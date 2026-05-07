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

- **Windows / Linux with NVIDIA GPU**: uses CUDA, large-v3 model. Fast.
- **macOS**: faster-whisper has no Metal/MPS backend, so it runs on
  CPU. The app picks the medium model on Mac to keep things tolerable
  (~2-5× realtime on Apple Silicon). For shorter videos this is fine;
  for hour-long ones, expect a coffee break.

You can override defaults via env vars before launching:

- `SUBTITLE_WHISPER_MODEL` (e.g. `tiny`, `small`, `medium`, `large-v3`)
- `SUBTITLE_WHISPER_DEVICE` (`cpu`, `cuda`, `auto`)
- `SUBTITLE_WHISPER_COMPUTE_TYPE` (`int8`, `float16`, `float32`)
