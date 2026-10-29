// ── Review style check ─────────────────────────────────────────────────
// Runs after every AI review, over the whole transcript (the transcriber
// produces US spellings and dashes on its own too). Two house rules:
//   1. no em dashes (nor a spaced en dash used as punctuation);
//   2. Australian spelling.
// It's deterministic on purpose: a prompt alone can't be relied on.
//
// A US-only spelling is a word en_US accepts and en_AU rejects. It's fixed
// automatically only when one of the patterns below turns it into a word
// en_AU accepts; otherwise it's flagged for Ben, never guessed. Capitalised
// words are left alone mid-sentence (names: "Labor", "Pearl Harbor") and
// flagged at the start of a sentence.
//
// Pure functions over cue text, so it runs the same in the browser and
// under node (tests/test_review_style.js). Output is in the live link's
// shape: fixes as {cue, find, replace, reason}, flags as {cue, word,
// suggestion, why}.

(function (root) {
  'use strict';

  const ANCHOR = '[.]';
  const DASHES = new Set(['—', '–', '--']);   // standalone tokens

  // Spellings that are fine in Australia in one sense and not another. Both
  // forms pass en_AU, so only a person can tell; flag every one.
  const UNCLEAR = {
    license: ['licence', 'licence (noun) or license (verb)?'],
    licenses: ['licences', 'licences (noun) or licenses (verb)?'],
    meter: ['metre', 'metre (unit) or meter (a measuring device)?'],
    meters: ['metres', 'metres (unit) or meters (measuring devices)?'],
  };

  // Not spelling patterns, just whole words.
  const WORDS = {
    gray: 'grey', grays: 'greys', grayish: 'greyish',
    jewelry: 'jewellery', aluminum: 'aluminium', plow: 'plough', plows: 'ploughs',
    maneuver: 'manoeuvre', maneuvers: 'manoeuvres', maneuvering: 'manoeuvring',
    pediatric: 'paediatric', pediatrician: 'paediatrician',
    skeptic: 'sceptic', skeptical: 'sceptical', skepticism: 'scepticism',
    mold: 'mould', molds: 'moulds', moldy: 'mouldy',
    pajamas: 'pyjamas',
  };

  // Each pattern proposes one candidate; the first that en_AU accepts wins.
  const PATTERNS = [
    [/iz(e|es|ed|ing|er|ers|ation|ations|able)$/, 'is$1'],   // organize, realization
    [/yz(e|es|ed|ing|er|ers)$/, 'ys$1'],                         // analyze
    [/or(s|ed|ing|ful|fully|less|ite|ites|able|ably|ism|ist|y)?$/, 'our$1'], // colour, favourite
    [/(\w[bcdgkmnprstv])er(s)?$/, '$1re$2'],                     // centre, fibre, kilometre
    [/(\w[bcdgkmnprstv])ered$/, '$1red'],                         // centred
    [/(\w[bcdgkmnprstv])ering$/, '$1ring'],                      // centring
    [/og(s)?$/, 'ogue$1'],                                       // catalogue, analogue
    [/ense(s)?$/, 'ence$1'],                                     // defence, offence
    [/([aeiou])l(ed|ing|er|ers)$/, '$1ll$2'],                    // travelled, cancelled
  ];

  function splitPunct(token) {
    const m = token.match(/^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u);
    return m ? [m[1], m[2], m[3]] : ['', token, ''];
  }

  function matchCase(src, out) {
    if (src === src.toUpperCase() && src.length > 1) return out.toUpperCase();
    if (src[0] === src[0].toUpperCase()) return out[0].toUpperCase() + out.slice(1);
    return out;
  }

  function auSpelling(core, au, us) {
    // Returns {fix} | {flag, suggestion} | null for one bare word.
    const low = core.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(UNCLEAR, low)) {
      const [suggestion, why] = UNCLEAR[low];
      return { flag: why, suggestion: matchCase(core, suggestion) };
    }
    if (low.endsWith("'s")) {
      const r = auSpelling(core.slice(0, -2), au, us);
      if (r && r.fix) return { fix: r.fix + core.slice(-2) };
      return r;
    }
    if (au(low) || au(core) || !us(low)) return null;   // fine, or not a US word
    if (Object.prototype.hasOwnProperty.call(WORDS, low)) {
      const w = WORDS[low];
      return w && au(w) ? { fix: matchCase(core, w) } : { flag: 'US spelling?', suggestion: '' };
    }
    for (const [re, sub] of PATTERNS) {
      if (!re.test(low)) continue;
      const cand = low.replace(re, sub);
      if (cand !== low && au(cand)) return { fix: matchCase(core, cand) };
    }
    return { flag: 'US spelling? (no automatic fix)', suggestion: '' };
  }

  // cues: [{n, text}]; au/us: word -> bool (dictionary checks).
  function check(cues, au, us) {
    const fixes = [];
    const flags = [];
    const lines = [];    // whole new text per changed caption, for applying
    let sentenceStart = true;
    for (const cue of cues) {
      const text = String(cue.text || '');
      if (text.trim() === ANCHOR) continue;
      const toks = text.split(/\s+/).filter(Boolean);
      const firstFix = fixes.length;

      // 1. Dashes. Standalone dash: drop it, comma on the word before.
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (DASHES.has(t)) {
          if (i === 0) {
            fixes.push({ cue: cue.n, find: t, replace: '', reason: 'style: no em dashes' });
          } else {
            const prev = toks[i - 1];
            const rep = /[,.;:!?]$/.test(prev) ? prev : prev + ',';
            fixes.push({ cue: cue.n, find: `${prev} ${t}`, replace: rep, reason: 'style: no em dashes' });
            toks[i - 1] = rep;
          }
          toks.splice(i, 1);
          i--;
        } else if (t.includes('—')) {
          // Joined ("market—and") or trailing/leading.
          let rep = t.replace(/^—+/, '').replace(/—+$/, ',')
            .replace(/\s*—+\s*/g, ', ');
          rep = rep.replace(/([,.;:!?]),$/, '$1');
          fixes.push({ cue: cue.n, find: t, replace: rep, reason: 'style: no em dashes' });
          toks[i] = rep;
        }
      }

      // 2. Spelling, over the dash-fixed tokens.
      for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        const startsSentence = sentenceStart;
        sentenceStart = /[.!?]["')\]]*$/.test(tok);
        if (!tok) continue;
        const [pre, core, post] = splitPunct(tok.replace(/[‘’]/g, "'"));
        if (!core || /\p{N}/u.test(core)) continue;
        const capital = core[0] !== core[0].toLowerCase();
        if (capital && core.length > 1 && core === core.toUpperCase()) continue;  // acronym
        // Hyphenated compounds: check each part.
        const parts = core.split('-');
        let changed = false;
        const outParts = parts.map(p => {
          if (!p) return p;
          const r = auSpelling(p, au, us);
          if (!r) return p;
          if (r.fix && !capital) { changed = true; return r.fix; }
          if (capital && !startsSentence) return p;              // a name
          flags.push({
            cue: cue.n, word: tok,
            suggestion: r.fix || r.suggestion || '',
            why: r.fix ? 'US spelling? Capitalised, so it may be a name' : r.flag,
          });
          return p;
        });
        if (changed) {
          const rep = pre + outParts.join('-') + post;
          fixes.push({ cue: cue.n, find: tok, replace: rep, reason: `style: Australian spelling (was ${core})` });
          toks[i] = rep;
        }
      }

      const mine = fixes.slice(firstFix);
      if (mine.length) {
        lines.push({
          cue: cue.n,
          text: toks.filter(Boolean).join(' '),
          count: mine.length,
          note: mine.map(f => (f.replace ? `${f.find} → ${f.replace}` : `${f.find} removed`)
            + ` (${f.reason})`).join('; '),
        });
      }
    }
    return { fixes, flags, lines };
  }

  // Captions pushed over the line length by the review.
  function overLength(cues, maxChars) {
    if (!maxChars) return [];
    return cues
      .filter(c => String(c.text || '').trim() !== ANCHOR && String(c.text || '').length > maxChars)
      .map(c => ({
        cue: c.n, word: String(c.text).split(/\s+/).slice(-1)[0] || '',
        suggestion: '', why: `this caption is now ${String(c.text).length} characters (limit ${maxChars})`,
      }));
  }

  const api = { check, overLength, auSpelling };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReviewStyle = api;
})(typeof window !== 'undefined' ? window : this);
