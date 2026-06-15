#!/bin/bash
# Subtitle Editor — launcher (macOS / Linux)
# Double-click in Finder to start, or invoke from a terminal.
cd "$(dirname "$0")"

# DaVinci Resolve scripting — point the bridge at the Mac install location.
# (resolve_bridge.py also has fallbacks if these vars aren't set.)
if [[ "$OSTYPE" == "darwin"* ]]; then
  export RESOLVE_SCRIPT_API="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
  export RESOLVE_SCRIPT_LIB="/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
elif [[ "$OSTYPE" == "linux"* ]]; then
  export RESOLVE_SCRIPT_API="/opt/resolve/Developer/Scripting"
  export RESOLVE_SCRIPT_LIB="/opt/resolve/libs/Fusion/fusionscript.so"
fi
export PYTHONPATH="$PYTHONPATH:$RESOLVE_SCRIPT_API/Modules"

# Use the project venv if it exists (created by setup), else fall back to python3.
if [[ -x "$(dirname "$0")/.venv/bin/python" ]]; then
  exec "$(dirname "$0")/.venv/bin/python" app.py
fi
python3 app.py
