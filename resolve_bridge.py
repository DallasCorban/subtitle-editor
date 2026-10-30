"""
DaVinci Resolve scripting bridge.

This bridge is read-only: it pulls subtitle items from the active timeline
so the editor can ingest captions a user has edited inside Resolve, and it
can move the playhead to a caption (move_playhead) so Ben can listen to it,
which changes nothing in the project. There
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


# ---------------------------------------------------------------------------
# Moving the playhead (the only thing here that acts on Resolve, and it
# changes nothing in the project: no clips, no text, no settings)
# ---------------------------------------------------------------------------

def parse_rate(value) -> float:
    """Resolve gives the frame rate as a string ('25', '29.97', '29.97 DF')."""
    num = ''.join(ch for ch in str(value or '') if ch.isdigit() or ch == '.')
    try:
        fps = float(num)
    except ValueError:
        return 24.0
    return fps if fps > 0 else 24.0


def _nominal(fps: float) -> int:
    """Frames counted per timecode second: 30 for 29.97, 24 for 23.976."""
    return int(round(fps))


def _drop_per_minute(fps: float, drop: bool) -> int:
    """Frame numbers skipped each minute (bar every tenth) in drop frame."""
    return _nominal(fps) // 15 if drop and abs(fps - round(fps)) > 0.001 else 0


def timecode_to_frames(tc: str, fps: float, drop: bool = False) -> int:
    """'01:00:00:00' (or '01:00:00;00' for drop frame) to a frame count."""
    parts = [int(p) for p in str(tc).replace(';', ':').replace('.', ':').split(':')]
    if len(parts) != 4:
        raise ValueError(f'not a timecode: {tc!r}')
    h, m, s, f = parts
    nominal = _nominal(fps)
    frames = ((h * 3600 + m * 60 + s) * nominal) + f
    dpm = _drop_per_minute(fps, drop)
    if dpm:
        minutes = h * 60 + m
        frames -= dpm * (minutes - minutes // 10)
    return frames


def frames_to_timecode(frames: int, fps: float, drop: bool = False) -> str:
    """A frame count to 'HH:MM:SS:FF' ('HH:MM:SS;FF' in drop frame)."""
    nominal = _nominal(fps)
    frames = max(0, int(frames))
    dpm = _drop_per_minute(fps, drop)
    if dpm:
        per_10min = nominal * 600 - dpm * 9
        per_min = nominal * 60 - dpm
        tens, rem = divmod(frames, per_10min)
        frames += dpm * 9 * tens
        if rem > dpm:
            frames += dpm * ((rem - dpm) // per_min)
    f = frames % nominal
    s = (frames // nominal) % 60
    m = (frames // (nominal * 60)) % 60
    h = frames // (nominal * 3600)
    sep = ';' if dpm else ':'
    return f'{h:02d}:{m:02d}:{s:02d}{sep}{f:02d}'


def seconds_to_frames(seconds: float, fps: float) -> int:
    """Real time to frames: 29.97 really is 30000/1001 frames a second."""
    nominal = _nominal(fps)
    real = nominal * 1000 / 1001 if abs(fps - nominal) > 0.001 else float(nominal)
    return int(round(seconds * real))


def srt_time_to_seconds(t) -> float:
    """'00:01:23,456' (SRT), '00:01:23.456' or plain seconds."""
    if isinstance(t, (int, float)):
        return float(t)
    s = str(t or '').strip().replace(',', '.')
    if not s:
        raise ValueError('no time given')
    total = 0.0
    for part in s.split(':'):
        total = total * 60 + float(part)
    return total


def _norm_text(s: str) -> str:
    kept = ''.join(ch.lower() if ch.isalnum() or ch.isspace() else ' ' for ch in str(s or ''))
    return ' '.join(kept.split())


def match_subtitle_item(items, text: str, expected_frame: int):
    """Pick the subtitle clip that is this caption.

    items: [(start_frame, name)]. The same words can appear twice, and the
    copy in Resolve may be an older version with a word or two different,
    so: exact text first, else the closest wording, and on a tie the clip
    nearest where the SRT says it should be. Returns (index, exact) or None.
    """
    import difflib
    want = _norm_text(text)
    if not want or not items:
        return None
    best = None
    for i, (start, name) in enumerate(items):
        got = _norm_text(name)
        score = 1.0 if got == want else difflib.SequenceMatcher(None, want, got).ratio()
        key = (score, -abs(start - expected_frame))
        if best is None or key > best[0]:
            best = (key, i)
    (score, _), i = best
    if score < 0.6:
        return None
    return i, score == 1.0


def _fail(msg: str) -> dict:
    return {'ok': False, 'error': msg}


def _plain_connect_error(err: str) -> str:
    low = (err or '').lower()
    if not err or 'not running' in low or 'scripting is' in low:
        return ('Could not reach Resolve. Either it is not running, or external '
                'scripting is off (Preferences, General, External scripting using: Local).')
    return err


def _current_project():
    """(project, None) or (None, plain error). Reconnects once if Resolve
    was restarted since the last call."""
    for attempt in (1, 2):
        if attempt == 2 or not _connected or not _resolve:
            res = connect()
            if not res.get('connected'):
                return None, _plain_connect_error(res.get('error', ''))
        try:
            project = _resolve.GetProjectManager().GetCurrentProject()
        except Exception:
            continue
        if not project:
            return None, 'Resolve is open but no project is loaded.'
        return project, None
    return None, 'Resolve stopped answering. Is it still open?'


def move_playhead(srt_seconds: float, text: str = '') -> dict:
    """Put the playhead of the current Resolve timeline on a caption.

    First the matching subtitle clip on the timeline (its real position,
    whatever offset the SRT was dropped at), else the timeline's start
    timecode plus the SRT time. Never raises; a failure comes back as a
    short plain sentence in 'error'.
    """
    project, err = _current_project()
    if err:
        return _fail(err)
    try:
        timeline = project.GetCurrentTimeline()
    except Exception:
        timeline = None
    if not timeline:
        return _fail('No timeline is open in Resolve.')

    try:
        fps = parse_rate(timeline.GetSetting('timelineFrameRate')
                         or project.GetSetting('timelineFrameRate'))
        start_tc = timeline.GetStartTimecode() or '00:00:00:00'
        drop = (str(timeline.GetSetting('timelineDropFrameTimecode') or '0') == '1'
                or ';' in start_tc)
        expected = timecode_to_frames(start_tc, fps, drop) + seconds_to_frames(srt_seconds, fps)

        target, method, clip_text = expected, 'srt-time', None
        if text:
            for tidx in range(1, (timeline.GetTrackCount('subtitle') or 0) + 1):
                clips = timeline.GetItemListInTrack('subtitle', tidx) or []
                found = match_subtitle_item([(c.GetStart(), c.GetName()) for c in clips],
                                            text, expected)
                if found:
                    i, exact = found
                    target = clips[i].GetStart()
                    clip_text = clips[i].GetName()
                    method = 'subtitle-clip' if exact else 'subtitle-clip-closest'
                    break

        tc = frames_to_timecode(target, fps, drop)
        if not timeline.SetCurrentTimecode(tc):
            return _fail(f'Resolve would not move the playhead to {tc}. '
                         'Try the Edit page.')
        out = {
            'ok': True,
            'timecode': tc,
            'method': method,
            'project': project.GetName(),
            'timeline': timeline.GetName(),
            'fps': fps,
            'offsetFrames': target - expected,
        }
        if clip_text is not None:
            out['clipText'] = clip_text
        return out
    except Exception as e:
        return _fail(f'Could not move the playhead: {e}')


