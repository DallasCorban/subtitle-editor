import os
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
    generate_word_srt,
    parse_srt,
    serialize_srt,
)

app = Flask(__name__)


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
    """Open a native file dialog and return the selected path."""
    import tkinter as tk
    from tkinter import filedialog

    data = request.get_json() or {}
    mode = data.get('mode', 'media')  # 'media' or 'srt'

    if mode == 'srt':
        title = 'Select SRT file'
        filetypes = [('SRT files', '*.srt'), ('All files', '*.*')]
    else:
        title = 'Select audio or video file'
        filetypes = [
            ('Media files', '*.mp4 *.mov *.mkv *.avi *.webm *.mp3 *.wav *.m4a *.flac *.ogg *.aac *.wma'),
            ('All files', '*.*'),
        ]

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    path = filedialog.askopenfilename(title=title, filetypes=filetypes)
    root.destroy()

    if not path:
        return jsonify({'path': None})
    return jsonify({'path': path})


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


@app.route('/api/resolve/reimport-srt', methods=['POST'])
def resolve_reimport():
    """Save the current SRT and attempt to reimport it into Resolve."""
    data = request.get_json()
    srt_path = (data or {}).get('srtPath', '').strip()
    cues_data = (data or {}).get('cues', [])

    if not srt_path:
        return jsonify({'error': 'No SRT path provided.'}), 400

    # Save the SRT first
    cues = _cues_from_list(cues_data)
    content = serialize_srt(cues)
    try:
        with open(srt_path, 'w', encoding='utf-8') as f:
            f.write(content)
    except Exception as e:
        return jsonify({'error': f'Could not save SRT: {e}'}), 500

    # Try to reimport into Resolve
    result = resolve_bridge.reimport_srt(srt_path)
    result['srtPath'] = srt_path
    result['saved'] = True
    return jsonify(result)


@app.route('/api/resolve/update-cue', methods=['POST'])
def resolve_update_cue():
    data = request.get_json()
    resolve_id = (data or {}).get('resolveId')
    text = (data or {}).get('text', '')
    if not resolve_id:
        return jsonify({'success': False, 'error': 'No resolveId provided.'}), 400
    return jsonify(resolve_bridge.update_cue_text(resolve_id, text))


@app.route('/api/resolve/push-all', methods=['POST'])
def resolve_push_all():
    """Push text of all cues that have a resolveId back to Resolve."""
    data = request.get_json()
    cues = (data or {}).get('cues', [])
    return jsonify(resolve_bridge.update_all_texts(cues))


# ---------------------------------------------------------------------------
# Whisper transcription
# ---------------------------------------------------------------------------

@app.route('/api/transcribe', methods=['POST'])
def transcribe():
    """Start a background Whisper transcription job."""
    data = request.get_json()
    file_path = (data or {}).get('filePath', '').strip()
    language = (data or {}).get('language', 'en')

    if not file_path:
        return jsonify({'error': 'No file path provided.'}), 400

    try:
        job_id = transcriber.start_transcription(file_path, language)
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


@app.route('/api/export-word-srt', methods=['POST'])
def export_word_srt():
    """Generate a word-level SRT (one cue per word, contiguous timing)."""
    data = request.get_json()
    words = (data or {}).get('words', [])

    if not words:
        return jsonify({'error': 'No words provided.'}), 400

    try:
        srt_content = generate_word_srt(words)
        return jsonify({'srt': srt_content})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/resolve/push-word-groups', methods=['POST'])
def resolve_push_word_groups():
    """
    Push word groups to Resolve — each word-item gets its group's combined text.
    This is the live-update mechanism: all word-items in a group show the same text,
    so it looks like one continuous subtitle spanning the full group duration.
    """
    data = request.get_json()
    words = (data or {}).get('words', [])
    breaks = (data or {}).get('breakPositions', [])

    if not words:
        return jsonify({'error': 'No words provided.'}), 400

    # Build groups from break positions
    cuts = [0] + sorted(breaks) + [len(words)]
    updates = []  # list of (resolveId, text)

    for i in range(len(cuts) - 1):
        group_words = words[cuts[i]:cuts[i + 1]]
        combined_text = ' '.join(w['word'] for w in group_words)

        for w in group_words:
            rid = w.get('resolveId')
            if rid:
                updates.append((rid, combined_text))

    if not updates:
        return jsonify({'success': True, 'updated': 0,
                        'note': 'No words have resolveIds. Read from Resolve first.'})

    return jsonify(resolve_bridge.batch_set_names(updates))


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
