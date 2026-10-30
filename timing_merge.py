"""
Whisper wording + Deepgram timing.

Whisper (large-v2) is the better transcriber of Ben's voiceover: it keeps
every word, writes numbers as digits and leaves the spelling alone. Its word
timings, though, run a couple of frames early and occasionally put a word
boundary hundreds of milliseconds off. Deepgram Nova-3 times words more
tightly but drops words, spells out numbers and Americanises spelling.

merge() keeps Whisper's words exactly (text, probability, order) and swaps in
Deepgram's start/end only where a word lines up with a Deepgram word and the
Deepgram time passes some sanity checks. Deepgram is not ground truth either:
it sometimes runs a word into the next or stretches one over a word it
dropped, so suspect times are skipped and those words are fitted between
their trusted neighbours instead.

Stdlib only.
"""

import difflib
import re
import statistics

# A Deepgram word shorter than this is a glitch, not a word.
MIN_WORD_S = 0.02
# Longest believable short word. Longer words get 0.15 s per letter.
MAX_SHORT_WORD_S = 1.2
MAX_S_PER_LETTER = 0.15
# A start this far from Whisper's needs a neighbour moving the same way.
BIG_SHIFT_S = 0.3
AGREE_S = 0.15
# Below this share of Whisper words matched, the two transcripts are not of
# the same audio (or Deepgram misheard badly), so nothing is merged.
MIN_MATCH_RATE = 0.5
# Words fitted between trusted neighbours get at least this much room.
MIN_FIT_S = 0.05
# Blocks of disagreement larger than this (word pairs) are left unmatched
# rather than aligned word by word; it keeps the cost bounded on long files.
MAX_BLOCK_CELLS = 2500

SKIP_REASONS = ("too_long", "too_short", "big_shift", "backwards", "overlap")


# ---------------------------------------------------------------------------
# Normalising words so the two transcripts can be compared
# ---------------------------------------------------------------------------

_ONES = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_ORDINALS = {
    "first": "one", "second": "two", "third": "three", "fourth": "four",
    "fifth": "five", "sixth": "six", "seventh": "seven", "eighth": "eight",
    "ninth": "nine", "tenth": "ten", "eleventh": "eleven",
    "twelfth": "twelve", "thirteenth": "thirteen",
    "fourteenth": "fourteen", "fifteenth": "fifteen",
    "sixteenth": "sixteen", "seventeenth": "seventeen",
    "eighteenth": "eighteen", "nineteenth": "nineteen",
    "twentieth": "twenty", "thirtieth": "thirty", "fortieth": "forty",
    "fiftieth": "fifty", "sixtieth": "sixty", "seventieth": "seventy",
    "eightieth": "eighty", "ninetieth": "ninety",
    "hundredth": "hundred", "thousandth": "thousand",
    "millionth": "million",
}
_SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000}


def _plain(text: str) -> str:
    """Lower case, letters and digits only ("Disney+." -> "disneyplus").

    Symbols that are spoken become their words, so "Disney+" lines up with
    "Disney plus" and "100 %" with "100%".
    """
    text = (text or "").lower()
    for sym, said in (("+", "plus"), ("%", "percent"), ("&", "and")):
        text = text.replace(sym, said)
    return re.sub(r"[^a-z0-9]", "", text)


def _ordinal_suffix(n: int) -> str:
    if 10 <= n % 100 <= 13:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def _spoken_number(tokens: list[str]) -> str | None:
    """Digits for spelt-out number words, or None if they aren't a number.

    "twelve" -> "12", "fifteenth" -> "15th", "twenty twenty six" -> "2026",
    "one hundred and five" -> "105". Ordinal "second" is left alone on its
    own (it is far more often the unit of time).
    """
    parts = []
    for t in tokens:
        parts.extend(p for p in re.split(r"[-\s]+", t.lower()) if p)
    parts = [re.sub(r"[^a-z]", "", p) for p in parts]
    if not parts or not all(parts):
        return None
    if len(parts) == 1 and parts[0] == "second":
        return None

    ordinal = parts[-1] in _ORDINALS
    if ordinal:
        parts[-1] = _ORDINALS[parts[-1]]
    if parts[0] == "and" or parts[-1] == "and":
        return None
    parts = [p for p in parts if p != "and"]
    if any(p not in _ONES and p not in _TENS and p not in _SCALES for p in parts):
        return None
    if parts[0] == "oh" or (len(parts) == 1 and parts[0] in _SCALES):
        return None

    # Chunks under 100: a tens word plus an optional unit, or a single word.
    if not any(p in _SCALES for p in parts):
        chunks, i = [], 0
        while i < len(parts):
            p = parts[i]
            if p in _TENS and i + 1 < len(parts) and parts[i + 1] in _ONES \
                    and 0 < _ONES[parts[i + 1]] < 10:
                chunks.append(_TENS[p] + _ONES[parts[i + 1]])
                i += 2
            else:
                chunks.append(_TENS.get(p, _ONES.get(p)))
                i += 1
        if len(chunks) == 1:
            value = chunks[0]
        elif len(chunks) == 2 and chunks[0] >= 10:
            # Said like a year: "twenty twenty six", "nineteen oh five".
            value = chunks[0] * 100 + chunks[1]
        else:
            return None
    else:
        total, current = 0, 0
        for p in parts:
            if p in _SCALES:
                scale = _SCALES[p]
                current = max(current, 1) * scale
                if scale >= 1000:
                    total += current
                    current = 0
            else:
                current += _TENS.get(p, _ONES.get(p, 0))
        value = total + current

    return f"{value}{_ordinal_suffix(value)}" if ordinal else str(value)


def _key(text: str) -> str:
    """Comparison key for one word: plain text, number words as digits."""
    return _spoken_number([text]) or _plain(text)


def _similar(a: str, b: str) -> bool:
    """Same word give or take spelling ("cancelled"/"canceled", "SVODs"/"SVOD")."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def _align(w_keys: list[str], d_keys: list[str], d_texts: list[str]) -> list[tuple]:
    """Pair Whisper and Deepgram words.

    Returns (w_indices, d_indices, kind) tuples, kind being "exact",
    "similar" (spelling or a spelt-out number) or "substituted" (a
    different word in the same slot, e.g. "luck"/"work"). Indices are into
    the key lists.
    """
    pairs = []
    sm = difflib.SequenceMatcher(None, w_keys, d_keys, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs.extend(([i1 + k], [j1 + k], "exact") for k in range(i2 - i1))
        elif tag == "replace" and (i2 - i1) * (j2 - j1) <= MAX_BLOCK_CELLS:
            pairs.extend(_align_block(w_keys, d_keys, d_texts, i1, i2, j1, j2))
    return pairs


def _align_block(w_keys, d_keys, d_texts, i1, i2, j1, j2) -> list[tuple]:
    """Least-cost word alignment inside one block where the two disagree."""
    n, m = i2 - i1, j2 - j1
    INF = float("inf")
    # cost[i][j] = cheapest way to align w[i:] with d[j:] (block-relative).
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    move = [[None] * (m + 1) for _ in range(n + 1)]
    cost[n][m] = 0.0

    def group_matches(w_text: str, d_slice: list[str]) -> bool:
        return (_spoken_number(d_slice) == w_text
                or _similar(w_text, "".join(_plain(t) for t in d_slice)))

    for i in range(n, -1, -1):
        for j in range(m, -1, -1):
            if i == n and j == m:
                continue
            best, how = INF, None
            if i < n and cost[i + 1][j] + 1 < best:
                best, how = cost[i + 1][j] + 1, ("skip_w",)
            if j < m and cost[i][j + 1] + 1 < best:
                best, how = cost[i][j + 1] + 1, ("skip_d",)
            if i < n and j < m:
                a, b = w_keys[i1 + i], d_keys[j1 + j]
                c = 0.0 if _similar(a, b) else 1.2
                if cost[i + 1][j + 1] + c < best:
                    kind = "similar" if c == 0 else "substituted"
                    best, how = cost[i + 1][j + 1] + c, ("pair", 1, 1, kind)
                # One Whisper word said as several Deepgram words ("2026" /
                # "twenty twenty six"), or the other way round.
                for k in range(2, 5):
                    if j + k <= m and cost[i + 1][j + k] < best and \
                            group_matches(a, d_texts[j1 + j:j1 + j + k]):
                        best, how = cost[i + 1][j + k], ("pair", 1, k, "similar")
                for k in range(2, 4):
                    if i + k <= n and cost[i + k][j + 1] < best and \
                            _similar("".join(w_keys[i1 + i:i1 + i + k]), b):
                        best, how = cost[i + k][j + 1], ("pair", k, 1, "similar")
            cost[i][j], move[i][j] = best, how

    pairs, i, j = [], 0, 0
    while (i, j) != (n, m):
        how = move[i][j]
        if how[0] == "skip_w":
            i += 1
        elif how[0] == "skip_d":
            j += 1
        else:
            _, kw, kd, kind = how
            pairs.append((list(range(i1 + i, i1 + i + kw)),
                          list(range(j1 + j, j1 + j + kd)), kind))
            i, j = i + kw, j + kd
    return pairs


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def _max_duration(text: str) -> float:
    letters = len(_plain(text))
    if any(ch.isdigit() for ch in text):
        return 2.5  # "2026" is four characters but five syllables
    return max(MAX_SHORT_WORD_S, MAX_S_PER_LETTER * letters)


def merge(whisper_words: list[dict], deepgram_words: list[dict],
          keep_speakers: bool = False) -> tuple[list[dict], dict]:
    """Whisper's words with Deepgram's timing where it can be trusted.

    Returns (words, stats). Words come back in Whisper's order with Whisper's
    text and probability; only start/end change (and speaker, from Deepgram,
    when keep_speakers is set). Output times never go backwards.
    """
    words = [dict(w) for w in whisper_words]
    stats = {
        "applied": False,
        "whisper_words": len(words),
        "deepgram_words": len(deepgram_words),
        "matched": 0,
        "matched_exact": 0,
        "substituted": 0,
        "replaced": 0,
        "trimmed": 0,
        "skipped": {r: 0 for r in SKIP_REASONS},
        "interpolated": 0,
        "median_shift_ms": 0,
        "reason": "",
    }
    if not words or not deepgram_words:
        stats["reason"] = "Deepgram returned no words" if words else "no Whisper words"
        return words, stats

    # Words that are only punctuation ("%", "-") have nothing to compare.
    w_idx = [i for i, w in enumerate(words) if _key(w["word"])]
    d_idx = [j for j, d in enumerate(deepgram_words) if _key(d["word"])]
    pairs = _align(
        [_key(words[i]["word"]) for i in w_idx],
        [_key(deepgram_words[j]["word"]) for j in d_idx],
        [deepgram_words[j]["word"] for j in d_idx],
    )

    # cand: Whisper index -> proposed Deepgram (start, end).
    cand: dict[int, list] = {}
    speaker_of: dict[int, object] = {}
    for wi, dj, kind in pairs:
        ws = [w_idx[i] for i in wi]
        ds = [deepgram_words[d_idx[j]] for j in dj]
        stats["matched"] += len(ws)
        if kind == "exact":
            stats["matched_exact"] += len(ws)
        elif kind == "substituted":
            stats["substituted"] += len(ws)
        for w in ws:
            speaker_of[w] = ds[0].get("speaker")
        start, end = float(ds[0]["start"]), float(ds[-1]["end"])
        if len(ws) == 1:
            cand[ws[0]] = [start, end]
        else:
            # Several Whisper words heard as one Deepgram word: share its
            # span out in proportion to Whisper's own durations.
            durs = [max(0.0, words[w]["end"] - words[w]["start"]) for w in ws]
            total = sum(durs) or len(ws)
            t = start
            for w, dur in zip(ws, durs):
                share = (dur if sum(durs) else 1) / total * (end - start)
                cand[w] = [t, t + share]
                t += share

    agreed = stats["matched"] - stats["substituted"]
    if agreed < MIN_MATCH_RATE * len(w_idx):
        stats["reason"] = (f"only {agreed} of {len(w_idx)} words "
                           "lined up, so the transcripts look too different")
        return words, stats

    # Guard 1: implausible durations.
    for w in list(cand):
        s, e = cand[w]
        if e - s < MIN_WORD_S:
            stats["skipped"]["too_short"] += 1
            del cand[w]
        elif e - s > _max_duration(words[w]["word"]):
            stats["skipped"]["too_long"] += 1
            del cand[w]

    # Guard 2: a big move needs a neighbour moving the same way. "The same
    # way" means the boundary moved: a word's new start agrees with the
    # previous word's new end (or its new end with the next word's start),
    # which is what happens when the two models place a word boundary
    # differently but agree about everything else.
    order = sorted(cand)
    shift_s = {w: cand[w][0] - words[w]["start"] for w in order}
    shift_e = {w: cand[w][1] - words[w]["end"] for w in order}
    big = []
    for k, w in enumerate(order):
        if abs(shift_s[w]) <= BIG_SHIFT_S and abs(shift_e[w]) <= BIG_SHIFT_S:
            continue
        agree = False
        if k > 0 and order[k - 1] == w - 1:
            p = order[k - 1]
            agree = (abs(shift_e[p] - shift_s[w]) <= AGREE_S
                     or abs(shift_s[p] - shift_s[w]) <= AGREE_S)
        if not agree and k + 1 < len(order) and order[k + 1] == w + 1:
            nx = order[k + 1]
            agree = (abs(shift_s[nx] - shift_e[w]) <= AGREE_S
                     or abs(shift_s[nx] - shift_s[w]) <= AGREE_S)
        if not agree:
            big.append(w)
    for w in big:
        stats["skipped"]["big_shift"] += 1
        del cand[w]

    # Guard 3: order. A start before the previous trusted word's start would
    # reorder the words; an end past the next start is a word run into the
    # next one, so its end is pulled back to where the next word begins.
    order, prev_start = sorted(cand), None
    for w in order:
        if prev_start is not None and cand[w][0] < prev_start:
            stats["skipped"]["backwards"] += 1
            del cand[w]
        else:
            prev_start = cand[w][0]
    order = sorted(cand)
    for a, b in zip(order, order[1:]):
        if cand[a][1] > cand[b][0]:
            if cand[b][0] - cand[a][0] >= MIN_WORD_S:
                cand[a][1] = cand[b][0]
                stats["trimmed"] += 1
    order = sorted(cand)
    for a, b in zip(order, order[1:]):
        if cand[a][1] > cand[b][0]:  # could not be trimmed
            stats["skipped"]["overlap"] += 1
            del cand[a]
    anchors = sorted(cand)

    for w in anchors:
        words[w]["start"], words[w]["end"] = round(cand[w][0], 3), round(cand[w][1], 3)
    stats["replaced"] = len(anchors)
    if anchors:
        stats["median_shift_ms"] = round(1000 * statistics.median(
            cand[w][0] - whisper_words[w]["start"] for w in anchors))

    # Everything else is fitted between its trusted neighbours.
    _fit_unanchored(words, whisper_words, anchors, stats)
    _make_monotonic(words)

    if keep_speakers:
        _carry_speakers(words, speaker_of, deepgram_words)
        smooth_speaker_blips(words)

    stats["applied"] = True
    return words, stats


def _fit_unanchored(words, original, anchors, stats):
    """Move each run of words between two anchors by the anchors' shift,
    blended across the run, and keep it inside the gap they leave."""
    anchor_set = set(anchors)
    n = len(words)
    i = 0
    while i < n:
        if i in anchor_set:
            i += 1
            continue
        j = i
        while j < n and j not in anchor_set:
            j += 1
        run = list(range(i, j))  # words i..j-1 have no trusted time
        a = i - 1 if i > 0 else None
        b = j if j < n else None
        stats["interpolated"] += len(run)

        sh_a = words[a]["start"] - original[a]["start"] if a is not None else None
        sh_b = words[b]["start"] - original[b]["start"] if b is not None else None
        if sh_a is None and sh_b is None:
            i = j
            continue
        sh_a = sh_b if sh_a is None else sh_a
        sh_b = sh_a if sh_b is None else sh_b

        lo = words[a]["end"] if a is not None else 0.0
        hi = words[b]["start"] if b is not None else float("inf")
        need = MIN_FIT_S * len(run)
        if a is not None and hi - lo < need:
            # The run has no room (its neighbour's time swallowed the gap):
            # give it some of the previous word, at most half.
            floor = words[a]["start"] + (words[a]["end"] - words[a]["start"]) / 2
            words[a]["end"] = round(max(floor, min(words[a]["end"], hi - need)), 3)
            lo = words[a]["end"]

        t0 = original[run[0]]["start"]
        t1 = original[run[-1]]["end"]
        span = max(t1 - t0, 1e-6)
        for w in run:
            frac = (original[w]["start"] - t0) / span
            shift = sh_a + (sh_b - sh_a) * frac
            s = original[w]["start"] + shift
            e = original[w]["end"] + shift
            words[w]["start"] = round(min(max(s, lo), hi), 3)
            words[w]["end"] = round(min(max(e, lo), hi), 3)
        i = j


def _make_monotonic(words):
    """No word starts before the previous one ends; no word ends before it starts."""
    prev_end = 0.0
    for w in words:
        s = max(float(w["start"]), prev_end)
        e = max(float(w["end"]), s)
        w["start"], w["end"] = round(s, 3), round(e, 3)
        prev_end = w["end"]


def _carry_speakers(words, speaker_of, deepgram_words=()):
    """Deepgram's speaker on matched words. An unmatched word between two
    matched words of the same speaker takes that speaker. One sitting at a
    change of speaker goes by time instead: it takes the speaker of the
    nearest Deepgram word (of those two), so a word Deepgram dropped at the
    start of a reply isn't handed to the person who was talking before.
    Unmatched words at either end take the nearest matched word's speaker."""
    known = [(i, speaker_of[i]) for i in sorted(speaker_of) if speaker_of[i] is not None]
    if not known:
        for w in words:
            w["speaker"] = None
        return
    timed = [d for d in deepgram_words if d.get("speaker") is not None]
    k = 0  # known[k] is the next matched word at or after i
    for i, w in enumerate(words):
        while k < len(known) and known[k][0] < i:
            k += 1
        if k < len(known) and known[k][0] == i:
            w["speaker"] = known[k][1]
            continue
        before = known[k - 1][1] if k > 0 else None
        after = known[k][1] if k < len(known) else None
        if before is None or after is None or before == after:
            w["speaker"] = before if before is not None else after
            continue
        w["speaker"] = _nearest_speaker(w, timed, (before, after)) or before


def _nearest_speaker(w, deepgram_words, choices):
    """Speaker (one of choices) of the Deepgram word nearest w in time."""
    mid = (float(w["start"]) + float(w["end"])) / 2
    best, best_d = None, None
    for d in deepgram_words:
        if d["speaker"] not in choices:
            continue
        s, e = float(d["start"]), float(d["end"])
        dist = 0.0 if s <= mid <= e else min(abs(mid - s), abs(mid - e))
        if best_d is None or dist < best_d:
            best, best_d = d["speaker"], dist
    return best


# A one-word change of speaker this tight against both neighbours, in the
# middle of a sentence, is diarisation flicker rather than someone cutting in.
BLIP_GAP_S = 0.3
_ENDS_SENTENCE = re.compile(r"[.!?…][\"')\]]*$")
_ENDS_CLAUSE = re.compile(r"[.!?…,;:][\"')\]]*$")


def smooth_speaker_blips(words):
    """Give a lone word back to the speaker on both sides of it when it is
    clearly a diarisation flicker: same speaker either side, mid-sentence
    (the word before doesn't end a sentence, the word itself doesn't end a
    clause) and no real pause either side. A one-word reply ("Yeah.") is
    kept: it ends in punctuation, and usually has a pause around it.
    Returns how many words were changed."""
    changed = 0
    for i in range(1, len(words) - 1):
        prev, w, nxt = words[i - 1], words[i], words[i + 1]
        sp = prev.get("speaker")
        if sp is None or w.get("speaker") is None or w["speaker"] == sp:
            continue
        if nxt.get("speaker") != sp:
            continue
        if _ENDS_SENTENCE.search(prev["word"]) or _ENDS_CLAUSE.search(w["word"]):
            continue
        gap_in = float(w["start"]) - float(prev["end"])
        gap_out = float(nxt["start"]) - float(w["end"])
        if gap_in > BLIP_GAP_S or gap_out > BLIP_GAP_S:
            continue
        w["speaker"] = sp
        changed += 1
    return changed


def summary(stats: dict) -> str:
    """One line for the completion toast."""
    if not stats.get("applied"):
        return f"Deepgram timing not applied: {stats.get('reason') or 'no match'}."
    skipped = sum(stats["skipped"].values())
    shift = stats["median_shift_ms"]
    direction = "later" if shift > 0 else "earlier"
    parts = [f"Deepgram timing on {stats['replaced']} of {stats['whisper_words']} words"]
    if shift:
        parts.append(f"typically {abs(shift)} ms {direction}")
    if skipped:
        parts.append(f"{skipped} suspect Deepgram time{'s' if skipped != 1 else ''} ignored")
    return ", ".join(parts) + "."
