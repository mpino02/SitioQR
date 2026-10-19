#!/bin/bash
# Comando de inicio para Azure App Service (Linux).
# Configurar en: App Service > Configuración > Configuración general > Comando de inicio:  bash startup.sh
set -e
mkdir -p "${DATA_DIR:-/home/data}"
python manage.py migrate --noinput
python manage.py createcachetable
exec gunicorn pyqr.wsgi:application --bind=0.0.0.0:${PORT:-8000} --workers ${GUNICORN_WORKERS:-2} --timeout 120 --access-logfile - --error-logfile -
