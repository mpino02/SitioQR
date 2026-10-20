"""Historial de cambios (quién cambió qué y cuándo)."""
from .models import AuditLog
from .ratelimit import client_ip

CREATE, UPDATE, DELETE, DUPLICATE = "crear", "editar", "eliminar", "duplicar"


def diff(before, after):
    """{"campo": [antes, después]} solo con los campos que cambiaron."""
    return {k: [before.get(k), after.get(k)] for k in after if before.get(k) != after.get(k)}


def record(request, action, object_type, obj=None, *, name=None, object_id=None, area=None, changes=None):
    """Guarda un registro. Si `obj` trae `area`, se usa como área del registro."""
    if obj is not None:
        object_id = object_id or obj.pk
        name = name if name is not None else (getattr(obj, "name", None) or getattr(obj, "username", None) or str(obj))
        if area is None:
            area = getattr(obj, "area", None)
    user = request.user if request.user.is_authenticated else None
    AuditLog.objects.create(
        user=user, username=user.get_username() if user else "", ip=client_ip(request)[:64],
        action=action, object_type=object_type, object_id=str(object_id or "")[:40],
        object_name=str(name or "")[:255], area=area, changes=changes or {},
    )
