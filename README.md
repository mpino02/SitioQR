# PY QR — Generador de códigos QR dinámicos (Python + Django)

Panel propio para crear y administrar códigos QR, similar a QR.io:

- **QR dinámicos**: el QR apunta a `https://tu-dominio/r/<codigo>` y Django redirige a la URL de destino. Puedes **cambiar la URL de destino cuando quieras sin reimprimir**.
- **Diseño**: estilo de puntos, degradado, esquinas, colores, fondo transparente, margen y corrección de errores.
- **Logo**: sube tu logo (PNG, JPG, SVG, WEBP), ajusta tamaño y espacio.
- **Marco con texto** (ej. “TIPOLOGÍA J ESPEJO”).
- **Descarga** en **PNG, JPG, WEBP, SVG y PDF**.
- **Carpetas**, archivar/activar (un QR archivado deja de redirigir), duplicar, buscar, ordenar.
- **Plantillas de diseño** reutilizables.
- **Estadísticas** de escaneos por día y por dispositivo.
- **Usuarios** con el sistema de cuentas de Django; administración en `/admin/`.

## Instalación local

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # edita los valores (para pruebas locales: DEBUG=true y PUBLIC_BASE_URL=http://localhost:8000)
python manage.py migrate
python manage.py createsuperuser  # tu usuario para entrar
python manage.py runserver
```

Abre http://localhost:8000 e ingresa con el usuario creado.
Para agregar más personas del equipo: botón **Usuarios** (o `/admin/`) → Usuarios → Agregar.

## Producción (Linux con gunicorn)

```bash
pip install -r requirements.txt
python manage.py migrate
python manage.py collectstatic --noinput
python manage.py createsuperuser
gunicorn pyqr.wsgi:application --bind 127.0.0.1:8000 --workers 3
```

Pon delante un proxy con HTTPS. Ejemplo con Caddy:

```
qr.py.cl {
    reverse_proxy 127.0.0.1:8000
}
```

Con Nginx, recuerda enviar `proxy_set_header X-Forwarded-Proto $scheme;` y `proxy_set_header Host $host;`.

## Azure App Service (Linux, Python 3.13)

El mismo `requirements.txt` sirve para local (Windows usa waitress) y Azure (Linux usa gunicorn).

1. **Configuración > Variables de entorno**: las mismas del `.env` (nunca se sube el `.env`), más:
   - `PUBLIC_BASE_URL=https://<tu-app>.azurewebsites.net` (o el dominio definitivo antes de imprimir QR)
   - `DATA_DIR=/home/data` (carpeta persistente: ahí quedan los PDF de fichas)
   - `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (Azure instala `requirements.txt` al desplegar)
   - `DEBUG=false` y un `DJANGO_SECRET_KEY` nuevo
2. **Configuración > Configuración general > Comando de inicio**: `bash startup.sh`
   (aplica las migraciones y arranca gunicorn).
3. **Entra ID**: agregar la URI `https://<tu-app>.azurewebsites.net/auth/microsoft/callback` (plataforma Web).
4. **PostgreSQL**: el firewall debe permitir servicios de Azure.
5. Desplegar el código, por ejemplo desde esta carpeta:

```bash
git archive --format=zip -o deploy.zip HEAD
az webapp deploy -g <grupo> -n <tu-app> --src-path deploy.zip --type zip
```

Los errores se ven en **Supervisión > Secuencia de registro**.

## Con Docker

```bash
docker build -t py-qr .
docker run -d --name py-qr -p 8000:8000 \
  -e DJANGO_SECRET_KEY=una-clave-larga \
  -e PUBLIC_BASE_URL=https://qr.tudominio.cl \
  -v pyqr-data:/data py-qr
docker exec -it py-qr python manage.py createsuperuser
```

## Inicio de sesión con Microsoft (Entra ID)

1. En https://entra.microsoft.com → **Registros de aplicaciones** → tu app → **Autenticación** → agrega la plataforma **Web** con la URI de redirección
   `https://tu-dominio/auth/microsoft/callback` (debe coincidir con `PUBLIC_BASE_URL` o con `MS_REDIRECT_URI`).
   Puede ser `http://` en la red local (ej. `http://192.168.4.10:7700/auth/microsoft/callback`); en producción se recomienda HTTPS.
2. En **Certificados y secretos** crea un secreto de cliente y copia su **Valor**.
3. Completa en el `.env`: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` (y opcionalmente `MS_ALLOWED_DOMAINS`, `MS_AUTO_CREATE_USERS`, `LOCAL_LOGIN_ENABLED`).
4. `pip install -r requirements.txt` y reinicia la app. En el login aparecerá **Ingresar con Microsoft**.

El usuario se asocia por correo con un usuario existente de Django; si no existe y `MS_AUTO_CREATE_USERS=true`, se crea sin permisos de administrador (dale "Es staff" desde **Usuarios** si debe administrar).

## Importante: el dominio

Define `PUBLIC_BASE_URL` con el dominio definitivo (ej. `https://qr.py.cl`) **antes de imprimir QR**. Ese dominio queda grabado dentro de cada QR; si cambia después, los QR impresos dejan de funcionar.

## Base de datos y respaldo

Por defecto usa SQLite en `data/db.sqlite3`: basta con respaldar ese archivo.
Para PostgreSQL define en el `.env` `DATABASE_URL` (o `DB_ENGINE=postgresql` y las variables `DB_*`) y `DB_SSLMODE=require` si la base está en la nube.
Los PDF de las fichas no van en la base: siguen en `DATA_DIR/media` y hay que respaldarlos aparte.

### Pasar de SQLite a PostgreSQL (conservando los datos)

En el servidor donde corre la app, con el código actualizado:

```bash
pip install -r requirements.txt
# 1. Respaldo del SQLite actual
copy data\db.sqlite3 data\db.sqlite3.respaldo          # Linux: cp data/db.sqlite3 data/db.sqlite3.respaldo
# 2. Aplicar las migraciones pendientes AÚN EN SQLITE (crea los perfiles de los usuarios existentes)
python manage.py migrate
# 3. Exportar los datos
python -X utf8 manage.py dumpdata --natural-foreign --natural-primary -e contenttypes -e auth.permission -e admin.logentry -e sessions --indent 2 -o respaldo.json
# 4. Editar el .env: agregar DATABASE_URL (o DB_*) y DB_SSLMODE=require
# 5. Probar la conexión y crear las tablas en PostgreSQL (la base debe estar vacía)
python manage.py migrate
# 6. Importar los datos
python -X utf8 manage.py loaddata respaldo.json
# 7. Reiniciar la app
```

Si algo falla, basta con quitar `DATABASE_URL`/`DB_ENGINE` del `.env` para volver al SQLite, que queda intacto.
El firewall de la base en la nube debe permitir la IP pública del servidor.

## Pruebas

```bash
python manage.py test qrcodes
```

## Estructura

```
pyqr/settings.py                     Configuración (lee .env)
qrcodes/models.py                    QRCode, Folder, DesignTemplate, ScanStat
qrcodes/views.py                     Redirección /r/<codigo> y API JSON del panel
qrcodes/admin.py                     Administración Django
qrcodes/templates/qrcodes/index.html Panel
qrcodes/static/qrcodes/              JS/CSS del panel + librerías (qr-code-styling, jsPDF), sin CDN
```

## QR existentes en QR.io

Los QR impresos con QR.io apuntan a `qr.codes/...` (dominio de QR.io) y no se pueden trasladar. Los nuevos o reimpresos, créalos aquí.
