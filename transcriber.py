"""
Whisper transcription service.

Backend is chosen at runtime based on platform, or by explicit request:
- Apple Silicon Mac → mlx-whisper (Metal-accelerated, ~10x realtime).
- Windows / Linux   → faster-whisper (CUDA on NVIDIA, CPU fallback).
- engine="deepgram" → Deepgram Nova-3 in the cloud, which unlike Whisper
  labels who is speaking. Opt-in per job, for transcripts that need speakers.

All backends emit the same shape: a list of {"word", "start", "end"} dicts,
so the rest of the app doesn't care which ran. Deepgram additionally sets
"speaker" on each word; the Whisper backends leave it None.

sharpen_timing=True runs both: Whisper for the words, Deepgram (in a second
thread, at the same time) for the timing, merged by timing_merge.py. If the
Deepgram half fails the job still completes with Whisper's own timing.

Runs in a background thread so the Flask server stays responsive. Only one
transcription runs at a time (the model uses ~3 GB VRAM/RAM).
"""

import os
import shutil
import sys
import threading
import time
import uuid
from typing import Optional

_models: dict = {}  # model_name -> WhisperModel (faster-whisper only; mlx caches via repo path)
_model_lock = threading.Lock()
_jobs: dict = {}  # job_id -> job state dict
_latest_job_id: Optional[str] = None  # the job /api/transcribe/latest reports

# Default chosen for verbatim accuracy on clean English voiceover:
# large-v2 paraphrases noticeably less than large-v3 on this kind of content.
# Override via SUBTITLE_WHISPER_MODEL env var or per-request `model` argument.
DEFAULT_FW_MODEL = "large-v2"
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo"


# ---------------------------------------------------------------------------
# Public API — same shape on both backends
# ---------------------------------------------------------------------------

def start_transcription(
    file_path: str,
    language: str = "en",
    model: str | None = None,
    engine: str = "whisper",
    sharpen_timing: bool = False,
    keep_speakers: bool = False,
) -> str:
    """Start a background transcription job. Returns the job ID.

    sharpen_timing (Whisper engine only) adds the Deepgram timing pass;
    keep_speakers then also keeps Deepgram's speaker labels.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    if _any_running():
        raise RuntimeError(
            "A transcription is already in progress. Wait for it to finish."
        )

    global _latest_job_id
    job_id = str(uuid.uuid4())
    _latest_job_id = job_id
    _jobs[job_id] = {
        "status": "running",
        "progress": 0.0,
        "duration": 0.0,
        "segments_done": 0,
        "last_segment_end": 0.0,
        "words": [],
        "error": None,
        "file": os.path.basename(file_path),
        "file_path": file_path,
        "started_at": time.time(),
        "finished_at": None,
        "model": model or os.environ.get("SUBTITLE_WHISPER_MODEL", ""),
        "engine": engine,
        # Deepgram's batch API is one request, so the UI reports which phase
        # it's in (extracting / uploading / processing) rather than a
        # segment count that would sit at zero the whole time.
        "stage": "",
        "speakers": 0,
    }
    sharpen_timing = sharpen_timing and engine != "deepgram"
    if sharpen_timing:
        # The Deepgram half reports into its own dict so its progress
        # doesn't fight Whisper's over job["progress"].
        _jobs[job_id]["deepgram"] = {"stage": "starting", "progress": 0.0}
        _jobs[job_id]["timing_stats"] = None
        _jobs[job_id]["timing_summary"] = ""
        _jobs[job_id]["timing_warning"] = ""

    t = threading.Thread(
        target=_run_transcription,
        args=(job_id, file_path, language, model, engine,
              sharpen_timing, keep_speakers),
        daemon=True,
    )
    t.start()
    return job_id


def get_job_status(job_id: str) -> Optional[dict]:
    return _jobs.get(job_id)


def latest_job_summary() -> Optional[dict]:
    """The most recent job without its word list, for a quick status check."""
    job = _jobs.get(_latest_job_id) if _latest_job_id else None
    if job is None:
        return None
    out = {k: v for k, v in job.items() if k != "words"}
    out["jobId"] = _latest_job_id
    out["word_count"] = len(job.get("words") or [])
    return out


def get_model_status() -> dict:
    return {"loaded": bool(_models), "models": list(_models.keys())}


# ---------------------------------------------------------------------------
# Job worker
# ---------------------------------------------------------------------------

def _any_running() -> bool:
    return any(j["status"] == "running" for j in _jobs.values())


def is_busy() -> bool:
    """A transcription is in progress (the auto-reloader waits for it)."""
    return _any_running()


def _run_transcription(
    job_id: str, file_path: str, language: str, model: str | None,
    engine: str = "whisper", sharpen_timing: bool = False,
    keep_speakers: bool = False,
):
    """Worker function — runs in a background thread."""
    job = _jobs[job_id]
    try:
        if engine == "deepgram":
            _transcribe_with_deepgram(job, file_path, language)
        elif sharpen_timing:
            _transcribe_sharpened(job, file_path, language, model, keep_speakers)
        else:
            _transcribe_with_whisper(job, file_path, language, model)
        job["progress"] = 1.0
        job["status"] = "complete"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
    finally:
        job["finished_at"] = time.time()


def _transcribe_with_whisper(job: dict, file_path: str, language: str, model: str | None):
    if sys.platform == "darwin":
        _transcribe_with_mlx(job, file_path, language, model)
    else:
        _transcribe_with_faster_whisper(job, file_path, language, model)


# ---------------------------------------------------------------------------
# Whisper wording + Deepgram timing
# ---------------------------------------------------------------------------

def _transcribe_sharpened(
    job: dict, file_path: str, language: str, model: str | None, keep_speakers: bool
):
    """Whisper's words with Deepgram's word timing (see timing_merge.py).

    Deepgram runs in its own thread while Whisper works; it is usually done
    first. Any Deepgram failure leaves Whisper's result in place with a
    warning for the UI, rather than failing the job.
    """
    import deepgram_client
    import timing_merge

    dg = job["deepgram"]
    result: dict = {}

    def run_deepgram():
        try:
            result["words"] = deepgram_client.transcribe(
                dg, file_path, language, diarize=keep_speakers
            )
            dg["stage"] = "done"
        except Exception as e:
            result["error"] = str(e)
            dg["stage"] = "failed"

    t = threading.Thread(target=run_deepgram, daemon=True)
    t.start()

    _transcribe_with_whisper(job, file_path, language, model)

    if t.is_alive():
        job["stage"] = "waiting-deepgram"
        t.join(deepgram_client.TIMEOUT_S + 60)
    if t.is_alive():
        result["error"] = "Deepgram took too long"

    whisper_words = job["words"]
    dg_words = result.get("words") or []
    if result.get("error") or not dg_words:
        why = result.get("error") or "Deepgram returned no words"
        job["timing_warning"] = (
            f"Deepgram timing failed: {why.rstrip('.')}. Kept Whisper's own timing."
        )
        print(f"[transcriber] timing pass failed: {why}", flush=True)
    else:
        job["stage"] = "merging"
        merged, stats = timing_merge.merge(whisper_words, dg_words, keep_speakers)
        job["timing_stats"] = stats
        job["timing_summary"] = timing_merge.summary(stats)
        if stats["applied"]:
            job["words"] = merged
            job["model"] = f"{job.get('model') or 'whisper'} + {deepgram_client.MODEL} timing"
        else:
            job["timing_warning"] = job["timing_summary"] + " Kept Whisper's own timing."
        print(f"[transcriber] timing pass: {stats}", flush=True)

    if keep_speakers:
        job["speakers"] = len({
            w["speaker"] for w in job["words"] if w.get("speaker") is not None
        })
    job["stage"] = ""


# ---------------------------------------------------------------------------
# Backend: Deepgram Nova-3 (cloud, speaker-labelled)
# ---------------------------------------------------------------------------

def _transcribe_with_deepgram(job: dict, file_path: str, language: str):
    import deepgram_client

    job["model"] = deepgram_client.MODEL
    words = deepgram_client.transcribe(job, file_path, language)
    job["words"] = words
    job["speakers"] = len({
        w["speaker"] for w in words if w.get("speaker") is not None
    })
    job["stage"] = ""


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
                        # Whisper can't tell speakers apart — only Deepgram
                        # fills this in.
                        "speaker": None,
                    })
        job["segments_done"] += 1
        job["last_segment_end"] = segment.end
        if job["duration"] > 0:
            job["progress"] = min(1.0, segment.end / job["duration"])
    job["words"] = all_words


# ---------------------------------------------------------------------------
# Backend: mlx-whisper (macOS, Apple Silicon)
# ---------------------------------------------------------------------------

# The UI's model dropdown uses faster-whisper size names (shared with the
# Windows backend). On Mac those must resolve to mlx-community HF repos —
# passing a bare size like "large-v2" to mlx-whisper 404s on the Hub.
_MLX_REPO_FOR_SIZE = {
    "tiny": "mlx-community/whisper-tiny",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v2": "mlx-community/whisper-large-v2-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}


def _mlx_model_repo(model_override: str | None = None) -> str:
    """Default to large-v3-turbo: ~10x realtime on M2 Pro, near-large accuracy."""
    name = (
        model_override
        or os.environ.get("SUBTITLE_WHISPER_MODEL")
        or DEFAULT_MLX_MODEL
    )
    if "/" not in name:
        # Bare size name → mlx repo; unknown sizes fall back to the default.
        name = _MLX_REPO_FOR_SIZE.get(name, DEFAULT_MLX_MODEL)
    return name


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
                    "speaker": None,
                })
        job["segments_done"] += 1
        # mlx-whisper returns all segments at once, so we can't show smooth
        # progress mid-job. Update at the end of the segment loop.
        if job["duration"] > 0:
            seg_end = float(seg.get("end", 0) or 0)
            job["progress"] = min(0.99, seg_end / job["duration"])
        job["last_segment_end"] = float(seg.get("end", 0) or 0)
    job["words"] = all_words
