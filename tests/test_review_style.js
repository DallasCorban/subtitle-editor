// Tests for static/review_style.js against the real Hunspell dictionaries.
//   node tests/test_review_style.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Typo = require(path.join(ROOT, 'static/vendor/typo.js'));
const S = require(path.join(ROOT, 'static/review_style.js'));

const dict = n => new Typo(n,
  fs.readFileSync(path.join(ROOT, `static/vendor/dict/${n}.aff`), 'utf8'),
  fs.readFileSync(path.join(ROOT, `static/vendor/dict/${n}.dic`), 'utf8'));
const AU = dict('en_AU'), US = dict('en_US');
const au = w => AU.check(w), us = w => US.check(w);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}

// Apply fixes in order, the way the tab does (find/replace on current text).
function apply(cues, fixes) {
  const out = cues.map(c => ({ ...c }));
  for (const f of fixes) {
    const c = out.find(x => x.n === f.cue);
    assert.ok(c.text.includes(f.find), `fix ${JSON.stringify(f)} doesn't find text in "${c.text}"`);
    c.text = c.text.replace(f.find, f.replace).replace(/\s+/g, ' ').trim();
  }
  return out.map(c => c.text);
}

test('US spellings become Australian', () => {
  const pairs = {
    color: 'colour', colors: 'colours', colored: 'coloured', colorful: 'colourful',
    organize: 'organise', organization: 'organisation', organizing: 'organising',
    realized: 'realised', analyze: 'analyse', center: 'centre', centered: 'centred',
    theater: 'theatre', fiber: 'fibre', catalog: 'catalogue', defense: 'defence',
    offense: 'offence', traveling: 'travelling', canceled: 'cancelled', gray: 'grey',
    jewelry: 'jewellery', aluminum: 'aluminium', favorite: 'favourite',
    behavior: 'behaviour', neighbors: 'neighbours', honor: 'honour', humor: 'humour',
    flavor: 'flavour', kilometer: 'kilometre', skeptical: 'sceptical',
    maneuver: 'manoeuvre', pediatric: 'paediatric', modeling: 'modelling',
    labeled: 'labelled', fueled: 'fuelled',
  };
  const misses = [];
  for (const [u, a] of Object.entries(pairs)) {
    const r = S.auSpelling(u, au, us);
    if (!r || r.fix !== a) misses.push(`${u} -> ${JSON.stringify(r)}`);
  }
  assert.deepStrictEqual(misses, []);
});

test('Australian, ordinary and misspelt words are left alone', () => {
  for (const w of ['colour', 'program', 'dialogue', 'check', 'practice', 'motor', 'the', 'esquad', 'xqzt']) {
    assert.strictEqual(S.auSpelling(w, au, us), null, w);
  }
});

test('unclear words are flagged, not changed', () => {
  const { fixes, flags } = S.check([{ n: 1, text: 'the license and the meter' }], au, us);
  assert.deepStrictEqual(fixes, []);
  assert.deepStrictEqual(flags.map(f => f.suggestion), ['licence', 'metre']);
});

test('capitalised words: names mid-sentence skipped, sentence starts flagged', () => {
  const { fixes, flags } = S.check([
    { n: 1, text: 'Pearl Harbor and the Labor party.' },
    { n: 2, text: 'Color matters.' },
  ], au, us);
  assert.deepStrictEqual(fixes, []);
  assert.deepStrictEqual(flags.map(f => [f.cue, f.word, f.suggestion]), [[2, 'Color', 'Colour']]);
});

test('punctuation, possessives and hyphens survive', () => {
  const cues = [{ n: 1, text: 'the color, "favorite" color-coded behavior\'s end.' }];
  const { fixes } = S.check(cues, au, us);
  assert.deepStrictEqual(apply(cues, fixes), ['the colour, "favourite" colour-coded behaviour\'s end.']);
});

test('every dash form goes, with a comma where needed', () => {
  const cues = [
    { n: 1, text: 'the market — and who pays' },
    { n: 2, text: 'it was big, – really big' },
    { n: 3, text: 'the market—and who pays' },
    { n: 4, text: 'trailing— then' },
    { n: 5, text: '— leading dash' },
    { n: 6, text: 'double -- dash' },
    { n: 7, text: 'years 2019–2020 and on-demand' },
  ];
  const { fixes } = S.check(cues, au, us);
  assert.deepStrictEqual(apply(cues, fixes), [
    'the market, and who pays',
    'it was big, really big',
    'the market, and who pays',
    'trailing, then',
    'leading dash',
    'double, dash',
    'years 2019–2020 and on-demand',
  ]);
  assert.ok(fixes.every(f => f.reason.startsWith('style:')));
});

test('whole changed lines match the fixes applied in order', () => {
  const cues = [
    { n: 1, text: 'the color — and the Color' },
    { n: 2, text: 'nothing to see' },
    { n: 3, text: 'organize the theater' },
  ];
  const { lines } = S.check(cues, au, us);
  assert.deepStrictEqual(lines.map(l => [l.cue, l.text, l.count]), [
    [1, 'the colour, and the Color', 2],
    [3, 'organise the theatre', 2],
  ]);
  assert.ok(lines[0].note.includes('style:'));
});

test('the [.] anchor is never touched', () => {
  const { fixes, flags } = S.check([{ n: 1, text: '[.]' }], au, us);
  assert.deepStrictEqual([fixes, flags], [[], []]);
});

test('SVOD fixture: color and the dash fixed, nothing else', () => {
  const cues = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/svod_cues.json'), 'utf8'))
    .map(c => ({ n: c.n, text: c.words.join(' ') }));
  const { fixes, flags } = S.check(cues, au, us);
  const out = apply(cues, fixes);
  assert.deepStrictEqual(flags, []);
  assert.strictEqual(out[3], 'the colour of the market, and who pays.');
  assert.deepStrictEqual(out.slice(0, 3), cues.slice(0, 3).map(c => c.text));
});

test('captions over the line limit are flagged', () => {
  const f = S.overLength([{ n: 1, text: '[.]' }, { n: 2, text: 'short' }, { n: 3, text: 'x'.repeat(50) }], 42);
  assert.deepStrictEqual(f.map(x => x.cue), [3]);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
