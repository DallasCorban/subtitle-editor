"""
DaVinci Resolve scripting bridge.

This bridge is read-only: it pulls subtitle items from the active timeline
so the editor can ingest captions a user has edited inside Resolve. There
is no "write back" path — Resolve's scripting API does not support
mutating existing subtitle text (item.SetName() returns False on subtitle
items, and there is no documented alternative). The round-trip back into
Resolve happens by saving a versioned SRT and dragging it onto the
timeline.

NOTE: The fusionscript.dll is compiled against specific Python versions.
Python 3.14 may not be compatible.  All errors are caught gracefully so
the rest of the app keeps working as a standalone SRT editor.
"""

import os
import subprocess
import sys

_resolve = None
_connected = False
_error_msg = ''
_dll_safe: bool | None = None  # cached probe result; None = not yet probed


def _scripting_modules_path() -> str:
    """Locate Resolve's scripting Modules directory across platforms.

    Honors RESOLVE_SCRIPT_API if the launcher set it; otherwise falls back to
    the platform-default install location.
    """
    env_api = os.environ.get('RESOLVE_SCRIPT_API')
    if env_api:
        return os.path.join(env_api, 'Modules')

    if sys.platform == 'darwin':
        return ('/Library/Application Support/Blackmagic Design/'
                'DaVinci Resolve/Developer/Scripting/Modules')
    if sys.platform == 'win32':
        program_data = os.environ.get('PROGRAMDATA', r'C:\ProgramData')
        return os.path.join(
            program_data,
            'Blackmagic Design', 'DaVinci Resolve',
            'Support', 'Developer', 'Scripting', 'Modules',
        )
    if sys.platform.startswith('linux'):
        return '/opt/resolve/Developer/Scripting/Modules'
    return ''


SCRIPTING_MODULES = _scripting_modules_path()


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def _probe_dll_safe() -> bool:
    """Try to import DaVinciResolveScript in a subprocess.

    fusionscript.dll is compiled against a specific Python ABI; importing
    it under an incompatible interpreter (e.g. Python 3.14) crashes the
    whole process natively — Python try/except can't catch it. So we
    isolate the probe in a subprocess. If it survives, the in-process
    import is also safe. If it dies, we permanently mark Resolve as
    unavailable for this session and the Flask server stays up.
    """
    global _dll_safe, _error_msg
    if _dll_safe is not None:
        return _dll_safe

    probe_code = (
        "import sys\n"
        f"sys.path.insert(0, {SCRIPTING_MODULES!r})\n"
        "import DaVinciResolveScript\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", probe_code],
            capture_output=True, text=True, timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        _dll_safe = False
        _error_msg = f'Resolve DLL probe failed to launch: {e}'
        return False

    if result.returncode == 0:
        _dll_safe = True
        return True

    _dll_safe = False
    # Non-zero exit: either a Python exception (ImportError if Resolve not
    # installed) or a native crash (DLL ABI mismatch). Both mean we can't
    # use Resolve integration this session.
    stderr_tail = (result.stderr or '').strip().splitlines()
    hint = stderr_tail[-1] if stderr_tail else f'exit code {result.returncode}'
    _error_msg = (
        f'Resolve integration unavailable: {hint}. '
        f'fusionscript.dll likely requires a different Python version '
        f'(currently {sys.version_info.major}.{sys.version_info.minor}). '
        f'The editor still works as a standalone SRT tool.'
    )
    return False


def connect() -> dict:
    global _resolve, _connected, _error_msg

    if not _probe_dll_safe():
        _connected = False
        return {'connected': False, 'error': _error_msg}

    # Ensure the module path is on sys.path
    if SCRIPTING_MODULES not in sys.path:
        sys.path.insert(0, SCRIPTING_MODULES)

    try:
        import DaVinciResolveScript as dvr
        resolve = dvr.scriptapp('Resolve')
        if resolve is None:
            _connected = False
            _error_msg = (
                'DaVinci Resolve is not running, or external scripting is '
                'disabled.  Enable it via: Preferences → General → '
                '"External scripting using" → Local network'
            )
            return {'connected': False, 'error': _error_msg}

        _resolve = resolve
        _connected = True
        _error_msg = ''
        version = _resolve.GetVersionString()
        return {'connected': True, 'version': version}

    except OSError as e:
        # Most likely the .dll ABI doesn't match Python 3.14
        _connected = False
        _error_msg = (
            f'Could not load fusionscript.dll ({e}).  '
            'DaVinci Resolve scripting requires a Python version it was '
            'compiled against (typically 3.10 or 3.11).  '
            'The tool will work as a standalone SRT editor.'
        )
        return {'connected': False, 'error': _error_msg}

    except ImportError as e:
        _connected = False
        _error_msg = f'Import error: {e}'
        return {'connected': False, 'error': _error_msg}

    except Exception as e:
        _connected = False
        _error_msg = str(e)
        return {'connected': False, 'error': _error_msg}


def get_status() -> dict:
    if _connected and _resolve:
        try:
            version = _resolve.GetVersionString()
            return {'connected': True, 'version': version}
        except Exception:
            pass
    return {'connected': False, 'error': _error_msg}


# ---------------------------------------------------------------------------
# Reading subtitle track
# ---------------------------------------------------------------------------

def _get_timeline():
    if not _connected or not _resolve:
        return None, None
    try:
        project = _resolve.GetProjectManager().GetCurrentProject()
        if not project:
            return None, None
        timeline = project.GetCurrentTimeline()
        return project, timeline
    except Exception:
        return None, None


def _fps(timeline) -> float:
    try:
        return float(timeline.GetSetting('timelineFrameRate'))
    except Exception:
        return 24.0


def _ms_to_time(ms: int) -> str:
    ms = max(0, ms)
    h = ms // 3_600_000; ms %= 3_600_000
    m = ms // 60_000;    ms %= 60_000
    s = ms // 1_000;     ms %= 1_000
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def read_subtitle_track(track_index: int = 0) -> dict:
    """
    Return all cues from a subtitle track of the current timeline.

    track_index=0 means auto-detect: try each track and use the first
    one that has items. Otherwise use the specified 1-based index.
    """
    _, timeline = _get_timeline()
    if timeline is None:
        return {'error': 'Not connected or no active timeline.'}

    try:
        track_count = timeline.GetTrackCount('subtitle')
        if track_count == 0:
            return {'error': 'No subtitle tracks in current timeline.'}

        fps = _fps(timeline)
        start_frame = timeline.GetStartFrame()

        # Determine which track to read
        if track_index > 0:
            tracks_to_try = [track_index]
        else:
            # Auto: try all tracks, pick the first with items
            tracks_to_try = list(range(1, track_count + 1))

        items = None
        used_track = None
        for tidx in tracks_to_try:
            candidate = timeline.GetItemListInTrack('subtitle', tidx)
            if candidate and len(candidate) > 0:
                items = candidate
                used_track = tidx
                break

        if not items:
            return {'error': f'No subtitle items found in any of the {track_count} subtitle track(s).'}

        cues = []
        for item in items:
            item_start = item.GetStart() - start_frame
            item_end = item.GetEnd() - start_frame
            start_ms = int(item_start / fps * 1000)
            end_ms = int(item_end / fps * 1000)
            cues.append({
                'startTime': _ms_to_time(start_ms),
                'endTime': _ms_to_time(end_ms),
                'text': item.GetName(),
                'resolveId': item.GetUniqueId(),
            })

        return {'cues': cues, 'fps': fps, 'trackCount': track_count, 'trackUsed': used_track}

    except Exception as e:
        return {'error': str(e)}


