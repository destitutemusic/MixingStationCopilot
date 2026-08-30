@echo off
setlocal
cd /d "%~dp0"
echo Mixing Station Copilot
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install Node 20 or newer from https://nodejs.org
  echo Then run start.bat again.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo Found Node %NODE_VER%

if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

echo.
echo Starting Copilot... browser will open at http://localhost:8085
echo Keep this window open while using Copilot. Press Ctrl+C to stop.
echo.
start "" http://localhost:8085
node server/index.js
echo.
echo Copilot stopped.
pause
