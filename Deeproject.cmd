@echo off
rem Launch Deeproject straight from this repo, using the Electron binary in
rem node_modules and the compiled bundle in out\. Updating is then just
rem `npm run build` followed by restarting — no installer, no reinstall.
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run: npm install
  pause
  exit /b 1
)

if not exist "out\main\index.js" (
  echo No build found. Building...
  call npm run build || (echo Build failed. & pause & exit /b 1)
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
