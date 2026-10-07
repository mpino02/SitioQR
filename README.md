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

## Con Docker

```bash
docker build -t py-qr .
docker run -d --name py-qr -p 8000:8000 \
  -e DJANGO_SECRET_KEY=una-clave-larga \
  -e PUBLIC_BASE_URL=https://qr.tudominio.cl \
  -v pyqr-data:/data py-qr
docker exec -it py-qr python manage.py createsuperuser
```

## Importante: el dominio

Define `PUBLIC_BASE_URL` con el dominio definitivo (ej. `https://qr.py.cl`) **antes de imprimir QR**. Ese dominio queda grabado dentro de cada QR; si cambia después, los QR impresos dejan de funcionar.

## Base de datos y respaldo

Por defecto usa SQLite en `data/db.sqlite3`: basta con respaldar ese archivo.
Para PostgreSQL, instala `psycopg[binary]` y define `DB_ENGINE=postgresql` y las variables `DB_*` del `.env`.

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
