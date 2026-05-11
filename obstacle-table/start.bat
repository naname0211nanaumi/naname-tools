@echo off
cd /d "%~dp0"
echo 妨害表ツール起動中...
echo.
echo Overlay : http://localhost:8788/overlay
echo Admin   : http://localhost:8788/admin
echo Webhook : http://localhost:8788/webhook
echo.
deno task start
pause
