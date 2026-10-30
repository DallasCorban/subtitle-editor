// Headless Chrome check of speaker-aware caption breaks in the real editor.
// Not part of the automatic suite: it needs a spare server and a browser.
//   PORT=5001 SUBTITLE_NO_BROWSER=1 python app.py
//   chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<temp dir>
//   node tests/browser_speaker_breaks.js
// Made-up words only; nothing is transcribed and no SRT is saved (no media
// path is set, so auto-save does nothing).
'use strict';
const assert = require('assert');

const APP = process.env.APP_URL || 'http://127.0.0.1:5001/';
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333';
if (/:5000\b/.test(APP)) throw new Error('never point this at the app on port 5000');

let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}\n${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function load() {
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try { if (await js('typeof loadTranscriptionWords === "function" && document.readyState === "complete"')) return; }
    catch (e) { /* page still loading */ }
  }
  throw new Error('editor did not load');
}

// Two speakers trading mid-sentence with no pause or punctuation at the change.
const TEXT = 'so what we found was that the market grew and honestly I would add that it grew fast';
const made = sp => JSON.stringify(TEXT.split(' ').map((w, i) => ({
  word: w, start: i * 0.3, end: i * 0.3 + 0.28, probability: 0.9,
  speaker: sp ? (i < 10 ? 0 : 1) : null,
})));

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}

(async () => {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result || m); pending.delete(m.id); }
  });
  await send('Runtime.enable');
  await load();
  await js('localStorage.clear()');
  await load();

  await test('checkbox defaults on, hidden until a transcript has two speakers', async () => {
    assert.strictEqual(await js('document.getElementById("break-at-speakers").checked'), true);
    assert.strictEqual(await js('document.getElementById("break-at-speakers-row").hidden'), true);
    await js(`loadTranscriptionWords(${made(true)}), 0`);
    assert.strictEqual(await js('document.getElementById("break-at-speakers-row").hidden'), false);
  });

  await test('first transcription breaks at the speaker change', async () => {
    assert.ok(await js('breakPositions.includes(10)'), await js('JSON.stringify(cues.map(c => c.text))'));
    assert.strictEqual(await js('cues.some(c => /grew and honestly/.test(c.text))'), false);
  });

  await test('unticking it is remembered and Apply formatting then ignores speakers', async () => {
    await js(`(() => { const b = document.getElementById("break-at-speakers"); b.checked = false;
      b.dispatchEvent(new Event("change")); })()`);
    assert.strictEqual(await js('localStorage.getItem("breakAtSpeakers")'), 'false');
    await js('document.getElementById("btn-auto-format").click()');
    await sleep(100);
    assert.strictEqual(await js('breakPositions.includes(10)'), false);
    await load();
    assert.strictEqual(await js('document.getElementById("break-at-speakers").checked'), false);
  });

  await test('ticking it again and Apply formatting restores the speaker break', async () => {
    await js(`loadTranscriptionWords(${made(true)}), 0`);
    await js(`(() => { const b = document.getElementById("break-at-speakers"); b.checked = true;
      b.dispatchEvent(new Event("change")); })()`);
    await js('document.getElementById("btn-auto-format").click()');
    await sleep(100);
    assert.ok(await js('breakPositions.includes(10)'));
    assert.strictEqual(await js('localStorage.getItem("breakAtSpeakers")'), 'true');
  });

  await test('Whisper words: row hidden, breaks the same as with the setting off', async () => {
    await js(`loadTranscriptionWords(${made(false)}), 0`);
    assert.strictEqual(await js('document.getElementById("break-at-speakers-row").hidden'), true);
    const on = await js('JSON.stringify(breakPositions)');
    const off = await js('JSON.stringify(CaptionBreaks.computeSmartBreaks(allWords, maxChars))');
    assert.strictEqual(on, off);
  });

  await test('live link: a word added at the start of a reply belongs to the new speaker', async () => {
    await js(`loadTranscriptionWords(${made(true)}), 0`);
    const cue = await js('liveCueOfWord(10)');
    const was = await js(`liveCueText(liveCueRanges()[${cue} - 1])`);
    const res = await js(`liveApplyText({ op: 'set', cue: ${cue}, expect: ${JSON.stringify(was)},
      text: ${JSON.stringify('Well, ' + was)} })`);
    assert.ok(res.ok, JSON.stringify(res));
    assert.strictEqual(await js('allWords[10].word'), 'Well,');
    assert.strictEqual(await js('allWords[10].speaker'), 1);
    assert.ok(await js('breakPositions.includes(10)'), 'the speaker break stays put');
    // Re-breaking afterwards still splits at the same place.
    assert.ok(await js('CaptionBreaks.computeSmartBreaks(allWords, maxChars, { breakAtSpeakers: true }).includes(10)'));
    // Ctrl+Z equivalent for voice edits.
    assert.ok((await js('liveUndoLast()')).ok);
    assert.strictEqual(await js('allWords[10].word'), 'honestly');
  });

  await test('typing a word at the start of a caption takes the next word\'s speaker', async () => {
    await js(`loadTranscriptionWords(${made(true)}), 0`);
    const out = await js(`(() => {
      const toks = allWords.map(w => w.word); toks.splice(10, 0, 'Look,');
      const r = reconcileWords(allWords, toks, new Set([10]));
      return [r[9].speaker, r[10].speaker, r[11].speaker];
    })()`);
    assert.deepStrictEqual(out, [0, 1, 1]);
    // Mid-caption it still follows the word before, as it always has.
    const mid = await js(`(() => {
      const toks = allWords.map(w => w.word); toks.splice(10, 0, 'and');
      return reconcileWords(allWords, toks)[10].speaker;
    })()`);
    assert.strictEqual(mid, 0);
  });

  await test('reassigning a paragraph in the transcript view adds the caption break', async () => {
    const words = JSON.parse(made(true)).map(w => ({ ...w, speaker: 0 }));
    await js(`loadTranscriptionWords(${JSON.stringify(words)}), 0`);
    assert.strictEqual(await js('breakPositions.includes(10)'), false);
    await js(`assignParagraph({ startIdx: 10, endIdx: allWords.length - 1 }, 1)`);
    assert.ok(await js('breakPositions.includes(10)'));
    assert.strictEqual(await js('cues.some(c => /grew and honestly/.test(c.text))'), false);
  });

  ws.close();
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch(e => { console.error(e); process.exit(1); });
