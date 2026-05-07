@echo off
title Subtitle Editor — Setup
cd /d "%~dp0"

echo.
echo  Subtitle Editor — One-time setup
echo  --------------------------------
echo.
echo  This will install the Python packages the app needs (Flask,
echo  faster-whisper, etc.) into your user Python.
echo.

py --version >nul 2>&1
if errorlevel 1 (
  echo  [!] Python isn't installed or isn't on PATH.
  echo      Install Python 3.11 or newer from https://www.python.org/downloads/
  echo      then run this script again.
  echo.
  pause
  exit /b 1
)

py -m pip install --user --upgrade pip
py -m pip install --user -r requirements.txt
if errorlevel 1 (
  echo.
  echo  [!] Setup failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo  Done. You can now double-click run.bat to launch the app.
echo.
pause
