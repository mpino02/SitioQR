import json
import os
import shutil
import tempfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from .models import Ficha, QRCode, ScanStat

MINI_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")


class QRTests(TestCase):
    def setUp(self):
        User.objects.create_user("ana", password="clave-segura-123")

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
        User.objects.create_user("ana", password="clave-segura-123")
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
