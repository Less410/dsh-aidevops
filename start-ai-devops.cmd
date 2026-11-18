@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ai-devops.ps1"
if errorlevel 1 (
  echo.
  echo AI DevOps failed to start. Review the error above.
  pause
)

