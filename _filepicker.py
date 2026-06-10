"""Helper invoked as a subprocess by /api/browse-file.

On Windows, tkinter must be created and torn down on the process's main
thread. Doing it inside a Flask worker thread silently kills the whole
Python process, so the web app launches us as a short-lived subprocess
where tkinter owns the main thread cleanly. The selected path is written
to stdout; an empty line means the user cancelled.

Usage:  py _filepicker.py {srt|media}
"""

import sys
import tkinter as tk
from tkinter import filedialog


def _enable_dpi_awareness() -> None:
    """Mark this process DPI-aware so the file dialog renders crisply.

    Without this, Windows bitmap-stretches tkinter windows on high-DPI
    displays, making the dialog look blurry/low-resolution. Try the modern
    per-monitor API first, then fall back to the older system-DPI call.
    No-op on non-Windows platforms.
    """
    if sys.platform != "win32":
        return
    import ctypes

    try:
        # PROCESS_PER_MONITOR_DPI_AWARE (Windows 8.1+)
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            # System-DPI-aware fallback (Windows Vista+)
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass


def main() -> int:
    _enable_dpi_awareness()

    mode = sys.argv[1] if len(sys.argv) > 1 else "media"

    if mode == "srt":
        title = "Select SRT file"
        filetypes = [("SRT files", "*.srt"), ("All files", "*.*")]
    else:
        title = "Select audio or video file"
        filetypes = [
            ("Media files",
             "*.mp4 *.mov *.mkv *.avi *.webm *.mp3 *.wav *.m4a *.flac *.ogg *.aac *.wma"),
            ("All files", "*.*"),
        ]

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(title=title, filetypes=filetypes)
    root.destroy()

    sys.stdout.write(path or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
