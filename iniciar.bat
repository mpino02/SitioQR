@echo off
REM Inicia PY QR en el puerto 9090 (accesible desde la red local)
cd /d "%~dp0"
python manage.py migrate --noinput
python manage.py collectstatic --noinput
echo.
echo PY QR corriendo en http://localhost:9090  (Ctrl+C para detener)
python -m waitress --listen=*:9090 pyqr.wsgi:application
pause
