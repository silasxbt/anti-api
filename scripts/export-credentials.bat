@echo off
REM Launcher Windows per esportare credenziali Antigravity
cd /d "%~dp0\.."
python scripts\export-credentials.py %*
pause
