"""Starting a transcription keeps the SRT already next to the media, and the
latest job is visible from a shell (what the ?transcribe= link relies on)."""

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app  # noqa: E402
import transcriber  # noqa: E402


def _fake_worker(job_id, *args, **kwargs):
    job = transcriber._jobs[job_id]
    job['words'] = [{'word': 'hello', 'start': 0.0, 'end': 0.4}]
    job['status'] = 'complete'
    job['finished_at'] = 1.0


class TranscribeLinkTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.media = os.path.join(self.dir, 'clip.mp3')
        with open(self.media, 'wb') as f:
            f.write(b'not really audio')
        self.client = app.app.test_client()
        transcriber._jobs.clear()
        patcher = mock.patch.object(transcriber, '_run_transcription', _fake_worker)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.dir)
        self.addCleanup(transcriber._jobs.clear)

    def start(self):
        with mock.patch('builtins.print'):
            return self.client.post('/api/transcribe', json={'filePath': self.media})

    def test_existing_srt_is_copied_before_the_job_starts(self):
        srt = os.path.join(self.dir, 'clip.srt')
        with open(srt, 'w', encoding='utf-8') as f:
            f.write('1\n00:00:00,000 --> 00:00:01,000\nBen fixed this\n')
        res = self.start().get_json()
        self.assertTrue(res['jobId'])
        backup = res['backup']
        self.assertRegex(os.path.basename(backup), r'^clip_backup_\d{8}-\d{6}\.srt$')
        with open(backup, encoding='utf-8') as f:
            self.assertIn('Ben fixed this', f.read())
        self.assertTrue(os.path.isfile(srt))   # the original stays until the tab saves

    def test_two_backups_in_one_second_do_not_collide(self):
        with open(os.path.join(self.dir, 'clip.srt'), 'w') as f:
            f.write('x')
        a = self.start().get_json()['backup']
        b = self.start().get_json()['backup']
        self.assertNotEqual(a, b)
        self.assertTrue(os.path.isfile(a) and os.path.isfile(b))

    def test_no_srt_no_backup(self):
        res = self.start().get_json()
        self.assertIsNone(res['backup'])
        self.assertEqual(os.listdir(self.dir), ['clip.mp3'])

    def test_refused_job_leaves_no_backup(self):
        with open(os.path.join(self.dir, 'clip.srt'), 'w') as f:
            f.write('x')
        with mock.patch.object(transcriber, 'is_busy', lambda: True), \
             mock.patch.object(transcriber, '_any_running', lambda: True):
            r = self.start()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(sorted(os.listdir(self.dir)), ['clip.mp3', 'clip.srt'])

    def test_latest_reports_the_job_without_its_words(self):
        self.assertEqual(self.client.get('/api/transcribe/latest').get_json(),
                         {'status': 'none'})
        job_id = self.start().get_json()['jobId']
        latest = self.client.get('/api/transcribe/latest').get_json()
        self.assertEqual(latest['jobId'], job_id)
        self.assertEqual(latest['status'], 'complete')
        self.assertEqual(latest['word_count'], 1)
        self.assertNotIn('words', latest)
        self.assertEqual(latest['srt'], os.path.join(self.dir, 'clip.srt'))


if __name__ == '__main__':
    unittest.main()
