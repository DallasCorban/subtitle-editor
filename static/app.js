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

// Flat model — each word is {word, start, end, resolveId}
let allWords       = [];      // [{word:"hello", start:0.0, end:0.4, resolveId:null}, …]
let breakPositions = [];      // sorted indices into allWords where a new cue starts
let wordTimingMode = false;   // true when allWords have real Whisper timestamps

// Drag
let dragState      = null;    // { breakIdx, sourceEl, min, max, currentTarget }

// Transcription
let transcribeJobId = null;
let transcribePollTimer = null;
let sourceFilePath = null;  // original media file path (for auto-saving SRT next to it)
let srtVersion     = 0;     // incremented each time user clicks "Save new version"

// ── DOM refs ───────────────────────────────────────────────────────────
const btnBrowse        = document.getElementById('btn-browse');
const fileNameDisplay  = document.getElementById('file-name-display');
const btnSave          = document.getElementById('btn-save');
const btnSaveAs        = document.getElementById('btn-save-as');
const btnAutoFormat    = document.getElementById('btn-auto-format');
const btnReadResolve   = document.getElementById('btn-read-resolve');
const btnPushResolve   = document.getElementById('btn-push-resolve');
const maxCharsInput    = document.getElementById('max-chars');
const formatModeSelect = document.getElementById('format-mode');
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
const transcribeBar    = document.getElementById('transcribe-progress');
const transcribeFill   = document.getElementById('transcribe-progress-fill');
const btnExportWordSrt = document.getElementById('btn-export-word-srt');
const timingBadge      = document.getElementById('timing-badge');

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
        resolveId: cue.resolveId || null,
      });
    });

    if (i < cues.length - 1) breakPositions.push(allWords.length);
  });
}

function flatModelToCues() {
  const cuts = [0, ...breakPositions, allWords.length];
  const newCues = [];

  for (let i = 0; i < cuts.length - 1; i++) {
    const groupWords = allWords.slice(cuts[i], cuts[i + 1]);
    if (!groupWords.length) continue;

    const text = groupWords.map(w => w.word).join(' ');
    const sMs  = Math.round(groupWords[0].start * 1000);
    const eMs  = Math.round(groupWords[groupWords.length - 1].end * 1000);

    newCues.push({
      index: i + 1,
      startTime: msToTime(sMs),
      endTime: msToTime(eMs),
      text,
    });
  }
  return newCues;
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
    resolveId: null,
  }));
  wordTimingMode = true;

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

  emptyState.style.display     = allWords.length ? 'none' : '';
  cueCountEl.textContent       = cues.length ? `${cues.length} cues` : '';
  btnSave.disabled             = !cues.length;
  btnSaveAs.disabled           = !cues.length;
  btnAutoFormat.disabled       = !cues.length;
  btnReadResolve.disabled      = !resolveOk;
  btnPushResolve.disabled      = !cues.length;  // always available when cues exist
  btnExportWordSrt.disabled    = !allWords.length;

  // Update timing badge
  if (timingBadge) {
    timingBadge.textContent = wordTimingMode ? 'Word-timed' : 'SRT-timed';
    timingBadge.className   = 'timing-badge ' + (wordTimingMode ? 'badge-word' : 'badge-srt');
  }

  if (!allWords.length) return;

  const view = document.createElement('div');
  view.id = 'script-view';
  view.className = 'script-flow';

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
    span.textContent = wordObj.word;
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
    autoLivePush();
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
// ADD / REMOVE BREAKS
// ═══════════════════════════════════════════════════════════════════════

function onDoubleClick(e) {
  const wordEl = e.target.closest('.word');
  if (!wordEl) return;

  const idx = parseInt(wordEl.dataset.idx);
  const insertPos = idx + 1;

  if (insertPos >= allWords.length) return;
  if (breakPositions.includes(insertPos)) return;

  breakPositions.push(insertPos);
  breakPositions.sort((a, b) => a - b);
  cues = flatModelToCues();
  render();
  toast('Break added. Double-click the blue line to remove it.', 'success');
  setStatus('Break added.');
  autoSaveSRT(true);
  autoLivePush();
}

function removeBreak(breakIdx) {
  if (breakPositions.length <= 0) return;
  breakPositions.splice(breakIdx, 1);
  cues = flatModelToCues();
  render();
  toast('Break removed (cues merged).', 'success');
  setStatus('Cues merged.');
  autoSaveSRT(true);
  autoLivePush();
}

// ═══════════════════════════════════════════════════════════════════════
// LIVE RESOLVE PUSH (word-level grouping)
// ═══════════════════════════════════════════════════════════════════════

async function autoLivePush() {
  if (!resolveOk) return;
  if (!allWords.some(w => w.resolveId)) return;

  try {
    const res = await api('POST', '/api/resolve/push-word-groups', {
      words: allWords.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        resolveId: w.resolveId,
      })),
      breakPositions,
    });
    if (res.success && res.updated > 0) {
      toast(`Live update: ${res.updated} items.`, 'success', 1500);
    }
  } catch (e) { /* silent fail for auto-push */ }
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
  // Don't touch btnPushResolve here — it's always available when cues exist
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
  resolveLabel.textContent = 'Connecting…';
  const r = await api('POST', '/api/resolve/connect');
  updateResolvePill(r);
  toast(r.connected ? `Connected to Resolve ${r.version}` : (r.error || 'Could not connect.'),
    r.connected ? 'success' : 'error', r.connected ? 3000 : 6000);
});

// Load SRT file via native dialog (gets full path for auto-save)
btnBrowse.addEventListener('click', async () => {
  try {
    const browse = await api('POST', '/api/browse-file', { mode: 'srt' });
    if (!browse.path) return;  // user cancelled

    setStatus('Loading…');
    const res = await api('POST', '/api/load-srt', { filePath: browse.path });
    if (res.error) { toast(res.error, 'error'); setStatus('Error.'); return; }

    cues = res.cues;
    fileName = browse.path.split(/[/\\]/).pop();
    // Set sourceFilePath to the folder of the SRT, pointing at the video
    // (strip _vN suffix if present, then look for common video extensions)
    sourceFilePath = browse.path.replace(/(_v\d+)?\.srt$/i, '');
    // If the base file doesn't exist with a known extension, just use the SRT path
    // so auto-save overwrites the SRT itself
    sourceFilePath = browse.path.replace(/\.srt$/i, '');

    fileNameDisplay.textContent = fileName;
    fileNameDisplay.classList.add('loaded');
    wordTimingMode = false;
    allWords = [];
    srtVersion = 0;
    render();
    setStatus(`Loaded ${res.count} cues from ${fileName}`);
    toast(`Loaded ${res.count} cues. Auto-save active.`, 'success');
  } catch (err) { toast('Failed to load file.', 'error'); setStatus('Error.'); }
});

// Auto-format
btnAutoFormat.addEventListener('click', async () => {
  setStatus('Formatting…');
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
btnExportWordSrt.addEventListener('click', async () => {
  if (!allWords.length) { toast('No words to export.', 'warn'); return; }
  setStatus('Generating word-level SRT…');
  try {
    const res = await api('POST', '/api/export-word-srt', {
      words: allWords.map(w => ({ word: w.word, start: w.start, end: w.end })),
    });
    if (res.error) { toast(res.error, 'error'); return; }
    const blob = new Blob([res.srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const wordFileName = fileName.replace(/\.srt$/i, '') + '_words.srt';
    a.href = url; a.download = wordFileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Word-level SRT downloaded. Import this into Resolve for live mode.', 'success', 5000);
    setStatus(`Exported ${wordFileName}`);
  } catch (e) { toast('Export failed.', 'error'); }
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
  setStatus('Reading from DaVinci Resolve…');
  try {
    const res = await api('GET', '/api/resolve/read');
    if (res.error) {
      toast(res.error, 'error');
      setStatus('Error.');
      return;  // Don't wipe editor state on error
    }

    const readCues = res.cues.map((c, i) => ({ ...c, index: i + 1 }));

    if (!readCues.length) {
      toast('No subtitle items found in Resolve.', 'warn');
      setStatus('No items in Resolve.');
      return;  // Don't wipe editor state on empty result
    }

    // Detect word-level track: most cues are single words
    const singleWordCues = readCues.filter(c => c.text.trim().split(/\s+/).length === 1);
    const isWordLevel = readCues.length > 10 && singleWordCues.length / readCues.length > 0.8;

    if (isWordLevel) {
      // Word-level track — build allWords directly with resolveIds, then smart-group
      allWords = readCues.map(c => ({
        word: c.text.trim(),
        start: timeToMs(c.startTime) / 1000,
        end: timeToMs(c.endTime) / 1000,
        resolveId: c.resolveId || null,
      }));
      wordTimingMode = true;
      breakPositions = computeInitialBreaks(allWords);
      cues = flatModelToCues();
      render();
      toast(`Read ${allWords.length} words from Resolve (word-level track, track ${res.trackUsed}). Smart breaks applied.`, 'success', 5000);
      setStatus(`Loaded ${allWords.length} words from Resolve — ${cues.length} cues.`);
    } else {
      // Normal subtitle track — load as cues
      cues = readCues;
      allWords = [];
      wordTimingMode = false;
      render();
      toast(`Read ${cues.length} cues from Resolve (track ${res.trackUsed}).`, 'success');
      setStatus(`Loaded ${cues.length} cues from DaVinci Resolve.`);
    }
  } catch (e) { toast('Could not read from Resolve.', 'error'); }
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
    const res = await api('POST', '/api/transcribe', { filePath });
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

    // Update progress bar
    const pct = Math.round((job.progress || 0) * 100);
    transcribeFill.style.width = pct + '%';
    setStatus(`Transcribing… ${pct}%`);

    if (job.status === 'complete') {
      stopTranscriptionPolling();

      if (job.words && job.words.length) {
        loadTranscriptionWords(job.words);
        fileName = (job.file || 'transcription').replace(/\.[^.]+$/, '') + '.srt';
        fileNameDisplay.textContent = job.file || 'Transcription';
        fileNameDisplay.classList.add('loaded');
        toast(`Transcribed ${job.words.length} words.`, 'success');
        setStatus(`Transcription complete — ${job.words.length} words, ${cues.length} cues.`);

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
