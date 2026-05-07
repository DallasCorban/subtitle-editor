@echo off
title Subtitle Editor

:: DaVinci Resolve scripting environment
set RESOLVE_SCRIPT_API=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting
set RESOLVE_SCRIPT_LIB=C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll
set PYTHONPATH=%PYTHONPATH%;%RESOLVE_SCRIPT_API%\Modules\

:: CUDA DLLs for faster-whisper (cublas, cudnn, nvrtc)
set PATH=C:\Users\ben\AppData\Roaming\Python\Python314\site-packages\nvidia\cublas\bin;%PATH%
set PATH=C:\Users\ben\AppData\Roaming\Python\Python314\site-packages\nvidia\cudnn\bin;%PATH%
set PATH=C:\Users\ben\AppData\Roaming\Python\Python314\site-packages\nvidia\cuda_nvrtc\bin;%PATH%

echo Starting Subtitle Editor...
echo.

cd /d "%~dp0"
py app.py

if %errorlevel% neq 0 (
  echo.
  echo Something went wrong. Make sure Python is installed.
  pause
)
