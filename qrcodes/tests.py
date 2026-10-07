import json

from django.contrib.auth.models import User
from django.test import TestCase

from .models import QRCode, ScanStat


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
