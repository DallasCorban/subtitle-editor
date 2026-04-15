@echo off
title Subtitle Editor

:: DaVinci Resolve scripting environment
set RESOLVE_SCRIPT_API=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting
set RESOLVE_SCRIPT_LIB=C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll
set PYTHONPATH=%PYTHONPATH%;%RESOLVE_SCRIPT_API%\Modules\

echo Starting Subtitle Editor...
echo.

cd /d "%~dp0"
py app.py

if %errorlevel% neq 0 (
  echo.
  echo Something went wrong. Make sure Python is installed.
  pause
)
