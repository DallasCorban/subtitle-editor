"""
Whisper transcription service using faster-whisper.

Runs transcription in a background thread so the Flask server stays responsive.
Only one transcription can run at a time (the model uses ~3 GB VRAM).
"""

import os
import sys
import threading
import uuid
from typing import Optional

_model = None
_model_lock = threading.Lock()
_jobs: dict = {}  # job_id -> job state dict


# ---------------------------------------------------------------------------
# Model management
# ---------------------------------------------------------------------------

def _model_settings() -> tuple:
    """Pick a sensible (model_size, device, compute_type) for this machine.

    - Windows / Linux with NVIDIA: large-v3 on CUDA at float16 (fast, accurate).
    - Apple Silicon / CPU-only: medium model on CPU at int8 (acceptable speed,
      faster-whisper has no Metal/MPS backend so CPU is the only option).

    Override via env vars: SUBTITLE_WHISPER_MODEL, SUBTITLE_WHISPER_DEVICE,
    SUBTITLE_WHISPER_COMPUTE_TYPE.
    """
    if sys.platform == 'darwin':
        model_size = 'medium'
        device = 'cpu'
        compute_type = 'int8'
    else:
        model_size = 'large-v3'
        device = 'auto'        # CUDA if available, else CPU
        compute_type = 'float16'

    return (
        os.environ.get('SUBTITLE_WHISPER_MODEL', model_size),
        os.environ.get('SUBTITLE_WHISPER_DEVICE', device),
        os.environ.get('SUBTITLE_WHISPER_COMPUTE_TYPE', compute_type),
    )


def _setup_cuda_dll_paths() -> None:
    """On Windows, prepend nvidia/{cublas,cudnn,cuda_nvrtc}/bin from this
    Python's site-packages to the DLL search path. Without this,
    faster-whisper raises 'Library cublas64_12.dll is not found'.

    No-op on Mac/Linux (CUDA isn't bundled there).
    """
    if sys.platform != 'win32':
        return

    import site
    seen = set()
    site_dirs = [site.getusersitepackages(), *site.getsitepackages()]
    for site_dir in site_dirs:
        for sub in ('cublas', 'cudnn', 'cuda_nvrtc', 'cuda_runtime'):
            p = os.path.join(site_dir, 'nvidia', sub, 'bin')
            if p in seen or not os.path.isdir(p):
                continue
            seen.add(p)
            os.environ['PATH'] = p + os.pathsep + os.environ.get('PATH', '')
            try:
                os.add_dll_directory(p)
            except (OSError, AttributeError):
                pass


def _ensure_model():
    """Lazy-load the WhisperModel once, reuse across transcriptions."""
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        # Double-check after acquiring lock
        if _model is not None:
            return _model

        _setup_cuda_dll_paths()
        from faster_whisper import WhisperModel

        model_size, device, compute_type = _model_settings()
        _model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
        )
        return _model


def get_model_status() -> dict:
    """Return whether the Whisper model is loaded."""
    return {"loaded": _model is not None}


# ---------------------------------------------------------------------------
# Transcription jobs
# ---------------------------------------------------------------------------

def _any_running() -> bool:
    return any(j["status"] == "running" for j in _jobs.values())


def start_transcription(file_path: str, language: str = "en") -> str:
    """
    Start a background transcription job.

    Returns the job ID (UUID string).
    Raises RuntimeError if a job is already running.
    Raises FileNotFoundError if the file doesn't exist.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    if _any_running():
        raise RuntimeError(
            "A transcription is already in progress. Wait for it to finish."
        )

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {
        "status": "running",
        "progress": 0.0,
        "duration": 0.0,
        "segments_done": 0,
        "last_segment_end": 0.0,
        "words": [],
        "error": None,
        "file": os.path.basename(file_path),
    }

    t = threading.Thread(
        target=_run_transcription,
        args=(job_id, file_path, language),
        daemon=True,
    )
    t.start()
    return job_id


def get_job_status(job_id: str) -> Optional[dict]:
    """Return the job state dict, or None if not found."""
    return _jobs.get(job_id)


def _run_transcription(job_id: str, file_path: str, language: str):
    """Worker function — runs in a background thread."""
    job = _jobs[job_id]

    try:
        model = _ensure_model()

        segments_gen, info = model.transcribe(
            file_path,
            language=language,
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
        )

        job["duration"] = info.duration if info.duration else 0.0
        all_words = []

        for segment in segments_gen:
            if segment.words:
                for w in segment.words:
                    word_text = w.word.strip()
                    if word_text:  # skip empty tokens
                        all_words.append({
                            "word": word_text,
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                        })

            job["segments_done"] += 1
            job["last_segment_end"] = segment.end

            if job["duration"] > 0:
                job["progress"] = min(
                    1.0, segment.end / job["duration"]
                )

        job["words"] = all_words
        job["progress"] = 1.0
        job["status"] = "complete"

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
