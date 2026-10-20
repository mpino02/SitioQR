from urllib.parse import urlencode

from django.conf import settings
from django.contrib import admin
from django.shortcuts import redirect
from django.utils.html import format_html

from . import microsoft_auth
from .models import Area, DesignTemplate, Ficha, Folder, Profile, QRCode, ScanStat


@admin.register(QRCode)
class QRCodeAdmin(admin.ModelAdmin):
    list_display = ("name", "short_link", "url", "folder", "scans", "archived", "updated_at")
    list_filter = ("archived", "area", "folder")
    search_fields = ("name", "code", "url")
    readonly_fields = ("scans", "last_scan_at", "created_by", "created_at", "updated_at")

    @admin.display(description="URL corta")
    def short_link(self, obj):
        u = f"{settings.PUBLIC_BASE_URL}/r/{obj.code}"
        return format_html('<a href="{}" target="_blank">{}</a>', u, obj.code)


@admin.register(Folder)
class FolderAdmin(admin.ModelAdmin):
    list_display = ("name", "created_at")


@admin.register(DesignTemplate)
class DesignTemplateAdmin(admin.ModelAdmin):
    list_display = ("name", "created_at")


@admin.register(Ficha)
class FichaAdmin(admin.ModelAdmin):
    list_display = ("name", "folder", "original_name", "updated_at")
    list_filter = ("folder",)
    search_fields = ("name", "original_name")
    readonly_fields = ("file", "size", "placements", "created_by", "created_at", "updated_at")


@admin.register(ScanStat)
class ScanStatAdmin(admin.ModelAdmin):
    list_display = ("qr", "day", "device", "count")
    list_filter = ("device", "day")


@admin.register(Area)
class AreaAdmin(admin.ModelAdmin):
    list_display = ("name", "created_at")
    search_fields = ("name",)


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "role", "area")
    list_filter = ("role", "area")
    search_fields = ("user__username", "user__email")


# ---------- /admin/ exige haber entrado con Microsoft ----------
# Si el login con Microsoft está configurado (y ADMIN_REQUIRE_MICROSOFT=true), una sesión iniciada con
# usuario y contraseña no basta para /admin/: la pantalla de login de Django redirige a Microsoft.
def _admin_requires_microsoft():
    return settings.ADMIN_REQUIRE_MICROSOFT and microsoft_auth.enabled()


def _entered_with_microsoft(request):
    return request.session.get(microsoft_auth.SESSION_METHOD_KEY) == microsoft_auth.METHOD_MICROSOFT


_default_has_permission = admin.site.has_permission
_default_login = admin.site.login


def _admin_has_permission(request):
    if _admin_requires_microsoft() and not _entered_with_microsoft(request):
        return False
    return _default_has_permission(request)


def _admin_login(request, extra_context=None):
    if not _admin_requires_microsoft():
        return _default_login(request, extra_context)
    if request.user.is_authenticated and _entered_with_microsoft(request):
        # Ya entró con Microsoft pero no es staff: no volver a enviarlo a Microsoft (evita un bucle)
        return redirect("/?" + urlencode({"login_error": "Tu usuario no tiene acceso a la administración"}))
    next_url = request.GET.get("next") or "/admin/"
    return redirect("/auth/microsoft/login?" + urlencode({"next": next_url}))


admin.site.has_permission = _admin_has_permission
admin.site.login = _admin_login
