#!/usr/bin/env python3
"""Daily Workspace — PC Work Time agent (Ubuntu / GNOME, Wayland or X11).

Counts the time this computer is actively used and sends ONE number per day (seconds) to your
Daily Workspace account. Nothing else leaves the computer: no screenshots, no window titles, no
keystrokes, no list of when you were active.

Counting rules (checked every few seconds):
  * counts while you use the keyboard or mouse, and up to N minutes without input (N = idle minutes,
    5 by default, set in the dashboard or with `dw-pc-time idle N`);
  * stops after N minutes without input, while the screen is locked, while Paused, and while the
    computer is suspended or off; continues on its own when you come back.
Offline: totals are kept on this computer and sent when the connection is back.

Usage:  dw-pc-time run | status | notify | pause | resume | idle MINUTES | sync | pair CODE
Files:  ~/.config/daily-workspace-pc-time/config.json  (server address + this computer's key, 0600)
        ~/.local/state/daily-workspace-pc-time/state.json (per-day totals, settings)
        ~/.config/daily-workspace-pc-time/control.json (your Pause / Resume / idle changes)
"""
import base64
import datetime as dt
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

VERSION = '1.0.0'
APP = 'daily-workspace-pc-time'
CONFIG_DIR = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), APP)
STATE_DIR = os.path.join(os.environ.get('XDG_STATE_HOME') or os.path.expanduser('~/.local/state'), APP)
CONFIG = os.path.join(CONFIG_DIR, 'config.json')
CONTROL = os.path.join(CONFIG_DIR, 'control.json')
STATE = os.path.join(STATE_DIR, 'state.json')

TICK = 10            # seconds between checks
SYNC_EVERY = 60      # seconds between uploads (when something changed, or as a heartbeat)
SAVE_EVERY = 60      # seconds between writes of the local state
KEEP_DAYS = 35       # local totals older than this are dropped (the server ignores them too)
DEFAULT_IDLE_MIN = 5


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


def notify(text):
    if shutil.which('notify-send'):
        subprocess.run(['notify-send', '-a', 'Daily Workspace', 'PC Work Time', text], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


# ---------------------------------------------------------------- what the desktop tells us
def _gdbus(dest, path, method):
    out = subprocess.run(['gdbus', 'call', '--session', '--dest', dest, '--object-path', path, '--method', method],
                         capture_output=True, text=True, timeout=5)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or 'gdbus failed')
    return out.stdout.strip()


class Desktop:
    """Idle time and lock state. GNOME first (works on Wayland), then common fallbacks."""

    def idle_ms(self):
        try:  # GNOME / Mutter, Wayland and X11: "(uint64 12345,)"
            out = _gdbus('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core',
                         'org.gnome.Mutter.IdleMonitor.GetIdletime')
            return int(out.strip('(),').split()[-1].rstrip(','))
        except Exception:
            pass
        try:  # KDE and others: seconds
            out = _gdbus('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver',
                         'org.freedesktop.ScreenSaver.GetSessionIdleTime')
            return int(out.strip('(),').split()[-1].rstrip(',')) * 1000
        except Exception:
            pass
        if shutil.which('xprintidle'):  # X11
            try:
                return int(subprocess.run(['xprintidle'], capture_output=True, text=True, timeout=5).stdout.strip())
            except Exception:
                pass
        return None  # unknown: the agent does not count rather than guess

    def locked(self):
        try:
            return 'true' in _gdbus('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.GetActive')
        except Exception:
            pass
        try:
            return 'true' in _gdbus('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver.GetActive')
        except Exception:
            pass
        sid = os.environ.get('XDG_SESSION_ID')
        if sid and shutil.which('loginctl'):
            try:
                out = subprocess.run(['loginctl', 'show-session', sid, '-p', 'LockedHint', '--value'],
                                     capture_output=True, text=True, timeout=5).stdout.strip()
                return out == 'yes'
            except Exception:
                pass
        return False


# ---------------------------------------------------------------- the counter (pure logic, tested)
class Counter:
    """Adds active seconds to today's total. `step()` is called every TICK seconds."""

    def __init__(self, state, desktop, clock=time.time, today=lambda: dt.date.today().isoformat()):
        self.s = state
        self.s.setdefault('days', {})        # {"YYYY-MM-DD": seconds}
        self.s.setdefault('dirty', [])       # days changed since the last successful upload
        self.s.setdefault('server', {})      # settings last received from the server
        self.desktop = desktop
        self.clock = clock
        self.today = today
        self.last = None                     # wall-clock time of the previous step
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
        # Much longer than a tick: the computer was suspended / hibernated, or the clock jumped.
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


def upload(state, server, control):
    """Send the days changed since the last upload (or just a heartbeat). Returns an error text or None."""
    dirty = list(state.get('dirty', []))
    days = {d: int(round(state['days'][d])) for d in dirty if d in state['days']}
    try:
        res = server.sync(days, control)
    except SyncRefused as e:
        state['last_error'] = str(e)
        return str(e)
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
        state['last_error'] = f'offline: {getattr(e, "reason", e)}'
        return state['last_error']
    # Days that changed again while uploading stay dirty for the next round.
    state['dirty'] = [d for d in state.get('dirty', []) if d not in days or int(round(state['days'].get(d, 0))) != days[d]]
    state['server'] = {k: res.get(k) for k in ('idle_minutes', 'paused', 'idle_changed_at', 'paused_changed_at')} if isinstance(res, dict) else state.get('server', {})
    state['last_sync'] = now_iso()
    state['device'] = res.get('device') if isinstance(res, dict) else state.get('device')
    state.pop('last_error', None)
    return None


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
        cfg = {'url': data['u'], 'publishable_key': data['k'], 'device_key': data['d'], 'name': data.get('n', '')}
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
    paused, idle = Counter(dict(st), Desktop()).effective(read_json(CONTROL, {}))
    lines = [f'Today {fmt(days.get(today.isoformat(), 0))} · this week {fmt(week)} (this computer)',
             f'State: {"paused" if paused else st.get("reason", "unknown")} · stops after {idle} min idle',
             f'Last upload: {st.get("last_sync") or "never"}' + (f' · waiting: {len(st.get("dirty", []))} day(s)' if st.get('dirty') else '')]
    if st.get('last_error'):
        lines.append('Last problem: ' + st['last_error'])
    return lines


def cmd_status():
    print('PC Work Time — ' + '\n'.join(status_lines()))


def cmd_sync():
    cfg = load_config()
    st = read_json(STATE, {'days': {}, 'dirty': []})
    err = upload(st, Server(cfg), read_json(CONTROL, {}))
    write_json(STATE, st)
    print('Uploaded.' if not err else err)
    return 0 if not err else 1


def cmd_run():
    cfg = load_config()
    server = Server(cfg)
    state = read_json(STATE, {})
    counter = Counter(state, Desktop())
    stop = {'now': False}

    def handle(_sig, _frm):
        stop['now'] = True
    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    last_sync = last_save = 0.0
    while not stop['now']:
        control = read_json(CONTROL, {})
        counter.step(control)
        state['reason'] = counter.reason
        mono = time.monotonic()
        if mono - last_sync >= SYNC_EVERY:
            counter.prune()
            upload(state, server, control)
            last_sync = mono
        if mono - last_save >= SAVE_EVERY:
            write_json(STATE, state)
            last_save = mono
        for _ in range(TICK * 2):  # wake up quickly on SIGTERM
            if stop['now']:
                break
            time.sleep(0.5)
    write_json(STATE, state)
    try:
        upload(state, server, read_json(CONTROL, {}))
        write_json(STATE, state)
    except Exception:
        pass
    return 0


def main(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]
    if cmd == 'run':
        return cmd_run()
    if cmd == 'status':
        return cmd_status()
    if cmd == 'notify':
        return notify('\n'.join(status_lines()))
    if cmd == 'pause':
        return cmd_pause(True)
    if cmd == 'resume':
        return cmd_pause(False)
    if cmd == 'idle' and args:
        return cmd_idle(args[0])
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
