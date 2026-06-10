"""
Whisper transcription service.

Backend is chosen at runtime based on platform:
- Apple Silicon Mac → mlx-whisper (Metal-accelerated, ~10x realtime).
- Windows / Linux   → faster-whisper (CUDA on NVIDIA, CPU fallback).

Both backends emit the same shape: a list of {"word", "start", "end"} dicts,
so the rest of the app doesn't care which ran.

Runs in a background thread so the Flask server stays responsive. Only one
transcription runs at a time (the model uses ~3 GB VRAM/RAM).
"""

import os
import shutil
import sys
import threading
import uuid
from typing import Optional

_models: dict = {}  # model_name -> WhisperModel (faster-whisper only; mlx caches via repo path)
_model_lock = threading.Lock()
_jobs: dict = {}  # job_id -> job state dict

# Default chosen for verbatim accuracy on clean English voiceover:
# large-v2 paraphrases noticeably less than large-v3 on this kind of content.
# Override via SUBTITLE_WHISPER_MODEL env var or per-request `model` argument.
DEFAULT_FW_MODEL = "large-v2"
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo"


# ---------------------------------------------------------------------------
# Public API — same shape on both backends
# ---------------------------------------------------------------------------

def start_transcription(file_path: str, language: str = "en", model: str | None = None) -> str:
    """Start a background transcription job. Returns the job ID."""
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
        "model": model or os.environ.get("SUBTITLE_WHISPER_MODEL", ""),
    }

    t = threading.Thread(
        target=_run_transcription,
        args=(job_id, file_path, language, model),
        daemon=True,
    )
    t.start()
    return job_id


def get_job_status(job_id: str) -> Optional[dict]:
    return _jobs.get(job_id)


def get_model_status() -> dict:
    return {"loaded": bool(_models), "models": list(_models.keys())}


# ---------------------------------------------------------------------------
# Job worker
# ---------------------------------------------------------------------------

def _any_running() -> bool:
    return any(j["status"] == "running" for j in _jobs.values())


def _run_transcription(job_id: str, file_path: str, language: str, model: str | None):
    """Worker function — runs in a background thread."""
    job = _jobs[job_id]
    try:
        if sys.platform == "darwin":
            _transcribe_with_mlx(job, file_path, language, model)
        else:
            _transcribe_with_faster_whisper(job, file_path, language, model)
        job["progress"] = 1.0
        job["status"] = "complete"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


# ---------------------------------------------------------------------------
# Backend: faster-whisper (Windows / Linux)
# ---------------------------------------------------------------------------

def _faster_whisper_settings(model_override: str | None = None) -> tuple:
    """Pick (model_size, device, compute_type) for the local hardware."""
    model = (
        model_override
        or os.environ.get("SUBTITLE_WHISPER_MODEL")
        or DEFAULT_FW_MODEL
    )
    return (
        model,
        os.environ.get("SUBTITLE_WHISPER_DEVICE", "auto"),
        os.environ.get("SUBTITLE_WHISPER_COMPUTE_TYPE", "float16"),
    )


def _setup_cuda_dll_paths() -> None:
    """Prepend nvidia/{cublas,cudnn,cuda_nvrtc}/bin to the Windows DLL
    search path, regardless of where Python is installed. No-op elsewhere."""
    if sys.platform != "win32":
        return
    import site
    seen = set()
    for site_dir in [site.getusersitepackages(), *site.getsitepackages()]:
        for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            p = os.path.join(site_dir, "nvidia", sub, "bin")
            if p in seen or not os.path.isdir(p):
                continue
            seen.add(p)
            os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
            try:
                os.add_dll_directory(p)
            except (OSError, AttributeError):
                pass


def _ensure_faster_whisper(model_override: str | None = None):
    size, device, compute_type = _faster_whisper_settings(model_override)
    cached = _models.get(size)
    if cached is not None:
        print(f"[transcriber] reusing cached model: {size}", flush=True)
        return cached, size
    with _model_lock:
        cached = _models.get(size)
        if cached is not None:
            return cached, size
        _setup_cuda_dll_paths()
        from faster_whisper import WhisperModel
        print(f"[transcriber] loading model: {size} (device={device}, compute={compute_type})", flush=True)
        _models[size] = WhisperModel(size, device=device, compute_type=compute_type)
        print(f"[transcriber] loaded: {size}", flush=True)
        return _models[size], size


def _transcribe_with_faster_whisper(job: dict, file_path: str, language: str, model_override: str | None):
    model, size = _ensure_faster_whisper(model_override)
    job["model"] = size
    segments_gen, info = model.transcribe(
        file_path,
        language=language,
        beam_size=5,
        best_of=5,
        # Single float (not the default fallback list) — fallback sampling at
        # higher temps is a known paraphrase / hallucination source.
        temperature=0.0,
        word_timestamps=True,
        # VAD on, but tuned to be less aggressive than defaults — the stock
        # Silero settings clip soft starts/ends and drop short utterances.
        vad_filter=True,
        vad_parameters=dict(
            threshold=0.3,
            min_speech_duration_ms=100,
            min_silence_duration_ms=500,
            speech_pad_ms=800,
        ),
        # Don't carry decoded text forward as context — it causes the model
        # to drift and truncate on long inputs.
        condition_on_previous_text=False,
        no_speech_threshold=0.3,
        # faster-whisper's built-in fix for the "Whisper invents text over a
        # short silence" failure mode. Requires word_timestamps=True.
        hallucination_silence_threshold=2.0,
    )
    job["duration"] = info.duration if info.duration else 0.0
    all_words = []
    for segment in segments_gen:
        if segment.words:
            for w in segment.words:
                text = w.word.strip()
                if text:
                    all_words.append({
                        "word": text,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        # Per-word confidence in [0,1]. The editor surfaces
                        # low-probability words as a faint underline so the
                        # human reviewer knows which ones to double-check.
                        "probability": round(float(getattr(w, "probability", 1.0) or 0.0), 3),
                    })
        job["segments_done"] += 1
        job["last_segment_end"] = segment.end
        if job["duration"] > 0:
            job["progress"] = min(1.0, segment.end / job["duration"])
    job["words"] = all_words


# ---------------------------------------------------------------------------
# Backend: mlx-whisper (macOS, Apple Silicon)
# ---------------------------------------------------------------------------

def _mlx_model_repo(model_override: str | None = None) -> str:
    """Default to large-v3-turbo: ~10x realtime on M2 Pro, near-large accuracy."""
    return (
        model_override
        or os.environ.get("SUBTITLE_WHISPER_MODEL")
        or DEFAULT_MLX_MODEL
    )


def _ensure_ffmpeg_on_path() -> None:
    """mlx-whisper (via openai-whisper's audio loader) shells out to `ffmpeg`
    for any non-WAV input. If the system doesn't have ffmpeg on PATH, fall
    back to the imageio-ffmpeg bundled binary by symlinking it as `ffmpeg`
    in a cache directory and adding that to PATH."""
    if shutil.which("ffmpeg"):
        return
    try:
        import imageio_ffmpeg
    except ImportError:
        return  # nothing we can do; mlx-whisper will raise a clear error

    ffmpeg_bin = imageio_ffmpeg.get_ffmpeg_exe()
    cache_bin = os.path.expanduser("~/.cache/subtitle-editor/bin")
    os.makedirs(cache_bin, exist_ok=True)
    link = os.path.join(cache_bin, "ffmpeg")
    try:
        if os.path.islink(link) or os.path.exists(link):
            os.remove(link)
        os.symlink(ffmpeg_bin, link)
    except OSError:
        # Fallback to copying if symlinks aren't allowed
        shutil.copy2(ffmpeg_bin, link)
        os.chmod(link, 0o755)
    os.environ["PATH"] = cache_bin + os.pathsep + os.environ.get("PATH", "")


def _transcribe_with_mlx(job: dict, file_path: str, language: str, model_override: str | None):
    _ensure_ffmpeg_on_path()
    import mlx_whisper

    repo = _mlx_model_repo(model_override)
    job["model"] = repo
    result = mlx_whisper.transcribe(
        file_path,
        path_or_hf_repo=repo,
        language=language,
        word_timestamps=True,
        verbose=False,
        # Disable text-conditioning to prevent the model from drifting and
        # truncating long passages.
        condition_on_previous_text=False,
        no_speech_threshold=0.3,
        temperature=0.0,
    )

    segments = result.get("segments", []) or []
    if segments:
        job["duration"] = float(segments[-1].get("end", 0) or 0)

    all_words = []
    for seg in segments:
        for w in (seg.get("words") or []):
            text = (w.get("word") or "").strip()
            if text:
                all_words.append({
                    "word": text,
                    "start": round(float(w.get("start", 0) or 0), 3),
                    "end": round(float(w.get("end", 0) or 0), 3),
                    "probability": round(float(w.get("probability", 1.0) or 0.0), 3),
                })
        job["segments_done"] += 1
        # mlx-whisper returns all segments at once, so we can't show smooth
        # progress mid-job. Update at the end of the segment loop.
        if job["duration"] > 0:
            seg_end = float(seg.get("end", 0) or 0)
            job["progress"] = min(0.99, seg_end / job["duration"])
        job["last_segment_end"] = float(seg.get("end", 0) or 0)
    job["words"] = all_words
