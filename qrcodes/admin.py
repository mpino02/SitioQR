from django.conf import settings
from django.contrib import admin
from django.utils.html import format_html

from .models import DesignTemplate, Folder, QRCode, ScanStat


@admin.register(QRCode)
class QRCodeAdmin(admin.ModelAdmin):
    list_display = ("name", "short_link", "url", "folder", "scans", "archived", "updated_at")
    list_filter = ("archived", "folder")
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


@admin.register(ScanStat)
class ScanStatAdmin(admin.ModelAdmin):
    list_display = ("qr", "day", "device", "count")
    list_filter = ("device", "day")
