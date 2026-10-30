// ── Caption breaks ─────────────────────────────────────────────────────
// Where to cut a run of timed words into captions. Pure functions over
// {word, start, end, speaker} objects, so they run the same in the browser
// and under node (tests/test_caption_breaks.js).

(function (root) {
  'use strict';

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
  //   • speakers: with breakAtSpeakers set, a cue never spans a change of
  //     speaker: every first word of a new speaker starts a new cue
  function computeSmartBreaks(words, limit, opts = {}) {
    const n = words.length;
    if (n <= 1) return [];

    // forced[k]: a cue must start at words[k]
    const forced = new Uint8Array(n + 1);
    if (opts.breakAtSpeakers) speakerChanges(words).forEach(k => { forced[k] = 1; });

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
        if (forced[i + 1] && i + 1 < j) break;          // would swallow a speaker change
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

  // Indices k where words[k] starts a different speaker from words[k - 1].
  // Only between two known speakers: Whisper words carry speaker null and
  // never force a break.
  function speakerChanges(words) {
    const out = [];
    for (let k = 1; k < words.length; k++) {
      const a = words[k - 1].speaker, b = words[k].speaker;
      if (a != null && b != null && a !== b) out.push(k);
    }
    return out;
  }

  function hasSpeakers(words) {
    return words.some(w => w.speaker != null);
  }

  const api = { computeSmartBreaks, speakerChanges, hasSpeakers, bareWord: _bareWord };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptionBreaks = api;
})(typeof window !== 'undefined' ? window : this);
