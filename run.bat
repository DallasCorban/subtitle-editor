@echo off
title Subtitle Editor
cd /d "%~dp0"

:: DaVinci Resolve scripting — point the bridge at the Windows install location.
:: (resolve_bridge.py also has fallbacks if these vars aren't set.)
set RESOLVE_SCRIPT_API=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting
set RESOLVE_SCRIPT_LIB=C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll
set PYTHONPATH=%PYTHONPATH%;%RESOLVE_SCRIPT_API%\Modules\

:: CUDA DLL paths are auto-detected by transcriber.py at first use —
:: works regardless of where Python is installed on this machine.

:: Quiet the HF symlinks-on-Windows warning — informational only, the cache
:: still works fine without symlinks, just uses a bit more disk.
set HF_HUB_DISABLE_SYMLINKS_WARNING=1

echo Starting Subtitle Editor...
echo.

:: -u = unbuffered stdout/stderr so print() output appears in this window
:: in real time (otherwise Windows can hold it for minutes).
py -u app.py

if %errorlevel% neq 0 (
  echo.
  echo Something went wrong. Make sure Python is installed and run setup.bat first.
  pause
)
