# Subtitle Editor

A local web app for transcribing video and editing subtitle break positions
before pulling them into DaVinci Resolve. Runs on Windows and macOS.

## What it does

1. **Transcribe** a video or audio file using faster-whisper (word-level
   timestamps), or Deepgram Nova-3 when you also need to know *who* is
   speaking.
2. **Edit** the captions in a script-flow editor: type to fix words, drag
   the blue markers to retime the breaks, press Enter to insert a new
   break at the cursor.
3. **Read it as a document** — the Transcript view regroups the same words
   into speaker paragraphs with editable names, and exports a `.txt` you
   can hand to someone else.
4. **Round-trip** with DaVinci Resolve: pull captions from your active
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

## Refreshing the page and code changes

- **Refresh is safe.** Every edit auto-saves the SRT next to the media, and
  the tab remembers which SRT it had open. After a refresh it reopens that
  SRT (a toast says "Reopened ...") and keeps saving to the same file. The
  caption text and timing come back; Whisper's per-word confidence marks
  don't, since the SRT doesn't hold them. A new launch still opens on the
  landing page, and if the SRT has gone the landing page shows as usual.
- **Open an SRT by link:** `http://127.0.0.1:5000/?open=<url-encoded path
  to an .srt>` opens that file the same way, with auto-save back to it.
- **The server reloads itself** when one of its `.py` files changes, so a
  code edit needs no restart. It waits until no transcription or AI review
  is running first, and the open tab reconnects on its own. Changes to
  `static/` files only need a page refresh. Set `SUBTITLE_NO_RELOAD=1` to
  turn the reloader off.

## Transcript documents and speaker names

The **Transcript** tab in the top bar shows the same transcript as a
readable document rather than as captions: one paragraph per speaker turn,
each headed by a timestamp and a speaker name.

- **Click a speaker name to rename it.** The new name replaces that
  speaker everywhere in the document and is remembered per file.
- **Hover a paragraph and click ▾** to reassign it to a different speaker,
  or to add a new one. Diarization gets some turns wrong, so fixing one is
  meant to be a single click.
- **Download .txt** writes the document out with `[HH:MM:SS] Name:` headings.
  Turn the **Timestamps** checkbox off to omit them.

Text edits made in either view flow into the other — both read from the
same word list. Heavier edits in the Transcript view can shift the caption
break positions, so re-run **Auto-format** in the Captions view afterwards
if you're also delivering an SRT.

Whisper has no concept of speakers, so a Whisper transcript opens as a
single speaker you can rename and split up by hand. For automatic speaker
labels, use Deepgram.

## Speaker identification (Deepgram)

Whisper is the more verbatim transcriber for clean single-speaker voiceover,
but it cannot tell speakers apart. Ticking **Identify speakers** on the
landing screen runs Deepgram Nova-3 instead, which returns a speaker label
attached to every word — and is stronger than Whisper on the multi-speaker
interview audio that actually needs diarizing.

This is the one part of the app that is **not local**: the audio is uploaded
to Deepgram. The app strips the file down to 16 kHz mono FLAC first, so it
sends the audio rather than your video master. Batch transcription runs
about US$0.26/hour with diarization included.

To enable it, set an API key in your environment before launching:

```
setx DEEPGRAM_API_KEY "your-key-here"        # Windows, one time
export DEEPGRAM_API_KEY="your-key-here"      # macOS / Linux
```

Without a key the option is greyed out and everything else works as before.

## AI review: fixing misheard words

**Review** in the top bar has Claude fix words the transcriber misheard
("esquad" → "SVOD") using the context of the whole transcript and an optional
one-line note about what the video is about (remembered per file).

- It runs the **Claude Code** command already installed on this computer, in
  the background, signed in with your normal Claude login. No API key; it
  comes out of your Claude plan's usage. It runs in an empty temp folder with
  no tools, MCP servers or hooks, so it only reads the text it's given. If
  `claude` isn't installed the button is greyed out and says why.
- Fixes go **straight into the captions**, each underlined green. Hover for
  the reason; click for what it was and **Revert**. The toast after a review
  has **Undo all**.
- Claude answers with word swaps, never rewritten text, and the server checks
  every swap (right words at the right positions, inside one caption, not much
  longer than the original, never the `[.]` anchor) before it's applied.
- **Caption timing doesn't move** and no caption is added or removed, so the
  new SRT still lines up with the version already in Resolve.
- Afterwards a fixed check enforces the house style over the whole
  transcript: **no em dashes** (a comma instead), **no stray hyphens**
  ("pro -Disney+" → "pro Disney+"; on-demand stays) and **Australian spelling**
  (color → colour, organize → organise, center → centre). It only changes a
  word when the Australian dictionary accepts the result; unclear ones
  (licence or license, metre or meter) and captions now over the line limit
  are flagged with a violet dotted underline instead.
- `SUBTITLE_REVIEW_MODEL=opus` uses Opus instead of the default Sonnet.

Still check the green words: with an unfamiliar topic Claude will sometimes
"fix" an unusual but correct word into a plausible wrong one.

For an operator in chat (or a voice call), the same review is available over
HTTP on the app's port (5000, or `PORT`):

| | |
|---|---|
| `POST /api/review {note?}` | start a review of the open transcript → `{jobId}` |
| `GET /api/review/status?jobId=` | progress, then `summary`, `changes` (`was`, `now`, `reason`), `rejected`, `skipped` |
| `GET /api/review/transcript` | the open transcript numbered exactly as Claude sees it |
| `POST /api/review/apply {edits, summary?}` | apply swaps you worked out yourself, with the same checks and highlights |

Tests: `py -m unittest discover tests` and `node tests/test_review_style.js`.

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

## Talking to it: the live link and "hey Subtitle"

The editor tab and the local server share a **live link**, so a voice call
(the Subtitle voice agent in Claude HQ) or a review job can read and fix the
transcript you have open without fighting the tab's auto-save:

- The tab publishes the open document to `/api/live/doc` on every change and
  polls the server for queued edits about once a second.
- Edits (`POST /api/live/edits`) are applied **in the tab**, through the same
  path as your typing: timing and speakers are kept, the fix flashes green,
  and **Ctrl+Z** undoes it. The file auto-saves as usual.
- Each edit carries the line text the caller read. If you've changed that
  line since, the edit is rejected, so your typing always wins.
- Review suggestions posted to `/api/live/flags` show as violet dotted
  underlines; hover for the suggestion.
- `/api/live/strip` is a one-line summary Claude HQ shows during a call.

Everything is in memory and localhost-only. With no editor tab open, every
`/api/live/*` read answers `{"open": false}`. The routes are documented for
the call in `.claude/voice-agent.md`; the server side is `live_link.py`.
