from django.contrib import admin
from django.urls import include, path

admin.site.site_header = "PY QR · Administración"
admin.site.site_title = "PY QR"

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("qrcodes.urls")),
]
