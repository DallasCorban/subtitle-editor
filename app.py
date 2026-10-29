import os
import subprocess
import sys
import tempfile
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request

import deepgram_client
import resolve_bridge
import reviewer
import transcriber
from live_link import link as live
from srt_parser import (
    SubtitleCue,
    format_cues_split,
    format_cues_two_line,
    parse_srt,
    serialize_srt,
)

app = Flask(__name__)
# Re-read templates from disk on each request (no need to restart Flask after HTML edits)
app.config['TEMPLATES_AUTO_RELOAD'] = True


# Disable caching for all static/template files during development
@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Native file picker (opens a Windows file dialog via tkinter)
# ---------------------------------------------------------------------------

@app.route('/api/browse-file', methods=['POST'])
def browse_file():
    """Open a native file dialog and return the selected path.

    Runs in a subprocess: tkinter must own the process's main thread on
    Windows, and Flask serves us on a worker thread — so doing it inline
    silently kills the whole server.
    """
    data = request.get_json() or {}
    mode = data.get('mode', 'media')  # 'media' or 'srt'

    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_filepicker.py')
    try:
        result = subprocess.run(
            [sys.executable, helper, mode],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'File picker timed out.'}), 504

    if result.returncode != 0:
        return jsonify({'error': result.stderr.strip() or 'File picker failed.'}), 500

    path = result.stdout.strip()
    return jsonify({'path': path or None})


# ---------------------------------------------------------------------------
# SRT file operations
# ---------------------------------------------------------------------------

@app.route('/api/parse-srt', methods=['POST'])
def parse_srt_content():
    """Accept raw SRT text sent from the browser (file picker approach)."""
    data = request.get_json()
    content = (data or {}).get('content', '')
    filename = (data or {}).get('filename', 'subtitles.srt')

    if not content:
        return jsonify({'error': 'No content provided.'}), 400

    try:
        cues = parse_srt(content)
        return jsonify({
            'cues': [c.to_dict() for c in cues],
            'filename': filename,
            'count': len(cues),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/load-srt', methods=['POST'])
def load_srt():
    """Legacy path-based load (kept for server-side use)."""
    data = request.get_json()
    path = (data or {}).get('filePath', '').strip()

    if not path:
        return jsonify({'error': 'No file path provided.'}), 400
    if not os.path.isfile(path):
        return jsonify({'error': f'File not found: {path}'}), 400

    try:
        with open(path, encoding='utf-8-sig') as f:
            content = f.read()
        cues = parse_srt(content)
        return jsonify({
            'cues': [c.to_dict() for c in cues],
            'filePath': path,
            'count': len(cues),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


_save_lock = threading.Lock()


@app.route('/api/save-srt', methods=['POST'])
def save_srt():
    data = request.get_json()
    path = (data or {}).get('filePath', '').strip()
    cues_data = (data or {}).get('cues', [])

    if not path:
        return jsonify({'error': 'No file path provided.'}), 400

    cues = _cues_from_list(cues_data)
    content = serialize_srt(cues)

    try:
        # One write at a time. Two overlapping saves of the same file (a run
        # of quick edits each auto-saves) could interleave, leaving the tail
        # of the longer version after the shorter one.
        with _save_lock, open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({'success': True, 'filePath': path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------------------
# Auto-format
# ---------------------------------------------------------------------------

@app.route('/api/format', methods=['POST'])
def format_cues():
    data = request.get_json()
    cues_data = (data or {}).get('cues', [])
    max_chars = int((data or {}).get('maxChars', 42))
    mode = (data or {}).get('mode', 'two_line')  # 'two_line' | 'split'

    cues = _cues_from_list(cues_data)

    if mode == 'split':
        formatted = format_cues_split(cues, max_chars)
    else:
        formatted = format_cues_two_line(cues, max_chars)

    return jsonify({'cues': [c.to_dict() for c in formatted]})


# ---------------------------------------------------------------------------
# DaVinci Resolve integration
# ---------------------------------------------------------------------------

@app.route('/api/resolve/status')
def resolve_status():
    return jsonify(resolve_bridge.get_status())


@app.route('/api/resolve/connect', methods=['POST'])
def resolve_connect():
    return jsonify(resolve_bridge.connect())


@app.route('/api/resolve/read')
def resolve_read():
    result = resolve_bridge.read_subtitle_track()
    if 'error' in result:
        return jsonify(result), 400
    return jsonify(result)


# ---------------------------------------------------------------------------
# Whisper transcription
# ---------------------------------------------------------------------------

@app.route('/api/transcribe', methods=['POST'])
def transcribe():
    """Start a background Whisper transcription job."""
    data = request.get_json()
    file_path = (data or {}).get('filePath', '').strip()
    language = (data or {}).get('language', 'en')
    model = ((data or {}).get('model') or '').strip() or None
    engine = ((data or {}).get('engine') or 'whisper').strip()

    if not file_path:
        return jsonify({'error': 'No file path provided.'}), 400
    if engine == 'deepgram' and not deepgram_client.has_api_key():
        return jsonify({
            'error': 'No Deepgram API key configured. Set DEEPGRAM_API_KEY and '
                     'restart the app.'
        }), 400

    print(
        f"[transcribe] requested: file={os.path.basename(file_path)} "
        f"engine={engine} model={model or '(default)'}",
        flush=True,
    )

    try:
        job_id = transcriber.start_transcription(
            file_path, language, model=model, engine=engine
        )
        return jsonify({'jobId': job_id})
    except FileNotFoundError as e:
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 409
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/transcribe-upload', methods=['POST'])
def transcribe_upload():
    """Accept an uploaded audio/video file and start transcription."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded.'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Empty filename.'}), 400

    language = request.form.get('language', 'en')

    # Save to a temp file preserving the extension (ffmpeg needs it)
    ext = os.path.splitext(file.filename)[1] or '.mp4'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext, dir=tempfile.gettempdir())
    file.save(tmp.name)
    tmp.close()

    try:
        job_id = transcriber.start_transcription(tmp.name, language)
        return jsonify({'jobId': job_id, 'tempFile': tmp.name})
    except RuntimeError as e:
        os.unlink(tmp.name)
        return jsonify({'error': str(e)}), 409
    except Exception as e:
        os.unlink(tmp.name)
        return jsonify({'error': str(e)}), 500


@app.route('/api/engines')
def engines():
    """Which transcription engines this install can actually run.

    Deepgram needs an API key in the environment; the UI uses this to explain
    why the speaker option is unavailable instead of failing at click time.
    """
    review_ok, review_why = reviewer.availability()
    return jsonify({
        'whisper': True,
        'deepgram': deepgram_client.has_api_key(),
        'review': review_ok,
        'reviewReason': review_why,
    })


@app.route('/api/transcribe/status')
def transcribe_status():
    """Poll transcription progress."""
    job_id = request.args.get('jobId', '')
    if not job_id:
        return jsonify({'error': 'No jobId provided.'}), 400

    job = transcriber.get_job_status(job_id)
    if job is None:
        return jsonify({'error': 'Job not found.'}), 404

    return jsonify(job)


# ---------------------------------------------------------------------------
# Live link — the open editor tab <-> voice call / review jobs (live_link.py)
# ---------------------------------------------------------------------------

def _int_arg(name):
    v = request.args.get(name)
    try:
        return int(v) if v not in (None, '') else None
    except ValueError:
        return None


def _wait_arg(body):
    try:
        return float(body.get('wait', 4))
    except (TypeError, ValueError):
        return 4.0


@app.route('/api/live/doc', methods=['GET', 'POST'])
def live_doc():
    if request.method == 'POST':
        live.publish(request.get_json(silent=True) or {})
        return jsonify({'ok': True})
    return jsonify(live.doc(_int_arg('from'), _int_arg('to'), _int_arg('around')))


@app.route('/api/live/close', methods=['POST'])
def live_close():
    # Sent with navigator.sendBeacon on unload, so the body arrives as text.
    body = request.get_json(force=True, silent=True) or {}
    live.close(str(body.get('tab') or ''))
    return jsonify({'ok': True})


@app.route('/api/live/poll')
def live_poll():
    return jsonify(live.poll(request.args.get('tab', ''), _int_arg('fv')))


@app.route('/api/live/results', methods=['POST'])
def live_results():
    body = request.get_json(silent=True) or {}
    live.report(str(body.get('tab') or ''), body.get('results'))
    return jsonify({'ok': True})


@app.route('/api/live/find')
def live_find():
    return jsonify(live.find(request.args.get('q', '')))


@app.route('/api/live/edits', methods=['POST'])
def live_edits():
    body = request.get_json(silent=True) or {}
    edits = body.get('edits')
    if edits is None:
        edits = [body]  # a single edit posted bare
    return jsonify(live.submit(edits, body.get('rev'), _wait_arg(body)))


@app.route('/api/live/focus', methods=['POST'])
def live_focus():
    body = request.get_json(silent=True) or {}
    return jsonify(live.submit([{'op': 'focus', 'cue': body.get('cue')}], wait=_wait_arg(body)))


@app.route('/api/live/speaker', methods=['POST'])
def live_speaker():
    body = request.get_json(silent=True) or {}
    return jsonify(live.submit(
        [{'op': 'speaker', 'speaker': body.get('speaker'), 'name': body.get('name')}],
        wait=_wait_arg(body),
    ))


@app.route('/api/live/undo', methods=['POST'])
def live_undo():
    body = request.get_json(silent=True) or {}
    return jsonify(live.submit([{'op': 'undo'}], wait=_wait_arg(body)))


@app.route('/api/live/flags', methods=['GET', 'POST'])
def live_flags():
    if request.method == 'POST':
        body = request.get_json(silent=True) or {}
        return jsonify(live.set_flags(body.get('flags'), replace=body.get('replace', True) is not False))
    return jsonify(live.flags(include_all=request.args.get('all') == '1'))


@app.route('/api/live/flags/resolve', methods=['POST'])
def live_flags_resolve():
    body = request.get_json(silent=True) or {}
    res = live.resolve_flag(body.get('id') or 0, str(body.get('status') or ''))
    return jsonify(res), (400 if 'error' in res else 200)


@app.route('/api/live/strip')
def live_strip():
    return jsonify(live.strip())


# ---------------------------------------------------------------------------
# AI review (reviewer.py) — runs the local `claude` CLI on whatever is open in
# the editor tab, then sends the checked swaps to the tab over the live link.
# The Review button and the chat operator use the same endpoints.
# ---------------------------------------------------------------------------

def _start_review(work):
    job_id = reviewer.start_job(work)
    if job_id is None:
        return jsonify({'error': 'A review is already running.'}), 409
    return jsonify({'jobId': job_id})


@app.route('/api/review', methods=['POST'])
def review_start():
    """Start a review of the open transcript. Body: {note?}. Returns {jobId}."""
    body = request.get_json(silent=True) or {}
    note = str(body.get('note') or '').strip()
    ok, why = reviewer.availability()
    if not ok:
        return jsonify({'error': why}), 400
    if not live.is_open():
        return jsonify({'error': live.closed_reply()['reason']}), 400
    return _start_review(lambda job: reviewer.run_live_review(job, live, note))


@app.route('/api/review/apply', methods=['POST'])
def review_apply():
    """Apply swaps an operator worked out itself, with the same checks.

    Body: {edits: [{from_index, to_index, original, replacement, reason}],
    summary?}. Word numbers are those in GET /api/review/transcript.
    """
    body = request.get_json(silent=True) or {}
    edits = body.get('edits')
    if not isinstance(edits, list):
        return jsonify({'error': 'edits must be a list'}), 400
    summary = str(body.get('summary') or '').strip()
    return _start_review(lambda job: reviewer.run_live_review(job, live, summary, supplied=edits))


@app.route('/api/review/status')
def review_status():
    """Poll a review. ?jobId= (or none for the latest)."""
    job_id = request.args.get('jobId', '')
    job = reviewer.get_job(job_id) if job_id else reviewer.latest_job()
    if job is None:
        return jsonify({'error': 'Review not found.'}), 404
    return jsonify(job)


@app.route('/api/review/transcript')
def review_transcript():
    """The open transcript numbered exactly as the reviewer sees it."""
    return jsonify(reviewer.numbered_transcript(live))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cues_from_list(cues_data: list) -> list:
    return [
        SubtitleCue(
            index=c.get('index', i + 1),
            start_time=c['startTime'],
            end_time=c['endTime'],
            text=c['text'],
        )
        for i, c in enumerate(cues_data)
    ]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Port 5000 by default, overridable via PORT (macOS AirPlay Receiver also
# listens on 5000, which can confuse tooling even though we bind 127.0.0.1).
PORT = int(os.environ.get('PORT', 5000))


def _open_browser():
    import time
    time.sleep(1.2)
    webbrowser.open(f'http://127.0.0.1:{PORT}')


if __name__ == '__main__':
    if not os.environ.get('SUBTITLE_NO_BROWSER'):
        threading.Thread(target=_open_browser, daemon=True).start()
    app.run(host='127.0.0.1', port=PORT, debug=False)
