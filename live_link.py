"""Live link between the open editor tab and anything else on this machine.

The working transcript only exists in the browser tab (``static/app.js``), so a
voice call (the Subtitle voice agent in Claude HQ) or a review job can't safely
edit the SRT on disk: the tab's next auto-save would quietly overwrite it, or it
would overwrite typing the tab hasn't saved yet. Instead:

* the tab publishes a compact copy of the open document here on every change;
* callers queue edits here; the tab picks them up on its poll, applies them
  through the same model path typing uses, and reports applied/rejected;
* every text edit carries the cue text the caller saw (looked up from the
  revision it read), and the tab rejects it if that cue has changed since,
  so the keyboard always wins.

Everything is in memory. Nothing in this module touches disk; the tab's normal
auto-save is still the only writer of the SRT.
"""

import itertools
import threading
import time
from collections import OrderedDict

# A tab that hasn't polled for this long is treated as gone. Generous because
# browsers throttle timers in background tabs to roughly once a minute.
TAB_TIMEOUT_S = 90
HISTORY_REVS = 60
MAX_WAIT_S = 8

TEXT_OPS = ('replace', 'set')
# 'review' brackets a review job's edits (start/end) so the tab can snapshot
# for Undo all and run its style check afterwards. No text guard.
ALL_OPS = TEXT_OPS + ('focus', 'speaker', 'undo', 'review')


class LiveLink:
    def __init__(self):
        self._cv = threading.Condition()
        self._ids = itertools.count(1)
        self._doc = None              # latest snapshot from the active tab
        self._tab = None              # id of the tab that published last
        self._last_poll = 0.0
        self._history = OrderedDict()  # rev -> {cue number: text}
        self._queue = []              # ops waiting for the tab
        self._results = {}            # op id -> result dict
        self._fixes = 0               # text edits applied since this file opened
        self._flags = []
        self._flags_version = 0

    # ── the tab side ──────────────────────────────────────────────────────

    def publish(self, body):
        tab = str(body.get('tab') or '')
        cues = [
            {
                'n': int(c.get('n', i + 1)),
                'start': str(c.get('start', '')),
                'end': str(c.get('end', '')),
                'text': str(c.get('text', '')),
                'unsure': [int(k) for k in (c.get('unsure') or []) if str(k).isdigit()],
            }
            for i, c in enumerate(body.get('cues') or [])
        ]
        doc = {
            'file': str(body.get('file') or ''),
            'path': str(body.get('path') or ''),
            'rev': int(body.get('rev') or 0),
            'view': str(body.get('view') or 'captions'),
            'focusCue': body.get('focusCue'),
            'speakers': body.get('speakers') or [],
            'cues': cues,
        }
        with self._cv:
            prev = self._doc
            switched = (
                prev is None
                or prev['file'] != doc['file']
                or prev['path'] != doc['path']
            )
            if switched or tab != self._tab:
                # A different file (or another tab took over): old edits and
                # flags were about something else.
                self._fail_queue('a different file is open now')
                self._history.clear()
            if switched:
                self._fixes = 0
                self._flags = []
                self._flags_version += 1
            self._tab = tab
            self._doc = doc
            self._last_poll = time.time()
            self._history[doc['rev']] = {c['n']: c['text'] for c in cues}
            while len(self._history) > HISTORY_REVS:
                self._history.popitem(last=False)
            self._cv.notify_all()

    def close(self, tab):
        with self._cv:
            if tab and tab == self._tab:
                self._doc = None
                self._tab = None
                self._history.clear()
                self._fail_queue('the editor tab was closed')
                self._cv.notify_all()

    def poll(self, tab, flags_version=None):
        with self._cv:
            if tab != self._tab:
                return {'active': False, 'ops': []}
            self._last_poll = time.time()
            ops, self._queue = self._queue, []
            out = {'active': True, 'ops': ops}
            if flags_version != self._flags_version:
                out['flags'] = {'version': self._flags_version, 'items': self._open_flags()}
            return out

    def report(self, tab, results):
        with self._cv:
            for r in results or []:
                rid = int(r.get('id') or 0)
                if not rid:
                    continue
                res = {
                    'id': rid,
                    'ok': bool(r.get('ok')),
                    'op': str(r.get('op') or ''),
                }
                for k in ('reason', 'cue', 'text', 'was'):
                    if r.get(k) is not None:
                        res[k] = r[k]
                self._results[rid] = res
                if res['ok'] and res['op'] in TEXT_OPS:
                    self._fixes += 1
                if res['ok'] and r.get('flag'):
                    self._set_flag_status(int(r['flag']), 'fixed')
                if res['ok'] and res['op'] == 'undo':
                    self._fixes = max(0, self._fixes - 1)
            while len(self._results) > 500:
                self._results.pop(next(iter(self._results)))
            self._cv.notify_all()

    # ── the caller side (voice call, review job, curl) ────────────────────

    def is_open(self):
        return (
            self._doc is not None
            and time.time() - self._last_poll < TAB_TIMEOUT_S
        )

    def has_pending(self):
        """Edits are queued that the tab hasn't collected yet."""
        with self._cv:
            return bool(self._queue)

    def closed_reply(self):
        return {'open': False, 'reason': 'No transcript is open in the Subtitle editor.'}

    def doc(self, start=None, end=None, around=None):
        with self._cv:
            if not self.is_open():
                return self.closed_reply()
            d = self._doc
            cues = d['cues']
            if around is not None:
                start, end = around - 5, around + 5
            if start is not None or end is not None:
                lo = start if start is not None else 1
                hi = end if end is not None else len(cues)
                cues = [c for c in cues if lo <= c['n'] <= hi]
            return {
                'open': True,
                'file': d['file'],
                'rev': d['rev'],
                'view': d['view'],
                'focusCue': d['focusCue'],
                'cueCount': len(d['cues']),
                'speakers': d['speakers'],
                'fixes': self._fixes,
                'openFlags': len(self._open_flags()),
                'cues': cues,
            }

    def find(self, q):
        with self._cv:
            if not self.is_open():
                return self.closed_reply()
            needle = (q or '').strip().lower()
            hits = [c for c in self._doc['cues'] if needle and needle in c['text'].lower()]
            return {'open': True, 'rev': self._doc['rev'], 'count': len(hits), 'cues': hits[:50]}

    def submit(self, ops, rev=None, wait=4.0):
        """Queue ops for the tab and wait (briefly) for its verdicts."""
        with self._cv:
            if not self.is_open():
                return self.closed_reply()
            if rev is None:
                rev = self._doc['rev']
            seen = self._history.get(int(rev))
            queued, results = [], []
            for raw in ops:
                op = str(raw.get('op') or ('set' if 'text' in raw else 'replace'))
                if op not in ALL_OPS:
                    results.append({'ok': False, 'op': op, 'reason': f'unknown op {op!r}'})
                    continue
                item = {'id': next(self._ids), 'op': op}
                for k in ('cue', 'find', 'replace', 'text', 'speaker', 'name', 'flag', 'note',
                          'phase', 'summary', 'job', 'count'):
                    if raw.get(k) is not None:
                        item[k] = raw[k]
                if op in TEXT_OPS:
                    try:
                        item['cue'] = int(item.get('cue'))
                    except (TypeError, ValueError):
                        results.append({'ok': False, 'op': op, 'reason': 'which line? (cue number missing)'})
                        continue
                    if seen is None:
                        results.append({
                            'ok': False, 'op': op, 'cue': item['cue'],
                            'reason': 'stale: that version of the transcript is gone, read it again',
                        })
                        continue
                    if item['cue'] not in seen:
                        results.append({'ok': False, 'op': op, 'cue': item['cue'], 'reason': 'no such line'})
                        continue
                    # The guard: the tab only applies this if the line still
                    # says what the caller read.
                    item['expect'] = seen[item['cue']]
                queued.append(item)
            self._queue.extend(queued)
            self._cv.notify_all()

            ids = [q['id'] for q in queued]
            deadline = time.time() + max(0.0, min(float(wait), MAX_WAIT_S))
            while ids and not all(i in self._results for i in ids):
                left = deadline - time.time()
                if left <= 0:
                    break
                self._cv.wait(left)
            for i in ids:
                results.append(self._results.get(i) or {'id': i, 'ok': None, 'pending': True})
            return {'open': True, 'rev': self._doc['rev'] if self._doc else None, 'results': results}

    # ── flags (the AI review's suggestions; the call walks Ben through them) ──

    def _open_flags(self):
        return [f for f in self._flags if f['status'] == 'open']

    def _set_flag_status(self, fid, status):
        for f in self._flags:
            if f['id'] == fid and f['status'] != status:
                f['status'] = status
                self._flags_version += 1

    def flags(self, include_all=False):
        with self._cv:
            if not self.is_open():
                return self.closed_reply()
            items = self._flags if include_all else self._open_flags()
            return {'open': True, 'version': self._flags_version, 'flags': items}

    def set_flags(self, items, replace=True):
        with self._cv:
            if not self.is_open():
                return self.closed_reply()
            if replace:
                self._flags = []
            for raw in items or []:
                try:
                    cue = int(raw.get('cue'))
                except (TypeError, ValueError):
                    continue
                word = str(raw.get('word') or '').strip()
                if not word:
                    continue
                self._flags.append({
                    'id': next(self._ids),
                    'cue': cue,
                    'word': word,
                    'suggestion': str(raw.get('suggestion') or '').strip(),
                    'why': str(raw.get('why') or '').strip(),
                    'status': 'open',
                })
            self._flags.sort(key=lambda f: (f['cue'], f['id']))
            self._flags_version += 1
            self._cv.notify_all()
            return {'open': True, 'version': self._flags_version, 'flags': self._open_flags()}

    def resolve_flag(self, fid, status):
        if status not in ('fixed', 'skipped', 'open'):
            return {'error': 'status must be fixed, skipped or open'}
        with self._cv:
            self._set_flag_status(int(fid), status)
            return {'ok': True, 'version': self._flags_version, 'openFlags': len(self._open_flags())}

    # ── the one-glance strip for Claude HQ's middle column ────────────────

    def strip(self):
        with self._cv:
            if not self.is_open():
                return {'lines': ['Subtitle · no transcript open']}
            d = self._doc
            if not d['cues']:
                return {'lines': ['Subtitle · no transcript open']}
            first = d['file'] or 'untitled'
            if d['focusCue']:
                first += f" · line {d['focusCue']} of {len(d['cues'])}"
            else:
                first += f" · {len(d['cues'])} lines"
            bits = []
            if self._fixes:
                bits.append(f"{self._fixes} fix{'es' if self._fixes != 1 else ''}")
            n_flags = len(self._open_flags())
            if n_flags:
                bits.append(f"{n_flags} flag{'s' if n_flags != 1 else ''} to go")
            return {'lines': [first] + ([' · '.join(bits)] if bits else [])}

    # ── internals ─────────────────────────────────────────────────────────

    def _fail_queue(self, reason):
        for q in self._queue:
            self._results[q['id']] = {'id': q['id'], 'ok': False, 'op': q['op'], 'reason': reason}
        self._queue = []


link = LiveLink()
