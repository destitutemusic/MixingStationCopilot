@echo off
setlocal
cd /d "%~dp0"

set "NODE="
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
if not defined NODE if exist "runtime\node" set "NODE=runtime\node"
if not defined NODE (
  where node >nul 2>&1
  if errorlevel 1 (
    echo No Node runtime found in this folder and no system Node installed.
    echo Download the Mixing Station Copilot zip again from the release page; it includes its own runtime.
    pause
    exit /b 1
  )
  set "NODE=node"
  echo Bundled runtime not found; using the system Node.
)

if not exist node_modules (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo This copy is missing its dependencies and npm is not available.
    echo Download the release zip again; it includes everything.
    pause
    exit /b 1
  )
  echo Installing dependencies ^(first run^)...
  call npm install --no-audit --no-fund
)

echo.
echo Starting Mixing Station Copilot... your browser will open at http://localhost:8085
echo Keep this window open while using Copilot. Press Ctrl+C to stop.
echo.
start "" http://localhost:8085
"%NODE%" server/index.js
echo.
echo Copilot stopped.
pause
