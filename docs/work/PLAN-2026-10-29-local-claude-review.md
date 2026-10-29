# Plan: AI transcript review through Claude on Ben's computer (2026-10-29, revision 2)

Status: approved by Ben 2026-10-29 and built. Built on top of the live link (`live_link.py`, Jimmy's voice-agent work) rather than a separate `/api/session` mirror and pending-review poll: the review job reads the open document from the live link and sends its swaps to the tab as whole-line edits, so the button and chat paths are one path.
Supersedes `PLAN-2026-10-29-ai-transcript-review.md`. Everything there still stands except how the app talks to Claude. That plan needed an Anthropic API key; this one doesn't.

Decisions so far:
- Fixes apply straight away, highlighted in the interface, with undo (Ben, 2026-10-29).
- No Anthropic API key. The review runs through Claude on Ben's own computer, alongside the Sarah app and the operator session (Ben, 2026-10-29).
- Still open: approval to build.

## Goal (one line)

One click in the app (or one ask in chat) has Claude on Ben's own computer fix the words the transcriber misheard ("esquad" to "SVOD"), using context and Ben's optional note. The fixes go straight into the captions, highlighted with undo. Caption timing doesn't move, and no API key is needed.

## What changed from revision 1

| | Revision 1 | Revision 2 (this plan) |
|---|---|---|
| How the app reaches Claude | HTTPS to the Anthropic API with `ANTHROPIC_API_KEY` | Runs the `claude` command already installed on Ben's PC (Claude Code 2.1.304 at `C:\Users\ben\.local\bin\claude.exe`), in non-interactive mode, signed in with Ben's existing Claude login |
| Billing | Pay per call on an API account | Comes out of Ben's existing Claude plan usage, shared with Sarah and the operators |
| Chat review | Operator calls an app endpoint that calls the API | Operator calls the same app endpoint, which runs the same local `claude` command. The operator can also do the review itself in the chat, using the same apply step. |
| Response time | Tens of seconds | Same plus a few seconds to start `claude`, so it runs as a background job with progress, like transcription |
| New setup for Ben | Set an API key | None, as long as `claude` stays installed and signed in |

Unchanged from revision 1: Claude returns a list of word swaps, not rewritten text. The server checks every swap before it's used. The browser applies the swaps without touching timing and highlights each change with a reason and undo. A fixed rule check afterwards removes em dashes and corrects US spellings to Australian. The protections for the Resolve caption output are the same.

## Approach

### 1. How the app runs Claude locally

New module `reviewer.py`, same style as `deepgram_client.py` (no new Python dependencies). It starts the CLI as a subprocess:

```
claude -p
  --output-format json
  --json-schema <edits schema>
  --system-prompt <review rules>
  --model sonnet
  --tools ""                  # no file, shell or web tools: it only reads the text it's given
  --strict-mcp-config         # don't load MCP servers, including voice-bridge
  --no-session-persistence    # don't save a session for each review
```

- The transcript and Ben's note go in on **stdin**. Windows limits command-line length, and an hour of talk is far over that limit.
- The working folder is a fresh temp folder, not this repo. That way the review doesn't pick up this project's notes, memory or operator instructions.
- **Not `--bare`.** That flag would be the cleanest isolation, but it only accepts an API key and never reads Ben's normal login, which is exactly what we're avoiding.
- `CLAUDECODE` and related variables are removed from the child's environment, so a review started from inside an operator session doesn't think it is nested in one. If `ANTHROPIC_API_KEY` happens to be set, it's removed too, so the review always uses Ben's plan and never bills an API account.
- The result is read from the JSON output's structured result, then checked as in section 3. A timeout (about 3 minutes for one chunk) kills a stuck run. Non-zero exits are turned into plain messages, such as "Claude isn't signed in: open a terminal and run `claude` once" or "You've hit your Claude usage limit; try again after it resets".
- `claude` is located with `shutil.which("claude")`, falling back to `~/.local/bin/claude(.exe)`. That covers the Mac launcher too. `/api/engines` reports `review: true/false` plus a reason, so the button can explain itself when it's greyed out.
- Model: Sonnet by default. It's good at context and easier on usage limits. `SUBTITLE_REVIEW_MODEL=opus` lets Ben use Opus for a hard video.

### 2. What Claude is asked to do (same as revision 1)

Claude sees the transcript as numbered words grouped by caption. Words the transcriber was unsure about are marked with `*`.

```
[c12] 118:the 119:rise 120:of 121:esquad* 122:services 123:like 124:Netflix
```

It must answer in this shape, enforced by `--json-schema`:

```json
{ "summary": "Talk about streaming business models in Australia.",
  "edits": [ { "from_index": 121, "to_index": 121, "original": "esquad",
               "replacement": ["SVOD"], "reason": "subscription video on demand; fits streaming context" } ] }
```

The prompt rules:
- Only fix words that were misheard. Don't rephrase, fix the speaker's grammar, remove filler words, or add anything the speaker didn't say.
- Keep each replacement about the same length as the original. Never spell out an acronym.
- Never touch the `[.]` anchor caption.
- Use Australian spelling, but leave proper nouns alone. Use no em dashes.
- First work out the topic from the whole transcript and Ben's note, then look for words that don't fit it. When unsure, leave the word alone.

Long transcripts: up to about 12,000 words (roughly 75 minutes of talk) go in one call. Anything longer is split at caption boundaries with a little overlap, and the first chunk's summary is passed on so later chunks keep the topic. The chunks run one after another to stay gentle on usage limits, and progress shows "Reviewing part 2 of 3".

### 3. Server: background job and checks

- `POST /api/review` with `{words: [{word, probability}], breaks, note}` returns `{jobId}`. `GET /api/review/status?jobId=` returns progress, then `{summary, edits, rejected}`. This copies the transcription job/poll pattern in `transcriber.py`. Only one review runs at a time.
- Every edit is checked before it reaches the browser:
  - its word numbers are in range;
  - its `original` matches the words actually at those positions;
  - it doesn't overlap another edit;
  - the replacement isn't empty;
  - the replacement is no more than about twice as long as the original;
  - it doesn't touch `[.]`.
- Failed edits are dropped and listed under `rejected`.

### 4. Browser: applying, highlighting, undo (same as revision 1)

- Edits are applied to `allWords[]` from the end of the transcript backwards. A one-for-one swap keeps the word's `start`, `end` and `speaker` exactly.
- An edit that changes the word count spreads the time across the original span and shifts the later caption breaks (`breakPositions[]`). Merges and splits never create or remove a caption.
- Each changed word gets a green underline. Hovering shows "was: esquad (reason)" and clicking gives Revert. A toast says "Review made 7 changes" with Undo all.
- Then the usual `flatModelToCues(); render(); autoSaveSRT(true);` runs.
- Rule check on all words after the AI edits:
  - Em dashes, and spaced en dashes used as punctuation, are removed. A comma is added where needed.
  - US-only spellings are found by comparing the en_US and en_AU dictionaries the app already loads. Clear-cut patterns (`-ize`, `-or`, `-er`, `-og`, `-yze`, defense/offense) are fixed automatically. Unclear ones (program, license, meter) are flagged, not changed.
  - Capitalised words in mid-sentence are skipped as names.
  - Rule fixes appear in the same change list, labelled "style".
- UI: a Review button next to Transcribe and an optional "What's this video about?" box. The note is remembered for each file.

### 5. Review by asking the operator in chat

The operator can't see the browser's in-memory transcript. If it edited the `.srt` on disk, the app's next auto-save would overwrite the fix. So chat goes through the running app:

- The browser sends its current state to the server on every auto-save (`POST /api/session`: words, breaks, note, file path).
- **Default path:** the operator calls `POST /api/review/session` with any note Ben gave in chat. The server runs the same local `claude` review on that copy. The browser checks `GET /api/review/pending` every couple of seconds and applies the result through the same code as the button, so the highlights and undo are identical. The endpoint also returns the summary and the list of changes, and the operator tells Ben what changed and why.
- **Alternative path:** the operator is already Claude, so it can do the review itself. It reads `GET /api/session`, decides the swaps, and posts them to `POST /api/review/apply`. That runs the same checks and reaches the browser the same way. This is useful when Ben wants to talk through a specific word ("is that meant to be SVOD or AVOD?"). Either way the app's checks and highlighting are the safety net.
- `README.md` documents these endpoints and how to find the port (5000, or `PORT`; tests use 5001 because of the dev-server port collision).

What chat review needs from Jimmy's voice-operator work, nothing more:
- The Subtitle operator can make local HTTP calls to the app while Ben is chatting.
- It knows the app's port.
- It can read a short list of changes back to Ben.

If voice runs through the same Claude Code session in this repo, all of that already works.

## Files to touch

| File | Change |
|---|---|
| `reviewer.py` (new) | Find and run the local `claude` CLI, prompt and schema, chunking, edit checks, error messages |
| `app.py` | `/api/review` + `/api/review/status` (background job), `/api/session` (GET/POST), `/api/review/session`, `/api/review/apply`, `/api/review/pending`, `review` flag in `/api/engines` |
| `static/app.js` | Review button and note, job polling, applying edits and remapping breaks, highlights/revert/undo all, style check, session mirror, pending-review poll |
| `templates/index.html` | Review button, note field, change-list popover |
| `static/style.css` | Changed-word underline, flagged-spelling style, popover |
| `README.md` | How review works, that it needs Claude Code installed and signed in (no key), operator endpoints |
| `tests/test_reviewer.py` (new) | Edit checks, break remapping, CLI command construction and error mapping (subprocess mocked) |
| `tests/fixtures/` (new) | SVOD sample transcript, a captured SRT for the byte-compare check, a sample `claude -p` JSON output |

No changes to `srt_parser.py`, `resolve_bridge.py`, `transcriber.py`, `deepgram_client.py` or `requirements.txt`.

Before building, the current uncommitted Deepgram and transcript-view work should be committed, so this feature lands as its own change.

## Resolve caption output: what the review must not break (unchanged)

- **SRT format:** sequential numbers, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line, UTF-8, saved as `<name>.srt` next to the media.
- **Timings:** a one-for-one swap leaves every timestamp byte-for-byte identical. Only word-count changes spread time, and only within the edited span.
- **Caption count:** never changes, so a new version still lines up when dragged onto the Resolve timeline.
- **The `[.]` anchor caption** at 00:00:00, which makes the track snap to the start of the timeline: never edited by the review or the rule check.
- **Line length (`maxChars`):** replacements are capped in length. A caption pushed over the limit is flagged, not re-broken, because re-breaking would move timing.
- **Characters:** no curly quotes or other typography the transcriber didn't produce. Only the em dash rule removes characters.
- **Auto-save:** a review overwrites the auto-saved `<name>.srt` like any edit. Undo all covers mistakes, and the versioned saves are untouched.

## Risks and unknowns

1. **Biggest risk: confident wrong corrections.** This is unchanged. With an unfamiliar topic Claude will sometimes "fix" a correct but unusual word or name into something plausible and wrong. That reads naturally and could get into the final cut. Mitigations:
   - a cautious prompt and the unsure-word hints;
   - Ben's note;
   - the `original` check and the length cap;
   - every change visibly highlighted with its reason and undo.

   We'll count wrong fixes on two or three real videos before calling it done.
2. **The local `claude` CLI behaving well as a background helper.** It's built for people, not as a library, and this is the main new unknown in this revision. The things to prove early:
   - It works when started by the Flask app, under `run.bat`, with no console.
   - It uses Ben's normal sign-in.
   - `--tools ""` and `--strict-mcp-config` keep it from loading voice-bridge. Otherwise each review could show up in Sarah's world as a phantom operator session.
   - User-level hooks don't fire for it. If they do, use `--restricted` or a `--settings` file that turns them off, provided that keeps the normal sign-in.
   - The `--json-schema` result shape is what we expect.

   A Claude Code update could change flags or output. The fixture of sample output and a clear error message make that obvious rather than silent.
3. **Shared usage limits.** Reviews come out of the same Claude plan Sarah and the operators use. An hour-long transcript is a sizeable request. If Ben is close to his limit, a review could fail, or it could eat into what the operators have left that day. Sonnet by default and one-after-another chunks keep this modest. The error message says plainly when a limit is hit.
4. **Word-count-changing edits** are the only path that can move timing or breaks. If they prove fiddly, version one allows only one-for-one swaps. That still covers "esquad" to "SVOD".
5. **Out-of-date chat reviews.** If Ben edits while a chat-triggered review is running, or has two tabs open, the queued swaps may no longer line up. The `original` check drops the mismatches and reports them, and the browser ignores a review older than its last edit.
6. **The Mac.** The plan finds `claude` on both platforms, but Ben's Mac needs Claude Code installed and signed in for the button to work there.

## How we'll verify it works

1. **Spike first, before any UI.** From a plain terminal, and then from the Flask app started by `run.bat`, run the exact `claude -p` command on a 20-line sample:
   - Check it returns the edits JSON using Ben's sign-in, with no API key set.
   - Check that nothing new appears in Sarah's status cards or session list.
   - Time it.

   If this fails, stop and come back to Ben before building anything else.
2. **The SVOD case, end to end:** a fixture with "esquad" for "SVOD", "color" and one em dash, plus the note "media subscriptions". Expected result: "esquad" becomes "SVOD", "color" becomes "colour", the em dash goes, and nothing else changes. All changes are highlighted.
3. **Timing and format untouched:** save the SRT before and after a one-for-one review and diff the two files. Every number and timestamp line must be identical. Repeat with an SRT that includes the `[.]` anchor.
4. **Unit tests (subprocess mocked):**
   - edit checks;
   - break remapping for merges and splits keeps the caption count;
   - the CLI command is built correctly: has `--tools ""`, `--strict-mcp-config`, no `--bare`, transcript on stdin;
   - error mapping for not signed in, usage limit, timeout and bad JSON.
5. **Style check tests:** US-to-AU spelling map, proper nouns and unclear words flagged rather than changed, every dash form removed.
6. **Real videos:** the original SVOD video and one TF50 podcast episode, which is full of names and uses the Deepgram path. Count correct fixes, wrong fixes and misses, and report the numbers to Ben.
7. **Chat path:** with the app on port 5001, call `/api/review/session` from the operator's shell and check the browser applies and highlights the same changes. Then post a hand-written swap to `/api/review/apply`, and an invalid one to check it's rejected.
8. **Undo:** Undo all restores the exact words, breaks and SRT on disk from before the review.
9. **Resolve:** drag the reviewed SRT onto a Resolve 20 timeline and confirm it snaps to the start and lines up with the previous version.
