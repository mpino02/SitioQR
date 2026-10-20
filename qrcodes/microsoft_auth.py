"""
Inicio de sesión con Microsoft (Entra ID / Azure AD) usando el flujo "authorization code" de MSAL.
Se activa definiendo MS_CLIENT_ID, MS_CLIENT_SECRET y MS_TENANT_ID en el .env.
"""
from urllib.parse import urlencode

import msal
from django.conf import settings
from django.contrib.auth import login
from django.contrib.auth.models import User
from django.http import HttpResponseRedirect
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

SESSION_FLOW_KEY = "ms_auth_flow"
SESSION_NEXT_KEY = "ms_auth_next"
# Marca en la sesión que el usuario entró con Microsoft (la exige /admin/)
SESSION_METHOD_KEY = "auth_method"
METHOD_MICROSOFT = "microsoft"
SCOPES = ["User.Read"]


def enabled():
    return bool(settings.MS_CLIENT_ID and settings.MS_CLIENT_SECRET and settings.MS_TENANT_ID)


def _app():
    return msal.ConfidentialClientApplication(
        settings.MS_CLIENT_ID,
        client_credential=settings.MS_CLIENT_SECRET,
        authority=f"https://login.microsoftonline.com/{settings.MS_TENANT_ID}",
    )


def _fail(msg):
    return HttpResponseRedirect("/?" + urlencode({"login_error": msg}))


def _user_from_claims(claims):
    """Busca el usuario Django por correo (o lo crea si MS_AUTO_CREATE_USERS=true)."""
    email = (claims.get("email") or claims.get("preferred_username") or claims.get("upn") or "").strip().lower()
    if not email or "@" not in email:
        return None, "Microsoft no entregó un correo para esta cuenta"
    domain = email.rsplit("@", 1)[1]
    if settings.MS_ALLOWED_DOMAINS and domain not in settings.MS_ALLOWED_DOMAINS:
        return None, f"El dominio {domain} no tiene acceso"

    user = User.objects.filter(email__iexact=email).first() or User.objects.filter(username__iexact=email).first()
    if not user:
        if not settings.MS_AUTO_CREATE_USERS:
            return None, "Tu cuenta no está habilitada. Pide acceso a un administrador"
        user = User(username=email, email=email)
        user.set_unusable_password()
    if not user.is_active:
        return None, "Tu cuenta está desactivada"

    name = (claims.get("name") or "").strip()
    if name and not (user.first_name or user.last_name):
        user.first_name, _, user.last_name = name.partition(" ")
        user.first_name, user.last_name = user.first_name[:150], user.last_name[:150]
    if not user.email:
        user.email = email
    user.save()
    return user, None


@never_cache
@require_GET
def ms_login(request):
    if not enabled():
        return _fail("El inicio de sesión con Microsoft no está configurado")
    try:
        flow = _app().initiate_auth_code_flow(SCOPES, redirect_uri=settings.MS_REDIRECT_URI, prompt="select_account")
    except ValueError:  # MS_TENANT_ID inválido o sin conexión con Microsoft
        return _fail("No se pudo contactar a Microsoft. Revisa MS_TENANT_ID en la configuración")
    request.session[SESSION_FLOW_KEY] = flow
    # Página a la que volver después de entrar (solo rutas de este mismo sitio)
    next_url = request.GET.get("next", "")
    if next_url and url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure()):
        request.session[SESSION_NEXT_KEY] = next_url
    else:
        request.session.pop(SESSION_NEXT_KEY, None)
    return HttpResponseRedirect(flow["auth_uri"])


@never_cache
@require_GET
def ms_callback(request):
    if not enabled():
        return _fail("El inicio de sesión con Microsoft no está configurado")
    flow = request.session.pop(SESSION_FLOW_KEY, None)
    if not flow:
        return _fail("La sesión de inicio expiró, vuelve a intentarlo")
    try:
        result = _app().acquire_token_by_auth_code_flow(flow, request.GET.dict())
    except ValueError:  # state no coincide (posible CSRF o pestaña antigua)
        return _fail("No se pudo validar la respuesta de Microsoft, vuelve a intentarlo")
    if "error" in result:
        return _fail(result.get("error_description") or result["error"])

    user, error = _user_from_claims(result.get("id_token_claims") or {})
    if error:
        return _fail(error)
    next_url = request.session.pop(SESSION_NEXT_KEY, None) or "/"
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session[SESSION_METHOD_KEY] = METHOD_MICROSOFT
    return HttpResponseRedirect(next_url)
