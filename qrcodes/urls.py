from django.urls import path

from . import microsoft_auth, views

urlpatterns = [
    path("", views.index, name="index"),
    path("r/<str:code>", views.redirect_qr, name="redirect"),
    path("auth/microsoft/login", microsoft_auth.ms_login, name="ms_login"),
    path("auth/microsoft/callback", microsoft_auth.ms_callback, name="ms_callback"),
    path("api/config", views.config),
    path("api/login", views.api_login),
    path("api/logout", views.api_logout),
    path("api/qrs", views.qrs),
    path("api/qrs/<int:pk>", views.qr_detail),
    path("api/qrs/<int:pk>/duplicate", views.qr_duplicate),
    path("api/qrs/<int:pk>/stats", views.qr_stats),
    path("api/stats", views.global_stats),
    path("api/folders", views.folders),
    path("api/folders/<int:pk>", views.folder_detail),
    path("api/templates", views.templates),
    path("api/templates/<int:pk>", views.template_detail),
    path("api/fichas", views.fichas),
    path("api/fichas/<int:pk>", views.ficha_detail),
    path("api/fichas/<int:pk>/file", views.ficha_file),
    path("api/me/area", views.switch_area),
    path("api/audit", views.audit_log),
    path("api/users", views.users),
    path("api/users/<int:pk>", views.user_detail),
    path("api/areas", views.areas),
    path("api/areas/<int:pk>", views.area_detail),
]
