@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE=1"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing. Ask Codex to restore this tool's local dependencies.
  pause
  exit /b 1
)
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --demo
