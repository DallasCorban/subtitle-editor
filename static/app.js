/* ═══════════════════════════════════════════════════════════════════════
   Subtitle Editor — script-flow view with word-level timing
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let cues           = [];
let fileName       = 'subtitles.srt';
let resolveOk      = false;
let autoFormatMode = 'two_line';

// Aspect ratio → how many characters fit on one caption line before it
// wraps or shrinks. Wide frames give captions room; vertical crops don't.
const ASPECT_MAX_CHARS = { '16:9': 42, '1:1': 32, '4:5': 30, '9:16': 24 };
let aspectRatio = localStorage.getItem('aspectRatio') || '16:9';
if (aspectRatio !== 'custom' && !(aspectRatio in ASPECT_MAX_CHARS)) aspectRatio = '16:9';
let maxChars = parseInt(localStorage.getItem('maxChars'), 10)
  || ASPECT_MAX_CHARS[aspectRatio] || 42;

// Hold a cue through silences up to this many seconds before letting it cut out
let pauseTolerance = parseFloat(localStorage.getItem('pauseTolerance')) || 2.0;

// Which view is on screen: 'captions' (the SRT editor) or 'transcript'
// (speaker-separated prose for handing to someone else).
let viewMode = localStorage.getItem('viewMode') === 'transcript' ? 'transcript' : 'captions';
let showTimestamps = localStorage.getItem('showTimestamps') !== 'false';
let speakerNames = {};   // speaker id -> the name the user typed
let deepgramReady = false;

// Flat model — each word is {word, start, end, speaker, resolveId}
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

// Transcript view DOM refs
const viewCaptionsBtn   = document.getElementById('view-captions');
const viewTranscriptBtn = document.getElementById('view-transcript');
const btnExportTxt      = document.getElementById('btn-export-txt');
const showTimestampsInput = document.getElementById('show-timestamps');
const transcribeDiarize   = document.getElementById('transcribe-diarize');
const diarizeUnavailable  = document.getElementById('diarize-unavailable');

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
        speaker: null,      // an SRT has no speaker information
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
    // Only Deepgram fills this in; Whisper sends null.
    speaker: typeof w.speaker === 'number' ? w.speaker : null,
    resolveId: null,
  }));

  // Compute initial break positions based on pauses and max line length
  breakPositions = computeSmartBreaks(allWords, maxChars);

  // Build cues from the flat model
  cues = flatModelToCues();
  render();
}

// Words a cue shouldn't end on — articles, conjunctions, prepositions,
// auxiliaries, possessives. Ending a cue here splits a phrase mid-thought
// ("she went to the / shops" reads badly; "she went / to the shops" is fine).
const WEAK_TAIL = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'from', 'as', 'into', 'onto', 'over', 'under', 'than',
  'that', 'which', 'who', 'whose', 'whom', 'if', 'so', 'because', 'while',
  'when', 'where', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'shall',
  'may', 'might', 'must', 'not', 'very', 'quite', 'their', 'his', 'her',
  'its', 'my', 'your', 'our', 'this', 'these', 'those', 'each', 'every',
  'some', 'any', 'no', "i'm", "we're", "you're", "it's", "he's", "she's",
  "they're", "there's", "that's", "what's", "don't", "doesn't", "isn't",
  "aren't", "won't", "can't",
]);

function _bareWord(w) {
  return w.toLowerCase().replace(/[^a-z']/g, '');
}

// Find break positions by minimizing a global cost over all possible
// segmentations (dynamic programming), instead of greedily cutting when a
// line fills up. Each candidate cue is scored on:
//   • boundary quality — real audio pauses, sentence/clause punctuation,
//     and never stranding a weak connective word at the end of a cue
//   • line fill — prefer comfortably full lines for the chosen aspect
//     ratio over ragged short ones
//   • rhythm — penalize blink-and-miss cues (<0.8s) and long silences
//     trapped inside a cue
function computeSmartBreaks(words, limit) {
  const n = words.length;
  if (n <= 1) return [];

  // segLen(i, j) = characters of words[i..j) joined with single spaces
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + words[i].word.length;
  const segLen = (i, j) => (prefix[j] - prefix[i]) + (j - i - 1);

  // Quality of ending a cue just before words[k]; lower = better.
  function boundaryCost(k) {
    if (k >= n) return -8;  // the very end of the transcript is always fine
    const prev = words[k - 1];
    const next = words[k];
    let cost = 0;
    if (/[.!?…]["')\]]*$/.test(prev.word)) cost -= 14;        // sentence end
    else if (/[,;:—–]["')\]]*$/.test(prev.word)) cost -= 7;   // clause end
    const gap = (next.start ?? 0) - (prev.end ?? 0);
    if (gap > 0) cost -= Math.min(12, gap * 10);              // spoken pause
    if (WEAK_TAIL.has(_bareWord(prev.word))) cost += 11;      // stranded connective
    return cost;
  }

  // Cost of one cue spanning words[i..j).
  function cueCost(i, j) {
    const len = segLen(i, j);
    // A cue must fit on one line — unless it's a single unbreakable word.
    if (len > limit && j - i > 1) return Infinity;

    let cost = 0;
    const fill = Math.min(1, len / limit);
    cost += (1 - fill) * (1 - fill) * 18;                     // underfilled line

    const dur = (words[j - 1].end ?? 0) - (words[i].start ?? 0);
    if (dur < 0.8) cost += 8;                                 // flashes too fast
    if (j - i === 1) cost += 6;                               // lone-word cue

    // Long silence trapped inside the cue → text lingers over dead air
    for (let k = i + 1; k < j; k++) {
      const g = (words[k].start ?? 0) - (words[k - 1].end ?? 0);
      if (g > 1.0) cost += Math.min(12, (g - 1.0) * 6);
    }
    return cost + boundaryCost(j);
  }

  // best[j] = minimal cost to segment words[0..j)
  const best = new Float64Array(n + 1).fill(Infinity);
  const back = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (segLen(i, j) > limit && j - i > 1) break;  // longer spans only get worse
      const c = best[i] + cueCost(i, j);
      if (c < best[j]) { best[j] = c; back[j] = i; }
    }
  }

  const breaks = [];
  for (let j = n; j > 0; j = back[j]) {
    if (back[j] > 0) breaks.push(back[j]);
  }
  return breaks.reverse();
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════

function render() {
  // If we don't have word-level data yet, build from cues
  if (!allWords.length && cues.length) {
    buildFlatModel();
  }

  document.querySelectorAll('#script-view, #transcript-view').forEach(el => el.remove());
  closeSpeakerMenu();

  // Toggle loaded/empty UI based on whether we have content
  document.body.classList.toggle('app-loaded', !!allWords.length);
  document.body.classList.toggle('view-transcript', viewMode === 'transcript');

  btnSave.disabled             = !cues.length;
  btnSaveAs.disabled           = !cues.length;
  btnAutoFormatToggle.disabled = !cues.length;
  btnAutoFormat.disabled       = !cues.length;
  btnReadResolve.disabled      = !resolveOk;
  btnPushResolve.disabled      = !cues.length;
  reviewSyncButton();

  if (!allWords.length) {
    cueCountEl.textContent = '';
    liveAfterRender();
    return;
  }

  if (viewMode === 'transcript') {
    renderTranscriptView();
  } else {
    cueCountEl.textContent = cues.length ? `${cues.length} cues` : '';
    renderCaptionView();
  }
  liveAfterRender();
}

function renderCaptionView() {
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
        speaker: orig.speaker ?? null,
        resolveId: orig.resolveId,
      });
    } else if (op.type === 'insert') {
      result.push({
        word: newTokens[op.newIdx],
        start: null,
        end: null,
        probability: null,
        speaker: null,   // inherited from the preceding word below
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

  // A word typed into the middle of someone's paragraph belongs to that
  // someone — inherit the speaker of the word it follows.
  for (let k = 1; k < result.length; k++) {
    if (result[k].speaker == null) result[k].speaker = result[k - 1].speaker;
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

function downloadBlob(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function serializeSRT(list) {
  return list.map((c, i) =>
    `${i + 1}\n${c.startTime} --> ${c.endTime}\n${c.text}`
  ).join('\n\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSCRIPT VIEW — the same words as a readable document
//
// Captions and a transcript document want opposite things: captions want
// short timed fragments, a document wants whole paragraphs attributed to a
// person. Both read from the same allWords[] — the caption view groups it
// with breakPositions[], this one groups it by who is speaking.
// ═══════════════════════════════════════════════════════════════════════

// A speaker who pauses this long has finished a thought — start a new
// paragraph even though they're still the one talking.
const PARAGRAPH_GAP_S = 2.0;
// Hard ceiling so an uninterrupted monologue still breaks up; only applied
// at a sentence end so it never cuts mid-thought.
const PARAGRAPH_MAX_WORDS = 110;

function speakerKey(id) { return id == null ? 'none' : String(id); }

function speakerLabel(id) {
  const named = speakerNames[speakerKey(id)];
  if (named) return named;
  return id == null ? 'Speaker' : `Speaker ${id + 1}`;
}

// Distinct hue per speaker, walked around the wheel so adjacent speakers
// never land on similar colours.
function speakerHue(id) { return id == null ? 30 : (id * 67 + 28) % 360; }

function speakerIds() {
  const seen = new Set(allWords.map(w => w.speaker ?? null));
  return [...seen].sort((a, b) => (a ?? -1) - (b ?? -1));
}

function nextSpeakerId() {
  const nums = allWords.map(w => w.speaker).filter(v => typeof v === 'number');
  return nums.length ? Math.max(...nums) + 1 : 0;
}

// A Whisper transcript has no speaker data at all. Rather than special-case
// null everywhere, fold it into speaker 0 on the way into this view — then
// every downstream path is uniformly integer-keyed, and the user can split
// paragraphs off to a second speaker by hand.
function ensureSpeakers() {
  if (!allWords.length) return;
  if (allWords.every(w => w.speaker == null)) {
    allWords.forEach(w => { w.speaker = 0; });
  }
}

function buildParagraphs() {
  const paras = [];
  let cur = null;
  allWords.forEach((w, idx) => {
    const prev = idx > 0 ? allWords[idx - 1] : null;
    const gap = prev ? (w.start ?? 0) - (prev.end ?? 0) : 0;
    const speakerChanged = cur && cur.speaker !== (w.speaker ?? null);
    const longPause = cur && gap > PARAGRAPH_GAP_S;
    const overlong = cur
      && (idx - cur.startIdx) >= PARAGRAPH_MAX_WORDS
      && prev && /[.!?…]["')\]]*$/.test(prev.word);

    if (!cur || speakerChanged || longPause || overlong) {
      cur = { speaker: w.speaker ?? null, startIdx: idx, endIdx: idx };
      paras.push(cur);
    } else {
      cur.endIdx = idx;
    }
  });
  return paras;
}

// ── Speaker names persist per file, so a reload doesn't lose the work ──
function speakerStoreKey() { return `speakerNames:${fileName}`; }

function loadSpeakerNames() {
  try {
    speakerNames = JSON.parse(localStorage.getItem(speakerStoreKey())) || {};
  } catch (e) { speakerNames = {}; }
}

function saveSpeakerNames() {
  try {
    localStorage.setItem(speakerStoreKey(), JSON.stringify(speakerNames));
  } catch (e) { /* storage full or blocked — names still work this session */ }
}

// ── Render ─────────────────────────────────────────────────────────────
function renderTranscriptView() {
  ensureSpeakers();

  const paras = buildParagraphs();
  const ids = speakerIds();
  cueCountEl.textContent =
    `${paras.length} paragraph${paras.length === 1 ? '' : 's'} · ` +
    `${ids.length} speaker${ids.length === 1 ? '' : 's'}`;

  const view = document.createElement('article');
  view.id = 'transcript-view';
  view.className = 'transcript-doc';

  const head = document.createElement('header');
  head.className = 'transcript-head';
  const h1 = document.createElement('h1');
  h1.className = 'transcript-title';
  h1.textContent = transcriptTitle();
  const meta = document.createElement('p');
  meta.className = 'transcript-meta';
  meta.textContent = 'Click a speaker name to rename it everywhere · ▾ reassigns a paragraph';
  head.append(h1, meta);
  view.appendChild(head);

  paras.forEach(p => view.appendChild(renderParagraph(p)));
  container.appendChild(view);
}

function renderParagraph(p) {
  const block = document.createElement('section');
  block.className = 'para';

  const head = document.createElement('div');
  head.className = 'para-head';
  head.contentEditable = 'false';

  if (showTimestamps) {
    const t = document.createElement('span');
    t.className = 'para-time';
    t.textContent = hhmmss(allWords[p.startIdx].start ?? 0);
    head.appendChild(t);
  }

  const chip = document.createElement('span');
  chip.className = 'speaker-chip';
  chip.setAttribute('role', 'button');
  chip.tabIndex = 0;
  chip.style.setProperty('--sp-hue', String(speakerHue(p.speaker)));
  chip.textContent = speakerLabel(p.speaker);
  chip.title = 'Click to rename this speaker everywhere';
  chip.addEventListener('click', () => beginRenameSpeaker(chip, p.speaker));
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      beginRenameSpeaker(chip, p.speaker);
    }
  });
  head.appendChild(chip);

  const reassign = document.createElement('button');
  reassign.className = 'para-reassign';
  reassign.textContent = '▾';
  reassign.title = 'Assign this paragraph to a different speaker';
  reassign.addEventListener('click', (e) => {
    e.stopPropagation();
    openSpeakerMenu(head, p);
  });
  head.appendChild(reassign);

  const body = document.createElement('p');
  body.className = 'para-body';
  body.contentEditable = 'true';
  body.spellcheck = false;
  for (let i = p.startIdx; i <= p.endIdx; i++) {
    if (i > p.startIdx) body.appendChild(document.createTextNode(' '));
    body.appendChild(wordSpan(allWords[i], i));
  }
  // Reconcile on blur rather than on every keystroke: re-rendering mid-type
  // would fight the caret, and nothing here is timing-sensitive.
  body.addEventListener('blur', reconcileTranscriptFromDOM);

  block.append(head, body);
  return block;
}

// Shared with the caption view so the confidence and spelling cues a
// reviewer relies on look identical in both.
function wordSpan(wordObj, idx) {
  const span = document.createElement('span');
  span.className = 'word';
  if (
    typeof wordObj.probability === 'number'
    && wordObj.probability < LOW_CONFIDENCE_THRESHOLD
  ) {
    span.classList.add('low-confidence');
    span.title = `Confidence: ${Math.round(wordObj.probability * 100)}%`;
  }
  if (isMisspelled(wordObj.word)) span.classList.add('misspelled');
  span.textContent = wordObj.word;
  span.dataset.idx = idx;
  return span;
}

// ── Editing ────────────────────────────────────────────────────────────
function reconcileTranscriptFromDOM() {
  const bodies = document.querySelectorAll('#transcript-view .para-body');
  if (!bodies.length) return;

  const tokens = [];
  bodies.forEach(b => {
    (b.textContent || '').split(/\s+/).filter(Boolean).forEach(t => tokens.push(t));
  });

  if (!tokens.length) return;  // don't let a stray select-all-delete wipe the file
  if (tokens.join(' ') === allWords.map(w => w.word).join(' ')) return;

  allWords = reconcileWords(allWords, tokens);
  // Caption breaks are indices into allWords, so an insert or delete here
  // shifts everything after it. Typo fixes (equal-length replacements) keep
  // them exact; after heavier edits, re-run Auto-format in the caption view.
  breakPositions = breakPositions.filter(b => b > 0 && b < allWords.length);
  cues = flatModelToCues();
  render();
  setStatus('Transcript edited.');
  autoSaveSRT(true);
}

function beginRenameSpeaker(chip, speakerId) {
  // The chip keeps its click/Enter listeners while it's being edited, so
  // pressing Enter to commit would otherwise re-enter this function and
  // stack a second set of handlers instead of finishing the rename.
  if (chip.dataset.renaming === '1') return;
  chip.dataset.renaming = '1';

  const current = speakerLabel(speakerId);
  chip.contentEditable = 'true';
  chip.classList.add('editing');
  chip.focus();

  const range = document.createRange();
  range.selectNodeContents(chip);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    chip.removeEventListener('blur', finish);
    chip.removeEventListener('keydown', onKey);
    delete chip.dataset.renaming;
    chip.contentEditable = 'false';
    chip.classList.remove('editing');
    chip.blur();   // safe — the blur listener is already detached

    const name = (chip.textContent || '').trim();
    if (!name || name === current) { chip.textContent = current; return; }
    speakerNames[speakerKey(speakerId)] = name;
    saveSpeakerNames();
    render();
    setStatus(`Renamed to ${name}.`);
  };
  // Enter commits directly rather than via chip.blur(): a blur event isn't
  // guaranteed to fire (an unfocused window won't emit one), and losing a
  // rename because the commit never ran is worse than a stray caret.
  const onKey = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { e.preventDefault(); chip.textContent = current; finish(); }
  };

  chip.addEventListener('blur', finish);
  chip.addEventListener('keydown', onKey);
}

// ── Reassigning a paragraph to another speaker ─────────────────────────
// Diarization gets some turns wrong, so fixing one has to be quick.
function closeSpeakerMenu() {
  document.querySelectorAll('.speaker-menu').forEach(m => m.remove());
}

function openSpeakerMenu(anchorEl, para) {
  const alreadyOpen = anchorEl.querySelector('.speaker-menu');
  closeSpeakerMenu();
  if (alreadyOpen) return;

  const menu = document.createElement('div');
  menu.className = 'popover speaker-menu';
  menu.contentEditable = 'false';

  speakerIds().forEach(id => {
    const item = document.createElement('button');
    item.className = 'menu-item';
    if (id === para.speaker) item.classList.add('is-current');
    item.textContent = speakerLabel(id);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      assignParagraph(para, id);
    });
    menu.appendChild(item);
  });

  const add = document.createElement('button');
  add.className = 'menu-item menu-item-new';
  add.textContent = '+ New speaker';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    assignParagraph(para, nextSpeakerId());
  });
  menu.appendChild(add);

  anchorEl.appendChild(menu);
}

function assignParagraph(para, speakerId) {
  for (let i = para.startIdx; i <= para.endIdx; i++) {
    allWords[i].speaker = speakerId;
  }
  closeSpeakerMenu();
  render();
  setStatus(`Paragraph assigned to ${speakerLabel(speakerId)}.`);
}

// ── Export ─────────────────────────────────────────────────────────────
function transcriptTitle() {
  // An audio export of a video is often named "talk.mp4.mp3", which becomes
  // "talk.mp4.srt" on load — so drop any media extensions stacked under the
  // last one too, or the document ends up titled "talk.mp4".
  return (fileName || 'Transcript')
    .replace(/\.[^.]+$/, '')
    .replace(/(\.(mp3|mp4|m4a|m4v|mov|wav|aac|flac|ogg|opus|mkv|mxf|avi|webm))+$/i, '');
}

function hhmmss(sec) {
  const total = Math.max(0, Math.floor(sec || 0));
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function buildTranscriptText() {
  const title = transcriptTitle();
  const out = [title, '='.repeat(Math.max(3, title.length)), ''];

  buildParagraphs().forEach(p => {
    const name = speakerLabel(p.speaker);
    out.push(showTimestamps
      ? `[${hhmmss(allWords[p.startIdx].start ?? 0)}] ${name}:`
      : `${name}:`);
    // Left unwrapped on purpose — soft-wrapping editors handle it, and it
    // pastes into Word or Docs as real paragraphs instead of ragged lines.
    out.push(allWords.slice(p.startIdx, p.endIdx + 1).map(w => w.word).join(' '));
    out.push('');
  });

  // CRLF — this file gets handed to someone else, quite possibly on Windows.
  return out.join('\r\n');
}

// ── View switching ─────────────────────────────────────────────────────
function setViewMode(mode) {
  if (mode === viewMode) return;

  // Flush whatever the outgoing view has pending before we throw its DOM away
  if (viewMode === 'transcript') {
    reconcileTranscriptFromDOM();
  } else if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileFromDOM();
  }

  viewMode = mode;
  localStorage.setItem('viewMode', mode);
  viewCaptionsBtn.classList.toggle('is-active', mode === 'captions');
  viewTranscriptBtn.classList.toggle('is-active', mode === 'transcript');
  render();
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
const aspectRatioSelect = document.getElementById('aspect-ratio');
if (aspectRatioSelect) {
  aspectRatioSelect.value = aspectRatio;
  aspectRatioSelect.addEventListener('change', () => {
    aspectRatio = aspectRatioSelect.value;
    localStorage.setItem('aspectRatio', aspectRatio);
    if (aspectRatio !== 'custom') {
      maxChars = ASPECT_MAX_CHARS[aspectRatio];
      maxCharsInput.value = maxChars;
      localStorage.setItem('maxChars', String(maxChars));
    }
  });
}
maxCharsInput.value = maxChars;
maxCharsInput.addEventListener('change', () => {
  maxChars = Math.max(10, Math.min(120, +maxCharsInput.value));
  maxCharsInput.value = maxChars;
  localStorage.setItem('maxChars', String(maxChars));
  // A hand-tuned char count is no longer a preset
  if (aspectRatioSelect && maxChars !== ASPECT_MAX_CHARS[aspectRatio]) {
    aspectRatio = 'custom';
    aspectRatioSelect.value = 'custom';
    localStorage.setItem('aspectRatio', 'custom');
  }
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
    openLoadedSrt(browse.path, res);
    toast(`Loaded ${res.count} cues. Auto-save active.`, 'success');
  } catch (err) { toast('Failed to load file.', 'error'); setStatus('Error.'); }
}

// Show an SRT read by /api/load-srt and auto-save back to the same file.
function openLoadedSrt(srtPath, res) {
  cues = res.cues;
  fileName = srtPath.split(/[/\\]/).pop();
  // Keep the full path: autoSaveSRT strips the final extension itself.
  // (Stripping .srt here too made "my.video.srt" auto-save to "my.srt".)
  sourceFilePath = srtPath;
  rememberOpenSrt(srtPath, false);

  fileNameDisplay.textContent = fileName;
  fileNameDisplay.classList.add('loaded');
  if (modelTag) modelTag.textContent = '';  // SRT load, no Whisper model involved
  allWords = [];
  srtVersion = 0;
  loadSpeakerNames();
  render();
  setStatus(`Loaded ${res.count} cues from ${fileName}`);
}

// ── Surviving a page refresh ──────────────────────────────────────────────
// The transcript lives only in this tab, but every edit is auto-saved to an
// SRT on disk. Remember which one (per tab: a fresh launch opens the landing
// page), and after a refresh reopen it. sourceFilePath is set to the SRT
// itself, so auto-save keeps writing to exactly the same file.
const OPEN_SRT_KEY = 'openSrt';

function srtPathFor(path) {
  return path.replace(/\.[^.]+$/, '') + '.srt';  // where autoSaveSRT writes
}

function rememberOpenSrt(srtPath, transcribed) {
  try {
    if (srtPath) sessionStorage.setItem(OPEN_SRT_KEY, JSON.stringify({ path: srtPath, transcribed }));
    else sessionStorage.removeItem(OPEN_SRT_KEY);
  } catch (e) { /* storage unavailable */ }
}

// On load: a link like /?open=<path to an .srt> opens that file (how an
// operator hands Ben a file without the picker); otherwise reopen the SRT
// this tab had open before a refresh. Both go through /api/load-srt.
async function restoreOpenSrt() {
  const url = new URL(location.href);
  const asked = (url.searchParams.get('open') || '').trim();
  if (url.searchParams.has('open')) {
    url.searchParams.delete('open');  // a later refresh then uses sessionStorage
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  let saved = null;
  const fromLink = /\.srt$/i.test(asked);
  if (fromLink) saved = { path: asked, transcribed: false };
  else try { saved = JSON.parse(sessionStorage.getItem(OPEN_SRT_KEY)); } catch (e) { /* none */ }
  if (!saved || !saved.path || cues.length) return;
  try {
    const res = await api('POST', '/api/load-srt', { filePath: saved.path });
    if (res.error || !res.cues || !res.cues.length || cues.length) {
      if (res.error && fromLink) toast(res.error, 'error', 6000);
      else if (res.error) rememberOpenSrt(null);  // gone from disk: stay on the landing page
      return;
    }
    openLoadedSrt(saved.path, res);
    // A transcription had Whisper's per-word confidence; the SRT doesn't.
    rememberOpenSrt(saved.path, saved.transcribed);
    toast(saved.transcribed
      ? `Reopened ${fileName}. Caption timing is kept; confidence marks are not.`
      : `Reopened ${fileName}`, 'success', 4000);
  } catch (e) { /* server unreachable: leave the landing page up */ }
}

btnBrowse.addEventListener('click', openSrtFromDisk);
if (btnBrowseEmpty) btnBrowseEmpty.addEventListener('click', openSrtFromDisk);

// Auto-format
btnAutoFormat.addEventListener('click', async () => {
  setStatus('Formatting…');
  formatPopover.classList.add('hidden');

  // With word-level timing available, re-break locally: the optimizer uses
  // the real pauses, and we keep Whisper's timings intact. (The server path
  // flattens cues and re-estimates word timing proportionally.)
  if (allWords.length) {
    breakPositions = computeSmartBreaks(allWords, maxChars);
    cues = flatModelToCues();
    render();
    const ratioNote = aspectRatio === 'custom' ? `${maxChars} chars/line` : `${aspectRatio}, ${maxChars} chars/line`;
    toast(`Re-broke into ${cues.length} cues (${ratioNote}).`, 'success');
    setStatus('Formatted.');
    autoSaveSRT(true);
    return;
  }

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
  // The speaker menu is built and torn down per paragraph, so it's removed
  // outright rather than just hidden like the static popovers.
  if (!e.target.closest('.speaker-menu, .para-reassign')) closeSpeakerMenu();
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
  downloadBlob(serializeSRT(cues), fileName);
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
        speaker: null,
        resolveId: c.resolveId || null,
      }));
      breakPositions = computeSmartBreaks(allWords, maxChars);
      cues = flatModelToCues();
      fileName = 'from-resolve.srt';
      fileNameDisplay.textContent = fileName;
      fileNameDisplay.classList.add('loaded');
      if (modelTag) modelTag.textContent = '';  // came from Resolve, not from Whisper
      loadSpeakerNames();
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
    downloadBlob(serializeSRT(cues), dlName);
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
    // Whisper is more verbatim on clean voiceover, but it cannot tell
    // speakers apart — that's the whole reason to reach for Deepgram.
    const engine = (transcribeDiarize && transcribeDiarize.checked) ? 'deepgram' : 'whisper';
    const res = await api('POST', '/api/transcribe', { filePath, model, engine });
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
    if (job.stage === 'extracting') {
      setStatus('Extracting audio…');
    } else if (job.stage === 'uploading') {
      setStatus(`Uploading to Deepgram… ${pct}%`);
    } else if (job.stage === 'processing') {
      setStatus('Deepgram is transcribing…');
    } else if ((job.segments_done || 0) === 0 && pct === 0) {
      setStatus('Loading model… (first run may download ~3 GB)');
    } else {
      setStatus(`Transcribing… ${pct}%`);
    }

    if (job.status === 'complete') {
      stopTranscriptionPolling();

      if (job.words && job.words.length) {
        fileName = (job.file || 'transcription').replace(/\.[^.]+$/, '') + '.srt';
        loadSpeakerNames();
        // Asked for speakers? Then the transcript document is what they came
        // for — open on it rather than the caption editor.
        if (job.speakers > 0) {
          viewMode = 'transcript';
          localStorage.setItem('viewMode', viewMode);
        }
        loadTranscriptionWords(job.words);
        fileNameDisplay.textContent = job.file || 'Transcription';
        fileNameDisplay.classList.add('loaded');
        if (modelTag) modelTag.textContent = job.model || '';
        const modelSuffix = job.model ? ` · ${job.model}` : '';
        const speakerSuffix = job.speakers > 0
          ? ` · ${job.speakers} speaker${job.speakers === 1 ? '' : 's'}`
          : '';
        toast(
          `Transcribed ${job.words.length} words${modelSuffix}${speakerSuffix}.`,
          'success', 4000,
        );
        syncViewTabs();
        setStatus(`Transcription complete — ${job.words.length} words, ${cues.length} cues${modelSuffix}.`);

        // Auto-save SRT next to source file if we have the path
        if (sourceFilePath) {
          autoSaveSRT();
        }
        rememberOpenSrt(sourceFilePath ? srtPathFor(sourceFilePath) : null, true);
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

// One save in flight at a time. A burst of edits (a review applies several)
// would otherwise race, and an older save landing last could win; instead
// a save asked for mid-flight runs once more afterwards, with the latest cues.
let autoSaveBusy = false;
let autoSaveAgain = null;   // null, or the quiet flag for the follow-up save

async function autoSaveSRT(quiet = false) {
  if (!cues.length || !sourceFilePath) return;
  if (autoSaveBusy) {
    autoSaveAgain = autoSaveAgain === null ? quiet : (autoSaveAgain && quiet);
    return;
  }
  autoSaveBusy = true;
  // Save SRT next to the source file (replace extension with .srt)
  const srtPath = srtPathFor(sourceFilePath);
  try {
    const res = await api('POST', '/api/save-srt', { filePath: srtPath, cues });
    if (res.error) {
      if (!quiet) toast(`Auto-save failed: ${res.error}`, 'warn');
    } else {
      if (!quiet) toast(`SRT saved.`, 'success', 1500);
      setStatus(`Saved → ${srtPath}`);
    }
  } catch (e) { /* silent */ }
  finally {
    autoSaveBusy = false;
    if (autoSaveAgain !== null) {
      const q = autoSaveAgain;
      autoSaveAgain = null;
      autoSaveSRT(q);
    }
  }
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

// ═══════════════════════════════════════════════════════════════════════
// TRANSCRIPT VIEW — event wiring
// ═══════════════════════════════════════════════════════════════════════

function syncViewTabs() {
  if (viewCaptionsBtn)   viewCaptionsBtn.classList.toggle('is-active', viewMode === 'captions');
  if (viewTranscriptBtn) viewTranscriptBtn.classList.toggle('is-active', viewMode === 'transcript');
}
syncViewTabs();

if (viewCaptionsBtn)   viewCaptionsBtn.addEventListener('click', () => setViewMode('captions'));
if (viewTranscriptBtn) viewTranscriptBtn.addEventListener('click', () => setViewMode('transcript'));

if (showTimestampsInput) {
  showTimestampsInput.checked = showTimestamps;
  showTimestampsInput.addEventListener('change', () => {
    showTimestamps = showTimestampsInput.checked;
    localStorage.setItem('showTimestamps', String(showTimestamps));
    if (viewMode === 'transcript') render();
  });
}

if (btnExportTxt) {
  btnExportTxt.addEventListener('click', () => {
    if (!allWords.length) { toast('Nothing to export yet.', 'warn'); return; }
    // Flush any edit still sitting in the DOM before we serialise
    reconcileTranscriptFromDOM();
    const safeName = transcriptTitle().replace(/[\\/:*?"<>|]/g, '_') + '.txt';
    downloadBlob(buildTranscriptText(), safeName);
    toast('Transcript downloaded.', 'success');
    setStatus(`Downloaded ${safeName}`);
  });
}

// ── Deepgram availability ──────────────────────────────────────────────
// The key lives in the server's environment, so the browser has to ask.
// Better to grey the option out with a reason than to fail on click.
function syncDiarizeUI() {
  const on = !!(transcribeDiarize && transcribeDiarize.checked);
  if (transcribeModel) {
    transcribeModel.disabled = on;
    transcribeModel.title = on
      ? 'Speaker identification runs Deepgram Nova-3 — the Whisper model choice does not apply.'
      : 'Whisper model — large-v2 is the most verbatim for English voiceover; v3 is sharper but paraphrases more.';
  }
}

if (transcribeDiarize) {
  transcribeDiarize.addEventListener('change', syncDiarizeUI);
}

(async function checkEngines() {
  try {
    const r = await api('GET', '/api/engines');
    deepgramReady = !!r.deepgram;
  } catch (e) {
    deepgramReady = false;
  }
  if (transcribeDiarize && !deepgramReady) {
    transcribeDiarize.checked = false;
    transcribeDiarize.disabled = true;
    const row = document.getElementById('diarize-row');
    if (row) row.classList.add('is-disabled');
    if (diarizeUnavailable) diarizeUnavailable.classList.remove('hidden');
  }
  syncDiarizeUI();
})();

// ═══════════════════════════════════════════════════════════════════════
// LIVE LINK — lets a voice call (Claude HQ's Subtitle agent) or a review
// job read and fix the open transcript (server side: live_link.py)
// ═══════════════════════════════════════════════════════════════════════
//
// The open document only exists in this tab, so the server can't edit the
// SRT on disk without fighting the auto-save. Instead this tab publishes a
// compact copy of the document on every change, polls for queued edits, and
// applies each one through reconcileWords() — the same model path typing
// uses — so timing, speakers and auto-save behave exactly as for a keystroke.
// Every text edit carries the line text the caller read; if Ben has changed
// that line since, the edit is rejected. The keyboard always wins.

// `var`, not `let`: render() can run before this section has executed.
var live = {
  tab: Math.random().toString(36).slice(2, 10),
  rev: 0,
  publishTimer: null,
  focusCue: null,      // the line Ben's caret is on (or the call last showed)
  shownCue: null,      // the line the call asked to show, outlined
  flags: [],
  flagsVersion: null,
  undo: [],            // [{ words, breaks, names, sig }] — voice edits only
  fixed: null,         // word indices to flash after the next render
  polling: false,
};
const LIVE_POLL_MS = 700;
const LIVE_PUBLISH_MS = 250;
const LIVE_UNDO_MAX = 50;

// Word-index ranges of each caption, matching flatModelToCues() one for one.
function liveCueRanges() {
  const cuts = [0, ...breakPositions, allWords.length];
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] > cuts[i]) out.push({ s: cuts[i], e: cuts[i + 1] });
  }
  return out;
}

function liveCueOfWord(idx) {
  let n = 1;
  for (const b of breakPositions) { if (idx >= b) n++; else break; }
  return n;
}

function liveCueText(r) {
  return allWords.slice(r.s, r.e).map(w => w.word).join(' ');
}

function liveModelSig() {
  return allWords.map(w => w.word).join(' ') + '|' + breakPositions.join(',');
}

function livePublishSoon() {
  if (live.publishTimer) clearTimeout(live.publishTimer);
  live.publishTimer = setTimeout(livePublish, LIVE_PUBLISH_MS);
}

function livePublish() {
  live.publishTimer = null;
  const ranges = liveCueRanges();
  const doc = {
    tab: live.tab,
    rev: live.rev,
    file: allWords.length ? fileName : '',
    path: sourceFilePath || '',
    view: viewMode,
    focusCue: live.focusCue,
    speakers: allWords.length
      ? speakerIds().map(id => ({ id, name: speakerLabel(id) }))
      : [],
    cues: ranges.map((r, i) => ({
      n: i + 1,
      start: cues[i] ? cues[i].startTime : '',
      end: cues[i] ? cues[i].endTime : '',
      text: liveCueText(r),
      // 0-based word offsets the transcriber itself was unsure of — strong
      // hints for a reviewer. Absent for SRT loads (no probabilities).
      unsure: allWords.slice(r.s, r.e)
        .map((w, k) => (typeof w.probability === 'number' && w.probability < LOW_CONFIDENCE_THRESHOLD ? k : -1))
        .filter(k => k >= 0),
    })),
  };
  return api('POST', '/api/live/doc', doc).catch(() => {});
}

// Called at the end of every render(): the model may have changed.
function liveAfterRender() {
  if (typeof live === 'undefined') return;  // render() before this section ran
  live.rev++;
  livePublishSoon();
  liveDecorate();
}

// Flag underlines, the outlined "this line" the call is on, and the flash
// on a fix that just landed. Re-applied after every render.
function liveDecorate() {
  const ranges = liveCueRanges();
  const spanAt = idx => container.querySelector(`.word[data-idx="${idx}"]`);
  const bare = w => _bareWord(w).toLowerCase();

  for (const f of live.flags) {
    const r = ranges[f.cue - 1];
    if (!r) continue;
    const want = bare(f.word);
    for (let i = r.s; i < r.e; i++) {
      if (bare(allWords[i].word) === want) {
        const span = spanAt(i);
        if (span) {
          span.classList.add('live-flag');
          span.title = f.suggestion
            ? `Suggested: ${f.suggestion}${f.why ? ' — ' + f.why : ''}`
            : (f.why || 'Flagged for review');
        }
        break;
      }
    }
  }

  // A fix that came with a note (a review's reason) keeps it on hover.
  container.querySelectorAll('.word[data-idx]').forEach(span => {
    const w = allWords[Number(span.dataset.idx)];
    if (w && w.liveNote) { span.classList.add('live-noted'); span.title = w.liveNote; }
  });

  if (live.shownCue && ranges[live.shownCue - 1]) {
    const r = ranges[live.shownCue - 1];
    for (let i = r.s; i < r.e; i++) {
      const span = spanAt(i);
      if (span) span.classList.add('live-shown');
    }
  }

  if (live.fixed) {
    const idxs = live.fixed;
    live.fixed = null;
    const spans = [];
    for (const i of idxs) {
      const span = spanAt(i);
      if (span) { span.classList.add('live-fixed'); spans.push(span); }
    }
    if (spans[0]) spans[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => spans.forEach(sp => sp.classList.remove('live-fixed')), 2600);
  }
}

// Any typing the tab hasn't folded into the model yet goes in first, so an
// edit is checked against what's really on screen and never re-renders it away.
function liveFlushTyping() {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileFromDOM();
  }
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains('para-body')) {
    reconcileTranscriptFromDOM();
  }
}

function liveSnapshot() {
  return {
    words: allWords.map(w => ({ ...w })),
    breaks: [...breakPositions],
    names: { ...speakerNames },
  };
}

// Call AFTER the edit: the signature is what the model looks like with the
// fix in, so undo only fires while nothing else has changed since.
function livePushUndo(snap) {
  snap.sig = liveModelSig();
  live.undo.push(snap);
  if (live.undo.length > LIVE_UNDO_MAX) live.undo.shift();
}

// Replace one caption's words, keeping each surviving word's timing.
function liveApplyCueTokens(r, tokens, note = null) {
  // Give reconcileWords the neighbouring word on each side, so a word
  // inserted at either edge of the line interpolates from real timing.
  const lo = Math.max(0, r.s - 1);
  const hi = Math.min(allWords.length, r.e + 1);
  const before = r.s > lo ? [allWords[lo].word] : [];
  const after = hi > r.e ? [allWords[r.e].word] : [];
  const merged = reconcileWords(allWords.slice(lo, hi), [...before, ...tokens, ...after]);
  const slice = merged.slice(before.length, merged.length - after.length);
  if (note) {
    // Only the words that actually changed carry the note. The line before
    // and after rides along so a review change can be reverted on its own.
    const old = new Set(allWords.slice(r.s, r.e).map(w => w.word));
    const was = allWords.slice(r.s, r.e).map(w => w.word).join(' ');
    const now = tokens.join(' ');
    slice.forEach(w => {
      if (!old.has(w.word)) { w.liveNote = note; w.liveWas = was; w.liveNow = now; }
    });
  }
  // A text fix never moves the caption itself: if the line's first or last
  // word was merged away ("Net flicks" -> "Netflix"), the survivor takes over
  // its edge time, so the SRT still lines up with the version in Resolve.
  const first = allWords[r.s], last = allWords[r.e - 1];
  if (slice.length && typeof first.start === 'number'
      && !(typeof slice[0].start === 'number' && slice[0].start <= first.start)) {
    slice[0].start = first.start;
  }
  const tail = slice[slice.length - 1];
  if (tail && typeof last.end === 'number'
      && !(typeof tail.end === 'number' && tail.end >= last.end)) {
    tail.end = last.end;
  }

  const delta = tokens.length - (r.e - r.s);
  allWords = [...allWords.slice(0, r.s), ...slice, ...allWords.slice(r.e)];
  breakPositions = breakPositions.map(b => (b > r.s ? b + delta : b));
}

function liveRerender() {
  const view = document.getElementById('script-view');
  const hadFocus = view && view.contains(document.activeElement);
  const caret = hadFocus ? saveCaret(view) : null;
  cues = flatModelToCues();
  render();
  if (hadFocus) restoreCaret(document.getElementById('script-view'), caret);
  autoSaveSRT(true);
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function liveApplyText(op) {
  const ranges = liveCueRanges();
  const r = ranges[op.cue - 1];
  if (!r) return { ok: false, reason: 'no such line' };
  const was = liveCueText(r);
  if (op.expect != null && was !== op.expect) {
    return { ok: false, reason: 'changed: that line has been edited since', text: was };
  }

  let next;
  if (op.op === 'set') {
    next = String(op.text || '');
  } else {
    const find = String(op.find || '').trim();
    if (!find) return { ok: false, reason: 'nothing to find', text: was };
    // Whole words first ("SVOD" shouldn't match inside "SVODs"), then anywhere.
    const whole = new RegExp(`(^|[^\\p{L}\\p{N}'])${escapeRegExp(find)}(?=$|[^\\p{L}\\p{N}'])`, 'iu');
    const loose = new RegExp(escapeRegExp(find), 'i');
    const replace = String(op.replace ?? '');
    if (whole.test(was)) next = was.replace(whole, (m, pre) => pre + replace);
    else if (loose.test(was)) next = was.replace(loose, () => replace);
    else return { ok: false, reason: `"${find}" isn't in that line`, text: was };
  }

  const tokens = next.replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, reason: 'that would empty the line', text: was };
  if (tokens.join(' ') === was) return { ok: true, cue: op.cue, text: was, was };

  const snap = liveSnapshot();
  liveApplyCueTokens(r, tokens, op.note ? `${op.note} (was: ${was})` : null);
  livePushUndo(snap);
  // Flash just the words that changed (the whole line if it's all reshuffled).
  const old = new Set(was.split(' '));
  const changed = tokens.map((t, k) => (old.has(t) ? -1 : r.s + k)).filter(k => k >= 0);
  live.fixed = changed.length ? changed : tokens.map((t, k) => r.s + k);
  liveRerender();
  return { ok: true, cue: op.cue, text: tokens.join(' '), was };
}

function liveApplySpeaker(op) {
  const name = String(op.name || '').trim();
  if (!name) return { ok: false, reason: 'no new name given' };
  const ids = allWords.length ? speakerIds() : [];
  const key = String(op.speaker ?? '').trim().toLowerCase();
  let id;
  if (/^\d+$/.test(key) && ids.includes(Number(key))) id = Number(key);
  else id = ids.find(i => speakerLabel(i).toLowerCase() === key);
  if (id === undefined) {
    return { ok: false, reason: `no speaker called "${op.speaker}"`, text: ids.map(speakerLabel).join(', ') };
  }
  const was = speakerLabel(id);
  const snap = liveSnapshot();
  speakerNames[speakerKey(id)] = name;
  livePushUndo(snap);
  saveSpeakerNames();
  render();
  return { ok: true, text: name, was };
}

function liveApplyFocus(op) {
  const ranges = liveCueRanges();
  const n = Number(op.cue);
  const r = ranges[n - 1];
  if (!r) return { ok: false, reason: 'no such line' };
  live.shownCue = n;
  live.focusCue = n;
  container.querySelectorAll('.word.live-shown').forEach(sp => sp.classList.remove('live-shown'));
  liveDecorate();
  const span = container.querySelector(`.word[data-idx="${r.s}"]`);
  if (span) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  livePublishSoon();
  return { ok: true, cue: n, text: liveCueText(r) };
}

// Undo the last voice edit — only while nothing else has changed since,
// so it can never roll back Ben's own typing.
function liveUndoLast() {
  const top = live.undo[live.undo.length - 1];
  if (!top) return { ok: false, reason: 'nothing to undo' };
  if (top.sig !== liveModelSig()) {
    live.undo = [];
    return { ok: false, reason: 'the transcript has been edited since, so I left it' };
  }
  live.undo.pop();
  allWords = top.words;
  breakPositions = top.breaks;
  speakerNames = top.names;
  saveSpeakerNames();
  liveRerender();
  return { ok: true };
}

function liveApply(op) {
  try {
    if (op.op === 'focus') return liveApplyFocus(op);
    if (!allWords.length) return { ok: false, reason: 'no transcript open' };
    liveFlushTyping();
    if (op.op === 'review') return reviewLiveOp(op);
    if (op.op === 'replace' || op.op === 'set') {
      const res = liveApplyText(op);
      if (res.ok && op.count && review.active) review.made += op.count;
      return res;
    }
    if (op.op === 'speaker') return liveApplySpeaker(op);
    if (op.op === 'undo') return liveUndoLast();
    return { ok: false, reason: `unknown op ${op.op}` };
  } catch (e) {
    return { ok: false, reason: `error: ${e.message}` };
  }
}

async function livePoll() {
  if (live.polling) return;
  live.polling = true;
  try {
    const fv = live.flagsVersion == null ? '' : live.flagsVersion;
    const res = await api('GET', `/api/live/poll?tab=${live.tab}&fv=${fv}`);
    if (!res.active) {
      // The server restarted, or another tab took over and this one is
      // in front again: publish so the server knows which tab is live.
      if (document.visibilityState === 'visible' && !live.publishTimer) livePublish();
      return;
    }
    if (res.flags) {
      live.flags = res.flags.items || [];
      live.flagsVersion = res.flags.version;
      container.querySelectorAll('.word.live-flag').forEach(sp => {
        sp.classList.remove('live-flag');
        sp.removeAttribute('title');
      });
      liveDecorate();
    }
    if (res.ops && res.ops.length) {
      const results = res.ops.map(op => ({ id: op.id, op: op.op, flag: op.flag, ...liveApply(op) }));
      const fixed = results.filter(r => r.ok && (r.op === 'replace' || r.op === 'set')).length;
      if (fixed) setStatus(`Voice fix${fixed > 1 ? 'es' : ''} applied · Ctrl+Z undoes`);
      await api('POST', '/api/live/results', { tab: live.tab, results });
    }
  } catch (e) {
    // Server not reachable — try again next tick.
  } finally {
    live.polling = false;
  }
}

// Which line Ben's caret is on, for the call ("this line") and HQ's strip.
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let node = sel.getRangeAt(0).startContainer;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !container.contains(node)) return;
  let wordEl = node.closest && node.closest('.word');
  if (!wordEl && node.querySelector) wordEl = node.querySelector('.word');
  if (!wordEl || wordEl.dataset.idx == null) return;
  const n = liveCueOfWord(Number(wordEl.dataset.idx));
  if (n !== live.focusCue) { live.focusCue = n; livePublishSoon(); }
});

// Ctrl/Cmd+Z right after a voice fix undoes the fix. A re-render clears the
// browser's own undo history anyway, so nothing native is lost by taking it.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  const top = live.undo[live.undo.length - 1];
  if (!top || reconcileTimer || top.sig !== liveModelSig()) return;
  e.preventDefault();
  const r = liveUndoLast();
  if (r.ok) toast('Voice fix undone.', 'success', 1500);
}, true);

window.addEventListener('pagehide', () => {
  navigator.sendBeacon('/api/live/close', JSON.stringify({ tab: live.tab }));
});

setInterval(livePoll, LIVE_POLL_MS);
livePublish();

// ═══════════════════════════════════════════════════════════════════════
// AI REVIEW — Claude on this computer fixes words the transcriber misheard
// (server side: reviewer.py). The Review button and a chat operator start
// the same job; its swaps arrive over the live link as whole-line edits,
// bracketed by {op:'review', phase:'start'|'end'}. At the start this tab
// snapshots for Undo all; at the end it runs the house style check
// (static/review_style.js: no em dashes, Australian spelling).
// ═══════════════════════════════════════════════════════════════════════

var review = {
  ready: false,       // claude CLI found on this machine
  reason: '',         // why not, for the greyed-out button
  jobId: null,        // job this tab started (chat-started jobs aren't polled)
  pollTimer: null,
  active: false,      // between the start and end ops
  job: null,
  snap: null,         // the model before the review, for Undo all
  undoLen: 0,
  made: 0,
  endSig: null,       // the model right after the review
};

const btnReview       = document.getElementById('btn-review');
const reviewPopover   = document.getElementById('review-popover');
const reviewNoteInput = document.getElementById('review-note');
const btnReviewStart  = document.getElementById('btn-review-start');

function reviewNoteKey() { return `reviewNote:${fileName}`; }

function reviewSyncButton() {
  if (typeof review === 'undefined' || !btnReview) return;  // render() before this ran
  const running = !!review.jobId;
  btnReview.disabled = !allWords.length || !review.ready || !!transcribeJobId || running;
  btnReview.textContent = running ? 'Reviewing…' : 'Review';
  btnReview.title = !review.ready
    ? (review.reason || 'Review is unavailable.')
    : 'Have Claude fix words the transcriber misheard';
}

function toastAction(msg, label, onClick, type = 'success', dur = 15000) {
  const t = document.createElement('div');
  t.className = `toast ${type} toast-action`;
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'btn-ghost toast-btn';
  btn.textContent = label;
  btn.addEventListener('click', () => { t.remove(); onClick(); });
  t.append(text, btn);
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

function reviewLiveOp(op) {
  if (op.phase === 'start') {
    review.active = true;
    review.job = op.job || null;
    review.snap = liveSnapshot();
    review.undoLen = live.undo.length;
    review.made = 0;
    return { ok: true };
  }
  if (op.phase !== 'end') return { ok: false, reason: `unknown review phase ${op.phase}` };

  const made = review.made;
  const style = reviewStyleCheck();
  review.active = false;
  review.endSig = liveModelSig();
  const changed = made + style.fixed;
  const bits = [`Review made ${made} change${made === 1 ? '' : 's'}`];
  if (style.fixed) bits.push(`${style.fixed} style fix${style.fixed === 1 ? '' : 'es'}`);
  if (style.flags) bits.push(`${style.flags} to check`);
  if (changed && review.snap) {
    toastAction(bits.join(' · '), 'Undo all', reviewUndoAll);
  } else {
    review.snap = null;
    toast(style.flags ? bits.join(' · ') : 'Review found nothing to change.', 'success', 5000);
  }
  setStatus(op.summary ? `Reviewed: ${op.summary}` : 'Review complete.');
  return { ok: true, text: `${made} review, ${style.fixed} style, ${style.flags} flagged` };
}

// Em dashes and Australian spelling over the whole transcript, plus captions
// the review pushed over the line limit. Fixes go in like any other live
// edit (green, revertable); anything unclear becomes a flag.
function reviewStyleCheck() {
  if (typeof ReviewStyle === 'undefined') return { fixed: 0, flags: 0 };
  const lines = () => liveCueRanges().map((r, i) => ({ n: i + 1, text: liveCueText(r) }));
  // Before the dictionaries load nothing reads as a US spelling, but the
  // dash rule still runs.
  const au = spellDicts ? (w => spellDicts[0].check(w)) : (() => true);
  const us = spellDicts ? (w => spellDicts[1].check(w)) : (() => false);
  const result = ReviewStyle.check(lines(), au, us);
  let fixed = 0;
  for (const line of result.lines) {
    const res = liveApplyText({ op: 'set', cue: line.cue, text: line.text, note: line.note });
    if (res.ok) fixed += line.count;
  }
  const limit = autoFormatMode === 'two_line' ? maxChars * 2 : maxChars;
  const flags = [...result.flags, ...ReviewStyle.overLength(lines(), limit)];
  // A new review's flags replace the last review's.
  api('POST', '/api/live/flags', { flags, replace: true }).catch(() => {});
  return { fixed, flags: flags.length };
}

function reviewUndoAll() {
  if (!review.snap) return;
  if (liveModelSig() !== review.endSig) {
    toast('The transcript has changed since the review, so Undo all would lose that. '
      + 'Click a green word to revert it on its own.', 'warn', 7000);
    return;
  }
  allWords = review.snap.words;
  breakPositions = review.snap.breaks;
  speakerNames = review.snap.names;
  saveSpeakerNames();
  live.undo.length = Math.min(live.undo.length, review.undoLen);
  review.snap = null;
  api('POST', '/api/live/flags', { flags: [], replace: true }).catch(() => {});
  liveRerender();
  toast('Review undone.', 'success', 2500);
}

// Click a green (review-changed) word: what it was, why, and Revert.
let reviewPop = null;
function closeReviewPop() { if (reviewPop) { reviewPop.remove(); reviewPop = null; } }

container.addEventListener('click', (e) => {
  const span = e.target.closest && e.target.closest('.word.live-noted');
  closeReviewPop();
  if (!span) return;
  const idx = Number(span.dataset.idx);
  const w = allWords[idx];
  if (!w || w.liveWas == null) return;
  reviewPop = document.createElement('div');
  reviewPop.className = 'review-pop';
  const note = document.createElement('div');
  note.className = 'review-pop-note';
  note.textContent = String(w.liveNote || '').replace(/ \(was: .*\)$/, '');
  const was = document.createElement('div');
  was.className = 'review-pop-was';
  was.textContent = `Was: ${w.liveWas}`;
  const btn = document.createElement('button');
  btn.className = 'btn-ghost';
  btn.textContent = 'Revert';
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); reviewRevert(idx); });
  reviewPop.append(note, was, btn);
  document.body.appendChild(reviewPop);
  const box = span.getBoundingClientRect();
  reviewPop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 340))}px`;
  reviewPop.style.top = `${box.bottom + 6}px`;
});
document.addEventListener('keydown', closeReviewPop);
window.addEventListener('scroll', closeReviewPop, true);

function reviewRevert(idx) {
  closeReviewPop();
  const w = allWords[idx];
  if (!w || w.liveWas == null) return;
  const n = liveCueOfWord(idx);
  const r = liveCueRanges()[n - 1];
  if (!r || liveCueText(r) !== w.liveNow) {
    toast('That line has been edited since, so change it by hand.', 'warn', 5000);
    return;
  }
  const res = liveApplyText({ op: 'set', cue: n, text: w.liveWas });
  if (!res.ok) { toast(res.reason || 'Could not revert.', 'warn'); return; }
  const r2 = liveCueRanges()[n - 1];
  for (let i = r2.s; i < r2.e; i++) {
    delete allWords[i].liveNote; delete allWords[i].liveWas; delete allWords[i].liveNow;
  }
  review.endSig = null;   // the post-review state no longer exists
  render();
  toast('Reverted.', 'success', 1500);
}

// ── The Review button ──────────────────────────────────────────────────
if (btnReview) {
  setupPopover(btnReview, reviewPopover);
  btnReview.addEventListener('click', () => {
    reviewNoteInput.value = localStorage.getItem(reviewNoteKey()) || '';
    setTimeout(() => reviewNoteInput.focus(), 0);
  });
  reviewNoteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); btnReviewStart.click(); }
  });
  btnReviewStart.addEventListener('click', startReview);
}

async function startReview() {
  const note = reviewNoteInput.value.trim();
  try {
    if (note) localStorage.setItem(reviewNoteKey(), note);
    else localStorage.removeItem(reviewNoteKey());
  } catch (e) { /* storage blocked: the note still goes with this review */ }
  reviewPopover.classList.add('hidden');
  // The server reviews what this tab last published, so publish now.
  liveFlushTyping();
  if (live.publishTimer) clearTimeout(live.publishTimer);
  await livePublish();
  let res;
  try {
    res = await api('POST', '/api/review', { note });
  } catch (e) {
    toast('Could not start the review.', 'error');
    return;
  }
  if (res.error) { toast(res.error, 'error', 6000); return; }
  review.jobId = res.jobId;
  reviewSyncButton();
  setStatus('Starting Claude…');
  review.pollTimer = setInterval(pollReview, 1500);
}

async function pollReview() {
  if (!review.jobId) return;
  let job;
  try {
    job = await api('GET', `/api/review/status?jobId=${review.jobId}`);
  } catch (e) { return; }   // network blip: try again
  if (job.status === 'running') {
    setStatus(`${job.stage || 'Reviewing'}…`);
    return;
  }
  clearInterval(review.pollTimer);
  review.pollTimer = null;
  review.jobId = null;
  reviewSyncButton();
  if (job.status === 'error' || job.error) {
    toast(job.error || 'Review failed.', 'error', 8000);
    setStatus('Review failed.');
    return;
  }
  // The edits themselves already arrived over the live link.
  if (job.skipped && job.skipped.length) {
    toast(`${job.skipped.length} line${job.skipped.length === 1 ? ' was' : 's were'} skipped `
      + 'because you edited them during the review.', 'warn', 6000);
  }
}

(async function checkReview() {
  try {
    const r = await api('GET', '/api/engines');
    review.ready = !!r.review;
    review.reason = r.reviewReason || '';
  } catch (e) {
    review.ready = false;
  }
  reviewSyncButton();
})();

// Open ?open=<srt>, or after a refresh the SRT this tab had open.
restoreOpenSrt();
