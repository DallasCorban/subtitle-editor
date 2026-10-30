"""The auto-reloader waits for running work before restarting the server."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app  # noqa: E402


class WaitUntilIdleTest(unittest.TestCase):
    def run_wait(self, transcribing, reviewing=(), pending=()):
        """Each sequence gives the busy answer per check; then idle."""
        def answers(seq):
            it = iter(seq)
            return lambda *a: next(it, False)
        clock = [0.0]
        sleeps = []

        def fake_sleep(s):
            sleeps.append(s)
            clock[0] += s

        with mock.patch.object(app.transcriber, 'is_busy', answers(transcribing)), \
             mock.patch.object(app.reviewer, 'busy', answers(reviewing)), \
             mock.patch.object(app.live, 'has_pending', answers(pending)), \
             mock.patch('time.sleep', fake_sleep), \
             mock.patch('time.time', lambda: clock[0]), \
             mock.patch('builtins.print'):
            app._wait_until_idle()
        return clock[0]

    def test_idle_waits_only_the_quiet_period(self):
        self.assertLessEqual(self.run_wait([]), app.RELOAD_IDLE_S + 1)

    def test_waits_for_a_transcription(self):
        waited = self.run_wait([True] * 30)
        self.assertGreaterEqual(waited, 30 + app.RELOAD_IDLE_S)

    def test_waits_for_a_review_and_queued_edits(self):
        self.assertGreaterEqual(self.run_wait([], reviewing=[True] * 10), 10 + app.RELOAD_IDLE_S)
        self.assertGreaterEqual(self.run_wait([], pending=[True] * 4), 4 + app.RELOAD_IDLE_S)


if __name__ == '__main__':
    unittest.main()
