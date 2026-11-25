#!/usr/bin/env python3
"""Daily Workspace — PC Work Time agent (Linux, Windows, macOS).

Counts the time this computer is actively used, even when the dashboard is closed, and sends ONE set
of numbers per day to your Daily Workspace account: active seconds and, if Activity Details are on,
how many of them were Work and Personal. Nothing else leaves the computer.

Never, on any system: screenshots or screen recording; keystrokes, typed text, passwords, messages or
clipboard; window or page titles; full URLs. Idle time comes only from the operating system's idle
timer (time since the last input event), never from reading input.

Counting (checked every 10 s): counts while you use the keyboard or mouse and up to N idle minutes
(N = 5 by default; dashboard or `dw-pc-time idle N`); stops after N minutes without input, while the
screen is locked, while paused, and while the computer sleeps or is off; continues by itself.

Activity Details (opt-in, `dw-pc-time details on`): the name of the app in the foreground and, with the
optional browser extension, the website DOMAIN of the active tab, with the time spent. Stored only on
this computer (local database, 30 days), shown on a local page (`dw-pc-time open`) with a daily
timeline, Work / Personal / Uncategorized classification, an exclusion list and Delete history.

Usage: dw-pc-time run | status | notify | open | pause | resume | idle MINUTES | details on|off
       | domains on|off | autostart on|off | sync | pair CODE | extension-token | browser-extension
       | gnome-extension | version
"""
import base64
import datetime as dt
import hmac
import http.server
import json
import os
import platform
import plistlib
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

VERSION = '2.0.0'
APP = 'daily-workspace-pc-time'
SYSTEM = platform.system()  # 'Linux' | 'Windows' | 'Darwin'


def _dirs():
    if SYSTEM == 'Windows':
        base = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~\\AppData\\Local'), 'DailyWorkspacePCTime')
        return base, base
    if SYSTEM == 'Darwin':
        base = os.path.expanduser('~/Library/Application Support/Daily Workspace PC Time')
        return base, base
    return (os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), APP),
            os.path.join(os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state'), APP))


CONFIG_DIR, STATE_DIR = _dirs()
CONFIG = os.path.join(CONFIG_DIR, 'config.json')     # server address + this computer's key
CONTROL = os.path.join(CONFIG_DIR, 'control.json')   # changes made on this computer (pause, idle, details)
STATE = os.path.join(STATE_DIR, 'state.json')        # per-day totals and settings
DETAILS_DB = os.path.join(STATE_DIR, 'activity.sqlite3')  # Activity Details, local only

TICK = 10            # seconds between checks
SYNC_EVERY = 60      # seconds between uploads
SAVE_EVERY = 60      # seconds between writes of the local state
KEEP_DAYS = 35       # daily totals kept locally (the server ignores older days too)
DETAIL_DAYS = 30     # Activity Details kept locally
DEFAULT_IDLE_MIN = 5
PORT = 47613         # local page + browser extension (127.0.0.1 only)
EXT_FRESH = 75       # seconds a browser-extension report stays valid
BROWSERS = {'chrome', 'google-chrome', 'chromium', 'chromium-browser', 'msedge', 'microsoft-edge', 'brave', 'brave-browser',
            'firefox', 'firefox-esr', 'safari', 'opera', 'vivaldi', 'arc', 'zen', 'google chrome', 'microsoft edge', 'brave browser'}
CATEGORIES = ('work', 'personal', 'uncategorized')


# ---------------------------------------------------------------- small helpers
def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def parse_iso(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data, mode=0o600):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def fmt(sec):
    sec = int(sec or 0)
    h, m = divmod(sec // 60, 60)
    return f'{h} h {m:02d} min' if h else f'{m} min'


def clean_name(s, limit=80):
    """An app name or domain, nothing else: one short line of plain characters."""
    if not s:
        return None
    s = re.sub(r'[\x00-\x1f\x7f]', '', str(s)).strip()
    return s[:limit] or None


def clean_domain(s):
    """Only a hostname (no scheme, path, query, port, user info)."""
    if not s:
        return None
    s = str(s).strip().lower()
    if not re.fullmatch(r'[a-z0-9.-]{1,253}', s) or '.' not in s or s.startswith('.') or s.endswith('.'):
        return None
    return s[4:] if s.startswith('www.') else s


def notify(text):
    try:
        if SYSTEM == 'Linux' and shutil.which('notify-send'):
            subprocess.run(['notify-send', '-a', 'Daily Workspace', 'PC Work Time', text], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        elif SYSTEM == 'Darwin':
            t = text.replace('\\', '').replace('"', "'")
            subprocess.run(['osascript', '-e', f'display notification "{t}" with title "PC Work Time"'], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        else:
            print(text)
    except Exception:
        print(text)


def _run(cmd, timeout=5):
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f'{cmd[0]} failed')
    return out.stdout.strip()


# ---------------------------------------------------------------- operating-system adapters
# Each adapter answers three questions, from OS APIs only: how long since the last input event (the
# OS idle timer), is the screen locked, and which app is in the foreground (its name only).
class LinuxDesktop:
    def _gdbus(self, dest, path, method):
        return _run(['gdbus', 'call', '--session', '--dest', dest, '--object-path', path, '--method', method])

    def idle_ms(self):
        try:  # GNOME / Mutter (Wayland and X11): "(uint64 12345,)"
            out = self._gdbus('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor.GetIdletime')
            return int(out.strip('(),').split()[-1].rstrip(','))
        except Exception:
            pass
        try:  # KDE Plasma and others (seconds)
            out = self._gdbus('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver.GetSessionIdleTime')
            return int(out.strip('(),').split()[-1].rstrip(',')) * 1000
        except Exception:
            pass
        if shutil.which('xprintidle'):  # X11 (XScreenSaver extension)
            try:
                return int(_run(['xprintidle']))
            except Exception:
                pass
        return None  # unknown: the agent does not count rather than guess

    def locked(self):
        for dest, path, iface in (('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver'),
                                  ('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver')):
            try:
                return 'true' in self._gdbus(dest, path, iface + '.GetActive')
            except Exception:
                pass
        sid = os.environ.get('XDG_SESSION_ID')
        if sid and shutil.which('loginctl'):
            try:
                return _run(['loginctl', 'show-session', sid, '-p', 'LockedHint', '--value']) == 'yes'
            except Exception:
                pass
        return False

    def foreground_app(self):
        # GNOME on Wayland lets no program read the focused window. The small GNOME Shell extension
        # shipped with this agent (agent/gnome-extension) exposes ONLY the focused app's name.
        try:
            out = self._gdbus('org.gnome.Shell', '/com/dailyworkspace/FocusedApp', 'com.dailyworkspace.FocusedApp.Get')
            name = out.strip("(),'\" ")
            if name:
                return clean_name(name)
        except Exception:
            pass
        # X11 session: the WM_CLASS of the active window (an app identifier, not its title).
        if os.environ.get('XDG_SESSION_TYPE') == 'x11' and shutil.which('xprop'):
            try:
                wid = _run(['xprop', '-root', '_NET_ACTIVE_WINDOW']).split()[-1]
                cls = _run(['xprop', '-id', wid, 'WM_CLASS'])
                parts = re.findall(r'"([^"]*)"', cls)
                if parts:
                    return clean_name(parts[-1])
            except Exception:
                pass
        return None


class WindowsDesktop:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ct, self.wt = ctypes, wintypes
        self.u32, self.k32 = ctypes.windll.user32, ctypes.windll.kernel32

    def idle_ms(self):
        ct, wt = self.ct, self.wt

        class LASTINPUTINFO(ct.Structure):
            _fields_ = [('cbSize', wt.UINT), ('dwTime', wt.DWORD)]
        lii = LASTINPUTINFO()
        lii.cbSize = ct.sizeof(LASTINPUTINFO)
        if not self.u32.GetLastInputInfo(ct.byref(lii)):  # the OS idle timer
            return None
        return (self.k32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF

    def locked(self):
        # The secure desktop (lock screen) can't be switched to by a normal app.
        h = self.u32.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_SWITCHDESKTOP
        if not h:
            return True
        try:
            return not self.u32.SwitchDesktop(h)
        finally:
            self.u32.CloseDesktop(h)

    def foreground_app(self):
        ct, wt = self.ct, self.wt
        hwnd = self.u32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wt.DWORD()
        self.u32.GetWindowThreadProcessId(hwnd, ct.byref(pid))
        h = self.k32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return None
        try:
            buf = ct.create_unicode_buffer(1024)
            size = wt.DWORD(1024)
            if not self.k32.QueryFullProcessImageNameW(h, 0, buf, ct.byref(size)):
                return None
            name = os.path.basename(buf.value)
            return clean_name(name[:-4] if name.lower().endswith('.exe') else name)
        finally:
            self.k32.CloseHandle(h)


class MacDesktop:
    def idle_ms(self):
        try:  # IOHIDSystem's HIDIdleTime (nanoseconds since the last input event)
            out = _run(['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'])
            m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
            return int(m.group(1)) // 1_000_000 if m else None
        except Exception:
            return None

    def locked(self):
        try:
            raw = subprocess.run(['ioreg', '-n', 'Root', '-d1', '-a'], capture_output=True, timeout=5).stdout
            root = plistlib.loads(raw)
            for u in root.get('IOConsoleUsers', []):
                if u.get('CGSSessionScreenIsLocked'):
                    return True
        except Exception:
            pass
        return False

    def foreground_app(self):
        try:
            asn = _run(['lsappinfo', 'front'])
            out = _run(['lsappinfo', 'info', '-only', 'name', asn])
            m = re.search(r'"(?:LSDisplayName|name)"\s*=\s*"([^"]*)"', out)
            return clean_name(m.group(1)) if m else None
        except Exception:
            return None


def make_desktop():
    return WindowsDesktop() if SYSTEM == 'Windows' else MacDesktop() if SYSTEM == 'Darwin' else LinuxDesktop()


# ---------------------------------------------------------------- Activity Details (local only)
class Details:
    """App / domain segments of time, classification rules and exclusions, in a local SQLite file."""

    def __init__(self, path=DETAILS_DB):
        if path != ':memory:':
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.lock = threading.Lock()
        if path != ':memory:':
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        self.db.executescript('''
          create table if not exists segments (id integer primary key, day text not null, start real not null, end real not null,
                                               app text, domain text);
          create index if not exists segments_day on segments(day, start);
          create table if not exists rules (kind text not null check (kind in ('app','domain')), name text not null,
                                            category text not null check (category in ('work','personal')), primary key (kind, name));
          create table if not exists exclusions (kind text not null check (kind in ('app','domain')), name text not null, primary key (kind, name));
        ''')

    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def excluded(self, kind, name):
        if not name:
            return False
        if kind == 'domain':
            return any(name == n or name.endswith('.' + n) for (n,) in self.q("select name from exclusions where kind='domain'"))
        return bool(self.q("select 1 from exclusions where kind='app' and lower(name)=lower(?)", (name,)))

    def record(self, day, start, end, app, domain):
        if self.excluded('app', app) or self.excluded('domain', domain):
            app, domain = '(excluded)', None
        with self.lock:
            last = self.db.execute('select id, end, app, domain from segments where day=? order by end desc limit 1', (day,)).fetchone()
            if last and last[2] == app and last[3] == domain and start - last[1] <= TICK * 2:
                self.db.execute('update segments set end=? where id=?', (end, last[0]))
            else:
                self.db.execute('insert into segments(day,start,end,app,domain) values(?,?,?,?,?)', (day, start, end, app, domain))

    def category(self, app, domain, rules=None):
        rules = rules if rules is not None else self.rules()
        if domain:
            for (kind, name), cat in rules.items():
                if kind == 'domain' and (domain == name or domain.endswith('.' + name)):
                    return cat
        if app:
            cat = rules.get(('app', app.lower()))
            if cat:
                return cat
        return 'uncategorized'

    def rules(self):
        return {(k, n.lower()): c for k, n, c in self.q('select kind, name, category from rules')}

    def day_summary(self, day):
        rows = self.q('select start, end, app, domain from segments where day=? order by start', (day,))
        rules = self.rules()
        by_app, by_domain, split = {}, {}, {c: 0.0 for c in CATEGORIES}
        timeline = []
        for start, end, app, domain in rows:
            secs = max(0.0, end - start)
            cat = self.category(app, domain, rules)
            split[cat] += secs
            key = app or 'Unknown app'
            by_app[key] = by_app.get(key, 0) + secs
            if domain:
                by_domain[domain] = by_domain.get(domain, 0) + secs
            timeline.append({'start': start, 'end': end, 'app': key, 'domain': domain, 'category': cat})
        lst = lambda d, kind: sorted(({'name': k, 'seconds': round(v), 'category': self.category(k if kind == 'app' else None, k if kind == 'domain' else None, rules)}
                                       for k, v in d.items()), key=lambda x: -x['seconds'])
        return {'day': day, 'apps': lst(by_app, 'app'), 'domains': lst(by_domain, 'domain'),
                'split': {k: round(v) for k, v in split.items()}, 'timeline': timeline}

    def split(self, day):
        s = self.day_summary(day)['split']
        return s['work'], s['personal']

    def set_rule(self, kind, name, category):
        name = clean_domain(name) if kind == 'domain' else clean_name(name)
        if kind not in ('app', 'domain') or not name:
            raise ValueError('invalid name')
        if category in ('work', 'personal'):
            self.q('insert into rules(kind,name,category) values(?,?,?) on conflict(kind,name) do update set category=excluded.category', (kind, name.lower(), category))
        else:
            self.q('delete from rules where kind=? and name=?', (kind, name.lower()))

    def exclusions(self):
        return [{'kind': k, 'name': n} for k, n in self.q('select kind, name from exclusions order by kind, name')]

    def add_exclusion(self, kind, name):
        name = clean_domain(name) if kind == 'domain' else clean_name(name)
        if kind not in ('app', 'domain') or not name:
            raise ValueError('invalid name')
        self.q('insert or ignore into exclusions(kind,name) values(?,?)', (kind, name.lower() if kind == 'domain' else name))
        # Already recorded time for it keeps counting, but under no name.
        if kind == 'app':
            self.q("update segments set app='(excluded)', domain=null where lower(app)=lower(?)", (name,))
        else:
            self.q("update segments set app='(excluded)', domain=null where domain=? or domain like ?", (name, '%.' + name))

    def remove_exclusion(self, kind, name):
        self.q('delete from exclusions where kind=? and name=?', (kind, name))

    def delete_history(self, day=None):
        if day:
            self.q('delete from segments where day=?', (day,))
        else:
            self.q('delete from segments')
            with self.lock:
                self.db.execute('vacuum')

    def prune(self, today):
        cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=DETAIL_DAYS)).isoformat()
        self.q('delete from segments where day < ?', (cutoff,))


# ---------------------------------------------------------------- the counter (shared by all systems)
class Counter:
    """Adds active seconds to today's total. `step()` is called every TICK seconds."""

    def __init__(self, state, desktop, clock=time.time, today=lambda: dt.date.today().isoformat(), details=None, browser=None):
        self.s = state
        self.s.setdefault('days', {})        # {"YYYY-MM-DD": seconds}
        self.s.setdefault('dirty', [])       # days changed since the last successful upload
        self.s.setdefault('server', {})      # settings last received from the server
        self.desktop = desktop
        self.clock = clock
        self.today = today
        self.details = details               # Details store when Activity Details are on, else None
        self.browser = browser or (lambda: None)  # () -> active tab's domain from the extension, or None
        self.last = None
        self.reason = 'starting'

    # settings: the most recent change wins, from this computer (control.json) or the dashboard
    def effective(self, control):
        srv = self.s['server']

        def pick(key_val, key_at, default):
            local_at, server_at = parse_iso(control.get(key_at)), parse_iso(srv.get(key_at))
            if local_at and (not server_at or local_at > server_at):
                return control.get(key_val)
            if srv.get(key_val) is not None:
                return srv.get(key_val)
            return default
        paused = bool(pick('paused', 'paused_changed_at', False))
        idle = pick('idle_minutes', 'idle_changed_at', DEFAULT_IDLE_MIN)
        try:
            idle = max(1, min(120, int(idle)))
        except (TypeError, ValueError):
            idle = DEFAULT_IDLE_MIN
        return paused, idle

    def step(self, control):
        t = self.clock()
        prev, self.last = self.last, t
        paused, idle_min = self.effective(control)
        if prev is None:
            self.reason = 'starting'
            return 0
        gap = t - prev
        # Much longer than a tick: the computer was asleep / hibernated, or the clock jumped.
        if gap <= 0 or gap > TICK * 3:
            self.reason = 'resumed after sleep'
            return 0
        if paused:
            self.reason = 'paused'
            return 0
        if self.desktop.locked():
            self.reason = 'screen locked'
            return 0
        idle = self.desktop.idle_ms()
        if idle is None:
            self.reason = 'idle time unavailable'
            return 0
        if idle > idle_min * 60000:
            self.reason = f'idle for {idle_min}+ min'
            return 0
        self.reason = 'active'
        day = self.today()
        add = min(gap, TICK * 1.5)
        cur = float(self.s['days'].get(day, 0))
        self.s['days'][day] = min(86400.0, cur + add)
        if day not in self.s['dirty']:
            self.s['dirty'].append(day)
        if self.details is not None:
            app = self.desktop.foreground_app()
            domain = None
            if control.get('domains', True):
                d = self.browser()
                # A domain applies when a browser is in front, or when the system can't say which app is.
                if d and (app is None or app.lower() in BROWSERS):
                    domain = d
            try:
                self.details.record(day, t - add, t, app, domain)
            except sqlite3.Error:
                pass
        return add

    def prune(self):
        cutoff = (dt.date.fromisoformat(self.today()) - dt.timedelta(days=KEEP_DAYS)).isoformat()
        for d in [d for d in self.s['days'] if d < cutoff]:
            del self.s['days'][d]
        self.s['dirty'] = [d for d in self.s['dirty'] if d >= cutoff]


# ---------------------------------------------------------------- talking to the account
class Server:
    def __init__(self, cfg):
        self.url = cfg['url'].rstrip('/') + '/rest/v1/rpc/pc_agent_sync'
        self.pk = cfg['publishable_key']
        self.key = cfg['device_key']

    def sync(self, days, control):
        body = {'p_key': self.key, 'p_days': days, 'p_version': VERSION}
        if control.get('paused_changed_at'):
            body.update(p_paused=bool(control.get('paused')), p_paused_at=control['paused_changed_at'])
        if control.get('idle_changed_at'):
            body.update(p_idle_minutes=int(control.get('idle_minutes') or DEFAULT_IDLE_MIN), p_idle_at=control['idle_changed_at'])
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), method='POST', headers={
            'apikey': self.pk, 'Content-Type': 'application/json', 'User-Agent': f'dw-pc-time/{VERSION}'})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read() or b'null')
        except urllib.error.HTTPError as e:
            try:
                info = json.loads(e.read() or b'{}')
            except ValueError:
                info = {}
            raise SyncRefused(e.code, info.get('message') or str(e), info.get('hint')) from None


class SyncRefused(Exception):
    def __init__(self, code, message, hint=None):
        super().__init__(f'{code} {message}' + (f' — {hint}' if hint else ''))
        self.code, self.message, self.hint = code, message, hint


def upload(state, server, control, details=None):
    """Send the days changed since the last upload (or just a heartbeat). Returns an error text or None.
    With Activity Details on, each day also carries its Work and Personal seconds — totals only."""
    dirty = list(state.get('dirty', []))
    days = {}
    for d in dirty:
        if d not in state['days']:
            continue
        total = int(round(state['days'][d]))
        if details is not None and control.get('details'):
            w, p = details.split(d)
            w, p = int(round(w)), int(round(p))
            if w + p > total:  # never more than the active total
                scale = total / (w + p)
                w, p = int(w * scale), int(p * scale)
            days[d] = {'total': total, 'work': w, 'personal': p}
        else:
            days[d] = total
    try:
        res = server.sync(days, control)
    except SyncRefused as e:
        state['last_error'] = str(e)
        return str(e)
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
        state['last_error'] = f'offline: {getattr(e, "reason", e)}'
        return state['last_error']
    sent_total = lambda d: days[d]['total'] if isinstance(days[d], dict) else days[d]
    state['dirty'] = [d for d in state.get('dirty', []) if d not in days or int(round(state['days'].get(d, 0))) != sent_total(d)]
    if isinstance(res, dict):
        state['server'] = {k: res.get(k) for k in ('idle_minutes', 'paused', 'idle_changed_at', 'paused_changed_at')}
        state['device'] = res.get('device')
    state['last_sync'] = now_iso()
    state.pop('last_error', None)
    return None


# ---------------------------------------------------------------- local page + browser extension endpoint
class BrowserState:
    """The active tab's domain, as last reported by the optional browser extension."""

    def __init__(self, clock=time.time):
        self.domain, self.at, self.focused, self.clock = None, 0.0, False, clock

    def report(self, domain, focused):
        self.domain, self.focused, self.at = clean_domain(domain), bool(focused), self.clock()

    def __call__(self):
        if self.focused and self.domain and self.clock() - self.at <= EXT_FRESH:
            return self.domain
        return None


PAGE = r'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'">
<title>PC Work Time · Activity Details</title><style>
:root{--g:#02B902;--ink:#0d0e12;--mut:#6b6b70;--line:#e5e2dc;--bg:#f6f5f1;--card:#fff;--w:#2b6cff;--p:#e0559b;--u:#a9a7a1}
@media (prefers-color-scheme:dark){:root{--ink:#f3f2ee;--mut:#a3a29d;--line:#2c2c30;--bg:#121214;--card:#1b1b1f}}
body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--ink)}main{max-width:980px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:17px;margin:0 0 10px}.mut{color:var(--mut)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sp{flex:1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{border:1px solid var(--line);border-radius:12px;padding:12px}
.tile b{display:block;font-size:24px}.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
table{width:100%;border-collapse:collapse}td,th{padding:7px 6px;border-top:1px solid var(--line);text-align:left}th{font-size:12px;color:var(--mut);text-transform:uppercase}
select,input,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:5px 9px}
button{cursor:pointer}button.pri{background:var(--g);border-color:var(--g);color:#000;font-weight:600}button.dan{color:#c62828}
.bar{position:relative;height:34px;border-radius:8px;background:var(--bg);border:1px solid var(--line);overflow:hidden}.bar i{position:absolute;top:0;bottom:0}
.hours{display:flex;justify-content:space-between;font-size:11px;color:var(--mut)}.tl{max-height:260px;overflow:auto}
.chip{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}</style></head><body><main>
<div class="row"><div><h1>Activity Details</h1><div class="mut small">Only on this computer. Never sent to your account: only daily totals (active, Work, Personal) are.</div></div><span class="sp"></span>
<input type="date" id="day"></div>
<div id="off" class="card" hidden><h2>Activity Details are off</h2><p class="mut">When on, this computer keeps the name of the app in front and, with the browser extension, the website domain — and how long. Never window or page titles, full addresses, what you type, or screenshots.</p><button class="pri" id="on">Turn on Activity Details</button></div>
<div id="main" hidden>
<div class="card"><div class="tiles" id="tiles"></div></div>
<div class="card"><div class="row"><h2>Timeline</h2><span class="sp"></span><span class="small mut"><span class="dot" style="background:var(--w)"></span>Work <span class="dot" style="background:var(--p);margin-left:8px"></span>Personal <span class="dot" style="background:var(--u);margin-left:8px"></span>Uncategorized</span></div>
<div class="bar" id="bar"></div><div class="hours"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
<div class="tl small" id="tl" style="margin-top:10px"></div></div>
<div class="card"><h2>Apps</h2><table id="apps"></table></div>
<div class="card"><h2>Websites <span class="small mut">(domains, from the browser extension)</span></h2><table id="domains"></table></div>
<div class="card"><h2>Excluded</h2><p class="small mut">Time in these apps or sites still counts as active time, but their names are not recorded.</p>
<div class="row"><select id="exk"><option value="app">App</option><option value="domain">Domain</option></select><input id="exn" placeholder="e.g. Signal or bank.com"><button id="exadd">Exclude</button></div><div id="exl" class="row" style="margin-top:10px"></div></div>
<div class="card"><h2>Settings</h2><div class="row"><label><input type="checkbox" id="dom"> Record website domains from the browser extension</label></div>
<div class="row" style="margin-top:10px"><button class="dan" id="delday">Delete this day’s details</button><button class="dan" id="delall">Delete all history on this computer</button><span class="sp"></span><button id="offbtn">Turn Activity Details off</button></div>
<p class="small mut">Browser extension token (paste it in the extension’s options): <code id="tok"></code></p></div>
</div></main><script>
const $=s=>document.querySelector(s);const api=async(p,b)=>{const r=await fetch(p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined,credentials:'same-origin'});if(!r.ok)throw new Error(await r.text());return r.json()};
const fmt=s=>{s=Math.round(s||0);const h=Math.floor(s/3600),m=Math.floor(s/60)%60;return h?h+' h '+String(m).padStart(2,'0')+' min':(s>=60?m+' min':(s?'< 1 min':'0 min'))};
const col={work:'var(--w)',personal:'var(--p)',uncategorized:'var(--u)'};const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const today=new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10);$('#day').value=today;
function rows(list,kind){if(!list.length)return '<tr><td class="mut">Nothing recorded.</td></tr>';return '<tr><th>Name</th><th>Time</th><th>Category</th><th></th></tr>'+list.map(x=>`<tr><td>${esc(x.name)}</td><td>${fmt(x.seconds)}</td><td><select data-k="${kind}" data-n="${esc(x.name)}">${['uncategorized','work','personal'].map(c=>`<option value="${c}" ${x.category===c?'selected':''}>${c[0].toUpperCase()+c.slice(1)}</option>`).join('')}</select></td><td>${x.name==='(excluded)'||x.name==='Unknown app'?'':`<button data-x="${kind}" data-n="${esc(x.name)}">Exclude</button>`}</td></tr>`).join('')}
async function load(){const s=await api('/api/summary?day='+$('#day').value);$('#off').hidden=s.enabled;$('#main').hidden=!s.enabled;$('#tok').textContent=s.extension_token;$('#dom').checked=s.domains;
if(!s.enabled)return;const d=s.summary,sp=d.split;$('#tiles').innerHTML=[['Active (this computer)',s.total],['Work',sp.work],['Personal',sp.personal],['Uncategorized',sp.uncategorized]].map(([k,v])=>`<div class="tile"><span class="small mut">${k}</span><b>${fmt(v)}</b></div>`).join('');
const day0=new Date($('#day').value+'T00:00:00').getTime()/1e3;$('#bar').innerHTML=d.timeline.map(t=>`<i title="${esc(t.app)}${t.domain?' · '+esc(t.domain):''}" style="left:${(t.start-day0)/864}%;width:${Math.max(.08,(t.end-t.start)/864)}%;background:${col[t.category]}"></i>`).join('');
$('#tl').innerHTML=d.timeline.length?d.timeline.slice().reverse().map(t=>`<div class="row" style="padding:3px 0"><span class="dot" style="background:${col[t.category]}"></span><span style="width:110px">${new Date(t.start*1e3).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}–${new Date(t.end*1e3).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><b>${esc(t.app)}</b><span class="mut">${t.domain?esc(t.domain):''}</span><span class="sp"></span>${fmt(t.end-t.start)}</div>`).join(''):'<p class="mut">Nothing recorded for this day.</p>';
$('#apps').innerHTML=rows(d.apps,'app');$('#domains').innerHTML=rows(d.domains,'domain');
$('#exl').innerHTML=s.exclusions.length?s.exclusions.map(e=>`<span class="chip">${e.kind}: ${esc(e.name)} <button data-rx="${e.kind}" data-n="${esc(e.name)}">×</button></span>`).join(''):'<span class="mut small">None.</span>'}
document.addEventListener('change',async e=>{const t=e.target;if(t.dataset.k){await api('/api/rule',{kind:t.dataset.k,name:t.dataset.n,category:t.value});load()}if(t.id==='day')load();if(t.id==='dom'){await api('/api/settings',{domains:t.checked});load()}});
document.addEventListener('click',async e=>{const t=e.target;
 if(t.dataset.x){if(confirm('Exclude '+t.dataset.n+'? Its recorded time keeps counting, under no name.')){await api('/api/exclusion',{kind:t.dataset.x,name:t.dataset.n});load()}}
 if(t.dataset.rx){await api('/api/exclusion',{kind:t.dataset.rx,name:t.dataset.n,remove:true});load()}
 if(t.id==='exadd'&&$('#exn').value.trim()){await api('/api/exclusion',{kind:$('#exk').value,name:$('#exn').value.trim()});$('#exn').value='';load()}
 if(t.id==='on'){await api('/api/settings',{details:true});load()} if(t.id==='offbtn'){await api('/api/settings',{details:false});load()}
 if(t.id==='delday'&&confirm('Delete the activity details of '+$('#day').value+' on this computer?')){await api('/api/delete',{day:$('#day').value});load()}
 if(t.id==='delall'&&confirm('Delete ALL activity details on this computer? This cannot be undone.')){await api('/api/delete',{all:true});load()}});
load().catch(e=>{document.body.innerHTML='<main><h1>Not signed in to this page</h1><p>Open it with <code>dw-pc-time open</code> on this computer.</p></main>'});setInterval(()=>load().catch(()=>{}),30000);
</script></body></html>'''


def make_handler(app):
    class H(http.server.BaseHTTPRequestHandler):
        server_version = 'dw-pc-time'

        def log_message(self, *a):
            pass

        def _host_ok(self):  # blocks DNS-rebinding: only our own loopback address
            return self.headers.get('Host', '') in (f'127.0.0.1:{app.port}', f'localhost:{app.port}')

        def _send(self, code, body, ctype='application/json', extra=None):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _ext_cors(self):
            o = self.headers.get('Origin', '')
            return {'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type, X-DW-Token',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true',
                    'Vary': 'Origin'} if re.match(r'^(chrome|moz|safari-web)-extension://[\w.-]+$', o) else {}

        def _page_ok(self):
            c = self.headers.get('Cookie', '')
            m = re.search(r'(?:^|;\s*)dwpc=([A-Za-z0-9_-]+)', c)
            return bool(m) and hmac.compare_digest(m.group(1), app.page_token)

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > 10000:
                raise ValueError('too large')
            return json.loads(self.rfile.read(n) or b'{}')

        def do_OPTIONS(self):
            if not self._host_ok():
                return self._send(403, {'error': 'host'})
            self._send(204, b'', extra=self._ext_cors())

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, {'error': 'host'})
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == '/':
                t = (q.get('t') or [''])[0]
                if t and hmac.compare_digest(t, app.page_token):  # one-time link from `dw-pc-time open`
                    return self._send(302, b'', 'text/plain', {'Location': '/', 'Set-Cookie': f'dwpc={app.page_token}; HttpOnly; SameSite=Strict; Path=/'})
                return self._send(200, PAGE.encode(), 'text/html; charset=utf-8')
            if u.path == '/api/summary':
                if not self._page_ok():
                    return self._send(401, {'error': 'open this page with: dw-pc-time open'})
                day = (q.get('day') or [dt.date.today().isoformat()])[0]
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
                    return self._send(400, {'error': 'day'})
                return self._send(200, app.summary(day))
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            if not self._host_ok():
                return self._send(403, {'error': 'host'})
            path = urllib.parse.urlparse(self.path).path
            try:
                b = self._body()
            except ValueError:
                return self._send(400, {'error': 'bad request'})
            if path == '/ext/active':  # browser extension: domain of the active tab, nothing else
                cors = self._ext_cors()
                tok = self.headers.get('X-DW-Token', '')
                if not cors or not hmac.compare_digest(tok, app.ext_token):
                    return self._send(401, {'error': 'token'}, extra=cors)
                app.browser.report(b.get('domain'), b.get('focused'))
                return self._send(200, {'ok': True, 'recording': app.details_on()}, extra=cors)
            if not self._page_ok():
                return self._send(401, {'error': 'open this page with: dw-pc-time open'})
            try:
                if path == '/api/rule':
                    app.details.set_rule(b.get('kind'), b.get('name'), b.get('category'))
                    app.mark_recent_dirty()
                elif path == '/api/exclusion':
                    (app.details.remove_exclusion if b.get('remove') else app.details.add_exclusion)(b.get('kind'), b.get('name'))
                    app.mark_recent_dirty()
                elif path == '/api/delete':
                    app.details.delete_history(None if b.get('all') else b.get('day'))
                    app.mark_recent_dirty()
                elif path == '/api/settings':
                    ch = {}
                    if 'details' in b:
                        ch['details'] = bool(b['details'])
                    if 'domains' in b:
                        ch['domains'] = bool(b['domains'])
                    set_control(**ch)
                else:
                    return self._send(404, {'error': 'not found'})
            except ValueError as e:
                return self._send(400, {'error': str(e)})
            self._send(200, {'ok': True})
    return H


class LocalApp:
    def __init__(self, state, details, browser, port=PORT):
        self.state, self.details, self.browser, self.port = state, details, browser, port
        self.page_token = state.setdefault('page_token', secrets.token_urlsafe(24))
        self.ext_token = state.setdefault('extension_token', secrets.token_urlsafe(24))

    def details_on(self):
        return bool(read_json(CONTROL, {}).get('details'))

    def summary(self, day):
        c = read_json(CONTROL, {})
        return {'enabled': bool(c.get('details')), 'domains': c.get('domains', True), 'day': day,
                'total': round(self.state['days'].get(day, 0)), 'summary': self.details.day_summary(day),
                'exclusions': self.details.exclusions(), 'extension_token': self.ext_token}

    def mark_recent_dirty(self):  # re-send the Work / Personal split of the last 7 days
        for d in self.state.get('days', {}):
            if d >= (dt.date.today() - dt.timedelta(days=7)).isoformat() and d not in self.state['dirty']:
                self.state['dirty'].append(d)

    def serve(self):
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', self.port), make_handler(self))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv


# ---------------------------------------------------------------- start at login, per system
def autostart(on):
    py = sys.executable
    script = os.path.abspath(__file__)
    if SYSTEM == 'Linux':
        unit_dir = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'systemd', 'user')
        unit = os.path.join(unit_dir, APP + '.service')
        if on:
            os.makedirs(unit_dir, exist_ok=True)
            with open(unit, 'w', encoding='utf-8') as f:
                f.write(f'[Unit]\nDescription=Daily Workspace — PC Work Time\nPartOf=graphical-session.target\nAfter=graphical-session.target\n\n'
                        f'[Service]\nExecStart={py} {script} run\nRestart=on-failure\nRestartSec=20\n\n[Install]\nWantedBy=graphical-session.target\n')
            subprocess.run(['systemctl', '--user', 'daemon-reload'], check=False)
            subprocess.run(['systemctl', '--user', 'enable', '--now', APP + '.service'], check=False)
        else:
            subprocess.run(['systemctl', '--user', 'disable', '--now', APP + '.service'], check=False)
    elif SYSTEM == 'Darwin':
        plist = os.path.expanduser('~/Library/LaunchAgents/com.dailyworkspace.pctime.plist')
        uid = str(os.getuid())
        if on:
            os.makedirs(os.path.dirname(plist), exist_ok=True)
            with open(plist, 'wb') as f:
                plistlib.dump({'Label': 'com.dailyworkspace.pctime', 'ProgramArguments': [py, script, 'run'],
                               'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'ProcessType': 'Background'}, f)
            subprocess.run(['launchctl', 'bootout', f'gui/{uid}', plist], check=False, capture_output=True)
            subprocess.run(['launchctl', 'bootstrap', f'gui/{uid}', plist], check=False)
        else:
            subprocess.run(['launchctl', 'bootout', f'gui/{uid}', plist], check=False, capture_output=True)
            if os.path.exists(plist):
                os.remove(plist)
    elif SYSTEM == 'Windows':
        import winreg
        pyw = os.path.join(os.path.dirname(py), 'pythonw.exe')
        cmd = f'"{pyw if os.path.exists(pyw) else py}" "{script}" run'
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, winreg.KEY_SET_VALUE) as k:
            if on:
                winreg.SetValueEx(k, 'DailyWorkspacePCTime', 0, winreg.REG_SZ, cmd)
            else:
                try:
                    winreg.DeleteValue(k, 'DailyWorkspacePCTime')
                except FileNotFoundError:
                    pass
    print('Starts at login: ' + ('on' if on else 'off'))


# ---------------------------------------------------------------- commands
def load_config():
    cfg = read_json(CONFIG, None)
    if not cfg or not all(cfg.get(k) for k in ('url', 'publishable_key', 'device_key')):
        sys.exit('Not connected yet. In Daily Workspace open Settings → PC Work Time → Connect this PC, '
                 'then run the command it shows (or: dw-pc-time pair CODE).')
    return cfg


def cmd_pair(code):
    try:
        raw = base64.urlsafe_b64decode(code + '=' * (-len(code) % 4))
        data = json.loads(raw)
        cfg = {'url': data['u'], 'publishable_key': data['k'], 'device_key': data['d'], 'name': data.get('n', ''), 'origin': data.get('o', '')}
    except Exception:
        sys.exit('That code is not valid. Copy it again from Settings → PC Work Time.')
    local = cfg['url'].startswith(('http://localhost:', 'http://127.0.0.1:'))  # local test server only
    if not (cfg['url'].startswith('https://') or local) or not cfg['device_key'].startswith('dwpc_'):
        sys.exit('That code is not valid. Copy it again from Settings → PC Work Time.')
    write_json(CONFIG, cfg)
    print(f'Connected as “{cfg["name"] or "this computer"}”.')
    err = upload(read_json(STATE, {'days': {}, 'dirty': []}), Server(cfg), read_json(CONTROL, {}))
    print('Check with the server: ' + ('OK' if not err else err))
    return 0 if not err else 1


def set_control(**changes):
    c = read_json(CONTROL, {})
    c.update(changes)
    write_json(CONTROL, c)
    return c


def cmd_pause(paused):
    set_control(paused=paused, paused_changed_at=now_iso())
    msg = 'Paused: PC Work Time is not counting.' if paused else 'Resumed: PC Work Time is counting again.'
    print(msg)
    notify(msg)


def cmd_idle(minutes):
    try:
        m = int(minutes)
        assert 1 <= m <= 120
    except (ValueError, AssertionError):
        sys.exit('Give a number of minutes between 1 and 120.')
    set_control(idle_minutes=m, idle_changed_at=now_iso())
    print(f'Stops counting after {m} min without keyboard or mouse.')


def status_lines():
    st = read_json(STATE, {})
    days = st.get('days', {})
    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    week = sum(v for d, v in days.items() if monday.isoformat() <= d <= today.isoformat())
    control = read_json(CONTROL, {})
    paused, idle = Counter(dict(st), None).effective(control)
    lines = [f'Today {fmt(days.get(today.isoformat(), 0))} · this week {fmt(week)} (this computer)',
             f'State: {"paused" if paused else st.get("reason", "unknown")} · stops after {idle} min idle'
             f' · Activity Details {"on" if control.get("details") else "off"}',
             f'Last upload: {st.get("last_sync") or "never"}' + (f' · waiting: {len(st.get("dirty", []))} day(s)' if st.get('dirty') else '')]
    if st.get('last_error'):
        lines.append('Last problem: ' + st['last_error'])
    return lines


def cmd_status():
    print('PC Work Time — ' + '\n'.join(status_lines()))


def cmd_sync():
    cfg = load_config()
    st = read_json(STATE, {'days': {}, 'dirty': []})
    err = upload(st, Server(cfg), read_json(CONTROL, {}), Details())
    write_json(STATE, st)
    print('Uploaded.' if not err else err)
    return 0 if not err else 1


def cmd_open():
    st = read_json(STATE, {})
    tok = st.get('page_token')
    if not tok:
        sys.exit('Start the agent first (it starts at login, or run: dw-pc-time run).')
    url = f'http://127.0.0.1:{PORT}/?t={tok}'
    print('Opening ' + url.split('?')[0])
    webbrowser.open(url)


def _download(rel, dest):
    origin = (read_json(CONFIG, {}) or {}).get('origin') or ''
    if not origin.startswith(('https://', 'http://localhost:')):
        sys.exit('Connect this computer first (dw-pc-time pair CODE).')
    with urllib.request.urlopen(origin.rstrip('/') + '/pc-agent/' + rel, timeout=20) as r:
        data = r.read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as f:
        f.write(data)


def cmd_gnome_extension():
    """GNOME on Wayland: install the tiny extension that exposes the focused app's NAME (only)."""
    uuid = 'focused-app@dailyworkspace.app'
    d = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'gnome-shell', 'extensions', uuid)
    for f in ('metadata.json', 'extension.js'):
        _download('gnome-extension/' + f, os.path.join(d, f))
    subprocess.run(['gnome-extensions', 'enable', uuid], check=False, capture_output=True)
    print(f'Installed to {d}.')
    print('GNOME loads new extensions at the next login on Wayland: log out and back in, then run: gnome-extensions enable ' + uuid)


def cmd_browser_extension():
    """Save the optional browser extension (website domains only) in a folder to load in the browser."""
    d = os.path.join(os.path.expanduser('~'), 'DailyWorkspace-browser-extension')
    for f in ('manifest.json', 'background.js', 'options.html', 'options.js'):
        _download('browser-extension/' + f, os.path.join(d, f))
    tok = read_json(STATE, {}).get('extension_token') or '(start the agent, then run: dw-pc-time extension-token)'
    print(f'Saved to {d}')
    print('Chrome / Edge / Brave: open chrome://extensions → turn on Developer mode → Load unpacked → choose that folder.')
    print('Firefox: about:debugging → This Firefox → Load Temporary Add-on → choose manifest.json (until restart).')
    print('Then open the extension\'s options and paste this token: ' + tok)


def cmd_run():
    cfg = load_config()
    server = Server(cfg)
    state = read_json(STATE, {})
    details = Details()
    browser = BrowserState()
    local = LocalApp(state, details, browser)
    write_json(STATE, state)  # tokens for `open` and the extension
    try:
        local.serve()
    except OSError as e:
        print(f'Local page unavailable (port {PORT}: {e}). Counting continues.', file=sys.stderr)
    counter = Counter(state, make_desktop(), browser=browser)
    stop = {'now': False}

    def handle(_sig, _frm):
        stop['now'] = True
    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    last_sync = last_save = 0.0
    while not stop['now']:
        control = read_json(CONTROL, {})
        counter.details = details if control.get('details') else None
        counter.step(control)
        state['reason'] = counter.reason
        mono = time.monotonic()
        if mono - last_sync >= SYNC_EVERY:
            counter.prune()
            details.prune(counter.today())
            upload(state, server, control, details)
            last_sync = mono
        if mono - last_save >= SAVE_EVERY:
            write_json(STATE, state)
            last_save = mono
        for _ in range(TICK * 2):
            if stop['now']:
                break
            time.sleep(0.5)
    write_json(STATE, state)
    try:
        upload(state, server, read_json(CONTROL, {}), details)
        write_json(STATE, state)
    except Exception:
        pass
    return 0


def main(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]
    onoff = lambda: (args[0] if args else '') in ('on', 'off')
    if cmd == 'run':
        return cmd_run()
    if cmd == 'status':
        return cmd_status()
    if cmd == 'notify':
        return notify('\n'.join(status_lines()))
    if cmd == 'open':
        return cmd_open()
    if cmd == 'pause':
        return cmd_pause(True)
    if cmd == 'resume':
        return cmd_pause(False)
    if cmd == 'idle' and args:
        return cmd_idle(args[0])
    if cmd == 'details' and onoff():
        set_control(details=args[0] == 'on')
        print('Activity Details ' + ('on: stored on this computer only. See them with: dw-pc-time open' if args[0] == 'on' else 'off (already recorded details stay until you delete them)'))
        return 0
    if cmd == 'domains' and onoff():
        set_control(domains=args[0] == 'on')
        print('Website domains from the browser extension: ' + args[0])
        return 0
    if cmd == 'autostart' and onoff():
        return autostart(args[0] == 'on')
    if cmd == 'gnome-extension':
        return cmd_gnome_extension()
    if cmd == 'browser-extension':
        return cmd_browser_extension()
    if cmd == 'extension-token':
        print(read_json(STATE, {}).get('extension_token') or 'Start the agent first.')
        return 0
    if cmd == 'sync':
        return cmd_sync()
    if cmd == 'pair' and args:
        return cmd_pair(args[0])
    if cmd == 'version':
        print(VERSION)
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]) or 0)
