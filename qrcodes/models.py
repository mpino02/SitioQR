import secrets

from django.db import models

ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_code(length=6):
    while True:
        code = "".join(secrets.choice(ALPHABET) for _ in range(length))
        if not QRCode.objects.filter(code=code).exists():
            return code


class Folder(models.Model):
    name = models.CharField("nombre", max_length=120)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "carpeta"

    def __str__(self):
        return self.name


class QRCode(models.Model):
    code = models.CharField("código corto", max_length=40, unique=True)
    name = models.CharField("nombre", max_length=200)
    url = models.URLField("URL de destino", max_length=2000)
    folder = models.ForeignKey(Folder, null=True, blank=True, on_delete=models.SET_NULL, related_name="qrs", verbose_name="carpeta")
    design = models.JSONField("diseño", default=dict, blank=True)
    archived = models.BooleanField("archivado", default=False)
    scans = models.PositiveIntegerField("escaneos", default=0)
    last_scan_at = models.DateTimeField("último escaneo", null=True, blank=True)
    created_by = models.ForeignKey("auth.User", null=True, blank=True, on_delete=models.SET_NULL, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "código QR"
        verbose_name_plural = "códigos QR"

    def __str__(self):
        return f"{self.name} ({self.code})"


class ScanStat(models.Model):
    """Escaneos agregados por QR, día y tipo de dispositivo."""
    qr = models.ForeignKey(QRCode, on_delete=models.CASCADE, related_name="stats")
    day = models.DateField()
    device = models.CharField(max_length=20)
    count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["qr", "day", "device"], name="uniq_scan_stat")]


class DesignTemplate(models.Model):
    name = models.CharField("nombre", max_length=120)
    design = models.JSONField("diseño", default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "plantilla de diseño"
        verbose_name_plural = "plantillas de diseño"

    def __str__(self):
        return self.name
