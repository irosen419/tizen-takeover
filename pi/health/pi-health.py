#!/usr/bin/env python3
"""
Weekly Pi health report.

Runs on the Pi itself (not in Docker), once a week from a systemd user timer
(install.sh in this folder sets it up). It collects everything worth knowing
about the Pi's health into one JSON file, so a Claude thread only has to read
and judge it:

    pi/data/health/latest.json        the newest report
    pi/data/health/YYYY-MM-DD.json    one per run, the newest 12 kept
    pi/data/health/latest.txt         the same in a few plain lines

The hub server (mailbox.js) copies a new latest.json to the Claude mailbox
bucket as health/latest.json and health/YYYY-MM-DD.json, so a cloud thread
can read it with curl.

What it never writes: tokens, keys or anything else from pi/.env, IP or MAC
addresses, Wi-Fi names, links, email addresses, Home Assistant entity ids,
budget amounts, to-do text, song or show titles. Every report is scrubbed
once more before it is written (scrub()).

Each check is on its own: one that fails or is not allowed (no permission,
tool missing) writes {"error": "..."} and the rest go on. The script exits 0
unless it could not write the report at all.

Extra checks: every executable file in checks.d/ is run and its JSON is kept
under "extras" (see checks.d/README.md). New parts of the Pi (Bluetooth storm
sounds, room lights) add their checks there, not here.

Run by hand:  python3 pi/health/pi-health.py           (writes the files)
              python3 pi/health/pi-health.py --print   (prints, writes nothing)
              --quick skips the slow parts (pings, week of history, Docker logs).

Python 3.7 or newer, standard library only.
"""
import datetime
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_VERSION = '1.0.0'
HERE = os.path.dirname(os.path.abspath(__file__))
PI_DIR = os.path.dirname(HERE)
REPO_DIR = os.path.dirname(PI_DIR)
HOME = os.path.expanduser('~')
KEEP_REPORTS = 12
WEEK = 7 * 24 * 3600

# Where a value turns a check yellow (warn) or red (bad). Tune here.
LIMITS = {
    'cpu_temp_warn': 70.0, 'cpu_temp_bad': 80.0,          # degrees C
    'mem_avail_warn': 15.0, 'mem_avail_bad': 5.0,         # % of RAM still available
    'swap_used_warn': 50.0, 'swap_used_bad': 85.0,        # % of swap in use
    'disk_warn': 80.0, 'disk_bad': 90.0,                  # % of a filesystem in use
    'inode_warn': 80.0,
    'load_warn': 1.5,                                     # 15-minute load per CPU core
    'wifi_signal_warn': -70, 'wifi_signal_bad': -80,      # dBm
    'ping_loss_warn': 2.0, 'ping_loss_bad': 10.0,         # % lost
    'ping_ms_warn': 50.0,                                 # average to the router
    'translate_warn': 0.8,                                # share of the daily cap on the busiest day
    'log_errors_warn': 20,                                # hub log problems in the last 24 hours
    'repo_stale_hours': 3,                                # auto-update: hours behind before it counts as stuck
    'journal_mb_warn': 1000,
    'stale_hours': {'calendar': 3, 'shows': 13, 'budget': 26, 'awws': 26, 'mailbox': 1},
}

# Kernel log lines worth counting over the week. Counts and a few scrubbed samples only.
KERNEL_PATTERNS = {
    'storage': r'mmc\d+:.*(error|timeout|timed out)|I/O error|EXT4-fs (error|warning)|Buffer I/O error|blk_update_request|critical medium error|nvme\S*:.*(error|timeout|reset)|FAT-fs \(.*\): error',
    'undervoltage': r'[Uu]nder-?voltage',
    'oom': r'Out of memory|oom-kill|invoked oom-killer|Killed process',
    'thermal': r'thermal|[Tt]emperature above threshold|cpu clock throttled',
    'wifi': r'brcmf\S*:.*(error|fail|timeout)|wlan\d: .*(disconnect|deauth|reason)',
    'usb': r'usb \S+: .*(error|disconnect|reset|over-current)',
    'bluetooth': r'[Bb]luetooth: .*(error|fail|timeout)|hci\d: .*(error|fail|timeout)',
    'segfault': r'segfault|general protection|kernel BUG|Oops',
}

# Home Assistant integrations whose entities describe this Pi or HA itself.
HA_INTEGRATIONS = ['systemmonitor', 'rpi_power', 'raspberry_pi', 'glances', 'hassio', 'version', 'uptime']

ARGS = set(sys.argv[1:])
QUICK = '--quick' in ARGS
PRINT_ONLY = '--print' in ARGS
# Overrides for the tests (pi/health/test_pi_health.py); the timer sets none of them.
DATA_DIR = os.environ.get('PI_HEALTH_DATA') or os.path.join(PI_DIR, 'data')
OUT_DIR = os.environ.get('PI_HEALTH_OUT') or os.path.join(DATA_DIR, 'health')
ENV_FILE = os.environ.get('PI_HEALTH_ENV') or os.path.join(PI_DIR, '.env')
CHECKS_DIR = os.environ.get('PI_HEALTH_CHECKS') or os.path.join(HERE, 'checks.d')

flags = []          # {"level": "bad"|"warn", "area", "text"}
script_errors = []


def flag(level, area, text):
    flags.append({'level': level, 'area': area, 'text': text})


# ---------- small helpers ----------

def run(cmd, timeout=20, env=None):
    """Runs a command. Returns (exit code, stdout text) or (None, reason) when it could not run."""
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                           env=env, universal_newlines=True, errors='replace')
        return p.returncode, p.stdout
    except FileNotFoundError:
        return None, 'not installed'
    except subprocess.TimeoutExpired:
        return None, 'timed out'
    except Exception as e:  # noqa: BLE001
        return None, type(e).__name__


def have(name):
    return shutil.which(name) is not None


def read(path, default=None):
    try:
        with open(path, 'r', errors='replace') as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return default


def num(text, default=None):
    try:
        return float(text)
    except Exception:  # noqa: BLE001
        return default


def pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else None


def mb(nbytes):
    return round(nbytes / 1048576.0, 1) if nbytes is not None else None


def iso(ts):
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec='seconds')


def hours_since(iso_text):
    try:
        t = datetime.datetime.fromisoformat(str(iso_text).replace('Z', '+00:00'))
        if t.tzinfo is None:
            t = t.astimezone()
        return round((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 3600.0, 1)
    except Exception:  # noqa: BLE001
        return None


def parse_env(path):
    out = {}
    for line in (read(path, '') or '').splitlines():
        m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if not m:
            continue
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        out[m.group(1)] = v
    return out


def section(name, fn, *a):
    t0 = time.time()
    try:
        out = fn(*a)
    except Exception as e:  # noqa: BLE001
        script_errors.append(name + ': ' + type(e).__name__ + ': ' + str(e)[:200])
        out = {'error': type(e).__name__ + ': ' + str(e)[:200]}
    if isinstance(out, dict):
        out['_seconds'] = round(time.time() - t0, 1)
    return out


# ---------- scrubbing ----------

IPV4_RE = re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])')
IPV6_RE = re.compile(r'(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])')
MAC_RE = re.compile(r'(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])')
EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
URL_RE = re.compile(r'\b(?:https?|wss?|webcal)://[^\s"\'<>]+')
ENTITY_RE = re.compile(r'(?<![\w.-])(?:sensor|binary_sensor|light|switch|media_player|update|button|number|select|input_\w+|automation|script|scene|climate|fan|cover|device_tracker|person|zone|sun|weather|camera|remote)\.(?!(?:service|timer|socket|target|js|py|sh|json|txt|md)\b)[a-z0-9_]+\b')


def looks_ipv6(t):
    """Only real IPv6 addresses: a '::' or a hex letter, so times like 10:22:01 stay."""
    return t.count(':') >= 2 and ('::' in t or bool(re.search(r'[A-Fa-f]', t))) and len(t) >= 6


def scrub(text, secrets):
    """Takes out anything from pi/.env and every address, link, email and entity id."""
    for s in sorted(secrets, key=len, reverse=True):
        text = text.replace(s, '[hidden]')
        esc = json.dumps(s)[1:-1]
        if esc != s:
            text = text.replace(esc, '[hidden]')
    text = URL_RE.sub('[link]', text)
    text = EMAIL_RE.sub('[email]', text)
    text = MAC_RE.sub('[mac]', text)
    text = IPV4_RE.sub('[address]', text)
    text = IPV6_RE.sub(lambda m: '[address]' if looks_ipv6(m.group(0)) else m.group(0), text)
    text = ENTITY_RE.sub('[entity]', text)
    return text


def secret_values(env):
    """Every value in pi/.env long enough to matter, kept only to scrub them out."""
    out = set()
    for k, v in env.items():
        if re.search(r'(TIMEZONE|_PORT|_SECONDS|_MINUTES|_DAYS|_DETAILS)$', k):
            continue
        if v and len(v) >= 6 and not re.fullmatch(r'\d+|true|false|on|off|yes|no', v, re.I):
            out.add(v)
            # A URL's host on its own too, so HA_URL's host never shows.
            m = re.match(r'^[a-z]+://([^/:@]+)', v)
            if m and len(m.group(1)) >= 4:
                out.add(m.group(1))
    return out


# ---------- the checks ----------

def check_system():
    up = num((read('/proc/uptime', '0') or '0').split()[0], 0)
    load = (read('/proc/loadavg', '') or '').split()
    osr = {}
    for line in (read('/etc/os-release', '') or '').splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            osr[k] = v.strip('"')
    cores = os.cpu_count() or 1
    out = {
        'model': (read('/proc/device-tree/model', '') or '').strip('\x00\n ') or None,
        'os': osr.get('PRETTY_NAME'),
        'kernel': os.uname().release,
        'arch': os.uname().machine,
        'cores': cores,
        'uptimeHours': round(up / 3600.0, 1),
        'bootedAt': iso(time.time() - up) if up else None,
        'bootId': (read('/proc/sys/kernel/random/boot_id', '') or '').strip() or None,
        'load': [num(x) for x in load[:3]] if len(load) >= 3 else None,
        'timezone': time.strftime('%Z'),
        'python': sys.version.split()[0],
    }
    if out['load'] and out['load'][2] is not None and out['load'][2] / cores > LIMITS['load_warn']:
        flag('warn', 'cpu', '15-minute load is %.2f on %d cores' % (out['load'][2], cores))
    return out


THROTTLE_BITS = {
    0: 'underVoltageNow', 1: 'freqCappedNow', 2: 'throttledNow', 3: 'softTempLimitNow',
    16: 'underVoltageSinceBoot', 17: 'freqCappedSinceBoot', 18: 'throttledSinceBoot', 19: 'softTempLimitSinceBoot',
}


def decode_throttled(value):
    return {name: bool(value & (1 << bit)) for bit, name in THROTTLE_BITS.items()}


def check_cpu():
    out = {}
    temps = []
    for z in sorted(glob.glob('/sys/class/thermal/thermal_zone*/temp')):
        t = num(read(z, ''))
        if t is not None:
            temps.append(round(t / 1000.0, 1))
    out['tempNowC'] = max(temps) if temps else None
    if have('vcgencmd'):
        rc, txt = run(['vcgencmd', 'get_throttled'])
        m = re.search(r'throttled=(0x[0-9a-fA-F]+)', txt or '') if rc == 0 else None
        if m:
            v = int(m.group(1), 16)
            out['throttledRaw'] = m.group(1)
            out['throttled'] = decode_throttled(v)
        else:
            out['throttled'] = {'error': 'vcgencmd get_throttled did not answer (is the user in the video group?)'}
        rc, txt = run(['vcgencmd', 'measure_clock', 'arm'])
        m = re.search(r'=(\d+)', txt or '') if rc == 0 else None
        out['armClockMHz'] = round(int(m.group(1)) / 1e6) if m else None
        rc, txt = run(['vcgencmd', 'measure_volts', 'core'])
        m = re.search(r'=([\d.]+)V', txt or '') if rc == 0 else None
        out['coreVolts'] = float(m.group(1)) if m else None
    else:
        out['throttled'] = {'error': 'vcgencmd is not installed'}
    gov = read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor')
    out['governor'] = gov.strip() if gov else None
    t = out['tempNowC']
    if t is not None:
        if t >= LIMITS['cpu_temp_bad']:
            flag('bad', 'cpu', 'CPU is at %.1f C right now' % t)
        elif t >= LIMITS['cpu_temp_warn']:
            flag('warn', 'cpu', 'CPU is at %.1f C right now' % t)
    th = out.get('throttled') or {}
    if th.get('underVoltageNow') or th.get('throttledNow'):
        flag('bad', 'power', 'The Pi is under-volted or throttled right now (throttled=%s)' % out.get('throttledRaw'))
    elif th.get('underVoltageSinceBoot'):
        flag('warn', 'power', 'Under-voltage happened since the last boot: check the power supply and cable')
    elif th.get('throttledSinceBoot') or th.get('softTempLimitSinceBoot'):
        flag('warn', 'cpu', 'The CPU was throttled since the last boot (heat or power)')
    return out


def check_memory():
    mi = {}
    for line in (read('/proc/meminfo', '') or '').splitlines():
        m = re.match(r'^(\w+):\s+(\d+)', line)
        if m:
            mi[m.group(1)] = int(m.group(2)) * 1024
    vm = {}
    for line in (read('/proc/vmstat', '') or '').splitlines():
        p = line.split()
        if len(p) == 2 and p[0] in ('pswpin', 'pswpout', 'oom_kill'):
            vm[p[0]] = int(p[1])
    total = mi.get('MemTotal', 0)
    avail = mi.get('MemAvailable', 0)
    st, sf = mi.get('SwapTotal', 0), mi.get('SwapFree', 0)
    zram = [os.path.basename(d) for d in glob.glob('/sys/block/zram*')]
    out = {
        'totalMB': mb(total), 'availableMB': mb(avail), 'availablePct': pct(avail, total),
        'swapTotalMB': mb(st), 'swapUsedMB': mb(st - sf), 'swapUsedPct': pct(st - sf, st),
        'swapPagesInSinceBoot': vm.get('pswpin'), 'swapPagesOutSinceBoot': vm.get('pswpout'),
        'oomKillsSinceBoot': vm.get('oom_kill'), 'zram': zram or None,
    }
    if out['availablePct'] is not None:
        if out['availablePct'] < LIMITS['mem_avail_bad']:
            flag('bad', 'memory', 'Only %.1f%% of memory is available' % out['availablePct'])
        elif out['availablePct'] < LIMITS['mem_avail_warn']:
            flag('warn', 'memory', 'Only %.1f%% of memory is available' % out['availablePct'])
    if out['swapUsedPct'] is not None:
        if out['swapUsedPct'] >= LIMITS['swap_used_bad']:
            flag('bad', 'memory', 'Swap is %.0f%% used' % out['swapUsedPct'])
        elif out['swapUsedPct'] >= LIMITS['swap_used_warn']:
            flag('warn', 'memory', 'Swap is %.0f%% used' % out['swapUsedPct'])
    if vm.get('oom_kill'):
        flag('bad', 'memory', 'The kernel killed %d process(es) for lack of memory since the last boot' % vm['oom_kill'])
    return out


def du(path):
    """Size in bytes of a folder (what this user can read), or None."""
    if not os.path.exists(path):
        return None
    rc, txt = run(['du', '-sxb', path], timeout=60)
    m = re.match(r'^(\d+)', txt or '') if rc is not None else None
    return int(m.group(1)) if m else None


def check_disk():
    out = {'filesystems': [], 'folders': {}, 'dataFiles': []}
    rc, txt = run(['findmnt', '-rno', 'TARGET,FSTYPE,SOURCE,OPTIONS'])
    mounts = []
    if rc == 0:
        for line in txt.splitlines():
            p = line.split()
            if len(p) < 4 or not p[2].startswith('/dev/') or p[2].startswith('/dev/loop'):
                continue
            # Read-only images (squashfs and the like) are always full; a read-only root is judged in storage.
            if p[0] != '/' and ('ro' in p[3].split(',') or p[1] in ('squashfs', 'iso9660', 'erofs')):
                continue
            mounts.append((p[0], p[1], p[2]))
    if not mounts:
        mounts = [('/', '?', '?')]
    seen = set()
    for target, fstype, source in mounts:
        try:
            s = os.statvfs(target)
        except Exception:  # noqa: BLE001
            continue
        key = (s.f_blocks, s.f_bfree, s.f_files)
        if key in seen:
            continue
        seen.add(key)
        size = s.f_blocks * s.f_frsize
        used = (s.f_blocks - s.f_bfree) * s.f_frsize
        free_user = s.f_bavail * s.f_frsize
        fs = {
            'mount': target, 'type': fstype, 'device': os.path.basename(source),
            'sizeGB': round(size / 1e9, 2), 'usedGB': round(used / 1e9, 2), 'freeGB': round(free_user / 1e9, 2),
            'usedPct': pct(used, used + free_user), 'inodesUsedPct': pct(s.f_files - s.f_ffree, s.f_files),
        }
        out['filesystems'].append(fs)
        if fs['usedPct'] is not None:
            if fs['usedPct'] >= LIMITS['disk_bad']:
                flag('bad', 'disk', '%s is %.0f%% full (%.1f GB free)' % (target, fs['usedPct'], fs['freeGB']))
            elif fs['usedPct'] >= LIMITS['disk_warn']:
                flag('warn', 'disk', '%s is %.0f%% full (%.1f GB free)' % (target, fs['usedPct'], fs['freeGB']))
        if fs['inodesUsedPct'] and fs['inodesUsedPct'] >= LIMITS['inode_warn']:
            flag('warn', 'disk', '%s has used %.0f%% of its inodes' % (target, fs['inodesUsedPct']))
    folders = {'pi/data': DATA_DIR, '/var/log': '/var/log', '/tmp': '/tmp', '~/.cache': os.path.join(HOME, '.cache')}
    for d in sorted(glob.glob(os.path.join(HOME, 'code', '*'))):
        if os.path.isdir(d):
            folders['~/code/' + os.path.basename(d)] = d
    for label, path in folders.items():
        folders_mb = mb(du(path))
        if folders_mb is not None:
            out['folders'][label] = folders_mb
    files = []
    for root, _dirs, names in os.walk(DATA_DIR):
        for n in names:
            p = os.path.join(root, n)
            try:
                files.append((os.path.getsize(p), os.path.relpath(p, DATA_DIR)))
            except OSError:
                pass
    files.sort(reverse=True)
    out['dataFiles'] = [{'file': n, 'KB': round(s / 1024.0, 1)} for s, n in files[:15]]
    out['dataFileCount'] = len(files)
    rc, txt = run(['journalctl', '--disk-usage'])
    m = re.search(r'take up ([\d.]+)([KMGT])', txt or '') if rc == 0 else None
    if m:
        mult = {'K': 1 / 1024.0, 'M': 1, 'G': 1024, 'T': 1048576}[m.group(2)]
        out['journalMB'] = round(float(m.group(1)) * mult, 1)
        if out['journalMB'] > LIMITS['journal_mb_warn']:
            flag('warn', 'disk', 'The system journal takes %.0f MB' % out['journalMB'])
    if have('docker'):
        rc, txt = run(['docker', 'system', 'df', '--format', '{{json .}}'], timeout=60)
        if rc == 0:
            rows = []
            for line in txt.splitlines():
                try:
                    j = json.loads(line)
                    rows.append({'type': j.get('Type'), 'count': j.get('TotalCount'), 'active': j.get('Active'),
                                 'size': j.get('Size'), 'reclaimable': j.get('Reclaimable')})
                except ValueError:
                    pass
            out['docker'] = rows
        else:
            out['docker'] = {'error': 'docker system df failed'}
    return out


def check_storage():
    """SD card (or SSD) health: read-only root, ext4 error counters, eMMC wear, device type."""
    out = {}
    rc, txt = run(['findmnt', '-no', 'SOURCE,OPTIONS', '/'])
    if rc == 0 and txt.strip():
        source, _, opts = txt.strip().partition(' ')
        dev = os.path.basename(source)
        out['rootDevice'] = dev
        out['rootKind'] = 'sd card' if dev.startswith('mmcblk') else 'nvme ssd' if dev.startswith('nvme') else 'usb disk' if dev.startswith('sd') else 'other'
        out['rootReadOnly'] = 'ro' in opts.strip().split(',')
        if out['rootReadOnly']:
            flag('bad', 'storage', 'The root filesystem is mounted read-only (usually the card or disk failing)')
        ext = '/sys/fs/ext4/' + dev
        if os.path.isdir(ext):
            for k in ('errors_count', 'first_error_time', 'last_error_time'):
                v = read(os.path.join(ext, k))
                if v is not None:
                    out['ext4_' + k] = int(v.strip() or 0)
            if out.get('ext4_errors_count'):
                flag('bad', 'storage', 'The root filesystem has recorded %d error(s)' % out['ext4_errors_count'])
        base = re.sub(r'p?\d+$', '', dev)
        lt = read('/sys/block/%s/device/life_time' % base)
        if lt:
            out['emmcLifeTime'] = lt.strip()
            out['emmcPreEol'] = (read('/sys/block/%s/device/pre_eol_info' % base) or '').strip()
        for k in ('name', 'oemid', 'date', 'type'):
            v = read('/sys/block/%s/device/%s' % (base, k))
            if v:
                out['card_' + k] = v.strip()
    return out


def kernel_log():
    """The last week of kernel messages, as text, and where it came from."""
    rc, txt = run(['journalctl', '-k', '--since', '-7d', '--no-pager', '-q', '-o', 'short-iso'], timeout=60)
    if rc == 0 and txt.strip():
        return txt, 'journal (7 days)'
    rc2, txt2 = run(['dmesg', '-T'], timeout=30)
    if rc2 == 0 and txt2.strip():
        return txt2, 'dmesg (since boot only: the journal could not be read)'
    return '', 'unreadable (add the user to the adm group, or turn on the persistent journal)'


def check_kernel(secrets):
    txt, source = kernel_log()
    out = {'source': source, 'counts': {}, 'samples': {}}
    for name, pat in KERNEL_PATTERNS.items():
        rx = re.compile(pat)
        hits = [ln for ln in txt.splitlines() if rx.search(ln)]
        out['counts'][name] = len(hits)
        if hits:
            out['samples'][name] = [scrub(h[-200:], secrets) for h in hits[-3:]]
    c = out['counts']
    if c.get('storage'):
        flag('bad', 'storage', '%d storage error line(s) in the kernel log this week (SD card or disk)' % c['storage'])
    if c.get('undervoltage'):
        flag('warn', 'power', '%d under-voltage warning(s) in the kernel log this week' % c['undervoltage'])
    if c.get('oom'):
        flag('bad', 'memory', '%d out-of-memory line(s) in the kernel log this week' % c['oom'])
    if c.get('segfault'):
        flag('warn', 'kernel', '%d crash line(s) (segfault, oops) in the kernel log this week' % c['segfault'])
    if c.get('wifi', 0) >= 10:
        flag('warn', 'network', '%d Wi-Fi error line(s) in the kernel log this week' % c['wifi'])
    if source.startswith('unreadable'):
        flag('warn', 'audit', 'The kernel log could not be read, so SD card and power errors are not checked')
    return out


DATE_RE = re.compile(r'(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})')


def parse_last(text):
    """'last -x -F reboot shutdown' lines -> [(epoch, 'reboot'|'shutdown')] oldest first."""
    events = []
    for line in text.splitlines():
        kind = line.split(' ', 1)[0]
        if kind not in ('reboot', 'shutdown'):
            continue
        m = DATE_RE.search(line)
        if not m:
            continue
        try:
            t = time.mktime(time.strptime(m.group(1), '%a %b %d %H:%M:%S %Y'))
        except ValueError:
            continue
        events.append((t, kind))
    events.sort()
    return events


def unexpected_boots(events, since):
    """Boots after `since` that had no clean shutdown before them (power cut, crash, hang)."""
    out = []
    prev = None
    for t, kind in events:
        if kind == 'reboot' and prev == 'reboot' and t >= since:
            out.append(t)
        prev = kind
    return out


def check_reboots(prev):
    out = {}
    now = time.time()
    rc, txt = run(['last', '-x', '-F', 'reboot', 'shutdown'])
    if rc == 0 and txt.strip():
        ev = parse_last(txt)
        boots = [t for t, k in ev if k == 'reboot' and t >= now - WEEK]
        bad = unexpected_boots(ev, now - WEEK)
        out['source'] = 'wtmp'
        out['bootsThisWeek'] = len(boots)
        out['bootTimes'] = [iso(t) for t in boots][-10:]
        out['uncleanBootsThisWeek'] = len(bad)
        out['uncleanBootTimes'] = [iso(t) for t in bad][-10:]
        if bad:
            flag('warn', 'reboots', '%d reboot(s) this week without a clean shutdown first (power cut or crash)' % len(bad))
    else:
        out['source'] = 'unavailable (no wtmp)'
    rc, txt = run(['journalctl', '--list-boots', '--no-pager', '-q'])
    if rc == 0:
        out['journalBoots'] = len([l for l in txt.splitlines() if l.strip()])
    boot_id = (read('/proc/sys/kernel/random/boot_id', '') or '').strip()
    if prev and prev.get('system', {}).get('bootId'):
        out['rebootedSinceLastReport'] = prev['system']['bootId'] != boot_id
    return out


def check_docker(prev):
    if not have('docker'):
        return {'error': 'docker is not installed'}
    rc, txt = run(['docker', 'ps', '-a', '--format', '{{.Names}}'])
    if rc != 0:
        flag('bad', 'docker', 'docker ps failed (Docker down, or this user is not in the docker group)')
        return {'error': 'docker ps failed'}
    names = [n for n in txt.split() if n]
    prev_restarts = {}
    for c in ((prev or {}).get('docker') or {}).get('containers') or []:
        prev_restarts[c.get('name')] = c.get('restartCount')
    stats = {}
    rc, st = run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], timeout=40)
    if rc == 0:
        for line in st.splitlines():
            try:
                j = json.loads(line)
                stats[j.get('Name')] = {'cpu': j.get('CPUPerc'), 'mem': j.get('MemUsage'), 'memPct': j.get('MemPerc')}
            except ValueError:
                pass
    out = {'containers': []}
    for n in names:
        rc, js = run(['docker', 'inspect', n])
        try:
            d = json.loads(js)[0]
        except Exception:  # noqa: BLE001
            out['containers'].append({'name': n, 'error': 'inspect failed'})
            continue
        s = d.get('State', {})
        c = {
            'name': n,
            'image': (d.get('Config', {}).get('Image') or '').split('@')[0],
            'status': s.get('Status'), 'running': s.get('Running'),
            'restartCount': d.get('RestartCount'),
            'restartsSinceLastReport': None,
            'startedAt': s.get('StartedAt'), 'upHours': hours_since(s.get('StartedAt')) if s.get('Running') else None,
            'exitCode': s.get('ExitCode'), 'oomKilled': s.get('OOMKilled'),
            'health': (s.get('Health') or {}).get('Status'),
            'restartPolicy': (d.get('HostConfig', {}).get('RestartPolicy') or {}).get('Name'),
            'logCap': (d.get('HostConfig', {}).get('LogConfig') or {}).get('Config') or None,
        }
        if n in stats:
            c.update(stats[n])
        if prev_restarts.get(n) is not None and c['restartCount'] is not None and c['restartCount'] >= prev_restarts[n]:
            c['restartsSinceLastReport'] = c['restartCount'] - prev_restarts[n]
        if not QUICK:
            try:
                # docker logs passes the container's stderr through as its own; count both. Counts only.
                p = subprocess.run(['docker', 'logs', '--since', '168h', n], stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, timeout=60, universal_newlines=True, errors='replace')
                lines = p.stdout.splitlines()
                c['logLinesThisWeek'] = len(lines)
                c['logProblemLinesThisWeek'] = len([l for l in lines if re.search(r'\b(error|failed|fail|cannot|exception|fatal|crash)', l, re.I)])
            except Exception:  # noqa: BLE001
                c['logLinesThisWeek'] = None
        out['containers'].append(c)
        if s.get('Status') != 'running' and c['restartPolicy'] in ('always', 'unless-stopped'):
            flag('bad', 'docker', 'Container %s is %s (exit code %s)' % (n, s.get('Status'), s.get('ExitCode')))
        if s.get('OOMKilled'):
            flag('bad', 'docker', 'Container %s was killed for lack of memory' % n)
        if c['health'] == 'unhealthy':
            flag('bad', 'docker', 'Container %s reports unhealthy' % n)
        if c['restartsSinceLastReport']:
            flag('warn', 'docker', 'Container %s restarted %d time(s) by itself since the last report' % (n, c['restartsSinceLastReport']))
        elif c['restartsSinceLastReport'] is None and c['restartCount']:
            flag('warn', 'docker', 'Container %s has restarted %d time(s) by itself since it was created' % (n, c['restartCount']))
    return out


def systemctl(user, *a):
    return run(['systemctl'] + (['--user'] if user else []) + list(a))


def unit_props(user, unit, props):
    rc, txt = systemctl(user, 'show', unit, '-p', ','.join(props))
    out = {}
    if rc == 0:
        for line in txt.splitlines():
            k, _, v = line.partition('=')
            out[k] = v
    return out


def check_systemd():
    out = {}
    if not have('systemctl'):
        return {'error': 'systemctl is not available'}
    for user in (False, True):
        key = 'user' if user else 'system'
        rc, txt = systemctl(user, 'list-units', '--failed', '--no-legend', '--plain', '--no-pager')
        failed = [l.split()[0] for l in (txt or '').splitlines() if l.strip()] if rc == 0 else None
        out[key + 'Failed'] = failed
        if failed:
            flag('bad', 'systemd', '%s unit(s) failed: %s' % (key.capitalize(), ', '.join(failed[:8])))
    rc, txt = systemctl(True, 'list-unit-files', '--type=service', '--state=enabled', '--no-legend', '--no-pager')
    services = []
    for line in (txt or '').splitlines() if rc == 0 else []:
        name = line.split()[0] if line.split() else ''
        if not name.endswith('.service') or '@' in name:
            continue
        p = unit_props(True, name, ['ActiveState', 'SubState', 'Result', 'NRestarts', 'ActiveEnterTimestamp', 'MemoryCurrent', 'Type'])
        svc = {'unit': name, 'active': p.get('ActiveState'), 'sub': p.get('SubState'), 'result': p.get('Result'),
               'restarts': int(p['NRestarts']) if (p.get('NRestarts') or '').isdigit() else None,
               'since': p.get('ActiveEnterTimestamp') or None}
        memc = p.get('MemoryCurrent')
        if memc and memc.isdigit():
            svc['memMB'] = mb(int(memc))
        services.append(svc)
        # A failed one is already in userFailed; a long-running one that is simply stopped is not.
        if p.get('Type') != 'oneshot' and svc['active'] == 'inactive':
            flag('warn', 'systemd', 'User service %s is enabled but not running' % name)
        if svc['restarts']:
            flag('warn', 'systemd', 'User service %s restarted itself %d time(s)' % (name, svc['restarts']))
    out['userServices'] = services
    # System services the hub depends on, when they exist.
    sys_watch = ['docker.service', 'containerd.service', 'NetworkManager.service', 'wpa_supplicant.service', 'dhcpcd.service',
                 'ssh.service', 'cron.service', 'bluetooth.service', 'home-hub.service', 'home-assistant.service', 'hciuart.service']
    sys_out = []
    for u in sys_watch:
        p = unit_props(False, u, ['LoadState', 'ActiveState', 'SubState', 'NRestarts', 'ActiveEnterTimestamp', 'UnitFileState'])
        if p.get('LoadState') != 'loaded':
            continue
        sys_out.append({'unit': u, 'active': p.get('ActiveState'), 'sub': p.get('SubState'), 'enabled': p.get('UnitFileState'),
                        'restarts': int(p['NRestarts']) if (p.get('NRestarts') or '').isdigit() else None,
                        'since': p.get('ActiveEnterTimestamp') or None})
        if p.get('UnitFileState') == 'enabled' and p.get('ActiveState') != 'active':
            flag('bad', 'systemd', 'System service %s is enabled but %s' % (u, p.get('ActiveState')))
    out['systemServices'] = sys_out
    # Timers, user and system: this is where the hourly auto-update, this audit and the like live.
    timers = []
    for user in (True, False):
        rc, txt = systemctl(user, 'list-timers', '--all', '--no-legend', '--no-pager', '--plain')
        for line in (txt or '').splitlines() if rc == 0 else []:
            m = re.search(r'(\S+\.timer)\s+(\S+\.service)\s*$', line)
            if not m:
                continue
            timer, svc = m.group(1), m.group(2)
            if not user and re.match(r'(apt-daily|man-db|fstrim|logrotate|e2scrub|dpkg-db-backup|systemd-tmpfiles|motd-news|sysstat)', timer):
                continue
            tp = unit_props(user, timer, ['LastTriggerUSec', 'NextElapseUSecRealtime'])
            sp = unit_props(user, svc, ['Result', 'ExecMainStatus', 'ExecMainExitTimestamp', 'ActiveState'])
            timers.append({'timer': timer, 'scope': 'user' if user else 'system', 'service': svc,
                           'last': tp.get('LastTriggerUSec') or None, 'next': tp.get('NextElapseUSecRealtime') or None,
                           'lastResult': sp.get('Result'), 'lastExit': sp.get('ExecMainStatus'), 'state': sp.get('ActiveState')})
            if sp.get('Result') not in (None, '', 'success') and not timer.startswith('pi-health'):
                flag('warn', 'systemd', 'The last run of %s ended with %s (exit %s)' % (svc, sp.get('Result'), sp.get('ExecMainStatus')))
    out['timers'] = timers
    linger = run(['loginctl', 'show-user', os.environ.get('USER') or '', '-p', 'Linger'])
    out['linger'] = (linger[1] or '').strip().endswith('=yes') if linger[0] == 0 else None
    if out['linger'] is False:
        flag('warn', 'systemd', 'Linger is off: user services and timers stop when nobody is logged in (sudo loginctl enable-linger)')
    return out


def check_cron(secrets):
    out = {'user': [], 'systemFiles': []}
    rc, txt = run(['crontab', '-l'])
    if rc == 0:
        for line in txt.splitlines():
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            s = re.sub(r'(\b[A-Z_][A-Z0-9_]*=)\S+', r'\1[hidden]', s)  # VAR=value pairs
            out['user'].append(scrub(s, secrets)[:160])
    out['systemFiles'] = sorted(os.path.basename(p) for p in glob.glob('/etc/cron.d/*') if not p.endswith('.placeholder'))
    return out


def git(repo, *a, timeout=20):
    return run(['git', '-C', repo] + list(a), timeout=timeout,
               env=dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/bin/true', LC_ALL='C'))


def check_repos():
    """Each git checkout under ~/code: branch, how far behind GitHub, when it last moved.
    This is how the hourly auto-update is judged: a checkout off main, or behind for
    hours, means the update is not landing (as happened to the budget app on 2026-11-19)."""
    out = []
    roots = set()
    for g in glob.glob(os.path.join(HOME, 'code', '*', '.git')) + glob.glob(os.path.join(HOME, 'code', '*', '*', '.git')):
        roots.add(os.path.dirname(g))
    if os.path.isdir(os.path.join(REPO_DIR, '.git')):
        roots.add(REPO_DIR)
    now = time.time()
    for repo in sorted(roots):
        r = {'repo': os.path.relpath(repo, HOME) if repo.startswith(HOME) else os.path.basename(repo)}
        rc, br = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
        r['branch'] = br.strip() if rc == 0 else None
        rc, sha = git(repo, 'rev-parse', '--short', 'HEAD')
        r['head'] = sha.strip() if rc == 0 else None
        rc, d = git(repo, 'log', '-1', '--format=%cI')
        r['headCommitDate'] = d.strip() if rc == 0 else None
        rc, head_ref = git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
        default = head_ref.strip().split('/', 1)[-1] if rc == 0 and head_ref.strip() else 'main'
        r['defaultBranch'] = default
        logs_head = os.path.join(repo, '.git', 'logs', 'HEAD')
        fetch_head = os.path.join(repo, '.git', 'FETCH_HEAD')
        r['headMovedAt'] = iso(os.path.getmtime(logs_head)) if os.path.exists(logs_head) else None
        r['lastFetchAt'] = iso(os.path.getmtime(fetch_head)) if os.path.exists(fetch_head) else None
        rc, st = git(repo, 'status', '--porcelain')
        if rc == 0:
            lines = [l for l in st.splitlines() if l.strip()]
            r['changedFiles'] = len([l for l in lines if not l.startswith('??')])
            r['untrackedFiles'] = len([l for l in lines if l.startswith('??')])
        rc, wt = git(repo, 'worktree', 'list', '--porcelain')
        r['worktrees'] = len([l for l in wt.splitlines() if l.startswith('worktree ')]) if rc == 0 else None
        # Ask GitHub what the default branch is at now (read-only; nothing is fetched or changed).
        rc, ls = git(repo, 'ls-remote', 'origin', 'refs/heads/' + default, timeout=30)
        remote_sha = ls.split()[0] if rc == 0 and ls.strip() else None
        r['remoteReachable'] = remote_sha is not None
        if remote_sha:
            rc, full = git(repo, 'rev-parse', 'HEAD')
            full = full.strip() if rc == 0 else ''
            r['upToDate'] = full == remote_sha
            rc, _ = git(repo, 'cat-file', '-e', remote_sha + '^{commit}')
            if rc == 0:
                rc, n = git(repo, 'rev-list', '--count', 'HEAD..' + remote_sha)
                r['behind'] = int(n.strip()) if rc == 0 and n.strip().isdigit() else None
                rc, n = git(repo, 'rev-list', '--count', remote_sha + '..HEAD')
                r['ahead'] = int(n.strip()) if rc == 0 and n.strip().isdigit() else None
            else:
                r['behind'] = 'unknown (the newest commit has not been fetched)'
        out.append(r)
        name = r['repo']
        if r['branch'] and r['branch'] != default:
            flag('bad', 'auto-update', '%s is on branch %s, not %s, so updates to %s never land there' % (name, r['branch'], default, default))
        if r.get('upToDate') is False:
            moved = os.path.getmtime(logs_head) if os.path.exists(logs_head) else 0
            fetched = os.path.getmtime(fetch_head) if os.path.exists(fetch_head) else 0
            # Stuck = behind GitHub while nothing has pulled for a while.
            if now - max(moved, fetched) > LIMITS['repo_stale_hours'] * 3600:
                flag('warn', 'auto-update', '%s is behind GitHub and has not pulled in over %d hours' % (name, LIMITS['repo_stale_hours']))
        if r.get('changedFiles'):
            flag('warn', 'auto-update', '%s has %d changed file(s) on the Pi, which can block a pull' % (name, r['changedFiles']))
        if r.get('worktrees') and r['worktrees'] > 1:
            flag('warn', 'tidy', '%s has %d worktrees (leftover work copies)' % (name, r['worktrees']))
    return out


def ping(host, count):
    rc, txt = run(['ping', '-n', '-q', '-c', str(count), '-i', '0.3', '-W', '2', host], timeout=count + 15)
    if rc is None:
        return {'error': txt}
    m = re.search(r'([\d.]+)% packet loss', txt)
    a = re.search(r'= [\d.]+/([\d.]+)/([\d.]+)', txt)
    return {'lossPct': float(m.group(1)) if m else None, 'avgMs': float(a.group(1)) if a else None, 'maxMs': float(a.group(2)) if a else None}


def default_route():
    """(interface, gateway) from /proc/net/route. The gateway is used, never written."""
    for line in (read('/proc/net/route', '') or '').splitlines()[1:]:
        p = line.split()
        if len(p) > 2 and p[1] == '00000000' and p[2] != '00000000':
            g = bytes.fromhex(p[2])[::-1]
            return p[0], '.'.join(str(b) for b in g)
    return None, None


def check_network():
    out = {'interfaces': []}
    iface, gw = default_route()
    out['defaultInterface'] = iface
    for d in sorted(glob.glob('/sys/class/net/*')):
        n = os.path.basename(d)
        if n == 'lo' or re.match(r'(docker|veth|br-|virbr|tailscale|zt)', n):
            continue
        st = lambda k: int(num(read(os.path.join(d, 'statistics', k), '0'), 0))  # noqa: E731
        out['interfaces'].append({
            'name': n, 'state': (read(os.path.join(d, 'operstate'), '') or '').strip(),
            'carrierChangesSinceBoot': int(num(read(os.path.join(d, 'carrier_changes'), '0'), 0)),
            'rxErrors': st('rx_errors'), 'txErrors': st('tx_errors'), 'rxDropped': st('rx_dropped'), 'txDropped': st('tx_dropped'),
            'wireless': os.path.isdir(os.path.join(d, 'wireless')),
        })
    wl = next((i['name'] for i in out['interfaces'] if i['wireless']), None)
    if wl and have('iw'):
        rc, txt = run(['iw', 'dev', wl, 'link'])
        w = {'interface': wl, 'connected': rc == 0 and 'Not connected' not in txt}
        for key, pat in (('signalDbm', r'signal:\s*(-?\d+)'), ('rxMbps', r'rx bitrate:\s*([\d.]+)'), ('txMbps', r'tx bitrate:\s*([\d.]+)'), ('freqMHz', r'freq:\s*([\d.]+)')):
            m = re.search(pat, txt or '')
            w[key] = float(m.group(1)) if m else None
        rc, txt = run(['iw', 'dev', wl, 'station', 'dump'])
        for key, pat in (('connectedSeconds', r'connected time:\s*(\d+)'), ('txRetries', r'tx retries:\s*(\d+)'), ('txFailed', r'tx failed:\s*(\d+)'), ('beaconLoss', r'beacon loss:\s*(\d+)')):
            m = re.search(pat, txt or '')
            w[key] = int(m.group(1)) if m else None
        out['wifi'] = w
        s = w.get('signalDbm')
        if iface == wl and s is not None:
            if s <= LIMITS['wifi_signal_bad']:
                flag('bad', 'network', 'Wi-Fi signal is weak (%d dBm)' % s)
            elif s <= LIMITS['wifi_signal_warn']:
                flag('warn', 'network', 'Wi-Fi signal is fair (%d dBm)' % s)
    elif wl:
        out['wifi'] = {'interface': wl, 'error': 'iw is not installed'}
    if wl:
        pm = run(['iw', 'dev', wl, 'get', 'power_save']) if have('iw') else (None, '')
        if pm[0] == 0:
            out['wifiPowerSave'] = 'on' in pm[1].lower().split()
    if not QUICK:
        if gw:
            out['pingRouter'] = ping(gw, 20)
            p = out['pingRouter']
            if p.get('lossPct') is not None:
                if p['lossPct'] >= LIMITS['ping_loss_bad']:
                    flag('bad', 'network', '%.0f%% of pings to the router were lost' % p['lossPct'])
                elif p['lossPct'] >= LIMITS['ping_loss_warn']:
                    flag('warn', 'network', '%.0f%% of pings to the router were lost' % p['lossPct'])
                if p.get('avgMs') and p['avgMs'] > LIMITS['ping_ms_warn']:
                    flag('warn', 'network', 'Pings to the router average %.0f ms' % p['avgMs'])
        out['pingInternet'] = ping('1.1.1.1', 10)
    t0 = time.time()
    try:
        socket.getaddrinfo('api.cloudflare.com', 443)
        out['dnsMs'] = round((time.time() - t0) * 1000)
    except Exception:  # noqa: BLE001
        out['dnsMs'] = None
        flag('bad', 'network', 'DNS lookup failed (api.cloudflare.com)')
    t0 = time.time()
    try:
        urllib.request.urlopen(urllib.request.Request('https://api.cloudflare.com/client/v4/', method='HEAD'), timeout=10)
        out['httpsOk'] = True
    except urllib.error.HTTPError:
        out['httpsOk'] = True  # an answer at all means the internet works
    except Exception:  # noqa: BLE001
        out['httpsOk'] = False
        flag('bad', 'network', 'Could not reach the internet over HTTPS')
    out['httpsMs'] = round((time.time() - t0) * 1000)
    rc, txt = run(['journalctl', '--since', '-7d', '--no-pager', '-q', '-u', 'NetworkManager', '-u', 'wpa_supplicant', '-u', 'dhcpcd'], timeout=60)
    if rc == 0:
        out['wifiDisconnectsThisWeek'] = len(re.findall(r'CTRL-EVENT-DISCONNECTED|state change: activated -> (?:deactivating|failed|disconnected)|carrier lost', txt))
        if out['wifiDisconnectsThisWeek'] >= 5:
            flag('warn', 'network', 'Wi-Fi dropped %d time(s) this week' % out['wifiDisconnectsThisWeek'])
    return out


def http_json(url, token=None, method='GET', body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/json')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    try:
        return json.loads(raw.decode('utf-8'))
    except ValueError:
        return raw.decode('utf-8', 'replace')


def check_hub(env, secrets):
    """The hub server on this Pi: version, mailbox, data freshness, log problems, translations."""
    port = env.get('HUB_PORT') or '8097'
    base = 'http://127.0.0.1:%s' % port
    token = env.get('HUB_TOKEN')
    out = {}
    if not token:
        flag('warn', 'hub', 'No HUB_TOKEN in pi/.env, so the hub server was not asked')
        return {'error': 'no token'}
    try:
        st = http_json(base + '/api/status', token)
    except Exception as e:  # noqa: BLE001
        flag('bad', 'hub', 'The hub server did not answer on this Pi (%s)' % type(e).__name__)
        return {'error': 'no answer (%s)' % type(e).__name__}
    mbx = st.get('mailbox') or {}
    sp = st.get('spotify') or {}
    out['server'] = st.get('server')
    out['uptimeHours'] = round((st.get('uptime') or 0) / 3600.0, 1)
    out['screensListening'] = len(st.get('screens') or [])
    out['calendar'] = st.get('calendar')
    out['mailbox'] = {k: mbx.get(k) for k in ('configured', 'connected', 'lastOkAt', 'lastError', 'pendingResults', 'pollSeconds', 'lastCommandAt', 'lastCommandOk')}
    out['spotify'] = {k: sp.get(k) for k in ('configured', 'signedIn', 'state', 'lastOkAt')}
    out['spotify']['problem'] = sp.get('problem') or sp.get('note') or None
    out['shows'] = st.get('shows')
    out['ambience'] = st.get('ambience')
    if mbx.get('configured') and not mbx.get('connected'):
        flag('bad', 'hub', 'The Claude mailbox is not connected to R2 (%s)' % (mbx.get('lastError') or 'no reason given'))
    age = hours_since(mbx.get('lastOkAt')) if mbx.get('lastOkAt') else None
    if age is not None and age > LIMITS['stale_hours']['mailbox']:
        flag('warn', 'hub', 'The mailbox last reached R2 %.1f hours ago' % age)
    # How fresh each kind of data is. Only times: nothing from inside the snapshots is kept.
    fresh = {}
    cal = (st.get('calendar') or {}).get('lastRefresh')
    fresh['calendar'] = hours_since(cal) if cal else None
    shows_at = (st.get('shows') or {}).get('lastRefresh')
    fresh['shows'] = hours_since(shows_at) if shows_at else None
    for kind in ('budget', 'awws'):
        try:
            d = (http_json(base + '/api/' + kind, token) or {}).get('data') or {}
            fresh[kind] = hours_since(d.get('sentAt')) if d.get('sentAt') else None
        except Exception:  # noqa: BLE001
            fresh[kind] = None
    out['dataAgeHours'] = fresh
    for kind, h in fresh.items():
        if h is not None and h > LIMITS['stale_hours'][kind]:
            flag('warn', 'data', 'The %s data on the hub is %.0f hours old' % (kind, h))
    # Problems in the hub's own log (already scrubbed by the server).
    try:
        lg = http_json(base + '/api/log?errors=1&lines=15&scrub=1', token)
        out['logErrors24h'] = lg.get('errors24h')
        out['recentProblems'] = [scrub(str(l.get('t', '')) + ' ' + str(l.get('text', ''))[:200], secrets) for l in (lg.get('lines') or [])][-15:]
        if (lg.get('errors24h') or 0) > LIMITS['log_errors_warn']:
            flag('warn', 'hub', '%d problems in the hub log in the last 24 hours' % lg['errors24h'])
    except Exception as e:  # noqa: BLE001
        out['logErrors24h'] = {'error': type(e).__name__}
    # Translations: the server's view (on/off, last error) and the last 7 days from its usage file.
    tr = {}
    try:
        u = http_json(base + '/api/translate/usage', token)
        tr = {k: u.get(k) for k in ('enabled', 'paused', 'cached', 'cap', 'lastError')}
    except Exception as e:  # noqa: BLE001
        tr = {'error': type(e).__name__}
    cap = tr.get('cap') if isinstance(tr.get('cap'), int) else translate_cap()
    days = translate_days()
    week = []
    for i in range(6, -1, -1):
        k = (datetime.date.today() - datetime.timedelta(days=i)).isoformat()
        d = days.get(k) or {}
        week.append({'day': k, 'lines': d.get('lines', 0), 'calls': d.get('calls', 0), 'tokens': d.get('inTok', 0) + d.get('outTok', 0)})
    tr['cap'] = cap
    tr['week'] = week
    tr['weekLines'] = sum(w['lines'] for w in week)
    tr['peakDayLines'] = max([w['lines'] for w in week] or [0])
    tr['peakShareOfCap'] = round(tr['peakDayLines'] / float(cap), 2) if cap else None
    out['translate'] = tr
    if cap and tr['peakDayLines'] >= cap:
        flag('bad', 'translate', 'Translations hit the daily cap of %d new lines this week' % cap)
    elif cap and tr['peakDayLines'] >= LIMITS['translate_warn'] * cap:
        flag('warn', 'translate', 'The busiest day used %d of the %d new translation lines a day' % (tr['peakDayLines'], cap))
    if tr.get('enabled') is False:
        flag('warn', 'translate', 'Translating is off (no key in pi/.env)')
    if tr.get('paused'):
        flag('warn', 'translate', 'Translating is paused after an error')
    return out


def translate_cap():
    m = re.search(r'MAX_NEW_PER_DAY\s*=\s*(\d+)', read(os.path.join(PI_DIR, 'translate.js'), '') or '')
    return int(m.group(1)) if m else 2000


def translate_days():
    try:
        j = json.loads(read(os.path.join(DATA_DIR, 'translate-usage.json'), '{}') or '{}')
        return j.get('days') or {}
    except ValueError:
        return {}


def week_stats(points, now_ts):
    """[(epoch, value)] oldest first -> time-weighted mean, min, max, last."""
    if not points:
        return None
    vals = [v for _, v in points]
    total = 0.0
    weight = 0.0
    for i, (t, v) in enumerate(points):
        end = points[i + 1][0] if i + 1 < len(points) else now_ts
        w = max(0.0, end - t)
        total += v * w
        weight += w
    return {'min': round(min(vals), 1), 'max': round(max(vals), 1),
            'mean': round(total / weight, 1) if weight else round(sum(vals) / len(vals), 1),
            'samples': len(points)}


def ha_parse_time(s):
    try:
        return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:  # noqa: BLE001
        return None


def check_home_assistant(env, secrets):
    """Pi and Home Assistant sensors that Home Assistant already tracks, with a week of history.
    Entities are named by their friendly name, never by entity id."""
    url = (env.get('HA_URL') or '').rstrip('/')
    token = env.get('HA_TOKEN')
    if not url or not token:
        return {'configured': False}
    out = {'configured': True}
    try:
        cfg = http_json(url + '/api/config', token)
        out['version'] = cfg.get('version')
        out['state'] = cfg.get('state')
        out['safeMode'] = cfg.get('safe_mode')
    except Exception as e:  # noqa: BLE001
        flag('warn', 'home assistant', 'Home Assistant did not answer (%s)' % type(e).__name__)
        out['error'] = 'no answer (%s)' % type(e).__name__
        return out
    tpl = ('{% set ns = namespace(out=[]) %}{% for d in ' + json.dumps(HA_INTEGRATIONS) + ' %}'
           '{% for e in integration_entities(d) %}{% set ns.out = ns.out + [[d, e]] %}{% endfor %}{% endfor %}'
           '{{ ns.out | tojson }}')
    try:
        pairs = http_json(url + '/api/template', token, 'POST', {'template': tpl})
        if isinstance(pairs, str):
            pairs = json.loads(pairs)
    except Exception as e:  # noqa: BLE001
        pairs = []
        out['templateError'] = type(e).__name__
    states = http_json(url + '/api/states', token, timeout=30)
    by_id = {s.get('entity_id'): s for s in states if isinstance(s, dict)}
    integ = {e: d for d, e in pairs if e in by_id}
    # Counts over everything, for the lights and sounds to come: unavailable per domain.
    domains = {}
    for eid, s in by_id.items():
        dom = eid.split('.', 1)[0]
        if dom in ('light', 'switch', 'media_player', 'sensor', 'binary_sensor', 'fan', 'climate', 'remote'):
            c = domains.setdefault(dom, {'total': 0, 'unavailable': 0})
            c['total'] += 1
            if s.get('state') in ('unavailable', 'unknown'):
                c['unavailable'] += 1
    out['domains'] = domains
    upd = [s for e, s in by_id.items() if e.startswith('update.') and s.get('state') == 'on']
    out['updatesWaiting'] = sorted(set(scrub(str((s.get('attributes') or {}).get('friendly_name') or 'an update'), secrets) for s in upd))[:20]
    # A week of history for the Pi's own sensors.
    hist = {}
    ids = sorted(integ)
    if ids and not QUICK:
        start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
        try:
            q = '?filter_entity_id=' + ','.join(ids) + '&minimal_response&no_attributes'
            h = http_json(url + '/api/history/period/' + urllib.parse.quote(start) + q, token, timeout=60)
            for series in h or []:
                if series and isinstance(series, list):
                    eid = series[0].get('entity_id')
                    hist[eid] = series
        except Exception as e:  # noqa: BLE001
            out['historyError'] = type(e).__name__
    now_ts = time.time()
    sensors = []
    for eid in ids:
        s = by_id[eid]
        a = s.get('attributes') or {}
        name = scrub(str(a.get('friendly_name') or eid.split('.', 1)[-1].replace('_', ' ')), secrets)
        item = {'name': name, 'integration': integ[eid], 'kind': eid.split('.', 1)[0], 'deviceClass': a.get('device_class'),
                'unit': a.get('unit_of_measurement'), 'now': s.get('state')}
        series = hist.get(eid) or []
        nums = []
        on_count = 0
        prev_state = None
        for p in series:
            t = ha_parse_time(p.get('last_changed') or p.get('last_updated') or '')
            v = num(p.get('state'))
            if t is not None and v is not None:
                nums.append((t, v))
            if p.get('state') == 'on' and prev_state != 'on':
                on_count += 1
            prev_state = p.get('state')
        if nums:
            item['week'] = week_stats(nums, now_ts)
        elif series and item['kind'] == 'binary_sensor':
            item['week'] = {'turnedOn': on_count, 'samples': len(series)}
        sensors.append(item)
        # Judge what can be judged by kind.
        low = (name + ' ' + str(item['deviceClass'])).lower()
        wk = item.get('week') or {}
        if item['deviceClass'] == 'temperature' and wk.get('max') is not None:
            if wk['max'] >= LIMITS['cpu_temp_bad']:
                flag('bad', 'cpu', '%s reached %.1f this week (Home Assistant)' % (name, wk['max']))
            elif wk['max'] >= LIMITS['cpu_temp_warn'] + 5:
                flag('warn', 'cpu', '%s reached %.1f this week (Home Assistant)' % (name, wk['max']))
        if item['unit'] == '%' and wk.get('max') is not None and re.search(r'disk|memory|swap', low) and re.search(r'use|usage', low):
            if wk['max'] >= LIMITS['disk_bad']:
                flag('warn', 'home assistant', '%s reached %.0f%% this week' % (name, wk['max']))
        if item['kind'] == 'binary_sensor' and item['deviceClass'] == 'problem' and (s.get('state') == 'on' or wk.get('turnedOn')):
            flag('warn', 'power', '%s was on this week (%s time(s))' % (name, wk.get('turnedOn', 1)))
    out['piSensors'] = sensors
    if not sensors:
        out['note'] = 'Home Assistant has no System Monitor or Raspberry Pi power entities; adding the System Monitor integration gives a week of CPU temperature, memory and disk history here.'
    return out


def run_extras(secrets):
    """Every executable in checks.d/ prints one JSON object. See checks.d/README.md."""
    out = {}
    for p in sorted(glob.glob(os.path.join(CHECKS_DIR, '*'))):
        name = os.path.basename(p)
        if name.startswith('.') or name.endswith(('.md', '.example', '.disabled', '~')) or not os.access(p, os.X_OK) or os.path.isdir(p):
            continue
        rc, txt = run([p] + (['--quick'] if QUICK else []), timeout=90)
        key = re.sub(r'\.\w+$', '', name)
        try:
            j = json.loads(txt) if rc is not None else None
        except ValueError:
            j = None
        if not isinstance(j, dict):
            out[key] = {'error': 'did not print one JSON object (exit %s)' % rc}
            flag('warn', 'audit', 'Extra check %s did not print a JSON object' % key)
            continue
        out[key] = j
        for f in j.get('flags') or []:
            if isinstance(f, dict) and f.get('level') in ('bad', 'warn'):
                flag(f['level'], str(f.get('area') or key)[:30], scrub(str(f.get('text') or '')[:200], secrets))
    return out


# ---------- the report ----------

def load_previous():
    try:
        with open(os.path.join(OUT_DIR, 'latest.json')) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def text_summary(rep):
    s = rep['summary']
    lines = ['Pi health %s: %s (%d bad, %d warn)' % (rep['generated'][:16].replace('T', ' '), s['overall'].upper(), s['bad'], s['warn'])]
    for f in rep['flags']:
        lines.append('  [%s] %s: %s' % (f['level'], f['area'], f['text']))
    if not rep['flags']:
        lines.append('  Nothing out of the ordinary.')
    return '\n'.join(lines) + '\n'


def build():
    t0 = time.time()
    env = parse_env(ENV_FILE)
    secrets = secret_values(env)
    prev = load_previous()
    rep = {
        'kind': 'pi-health', 'v': 1, 'script': SCRIPT_VERSION,
        'generated': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
        'quick': QUICK,
        'previous': prev.get('generated') if prev else None,
        'limits': LIMITS,
    }
    rep['system'] = section('system', check_system)
    rep['cpu'] = section('cpu', check_cpu)
    rep['memory'] = section('memory', check_memory)
    rep['disk'] = section('disk', check_disk)
    rep['storage'] = section('storage', check_storage)
    rep['kernel'] = section('kernel', check_kernel, secrets)
    rep['reboots'] = section('reboots', check_reboots, prev)
    rep['docker'] = section('docker', check_docker, prev)
    rep['systemd'] = section('systemd', check_systemd)
    rep['cron'] = section('cron', check_cron, secrets)
    rep['repos'] = section('repos', lambda: {'checkouts': check_repos()})
    rep['network'] = section('network', check_network)
    rep['hub'] = section('hub', check_hub, env, secrets)
    rep['homeAssistant'] = section('homeAssistant', check_home_assistant, env, secrets)
    rep['extras'] = section('extras', run_extras, secrets)
    order = {'bad': 0, 'warn': 1}
    flags.sort(key=lambda f: order.get(f['level'], 2))
    rep['flags'] = flags
    bad = len([f for f in flags if f['level'] == 'bad'])
    warn = len([f for f in flags if f['level'] == 'warn'])
    rep['summary'] = {'overall': 'bad' if bad else 'warn' if warn else 'ok', 'bad': bad, 'warn': warn}
    rep['scriptErrors'] = script_errors
    rep['seconds'] = round(time.time() - t0, 1)
    text = scrub(json.dumps(rep, indent=1, sort_keys=False, default=str), secrets)
    json.loads(text)  # still valid after scrubbing
    return text, json.loads(text)


def write_atomic(path, text):
    tmp = path + '.tmp-%d' % os.getpid()
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    text, rep = build()
    if PRINT_ONLY:
        sys.stdout.write(text + '\n')
        return 0
    os.makedirs(OUT_DIR, exist_ok=True)
    day = rep['generated'][:10]
    write_atomic(os.path.join(OUT_DIR, day + '.json'), text + '\n')
    write_atomic(os.path.join(OUT_DIR, 'latest.txt'), text_summary(rep))
    write_atomic(os.path.join(OUT_DIR, 'latest.json'), text + '\n')  # last: the hub uploads when this one changes
    dated = sorted(p for p in glob.glob(os.path.join(OUT_DIR, '????-??-??.json')))
    for p in dated[:-KEEP_REPORTS]:
        os.remove(p)
    sys.stdout.write(text_summary(rep))
    return 0


if __name__ == '__main__':
    sys.exit(main())
