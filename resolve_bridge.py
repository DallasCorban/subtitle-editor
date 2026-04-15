"""
DaVinci Resolve scripting bridge.

Live operations (text edits within existing cues) use the scripting API.
Structural operations (splits / merges / timing changes) are handled by
writing a new SRT and prompting the user to re-import in Resolve.

NOTE: The fusionscript.dll is compiled against specific Python versions.
Python 3.14 may not be compatible.  All errors are caught gracefully so
the rest of the app keeps working as a standalone SRT editor.
"""

import sys
import os
from typing import Optional

_resolve = None
_connected = False
_error_msg = ''

SCRIPTING_MODULES = (
    r'C:\ProgramData\Blackmagic Design\DaVinci Resolve'
    r'\Support\Developer\Scripting\Modules'
)


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def connect() -> dict:
    global _resolve, _connected, _error_msg

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


def read_subtitle_track() -> dict:
    """Return all cues from the first subtitle track of the current timeline."""
    _, timeline = _get_timeline()
    if timeline is None:
        return {'error': 'Not connected or no active timeline.'}

    try:
        track_count = timeline.GetTrackCount('subtitle')
        if track_count == 0:
            return {'error': 'No subtitle tracks in current timeline.'}

        fps = _fps(timeline)
        start_frame = timeline.GetStartFrame()
        items = timeline.GetItemListInTrack('subtitle', 1)

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

        return {'cues': cues, 'fps': fps, 'trackCount': track_count}

    except Exception as e:
        return {'error': str(e)}


# ---------------------------------------------------------------------------
# Live text updates (within existing cue boundaries only)
# ---------------------------------------------------------------------------

def update_cue_text(resolve_id: str, new_text: str) -> dict:
    """Update the text of one subtitle cue in Resolve by its unique ID."""
    _, timeline = _get_timeline()
    if timeline is None:
        return {'success': False, 'error': 'Not connected.'}

    try:
        items = timeline.GetItemListInTrack('subtitle', 1)
        for item in items:
            if item.GetUniqueId() == resolve_id:
                ok = item.SetName(new_text)
                return {'success': bool(ok)}
        return {'success': False, 'error': 'Cue not found in Resolve track.'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def update_all_texts(cues: list) -> dict:
    """
    Batch-update the text of multiple cues.
    `cues` is a list of {'resolveId': str, 'text': str}.
    Only updates cues that have a resolveId (i.e. were read from Resolve).
    Returns count of successful updates.
    """
    _, timeline = _get_timeline()
    if timeline is None:
        return {'success': False, 'error': 'Not connected.'}

    try:
        items = timeline.GetItemListInTrack('subtitle', 1)
        id_to_item = {item.GetUniqueId(): item for item in items}
        updated = 0
        for cue in cues:
            rid = cue.get('resolveId')
            if rid and rid in id_to_item:
                id_to_item[rid].SetName(cue['text'])
                updated += 1
        return {'success': True, 'updated': updated}
    except Exception as e:
        return {'success': False, 'error': str(e)}
