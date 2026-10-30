// Tests for static/caption_breaks.js, the caption break optimiser.
//   node tests/test_caption_breaks.js
'use strict';
const assert = require('assert');
const path = require('path');

const C = require(path.join(path.resolve(__dirname, '..'), 'static/caption_breaks.js'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}

// Made-up words, evenly spaced with no pauses: "text" is split on spaces,
// speakers is one id per word (or null for a Whisper transcript).
function words(text, speakers) {
  return text.split(' ').map((w, i) => ({
    word: w, start: i * 0.3, end: i * 0.3 + 0.28,
    speaker: speakers ? speakers[i] : null,
  }));
}

// Caption texts for a set of breaks.
function captions(ws, breaks) {
  const cuts = [0, ...breaks, ws.length];
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push(ws.slice(cuts[i], cuts[i + 1]).map(w => w.word).join(' '));
  return out;
}

// Two speakers trading mid-sentence, with no pause or punctuation at the
// change, so nothing but the speaker id says to break there.
const TEXT = 'so what we found was that the market grew and honestly I would add that it grew fast';
const SPEAKERS = TEXT.split(' ').map((w, i) => (i < 10 ? 0 : 1));   // speaker 1 from "honestly"

test('a new speaker always starts a new caption', () => {
  const ws = words(TEXT, SPEAKERS);
  const breaks = C.computeSmartBreaks(ws, 42, { breakAtSpeakers: true });
  assert.ok(breaks.includes(10), `breaks ${breaks} should include 10`);
  for (const cap of captions(ws, breaks)) assert.ok(cap.length <= 42, cap);
});

test('without the setting the optimiser runs across the change', () => {
  const ws = words(TEXT, SPEAKERS);
  const off = C.computeSmartBreaks(ws, 42, { breakAtSpeakers: false });
  assert.ok(!off.includes(10), `breaks ${off} happened to land on the change; pick other test text`);
  assert.deepStrictEqual(off, C.computeSmartBreaks(ws, 42));
});

test('no caption ever holds two speakers, at any line length', () => {
  const ids = [0, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0];
  const ws = words('one two three four five six seven eight nine ten eleven twelve '
    + 'thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', ids);
  for (const limit of [12, 20, 42, 80, 120]) {
    const cuts = [0, ...C.computeSmartBreaks(ws, limit, { breakAtSpeakers: true }), ws.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      const sp = new Set(ws.slice(cuts[i], cuts[i + 1]).map(w => w.speaker));
      assert.strictEqual(sp.size, 1, `limit ${limit}: caption ${i + 1} mixes speakers`);
    }
  }
});

test('even a long pause tolerance can not join two speakers: one word replies get their own caption', () => {
  const ws = words('That is the plan. Right. And then we launch it.', [0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  const caps = captions(ws, C.computeSmartBreaks(ws, 42, { breakAtSpeakers: true }));
  assert.ok(caps.includes('Right.'), JSON.stringify(caps));
});

test('Whisper words (speaker null) break exactly as before', () => {
  const ws = words(TEXT, null);
  const plain = words(TEXT, null).map(({ word, start, end }) => ({ word, start, end }));
  const on = C.computeSmartBreaks(ws, 42, { breakAtSpeakers: true });
  assert.deepStrictEqual(on, C.computeSmartBreaks(ws, 42, { breakAtSpeakers: false }));
  assert.deepStrictEqual(on, C.computeSmartBreaks(plain, 42));
});

test('speakerChanges only counts changes between two known speakers', () => {
  const ws = words('a b c d e f', [null, 0, 0, null, 1, 1]);
  assert.deepStrictEqual(C.speakerChanges(ws), []);
  assert.deepStrictEqual(C.speakerChanges(words('a b c d', [0, 1, 1, 0])), [1, 3]);
  assert.strictEqual(C.hasSpeakers(words('a b', null)), false);
  assert.strictEqual(C.hasSpeakers(words('a b', [null, 3])), true);
});

test('a speaker change on the very first or last word', () => {
  const ws = words('Yes. so we were saying that it works and', [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(C.computeSmartBreaks(ws, 42, { breakAtSpeakers: true })[0], 1);
  const end = words('so we were saying that it works Yes.', [0, 0, 0, 0, 0, 0, 0, 1]);
  const b = C.computeSmartBreaks(end, 42, { breakAtSpeakers: true });
  assert.strictEqual(b[b.length - 1], 7);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
