"""
Límite de intentos fallidos de login con usuario y contraseña.

Cuenta fallos por usuario y por IP en el caché de Django (en la base de datos, para que lo compartan
todos los procesos de gunicorn). Al superar el máximo, se bloquea hasta que pase la ventana de tiempo.
"""
from django.conf import settings
from django.core.cache import cache


def client_ip(request):
    """IP del cliente. Azure App Service la entrega en X-Forwarded-For (a veces con puerto)."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() if forwarded else request.META.get("REMOTE_ADDR", "")
    if ip.startswith("["):  # [IPv6]:puerto
        ip = ip[1:].split("]")[0]
    elif ip.count(":") == 1:  # IPv4:puerto
        ip = ip.split(":")[0]
    return ip or "desconocida"


def _keys(request, username):
    return [
        (f"login-fail:user:{username.strip().lower()[:150]}", settings.LOGIN_MAX_FAILURES_USER),
        (f"login-fail:ip:{client_ip(request)}", settings.LOGIN_MAX_FAILURES_IP),
    ]


def is_blocked(request, username):
    return any((cache.get(key) or 0) >= limit for key, limit in _keys(request, username))


def register_failure(request, username):
    for key, _ in _keys(request, username):
        # add() fija el inicio de la ventana; incr() suma sin extenderla
        cache.add(key, 0, settings.LOGIN_FAILURE_WINDOW)
        try:
            cache.incr(key)
        except ValueError:  # expiró justo entre add e incr
            cache.set(key, 1, settings.LOGIN_FAILURE_WINDOW)


def reset(request, username):
    cache.delete(_keys(request, username)[0][0])
