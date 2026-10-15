import json
import os
import shutil
import tempfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from .models import Area, Ficha, Profile, QRCode, ScanStat

MINI_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")


class QRTests(TestCase):
    def setUp(self):
        Profile.objects.create(user=User.objects.create_user("ana", password="clave-segura-123"), role=Profile.ADMIN)

    def login(self):
        r = self.client.post("/api/login", json.dumps({"username": "ana", "password": "clave-segura-123"}), content_type="application/json")
        self.assertEqual(r.status_code, 200)

    def test_api_requires_login(self):
        self.assertEqual(self.client.get("/api/qrs").status_code, 401)

    def test_create_redirect_and_edit_url(self):
        self.login()
        r = self.client.post("/api/qrs", json.dumps({"name": "Tipología J", "url": "https://example.com/a", "code": "tipo-j"}), content_type="application/json")
        self.assertEqual(r.status_code, 201)
        qid = r.json()["id"]
        r = self.client.get("/r/tipo-j", HTTP_USER_AGENT="iPhone")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], "https://example.com/a")
        self.client.put(f"/api/qrs/{qid}", json.dumps({"url": "https://example.com/b"}), content_type="application/json")
        self.assertEqual(self.client.get("/r/tipo-j")["Location"], "https://example.com/b")
        q = QRCode.objects.get(code="tipo-j")
        self.assertEqual(q.scans, 2)
        self.assertEqual(ScanStat.objects.get(qr=q, device="iOS").count, 1)

    def test_archived_qr_does_not_redirect(self):
        QRCode.objects.create(code="abc", name="x", url="https://example.com", archived=True)
        self.assertEqual(self.client.get("/r/abc").status_code, 404)

    def test_duplicate_code_rejected(self):
        self.login()
        data = json.dumps({"name": "a", "url": "https://example.com", "code": "dup"})
        self.client.post("/api/qrs", data, content_type="application/json")
        self.assertEqual(self.client.post("/api/qrs", data, content_type="application/json").status_code, 409)

    def test_invalid_url_rejected(self):
        self.login()
        r = self.client.post("/api/qrs", json.dumps({"name": "a", "url": "javascript:alert(1)"}), content_type="application/json")
        self.assertEqual(r.status_code, 400)


class FichaTests(TestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media)
        self.override.enable()
        Profile.objects.create(user=User.objects.create_user("ana", password="clave-segura-123"), role=Profile.ADMIN)
        self.client.login(username="ana", password="clave-segura-123")
        self.qr = QRCode.objects.create(code="tipo-a", name="Tipología A", url="https://example.com")

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media, ignore_errors=True)

    def upload(self, content=MINI_PDF, name="Planta P1.pdf"):
        return self.client.post("/api/fichas", {"file": SimpleUploadedFile(name, content, "application/pdf")})

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/fichas").status_code, 401)
        self.assertEqual(self.upload().status_code, 401)

    def test_upload_list_and_download_file(self):
        r = self.upload()
        self.assertEqual(r.status_code, 201)
        data = r.json()
        self.assertEqual(data["name"], "Planta P1")
        self.assertEqual(data["placements"], [])
        self.assertEqual(len(self.client.get("/api/fichas").json()), 1)
        f = self.client.get(data["fileUrl"])
        self.assertEqual(f["Content-Type"], "application/pdf")
        self.assertEqual(b"".join(f.streaming_content), MINI_PDF)

    def test_rejects_non_pdf(self):
        r = self.upload(content=b"hola", name="falso.pdf")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Ficha.objects.count(), 0)

    def test_save_placements(self):
        fid = self.upload().json()["id"]
        placements = [{"qrId": self.qr.id, "page": 1, "x": 0.1, "y": 0.2, "w": 0.05}]
        r = self.client.put(f"/api/fichas/{fid}", json.dumps({"placements": placements}), content_type="application/json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["placements"], [{"qrId": str(self.qr.id), "page": 1, "x": 0.1, "y": 0.2, "w": 0.05}])
        self.assertEqual(r.json()["qrCount"], 1)

    def test_rejects_invalid_placements(self):
        fid = self.upload().json()["id"]
        bad = [
            [{"qrId": 99999, "page": 1, "x": 0.1, "y": 0.1, "w": 0.1}],  # QR inexistente
            [{"qrId": self.qr.id, "page": 0, "x": 0.1, "y": 0.1, "w": 0.1}],  # página inválida
            [{"qrId": self.qr.id, "page": 1, "x": 0.1, "y": 0.1, "w": 0}],  # tamaño inválido
            [{"qrId": self.qr.id, "page": 1}],  # datos incompletos
            "no-es-lista",
        ]
        for placements in bad:
            r = self.client.put(f"/api/fichas/{fid}", json.dumps({"placements": placements}), content_type="application/json")
            self.assertEqual(r.status_code, 400, placements)

    def test_delete_removes_file(self):
        fid = self.upload().json()["id"]
        path = Ficha.objects.get(pk=fid).file.path
        self.assertEqual(self.client.delete(f"/api/fichas/{fid}").status_code, 200)
        self.assertFalse(Ficha.objects.exists())
        self.assertFalse(os.path.exists(path))


@override_settings(MS_CLIENT_ID="cid", MS_CLIENT_SECRET="secret", MS_TENANT_ID="tid",
                   MS_ALLOWED_DOMAINS=["py.cl"], MS_AUTO_CREATE_USERS=True, LOCAL_LOGIN_ENABLED=True)
class MicrosoftLoginTests(TestCase):
    def _callback(self, claims):
        from unittest import mock
        session = self.client.session
        session["ms_auth_flow"] = {"state": "s"}
        session.save()
        with mock.patch("qrcodes.microsoft_auth._app") as app:
            app.return_value.acquire_token_by_auth_code_flow.return_value = {"id_token_claims": claims}
            return self.client.get("/auth/microsoft/callback?code=x&state=s")

    def test_config_reports_microsoft(self):
        self.assertTrue(self.client.get("/api/config").json()["microsoftLogin"])

    def test_login_redirects_to_microsoft(self):
        from unittest import mock
        with mock.patch("qrcodes.microsoft_auth._app") as app:
            app.return_value.initiate_auth_code_flow.return_value = {
                "auth_uri": "https://login.microsoftonline.com/tid/oauth2/v2.0/authorize?x=1", "state": "s"}
            r = self.client.get("/auth/microsoft/login")
        self.assertEqual(self.client.session["ms_auth_flow"]["state"], "s")
        self.assertEqual(r.status_code, 302)
        self.assertIn("login.microsoftonline.com/tid", r["Location"])

    def test_callback_creates_and_logs_in_user(self):
        r = self._callback({"preferred_username": "Ana@py.cl", "name": "Ana Pérez"})
        self.assertEqual(r["Location"], "/")
        self.assertEqual(self.client.get("/api/config").json()["user"], "ana@py.cl")
        self.assertFalse(User.objects.get(username="ana@py.cl").is_staff)

    def test_callback_matches_existing_user_by_email(self):
        User.objects.create_user("mpino", email="mpino@py.cl", is_staff=True)
        self._callback({"preferred_username": "mpino@py.cl"})
        self.assertEqual(self.client.get("/api/config").json()["user"], "mpino")

    def test_callback_rejects_other_domain(self):
        r = self._callback({"preferred_username": "x@gmail.com"})
        self.assertIn("login_error", r["Location"])
        self.assertFalse(self.client.get("/api/config").json()["authenticated"])

    @override_settings(LOCAL_LOGIN_ENABLED=False)
    def test_local_login_can_be_disabled(self):
        User.objects.create_user("ana", password="clave-segura-123")
        r = self.client.post("/api/login", json.dumps({"username": "ana", "password": "clave-segura-123"}), content_type="application/json")
        self.assertEqual(r.status_code, 403)


class RolesAndAreasTests(TestCase):
    def setUp(self):
        self.rrhh = Area.objects.create(name="Recursos Humanos")
        self.boss = User.objects.create_superuser("boss", password="x")
        self.hr_admin = self._user("rrhh-admin", Profile.ADMIN, self.rrhh)
        self.hr_viewer = self._user("rrhh-ver", Profile.VIEWER, self.rrhh)
        self.gen_admin = self._user("general-admin", Profile.ADMIN, None)
        self.qr_hr = QRCode.objects.create(code="hr1", name="RRHH", url="https://a.cl", area=self.rrhh)
        self.qr_gen = QRCode.objects.create(code="gen1", name="General", url="https://b.cl")

    def _user(self, name, role, area):
        u = User.objects.create_user(name, password="x")
        Profile.objects.create(user=u, role=role, area=area)
        return u

    def _post(self, url, data):
        return self.client.post(url, json.dumps(data), content_type="application/json")

    def _codes(self):
        return sorted(q["code"] for q in self.client.get("/api/qrs").json())

    def test_area_users_only_see_their_area(self):
        self.client.force_login(self.hr_viewer)
        self.assertEqual(self._codes(), ["hr1"])
        self.assertEqual(self.client.get(f"/api/qrs/{self.qr_gen.id}").status_code, 404)
        self.client.force_login(self.gen_admin)
        self.assertEqual(self._codes(), ["gen1"])

    def test_viewer_cannot_write(self):
        self.client.force_login(self.hr_viewer)
        self.assertEqual(self._post("/api/qrs", {"name": "x", "url": "https://x.cl"}).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/qrs/{self.qr_hr.id}").status_code, 403)
        self.assertEqual(self._post("/api/folders", {"name": "x"}).status_code, 403)

    def test_admin_creates_in_own_area(self):
        self.client.force_login(self.hr_admin)
        r = self._post("/api/qrs", {"name": "Nuevo", "url": "https://x.cl", "code": "hr2"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(QRCode.objects.get(code="hr2").area, self.rrhh)
        self.assertEqual(self.client.get("/api/users").status_code, 403)

    def test_folder_from_other_area_rejected(self):
        from .models import Folder
        gen_folder = Folder.objects.create(name="General")
        self.client.force_login(self.hr_admin)
        r = self._post("/api/qrs", {"name": "x", "url": "https://x.cl", "folderId": gen_folder.id})
        self.assertEqual(r.status_code, 400)

    def test_superadmin_switches_area_and_manages_users(self):
        self.client.force_login(self.boss)
        self.assertEqual(self._codes(), ["gen1", "hr1"])
        self._post("/api/me/area", {"area": str(self.rrhh.id)})
        self.assertEqual(self._codes(), ["hr1"])
        cfg = self.client.get("/api/config").json()
        self.assertEqual((cfg["role"], cfg["area"]["name"]), ("superadmin", "Recursos Humanos"))

        r = self._post("/api/users", {"email": "nuevo@py.cl", "role": "admin", "areaId": str(self.rrhh.id)})
        self.assertEqual(r.status_code, 201)
        p = User.objects.get(email="nuevo@py.cl").profile
        self.assertEqual((p.role, p.area), ("admin", self.rrhh))

        r = self.client.put(f"/api/users/{self.hr_viewer.id}", json.dumps({"role": "superadmin"}), content_type="application/json")
        self.assertTrue(User.objects.get(pk=self.hr_viewer.id).is_superuser)
        r = self.client.put(f"/api/users/{self.boss.id}", json.dumps({"role": "viewer"}), content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_superadmin_all_areas_lists_everything(self):
        from .models import DesignTemplate, Folder
        Folder.objects.create(name="F RRHH", area=self.rrhh)
        DesignTemplate.objects.create(name="T", design={})
        self.client.force_login(self.boss)
        for url in ("/api/folders", "/api/templates", "/api/fichas", "/api/stats"):
            self.assertEqual(self.client.get(url).status_code, 200, url)
        self.assertEqual(len(self.client.get("/api/folders").json()), 1)

    def test_areas_crud(self):
        self.client.force_login(self.boss)
        r = self._post("/api/areas", {"name": "Ventas"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self._post("/api/areas", {"name": "ventas"}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/areas/{self.rrhh.id}").status_code, 409)  # tiene usuarios y QR
        self.assertEqual(self.client.delete(f"/api/areas/{r.json()['id']}").status_code, 200)
