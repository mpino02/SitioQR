"""
Perfiles y áreas.

- Super administrador: acceso a todo, todas las áreas, administra usuarios y áreas.
- Administrador: crea, edita y elimina dentro de su área.
- Visualización: solo ve y descarga dentro de su área.

Un usuario sin área trabaja en el área "General" (objetos con area = NULL).
El super administrador elige qué área está viendo (se guarda en la sesión); "Todas" muestra todo
y lo que cree en ese modo queda en "General".
"""
from django.conf import settings

from .models import Area, Profile

SESSION_AREA_KEY = "area_view"
ALL = "all"
GENERAL = "general"


def get_profile(user):
    try:
        return user.profile
    except Profile.DoesNotExist:
        # Usuario nuevo (p. ej. primer ingreso con Microsoft): sin acceso hasta que se le asigne perfil
        role = Profile.SUPERADMIN if user.is_superuser else settings.NEW_USER_ROLE
        return Profile.objects.create(user=user, role=role)


def has_access(user):
    """Falso para usuarios con perfil "Sin acceso (pendiente)"."""
    return is_superadmin(user) or get_profile(user).role != Profile.PENDING


def is_superadmin(user):
    return user.is_authenticated and (user.is_superuser or get_profile(user).role == Profile.SUPERADMIN)


def can_edit(user):
    return is_superadmin(user) or get_profile(user).role == Profile.ADMIN


def area_view(request):
    """Devuelve (ver_todo, area). area=None significa el área General."""
    if is_superadmin(request.user):
        value = request.session.get(SESSION_AREA_KEY, ALL)
        if value == ALL:
            return True, None
        if value == GENERAL:
            return False, None
        area = Area.objects.filter(pk=value).first()
        return (False, area) if area else (True, None)
    return False, get_profile(request.user).area


def scope(request, qs):
    """Filtra un queryset (con campo `area`) a lo que el usuario puede ver."""
    qs = qs.all()  # admite managers (QRCode.objects) además de querysets
    see_all, area = area_view(request)
    if see_all:
        return qs
    return qs.filter(area=area) if area else qs.filter(area__isnull=True)


def area_for_new(request):
    """Área que se asigna a lo que se crea."""
    return area_view(request)[1]
