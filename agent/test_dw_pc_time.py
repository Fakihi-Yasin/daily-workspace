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



class AppDesktop(FakeDesktop):
    def __init__(self):
        super().__init__()
        self.app = 'code'

    def foreground_app(self):
        return self.app


class DetailsTest(unittest.TestCase):
    def setUp(self):
        self.desk, self.clock = AppDesktop(), Clock()
        self.det = A.Details(':memory:')
        self.br = A.BrowserState(clock=self.clock)
        self.state = {}
        self.c = A.Counter(self.state, self.desk, clock=self.clock, today=lambda: '2026-11-25', details=self.det, browser=self.br)
        self.c.step({})

    def test_records_app_time_as_merged_segments(self):
        run(self.c, self.clock, 300)
        self.desk.app = 'firefox'
        run(self.c, self.clock, 120)
        s = self.det.day_summary('2026-11-25')
        self.assertEqual([(x['name'], x['seconds']) for x in s['apps']], [('code', 300), ('firefox', 120)])
        self.assertEqual(len(s['timeline']), 2, 'one segment per stretch of the same app')

    def test_domain_only_when_a_browser_is_in_front(self):
        self.br.report('https://evil.example/path', True)  # not a bare hostname: rejected
        self.assertIsNone(self.br())
        self.br.report('www.GitHub.com', True)
        self.desk.app = 'firefox'
        self.assertEqual(self.br(), 'github.com')
        run(self.c, self.clock, 60)
        self.desk.app = 'code'
        run(self.c, self.clock, 60)
        s = self.det.day_summary('2026-11-25')
        self.assertEqual(s['domains'], [{'name': 'github.com', 'seconds': 60, 'category': 'uncategorized'}])

    def test_unknown_app_uses_the_extension_domain_if_the_browser_has_focus(self):
        self.desk.app = None  # e.g. GNOME on Wayland without the helper extension
        self.br.report('docs.example.org', True)
        run(self.c, self.clock, 30)
        self.br.report(None, False)  # browser lost focus
        run(self.c, self.clock, 30)
        s = self.det.day_summary('2026-11-25')
        self.assertEqual([(d['name'], d['seconds']) for d in s['domains']], [('docs.example.org', 30)])

    def test_classification_work_personal_and_upload_of_totals_only(self):
        self.det.set_rule('app', 'code', 'work')
        self.det.set_rule('domain', 'youtube.com', 'personal')
        run(self.c, self.clock, 600)
        self.desk.app = 'chrome'
        for _ in range(10):  # the extension's heartbeat every 30 s
            self.br.report('m.youtube.com', True)  # subdomain matches the rule
            run(self.c, self.clock, 30)
        self.desk.app = 'slack'
        run(self.c, self.clock, 100)
        self.assertEqual(self.det.day_summary('2026-11-25')['split'], {'work': 600, 'personal': 300, 'uncategorized': 100})
        srv = FakeServer()
        A.upload(self.state, srv, {'details': True}, self.det)
        self.assertEqual(srv.received[-1], {'2026-11-25': {'total': 1000, 'work': 600, 'personal': 300}},
                         'only daily totals leave the computer: no app or domain names')
        self.assertNotIn('code', repr(srv.received)); self.assertNotIn('youtube', repr(srv.received))

    def test_details_off_sends_plain_totals(self):
        run(self.c, self.clock, 60)
        srv = FakeServer()
        A.upload(self.state, srv, {}, self.det)
        self.assertEqual(srv.received[-1], {'2026-11-25': 60})

    def test_exclusions_hide_names_but_keep_the_time(self):
        run(self.c, self.clock, 60)
        self.det.add_exclusion('app', 'Code')
        self.desk.app = 'code'
        run(self.c, self.clock, 60)
        self.det.add_exclusion('domain', 'bank.com')
        self.desk.app = 'firefox'
        self.br.report('online.bank.com', True)
        run(self.c, self.clock, 30)
        s = self.det.day_summary('2026-11-25')
        self.assertEqual([(a['name'], a['seconds']) for a in s['apps']], [('(excluded)', 150)])
        self.assertEqual(s['domains'], [])
        self.assertEqual(round(self.state['days']['2026-11-25']), 150, 'excluded time still counts as active')

    def test_delete_history(self):
        run(self.c, self.clock, 60)
        self.det.delete_history('2026-11-25')
        self.assertEqual(self.det.day_summary('2026-11-25')['timeline'], [])
        run(self.c, self.clock, 60)
        self.det.delete_history()
        self.assertEqual(self.det.q('select count(*) from segments')[0][0], 0)

    def test_only_app_domain_and_time_are_stored(self):
        cols = [r[1] for r in self.det.q('pragma table_info(segments)')]
        self.assertEqual(cols, ['id', 'day', 'start', 'end', 'app', 'domain'])


class LocalServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tempfile
        cls.tmp = tempfile.mkdtemp()
        A.CONTROL = os.path.join(cls.tmp, 'control.json')
        cls.det = A.Details(':memory:')
        cls.br = A.BrowserState()
        cls.app = A.LocalApp({'days': {}, 'dirty': []}, cls.det, cls.br, port=47699)
        cls.srv = cls.app.serve()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, headers=None):
        import http.client
        c = http.client.HTTPConnection('127.0.0.1', 47699, timeout=5)
        h = {'Host': '127.0.0.1:47699', 'Content-Type': 'application/json'}
        h.update(headers or {})
        c.request(method, path, body=json_dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        return r.status, r.read(), dict(r.getheaders())

    def test_page_api_needs_the_one_time_link(self):
        self.assertEqual(self.req('GET', '/api/summary')[0], 401)
        st, _, hd = self.req('GET', '/?t=' + self.app.page_token)
        self.assertEqual(st, 302)
        cookie = hd['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', hd['Set-Cookie'])
        self.assertEqual(self.req('GET', '/api/summary', headers={'Cookie': cookie})[0], 200)
        self.assertEqual(self.req('GET', '/?t=wrong')[0], 200, 'page shell only; no cookie')

    def test_other_hosts_are_refused(self):  # DNS rebinding
        self.assertEqual(self.req('GET', '/', headers={'Host': 'evil.example:47699'})[0], 403)

    def test_extension_needs_token_and_an_extension_origin(self):
        ok = {'Origin': 'chrome-extension://abcdefghijklmnop', 'X-DW-Token': self.app.ext_token}
        self.assertEqual(self.req('POST', '/ext/active', {'domain': 'github.com', 'focused': True}, ok)[0], 200)
        self.assertEqual(self.br.domain, 'github.com')
        self.assertEqual(self.req('POST', '/ext/active', {'domain': 'x.com', 'focused': True}, {'Origin': 'https://evil.example', 'X-DW-Token': self.app.ext_token})[0], 401)
        self.assertEqual(self.req('POST', '/ext/active', {'domain': 'x.com', 'focused': True}, {'Origin': 'chrome-extension://abc', 'X-DW-Token': 'nope'})[0], 401)
        self.assertEqual(self.br.domain, 'github.com')


def json_dumps(b):
    import json
    return json.dumps(b)


if __name__ == '__main__':
    unittest.main()


class StaleDomainTest(unittest.TestCase):
    def test_a_domain_report_expires_without_heartbeat(self):
        clock = Clock()
        br = A.BrowserState(clock=clock)
        br.report('github.com', True)
        clock.t += A.EXT_FRESH + 1
        self.assertIsNone(br(), 'no heartbeat (browser closed or extension gone): no domain')
