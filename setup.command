#!/bin/bash
# Subtitle Editor — one-time setup (macOS / Linux)
# Double-click in Finder to run, or invoke from a terminal.
set -e
cd "$(dirname "$0")"

echo
echo "  Subtitle Editor — One-time setup"
echo "  --------------------------------"
echo
echo "  This will install the Python packages the app needs (Flask,"
echo "  faster-whisper, etc.) into your user Python."
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "  [!] python3 isn't installed or isn't on PATH."
  echo "      Install Python 3.11+ from https://www.python.org/downloads/"
  echo "      then run this script again."
  echo
  read -n 1 -r -p "Press any key to close..."
  exit 1
fi

python3 -m pip install --user --upgrade pip
python3 -m pip install --user -r requirements.txt

echo
echo "  Done. You can now double-click run.command to launch the app."
echo
read -n 1 -r -p "Press any key to close..."
