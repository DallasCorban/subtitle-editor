"""
Deepgram Nova-3 transcription with speaker diarization.

Whisper is the more verbatim transcriber for clean single-speaker voiceover,
but it has no concept of *who* is talking. For interview / panel audio headed
for a read-as-prose transcript document, Nova-3 returns a speaker label inline
with every word — and it beats Whisper on exactly this kind of multi-speaker
audio — so it runs as its own pipeline rather than as a second pass to
reconcile against Whisper's words. Nothing downstream has to arbitrate between
two transcripts.

Emits the same {"word", "start", "end", "probability"} dicts as the Whisper
backends, plus "speaker" (an int index), so the editor doesn't care which ran.

Needs a DEEPGRAM_API_KEY environment variable. Stdlib only — no new deps.
"""

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

API_URL = "https://api.deepgram.com/v1/listen"
MODEL = "nova-3"

# Generous — covers the upload of a long file over a slow connection plus
# Deepgram's own processing time.
TIMEOUT_S = 1800


# ---------------------------------------------------------------------------
# API key
# ---------------------------------------------------------------------------

def api_key() -> str | None:
    key = (os.environ.get("DEEPGRAM_API_KEY") or "").strip()
    return key or None


def has_api_key() -> bool:
    return api_key() is not None


# ---------------------------------------------------------------------------
# Audio extraction
# ---------------------------------------------------------------------------

def _find_ffmpeg() -> str | None:
    """System ffmpeg if present, else the imageio-ffmpeg bundled binary."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _extract_audio(file_path: str) -> tuple[str, bool]:
    """Transcode to 16 kHz mono FLAC for upload.

    Returns (path, is_temp). Sending the original file would work — Deepgram
    accepts video containers — but a ProRes master is gigabytes of video we'd
    be uploading to transcribe the audio. 16 kHz mono FLAC is what the model
    listens to anyway and is ~1% of the size, so this is the difference
    between a job that takes seconds and one that takes an hour.

    Falls back to the original file if no ffmpeg can be found.
    """
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return file_path, False

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".flac")
    tmp.close()

    cmd = [
        ffmpeg, "-nostdin", "-y",
        "-i", file_path,
        "-vn",                 # drop video
        "-ac", "1",            # mono
        "-ar", "16000",        # 16 kHz — Deepgram's working rate
        "-c:a", "flac",
        tmp.name,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except (subprocess.TimeoutExpired, OSError):
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
        return file_path, False

    if result.returncode != 0 or not os.path.getsize(tmp.name):
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
        return file_path, False

    return tmp.name, True


# ---------------------------------------------------------------------------
# Upload with progress
# ---------------------------------------------------------------------------

class _ProgressReader:
    """File wrapper that reports upload progress into the job dict.

    Deepgram's batch endpoint is a single request/response — there's no
    progress stream to poll. Upload is the slow part for anything long, so
    bytes-sent is the only honest progress we can show; the remainder of the
    bar is held back for Deepgram's own processing.
    """

    def __init__(self, fh, total: int, job: dict, floor: float, ceiling: float):
        self._fh = fh
        self._total = max(1, total)
        self._sent = 0
        self._job = job
        self._floor = floor
        self._ceiling = ceiling

    def read(self, size=-1):
        chunk = self._fh.read(size)
        if chunk:
            self._sent += len(chunk)
            frac = min(1.0, self._sent / self._total)
            self._job["progress"] = self._floor + (self._ceiling - self._floor) * frac
        return chunk

    def __getattr__(self, name):
        return getattr(self._fh, name)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe(job: dict, file_path: str, language: str = "en") -> list[dict]:
    """Run a diarized Nova-3 transcription. Returns word dicts with speakers."""
    key = api_key()
    if not key:
        raise RuntimeError(
            "No Deepgram API key. Set the DEEPGRAM_API_KEY environment "
            "variable and restart the app."
        )

    job["stage"] = "extracting"
    job["progress"] = 0.02
    audio_path, is_temp = _extract_audio(file_path)

    try:
        params = {
            "model": MODEL,
            "language": language or "en",
            "diarize": "true",
            # Punctuation and capitalisation matter far more for a document
            # meant to be read than they do for captions.
            "punctuate": "true",
            "smart_format": "true",
        }
        query = "&".join(f"{k}={v}" for k, v in params.items())
        size = os.path.getsize(audio_path)

        job["stage"] = "uploading"
        with open(audio_path, "rb") as fh:
            body = _ProgressReader(fh, size, job, floor=0.05, ceiling=0.75)
            req = urllib.request.Request(
                f"{API_URL}?{query}",
                data=body,
                method="POST",
                headers={
                    "Authorization": f"Token {key}",
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(size),
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                    job["stage"] = "processing"
                    job["progress"] = 0.85
                    payload = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                raise RuntimeError(_http_error_message(e)) from None
            except urllib.error.URLError as e:
                raise RuntimeError(f"Could not reach Deepgram: {e.reason}") from None
    finally:
        if is_temp and os.path.exists(audio_path):
            os.unlink(audio_path)

    return _words_from_payload(payload, job)


def _http_error_message(e: urllib.error.HTTPError) -> str:
    try:
        detail = json.loads(e.read().decode("utf-8")).get("err_msg", "")
    except Exception:
        detail = ""

    if e.code == 401:
        return "Deepgram rejected the API key. Check DEEPGRAM_API_KEY."
    if e.code in (402, 403):
        return f"Deepgram refused the request (credits or permissions). {detail}".strip()
    if e.code == 400:
        return f"Deepgram couldn't read that audio. {detail}".strip()
    return f"Deepgram error {e.code}. {detail}".strip()


def _words_from_payload(payload: dict, job: dict) -> list[dict]:
    """Flatten Deepgram's response into the app's word dicts."""
    try:
        alt = payload["results"]["channels"][0]["alternatives"][0]
    except (KeyError, IndexError):
        return []

    words = []
    for w in alt.get("words", []):
        # smart_format returns both a raw `word` and a `punctuated_word`
        # carrying capitalisation and punctuation. A document wants the latter.
        text = (w.get("punctuated_word") or w.get("word") or "").strip()
        if not text:
            continue
        speaker = w.get("speaker")
        words.append({
            "word": text,
            "start": round(float(w.get("start", 0) or 0), 3),
            "end": round(float(w.get("end", 0) or 0), 3),
            "probability": round(float(w.get("confidence", 1.0) or 0.0), 3),
            "speaker": int(speaker) if speaker is not None else None,
        })

    if words:
        job["duration"] = words[-1]["end"]
    job["segments_done"] = len(words)
    return words
