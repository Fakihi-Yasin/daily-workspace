"""Unit tests of the PC Work Time agent's counting and syncing (fake clock, desktop and server).
Run: python3 -m unittest discover -s agent -p 'test_*.py'"""
import importlib.util
import os
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('agent', os.path.join(os.path.dirname(__file__), 'dw-pc-time.py'))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)


class FakeDesktop:
    def __init__(self):
        self.idle, self.lock = 0, False

    def idle_ms(self):
        return self.idle

    def locked(self):
        return self.lock


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def run(counter, clock, seconds, control=None, desk=None, idle_grows=False):
    for _ in range(int(seconds // A.TICK)):
        clock.t += A.TICK
        if idle_grows:
            desk.idle += A.TICK * 1000
        counter.step(control or {})


class CountingTest(unittest.TestCase):
    def setUp(self):
        self.desk, self.clock, self.day = FakeDesktop(), Clock(), ['2026-11-25']
        self.state = {}
        self.c = A.Counter(self.state, self.desk, clock=self.clock, today=lambda: self.day[0])
        self.c.step({})  # first step only sets the reference time

    def total(self, d='2026-11-25'):
        return round(self.state['days'].get(d, 0))

    def test_counts_active_time(self):
        run(self.c, self.clock, 600)
        self.assertEqual(self.total(), 600)
        self.assertEqual(self.c.reason, 'active')
        self.assertEqual(self.state['dirty'], ['2026-11-25'])

    def test_stops_after_idle_minutes_and_resumes_on_input(self):
        run(self.c, self.clock, 900, desk=self.desk, idle_grows=True)  # 15 min without input
        self.assertEqual(self.total(), 300, 'only the first 5 minutes count')
        self.assertTrue(self.c.reason.startswith('idle'))
        self.desk.idle = 0
        run(self.c, self.clock, 60)
        self.assertEqual(self.total(), 360, 'counting resumes by itself')

    def test_idle_minutes_are_adjustable(self):
        run(self.c, self.clock, 900, control={'idle_minutes': 10, 'idle_changed_at': '2026-11-25T10:00:00+00:00'}, desk=self.desk, idle_grows=True)
        self.assertEqual(self.total(), 600)

    def test_locked_screen_does_not_count(self):
        self.desk.lock = True
        run(self.c, self.clock, 300)
        self.assertEqual(self.total(), 0)
        self.assertEqual(self.c.reason, 'screen locked')
        self.desk.lock = False
        run(self.c, self.clock, 30)
        self.assertEqual(self.total(), 30)

    def test_suspend_gap_is_not_counted(self):
        run(self.c, self.clock, 60)
        self.clock.t += 3 * 3600  # lid closed for 3 hours
        self.c.step({})
        self.assertEqual(self.c.reason, 'resumed after sleep')
        run(self.c, self.clock, 60)
        self.assertEqual(self.total(), 120)

    def test_pause_and_resume(self):
        paused = {'paused': True, 'paused_changed_at': '2026-11-25T10:00:00+00:00'}
        run(self.c, self.clock, 300, control=paused)
        self.assertEqual(self.total(), 0)
        resumed = {'paused': False, 'paused_changed_at': '2026-11-25T10:05:00+00:00'}
        run(self.c, self.clock, 60, control=resumed)
        self.assertEqual(self.total(), 60)

    def test_latest_pause_change_wins_between_computer_and_dashboard(self):
        self.state['server'] = {'paused': True, 'paused_changed_at': '2026-11-25T11:00:00+00:00'}
        older_local = {'paused': False, 'paused_changed_at': '2026-11-25T10:00:00+00:00'}
        self.assertTrue(self.c.effective(older_local)[0], 'dashboard pause (newer) wins')
        newer_local = {'paused': False, 'paused_changed_at': '2026-11-25T12:00:00+00:00'}
        self.assertFalse(self.c.effective(newer_local)[0], 'local resume (newer) wins')

    def test_unknown_idle_time_does_not_count(self):
        self.desk.idle = None
        run(self.c, self.clock, 120)
        self.assertEqual(self.total(), 0)

    def test_midnight_starts_a_new_day(self):
        run(self.c, self.clock, 60)
        self.day[0] = '2026-11-26'
        run(self.c, self.clock, 30)
        self.assertEqual((self.total('2026-11-25'), self.total('2026-11-26')), (60, 30))

    def test_never_more_than_24_hours_a_day(self):
        self.state['days']['2026-11-25'] = 86395
        run(self.c, self.clock, 60)
        self.assertEqual(self.total(), 86400)


class FakeServer:
    def __init__(self):
        self.online, self.received = True, []

    def sync(self, days, control):
        if not self.online:
            raise urllib.error.URLError('network is unreachable')
        self.received.append(dict(days))
        return {'idle_minutes': 7, 'paused': False, 'idle_changed_at': '2026-11-25T09:00:00+00:00', 'paused_changed_at': None, 'device': 'Test PC'}


class SyncTest(unittest.TestCase):
    def test_offline_totals_are_kept_and_sent_when_back(self):
        st = {'days': {'2026-11-24': 3600.4, '2026-11-25': 120}, 'dirty': ['2026-11-24', '2026-11-25']}
        srv = FakeServer()
        srv.online = False
        err = A.upload(st, srv, {})
        self.assertIn('offline', err)
        self.assertEqual(st['dirty'], ['2026-11-24', '2026-11-25'], 'nothing is lost while offline')
        srv.online = True
        self.assertIsNone(A.upload(st, srv, {}))
        self.assertEqual(srv.received[-1], {'2026-11-24': 3600, '2026-11-25': 120}, 'only whole seconds per day are sent')
        self.assertEqual(st['dirty'], [])
        self.assertEqual(st['server']['idle_minutes'], 7, 'settings from the dashboard are applied')
        self.assertIsNone(A.upload(st, srv, {}))
        self.assertEqual(srv.received[-1], {}, 'a heartbeat sends no days when nothing changed')

    def test_only_durations_leave_the_computer(self):
        st = {'days': {'2026-11-25': 10}, 'dirty': ['2026-11-25'], 'reason': 'active'}
        srv = FakeServer()
        A.upload(st, srv, {})
        self.assertEqual(list(srv.received[0].items()), [('2026-11-25', 10)])


if __name__ == '__main__':
    unittest.main()
