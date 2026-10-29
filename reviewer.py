"""
AI review of a finished transcript: fix the words the transcriber misheard.

Runs the ``claude`` command already installed on this machine (Claude Code),
non-interactively, signed in with the user's normal Claude login. No API key
and no new Python dependencies.

Claude is shown the transcript as numbered words grouped by caption and
answers with a list of word swaps, never rewritten text, so caption timing
(which lives on each word in the browser) is never re-derived from prose.
Every swap is checked here before anything is applied:

* its word numbers are in range and inside a single caption;
* ``original`` matches the words actually at those positions;
* it doesn't overlap another swap;
* the replacement isn't empty and is at most about twice as long;
* it doesn't touch the ``[.]`` anchor caption.

Swaps that fail are returned under ``rejected`` with the reason.

The caller hands in captions (``[{"n", "words", "unsure"}]``) and gets back
``{"summary", "edits", "rejected"}``, where each edit names its caption
number and the exact text to find and replace, ready for the live link.
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

DEFAULT_MODEL = "sonnet"
TIMEOUT_S = 180            # one chunk; a stuck run is killed
CHUNK_WORDS = 12000        # about 75 minutes of talk in one call
OVERLAP_CUES = 3           # captions repeated at each chunk edge for context
ANCHOR = "[.]"

EDITS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from_index": {"type": "integer"},
                    "to_index": {"type": "integer"},
                    "original": {"type": "string"},
                    "replacement": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                },
                "required": ["from_index", "to_index", "original", "replacement", "reason"],
            },
        },
    },
    "required": ["summary", "edits"],
}

SYSTEM_PROMPT = """\
You proofread automatic speech-to-text transcripts that will become video \
subtitles. Your only job is to find words the transcriber MISHEARD and say \
what the speaker actually said.

The transcript is given as numbered words grouped by caption, like:
[c12] 118:we 119:moved 120:it 121:to 122:as* 123:your
A * after a word means the transcriber itself was unsure of it. The * is a \
marker, not part of the word.

Method: first work out what the video is about from the whole transcript and \
the note (if any). Then look for words that don't fit that topic or the \
sentence: a wrong word that sounds alike, a misspelt name or term, words run \
together or split apart. Example: in a talk about cloud hosting, "as your" \
is "Azure" (one edit, 122..123, replacement ["Azure"]).

Rules:
- Only fix misheard words. Do not rephrase, fix the speaker's grammar, remove \
filler words, change punctuation style, or add anything the speaker didn't say.
- Keep each replacement about as long as the original. Never spell out an \
acronym ("AWS" stays "AWS").
- An edit covers consecutive words from_index..to_index (inclusive) inside ONE \
caption. "original" must be exactly those words as given, joined by single \
spaces, without the * marker. "replacement" is the list of corrected words \
(one entry per word; it may have more or fewer words than the original).
- Keep the original's capitalisation and trailing punctuation unless the \
capitalisation itself was the mistake (a name or acronym).
- A mishearing sounds like what was said, so the replacement must sound like \
the transcribed words ("as your" -> "Azure"). Never swap in a different word \
just because it fits the meaning better.
- A real word that makes sense where it is was not misheard, even if \
another word would also fit. Only change a real word when it clearly doesn't \
make sense in context and a sound-alike clearly does.
- Spelling style (US vs Australian, "color" vs "colour") and dashes are fixed \
by a separate check afterwards. Don't edit a word just for that. When you do \
write a replacement, use Australian spelling and leave proper nouns alone.
- Never use em dashes. Use straight quotes and apostrophes only.
- When unsure, leave the word alone. A wrong "fix" that reads naturally is \
worse than a visible mistake. Returning no edits is fine.
- "reason" is one short line a video editor can read at a glance. It must say \
what the original sounds like and why that term fits, e.g. "'as your' sounds \
like Azure, the cloud platform being discussed". If you can't honestly say it \
sounds alike, don't make the edit.
- The editor's note helps you recognise terms the speaker would use. It is \
not a reason to change a word to something that merely fits the topic.
- "summary" is one sentence saying what the video is about.
"""


class ReviewError(Exception):
    """A failure worth showing the user as-is."""


# ---------------------------------------------------------------------------
# Finding and running the local claude CLI
# ---------------------------------------------------------------------------

def find_claude() -> str | None:
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home() / ".local" / "bin"
    for name in ("claude.exe", "claude"):
        p = home / name
        if p.is_file():
            return str(p)
    return None


def availability() -> tuple[bool, str]:
    if find_claude():
        return True, ""
    return False, "Review needs Claude Code installed and signed in on this computer."


def model() -> str:
    return (os.environ.get("SUBTITLE_REVIEW_MODEL") or "").strip() or DEFAULT_MODEL


def build_command(exe: str, model_name: str) -> list[str]:
    """The non-interactive claude call. The transcript goes in on stdin.

    No ``--bare``: it only accepts an API key and never reads the normal
    login, which is the whole point. ``--restricted`` ignores user/project
    settings (so no hooks fire), ``--tools ""`` gives it nothing to run, and
    ``--strict-mcp-config`` stops it loading MCP servers such as the voice
    bridge, so a review never shows up as a phantom operator session.
    """
    return [
        exe, "-p",
        "--output-format", "json",
        "--json-schema", json.dumps(EDITS_SCHEMA),
        "--system-prompt", SYSTEM_PROMPT,
        "--model", model_name,
        "--tools", "",
        "--strict-mcp-config",
        "--restricted",
        "--no-session-persistence",
    ]


def child_env(base: dict | None = None) -> dict:
    """Environment for the child: not nested in an operator session, and
    never billed to an API account even if a key happens to be set."""
    env = dict(os.environ if base is None else base)
    for k in list(env):
        if k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_") or k == "ANTHROPIC_API_KEY":
            env.pop(k, None)
    return env


def _explain_failure(text: str) -> str:
    t = (text or "").lower()
    if any(s in t for s in ("not logged in", "please run /login", "login", "authenticat", "oauth", "credential")):
        return "Claude isn't signed in. Open a terminal, run `claude` once and sign in, then try again."
    if any(s in t for s in ("usage limit", "rate limit", "limit reached", "rate_limit", "quota", "429")):
        return "You've hit your Claude usage limit. Try again after it resets."
    first = next((ln.strip() for ln in (text or "").splitlines() if ln.strip()), "")
    return f"Claude couldn't run the review: {first[:200] or 'no output'}"


def parse_output(stdout: str) -> dict:
    """Pull the structured result out of ``claude -p --output-format json``."""
    try:
        data = json.loads(stdout)
    except (TypeError, ValueError):
        raise ReviewError(_explain_failure(stdout))
    if not isinstance(data, dict):
        raise ReviewError("Claude returned something unexpected (not a JSON object).")
    if data.get("is_error") or data.get("subtype") not in (None, "success"):
        raise ReviewError(_explain_failure(str(data.get("result") or data.get("subtype") or "")))
    out = data.get("structured_output")
    if out is None and isinstance(data.get("result"), str):
        try:
            out = json.loads(data["result"])
        except ValueError:
            out = None
    if not isinstance(out, dict) or not isinstance(out.get("edits"), list):
        raise ReviewError("Claude's answer wasn't in the expected shape; try again.")
    return out


def run_claude(prompt: str, runner=subprocess.run) -> dict:
    exe = find_claude()
    if not exe:
        raise ReviewError(availability()[1])
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # A fresh folder, so the review doesn't pick up this project's notes,
    # memory or operator instructions.
    with tempfile.TemporaryDirectory(prefix="subtitle-review-") as cwd:
        try:
            proc = runner(
                build_command(exe, model()),
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=cwd,
                env=child_env(),
                timeout=TIMEOUT_S,
                **kwargs,
            )
        except subprocess.TimeoutExpired:
            raise ReviewError("Claude took too long to answer (over 3 minutes); try again.")
        except OSError as e:
            raise ReviewError(f"Couldn't start Claude: {e}")
    if proc.returncode != 0:
        # The JSON result often carries the real reason even on failure.
        try:
            return parse_output(proc.stdout)
        except ReviewError as e:
            if proc.stdout.strip().startswith("{"):
                raise
            raise ReviewError(_explain_failure((proc.stderr or "") + "\n" + (proc.stdout or ""))) from e
    return parse_output(proc.stdout)


# ---------------------------------------------------------------------------
# Transcript in, checked edits out
# ---------------------------------------------------------------------------

def _clean(word: str) -> str:
    return (word or "").strip().rstrip("*").strip()


def number_words(cues: list[dict]) -> list[dict]:
    """Flatten captions to globally numbered words.

    Each entry: {"i", "word", "cue", "pos", "unsure", "anchor"}.
    """
    flat = []
    for c in cues:
        words = c.get("words") or []
        unsure = set(c.get("unsure") or [])
        anchor = " ".join(words).strip() == ANCHOR
        for pos, w in enumerate(words):
            flat.append({
                "i": len(flat),
                "word": w,
                "cue": c["n"],
                "pos": pos,
                "unsure": pos in unsure,
                "anchor": anchor,
            })
    return flat


def format_transcript(flat: list[dict], lo: int = 0, hi: int | None = None) -> str:
    """Words lo..hi-1 as ``[cN] i:word i:word*`` lines. The anchor is left out."""
    hi = len(flat) if hi is None else hi
    lines, cur, parts = [], None, []
    for w in flat[lo:hi]:
        if w["anchor"]:
            continue
        if w["cue"] != cur:
            if parts:
                lines.append(" ".join(parts))
            cur, parts = w["cue"], [f"[c{w['cue']}]"]
        parts.append(f"{w['i']}:{w['word']}{'*' if w['unsure'] else ''}")
    if parts:
        lines.append(" ".join(parts))
    return "\n".join(lines)


def build_prompt(transcript: str, note: str = "", summary_so_far: str = "", part: tuple[int, int] | None = None) -> str:
    head = []
    if note.strip():
        head.append(f"Note from the editor about this video: {note.strip()}")
    if summary_so_far:
        head.append(f"Earlier parts of this video were about: {summary_so_far}")
    if part and part[1] > 1:
        head.append(f"This is part {part[0]} of {part[1]} of the transcript.")
    head.append("Transcript:")
    return "\n".join(head) + "\n" + transcript + "\n"


def chunk_ranges(flat: list[dict], limit: int | None = None, overlap_cues: int = OVERLAP_CUES) -> list[tuple[int, int]]:
    """Split at caption boundaries into word ranges of about ``limit`` words,
    each starting a few captions before the previous one ended."""
    limit = limit or CHUNK_WORDS
    if len(flat) <= limit:
        return [(0, len(flat))]
    starts = [w["i"] for w in flat if w["pos"] == 0]   # first word of each caption
    ranges, lo = [], 0
    while lo < len(flat):
        hi = min(len(flat), lo + limit)
        if hi < len(flat):
            cut = max((s for s in starts if lo < s <= hi), default=hi)
            hi = cut
        ranges.append((lo, hi))
        if hi >= len(flat):
            break
        back = [s for s in starts if s < hi]
        nxt = back[-overlap_cues] if len(back) >= overlap_cues else lo
        lo = nxt if nxt > lo else hi
    return ranges


def _tidy(word: str) -> str:
    """Straight quotes only, no em dashes, no stray whitespace."""
    w = (word or "").strip()
    w = w.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    w = w.replace("—", "").replace("…", "...")
    return w


def validate_edits(flat: list[dict], raw_edits: list) -> tuple[list[dict], list[dict]]:
    accepted, rejected = [], []

    def reject(e, why):
        rejected.append({"edit": e, "why": why})

    seen = set()
    candidates = []
    for e in raw_edits or []:
        if not isinstance(e, dict):
            reject(e, "not an edit")
            continue
        try:
            a, b = int(e.get("from_index")), int(e.get("to_index"))
        except (TypeError, ValueError):
            reject(e, "word numbers missing")
            continue
        repl = e.get("replacement")
        if isinstance(repl, str):
            repl = repl.split()
        words = []
        for r in repl or []:
            words.extend(_tidy(str(r)).split())
        key = (a, b, tuple(words))
        if key in seen:
            continue   # the same swap from two overlapping chunks
        seen.add(key)
        candidates.append((a, b, words, e))

    taken = set()
    for a, b, words, e in sorted(candidates, key=lambda c: (c[0], c[1])):
        if a < 0 or b < a or b >= len(flat):
            reject(e, "word numbers out of range")
            continue
        span = flat[a:b + 1]
        if any(w["anchor"] for w in span):
            reject(e, "touches the [.] anchor caption")
            continue
        if len({w["cue"] for w in span}) != 1:
            reject(e, "crosses a caption boundary")
            continue
        actual = " ".join(_clean(w["word"]) for w in span)
        original = " ".join(_clean(x) for x in str(e.get("original") or "").split())
        if original != actual:
            reject(e, f"original doesn't match the transcript (it says {actual!r})")
            continue
        if not words:
            reject(e, "empty replacement")
            continue
        new = " ".join(words)
        if new == actual:
            reject(e, "no change")
            continue
        if len(new) > max(2 * len(actual), len(actual) + 3):
            reject(e, "replacement is much longer than the original")
            continue
        if taken.intersection(range(a, b + 1)):
            reject(e, "overlaps another edit")
            continue
        taken.update(range(a, b + 1))
        cue_words = [w for w in flat if w["cue"] == span[0]["cue"]]
        accepted.append({
            "cue": span[0]["cue"],
            "at": span[0]["pos"],          # word offset within the caption
            "count": len(span),
            "find": actual,
            "replace": new,
            "reason": str(e.get("reason") or "").strip(),
            "cueText": " ".join(w["word"] for w in cue_words),
            "from_index": a,
            "to_index": b,
        })
    return accepted, rejected


def review(cues: list[dict], note: str = "", progress=None, runner=subprocess.run) -> dict:
    """Review captions; returns {"summary", "edits", "rejected"}."""
    flat = number_words(cues)
    if not any(not w["anchor"] for w in flat):
        return {"summary": "", "edits": [], "rejected": []}
    ranges = chunk_ranges(flat)
    summary, raw = "", []
    for k, (lo, hi) in enumerate(ranges, 1):
        if progress:
            progress(k, len(ranges))
        prompt = build_prompt(format_transcript(flat, lo, hi), note, summary, (k, len(ranges)))
        out = run_claude(prompt, runner=runner)
        if not summary:
            summary = str(out.get("summary") or "").strip()
        # Overlap words can be edited by two chunks: identical swaps are
        # merged, and a conflicting second one is rejected as an overlap.
        raw.extend(e for e in out.get("edits") or [] if isinstance(e, dict))
    edits, rejected = validate_edits(flat, raw)
    return {"summary": summary, "edits": edits, "rejected": rejected}


# ---------------------------------------------------------------------------
# Applying through the live link (live_link.py)
# ---------------------------------------------------------------------------

def cues_from_doc(doc: dict) -> list[dict]:
    """The live link's published document -> reviewer captions."""
    return [
        {"n": c["n"], "words": str(c.get("text") or "").split(), "unsure": c.get("unsure") or []}
        for c in doc.get("cues") or []
    ]


def edits_to_ops(edits: list[dict]) -> list[dict]:
    """One whole-line ``set`` per changed caption.

    Built from word positions rather than find/replace, so a word that
    appears twice in a line can't change the wrong one. The live link adds
    the line text this was read from, so the tab refuses it if Ben has
    edited that line since.
    """
    by_cue: dict[int, list[dict]] = {}
    for e in edits:
        by_cue.setdefault(e["cue"], []).append(e)
    ops = []
    for cue, group in sorted(by_cue.items()):
        words = group[0]["cueText"].split()
        for e in sorted(group, key=lambda e: e["at"], reverse=True):
            words[e["at"]:e["at"] + e["count"]] = e["replace"].split()
        note = "; ".join(
            f'{e["find"]} → {e["replace"]}' + (f': {e["reason"]}' if e["reason"] else "")
            for e in sorted(group, key=lambda e: e["at"])
        )
        ops.append({"op": "set", "cue": cue, "text": " ".join(words), "note": note, "count": len(group)})
    return ops


def numbered_transcript(link) -> dict:
    """What Claude sees, for an operator doing the review itself in chat."""
    doc = link.doc()
    if not doc.get("open"):
        return doc
    flat = number_words(cues_from_doc(doc))
    return {"open": True, "file": doc.get("file"), "rev": doc.get("rev"),
            "words": len(flat), "transcript": format_transcript(flat)}


def run_live_review(job: dict, link, note: str = "", runner=subprocess.run, supplied=None) -> dict:
    """Review whatever is open in the editor tab and send the swaps to it.

    ``supplied`` is a list of edits in the schema's shape (from an operator
    who did the review itself); they skip Claude but get the same checks.
    """
    doc = link.doc()
    if not doc.get("open"):
        raise ReviewError(doc.get("reason") or "No transcript is open in the Subtitle editor.")
    job["file"] = doc.get("file") or ""
    cues = cues_from_doc(doc)
    if supplied is None:
        res = review(cues, note, progress=progress_into(job), runner=runner)
    else:
        edits, rejected = validate_edits(number_words(cues), supplied)
        res = {"summary": note, "edits": edits, "rejected": rejected}
    job["stage"] = "Applying"
    ops = [{"op": "review", "phase": "start", "job": job["id"]}]
    ops += edits_to_ops(res["edits"])
    ops.append({"op": "review", "phase": "end", "job": job["id"], "summary": res["summary"]})
    sent = link.submit(ops, rev=doc.get("rev"), wait=8)
    results = [r for r in sent.get("results") or [] if r.get("op") == "set"]
    applied = [r for r in results if r.get("ok")]
    skipped = [r for r in results if r.get("ok") is False]
    return {
        "summary": res["summary"],
        "edits": res["edits"],
        "rejected": res["rejected"],
        "applied": len(applied),
        "skipped": [{"cue": r.get("cue"), "why": r.get("reason")} for r in skipped],
        "pending": sum(1 for r in results if r.get("ok") is None),
        "changes": [
            {"cue": e["cue"], "was": e["find"], "now": e["replace"], "reason": e["reason"]}
            for e in res["edits"]
        ],
    }


# ---------------------------------------------------------------------------
# Background job (one at a time), same shape as transcription jobs
# ---------------------------------------------------------------------------

_jobs: dict = {}
_lock = threading.Lock()


def busy() -> bool:
    return any(j["status"] == "running" for j in _jobs.values())


def start_job(work, label: str = "") -> str | None:
    """Run ``work(job)`` in the background. ``work`` returns the result dict.
    Returns the job id, or None if a review is already running."""
    with _lock:
        if busy():
            return None
        job_id = str(uuid.uuid4())
        job = {
            "id": job_id, "status": "running", "stage": "Starting Claude",
            "label": label, "started": time.time(),
            "part": 0, "parts": 0,
        }
        _jobs[job_id] = job

    def run():
        try:
            job.update(work(job) or {})
            job["status"] = "complete"
            job["stage"] = ""
        except ReviewError as e:
            job["status"], job["error"] = "error", str(e)
        except Exception as e:   # keep the UI informed rather than spinning
            job["status"], job["error"] = "error", f"Review failed: {e}"
        job["seconds"] = round(time.time() - job["started"], 1)

    threading.Thread(target=run, daemon=True).start()
    return job_id


def get_job(job_id: str) -> dict | None:
    return _jobs.get(job_id)


def latest_job() -> dict | None:
    return max(_jobs.values(), key=lambda j: j["started"], default=None)


def progress_into(job: dict):
    def cb(part, parts):
        job["part"], job["parts"] = part, parts
        job["stage"] = f"Reviewing part {part} of {parts}" if parts > 1 else "Reviewing"
    return cb
