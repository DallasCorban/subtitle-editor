"""Tests for timing_merge.py and the sharpened-timing job in transcriber.py.

The fixtures are real: large-v2 Whisper words and Deepgram Nova-3 words for
Ben's MECI "Subscription" voiceover (2 min 25 s). No audio, no API calls.

    py -m unittest discover tests
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import timing_merge  # noqa: E402
import transcriber  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def whisper():
    return load("subscription_whisper_words.json")


def deepgram():
    return load("subscription_deepgram_words.json")


def w(word, start, end, speaker=None, probability=0.9):
    return {"word": word, "start": start, "end": end,
            "probability": probability, "speaker": speaker}


def find(words, text, near):
    """The word with this text closest to `near` seconds (Whisper's time)."""
    hits = [i for i, x in enumerate(words) if x["word"] == text]
    return min(hits, key=lambda i: abs(words[i]["start"] - near))


def assert_monotonic(test, words):
    prev_end = 0.0
    for x in words:
        test.assertGreaterEqual(x["start"], prev_end, x)
        test.assertGreaterEqual(x["end"], x["start"], x)
        prev_end = x["end"]


class RealSubscriptionData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = whisper()
        cls.d = deepgram()
        cls.merged, cls.stats = timing_merge.merge(cls.w, cls.d)

    def test_keeps_every_whisper_word_exactly(self):
        self.assertEqual(len(self.merged), len(self.w))
        for a, b in zip(self.merged, self.w):
            self.assertEqual(a["word"], b["word"])
            self.assertEqual(a["probability"], b["probability"])
            self.assertIsNone(a["speaker"])

    def test_inputs_are_not_modified(self):
        self.assertEqual(self.w, whisper())
        self.assertEqual(self.d, deepgram())

    def test_most_words_take_deepgram_timing(self):
        s = self.stats
        self.assertTrue(s["applied"])
        self.assertGreater(s["matched"] / s["whisper_words"], 0.95)
        self.assertGreater(s["replaced"] / s["whisper_words"], 0.95)
        # Whisper runs a couple of frames early against Deepgram.
        self.assertTrue(30 <= s["median_shift_ms"] <= 120, s["median_shift_ms"])

    def test_monotonic(self):
        assert_monotonic(self, self.merged)

    def test_matched_word_takes_deepgram_times(self):
        i = find(self.merged, "edition", 2.5)
        self.assertEqual((self.merged[i]["start"], self.merged[i]["end"]), (2.56, 2.88))

    def test_number_spelling_matches(self):
        # Whisper "15th", Deepgram "fifteenth" at 2.08-2.56.
        i = find(self.merged, "15th", 2.0)
        self.assertEqual((self.merged[i]["start"], self.merged[i]["end"]), (2.08, 2.56))

    def test_word_run_into_the_next_is_trimmed(self):
        # Deepgram: "entertainment" 11.92-12.96 but "in" starts 12.54.
        i = find(self.merged, "entertainment", 11.8)
        self.assertEqual(self.merged[i]["start"], 11.92)
        self.assertEqual(self.merged[i]["end"], 12.535)
        self.assertEqual(self.merged[i + 1]["start"], 12.535)
        self.assertGreaterEqual(self.stats["trimmed"], 1)

    def test_stretched_word_over_a_dropped_word_is_skipped(self):
        # Deepgram dropped "a" in "subscribe for a particular show" and
        # stretched "for" to 40.05-41.49 (1.44 s). Neither "for" nor "a" may
        # keep that; both fit between "subscribe" and "particular".
        i = find(self.merged, "for", 39.9)
        self.assertEqual(self.merged[i + 1]["word"], "a")
        subscribe, particular = self.merged[i - 1], self.merged[i + 2]
        self.assertEqual(subscribe["end"], 40.05)
        self.assertEqual(particular["start"], 40.335)
        for x in (self.merged[i], self.merged[i + 1]):
            self.assertGreaterEqual(x["start"], subscribe["end"])
            self.assertLessEqual(x["end"], particular["start"])
            self.assertGreater(x["end"], x["start"])
        self.assertGreaterEqual(self.stats["skipped"]["too_long"], 1)

    def test_big_shift_accepted_when_the_boundary_moves(self):
        # Whisper puts "than" at 69.94; Deepgram at 70.47, with "FTA" ending
        # at 70.39. Both sides of the boundary agree, so it moves.
        i = find(self.merged, "than", 69.9)
        self.assertEqual(self.merged[i]["start"], 70.47)
        self.assertEqual(self.merged[i - 1]["end"], 70.39)

    def test_symbols_line_up_with_spoken_words(self):
        # Whisper "-Disney+." against Deepgram "Disney" "plus."
        i = find(self.merged, "-Disney+.", 91.9)
        self.assertEqual((self.merged[i]["start"], self.merged[i]["end"]), (91.92, 92.88))

    def test_summary_line(self):
        line = timing_merge.summary(self.stats)
        self.assertIn("Deepgram timing on", line)
        self.assertIn("ms later", line)
        self.assertNotIn("—", line)  # no em dashes


class Synthetic(unittest.TestCase):
    def test_spoken_numbers(self):
        n = timing_merge._spoken_number
        self.assertEqual(n(["twelve"]), "12")
        self.assertEqual(n(["fifteenth"]), "15th")
        self.assertEqual(n(["twenty", "twenty", "six"]), "2026")
        self.assertEqual(n(["twenty-one"]), "21")
        self.assertEqual(n(["one", "hundred", "and", "five"]), "105")
        self.assertEqual(n(["three", "thousand"]), "3000")
        self.assertIsNone(n(["second"]))
        self.assertIsNone(n(["hundred"]))
        self.assertIsNone(n(["twelve", "apples"]))

    def test_number_spread_over_several_deepgram_words(self):
        ws = [w("In", 0.0, 0.2), w("2026,", 0.2, 0.9), w("we", 0.9, 1.1), w("grew", 1.1, 1.4)]
        ds = [w("In", 0.05, 0.25), w("twenty", 0.25, 0.5), w("twenty", 0.5, 0.7),
              w("six,", 0.7, 0.98), w("we", 1.0, 1.15), w("grew", 1.15, 1.45)]
        out, stats = timing_merge.merge(ws, ds)
        self.assertEqual((out[1]["start"], out[1]["end"]), (0.25, 0.98))
        self.assertEqual(stats["replaced"], 4)

    def test_twelve_and_us_spelling(self):
        ws = [w("And", 0.0, 0.2), w("12", 0.2, 0.5), w("cancelled", 0.5, 1.0), w("it.", 1.0, 1.3)]
        ds = [w("And", 0.1, 0.3), w("twelve", 0.3, 0.6), w("canceled", 0.6, 1.1), w("it.", 1.1, 1.35)]
        out, stats = timing_merge.merge(ws, ds)
        self.assertEqual([x["word"] for x in out], ["And", "12", "cancelled", "it."])
        self.assertEqual([x["start"] for x in out], [0.1, 0.3, 0.6, 1.1])
        self.assertEqual(stats["matched"], 4)

    def test_word_deepgram_dropped_is_interpolated(self):
        ws = [w("tell", 0.0, 0.3), w("it", 0.3, 0.5), w("differently.", 0.5, 1.2), w("Then", 2.0, 2.2)]
        ds = [w("tell", 0.1, 0.4), w("it.", 0.4, 0.6), w("Then", 2.1, 2.3)]
        out, stats = timing_merge.merge(ws, ds)
        self.assertEqual(stats["interpolated"], 1)
        # Shifted with its neighbours (+0.1), kept inside the gap.
        self.assertEqual((out[2]["start"], out[2]["end"]), (0.6, 1.3))
        assert_monotonic(self, out)

    def test_lone_big_shift_is_skipped(self):
        ws = [w("one", 0.0, 0.3), w("two", 0.4, 0.7), w("three", 0.8, 1.1), w("four", 1.2, 1.5)]
        ds = [w("one", 0.0, 0.3), w("two", 0.4, 0.7), w("three", 1.3, 1.45), w("four", 1.25, 1.5)]
        out, stats = timing_merge.merge(ws, ds)
        self.assertEqual(stats["skipped"]["big_shift"], 1)
        self.assertEqual(out[2]["start"], 0.8)

    def test_too_short_is_skipped(self):
        ws = [w("a", 0.0, 0.2), w("b", 0.2, 0.4), w("c", 0.4, 0.6)]
        ds = [w("a", 0.0, 0.2), w("b", 0.25, 0.26), w("c", 0.4, 0.6)]
        out, stats = timing_merge.merge(ws, ds)
        self.assertEqual(stats["skipped"]["too_short"], 1)
        assert_monotonic(self, out)

    def test_never_goes_backwards_on_bad_input(self):
        ws = [w(t, i * 0.3, i * 0.3 + 0.25) for i, t in enumerate("a b c d e f".split())]
        ds = [w("a", 0.0, 0.2), w("b", 0.9, 1.0), w("c", 0.3, 0.5),
              w("d", 0.95, 1.4), w("e", 1.2, 1.3), w("f", 1.5, 1.7)]
        out, _ = timing_merge.merge(ws, ds)
        assert_monotonic(self, out)

    def test_no_deepgram_words_returns_whisper_unchanged(self):
        ws = [w("hello", 0.0, 0.5), w("there", 0.5, 0.9)]
        out, stats = timing_merge.merge(ws, [])
        self.assertEqual(out, ws)
        self.assertFalse(stats["applied"])
        self.assertIn("not applied", timing_merge.summary(stats))

    def test_unrelated_transcript_is_not_merged(self):
        ws = [w(t, i * 0.4, i * 0.4 + 0.3) for i, t in enumerate("the quick brown fox jumps".split())]
        ds = [w(t, i * 0.4 + 0.1, i * 0.4 + 0.35) for i, t in enumerate("lorem ipsum dolor sit amet".split())]
        out, stats = timing_merge.merge(ws, ds)
        self.assertFalse(stats["applied"])
        self.assertEqual(out, ws)

    def test_speakers_kept_only_when_asked(self):
        ws = [w("Hi", 0.0, 0.2), w("Pete.", 0.2, 0.5), w("um", 0.6, 0.7), w("Thanks.", 1.0, 1.3)]
        ds = [w("Hi", 0.05, 0.25, 0), w("Pete.", 0.25, 0.55, 0), w("Thanks.", 1.05, 1.35, 1)]
        out, _ = timing_merge.merge(ws, ds)
        self.assertEqual([x["speaker"] for x in out], [None] * 4)
        out, _ = timing_merge.merge(ws, ds, keep_speakers=True)
        self.assertEqual([x["speaker"] for x in out], [0, 0, 0, 1])


class SharpenedJob(unittest.TestCase):
    """transcriber's Whisper + Deepgram job, with both engines mocked."""

    def run_job(self, dg_side_effect, keep_speakers=False):
        def fake_whisper(job, file_path, language, model):
            job["model"] = "large-v2"
            job["words"] = whisper()

        job = {"words": [], "model": "", "stage": "", "speakers": 0,
               "deepgram": {"stage": "starting", "progress": 0.0},
               "timing_stats": None, "timing_summary": "", "timing_warning": ""}
        with mock.patch.object(transcriber, "_transcribe_with_whisper", fake_whisper), \
                mock.patch("deepgram_client.transcribe", side_effect=dg_side_effect) as dg:
            transcriber._transcribe_sharpened(job, "x.mp3", "en", None, keep_speakers)
        return job, dg

    def test_merges(self):
        job, dg = self.run_job(lambda *a, **k: deepgram())
        self.assertEqual(dg.call_args.kwargs["diarize"], False)
        self.assertTrue(job["timing_stats"]["applied"])
        self.assertEqual(job["timing_warning"], "")
        self.assertIn("nova-3 timing", job["model"])
        self.assertEqual([x["word"] for x in job["words"]], [x["word"] for x in whisper()])
        self.assertNotEqual(job["words"], whisper())
        self.assertEqual(job["deepgram"]["stage"], "done")

    def test_deepgram_failure_keeps_whisper(self):
        def boom(*a, **k):
            raise RuntimeError("Deepgram rejected the API key. Check DEEPGRAM_API_KEY.")
        job, _ = self.run_job(boom)
        self.assertEqual(job["words"], whisper())
        self.assertIn("Deepgram timing failed", job["timing_warning"])
        self.assertIn("rejected the API key", job["timing_warning"])
        self.assertEqual(job["model"], "large-v2")
        self.assertEqual(job["deepgram"]["stage"], "failed")

    def test_speakers_requested(self):
        job, dg = self.run_job(lambda *a, **k: deepgram(), keep_speakers=True)
        self.assertEqual(dg.call_args.kwargs["diarize"], True)
        # The fixture came from a diarised run, which split Ben's one voice
        # into several speakers; the merge carries those through.
        dg_speakers = {x["speaker"] for x in deepgram()}
        self.assertEqual(job["speakers"], len(dg_speakers))
        self.assertTrue(all(x["speaker"] in dg_speakers for x in job["words"]))


if __name__ == "__main__":
    unittest.main()
