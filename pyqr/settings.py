"""
Configuración de PY QR (Django).
Todas las opciones importantes se leen de variables de entorno o del archivo .env.
"""
import os
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


_load_env(BASE_DIR / ".env")


def env_bool(name, default=False):
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes", "si", "sí")


def env_list(name, default=""):
    return [x.strip() for x in os.environ.get(name, default).split(",") if x.strip()]


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-inseguro-cambiar-en-produccion")
DEBUG = env_bool("DEBUG", False)
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
APP_NAME = os.environ.get("APP_NAME", "PY QR")

_public_host = PUBLIC_BASE_URL.split("://", 1)[-1].split("/")[0].split(":")[0]
ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", f"{_public_host},localhost,127.0.0.1")
# Azure App Service define WEBSITE_HOSTNAME (dominio *.azurewebsites.net): se acepta siempre
if os.environ.get("WEBSITE_HOSTNAME") and os.environ["WEBSITE_HOSTNAME"] not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(os.environ["WEBSITE_HOSTNAME"])
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", PUBLIC_BASE_URL if PUBLIC_BASE_URL.startswith("https") else "")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "qrcodes",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "qrcodes.security.ContentSecurityPolicyMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "pyqr.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "pyqr.wsgi.application"

# Base de datos: SQLite por defecto. Para PostgreSQL define DATABASE_URL (cadena de conexión del proveedor)
# o DB_ENGINE=postgresql y las variables DB_*.
def _postgres_from_env():
    db = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "pyqr"),
        "USER": os.environ.get("DB_USER", "pyqr"),
        "PASSWORD": os.environ.get("DB_PASSWORD", ""),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": os.environ.get("DB_PORT", "5432"),
        "OPTIONS": {},
    }
    url = os.environ.get("DATABASE_URL", "")
    if url:  # postgresql://usuario:clave@host:5432/base?sslmode=require
        u = urlsplit(url)
        db.update(NAME=unquote(u.path.lstrip("/")), USER=unquote(u.username or ""), PASSWORD=unquote(u.password or ""),
                  HOST=u.hostname or "", PORT=str(u.port or 5432))
        db["OPTIONS"].update(dict(parse_qsl(u.query)))
    # Las bases en la nube suelen exigir SSL: require (o verify-full con DB_SSLROOTCERT)
    if os.environ.get("DB_SSLMODE"):
        db["OPTIONS"]["sslmode"] = os.environ["DB_SSLMODE"]
    if os.environ.get("DB_SSLROOTCERT"):
        db["OPTIONS"]["sslrootcert"] = os.environ["DB_SSLROOTCERT"]
    db["OPTIONS"].setdefault("connect_timeout", 10)
    db["CONN_MAX_AGE"] = int(os.environ.get("DB_CONN_MAX_AGE", "60"))
    db["CONN_HEALTH_CHECKS"] = True
    return db


DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
if os.environ.get("DATABASE_URL") or os.environ.get("DB_ENGINE", "sqlite") == "postgresql":
    DATABASES = {"default": _postgres_from_env()}
else:
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": DATA_DIR / "db.sqlite3"}}

# PDF subidos (fichas). Se sirven solo a usuarios autenticados mediante la API, no como archivos públicos.
MEDIA_ROOT = DATA_DIR / "media"
FICHA_MAX_MB = int(os.environ.get("FICHA_MAX_MB", "50"))

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "es-cl"
TIME_ZONE = os.environ.get("TIME_ZONE", "America/Santiago")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# Sirve los archivos estáticos aunque DEBUG=false y aunque no se haya ejecutado collectstatic
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = DEBUG
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # logos en base64 dentro del diseño

# Inicio de sesión con Microsoft (Entra ID). Se activa al definir MS_CLIENT_ID, MS_CLIENT_SECRET y MS_TENANT_ID.
MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
MS_TENANT_ID = os.environ.get("MS_TENANT_ID", "")
MS_REDIRECT_URI = os.environ.get("MS_REDIRECT_URI", f"{PUBLIC_BASE_URL}/auth/microsoft/callback")
MS_ALLOWED_DOMAINS = [d.lower() for d in env_list("MS_ALLOWED_DOMAINS")]
MS_AUTO_CREATE_USERS = env_bool("MS_AUTO_CREATE_USERS", True)
# Permite seguir entrando con usuario y contraseña de Django además de Microsoft
LOCAL_LOGIN_ENABLED = env_bool("LOCAL_LOGIN_ENABLED", True)
# /admin/ solo con sesión iniciada por Microsoft (si Microsoft está configurado)
ADMIN_REQUIRE_MICROSOFT = env_bool("ADMIN_REQUIRE_MICROSOFT", True)

# Límite de intentos fallidos de login con contraseña (por usuario y por IP, en una ventana de tiempo)
LOGIN_MAX_FAILURES_USER = int(os.environ.get("LOGIN_MAX_FAILURES_USER", "5"))
LOGIN_MAX_FAILURES_IP = int(os.environ.get("LOGIN_MAX_FAILURES_IP", "20"))
LOGIN_FAILURE_WINDOW = int(os.environ.get("LOGIN_FAILURE_WINDOW", str(15 * 60)))  # segundos

# Caché en la base de datos: compartido entre procesos e instancias (se crea con "manage.py createcachetable")
CACHES = {"default": {"BACKEND": "django.core.cache.backends.db.DatabaseCache", "LOCATION": "django_cache"}}

# Sesión: se cierra tras SESSION_IDLE_HOURS sin actividad (cada visita renueva el plazo)
SESSION_COOKIE_AGE = int(float(os.environ.get("SESSION_IDLE_HOURS", "8")) * 3600)
SESSION_SAVE_EVERY_REQUEST = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
if PUBLIC_BASE_URL.startswith("https") and not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    # HSTS: el navegador recordará usar solo HTTPS en este dominio. Solo este dominio
    # (no subdominios de constructoracarran.cl) y sin "preload". Empieza con 1 día; luego subir a 1 año.
    SECURE_HSTS_SECONDS = int(os.environ.get("HSTS_SECONDS", str(24 * 3600)))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = False
    SECURE_HSTS_PRELOAD = False

# Content-Security-Policy: de dónde puede cargar scripts, estilos, imágenes, etc. la página.
# CSP_REPORT_ONLY=true solo informa en la consola del navegador sin bloquear (útil para probar).
CSP = os.environ.get("CSP", "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",  # estilos en línea generados por el panel
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",  # vistas previas de QR y logos en data:
    "worker-src 'self' blob:",  # worker de pdf.js
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
]))
CSP_REPORT_ONLY = env_bool("CSP_REPORT_ONLY", False)

# Errores a la consola: en Azure se ven en "Secuencia de registro" (Log stream)
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "WARNING")},
}
