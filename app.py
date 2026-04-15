import os
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request

import resolve_bridge
from srt_parser import (
    SubtitleCue,
    format_cues_split,
    format_cues_two_line,
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
