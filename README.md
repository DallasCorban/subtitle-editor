# Subtitle Editor

A local web app for transcribing video and editing subtitle break positions
before pulling them into DaVinci Resolve. Runs on Windows and macOS.

## What it does

1. **Transcribe** a video or audio file using faster-whisper (word-level
   timestamps).
2. **Edit** the captions in a script-flow editor: type to fix words, drag
   the blue markers to retime the breaks, press Enter to insert a new
   break at the cursor.
3. **Round-trip** with DaVinci Resolve: pull captions from your active
   timeline, edit them, save a versioned SRT, drag it back onto the
   timeline.

## Install

You need Python 3.11+ on your machine. Get it from
<https://www.python.org/downloads/>.

### macOS

1. Download or clone this repo.
2. Double-click **`setup.command`** (one time only). If macOS warns
   about an unidentified developer, right-click → Open instead.
3. Double-click **`run.command`** to start the app. Your browser opens
   to <http://127.0.0.1:5000>.

### Windows

1. Download or clone this repo.
2. Double-click **`setup.bat`** (one time only).
3. Double-click **`run.bat`** to start the app.

## DaVinci Resolve integration

Optional. The app talks to a locally-running Resolve via Blackmagic's
scripting API. To use the "Read from Resolve" feature:

1. Have Resolve running with a project open and a timeline that has a
   subtitle track.
2. In Resolve: **Preferences → General → External scripting using →
   Local**.
3. The status pill in the app's top bar should turn green within a few
   seconds.

The bridge is **read-only**. Resolve's scripting API doesn't currently
allow writing back to existing subtitle items, so updates flow back via
"Save new version" → drag the resulting SRT onto the timeline.

## Notes on transcription speed

The app picks a different transcription backend per platform so each
machine uses the GPU it actually has:

- **Windows / Linux with NVIDIA GPU**: `faster-whisper` on CUDA at
  `large-v3` / float16. Fast.
- **Apple Silicon Mac**: `mlx-whisper` with the
  `mlx-community/whisper-large-v3-turbo` model on Metal. Roughly
  10× realtime on an M2 Pro — same accuracy as `large-v3`, much
  faster.
- **Intel Mac**: not currently supported by mlx-whisper.

The first transcription on a new machine downloads the model
(~1.5 GB), which takes a minute or two. After that, models are
cached and load instantly.

You can override defaults via env vars before launching:

- `SUBTITLE_WHISPER_MODEL`
  - On Windows/Linux: a faster-whisper size — `tiny`, `small`,
    `medium`, `large-v3`.
  - On Mac: a HuggingFace repo name —
    `mlx-community/whisper-large-v3-turbo`,
    `mlx-community/whisper-medium`, etc.
- `SUBTITLE_WHISPER_DEVICE` (faster-whisper only): `cpu`, `cuda`,
  `auto`.
- `SUBTITLE_WHISPER_COMPUTE_TYPE` (faster-whisper only): `int8`,
  `float16`, `float32`.

`ffmpeg` is needed by mlx-whisper to decode non-WAV inputs (mp4,
mov, etc.). The setup script installs `imageio-ffmpeg`, which
bundles a static ffmpeg — you don't need to install it via Homebrew.
