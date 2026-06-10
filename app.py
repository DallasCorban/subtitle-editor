import os
import subprocess
import sys
import tempfile
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request

import resolve_bridge
import transcriber
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
        with open(path, 'w', encoding='utf-8') as f:
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

    if not file_path:
        return jsonify({'error': 'No file path provided.'}), 400

    print(f"[transcribe] requested: file={os.path.basename(file_path)} model={model or '(default)'}", flush=True)

    try:
        job_id = transcriber.start_transcription(file_path, language, model=model)
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

def _open_browser():
    import time
    time.sleep(1.2)
    webbrowser.open('http://127.0.0.1:5000')


if __name__ == '__main__':
    threading.Thread(target=_open_browser, daemon=True).start()
    app.run(host='127.0.0.1', port=5000, debug=False)
