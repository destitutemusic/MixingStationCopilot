@echo off
REM Mixing Station Copilot launcher (Windows)
REM Requires Node.js 20+ from https://nodejs.org
setlocal
cd /d "%~dp0"

node -v >nul 2>&1
if errorlevel 1 (
  echo Need Node.js 20+. Install from https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:~1%
if %NODE_MAJOR% LSS 20 (
  echo Need Node.js 20+ (found %NODE_MAJOR%). Install from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed
    pause
    exit /b 1
  )
)

start "" http://localhost:8085
node server/index.js
pause
