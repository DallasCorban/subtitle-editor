# Plan: AI review of transcripts (2026-10-29)

Status: superseded by `PLAN-2026-10-29-local-claude-review.md` (revision 2, no API key), which is what was built.

Decisions so far:
- 2026-10-29: Ben confirmed fixes apply straight away, highlighted in the interface, with undo (section 4 as written).
- Still open: Anthropic API key on Ben's machine and sending transcript text to Claude; approval to build.
Source idea: `docs/ideas/subtitle-ai-review.md`.

## Goal (one line)

One click (or one ask in chat) sends a finished transcript to Claude, which fixes words the transcriber misheard ("esquad" to "SVOD") using context and Ben's optional note about the video, without touching caption timing, so the SRT that goes into Resolve is right.

## What "done" looks like

1. A **Review** button in the editor runs an AI pass over the current transcript and corrects misheard words.
2. The same review can be triggered by asking the Subtitle operator in chat.
3. An optional one-line **"What's this video about?"** note feeds the reviewer. No glossary.
4. Every pass obeys two style rules: **no em dashes** and **Australian English spelling**. Both are in the prompt *and* enforced by a deterministic check afterwards, because a prompt alone can't be relied on.

## How the app works today (what the plan builds on)

- The working transcript lives **only in the browser**: `allWords[]` (each word has `word`, `start`, `end`, `probability`, `speaker`) plus `breakPositions[]` (word indices where a new caption starts). See `static/app.js:30-32`.
- Captions are derived from that model by `flatModelToCues()` (`static/app.js:215`). Timing comes from the words, not from the text.
- Text edits go through `reconcileWords()` (`static/app.js:783`), which keeps each word's timing when a word is replaced in place, and interpolates timing for inserted words.
- Every edit triggers `autoSaveSRT()` (`static/app.js:1775`), which POSTs cues to `/api/save-srt`; the server writes `<media name>.srt` next to the source file via `serialize_srt()` (`srt_parser.py:63`), adding a `[.]` anchor cue at 00:00:00 when the first caption starts late.
- The Flask server is otherwise stateless. External APIs are called with stdlib `urllib` and an env-var key (`deepgram_client.py`), no SDK dependencies.
- The client already loads en_AU and en_US Hunspell dictionaries for spell check (`static/app.js:107-145`).

## Approach

### 1. The reviewer returns a list of word edits, not rewritten text

The model is shown the transcript as numbered words, grouped by caption, e.g.

```
[c12] 118:the 119:rise 120:of 121:esquad* 122:services 123:like 124:Netflix
```

(`*` marks words the transcriber itself was unsure about, from `probability < 0.5`. Those are strong hints. Deepgram and SRT loads have no probability, so no marks; that's fine.)

It replies through a forced tool call / JSON schema with a list of edits:

```json
{ "summary": "Talk about streaming business models in Australia.",
  "edits": [ { "from_index": 121, "to_index": 121, "original": "esquad",
               "replacement": ["SVOD"], "reason": "subscription video on demand; fits streaming context" } ] }
```

Why edits rather than corrected text: timing lives on each word, and a rewritten paragraph would force us to re-align text to timestamps and risks the model "tidying" sentences Ben never asked it to touch. Edits are small, checkable, and each one can be shown and reverted on its own.

Prompt rules (system prompt):
- Only fix words that were **misheard** (wrong word, wrong spelling of a name/term, run-together or split words). Do not rephrase, do not fix the speaker's grammar, do not remove fillers, do not add words the speaker didn't say.
- Keep the replacement roughly as long as the original: never expand an acronym ("SVOD" stays "SVOD", not "subscription video on demand").
- Never edit inside caption 0 if it is `[.]`.
- Australian English spelling (colour, organise, centre, programme for TV only / program for software, etc.). Leave proper nouns and quoted names alone ("World Health Organization").
- No em dashes; use a comma or full stop.
- First infer the topic from the whole transcript plus Ben's note, then look for words that don't fit it. Prefer leaving a word alone over guessing.

The `original` field is echoed back so the server can reject any edit whose `original` doesn't match the word(s) at those indices (guards against off-by-one index errors).

### 2. Server: new `reviewer.py` + one endpoint

- `reviewer.py`, stdlib only, same shape as `deepgram_client.py`: `has_api_key()` (reads `ANTHROPIC_API_KEY`), `review(words, breaks, note) -> {summary, edits}`.
- Model: Claude Sonnet 5.5 by default (good at context, cheap enough to run on every video), overridable with `SUBTITLE_REVIEW_MODEL` so Ben can try Opus 5.5 on a hard one.
- Long transcripts: send the whole thing in one request up to a word cap (~12k words, about 75 minutes of talk). Above that, chunk by caption boundaries with a small overlap and pass the first chunk's `summary` into later chunks so the topic carries through. Output is only the edits, so output size is small either way.
- Validation in the server before anything reaches the browser: indices in range, `original` matches, spans don't overlap, replacement non-empty, replacement no more than ~2x the original's character length, no edits to a `[.]` word. Rejected edits are logged, not applied.
- `POST /api/review` takes `{words: [{word, probability}], breaks, note}` and returns `{summary, edits, rejected}`. Runs synchronously (one API call, tens of seconds); the button shows a spinner. If it proves slow on long files, switch to the same job + poll pattern transcription uses.
- `GET /api/engines` gains `review: true/false` so the UI can grey out the button with an explanation when there's no key, as it does for Deepgram.

### 3. Deterministic style check after the review (enforcement, not hope)

Runs in the browser after edits are applied, over **all** words (not just edited ones), because the transcriber itself can produce US spellings and dashes:

- **Em dashes:** any `—` (and a spaced ` – ` en dash used as punctuation) is removed; a standalone dash token is dropped and a comma added to the previous word if it doesn't already end in punctuation. Fully automatic.
- **Australian spelling:** a word that the en_US dictionary accepts but en_AU rejects is a US-only spelling. A small built-in map handles the common patterns automatically (`-ize/-ization` to `-ise/-isation`, `-or` to `-our` for a fixed list like color/favor/behavior/neighbor, `-er` to `-re` for center/theater/meter-as-unit, `-og` to `-ogue`, `-yze` to `-yse`, `defense/license(noun)/offense`). Anything the check finds but can't map is flagged (highlighted) rather than guessed. Capitalised words mid-sentence are treated as proper nouns and skipped.
- These style fixes are recorded in the same change list as the AI edits, labelled "style", so Ben can see and revert them.

Why in the browser: the dictionaries are already loaded there and the browser owns the word model. The check is also cheap enough to run on every review.

### 4. Browser: applying and showing the changes

- Edits are applied to `allWords[]` as in-place replacements, keeping each word's `start`/`end`/`speaker`. For an edit that changes the word count (e.g. "on demand" to "on-demand", "Net flicks" to "Netflix"), timing is spread across the original span, and every entry in `breakPositions[]` after the edit is shifted by the count difference. A break that fell *inside* a merged span is moved to the end of it. Edits are applied back to front so earlier indices stay valid.
- Changed words get a green underline; hovering shows "was: esquad (reason)"; clicking offers **Revert**. A toast says "Review made 7 changes" with **Undo all**. This means changes go straight into the subtitles as Ben asked, but every one is visible and reversible.
- Then `cues = flatModelToCues(); render(); autoSaveSRT(true);` as for any other edit.
- UI: a **Review** button next to Transcribe, and a small "What's this video about? (optional)" text box that appears in the review popover. The note is remembered per file in `localStorage` (same pattern as speaker names).
- Review is only offered once a transcript is loaded and transcription has finished.

### 5. Review by asking the operator in chat

The Subtitle operator is a Claude Code session in this repo. It can't see the browser's in-memory state, and if it edited the `.srt` on disk directly the browser's next auto-save would overwrite those edits. So chat review goes through the running app:

- The browser mirrors its current session to the server on each auto-save: `POST /api/session` with `{sourceFilePath, words, breaks, note}`, held in memory.
- The operator runs the review by calling `POST /api/review/session` (optionally with a `note` from the chat). The server runs the same `reviewer.review()` on the mirrored session and queues the result.
- The browser polls `GET /api/review/pending` (cheap, every couple of seconds, only while a file is open), applies the queued edits through the exact same path as the button, so the change list, highlights and undo are identical.
- The endpoint returns the summary and the list of changes, so the operator can tell Ben in chat what it changed and why, and Ben can say "put esquad back" (operator calls a revert endpoint, or Ben clicks Revert).
- A short section in `README.md` (and a line in the operator's own notes) documents these endpoints and how to find the port (5000, or `PORT`; the dev-server collision means tests use 5001).

**What chat review needs from the voice-operator work (Jimmy's side), nothing more:** a way for the Subtitle operator to make local HTTP calls to the app while Ben is chatting, knowledge of which port the app is on, and the ability to read a short structured result (summary + list of `original -> replacement, reason`) back to Ben. If the voice setup routes Ben's speech to the same Claude Code session in this repo, that already works. If it runs elsewhere, it needs network access to `127.0.0.1:<port>` on Ben's machine.

## Files to touch

| File | Change |
|---|---|
| `reviewer.py` (new) | Anthropic API call (stdlib `urllib`), prompt, chunking, edit validation |
| `app.py` | `/api/review`, `/api/session`, `/api/review/session`, `/api/review/pending`, `review` flag in `/api/engines` |
| `static/app.js` | Review button + note, apply-edits with break remapping, change list / highlight / revert / undo all, style check (em dash + AU spelling map), session mirror, pending-review poll |
| `templates/index.html` | Review button, note field, change-list popover |
| `static/style.css` | "AI-changed" underline, flagged-spelling style, popover |
| `README.md` | `ANTHROPIC_API_KEY` setup (`setx`, as for Deepgram), how review works, operator endpoints |
| `tests/test_reviewer.py` (new) | Validation and break-remapping logic against fixtures (API mocked) |
| `tests/fixtures/` (new) | Small SVOD transcript fixture and a captured SRT for the byte-compare check |

No change to `srt_parser.py`, `resolve_bridge.py`, `transcriber.py` or `deepgram_client.py`. No new pip dependencies.

Note: the working tree currently has uncommitted changes in most of these files (Deepgram work, transcript view). Those should be committed first so the review feature lands as its own diff.

## Resolve caption output: what the review must not break

- **SRT shape stays exactly as is:** sequential index, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line, UTF-8, file written next to the media as `<name>.srt`. The review never touches serialisation.
- **Timings must not move.** A one-for-one word fix must leave every timestamp identical. Only word-count-changing edits respread time, and only inside the edited span.
- **Caption count and break positions must not change** for one-for-one fixes; for count-changing fixes, breaks shift but no caption is created, merged or lost. If the caption count changes, the SRT Ben already snapped in Resolve no longer lines up when he drags the new version on.
- **The `[.]` anchor cue** at 00:00:00 is what makes the track snap to the start of the timeline. It is added at save time, but if Ben re-loads a saved SRT it comes back in as a real caption. The reviewer must never "correct" it, and the em dash / spelling check must skip it.
- **Line length.** Captions are sized for the chosen aspect ratio (`maxChars`). A longer replacement can push a caption over. The length cap on replacements limits this; any caption that ends up over `maxChars` after review is flagged in the change list rather than silently re-broken (re-breaking would change timing).
- **Characters.** No smart quotes, ellipsis characters or other typography the transcriber didn't produce. Straight apostrophes stay straight. Only the em dash rule removes characters.
- **Auto-save overwrites `<name>.srt`.** A review is a normal edit, so it will overwrite the auto-saved file. "Undo all" covers mistakes; the versioned "Save new version" files are untouched.

## Risks and unknowns

1. **Biggest risk: confident wrong "corrections."** The whole point is to change words the model thinks don't fit, and with an unfamiliar topic it will sometimes "fix" a correct but unusual word, name or bit of jargon into something plausible and wrong, which is worse than the original because it reads fine and gets through to the final cut. Mitigations: conservative prompt ("prefer leaving it alone"), low-confidence hints, Ben's note, the `original` echo check, length cap, and above all every change visibly highlighted with its reason and one-click revert. Ben still has to glance at the highlighted words. We should measure the false-fix rate on two or three real videos before calling it done.
2. **Australian spelling can't be fully automated.** The dictionary comparison catches US-only words, but some words are legitimately different by meaning (program/programme, license/licence as verb vs noun, meter/metre) and proper nouns keep their own spelling. Plan: auto-fix the unambiguous patterns, flag the rest. Ben should expect a few flags rather than perfect silence.
3. **Word-count-changing edits** are the only path that can disturb timing and breaks. They need careful tests. If they prove fiddly, a fallback is to allow only one-for-one replacements in the first version (covers "esquad" to "SVOD") and add merges/splits later.
4. **Chat review and stale state.** If Ben has the app open in two tabs, or edits while a chat-triggered review is running, the queued edits may no longer line up. The `original` check catches most of this (mismatched edits are skipped and reported); the browser also discards a pending review older than its last edit.
5. **API key and cost.** Needs `ANTHROPIC_API_KEY` set on Ben's machine. A 30-minute video is roughly 5k words; one Sonnet pass is a few cents. Transcript text leaves the machine (same as the Deepgram path already does for audio).
6. **Unknown: what voice-operator setup Jimmy lands on**, and whether it can reach localhost on Ben's machine. Chat review is designed so the button works regardless.

## How we'll verify it works

1. **The SVOD case, end to end:** a short fixture (a few captions about streaming services with "esquad" in place of "SVOD", plus "colour" written as "color" and an em dash). Run review with note "media subscriptions". Expect: "esquad" to "SVOD", "color" to "colour", em dash gone, and nothing else changed.
2. **Timing and format are untouched:** save the SRT before and after a one-for-one review and diff them. Every index and timestamp line must be byte-identical; only text lines differ, and only on the changed captions. Same check on an SRT that includes the `[.]` anchor.
3. **Unit tests (pytest, API mocked):** edit validation rejects out-of-range indices, `original` mismatches, overlapping spans, over-long replacements and `[.]` edits; break remapping for merges and splits keeps caption count and puts breaks in the right place.
4. **Style check tests:** a word list of US spellings maps to AU; proper nouns and ambiguous words are flagged, not changed; every dash form is removed.
5. **Real videos:** run on the original SVOD video and on one TF50 podcast episode (names-heavy, Deepgram path). Count correct fixes, wrong fixes and misses. Target: no wrong fixes that Ben wouldn't spot from the highlights; report the numbers to Ben.
6. **Chat path:** with the app open on port 5001, call `/api/review/session` from the shell; confirm the browser picks up the review, shows the same highlights, and that the operator's response lists the changes.
7. **Undo:** "Undo all" restores the exact pre-review words, breaks and SRT on disk.
8. **Resolve:** drag the reviewed SRT onto a timeline in Resolve 20 and confirm it snaps to the start and lines up with the previous version.
