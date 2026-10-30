"""Moving Resolve's playhead to a caption: the timecode maths, matching the
subtitle clip, and failing politely when Resolve isn't there."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import resolve_bridge as rb  # noqa: E402


class TimecodeMathsTest(unittest.TestCase):
    def test_round_trip_non_drop(self):
        for fps in (24, 25, 30):
            for tc in ('00:00:00:00', '01:00:00:00', '01:01:23:04', '10:59:59:%02d' % (fps - 1)):
                self.assertEqual(rb.frames_to_timecode(rb.timecode_to_frames(tc, fps), fps), tc)

    def test_one_hour_start(self):
        self.assertEqual(rb.timecode_to_frames('01:00:00:00', 24), 86400)
        self.assertEqual(rb.timecode_to_frames('01:00:00:00', 25), 90000)
        self.assertEqual(rb.timecode_to_frames('01:00:00:00', 30), 108000)
        # Drop frame: an hour of timecode is 107892 real frames at 29.97.
        self.assertEqual(rb.timecode_to_frames('01:00:00;00', 29.97, drop=True), 107892)

    def test_caption_on_a_one_hour_timeline(self):
        # A caption at 00:01:23,160 on a timeline starting at 01:00:00:00.
        secs = rb.srt_time_to_seconds('00:01:23,160')
        for fps, want in ((24, '01:01:23:04'), (25, '01:01:23:04'), (30, '01:01:23:05')):
            start = rb.timecode_to_frames('01:00:00:00', fps)
            got = rb.frames_to_timecode(start + rb.seconds_to_frames(secs, fps), fps)
            self.assertEqual(got, want, fps)

    def test_drop_frame_skips_frames_0_and_1_each_minute(self):
        self.assertEqual(rb.frames_to_timecode(1799, 29.97, True), '00:00:59;29')
        self.assertEqual(rb.frames_to_timecode(1800, 29.97, True), '00:01:00;02')
        # Every tenth minute keeps them.
        self.assertEqual(rb.frames_to_timecode(17982, 29.97, True), '00:10:00;00')
        for f in (0, 1799, 1800, 17981, 17982, 107891, 107892, 123456):
            tc = rb.frames_to_timecode(f, 29.97, True)
            self.assertEqual(rb.timecode_to_frames(tc, 29.97, True), f, tc)

    def test_drop_frame_real_time_matches_wall_clock(self):
        # Ten real minutes at 29.97 DF land exactly on 00:10:00;00 past the start.
        start = rb.timecode_to_frames('01:00:00;00', 29.97, True)
        f = start + rb.seconds_to_frames(600, 29.97)
        self.assertEqual(rb.frames_to_timecode(f, 29.97, True), '01:10:00;00')

    def test_parse_rate_and_srt_time(self):
        self.assertEqual(rb.parse_rate('29.97 DF'), 29.97)
        self.assertEqual(rb.parse_rate('25'), 25.0)
        self.assertEqual(rb.parse_rate(None), 24.0)
        self.assertAlmostEqual(rb.srt_time_to_seconds('01:02:03,500'), 3723.5)
        self.assertAlmostEqual(rb.srt_time_to_seconds('00:00:05.25'), 5.25)
        self.assertEqual(rb.srt_time_to_seconds(12), 12.0)
        with self.assertRaises(ValueError):
            rb.srt_time_to_seconds('soon')


class MatchClipTest(unittest.TestCase):
    ITEMS = [(108000, "I can't believe it's"), (108100, 'the pro Disney+ tier'),
             (109000, "I can't believe it's"), (109100, 'something else entirely')]

    def test_exact_text_nearest_the_srt_time(self):
        self.assertEqual(rb.match_subtitle_item(self.ITEMS, "i can't believe it's", 108950), (2, True))
        self.assertEqual(rb.match_subtitle_item(self.ITEMS, "I can't believe it's", 108000), (0, True))

    def test_close_wording_still_matches(self):
        self.assertEqual(rb.match_subtitle_item(self.ITEMS, 'the pro Disney plus tier', 0), (1, False))

    def test_nothing_alike(self):
        self.assertIsNone(rb.match_subtitle_item(self.ITEMS, 'kangaroo', 0))
        self.assertIsNone(rb.match_subtitle_item([], 'anything', 0))


class FakeClip:
    def __init__(self, start, name):
        self.start, self.name = start, name

    def GetStart(self): return self.start
    def GetName(self): return self.name


class FakeTimeline:
    def __init__(self, fps='25', start='01:00:00:00', clips=(), accept=True):
        self.fps, self.start, self.clips, self.accept = fps, start, list(clips), accept
        self.moved_to = None

    def GetSetting(self, key):
        return {'timelineFrameRate': self.fps, 'timelineDropFrameTimecode': '0'}.get(key)

    def GetStartTimecode(self): return self.start
    def GetTrackCount(self, kind): return 1 if kind == 'subtitle' else 0
    def GetItemListInTrack(self, kind, i): return self.clips
    def GetName(self): return 'Main'

    def SetCurrentTimecode(self, tc):
        if self.accept:
            self.moved_to = tc
        return self.accept


class FakeProject:
    def __init__(self, timeline): self.timeline = timeline
    def GetCurrentTimeline(self): return self.timeline
    def GetSetting(self, key): return None
    def GetName(self): return 'Proj'


def fake_resolve(project):
    r = mock.Mock()
    r.GetProjectManager.return_value.GetCurrentProject.return_value = project
    return r


class MovePlayheadTest(unittest.TestCase):
    def use(self, resolve):
        return mock.patch.multiple(rb, _resolve=resolve, _connected=resolve is not None)

    def test_uses_the_subtitle_clip_when_found(self):
        # The SRT was dropped two seconds late: the clip's position wins.
        tl = FakeTimeline(clips=[FakeClip(90000 + 50 + 50, 'hello there'), FakeClip(91000, 'other')])
        with self.use(fake_resolve(FakeProject(tl))):
            res = rb.move_playhead(2.0, 'Hello there.')
        self.assertTrue(res['ok'])
        self.assertEqual(res['method'], 'subtitle-clip')
        self.assertEqual(res['timecode'], '01:00:04:00')
        self.assertEqual(tl.moved_to, '01:00:04:00')
        self.assertEqual(res['offsetFrames'], 50)

    def test_falls_back_to_start_plus_srt_time(self):
        tl = FakeTimeline(fps='24', clips=[FakeClip(86400, 'nothing like it')])
        with self.use(fake_resolve(FakeProject(tl))):
            res = rb.move_playhead(83.16, 'subscriptions out')
        self.assertEqual((res['ok'], res['method'], res['timecode']), (True, 'srt-time', '01:01:23:04'))

    def test_no_project_or_timeline(self):
        with self.use(fake_resolve(None)):
            self.assertEqual(rb.move_playhead(1.0)['error'], 'Resolve is open but no project is loaded.')
        with self.use(fake_resolve(FakeProject(None))):
            self.assertEqual(rb.move_playhead(1.0)['error'], 'No timeline is open in Resolve.')

    def test_resolve_refuses_the_move(self):
        tl = FakeTimeline(accept=False)
        with self.use(fake_resolve(FakeProject(tl))):
            res = rb.move_playhead(1.0)
        self.assertFalse(res['ok'])
        self.assertIn('would not move', res['error'])

    def test_resolve_not_running_or_scripting_off(self):
        no_resolve = {'connected': False, 'error': 'DaVinci Resolve is not running, or external scripting is disabled.'}
        with self.use(None), mock.patch.object(rb, 'connect', return_value=no_resolve):
            res = rb.move_playhead(1.0, 'anything')
        self.assertFalse(res['ok'])
        self.assertIn('not running', res['error'])
        self.assertIn('External scripting', res['error'])

    def test_scripting_library_unavailable(self):
        with self.use(None), mock.patch.object(rb, '_probe_dll_safe', return_value=False), \
             mock.patch.object(rb, '_error_msg', 'Resolve integration unavailable: no module'):
            res = rb.move_playhead(1.0)
        self.assertEqual(res, {'ok': False, 'error': 'Resolve integration unavailable: no module'})

    def test_resolve_closed_since_last_call(self):
        dead = mock.Mock()
        dead.GetProjectManager.side_effect = RuntimeError('gone')
        with self.use(dead), mock.patch.object(
                rb, 'connect', return_value={'connected': False, 'error': ''}):
            res = rb.move_playhead(1.0)
        self.assertFalse(res['ok'])
        self.assertIn('Could not reach Resolve', res['error'])


class PlayheadRouteTest(unittest.TestCase):
    def setUp(self):
        import app
        self.app = app
        self.client = app.app.test_client()

    def test_needs_a_cue_or_timecode(self):
        r = self.client.post('/api/resolve/playhead', json={})
        self.assertEqual(r.status_code, 400)

    def test_cue_needs_an_open_transcript(self):
        with mock.patch.object(self.app.live, 'is_open', return_value=False):
            r = self.client.post('/api/resolve/playhead', json={'cue': 3})
        self.assertEqual(r.status_code, 400)
        self.assertIn('No transcript is open', r.get_json()['error'])

    def test_timecode_without_resolve_is_a_plain_failure(self):
        with mock.patch.object(self.app.resolve_bridge, 'move_playhead',
                               return_value={'ok': False, 'error': 'Could not reach Resolve.'}) as mp:
            r = self.client.post('/api/resolve/playhead', json={'timecode': '00:01:23,160'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()['error'], 'Could not reach Resolve.')
        self.assertAlmostEqual(mp.call_args[0][0], 83.16)


if __name__ == '__main__':
    unittest.main()
