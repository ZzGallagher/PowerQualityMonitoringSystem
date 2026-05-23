@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "MODE=serial"
if not "%~1"=="" set "MODE=%~1"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$root = (Resolve-Path -LiteralPath '%ROOT%').Path; Join-Path $root ([string]([char]0x8F6F) + [string]([char]0x4EF6) + '2\backend')"`) do set "BACKEND_DIR=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$root = (Resolve-Path -LiteralPath '%ROOT%').Path; Join-Path $root ([string]([char]0x8F6F) + [string]([char]0x4EF6) + '2\web')"`) do set "WEB_DIR=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$root = (Resolve-Path -LiteralPath '%ROOT%').Path; Join-Path $root ([string]([char]0x8F6F) + [string]([char]0x4EF6) + '1\amc_gateway')"`) do set "GATEWAY_DIR=%%I"

echo ========================================
echo Power Quality Demo - Local One Click Start
echo ========================================
echo Root: %ROOT%
echo Software1 mode: %MODE%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node was not found. Please install Node.js first.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python was not found. Please install Python 3 first.
  pause
  exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules" (
  echo [ERROR] Missing backend dependencies:
  echo   %BACKEND_DIR%\node_modules
  echo Please run:
  echo   cd /d "%BACKEND_DIR%"
  echo   npm install
  pause
  exit /b 1
)

if not exist "%BACKEND_DIR%\.env" (
  echo [INFO] Backend .env not found. Copying from .env.example.
  copy "%BACKEND_DIR%\.env.example" "%BACKEND_DIR%\.env" >nul
)

sc query postgresql-x64-18 | findstr /I "RUNNING" >nul 2>nul
if errorlevel 1 (
  echo [WARN] PostgreSQL service postgresql-x64-18 is not detected as running.
  echo If backend database connection fails, start PostgreSQL first.
  echo.
)

echo [1/4] Starting database ingest service: http://127.0.0.1:9000
start "Database Ingest - 9000" cmd /k "cd /d ""%BACKEND_DIR%"" && npm run init-db && npm run start:ingest"

echo Waiting for database ingest initialization...
timeout /t 4 /nobreak >nul

echo [2/4] Starting Software2 backend read API: http://127.0.0.1:8000
start "Software2 Backend Read API - 8000" cmd /k "cd /d ""%BACKEND_DIR%"" && npm start"

echo [3/4] Starting Software2 frontend: http://127.0.0.1:8080
start "Software2 Frontend - 8080" cmd /k "cd /d ""%WEB_DIR%"" && python -m http.server 8080"

echo [4/4] Starting Software1 acquisition: %MODE%
start "Software1 Acquisition - %MODE%" cmd /k "cd /d ""%GATEWAY_DIR%"" && set PYTHONPATH=.\src&& python -m amc_gateway run --config meter_config.example.json --mode %MODE%"

echo.
echo Four service windows have been opened.
echo Frontend:       http://127.0.0.1:8080
echo Ingest health:  http://127.0.0.1:9000/api/ingest/health
echo Backend health: http://127.0.0.1:8000/api/health
echo.
echo Use mock mode:   "%~nx0" mock
echo Use serial mode: "%~nx0" serial
echo.
pause
