/* ═══════════════════════════════════════════════════════════════════════
   Subtitle Editor — script-flow view with word-level timing
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let cues           = [];
let fileName       = 'subtitles.srt';
let resolveOk      = false;
let maxChars       = 42;
let autoFormatMode = 'two_line';

// Hold a cue through silences up to this many seconds before letting it cut out
let pauseTolerance = parseFloat(localStorage.getItem('pauseTolerance')) || 2.0;

// Flat model — each word is {word, start, end, resolveId}
let allWords       = [];      // [{word:"hello", start:0.0, end:0.4, resolveId:null}, …]
let breakPositions = [];      // sorted indices into allWords where a new cue starts

// Drag
let dragState      = null;    // { breakIdx, sourceEl, min, max, currentTarget }

// Transcription
let transcribeJobId = null;
let transcribePollTimer = null;
let sourceFilePath = null;  // original media file path (for auto-saving SRT next to it)
let srtVersion     = 0;     // incremented each time user clicks "Save new version"

// ── DOM refs ───────────────────────────────────────────────────────────
const btnBrowse        = document.getElementById('btn-browse');
const btnBrowseEmpty   = document.getElementById('btn-browse-empty');
const fileNameDisplay  = document.getElementById('file-name-display');
const modelTag         = document.getElementById('model-tag');
const btnSave          = document.getElementById('btn-save');
const btnSaveAs        = document.getElementById('btn-save-as');
const btnAutoFormatToggle = document.getElementById('btn-auto-format-toggle');
const btnAutoFormat    = document.getElementById('btn-auto-format');
const formatPopover    = document.getElementById('format-popover');
const btnOverflow      = document.getElementById('btn-overflow');
const overflowMenu     = document.getElementById('overflow-menu');
const btnReadResolve   = document.getElementById('btn-read-resolve');
const btnPushResolve   = document.getElementById('btn-push-resolve');
const maxCharsInput    = document.getElementById('max-chars');
const formatModeSelect = document.getElementById('format-mode');
const pauseToleranceInput = document.getElementById('pause-tolerance');
const resolvePill      = document.getElementById('resolve-pill');
const resolveLabel     = document.getElementById('resolve-label');
const container        = document.getElementById('cue-list-container');
const emptyState       = document.getElementById('empty-state');
const statusMsg        = document.getElementById('status-msg');
const cueCountEl       = document.getElementById('cue-count');
const modalOverlay     = document.getElementById('modal-overlay');
const saveAsInput      = document.getElementById('save-as-input');
const btnModalCancel   = document.getElementById('btn-modal-cancel');
const btnModalSave     = document.getElementById('btn-modal-save');

// Transcription DOM refs
const transcribePath   = document.getElementById('transcribe-path');
const btnBrowseMedia   = document.getElementById('btn-browse-media');
const btnTranscribe    = document.getElementById('btn-transcribe');
const transcribeModel  = document.getElementById('transcribe-model');
const transcribeBar    = document.getElementById('transcribe-progress');
const transcribeFill   = document.getElementById('transcribe-progress-fill');

// Restore the user's last-used model from localStorage (default: large-v2).
const savedModel = localStorage.getItem('whisperModel');
if (savedModel && transcribeModel) {
  // Only restore if the option exists in the dropdown
  if ([...transcribeModel.options].some(o => o.value === savedModel)) {
    transcribeModel.value = savedModel;
  }
}
if (transcribeModel) {
  transcribeModel.addEventListener('change', () => {
    localStorage.setItem('whisperModel', transcribeModel.value);
  });
}

// Words below this Whisper-reported probability get an amber underline.
// 0.5 hits the sweet spot — flags genuinely uncertain words without
// underlining most of the transcript.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// ── Spell check ────────────────────────────────────────────────────────
// Hunspell dictionaries via typo.js (static/vendor/). Checked against both
// Australian and US English — Whisper itself tends to emit US spellings —
// and a word is only flagged when it fails both.
let spellDicts = null;          // [Typo, ...] once dictionaries are parsed
const spellCache = new Map();   // normalised word -> is misspelled

async function loadSpellcheck() {
  try {
    const load = async (name) => {
      const [aff, dic] = await Promise.all([
        fetch(`/static/vendor/dict/${name}.aff`).then(r => r.text()),
        fetch(`/static/vendor/dict/${name}.dic`).then(r => r.text()),
      ]);
      return new Typo(name, aff, dic);
    };
    spellDicts = await Promise.all([load('en_AU'), load('en_US')]);
    refreshSpellcheck();  // transcript may already be on screen
  } catch (e) {
    console.warn('Spell check unavailable:', e);
  }
}

function isMisspelled(rawWord) {
  if (!spellDicts) return false;
  // Normalise curly apostrophes, strip surrounding punctuation
  const word = rawWord
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  if (!word || /\p{N}/u.test(word)) return false;          // numbers, "3rd"
  if (word.length > 1 && word === word.toUpperCase()) return false;  // acronyms
  if (spellCache.has(word)) return spellCache.get(word);
  const inDict = (w) => spellDicts.some(d => d.check(w));
  // Hyphenated compounds pass if every part passes; possessives pass if the
  // base word does ("Resolve's").
  const bad = word.split('-').filter(Boolean).some(part =>
    !inDict(part) && !(part.endsWith("'s") && inDict(part.slice(0, -2)))
  );
  spellCache.set(word, bad);
  return bad;
}

// Re-run spell check over the rendered spans without a full re-render
// (used when dictionaries finish loading after first paint).
function refreshSpellcheck() {
  document.querySelectorAll('#script-view .word').forEach(span => {
    span.classList.toggle('misspelled', isMisspelled(span.textContent));
  });
}

loadSpellcheck();

// ── Toast ──────────────────────────────────────────────────────────────
const toastContainer = (() => {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
  return el;
})();
function toast(msg, type = 'info', dur = 3000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), dur);
}
function setStatus(msg) { statusMsg.textContent = msg; }

// ── API helper ─────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return (await fetch(path, opts)).json();
}

// ═══════════════════════════════════════════════════════════════════════
// FLAT MODEL — convert between cues[] and allWords[]+breakPositions[]
// ═══════════════════════════════════════════════════════════════════════

function buildFlatModel() {
  allWords = [];
  breakPositions = [];

  cues.forEach((cue, i) => {
    const words = cue.text.replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
    const cueStartMs = timeToMs(cue.startTime);
    const cueEndMs   = timeToMs(cue.endTime);
    const cueDur     = cueEndMs - cueStartMs;
    const totalChars = words.reduce((s, w) => s + w.length, 0) || 1;
    let charAcc = 0;

    words.forEach(w => {
      const wStart = cueStartMs + (cueDur * charAcc / totalChars);
      charAcc += w.length;
      const wEnd = cueStartMs + (cueDur * charAcc / totalChars);
      allWords.push({
        word: w,
        start: wStart / 1000,
        end: wEnd / 1000,
        probability: null,  // unknown — came from an SRT, not a fresh transcription
        resolveId: cue.resolveId || null,
      });
    });

    if (i < cues.length - 1) breakPositions.push(allWords.length);
  });
}

function flatModelToCues() {
  const cuts = [0, ...breakPositions, allWords.length];
  const groups = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const g = allWords.slice(cuts[i], cuts[i + 1]);
    if (g.length) groups.push(g);
  }

  const out = groups.map(groupWords => ({
    text:  groupWords.map(w => w.word).join(' '),
    start: groupWords[0].start,
    end:   groupWords[groupWords.length - 1].end,
  }));

  // Always keep the current cue on as long as possible:
  //   • Short pause (0 < gap ≤ pauseTolerance) → extend current's end to next's start.
  //   • Overlap (gap < 0, common with Whisper's imprecise word timings) → push next's
  //     start back to current's end, so the next caption doesn't pop in early and
  //     visually cut the current one short.
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i];
    const nxt = out[i + 1];
    const gap = nxt.start - cur.end;
    if (gap < 0) {
      nxt.start = cur.end;
    } else if (gap > 0 && gap <= pauseTolerance) {
      cur.end = nxt.start;
    }
  }

  return out.map((g, i) => ({
    index: i + 1,
    startTime: msToTime(Math.round(g.start * 1000)),
    endTime:   msToTime(Math.round(g.end   * 1000)),
    text: g.text,
  }));
}

// ═══════════════════════════════════════════════════════════════════════
// LOAD FROM WHISPER TRANSCRIPTION
// ═══════════════════════════════════════════════════════════════════════

function loadTranscriptionWords(words) {
  // Set allWords directly from Whisper output
  allWords = words.map(w => ({
    word: w.word,
    start: w.start,
    end: w.end,
    probability: typeof w.probability === 'number' ? w.probability : null,
    resolveId: null,
  }));

  // Compute initial break positions based on pauses and max line length
  breakPositions = computeInitialBreaks(allWords);

  // Build cues from the flat model
  cues = flatModelToCues();
  render();
}

function computeInitialBreaks(words) {
  if (words.length <= 1) return [];

  const breaks = [];
  let groupStart = 0;
  let groupChars = 0;

  for (let i = 0; i < words.length; i++) {
    groupChars += words[i].word.length + (i > groupStart ? 1 : 0); // +1 for space

    const atEnd = i === words.length - 1;
    if (atEnd) continue;

    const gap = words[i + 1].start - words[i].end;
    const isPause = gap >= 0.5;
    const isTooLong = groupChars > maxChars;
    const isPunct = /[.!?;]$/.test(words[i].word);
    const isComma = /,$/.test(words[i].word);

    // Break on: significant pause, line too long, or sentence-ending punctuation
    if (isPause || isTooLong || (isPunct && groupChars > 15)) {
      breaks.push(i + 1);
      groupStart = i + 1;
      groupChars = 0;
    } else if (isComma && groupChars > 30) {
      // Break on comma if line is getting long
      breaks.push(i + 1);
      groupStart = i + 1;
      groupChars = 0;
    }
  }

  return breaks;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════

function render() {
  // If we don't have word-level data yet, build from cues
  if (!allWords.length && cues.length) {
    buildFlatModel();
  }

  const old = document.getElementById('script-view');
  if (old) old.remove();

  // Toggle loaded/empty UI based on whether we have content
  document.body.classList.toggle('app-loaded', !!allWords.length);

  cueCountEl.textContent       = cues.length ? `${cues.length} cues` : '';
  btnSave.disabled             = !cues.length;
  btnSaveAs.disabled           = !cues.length;
  btnAutoFormatToggle.disabled = !cues.length;
  btnAutoFormat.disabled       = !cues.length;
  btnReadResolve.disabled      = !resolveOk;
  btnPushResolve.disabled      = !cues.length;

  if (!allWords.length) return;

  const view = document.createElement('div');
  view.id = 'script-view';
  view.className = 'script-flow';
  view.contentEditable = 'true';
  view.spellcheck = false;

  let breakIdx = 0;

  allWords.forEach((wordObj, idx) => {
    // Insert break marker before this word if it's a break position
    if (breakIdx < breakPositions.length && breakPositions[breakIdx] === idx) {
      view.appendChild(createBreakMarker(breakIdx, idx));
      breakIdx++;
    } else if (idx > 0) {
      view.appendChild(document.createTextNode(' '));
    }

    const span = document.createElement('span');
    span.className = 'word';
    // Flag low-confidence words so the human reviewer can scan for paraphrases.
    // Skip the flag when probability is null (word didn't come from a fresh
    // Whisper run — e.g. loaded from SRT or typed by the user).
    if (
      typeof wordObj.probability === 'number'
      && wordObj.probability < LOW_CONFIDENCE_THRESHOLD
    ) {
      span.classList.add('low-confidence');
      span.title = `Whisper confidence: ${Math.round(wordObj.probability * 100)}%`;
    }
    if (isMisspelled(wordObj.word)) {
      span.classList.add('misspelled');
    }
    span.textContent = wordObj.word;
    span.dataset.idx = idx;
    view.appendChild(span);
  });

  // Live editing — reconcile model from DOM after typing settles
  view.addEventListener('input', onContentEdit);
  view.addEventListener('keydown', onContentKeyDown);
  view.addEventListener('blur', () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileFromDOM();
  });

  container.appendChild(view);
}

function createBreakMarker(breakIdx, wordIdx) {
  const marker = document.createElement('span');
  marker.className = 'cue-break';
  marker.dataset.breakIdx = breakIdx;
  marker.contentEditable = 'false';
  // contenteditable=false inside a contenteditable=true root is HTML5-draggable
  // by default — that hijacks our mousemove-based custom drag. Kill it.
  marker.setAttribute('draggable', 'false');
  marker.addEventListener('dragstart', (e) => e.preventDefault());

  // Tooltip label — show cue number and time from the word at this break
  const label = document.createElement('span');
  label.className = 'break-label';
  const breakWord = allWords[wordIdx];
  const timeStr = shortTime(msToTime(Math.round(breakWord.start * 1000)));
  label.textContent = `${breakIdx + 1} | ${timeStr}`;
  marker.appendChild(label);

  // Drag
  marker.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startDrag(breakIdx, marker);
  });

  // Double-click → remove break (merge cues)
  marker.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeBreak(breakIdx);
  });

  return marker;
}

// ═══════════════════════════════════════════════════════════════════════
// DRAG — move a break marker between word gaps
// ═══════════════════════════════════════════════════════════════════════

function startDrag(breakIdx, sourceEl) {
  // Flush any pending text-edit reconcile so word data-idx values are current
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileFromDOM();
  }
  const prevBreak = breakIdx > 0 ? breakPositions[breakIdx - 1] : 0;
  const nextBreak = breakIdx < breakPositions.length - 1
    ? breakPositions[breakIdx + 1] : allWords.length;

  dragState = {
    breakIdx,
    sourceEl,
    min: prevBreak + 1,
    max: nextBreak,
    currentTarget: null,
  };

  sourceEl.classList.add('dragging-source');
  document.body.classList.add('is-dragging');
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;

  const prev = document.querySelector('.drop-target-before');
  if (prev) prev.classList.remove('drop-target-before');

  const target = findNearestGap(e.clientX, e.clientY);
  if (target === null) return;

  const clamped = Math.max(dragState.min, Math.min(dragState.max - 1, target));
  dragState.currentTarget = clamped;

  const wordEl = document.querySelector(`.script-flow .word[data-idx="${clamped}"]`);
  if (wordEl) wordEl.classList.add('drop-target-before');
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  if (!dragState) return;

  const { breakIdx, sourceEl, currentTarget } = dragState;

  sourceEl.classList.remove('dragging-source');
  document.body.classList.remove('is-dragging');
  const ind = document.querySelector('.drop-target-before');
  if (ind) ind.classList.remove('drop-target-before');

  if (currentTarget !== null && currentTarget !== breakPositions[breakIdx]) {
    breakPositions[breakIdx] = currentTarget;
    breakPositions.sort((a, b) => a - b);
    cues = flatModelToCues();
    render();
    setStatus('Break moved.');
    autoSaveSRT(true);
  }

  dragState = null;
}

function findNearestGap(cx, cy) {
  const wordEls = document.querySelectorAll('.script-flow .word');
  let best = null;
  let bestDist = Infinity;

  wordEls.forEach(el => {
    const rect = el.getBoundingClientRect();
    const idx = parseInt(el.dataset.idx);
    const dx = cx - rect.left;
    const dy = cy - (rect.top + rect.height / 2);
    const dist = Math.abs(dx) + Math.abs(dy) * 0.5;

    if (dist < bestDist) {
      bestDist = dist;
      best = idx;
    }
  });

  return best;
}

// ═══════════════════════════════════════════════════════════════════════
// INLINE TEXT EDITING — contenteditable, debounced reconcile, LCS diff
// ═══════════════════════════════════════════════════════════════════════

let reconcileTimer = null;
const RECONCILE_DELAY_MS = 350;

function onContentEdit() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcileFromDOM, RECONCILE_DELAY_MS);
}

function onContentKeyDown(e) {
  if (e.key === 'Enter') {
    // Enter inserts a break at the caret position
    e.preventDefault();
    insertBreakAtCaret();
  }
}

function createBreakMarkerStub() {
  // Used when inserting a break mid-edit; reconcile re-renders with full handlers
  const marker = document.createElement('span');
  marker.className = 'cue-break';
  marker.contentEditable = 'false';
  marker.setAttribute('draggable', 'false');
  const label = document.createElement('span');
  label.className = 'break-label';
  marker.appendChild(label);
  return marker;
}

function insertBreakAtCaret() {
  const view = document.getElementById('script-view');
  if (!view) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!view.contains(range.startContainer)) return;

  const marker = createBreakMarkerStub();
  range.deleteContents();
  range.insertNode(marker);
  // Place caret immediately after the marker
  range.setStartAfter(marker);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileFromDOM();
}

// ── DOM → tokens + break positions ──────────────────────────────────────
function tokenizeFromDOM(rootEl) {
  const tokens = [];
  const breaks = [];
  let buffer = '';

  function flush() {
    const parts = buffer.split(/\s+/).filter(Boolean);
    tokens.push(...parts);
    buffer = '';
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.nodeValue;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains('cue-break')) {
        flush();
        breaks.push(tokens.length);
      } else {
        for (const child of node.childNodes) walk(child);
      }
    }
  }
  walk(rootEl);
  flush();
  return { tokens, breaks };
}

// ── Caret offset in plain-text equivalent (skipping break markers) ──────
function isInBreak(node, root) {
  let cur = node;
  while (cur && cur !== root) {
    if (cur.classList && cur.classList.contains('cue-break')) return true;
    cur = cur.parentNode;
  }
  return false;
}

function saveCaret(rootEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!rootEl.contains(range.startContainer)) return null;

  let offset = 0;
  let found = false;

  function walk(node) {
    if (found) return;
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!isInBreak(node, rootEl)) offset += range.startOffset;
      } else {
        for (let i = 0; i < range.startOffset && i < node.childNodes.length; i++) {
          walk(node.childNodes[i]);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (!isInBreak(node, rootEl)) offset += node.nodeValue.length;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains('cue-break')) return;
      for (const child of node.childNodes) {
        walk(child);
        if (found) return;
      }
    }
  }
  walk(rootEl);
  return found ? offset : null;
}

function restoreCaret(rootEl, offset) {
  if (offset == null || !rootEl) return;
  let remaining = offset;
  let placed = false;

  function walk(node) {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue.length;
      if (remaining <= len) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        placed = true;
      } else {
        remaining -= len;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && node.classList.contains('cue-break')) return;
      for (const child of node.childNodes) {
        walk(child);
        if (placed) return;
      }
    }
  }
  walk(rootEl);

  if (!placed) {
    rootEl.focus();
    const range = document.createRange();
    range.selectNodeContents(rootEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ── LCS diff between old word strings and new tokens ────────────────────
function lcsDiff(oldArr, newArr) {
  const m = oldArr.length, n = newArr.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldArr[i] === newArr[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldArr[i] === newArr[j]) {
      ops.push({ type: 'keep', oldIdx: i, newIdx: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', oldIdx: i });
      i++;
    } else {
      ops.push({ type: 'insert', newIdx: j });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'delete', oldIdx: i++ });
  while (j < n) ops.push({ type: 'insert', newIdx: j++ });
  return ops;
}

// Rebuild allWords from old words + new tokens, preserving timing/resolveId
// for kept words, carrying it across in-place replacements (typo fixes),
// and interpolating timing for inserts.
function reconcileWords(oldWords, newTokens) {
  const oldStrings = oldWords.map(w => w.word);
  const ops = lcsDiff(oldStrings, newTokens);

  // Coalesce adjacent delete+insert (or insert+delete) into in-place 'replace'
  for (let k = 0; k < ops.length - 1; k++) {
    const a = ops[k], b = ops[k + 1];
    if (a.type === 'delete' && b.type === 'insert') {
      ops[k] = { type: 'replace', oldIdx: a.oldIdx, newIdx: b.newIdx };
      ops.splice(k + 1, 1);
    } else if (a.type === 'insert' && b.type === 'delete') {
      ops[k] = { type: 'replace', oldIdx: b.oldIdx, newIdx: a.newIdx };
      ops.splice(k + 1, 1);
    }
  }

  const result = [];
  for (const op of ops) {
    if (op.type === 'keep') {
      result.push({ ...oldWords[op.oldIdx] });
    } else if (op.type === 'replace') {
      // User edited a word — they've effectively vouched for it, so clear
      // the low-confidence flag (probability: null) but carry over timing.
      const orig = oldWords[op.oldIdx];
      result.push({
        word: newTokens[op.newIdx],
        start: orig.start,
        end: orig.end,
        probability: null,
        resolveId: orig.resolveId,
      });
    } else if (op.type === 'insert') {
      result.push({
        word: newTokens[op.newIdx],
        start: null,
        end: null,
        probability: null,
        resolveId: null,
      });
    }
    // 'delete' contributes nothing
  }

  // Interpolate timing for runs of inserted (untimed) words
  let i = 0;
  while (i < result.length) {
    if (result[i].start == null) {
      let runEnd = i;
      while (runEnd < result.length && result[runEnd].start == null) runEnd++;
      let prevEnd = 0;
      for (let p = i - 1; p >= 0; p--) {
        if (result[p].end != null) { prevEnd = result[p].end; break; }
      }
      let nextStart = null;
      for (let q = runEnd; q < result.length; q++) {
        if (result[q].start != null) { nextStart = result[q].start; break; }
      }
      const count = runEnd - i;
      const slot = nextStart != null
        ? Math.max(0.05, (nextStart - prevEnd) / count)
        : 0.3;
      for (let q = i; q < runEnd; q++) {
        result[q].start = prevEnd + (q - i) * slot;
        result[q].end = prevEnd + (q - i + 1) * slot;
      }
      i = runEnd;
    } else {
      i++;
    }
  }

  return result;
}

function reconcileFromDOM() {
  reconcileTimer = null;
  const view = document.getElementById('script-view');
  if (!view) return;

  const caretOffset = saveCaret(view);
  const { tokens, breaks } = tokenizeFromDOM(view);

  // Detect no-op so we don't churn re-renders on cosmetic DOM changes
  const oldText = allWords.map(w => w.word).join(' ');
  const newText = tokens.join(' ');
  const oldBreaksKey = breakPositions.join(',');
  const newBreaksKey = breaks.filter(b => b > 0 && b < tokens.length).join(',');
  if (oldText === newText && oldBreaksKey === newBreaksKey) return;

  if (!tokens.length) {
    allWords = [];
    breakPositions = [];
    cues = [];
    render();
    setStatus('All text removed.');
    autoSaveSRT(true);
    return;
  }

  allWords = reconcileWords(allWords, tokens);
  breakPositions = [...new Set(breaks)]
    .filter(b => b > 0 && b < allWords.length)
    .sort((a, b) => a - b);
  cues = flatModelToCues();
  render();
  restoreCaret(document.getElementById('script-view'), caretOffset);
  setStatus('Edited.');
  autoSaveSRT(true);
}

// ═══════════════════════════════════════════════════════════════════════
// REMOVE BREAK
// ═══════════════════════════════════════════════════════════════════════

function removeBreak(breakIdx) {
  if (breakPositions.length <= 0) return;
  breakPositions.splice(breakIdx, 1);
  cues = flatModelToCues();
  render();
  toast('Break removed (cues merged).', 'success');
  setStatus('Cues merged.');
  autoSaveSRT(true);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function shortTime(t) {
  const p = t.split(',')[0].split(':');
  const h = +p[0], m = +p[1], s = +p[2];
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function timeToMs(t) {
  const [h, m, rest] = t.split(':');
  const [s, ms] = rest.split(',');
  return +h * 3_600_000 + +m * 60_000 + +s * 1_000 + +ms;
}
function msToTime(ms) {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3_600_000); ms %= 3_600_000;
  const m = Math.floor(ms / 60_000);    ms %= 60_000;
  const s = Math.floor(ms / 1_000);     ms %= 1_000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function serializeSRT(list) {
  return list.map((c, i) =>
    `${i + 1}\n${c.startTime} --> ${c.endTime}\n${c.text}`
  ).join('\n\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// DAVINCI RESOLVE
// ═══════════════════════════════════════════════════════════════════════

function updateResolvePill(st) {
  resolvePill.className = 'pill';
  if (st.connected) {
    resolvePill.classList.add('pill-ok');
    resolveLabel.textContent = `Resolve ${st.version || ''}`.trim();
    resolveOk = true;
  } else {
    resolvePill.classList.add(st.error ? 'pill-error' : 'pill-idle');
    resolveLabel.textContent = 'DaVinci Resolve';
    resolveOk = false;
    if (st.error) resolvePill.title = st.error;
  }
  btnReadResolve.disabled = !resolveOk;
  // Reflect connection state on the landing's "Read from Resolve" affordance
  const dot = document.querySelector('.resolve-dot');
  if (dot) dot.dataset.state = resolveOk ? 'ok' : (st.error ? 'error' : 'idle');
  const readEmpty = document.getElementById('btn-read-empty');
  if (readEmpty) readEmpty.dataset.resolve = resolveOk ? 'on' : 'off';
  // Don't touch btnPushResolve here — it's always available when cues exist
}

// Auto-polling disabled — it floods the Flask console with /api/resolve/connect
// requests every 5s, which makes it hard to read transcription logs. The pill
// still works on click (handler below), so connecting to Resolve is one click
// away when actually needed.
async function pollResolve() {
  try { updateResolvePill(await api('POST', '/api/resolve/connect')); }
  catch (e) { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════

// Settings
maxCharsInput.addEventListener('change', () => {
  maxChars = Math.max(10, Math.min(120, +maxCharsInput.value));
  maxCharsInput.value = maxChars;
});
formatModeSelect.addEventListener('change', () => { autoFormatMode = formatModeSelect.value; });

// Pause tolerance applies live — rebuild cues with the new value
if (pauseToleranceInput) {
  pauseToleranceInput.value = pauseTolerance.toFixed(1);
  pauseToleranceInput.addEventListener('input', () => {
    const v = parseFloat(pauseToleranceInput.value);
    if (Number.isNaN(v)) return;
    pauseTolerance = Math.max(0, Math.min(10, v));
    localStorage.setItem('pauseTolerance', String(pauseTolerance));
    if (allWords.length) {
      cues = flatModelToCues();
      autoSaveSRT(true);
    }
  });
}

// Resolve pill
resolvePill.addEventListener('click', async () => {
  resolvePill.className = 'pill pill-idle';
  resolveLabel.textContent = 'Connecting…';
  const r = await api('POST', '/api/resolve/connect');
  updateResolvePill(r);
  toast(r.connected ? `Connected to Resolve ${r.version}` : (r.error || 'Could not connect.'),
    r.connected ? 'success' : 'error', r.connected ? 3000 : 6000);
});

// Load SRT file via native dialog (gets full path for auto-save)
async function openSrtFromDisk() {
  try {
    const browse = await api('POST', '/api/browse-file', { mode: 'srt' });
    if (!browse.path) return;  // user cancelled

    setStatus('Loading…');
    const res = await api('POST', '/api/load-srt', { filePath: browse.path });
    if (res.error) { toast(res.error, 'error'); setStatus('Error.'); return; }

    cues = res.cues;
    fileName = browse.path.split(/[/\\]/).pop();
    // Strip extension so auto-save writes back to the same path
    sourceFilePath = browse.path.replace(/\.srt$/i, '');

    fileNameDisplay.textContent = fileName;
    fileNameDisplay.classList.add('loaded');
    if (modelTag) modelTag.textContent = '';  // SRT load — no Whisper model involved
    allWords = [];
    srtVersion = 0;
    render();
    setStatus(`Loaded ${res.count} cues from ${fileName}`);
    toast(`Loaded ${res.count} cues. Auto-save active.`, 'success');
  } catch (err) { toast('Failed to load file.', 'error'); setStatus('Error.'); }
}
btnBrowse.addEventListener('click', openSrtFromDisk);
if (btnBrowseEmpty) btnBrowseEmpty.addEventListener('click', openSrtFromDisk);

// Auto-format
btnAutoFormat.addEventListener('click', async () => {
  setStatus('Formatting…');
  formatPopover.classList.add('hidden');
  try {
    const res = await api('POST', '/api/format', { cues, maxChars, mode: autoFormatMode });
    if (res.error) { toast(res.error, 'error'); return; }
    cues = res.cues;
    allWords = [];  // rebuild
    render();
    toast('Auto-format applied.', 'success');
    setStatus('Formatted.');
  } catch (e) { toast('Formatting failed.', 'error'); }
});

// Popover toggles — auto-format settings, overflow menu
function setupPopover(toggleBtn, popoverEl) {
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popoverEl.classList.contains('hidden');
    document.querySelectorAll('.popover').forEach(p => p.classList.add('hidden'));
    if (open) popoverEl.classList.remove('hidden');
  });
}
setupPopover(btnAutoFormatToggle, formatPopover);
setupPopover(btnOverflow, overflowMenu);

document.addEventListener('click', (e) => {
  const clickedMenuItem = !!e.target.closest('.menu-item');
  document.querySelectorAll('.popover').forEach(p => {
    if (clickedMenuItem || !p.contains(e.target)) p.classList.add('hidden');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.popover').forEach(p => p.classList.add('hidden'));
  }
});

// Download SRT (clean, grouped)
btnSave.addEventListener('click', () => {
  const blob = new Blob([serializeSRT(cues)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('SRT downloaded.', 'success');
  setStatus(`Downloaded ${fileName}`);
});

// Export word-level SRT (for Resolve live mode import)
// Save to path
btnSaveAs.addEventListener('click', () => {
  saveAsInput.value = fileName || '';
  modalOverlay.classList.remove('hidden');
  saveAsInput.focus();
});
btnModalCancel.addEventListener('click', () => modalOverlay.classList.add('hidden'));
btnModalSave.addEventListener('click', async () => {
  const path = saveAsInput.value.trim();
  if (!path) { toast('Enter a file path.', 'warn'); return; }
  modalOverlay.classList.add('hidden');
  try {
    const res = await api('POST', '/api/save-srt', { filePath: path, cues });
    if (res.error) { toast(res.error, 'error'); return; }
    toast(`Saved to ${path}`, 'success');
    setStatus(`Saved to ${path}`);
  } catch (e) { toast('Save failed.', 'error'); }
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) modalOverlay.classList.add('hidden');
});
saveAsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnModalSave.click();
  if (e.key === 'Escape') btnModalCancel.click();
});

// Read from Resolve — shared by toolbar button and landing button
async function readFromResolve() {
  if (!resolveOk) {
    showResolveHelp();
    return;
  }
  setStatus('Reading from DaVinci Resolve…');
  try {
    const res = await api('GET', '/api/resolve/read');
    if (res.error) {
      toast(res.error, 'error');
      setStatus('Error.');
      return;
    }

    const readCues = res.cues.map((c, i) => ({ ...c, index: i + 1 }));

    if (!readCues.length) {
      toast('No subtitle items found in Resolve.', 'warn');
      setStatus('No items in Resolve.');
      return;
    }

    // Detect word-level track: most cues are single words
    const singleWordCues = readCues.filter(c => c.text.trim().split(/\s+/).length === 1);
    const isWordLevel = readCues.length > 10 && singleWordCues.length / readCues.length > 0.8;

    if (isWordLevel) {
      allWords = readCues.map(c => ({
        word: c.text.trim(),
        start: timeToMs(c.startTime) / 1000,
        end: timeToMs(c.endTime) / 1000,
        probability: null,  // from Resolve — no Whisper confidence
        resolveId: c.resolveId || null,
      }));
      breakPositions = computeInitialBreaks(allWords);
      cues = flatModelToCues();
      fileName = 'from-resolve.srt';
      fileNameDisplay.textContent = fileName;
      fileNameDisplay.classList.add('loaded');
      if (modelTag) modelTag.textContent = '';  // came from Resolve, not from Whisper
      render();
      toast(`Read ${allWords.length} words from Resolve (word-level track ${res.trackUsed}).`, 'success', 5000);
      setStatus(`Loaded ${allWords.length} words from Resolve — ${cues.length} cues.`);
    } else {
      cues = readCues;
      allWords = [];
      fileName = 'from-resolve.srt';
      fileNameDisplay.textContent = fileName;
      fileNameDisplay.classList.add('loaded');
      if (modelTag) modelTag.textContent = '';  // came from Resolve, not from Whisper
      render();
      toast(`Read ${cues.length} cues from Resolve (track ${res.trackUsed}).`, 'success');
      setStatus(`Loaded ${cues.length} cues from DaVinci Resolve.`);
    }
  } catch (e) { toast('Could not read from Resolve.', 'error'); }
}
btnReadResolve.addEventListener('click', readFromResolve);

// Landing's Read from Resolve button — shows help if Resolve isn't connected
const btnReadEmpty = document.getElementById('btn-read-empty');
if (btnReadEmpty) btnReadEmpty.addEventListener('click', readFromResolve);

// Help modal
const resolveHelpOverlay = document.getElementById('resolve-help-overlay');
const btnHelpClose = document.getElementById('btn-help-close');
function showResolveHelp() {
  if (resolveHelpOverlay) resolveHelpOverlay.classList.remove('hidden');
}
function hideResolveHelp() {
  if (resolveHelpOverlay) resolveHelpOverlay.classList.add('hidden');
}
if (btnHelpClose) btnHelpClose.addEventListener('click', hideResolveHelp);
if (resolveHelpOverlay) {
  resolveHelpOverlay.addEventListener('click', (e) => {
    if (e.target === resolveHelpOverlay) hideResolveHelp();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && resolveHelpOverlay && !resolveHelpOverlay.classList.contains('hidden')) {
    hideResolveHelp();
  }
});

// Save new version — creates a versioned SRT for clean Resolve import
btnPushResolve.addEventListener('click', async () => {
  if (!cues.length) return;

  if (sourceFilePath) {
    srtVersion++;
    const baseName = sourceFilePath.replace(/\.[^.]+$/, '');
    const versionedPath = `${baseName}_v${srtVersion}.srt`;
    try {
      const res = await api('POST', '/api/save-srt', { filePath: versionedPath, cues });
      if (res.error) { toast(res.error, 'error'); srtVersion--; return; }
      toast(`Saved ${versionedPath} — drag into Resolve.`, 'success', 5000);
      setStatus(`Saved → ${versionedPath}`);
    } catch (e) { toast('Save failed.', 'error'); srtVersion--; }
  } else {
    // No source path — trigger versioned download
    srtVersion++;
    const dlName = fileName.replace(/\.srt$/i, '') + `_v${srtVersion}.srt`;
    const blob = new Blob([serializeSRT(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = dlName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Downloaded ${dlName} — drag into Resolve.`, 'success', 5000);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TRANSCRIPTION
// ═══════════════════════════════════════════════════════════════════════

// Browse for media file (opens native Windows file dialog)
btnBrowseMedia.addEventListener('click', async () => {
  btnBrowseMedia.disabled = true;
  try {
    const res = await api('POST', '/api/browse-file', { mode: 'media' });
    if (res.path) {
      transcribePath.value = res.path;
      transcribePath.focus();
    }
  } catch (e) { toast('Could not open file dialog.', 'error'); }
  btnBrowseMedia.disabled = false;
});

btnTranscribe.addEventListener('click', async () => {
  const filePath = transcribePath.value.trim();
  if (!filePath) {
    toast('Enter a file path to transcribe.', 'warn');
    transcribePath.focus();
    return;
  }

  btnTranscribe.disabled = true;
  btnTranscribe.textContent = 'Starting…';
  setStatus('Starting transcription…');

  try {
    const model = transcribeModel ? transcribeModel.value : null;
    const res = await api('POST', '/api/transcribe', { filePath, model });
    if (res.error) {
      toast(res.error, 'error', 5000);
      setStatus('Transcription failed to start.');
      btnTranscribe.disabled = false;
      btnTranscribe.textContent = 'Transcribe';
      return;
    }

    transcribeJobId = res.jobId;
    sourceFilePath = filePath;  // remember source for auto-save
    transcribeBar.classList.remove('hidden');
    transcribeFill.style.width = '0%';
    btnTranscribe.textContent = 'Transcribing…';
    setStatus('Transcribing…');

    // Start polling
    transcribePollTimer = setInterval(pollTranscription, 1500);

  } catch (e) {
    toast('Could not start transcription.', 'error');
    btnTranscribe.disabled = false;
    btnTranscribe.textContent = 'Transcribe';
  }
});

async function pollTranscription() {
  if (!transcribeJobId) return;

  try {
    const job = await api('GET', `/api/transcribe/status?jobId=${transcribeJobId}`);

    if (job.error && !job.status) {
      // Job not found
      stopTranscriptionPolling();
      toast(job.error, 'error');
      return;
    }

    // Update progress bar. Before the first segment is processed, the worker
    // is still loading (or downloading, on first run) the model — say so
    // explicitly instead of misleadingly showing "Transcribing… 0%".
    const pct = Math.round((job.progress || 0) * 100);
    transcribeFill.style.width = pct + '%';
    if ((job.segments_done || 0) === 0 && pct === 0) {
      setStatus('Loading model… (first run may download ~3 GB)');
    } else {
      setStatus(`Transcribing… ${pct}%`);
    }

    if (job.status === 'complete') {
      stopTranscriptionPolling();

      if (job.words && job.words.length) {
        loadTranscriptionWords(job.words);
        fileName = (job.file || 'transcription').replace(/\.[^.]+$/, '') + '.srt';
        fileNameDisplay.textContent = job.file || 'Transcription';
        fileNameDisplay.classList.add('loaded');
        if (modelTag) modelTag.textContent = job.model || '';
        const modelSuffix = job.model ? ` · ${job.model}` : '';
        toast(`Transcribed ${job.words.length} words${modelSuffix}.`, 'success', 4000);
        setStatus(`Transcription complete — ${job.words.length} words, ${cues.length} cues${modelSuffix}.`);

        // Auto-save SRT next to source file if we have the path
        if (sourceFilePath) {
          autoSaveSRT();
        }
      } else {
        toast('Transcription produced no words.', 'warn');
        setStatus('Transcription complete but no words detected.');
      }
    }

    if (job.status === 'error') {
      stopTranscriptionPolling();
      toast(`Transcription error: ${job.error}`, 'error', 8000);
      setStatus('Transcription failed.');
    }

  } catch (e) {
    // Network error — keep polling
  }
}

async function autoSaveSRT(quiet = false) {
  if (!cues.length || !sourceFilePath) return;
  // Save SRT next to the source file (replace extension with .srt)
  const srtPath = sourceFilePath.replace(/\.[^.]+$/, '') + '.srt';
  try {
    const res = await api('POST', '/api/save-srt', { filePath: srtPath, cues });
    if (res.error) {
      if (!quiet) toast(`Auto-save failed: ${res.error}`, 'warn');
    } else {
      if (!quiet) toast(`SRT saved.`, 'success', 1500);
      setStatus(`Saved → ${srtPath}`);
    }
  } catch (e) { /* silent */ }
}

function stopTranscriptionPolling() {
  if (transcribePollTimer) {
    clearInterval(transcribePollTimer);
    transcribePollTimer = null;
  }
  transcribeJobId = null;
  transcribeBar.classList.add('hidden');
  btnTranscribe.disabled = false;
  btnTranscribe.textContent = 'Transcribe';
}
