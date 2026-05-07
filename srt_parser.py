import re
from dataclasses import dataclass
from typing import List


@dataclass
class SubtitleCue:
    index: int
    start_time: str  # "00:00:01,000"
    end_time: str    # "00:00:03,500"
    text: str        # Text with \n for line breaks

    def to_dict(self):
        lines = self.text.split('\n')
        return {
            'index': self.index,
            'startTime': self.start_time,
            'endTime': self.end_time,
            'text': self.text,
            'lines': lines,
        }


def parse_srt(content: str) -> List[SubtitleCue]:
    cues = []
    content = content.strip().replace('\r\n', '\n').replace('\r', '\n')
    blocks = re.split(r'\n{2,}', content)

    for block in blocks:
        block = block.strip()
        if not block:
            continue

        lines = block.split('\n')
        if len(lines) < 3:
            continue

        try:
            index = int(lines[0].strip())
        except ValueError:
            continue

        time_match = re.match(
            r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})',
            lines[1].strip()
        )
        if not time_match:
            continue

        start_time = time_match.group(1)
        end_time = time_match.group(2)
        text = '\n'.join(lines[2:])

        cues.append(SubtitleCue(
            index=index,
            start_time=start_time,
            end_time=end_time,
            text=text,
        ))

    return cues


def serialize_srt(cues: List[SubtitleCue], anchor_zero: bool = True) -> str:
    """
    Serialize cues to SRT format.

    If anchor_zero is True and the first cue doesn't start at 00:00:00,
    a tiny blank cue is prepended at time zero.  This ensures that when
    the SRT is imported into DaVinci Resolve the subtitle track starts
    at the very beginning of the timeline — just drag it flush to the
    start and everything lines up, no manual alignment needed.
    """
    out_cues = list(cues)

    if anchor_zero and out_cues:
        first_ms = time_to_ms(out_cues[0].start_time)
        if first_ms > 100:  # only add anchor if first cue starts after 100ms
            out_cues.insert(0, SubtitleCue(
                index=0,
                start_time='00:00:00,000',
                end_time='00:00:01,000',
                text='[.]',  # visible anchor for timeline alignment — delete after snapping
            ))

    blocks = []
    for i, cue in enumerate(out_cues, 1):
        blocks.append(f"{i}\n{cue.start_time} --> {cue.end_time}\n{cue.text}")
    return '\n\n'.join(blocks) + '\n'


def time_to_ms(time_str: str) -> int:
    h, m, rest = time_str.split(':')
    s, ms = rest.split(',')
    return int(h) * 3_600_000 + int(m) * 60_000 + int(s) * 1_000 + int(ms)


def ms_to_time(ms: int) -> str:
    ms = max(0, ms)
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def flatten(text: str) -> str:
    """Collapse all whitespace/line-breaks to a single space."""
    return ' '.join(text.split())


def smart_break(flat: str, max_chars: int) -> str:
    """
    Insert at most one line break in `flat` so neither line exceeds
    `max_chars`.  Prefers breaks after punctuation and at roughly
    equal line lengths.  Returns original text if it already fits
    on one line or a valid two-line break cannot be found.
    """
    if len(flat) <= max_chars:
        return flat

    words = flat.split()
    best_idx = None          # break *before* words[best_idx]
    best_score = float('inf')

    current = ''
    for i, word in enumerate(words[:-1]):
        current = (current + ' ' + word).strip()
        remaining = ' '.join(words[i + 1:])

        if len(current) <= max_chars and len(remaining) <= max_chars:
            length_diff = abs(len(current) - len(remaining))
            # Prefer breaking after sentence-ending punctuation
            punct_bonus = -6 if current[-1] in ',.!?;:' else 0
            score = length_diff + punct_bonus
            if score < best_score:
                best_score = score
                best_idx = i + 1

    if best_idx is not None:
        return ' '.join(words[:best_idx]) + '\n' + ' '.join(words[best_idx:])

    # Fallback: hard break at max_chars on the nearest word boundary
    line1 = ''
    for i, word in enumerate(words):
        test = (line1 + ' ' + word).strip()
        if len(test) > max_chars:
            break
        line1 = test
    else:
        return flat  # somehow fits; shouldn't reach here

    line2 = flat[len(line1):].strip()
    return f"{line1}\n{line2}" if line1 else flat


def format_cues_two_line(cues: List[SubtitleCue], max_chars: int) -> List[SubtitleCue]:
    """Wrap long cues to two lines; keeps cue boundaries unchanged."""
    result = []
    for cue in cues:
        flat = flatten(cue.text)
        new_text = smart_break(flat, max_chars)
        result.append(SubtitleCue(
            index=cue.index,
            start_time=cue.start_time,
            end_time=cue.end_time,
            text=new_text,
        ))
    return result


def seconds_to_srt_time(sec: float) -> str:
    """Convert seconds (float) to SRT time format 'HH:MM:SS,mmm'."""
    total_ms = max(0, round(sec * 1000))
    return ms_to_time(total_ms)


def generate_word_srt(words: list) -> str:
    """
    Generate an SRT where each cue is a single word with contiguous timing.

    Each word's end time is set to the next word's start time (no gaps),
    so DaVinci Resolve creates a continuous sequence of subtitle items.

    `words` is a list of {"word": str, "start": float, "end": float}.
    """
    if not words:
        return ''

    cues = []
    for i, w in enumerate(words):
        start_sec = w['start']
        # Contiguous: this word's end = next word's start (no gaps)
        if i < len(words) - 1:
            end_sec = words[i + 1]['start']
            # But don't let end < start (shouldn't happen, but be safe)
            if end_sec <= start_sec:
                end_sec = w['end']
        else:
            end_sec = w['end']

        cues.append(SubtitleCue(
            index=i + 1,
            start_time=seconds_to_srt_time(start_sec),
            end_time=seconds_to_srt_time(end_sec),
            text=w['word'],
        ))
    return serialize_srt(cues)


def format_cues_split(cues: List[SubtitleCue], max_chars: int) -> List[SubtitleCue]:
    """
    Split cues that exceed max_chars into multiple single-line cues,
    dividing the time proportionally by character count.
    """
    result = []
    for cue in cues:
        flat = flatten(cue.text)

        if len(flat) <= max_chars:
            result.append(SubtitleCue(
                index=len(result) + 1,
                start_time=cue.start_time,
                end_time=cue.end_time,
                text=flat,
            ))
            continue

        # Greedy word-pack into chunks of max_chars
        words = flat.split()
        chunks: List[str] = []
        current = ''
        for word in words:
            test = (current + ' ' + word).strip()
            if len(test) <= max_chars:
                current = test
            else:
                if current:
                    chunks.append(current)
                current = word
        if current:
            chunks.append(current)

        start_ms = time_to_ms(cue.start_time)
        end_ms = time_to_ms(cue.end_time)
        duration_ms = end_ms - start_ms
        total_chars = sum(len(c) for c in chunks)

        cur_start = start_ms
        for i, chunk in enumerate(chunks):
            if i == len(chunks) - 1:
                chunk_end = end_ms
            else:
                proportion = len(chunk) / total_chars
                chunk_end = cur_start + int(duration_ms * proportion)

            result.append(SubtitleCue(
                index=len(result) + 1,
                start_time=ms_to_time(cur_start),
                end_time=ms_to_time(chunk_end),
                text=chunk,
            ))
            cur_start = chunk_end

    return result
