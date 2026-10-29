"""Tests for reviewer.py. The claude CLI is never run: subprocess is mocked.

    py -m unittest discover tests
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import reviewer  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def svod_cues():
    return json.loads((FIXTURES / "svod_cues.json").read_text(encoding="utf-8"))


def fake_run(structured, returncode=0, stdout=None, stderr=""):
    """A stand-in for subprocess.run returning a claude -p JSON result."""
    calls = []

    def run(cmd, **kw):
        calls.append({"cmd": cmd, **kw})
        out = stdout if stdout is not None else json.dumps({
            "type": "result", "subtype": "success", "is_error": False,
            "result": json.dumps(structured), "structured_output": structured,
        })
        return subprocess.CompletedProcess(cmd, returncode, out, stderr)

    run.calls = calls
    return run


class CommandTests(unittest.TestCase):
    def test_command_isolates_the_child(self):
        cmd = reviewer.build_command("claude", "sonnet")
        self.assertEqual(cmd[1], "-p")
        self.assertNotIn("--bare", cmd)   # --bare can't use the normal login
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        for flag in ("--strict-mcp-config", "--restricted", "--no-session-persistence"):
            self.assertIn(flag, cmd)
        self.assertEqual(json.loads(cmd[cmd.index("--json-schema") + 1]), reviewer.EDITS_SCHEMA)
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")

    def test_child_env_drops_nesting_and_api_key(self):
        env = reviewer.child_env({
            "PATH": "x", "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli",
            "ANTHROPIC_API_KEY": "sk-test",
        })
        self.assertEqual(env, {"PATH": "x"})

    def test_transcript_goes_on_stdin_in_a_temp_folder(self):
        run = fake_run({"summary": "s", "edits": []})
        with mock.patch.object(reviewer, "find_claude", return_value="claude"):
            reviewer.review(svod_cues(), note="media subscriptions", runner=run)
        call = run.calls[0]
        self.assertIn("5:esquad*", call["input"])
        self.assertIn("media subscriptions", call["input"])
        self.assertNotIn("esquad", " ".join(call["cmd"]))
        self.assertNotIn("2026_04_subtitle", call["cwd"])
        self.assertNotIn("[.]", call["input"])   # the anchor is never shown

    def test_model_override(self):
        with mock.patch.dict("os.environ", {"SUBTITLE_REVIEW_MODEL": "opus"}):
            self.assertEqual(reviewer.model(), "opus")


class ParseTests(unittest.TestCase):
    def test_real_cli_output_shape(self):
        out = reviewer.parse_output((FIXTURES / "claude_p_output.json").read_text(encoding="utf-8"))
        self.assertIn("edits", out)
        self.assertEqual(out["edits"][0]["from_index"], 4)

    def _err(self, **kw):
        run = fake_run(None, **kw)
        with mock.patch.object(reviewer, "find_claude", return_value="claude"):
            with self.assertRaises(reviewer.ReviewError) as cm:
                reviewer.run_claude("x", runner=run)
        return str(cm.exception)

    def test_not_signed_in(self):
        msg = self._err(returncode=1, stdout="", stderr="Invalid API key · Please run /login")
        self.assertIn("isn't signed in", msg)

    def test_usage_limit(self):
        out = json.dumps({"type": "result", "subtype": "success", "is_error": True,
                          "result": "Claude AI usage limit reached|1761800000"})
        self.assertIn("usage limit", self._err(returncode=1, stdout=out))

    def test_bad_json(self):
        self.assertIn("couldn't run", self._err(stdout="not json at all"))

    def test_wrong_shape(self):
        out = json.dumps({"type": "result", "subtype": "success", "is_error": False,
                          "result": "I think it's fine", "structured_output": None})
        self.assertIn("expected shape", self._err(stdout=out))

    def test_timeout(self):
        def run(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 1)
        with mock.patch.object(reviewer, "find_claude", return_value="claude"):
            with self.assertRaises(reviewer.ReviewError) as cm:
                reviewer.run_claude("x", runner=run)
        self.assertIn("too long", str(cm.exception))

    def test_not_installed(self):
        with mock.patch.object(reviewer, "find_claude", return_value=None):
            with self.assertRaises(reviewer.ReviewError) as cm:
                reviewer.run_claude("x")
        self.assertIn("Claude Code installed", str(cm.exception))


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.flat = reviewer.number_words(svod_cues())

    def edit(self, a, b, original, replacement, reason="r"):
        return {"from_index": a, "to_index": b, "original": original,
                "replacement": replacement, "reason": reason}

    def check(self, *edits):
        return reviewer.validate_edits(self.flat, list(edits))

    def test_svod_swap(self):
        ok, bad = self.check(self.edit(5, 5, "esquad", ["SVOD"]))
        self.assertEqual(bad, [])
        self.assertEqual(ok[0]["cue"], 2)
        self.assertEqual(ok[0]["at"], 4)
        self.assertEqual((ok[0]["find"], ok[0]["replace"]), ("esquad", "SVOD"))

    def test_marker_echoed_back_still_matches(self):
        ok, _ = self.check(self.edit(5, 5, "esquad*", ["SVOD"]))
        self.assertEqual(len(ok), 1)

    def test_rejections(self):
        cases = [
            (self.edit(99, 99, "x", ["y"]), "out of range"),
            (self.edit(5, 4, "x", ["y"]), "out of range"),
            (self.edit(5, 5, "squad", ["SVOD"]), "doesn't match"),
            (self.edit(0, 0, "[.]", ["x"]), "anchor"),
            (self.edit(5, 5, "esquad", []), "empty"),
            (self.edit(5, 5, "esquad", ["subscription", "video", "on", "demand"]), "longer"),
            (self.edit(8, 9, "Netflix changed", ["Netflix", "change"]), "caption boundary"),
            (self.edit(5, 5, "esquad", ["esquad"]), "no change"),
        ]
        for e, why in cases:
            with self.subTest(why=why):
                ok, bad = self.check(e)
                self.assertEqual(ok, [])
                self.assertIn(why, bad[0]["why"])

    def test_overlap_rejected_and_duplicates_merged(self):
        ok, bad = self.check(
            self.edit(5, 6, "esquad services", ["SVOD", "services"]),
            self.edit(5, 5, "esquad", ["SVOD"]),
            self.edit(5, 6, "esquad services", ["SVOD", "services"]),
        )
        self.assertEqual(len(ok), 1)
        self.assertEqual(len(bad), 1)
        self.assertIn("overlaps", bad[0]["why"])

    def test_merge_and_split(self):
        ok, bad = self.check(
            self.edit(11, 12, "Net flicks", ["Netflix"]),
            self.edit(14, 14, "ondemand", ["on", "demand"]),
        )
        self.assertEqual(bad, [])
        self.assertEqual([(e["count"], e["replace"]) for e in ok], [(2, "Netflix"), (1, "on demand")])

    def test_replacement_typography_tidied(self):
        ok, _ = self.check(self.edit(5, 5, "esquad", ["SVOD’s"]))
        self.assertEqual(ok[0]["replace"], "SVOD's")


class ChunkTests(unittest.TestCase):
    def test_short_transcript_is_one_call(self):
        flat = reviewer.number_words(svod_cues())
        self.assertEqual(reviewer.chunk_ranges(flat), [(0, len(flat))])

    def test_long_transcript_splits_on_caption_boundaries_with_overlap(self):
        cues = [{"n": n, "words": [f"w{n}_{k}" for k in range(10)]} for n in range(1, 101)]
        flat = reviewer.number_words(cues)
        ranges = reviewer.chunk_ranges(flat, limit=250, overlap_cues=2)
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], len(flat))
        for (lo, hi), (lo2, _) in zip(ranges, ranges[1:]):
            self.assertEqual(lo % 10, 0)
            self.assertEqual(hi % 10, 0)
            self.assertEqual(hi - lo2, 20)   # two captions of overlap
        covered = set()
        for lo, hi in ranges:
            covered.update(range(lo, hi))
        self.assertEqual(covered, set(range(len(flat))))

    def test_summary_carries_into_later_chunks(self):
        cues = [{"n": n, "words": [f"w{n}_{k}" for k in range(10)]} for n in range(1, 31)]
        run = fake_run({"summary": "a talk about streaming", "edits": []})
        with mock.patch.object(reviewer, "find_claude", return_value="claude"), \
                mock.patch.object(reviewer, "CHUNK_WORDS", 120):
            parts = []
            reviewer.review(cues, runner=run, progress=lambda k, n: parts.append((k, n)))
        self.assertGreater(len(run.calls), 1)
        self.assertNotIn("a talk about streaming", run.calls[0]["input"])
        self.assertIn("a talk about streaming", run.calls[1]["input"])
        self.assertEqual(parts[-1][0], parts[-1][1])


class LiveOpsTests(unittest.TestCase):
    def test_one_set_per_caption_by_position(self):
        flat = reviewer.number_words([{"n": 1, "words": ["the", "the", "esquad", "the", "net", "flicks"]}])
        ok, _ = reviewer.validate_edits(flat, [
            {"from_index": 3, "to_index": 3, "original": "the", "replacement": ["a"], "reason": ""},
            {"from_index": 4, "to_index": 5, "original": "net flicks", "replacement": ["Netflix"], "reason": "brand"},
            {"from_index": 2, "to_index": 2, "original": "esquad", "replacement": ["SVOD"], "reason": "streaming"},
        ])
        ops = reviewer.edits_to_ops(ok)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["text"], "the the SVOD a Netflix")   # the third "the", not the first
        self.assertIn("esquad → SVOD: streaming", ops[0]["note"])

    def test_run_live_review_brackets_edits_and_reads_results(self):
        class FakeLink:
            def doc(self):
                return {"open": True, "file": "a.mov", "rev": 7, "cues": [
                    {"n": c["n"], "text": " ".join(c["words"]), "unsure": c.get("unsure", [])}
                    for c in svod_cues()]}

            def submit(self, ops, rev=None, wait=4):
                self.ops, self.rev = ops, rev
                return {"open": True, "results": [
                    {"id": i, "op": o["op"], "ok": True, "cue": o.get("cue")} for i, o in enumerate(ops)]}

        link = FakeLink()
        answer = {"summary": "Streaming.", "edits": [
            {"from_index": 5, "to_index": 5, "original": "esquad", "replacement": ["SVOD"], "reason": "r"}]}
        with mock.patch.object(reviewer, "find_claude", return_value="claude"):
            res = reviewer.run_live_review({"id": "j1"}, link, runner=fake_run(answer))
        self.assertEqual(link.rev, 7)
        self.assertEqual([o["op"] for o in link.ops], ["review", "set", "review"])
        self.assertEqual(link.ops[1]["text"], "So the rise of SVOD services like Netflix")
        self.assertEqual(res["applied"], 1)
        self.assertEqual(res["changes"], [{"cue": 2, "was": "esquad", "now": "SVOD", "reason": "r"}])

    def test_closed_editor_is_a_plain_error(self):
        class Closed:
            def doc(self):
                return {"open": False, "reason": "No transcript is open in the Subtitle editor."}
        with self.assertRaises(reviewer.ReviewError):
            reviewer.run_live_review({"id": "j"}, Closed())


class EndToEndTests(unittest.TestCase):
    def test_svod_review_returns_only_the_checked_swap(self):
        answer = {"summary": "Streaming services.", "edits": [
            {"from_index": 5, "to_index": 5, "original": "esquad", "replacement": ["SVOD"],
             "reason": "subscription video on demand"},
            {"from_index": 7, "to_index": 7, "original": "lik", "replacement": ["like"],
             "reason": "index off by one"},
        ]}
        with mock.patch.object(reviewer, "find_claude", return_value="claude"):
            res = reviewer.review(svod_cues(), note="media subscriptions", runner=fake_run(answer))
        self.assertEqual([(e["find"], e["replace"]) for e in res["edits"]], [("esquad", "SVOD")])
        self.assertEqual(len(res["rejected"]), 1)
        self.assertEqual(res["summary"], "Streaming services.")


if __name__ == "__main__":
    unittest.main()
