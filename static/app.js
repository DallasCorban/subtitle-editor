/* ═══════════════════════════════════════════════════════════════════════
   Subtitle Editor — script-flow view
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let cues           = [];
let fileName       = 'subtitles.srt';
let resolveOk      = false;
let maxChars       = 42;
let autoFormatMode = 'two_line';

// Flat model (rebuilt on every render)
let allWords       = [];      // ["hello", "world", …]
let breakPositions = [];      // sorted indices into allWords where a new cue starts

// Drag
let dragState      = null;    // { breakIdx, sourceEl }

// ── DOM refs ───────────────────────────────────────────────────────────
const filePicker      = document.getElementById('file-picker');
const btnBrowse       = document.getElementById('btn-browse');
const fileNameDisplay = document.getElementById('file-name-display');
const btnSave         = document.getElementById('btn-save');
const btnSaveAs       = document.getElementById('btn-save-as');
const btnAutoFormat   = document.getElementById('btn-auto-format');
const btnReadResolve  = document.getElementById('btn-read-resolve');
const btnPushResolve  = document.getElementById('btn-push-resolve');
const maxCharsInput   = document.getElementById('max-chars');
const formatModeSelect= document.getElementById('format-mode');
const resolvePill     = document.getElementById('resolve-pill');
const resolveLabel    = document.getElementById('resolve-label');
const container       = document.getElementById('cue-list-container');
const emptyState      = document.getElementById('empty-state');
const statusMsg       = document.getElementById('status-msg');
const cueCountEl      = document.getElementById('cue-count');
const modalOverlay    = document.getElementById('modal-overlay');
const saveAsInput     = document.getElementById('save-as-input');
const btnModalCancel  = document.getElementById('btn-modal-cancel');
const btnModalSave    = document.getElementById('btn-modal-save');

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
    allWords.push(...words);
    if (i < cues.length - 1) breakPositions.push(allWords.length);
  });
}

function flatModelToCues() {
  // Preserve the overall time span; redistribute proportionally at moved boundaries
  const origStart = cues.length ? timeToMs(cues[0].startTime) : 0;
  const origEnd   = cues.length ? timeToMs(cues[cues.length - 1].endTime) : 0;
  const totalDur  = origEnd - origStart;

  const cuts = [0, ...breakPositions, allWords.length];
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    segments.push(allWords.slice(cuts[i], cuts[i + 1]).join(' '));
  }
  const totalChars = segments.reduce((s, t) => s + t.length, 0) || 1;

  const newCues = [];
  let cumChars = 0;
  segments.forEach((text, i) => {
    const sMs = origStart + Math.round(totalDur * cumChars / totalChars);
    cumChars += text.length;
    const eMs = origStart + Math.round(totalDur * cumChars / totalChars);
    newCues.push({
      index: i + 1,
      startTime: msToTime(sMs),
      endTime: msToTime(eMs),
      text,
    });
  });
  return newCues;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════

function render() {
  buildFlatModel();

  const old = document.getElementById('script-view');
  if (old) old.remove();

  emptyState.style.display = allWords.length ? 'none' : '';
  cueCountEl.textContent   = cues.length ? `${cues.length} cues` : '';
  btnSave.disabled         = !cues.length;
  btnSaveAs.disabled       = !cues.length;
  btnAutoFormat.disabled   = !cues.length;
  btnReadResolve.disabled  = !resolveOk;
  btnPushResolve.disabled  = !resolveOk || !cues.length;

  if (!allWords.length) return;

  const view = document.createElement('div');
  view.id = 'script-view';
  view.className = 'script-flow';

  let breakIdx = 0;

  allWords.forEach((word, idx) => {
    // Insert break marker before this word if it's a break position
    if (breakIdx < breakPositions.length && breakPositions[breakIdx] === idx) {
      view.appendChild(createBreakMarker(breakIdx, idx));
      breakIdx++;
    } else if (idx > 0) {
      view.appendChild(document.createTextNode(' '));
    }

    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word;
    span.dataset.idx = idx;
    view.appendChild(span);
  });

  // Double-click on a word → insert a break after it
  view.addEventListener('dblclick', onDoubleClick);

  container.appendChild(view);
}

function createBreakMarker(breakIdx, wordIdx) {
  const marker = document.createElement('span');
  marker.className = 'cue-break';
  marker.dataset.breakIdx = breakIdx;

  // Tooltip label
  const label = document.createElement('span');
  label.className = 'break-label';
  label.textContent = `${breakIdx + 1} | ${shortTime(cues[breakIdx].endTime)}`;
  marker.appendChild(label);

  // Drag
  marker.addEventListener('mousedown', (e) => {
    e.preventDefault();
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
  // Constraints: break can't cross adjacent breaks
  const prevBreak = breakIdx > 0 ? breakPositions[breakIdx - 1] : 0;
  const nextBreak = breakIdx < breakPositions.length - 1
    ? breakPositions[breakIdx + 1] : allWords.length;

  dragState = {
    breakIdx,
    sourceEl,
    min: prevBreak + 1,          // at least 1 word in cue above
    max: nextBreak,              // break position = first word of cue below; max keeps 1 word below
    currentTarget: null,
  };

  sourceEl.classList.add('dragging-source');
  document.body.classList.add('is-dragging');
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;

  // Clear previous indicator
  const prev = document.querySelector('.drop-target-before');
  if (prev) prev.classList.remove('drop-target-before');

  const target = findNearestGap(e.clientX, e.clientY);
  if (target === null) return;

  // Clamp to valid range
  const clamped = Math.max(dragState.min, Math.min(dragState.max - 1, target));
  dragState.currentTarget = clamped;

  // Show indicator on the word at position `clamped` (the first word of the "below" cue)
  const wordEl = document.querySelector(`.script-flow .word[data-idx="${clamped}"]`);
  if (wordEl) wordEl.classList.add('drop-target-before');
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  if (!dragState) return;

  const { breakIdx, sourceEl, currentTarget } = dragState;

  // Clean up
  sourceEl.classList.remove('dragging-source');
  document.body.classList.remove('is-dragging');
  const ind = document.querySelector('.drop-target-before');
  if (ind) ind.classList.remove('drop-target-before');

  // Commit move
  if (currentTarget !== null && currentTarget !== breakPositions[breakIdx]) {
    breakPositions[breakIdx] = currentTarget;
    breakPositions.sort((a, b) => a - b);
    cues = flatModelToCues();
    render();
    setStatus('Break moved.');
  }

  dragState = null;
}

function findNearestGap(cx, cy) {
  // Find the word whose left edge is closest to the cursor → break goes before that word
  const wordEls = document.querySelectorAll('.script-flow .word');
  let best = null;
  let bestDist = Infinity;

  wordEls.forEach(el => {
    const rect = el.getBoundingClientRect();
    const idx = parseInt(el.dataset.idx);

    // Gap before this word: use left edge center
    const dx = cx - rect.left;
    const dy = cy - (rect.top + rect.height / 2);
    const dist = Math.abs(dx) + Math.abs(dy) * 0.5; // weight Y less

    if (dist < bestDist) {
      bestDist = dist;
      best = idx;
    }
  });

  return best;
}

// ═══════════════════════════════════════════════════════════════════════
// ADD / REMOVE BREAKS
// ═══════════════════════════════════════════════════════════════════════

function onDoubleClick(e) {
  const wordEl = e.target.closest('.word');
  if (!wordEl) return;

  const idx = parseInt(wordEl.dataset.idx);
  const insertPos = idx + 1; // break after the clicked word

  // Don't insert if there's already a break here, or at the very end
  if (insertPos >= allWords.length) return;
  if (breakPositions.includes(insertPos)) return;

  breakPositions.push(insertPos);
  breakPositions.sort((a, b) => a - b);
  cues = flatModelToCues();
  render();
  toast('Break added. Double-click the blue line to remove it.', 'success');
  setStatus('Break added.');
}

function removeBreak(breakIdx) {
  if (breakPositions.length <= 0) return;
  breakPositions.splice(breakIdx, 1);
  cues = flatModelToCues();
  render();
  toast('Break removed (cues merged).', 'success');
  setStatus('Cues merged.');
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function wordsOf(cue) {
  return cue.text.replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
}

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
  btnPushResolve.disabled = !resolveOk || !cues.length;
}
async function checkResolveStatus() {
  try { updateResolvePill(await api('GET', '/api/resolve/status')); }
  catch (e) { /* ignore */ }
}
setInterval(checkResolveStatus, 8000);
checkResolveStatus();

// ═══════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════

// Settings
maxCharsInput.addEventListener('change', () => {
  maxChars = Math.max(10, Math.min(120, +maxCharsInput.value));
  maxCharsInput.value = maxChars;
});
formatModeSelect.addEventListener('change', () => { autoFormatMode = formatModeSelect.value; });

// Resolve pill
resolvePill.addEventListener('click', async () => {
  resolvePill.className = 'pill pill-idle';
  resolveLabel.textContent = 'Connecting\u2026';
  const r = await api('POST', '/api/resolve/connect');
  updateResolvePill(r);
  toast(r.connected ? `Connected to Resolve ${r.version}` : (r.error || 'Could not connect.'),
    r.connected ? 'success' : 'error', r.connected ? 3000 : 6000);
});

// Load SRT
btnBrowse.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', () => {
  const file = filePicker.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    setStatus('Parsing\u2026');
    try {
      const res = await api('POST', '/api/parse-srt', { content: e.target.result, filename: file.name });
      if (res.error) { toast(res.error, 'error'); setStatus('Error.'); return; }
      cues = res.cues;
      fileName = res.filename;
      fileNameDisplay.textContent = file.name;
      fileNameDisplay.classList.add('loaded');
      render();
      setStatus(`Loaded ${res.count} cues from ${file.name}`);
      toast(`Loaded ${res.count} cues.`, 'success');
    } catch (err) { toast('Failed to parse file.', 'error'); setStatus('Error.'); }
    filePicker.value = '';
  };
  reader.readAsText(file);
});

// Auto-format
btnAutoFormat.addEventListener('click', async () => {
  setStatus('Formatting\u2026');
  try {
    const res = await api('POST', '/api/format', { cues, maxChars, mode: autoFormatMode });
    if (res.error) { toast(res.error, 'error'); return; }
    cues = res.cues;
    render();
    toast('Auto-format applied.', 'success');
    setStatus('Formatted.');
  } catch (e) { toast('Formatting failed.', 'error'); }
});

// Download SRT
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

// Read from Resolve
btnReadResolve.addEventListener('click', async () => {
  setStatus('Reading from DaVinci Resolve\u2026');
  try {
    const res = await api('GET', '/api/resolve/read');
    if (res.error) { toast(res.error, 'error'); setStatus('Error.'); return; }
    cues = res.cues.map((c, i) => ({ ...c, index: i + 1 }));
    render();
    toast(`Read ${cues.length} cues from Resolve.`, 'success');
    setStatus(`Loaded ${cues.length} cues from DaVinci Resolve.`);
  } catch (e) { toast('Could not read from Resolve.', 'error'); }
});

// Push to Resolve
btnPushResolve.addEventListener('click', async () => {
  const withIds = cues.filter(c => c.resolveId);
  if (!withIds.length) {
    toast('No Resolve IDs \u2014 use "Read from Resolve" first.', 'warn', 5000);
    return;
  }
  setStatus('Pushing to DaVinci Resolve\u2026');
  try {
    const res = await api('POST', '/api/resolve/push-all', { cues });
    if (res.error) { toast(res.error, 'error'); return; }
    toast(`Updated ${res.updated} cue(s) in Resolve.`, 'success');
    setStatus(`Pushed ${res.updated} cues to DaVinci Resolve.`);
  } catch (e) { toast('Push to Resolve failed.', 'error'); }
});
