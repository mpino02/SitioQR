import json
import re
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.db.models import F, Q, Sum
from django.http import FileResponse, HttpResponse, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import access, microsoft_auth, ratelimit
from .access import scope
from .models import Area, DesignTemplate, Ficha, Folder, Profile, QRCode, ScanStat, generate_code

CODE_RE = re.compile(r"^[A-Za-z0-9_-]{3,40}$")
URL_RE = re.compile(r"^(https?://[^\s]+|mailto:[^\s]+|tel:[^\s]+)$", re.I)


# ---------- utilidades ----------
def short_url(code):
    return f"{settings.PUBLIC_BASE_URL}/r/{code}"


def qr_json(q):
    return {
        "id": str(q.id), "code": q.code, "name": q.name, "url": q.url,
        "folderId": str(q.folder_id) if q.folder_id else None,
        "design": q.design or {}, "archived": q.archived, "scans": q.scans,
        "lastScanAt": q.last_scan_at.isoformat() if q.last_scan_at else None,
        "createdAt": q.created_at.isoformat(), "updatedAt": q.updated_at.isoformat(),
        "shortUrl": short_url(q.code),
    }


def body(request):
    try:
        return json.loads(request.body or b"{}")
    except ValueError:
        return {}


class QRRedirect(HttpResponseRedirect):
    allowed_schemes = ["http", "https", "mailto", "tel"]


def err(msg, status=400):
    return JsonResponse({"error": msg}, status=status)


def api_login_required(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return err("No autorizado", 401)
        # El perfil Visualización solo puede leer
        if request.method not in ("GET", "HEAD") and not access.can_edit(request.user):
            return err("Tu perfil es de solo visualización", 403)
        return view(request, *args, **kwargs)
    return wrapper


def superadmin_required(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return err("No autorizado", 401)
        if not access.is_superadmin(request.user):
            return err("Solo el super administrador puede hacer esto", 403)
        return view(request, *args, **kwargs)
    return wrapper


def pick_folder(request, folder_id, area):
    """Carpeta visible para el usuario y de la misma área que el objeto; devuelve (carpeta, error)."""
    if not folder_id:
        return None, None
    f = scope(request, Folder.objects).filter(pk=folder_id).first()
    if not f:
        return None, "Carpeta no encontrada"
    if f.area_id != (area.id if area else None):
        return None, "La carpeta pertenece a otra área"
    return f, None


def area_json(a):
    return {"id": str(a.id), "name": a.name} if a else None


def device_from_ua(ua):
    ua = ua.lower()
    if any(k in ua for k in ("iphone", "ipad", "ipod")):
        return "iOS"
    if "android" in ua:
        return "Android"
    if any(k in ua for k in ("windows", "macintosh", "linux", "cros")):
        return "Escritorio"
    return "Otro"


def last_days(n=30):
    today = timezone.localdate()
    return [today - timedelta(days=i) for i in range(n - 1, -1, -1)]


# ---------- páginas ----------
@ensure_csrf_cookie
def index(request):
    return render(request, "qrcodes/index.html", {"app_name": settings.APP_NAME})


@never_cache
def redirect_qr(request, code):
    q = QRCode.objects.filter(code=code).first()
    if not q or q.archived:
        return HttpResponse(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            "<title>QR no disponible</title><body style=\"font-family:system-ui;display:grid;place-items:center;"
            'height:100vh;margin:0;color:#334"><div style="text-align:center"><h2>Este código QR no está disponible</h2>'
            "<p>Puede que haya sido desactivado.</p></div></body>",
            status=404,
        )
    now = timezone.now()
    device = device_from_ua(request.META.get("HTTP_USER_AGENT", ""))
    with transaction.atomic():
        QRCode.objects.filter(pk=q.pk).update(scans=F("scans") + 1, last_scan_at=now)
        stat, _ = ScanStat.objects.get_or_create(qr=q, day=timezone.localdate(), device=device)
        ScanStat.objects.filter(pk=stat.pk).update(count=F("count") + 1)
    return QRRedirect(q.url)


# ---------- autenticación ----------
@ensure_csrf_cookie
@require_GET
def config(request):
    return JsonResponse({
        "appName": settings.APP_NAME, "baseUrl": settings.PUBLIC_BASE_URL,
        "authenticated": request.user.is_authenticated,
        "user": request.user.get_username() if request.user.is_authenticated else None,
        "isAdmin": request.user.is_staff if request.user.is_authenticated else False,
        **(_session_info(request) if request.user.is_authenticated else {}),
        "microsoftLogin": microsoft_auth.enabled(),
        "localLogin": settings.LOCAL_LOGIN_ENABLED,
    })


def _session_info(request):
    profile = access.get_profile(request.user)
    superadmin = access.is_superadmin(request.user)
    see_all, area = access.area_view(request)
    info = {
        "role": Profile.SUPERADMIN if superadmin else profile.role,
        "canEdit": access.can_edit(request.user),
        "isSuperAdmin": superadmin,
        "area": area_json(area),
        "areaView": access.ALL if see_all else (str(area.id) if area else access.GENERAL),
    }
    if superadmin:
        info["areas"] = [area_json(a) for a in Area.objects.all()]
    return info


@require_POST
def api_login(request):
    if not settings.LOCAL_LOGIN_ENABLED:
        return err("Ingresa con tu cuenta de Microsoft", 403)
    data = body(request)
    username = str(data.get("username") or "")
    if ratelimit.is_blocked(request, username):
        minutes = max(1, settings.LOGIN_FAILURE_WINDOW // 60)
        return err(f"Demasiados intentos fallidos. Espera {minutes} minutos o entra con Microsoft.", 429)
    user = authenticate(request, username=username, password=str(data.get("password") or ""))
    if not user:
        ratelimit.register_failure(request, username)
        return err("Usuario o contraseña incorrectos", 401)
    ratelimit.reset(request, username)
    login(request, user)
    return JsonResponse({"ok": True})


@require_POST
def api_logout(request):
    logout(request)
    return JsonResponse({"ok": True})


# ---------- códigos QR ----------
@api_login_required
@require_http_methods(["GET", "POST"])
def qrs(request):
    if request.method == "GET":
        p = request.GET
        qs = scope(request, QRCode.objects).filter(archived=p.get("archived") == "1")
        if p.get("folder"):
            qs = qs.filter(folder_id=p["folder"])
        if p.get("q"):
            s = p["q"]
            qs = qs.filter(Q(name__icontains=s) | Q(url__icontains=s) | Q(code__icontains=s))
        order = {"created": "-created_at", "updated": "-updated_at", "name": "name", "scans": "-scans"}
        qs = qs.order_by(order.get(p.get("sort"), "-created_at"))
        return JsonResponse([qr_json(q) for q in qs], safe=False)

    data = body(request)
    name = str(data.get("name") or "").strip()
    url = str(data.get("url") or "").strip()
    if not name:
        return err("El nombre es obligatorio")
    if not URL_RE.match(url):
        return err("URL de destino inválida (debe empezar con http:// o https://)")
    code = str(data.get("code") or "").strip() or generate_code()
    if not CODE_RE.match(code):
        return err("Código corto inválido: usa 3-40 letras, números, - o _")
    area = access.area_for_new(request)
    folder, error = pick_folder(request, data.get("folderId"), area)
    if error:
        return err(error)
    try:
        q = QRCode.objects.create(code=code, name=name, url=url, folder=folder, area=area,
                                  design=data.get("design") or {}, created_by=request.user)
    except IntegrityError:
        return err("Ese código corto ya existe", 409)
    return JsonResponse(qr_json(q), status=201)


@api_login_required
@require_http_methods(["GET", "PUT", "DELETE"])
def qr_detail(request, pk):
    q = get_object_or_404(scope(request, QRCode.objects), pk=pk)
    if request.method == "GET":
        return JsonResponse(qr_json(q))
    if request.method == "DELETE":
        q.delete()
        return JsonResponse({"ok": True})

    data = body(request)
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            return err("El nombre es obligatorio")
        q.name = name
    if "url" in data:
        url = str(data["url"] or "").strip()
        if not URL_RE.match(url):
            return err("URL de destino inválida")
        q.url = url
    if "folderId" in data:
        q.folder, error = pick_folder(request, data["folderId"], q.area)
        if error:
            return err(error)
    if "design" in data:
        q.design = data["design"] or {}
    if "archived" in data:
        q.archived = bool(data["archived"])
    q.save()
    return JsonResponse(qr_json(q))


@api_login_required
@require_POST
def qr_duplicate(request, pk):
    q = get_object_or_404(scope(request, QRCode.objects), pk=pk)
    copy = QRCode.objects.create(code=generate_code(), name=f"{q.name} (copia)", url=q.url, area=q.area,
                                 folder=q.folder, design=q.design, created_by=request.user)
    return JsonResponse(qr_json(copy), status=201)


def _days_series(qs):
    days = last_days()
    rows = qs.filter(day__gte=days[0]).values("day").annotate(n=Sum("count"))
    by_day = {r["day"]: r["n"] for r in rows}
    return [{"day": d.isoformat(), "scans": by_day.get(d, 0)} for d in days]


def _devices(qs):
    return {r["device"]: r["n"] for r in qs.values("device").annotate(n=Sum("count"))}


@api_login_required
@require_GET
def qr_stats(request, pk):
    q = get_object_or_404(scope(request, QRCode.objects), pk=pk)
    st = ScanStat.objects.filter(qr=q)
    return JsonResponse({
        "total": q.scans, "lastScanAt": q.last_scan_at.isoformat() if q.last_scan_at else None,
        "days": _days_series(st), "devices": _devices(st),
    })


@api_login_required
@require_GET
def global_stats(request):
    qrs_qs = scope(request, QRCode.objects)
    st = ScanStat.objects.filter(qr__in=qrs_qs)
    top = qrs_qs.order_by("-scans")[:10]
    return JsonResponse({
        "totalQrs": qrs_qs.filter(archived=False).count(),
        "totalScans": qrs_qs.aggregate(n=Sum("scans"))["n"] or 0,
        "days": _days_series(st), "devices": _devices(st),
        "top": [{"id": str(q.id), "name": q.name, "scans": q.scans} for q in top],
    })


# ---------- carpetas ----------
@api_login_required
@require_http_methods(["GET", "POST"])
def folders(request):
    if request.method == "GET":
        out = []
        for f in scope(request, Folder.objects):
            out.append({"id": str(f.id), "name": f.name, "count": f.qrs.filter(archived=False).count()})
        return JsonResponse(out, safe=False)
    name = str(body(request).get("name") or "").strip()
    if not name:
        return err("Nombre obligatorio")
    f = Folder.objects.create(name=name, area=access.area_for_new(request))
    return JsonResponse({"id": str(f.id), "name": f.name, "count": 0}, status=201)


@api_login_required
@require_http_methods(["PUT", "DELETE"])
def folder_detail(request, pk):
    f = get_object_or_404(scope(request, Folder.objects), pk=pk)
    if request.method == "DELETE":
        f.delete()  # los QR quedan sin carpeta (SET_NULL)
        return JsonResponse({"ok": True})
    name = str(body(request).get("name") or "").strip()
    if not name:
        return err("Nombre obligatorio")
    f.name = name
    f.save()
    return JsonResponse({"id": str(f.id), "name": f.name})


# ---------- plantillas ----------
def tpl_json(t):
    return {"id": str(t.id), "name": t.name, "design": t.design, "createdAt": t.created_at.isoformat()}


@api_login_required
@require_http_methods(["GET", "POST"])
def templates(request):
    if request.method == "GET":
        return JsonResponse([tpl_json(t) for t in scope(request, DesignTemplate.objects)], safe=False)
    data = body(request)
    name = str(data.get("name") or "").strip()
    if not name or not isinstance(data.get("design"), dict):
        return err("Nombre y diseño obligatorios")
    t = DesignTemplate.objects.create(name=name, design=data["design"], area=access.area_for_new(request))
    return JsonResponse(tpl_json(t), status=201)


@api_login_required
@require_http_methods(["DELETE"])
def template_detail(request, pk):
    get_object_or_404(scope(request, DesignTemplate.objects), pk=pk).delete()
    return JsonResponse({"ok": True})


# ---------- fichas PDF ----------
MAX_PLACEMENTS = 1000


def ficha_json(f, full=False):
    data = {
        "id": str(f.id), "name": f.name, "originalName": f.original_name, "size": f.size,
        "folderId": str(f.folder_id) if f.folder_id else None,
        "qrCount": len(f.placements or []),
        "createdAt": f.created_at.isoformat(), "updatedAt": f.updated_at.isoformat(),
        "fileUrl": f"/api/fichas/{f.id}/file",
    }
    if full:
        data["placements"] = f.placements or []
    return data


def clean_placements(raw, qrs_qs):
    """Valida la lista de QR posicionados; devuelve (lista, error)."""
    if not isinstance(raw, list) or len(raw) > MAX_PLACEMENTS:
        return None, "Lista de QR posicionados inválida"
    out = []
    for p in raw:
        try:
            item = {
                "qrId": str(int(p["qrId"])), "page": int(p["page"]),
                "x": float(p["x"]), "y": float(p["y"]), "w": float(p["w"]),
            }
        except (KeyError, TypeError, ValueError):
            return None, "QR posicionado con datos inválidos"
        if item["page"] < 1 or not (0 < item["w"] <= 1) or not (-1 <= item["x"] <= 2) or not (-1 <= item["y"] <= 2):
            return None, "QR posicionado fuera de la página"
        out.append(item)
    ids = {p["qrId"] for p in out}
    if len(ids) != qrs_qs.filter(pk__in=ids).count():
        return None, "Uno de los QR posicionados ya no existe"
    return out, None


@api_login_required
@require_http_methods(["GET", "POST"])
def fichas(request):
    if request.method == "GET":
        qs = scope(request, Ficha.objects)
        if request.GET.get("folder"):
            qs = qs.filter(folder_id=request.GET["folder"])
        if request.GET.get("q"):
            qs = qs.filter(name__icontains=request.GET["q"])
        return JsonResponse([ficha_json(f) for f in qs], safe=False)

    up = request.FILES.get("file")
    if not up:
        return err("Selecciona un archivo PDF")
    if up.size > settings.FICHA_MAX_MB * 1024 * 1024:
        return err(f"El PDF supera el máximo de {settings.FICHA_MAX_MB} MB")
    head = up.read(1024)
    up.seek(0)
    if b"%PDF-" not in head:
        return err("El archivo no es un PDF válido")
    name = str(request.POST.get("name") or "").strip() or re.sub(r"\.pdf$", "", up.name, flags=re.I)
    area = access.area_for_new(request)
    folder, error = pick_folder(request, request.POST.get("folderId"), area)
    if error:
        return err(error)
    f = Ficha(name=name[:200], original_name=up.name[:255], size=up.size, folder=folder, area=area, created_by=request.user)
    f.file.save("ficha.pdf", up, save=False)
    f.save()
    return JsonResponse(ficha_json(f, full=True), status=201)


@api_login_required
@require_http_methods(["GET", "PUT", "DELETE"])
def ficha_detail(request, pk):
    f = get_object_or_404(scope(request, Ficha.objects), pk=pk)
    if request.method == "GET":
        return JsonResponse(ficha_json(f, full=True))
    if request.method == "DELETE":
        f.file.delete(save=False)
        f.delete()
        return JsonResponse({"ok": True})

    data = body(request)
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            return err("El nombre es obligatorio")
        f.name = name[:200]
    if "folderId" in data:
        f.folder, error = pick_folder(request, data["folderId"], f.area)
        if error:
            return err(error)
    if "placements" in data:
        # Solo QR de la misma área que la ficha
        qrs_qs = QRCode.objects.filter(area=f.area) if f.area else QRCode.objects.filter(area__isnull=True)
        placements, error = clean_placements(data["placements"], qrs_qs)
        if error:
            return err(error)
        f.placements = placements
    f.save()
    return JsonResponse(ficha_json(f, full=True))


@api_login_required
@require_GET
def ficha_file(request, pk):
    f = get_object_or_404(scope(request, Ficha.objects), pk=pk)
    try:
        fh = f.file.open("rb")
    except FileNotFoundError:
        return err("No se encontró el archivo PDF", 404)
    filename = f.original_name or f"{f.name}.pdf"
    return FileResponse(fh, content_type="application/pdf", filename=filename)


# ---------- usuarios, perfiles y áreas (solo super administrador) ----------
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def user_json(u):
    p = access.get_profile(u)
    return {
        "id": str(u.id), "username": u.username, "email": u.email,
        "name": u.get_full_name(), "active": u.is_active,
        "role": Profile.SUPERADMIN if u.is_superuser else p.role,
        "areaId": str(p.area_id) if p.area_id else None,
        "lastLogin": u.last_login.isoformat() if u.last_login else None,
    }


def _apply_profile(user, data, me):
    """Aplica perfil, área y activo desde `data`; devuelve un mensaje de error o None."""
    p = access.get_profile(user)
    if "role" in data:
        role = data["role"]
        if role not in dict(Profile.ROLES):
            return "Perfil inválido"
        if user == me and role != Profile.SUPERADMIN:
            return "No puedes quitarte a ti mismo el perfil de super administrador"
        p.role = role
        # El super administrador también entra a /admin/
        user.is_staff = user.is_superuser = role == Profile.SUPERADMIN
    if "areaId" in data:
        p.area = None
        if data["areaId"]:
            p.area = Area.objects.filter(pk=data["areaId"]).first()
            if not p.area:
                return "Área no encontrada"
    if "active" in data:
        if user == me and not data["active"]:
            return "No puedes desactivar tu propio usuario"
        user.is_active = bool(data["active"])
    user.save()
    p.save()
    return None


@superadmin_required
@require_http_methods(["GET", "POST"])
def users(request):
    if request.method == "GET":
        qs = User.objects.select_related("profile").order_by("username")
        return JsonResponse([user_json(u) for u in qs], safe=False)
    # Pre-registrar por correo: al entrar con Microsoft queda con el perfil y área asignados
    data = body(request)
    email = str(data.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return err("Correo inválido")
    if User.objects.filter(Q(email__iexact=email) | Q(username__iexact=email)).exists():
        return err("Ya existe un usuario con ese correo", 409)
    with transaction.atomic():
        u = User(username=email, email=email)
        u.set_unusable_password()
        u.save()
        error = _apply_profile(u, {"role": data.get("role") or Profile.VIEWER, "areaId": data.get("areaId")}, request.user)
        if error:
            transaction.set_rollback(True)
            return err(error)
    return JsonResponse(user_json(u), status=201)


@superadmin_required
@require_http_methods(["PUT"])
def user_detail(request, pk):
    u = get_object_or_404(User, pk=pk)
    with transaction.atomic():
        error = _apply_profile(u, body(request), request.user)
        if error:
            transaction.set_rollback(True)
            return err(error)
    return JsonResponse(user_json(u))


def area_full_json(a):
    return {**area_json(a), "users": a.profiles.count(), "qrs": a.qrs.count()}


@superadmin_required
@require_http_methods(["GET", "POST"])
def areas(request):
    if request.method == "GET":
        return JsonResponse([area_full_json(a) for a in Area.objects.all()], safe=False)
    name = str(body(request).get("name") or "").strip()[:120]
    if not name:
        return err("Nombre obligatorio")
    if Area.objects.filter(name__iexact=name).exists():
        return err("Ya existe un área con ese nombre", 409)
    return JsonResponse(area_full_json(Area.objects.create(name=name)), status=201)


@superadmin_required
@require_http_methods(["PUT", "DELETE"])
def area_detail(request, pk):
    a = get_object_or_404(Area, pk=pk)
    if request.method == "DELETE":
        try:
            a.delete()
        except ProtectedError:
            return err("El área tiene usuarios, QR, carpetas, fichas o plantillas. Muévelos o elimínalos antes.", 409)
        if request.session.get(access.SESSION_AREA_KEY) == str(pk):
            request.session[access.SESSION_AREA_KEY] = access.ALL
        return JsonResponse({"ok": True})
    name = str(body(request).get("name") or "").strip()[:120]
    if not name:
        return err("Nombre obligatorio")
    if Area.objects.filter(name__iexact=name).exclude(pk=pk).exists():
        return err("Ya existe un área con ese nombre", 409)
    a.name = name
    a.save()
    return JsonResponse(area_full_json(a))


@superadmin_required
@require_POST
def switch_area(request):
    """El super administrador elige qué área ver: "all", "general" o el id de un área."""
    value = str(body(request).get("area") or access.ALL)
    if value not in (access.ALL, access.GENERAL) and not (value.isdigit() and Area.objects.filter(pk=value).exists()):
        return err("Área no encontrada")
    request.session[access.SESSION_AREA_KEY] = value
    return JsonResponse({"ok": True})
