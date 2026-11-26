#!/usr/bin/env python3
"""
Sound lights: the Govee lamp (and the plant wall, if set) follow the sound
the Pi itself plays.

Runs on the Pi (not in Docker) as a systemd user service (soundlights.service
in this folder). It listens to the default output's monitor through PipeWire
(pw-record), so it hears music, ambience and storm sounds that go to the
Bluetooth speaker. It cannot hear the TV or the Xbox: they do not play
through the Pi.

    brightness   follows how loud it is now (fast up, slower down)
    color        drifts slowly; warm (amber, red) when bass dominates,
                 cool (teal, blue, violet) when highs dominate
    thunder      a sudden loud jump gives a bright white flash

When sound starts, each light's state is saved. About 8 seconds after the
sound stops (and on SIGTERM or SIGINT) the saved state is put back exactly.

Settings come from pi/.env (the file next to this script's folder):
    SOUNDLIGHTS=off          turns it off (default on)
    GOVEE_LAMP_IP            the lamp's address (LAN Control must be on in
                             Govee Home). With Home Assistant (below) it is
                             required; without, if empty the lamp is found by
                             itself (that needs UDP port 4002 to be free)
    HA_TOKEN, HA_URL         Home Assistant (URL default http://127.0.0.1:8123)
    SOUNDLIGHTS_HA_LAMP      the lamp's light entity id in Home Assistant. With
                             HA_TOKEN set, the lamp's state is saved and put
                             back through Home Assistant, and the color frames
                             go straight to the lamp (we never bind port 4002)
    WLED_URL                 the plant wall's WLED controller (optional)
    SOUNDLIGHTS_DELAY_MS     0-1000, default 150: lights wait this long, to
                             match the Bluetooth speaker's own delay
    SOUNDLIGHTS_MAX_FPS      2-20, default 10: most light updates a second

Command line:
    python3 soundlights.py               run (what the service does)
    python3 soundlights.py --dry-run     no lights; one summary line a second
    python3 soundlights.py --test-lamp   2 second color sweep and one white
                                         flash, then put back
    python3 soundlights.py --once-status say what answers, then exit

Standard library only. Logs a few plain lines (never one per frame, never an
address or a device id).
"""
import argparse
import array
import errno
import heapq
import json
import math
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENV = os.path.join(HERE, ".env")

RATE = 16000
BLOCK_SAMPLES = 400            # 25 ms at 16 kHz
BLOCK_S = BLOCK_SAMPLES / RATE

# The capture command. Tests replace this. The monitor of the default output.
CAPTURE_CMD = ["pw-record", "-P", "{ stream.capture.sink=true }",
               "--rate", str(RATE), "--channels", "1", "--format", "s16", "-"]
CAPTURE_RETRY_S = 30

GOVEE_MULTICAST = ("239.255.255.250", 4001)
GOVEE_REPLY_PORT = 4002
GOVEE_CONTROL_PORT = 4003
REDISCOVER_S = 300

# Analysis
GATE_RMS = 0.006               # below this (0..1 of full scale) it is silence
PEAK_FLOOR = 0.03              # the running peak never falls under this
PEAK_DECAY_S = 10.0
BASS_HZ = 150.0
FLASH_JUMP = 2.5               # block level must be this times the short average
FLASH_ABS = 0.06               # and at least this loud
FLASH_REFRACTORY_S = 0.4
FLASH_HOLD_S = 0.15
FLASH_FADE_S = 0.25
AVG_TAU_S = 0.4

# Sessions
START_AFTER_S = 0.3
GAP_OK_S = 0.1
QUIET_AFTER_S = 8.0
BEGIN_RETRY_S = 30

# Sending
MIN_COLOR_STEP = 8             # 0..255 change that is worth a packet
GOVEE_BRIGHT_EVERY_S = 10


# ---------------------------------------------------------------- settings

def parse_env(text):
    """KEY=value lines; # comments, 'export ', quotes allowed."""
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if val[:1] in ("'", '"'):
            q = val[0]
            end = val.find(q, 1)
            val = val[1:end] if end > 0 else val[1:]
        else:
            h = val.find(" #")
            if h >= 0:
                val = val[:h].strip()
        if key:
            out[key] = val
    return out


def _clamp_int(text, default, lo, hi):
    try:
        n = int(str(text).strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


class Config:
    def __init__(self, env):
        self.enabled = env.get("SOUNDLIGHTS", "on").strip().lower() not in (
            "off", "0", "false", "no")
        self.lamp_ip = env.get("GOVEE_LAMP_IP", "").strip()
        self.ha_token = env.get("HA_TOKEN", "").strip()
        self.ha_url = (env.get("HA_URL", "").strip() or "http://127.0.0.1:8123").rstrip("/")
        self.ha_lamp = env.get("SOUNDLIGHTS_HA_LAMP", "").strip()
        url = env.get("WLED_URL", "").strip().rstrip("/")
        if url and "://" not in url:
            url = "http://" + url
        self.wled_url = url
        self.delay_ms = _clamp_int(env.get("SOUNDLIGHTS_DELAY_MS"), 150, 0, 1000)
        self.max_fps = _clamp_int(env.get("SOUNDLIGHTS_MAX_FPS"), 10, 2, 20)


def load_config(path=DEFAULT_ENV):
    try:
        with open(path, encoding="utf-8") as f:
            return Config(parse_env(f.read()))
    except OSError:
        return Config({})


# ----------------------------------------------------------- Govee messages

def msg(cmd, data):
    return json.dumps({"msg": {"cmd": cmd, "data": data}}).encode()


def msg_scan():
    return msg("scan", {"account_topic": "reserve"})


def msg_turn(on):
    return msg("turn", {"value": 1 if on else 0})


def msg_brightness(v):
    return msg("brightness", {"value": max(1, min(100, int(round(v))))})


def msg_color(r, g, b, kelvin=0):
    return msg("colorwc", {"color": {"r": int(r), "g": int(g), "b": int(b)},
                           "colorTemInKelvin": int(kelvin)})


def msg_status():
    return msg("devStatus", {})


def parse_reply(raw):
    """Return (cmd, data) of a Govee reply, or None."""
    try:
        m = json.loads(raw.decode("utf-8", "replace"))["msg"]
        cmd, data = m["cmd"], m["data"]
        if isinstance(cmd, str) and isinstance(data, dict):
            return cmd, data
    except (ValueError, KeyError, TypeError, AttributeError):
        pass
    return None


def parse_scan_reply(raw):
    """A scan reply as {'ip','sku'}, or None."""
    r = parse_reply(raw)
    if not r or r[0] != "scan" or not r[1].get("ip"):
        return None
    return {"ip": str(r[1]["ip"]), "sku": str(r[1].get("sku", ""))}


def pick_device(devices):
    """Prefer the H6076 floor lamp, else the first one found."""
    for d in devices:
        if d["sku"].upper() == "H6076":
            return d
    return devices[0] if devices else None


def make_govee_socket():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.bind(("", GOVEE_REPLY_PORT))
    return s


def make_direct_socket():
    """Unbound (ephemeral port) socket: frames only, for Home Assistant mode."""
    return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


# ---------------------------------------------------------------- analysis

class Frame:
    """What one 25 ms block looked like."""
    __slots__ = ("rms", "level", "bass", "bass_share", "gate", "flash")

    def __init__(self, rms, level, bass, bass_share, gate, flash):
        self.rms, self.level, self.bass = rms, level, bass
        self.bass_share, self.gate, self.flash = bass_share, gate, flash


class Analyzer:
    """Block by block: level, bass, adaptive peak, noise gate, thunder."""

    def __init__(self, rate=RATE):
        self.alpha = 1.0 - math.exp(-2.0 * math.pi * BASS_HZ / rate)
        self.lp = 0.0
        self.peak = PEAK_FLOOR
        self.avg = 0.0
        self.last_flash = -1e9

    def process(self, samples, t, dt=BLOCK_S):
        n = len(samples) or 1
        a, y = self.alpha, self.lp
        sq = bsq = 0.0
        for x in samples:
            sq += x * x
            y += a * (x - y)
            bsq += y * y
        self.lp = y
        rms = math.sqrt(sq / n) / 32768.0
        bass_rms = math.sqrt(bsq / n) / 32768.0
        # Adaptive peak: rises at once, decays over ~10 s, never under the floor.
        self.peak = max(rms, self.peak * math.exp(-dt / PEAK_DECAY_S), PEAK_FLOOR)
        gate = rms >= GATE_RMS
        level = min(1.0, rms / self.peak) if gate else 0.0
        bass = min(1.0, bass_rms / self.peak) if gate else 0.0
        share = min(1.0, bass_rms / rms) if gate else 0.0
        flash = (gate and rms > FLASH_ABS and rms > self.avg * FLASH_JUMP
                 and t - self.last_flash >= FLASH_REFRACTORY_S)
        if flash:
            self.last_flash = t
        self.avg += (rms - self.avg) * (1.0 - math.exp(-dt / AVG_TAU_S))
        return Frame(rms, level, bass, share, gate, flash)


def hsv_rgb(h, s, v):
    h = h % 1.0
    i = int(h * 6)
    f = h * 6 - i
    p, q, tt = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    r, g, b = [(v, tt, p), (q, v, p), (p, v, tt), (p, q, v), (tt, p, v), (v, p, q)][i % 6]
    return int(round(r * 255)), int(round(g * 255)), int(round(b * 255))


class Out:
    """One light frame: full-brightness color, brightness 0..1, flash 0..1."""
    __slots__ = ("rgb", "bri", "flash")

    def __init__(self, rgb, bri, flash):
        self.rgb, self.bri, self.flash = rgb, bri, flash

    def scaled(self):
        return tuple(int(round(c * self.bri)) for c in self.rgb)


class Look:
    """Turns frames into colors: smooth brightness, drifting hue, white flash."""
    MIN_BRI = 0.03

    def __init__(self):
        self.cur = 0.0
        self.share = 0.4
        self.t = None
        self.flash_at = None

    def update(self, fr, t):
        dt = 0.0 if self.t is None else max(0.0, t - self.t)
        self.t = t
        tau = 0.04 if fr.level > self.cur else 0.35
        self.cur += (fr.level - self.cur) * (1.0 - math.exp(-dt / tau)) if dt else 0.0
        if fr.gate:
            self.share += (fr.bass_share - self.share) * (1.0 - math.exp(-dt / 1.5))
        if fr.flash:
            self.flash_at = t
        dom = max(0.0, min(1.0, (self.share - 0.25) / 0.5))   # 1 = bass heavy
        hue = 0.04 + (1.0 - dom) * 0.64 + 0.05 * math.sin(t * 0.1)
        rgb = hsv_rgb(hue, 0.9, 1.0)
        bri = self.MIN_BRI + (1.0 - self.MIN_BRI) * (self.cur ** 0.8)
        f = 0.0
        if self.flash_at is not None:
            age = t - self.flash_at
            if age < FLASH_HOLD_S:
                f = 1.0
            elif age < FLASH_HOLD_S + FLASH_FADE_S:
                f = 1.0 - (age - FLASH_HOLD_S) / FLASH_FADE_S
        if f > 0:
            rgb = tuple(int(round(c + (255 - c) * f)) for c in rgb)
            bri = max(bri, f)
        return Out(rgb, min(1.0, bri), f)


class Throttle:
    """Send only a meaningful change, never above max_fps."""

    def __init__(self, max_fps):
        self.min_gap = 1.0 / max_fps
        self.last_t = -1e9
        self.last = None

    def reset(self):
        self.last_t, self.last = -1e9, None

    def should_send(self, out, t):
        if t - self.last_t < self.min_gap - 1e-9:
            return False
        cur = out.scaled()
        if self.last is not None and max(abs(a - b) for a, b in zip(cur, self.last)) < MIN_COLOR_STEP:
            return False
        self.last_t, self.last = t, cur
        return True


class DelayQueue:
    """Frames wait here, then come out in the order they are due."""

    def __init__(self):
        self.h = []
        self.n = 0

    def push(self, due, item):
        self.n += 1
        heapq.heappush(self.h, (due, self.n, item))

    def pop_due(self, now):
        out = []
        while self.h and self.h[0][0] <= now:
            out.append(heapq.heappop(self.h)[2])
        return out

    def clear(self):
        self.h = []

    def __len__(self):
        return len(self.h)


# ------------------------------------------------------------------- lights

class Lamp:
    """The Govee lamp over its LAN API (UDP)."""

    def __init__(self, sock, ip="", clock=time.monotonic, log=print, wait=1.0,
                 ha=None, threaded=True):
        self.sock = sock
        self.ha = ha
        self.threaded = threaded
        self.restorer = None
        self.ip = ip
        self.pinned = bool(ip)
        self.clock = clock
        self.log = log
        self.wait = wait
        self.last_discovery = None
        self.snapshot = None
        self.problem = False
        self.announced = False
        self.last_bright = -1e9
        self.active = False

    def _send(self, data):
        try:
            self.sock.sendto(data, (self.ip, GOVEE_CONTROL_PORT))
        except OSError:
            pass

    def discover(self):
        """Scan once; remember the best lamp. Never more than every 5 minutes."""
        now = self.clock()
        if self.last_discovery is not None and now - self.last_discovery < REDISCOVER_S:
            return False
        self.last_discovery = now
        found = []
        try:
            self.sock.settimeout(self.wait)
            self.sock.sendto(msg_scan(), GOVEE_MULTICAST)
            while True:
                try:
                    raw, _ = self.sock.recvfrom(2048)
                except socket.timeout:
                    break
                d = parse_scan_reply(raw)
                if d:
                    found.append(d)
                self.sock.settimeout(0.4)
        except OSError:
            pass
        d = pick_device(found)
        if d:
            self.ip = d["ip"]
            return True
        return False

    def status(self):
        """devStatus data, or None if the lamp did not answer."""
        if not self.ip:
            return None
        self._send(msg_status())
        try:
            self.sock.settimeout(self.wait)
            for _ in range(8):
                raw, _ = self.sock.recvfrom(2048)
                r = parse_reply(raw)
                if r and r[0] == "devStatus":
                    return r[1]
        except (socket.timeout, OSError):
            pass
        return None

    def _fail(self):
        if not self.problem:
            self.log("Lamp did not answer (LAN Control on?).")
            self.problem = True
        if not self.pinned:
            self.ip = ""          # look again later (at most every 5 minutes)
        return False

    def begin(self):
        if self.ha:
            if not self.ip:
                return False
            st = self.ha.snapshot()
        else:
            if not self.ip and not self.discover():
                return self._fail()
            st = self.status()
        if st is None:
            return self._fail()
        if self.problem:
            self.log("Lamp answers again.")
        elif not self.announced:
            self.log("Lamp found.")
        self.problem, self.announced = False, True
        self.snapshot = st
        self.active = True
        self._send(msg_turn(True))
        self._send(msg_brightness(100))
        self.last_bright = self.clock()
        return True

    def frame(self, out):
        if not self.active:
            return
        r, g, b = out.scaled()
        self._send(msg_color(r, g, b))
        if self.clock() - self.last_bright >= GOVEE_BRIGHT_EVERY_S:
            self._send(msg_brightness(100))
            self.last_bright = self.clock()

    def end(self):
        self.active = False
        st, self.snapshot = self.snapshot, None
        if not st:
            return
        if self.ha:
            if self.threaded:       # off the audio thread; not a daemon, so exit waits
                t = threading.Thread(target=self.ha.restore, args=(st,))
                self.restorer = t
                t.start()
            else:
                self.ha.restore(st)
            return
        if not st.get("onOff"):
            self._send(msg_turn(False))
            return
        c = st.get("color") or {}
        kelvin = int(st.get("colorTemInKelvin") or 0)
        if kelvin > 0:
            self._send(msg_color(0, 0, 0, kelvin))
        else:
            self._send(msg_color(c.get("r", 255), c.get("g", 255), c.get("b", 255)))
        self._send(msg_brightness(st.get("brightness", 100)))
        self._send(msg_turn(True))


def default_http(method, url, body=None, timeout=1.5, headers=None):
    data = None if body is None else json.dumps(body).encode()
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "null")


class HaLamp:
    """Saves and restores the lamp's state through Home Assistant's REST API."""

    def __init__(self, url, token, entity, http=default_http):
        self.url = url
        self.entity = entity
        if http is default_http:
            auth = {"Authorization": "Bearer " + token}
            http = lambda m, u, body=None, timeout=1.5: default_http(m, u, body, timeout, auth)
        self.http = http

    def _call(self, method, path, body=None, timeout=1.5):
        return self.http(method, self.url + path, body, timeout)

    def snapshot(self):
        """The saved state, or None if Home Assistant did not answer for the entity."""
        try:
            st = self._call("GET", "/api/states/" + self.entity)
            a = st.get("attributes") or {}
            return {"onOff": st.get("state") == "on",
                    "brightness": a.get("brightness"),
                    "color_mode": a.get("color_mode"),
                    "rgb_color": a.get("rgb_color"),
                    "color_temp_kelvin": a.get("color_temp_kelvin")}
        except Exception:
            return None

    def restore(self, st):
        body = {"entity_id": self.entity}
        if not st.get("onOff"):
            svc = "turn_off"
        else:
            svc = "turn_on"
            if st.get("brightness") is not None:
                body["brightness"] = int(st["brightness"])
            if st.get("color_mode") == "color_temp" and st.get("color_temp_kelvin"):
                body["color_temp_kelvin"] = int(st["color_temp_kelvin"])
            elif st.get("rgb_color"):
                body["rgb_color"] = [int(v) for v in st["rgb_color"]][:3]
            elif st.get("color_temp_kelvin"):
                body["color_temp_kelvin"] = int(st["color_temp_kelvin"])
        try:
            self._call("POST", "/api/services/light/" + svc, body, 3.0)
            return True
        except Exception:
            return False


class Wled:
    """The plant wall's WLED controller over HTTP, off the audio thread."""

    def __init__(self, url, http=default_http, log=print, threaded=True):
        self.url = url
        self.http = http
        self.log = log
        self.threaded = threaded
        self.snapshot = None
        self.problem = False
        self.announced = False
        self.active = False
        self.busy = False
        self.lock = threading.Lock()

    def _post(self, body, timeout=1.5):
        try:
            self.http("POST", self.url + "/json/state", body, timeout)
            return True
        except Exception:
            return False

    def begin(self):
        try:
            st = self.http("GET", self.url + "/json/state", None, 1.5)
            seg = (st.get("seg") or [{}])[0]
            snap = {"on": bool(st.get("on")), "bri": st.get("bri", 128),
                    "seg": {k: seg[k] for k in ("col", "fx", "pal", "sx", "ix") if k in seg}}
        except Exception:
            if not self.problem:
                self.log("Plant wall did not answer.")
                self.problem = True
            return False
        if self.problem:
            self.log("Plant wall answers again.")
        elif not self.announced:
            self.log("Plant wall found.")
        self.problem, self.announced = False, True
        self.snapshot = snap
        self.active = True
        self._post({"on": True, "tt": 0, "seg": [{"id": 0, "fx": 0}]})
        return True

    def _do(self, body):
        with self.lock:
            if self.active:
                self._post(body)
            self.busy = False

    def frame(self, out):
        if not self.active or self.busy:
            return                      # previous request still in flight: drop
        r, g, b = out.rgb
        body = {"on": True, "bri": max(1, int(round(out.bri * 255))), "tt": 0,
                "seg": [{"col": [[r, g, b]]}]}
        self.busy = True
        if self.threaded:
            threading.Thread(target=self._do, args=(body,), daemon=True).start()
        else:
            self._do(body)

    def end(self):
        with self.lock:                 # waits for a request in flight
            self.active = False
            snap, self.snapshot = self.snapshot, None
            if not snap:
                return
            seg = dict(snap["seg"])
            seg["id"] = 0
            self._post({"on": snap["on"], "bri": snap["bri"], "tt": 0, "seg": [seg]}, 2.0)


# ------------------------------------------------------------------- engine

class Engine:
    """Audio blocks in, light frames out, with sessions and the delay."""

    def __init__(self, lights, delay_ms=150, max_fps=10, log=print):
        self.lights = list(lights)
        self.delay = delay_ms / 1000.0
        self.log = log
        self.an = Analyzer()
        self.look = Look()
        self.throttle = Throttle(max_fps)
        self.queue = DelayQueue()
        self.live = []
        self.active = False
        self.run_start = None
        self.last_loud = None
        self.next_begin = 0.0
        self.buf = b""
        self.t = 0.0
        self.flashes = 0
        self.last = Frame(0, 0, 0, 0, False, False)

    def feed(self, data, now):
        """Raw s16 little-endian mono PCM, as read at time `now`."""
        self.buf += data
        nb = BLOCK_SAMPLES * 2
        n = len(self.buf) // nb
        for i in range(n):
            chunk, self.buf = self.buf[:nb], self.buf[nb:]
            s = array.array("h")
            s.frombytes(chunk)
            if sys.byteorder == "big":
                s.byteswap()
            self.block(s, max(self.t, now - (n - 1 - i) * BLOCK_S))
        if n == 0:
            self.tick(now)

    def block(self, samples, t):
        self.t = t
        fr = self.an.process(samples, t)
        self.last = fr
        if fr.flash:
            self.flashes += 1
        if fr.gate:
            self.last_loud = t
            if self.run_start is None:
                self.run_start = t
        elif self.last_loud is None or t - self.last_loud > GAP_OK_S:
            self.run_start = None
        if (not self.active and fr.gate and self.run_start is not None
                and t - self.run_start >= START_AFTER_S and t >= self.next_begin):
            self._begin(t)
        if self.active:
            out = self.look.update(fr, t)
            if self.throttle.should_send(out, t):
                self.queue.push(t + self.delay, out)
        self.tick(t)

    def tick(self, now):
        """Call at least every 100 ms: sends due frames, ends quiet sessions."""
        self.t = max(self.t, now)
        if self.active:
            if self.last_loud is not None and now - self.last_loud >= QUIET_AFTER_S:
                self._end()
                return
            for out in self.queue.pop_due(now):
                for light in self.live:
                    light.frame(out)

    def _begin(self, t):
        self.live = [l for l in self.lights if l.begin()]
        if not self.live:
            self.next_begin = t + (BEGIN_RETRY_S if self.lights else 0)
            return
        self.active = True
        self.look = Look()
        self.throttle.reset()
        self.queue.clear()
        self.log("Following the sound.")

    def _end(self):
        self.queue.clear()
        for l in self.live:
            l.end()
        self.live = []
        self.active = False
        self.run_start = None
        self.log("Quiet, lights put back.")

    def stop(self):
        if self.active:
            self._end()


# ------------------------------------------------------------------ capture

class WavSkip:
    """pw-record may write a RIFF/WAV header first when it writes to a pipe.
    Skip it if the stream starts with b'RIFF'; otherwise pass bytes through."""

    def __init__(self):
        self.buf = b""
        self.done = False

    def push(self, data):
        if self.done:
            return data
        self.buf += data
        if len(self.buf) < 4:
            return b""
        if self.buf[:4] != b"RIFF":
            self.done = True
            out, self.buf = self.buf, b""
            return out
        i = 12                                    # past RIFF, size, WAVE
        while i + 8 <= len(self.buf):
            cid = self.buf[i:i + 4]
            size = int.from_bytes(self.buf[i + 4:i + 8], "little")
            if cid == b"data":
                self.done = True
                out, self.buf = self.buf[i + 8:], b""
                return out
            i += 8 + size + (size & 1)
        if len(self.buf) > 65536:                 # not a header we understand
            self.done = True
            out, self.buf = self.buf[44:], b""
            return out
        return b""


def run_capture(engine, stop, clock=time.monotonic, each=None):
    """Read PCM from the capture command until it ends or `stop` is set.
    Returns 'stopped', 'missing' or 'exited'."""
    try:
        proc = subprocess.Popen(CAPTURE_CMD, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
    except OSError:
        return "missing"
    fd = proc.stdout.fileno()
    reason = "exited"
    skip = WavSkip()
    try:
        while not stop.is_set():
            ready, _, _ = select.select([fd], [], [], 0.1)
            now = clock()
            if ready:
                data = os.read(fd, 4096)
                if not data:
                    break
                data = skip.push(data)
                if data:
                    engine.feed(data, now)
            else:
                engine.tick(now)
            if each:
                each(now)
        else:
            reason = "stopped"
    finally:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass
        try:
            proc.stdout.close()
        except Exception:
            pass
    return reason


class Reporter:
    """--dry-run: one plain line a second."""

    def __init__(self, engine, out=print):
        self.e, self.out, self.next = engine, out, None
        self.lv = self.bs = 0.0
        self.n = 0
        self.seen = 0

    def __call__(self, now):
        if self.next is None:
            self.next = now + 1.0
        f = self.e.last
        if self.e.t >= now - 0.2:
            self.lv, self.bs, self.n = max(self.lv, f.level), max(self.bs, f.bass), self.n + 1
        if now >= self.next:
            self.out("level %.2f bass %.2f flashes %d" % (self.lv, self.bs, self.e.flashes - self.seen))
            self.seen = self.e.flashes
            self.lv = self.bs = 0.0
            self.next = now + 1.0


# --------------------------------------------------------------------- main

def ha_mode(cfg):
    return bool(cfg.ha_token and cfg.ha_lamp)


def make_lamp(cfg, log, sock_factory=make_govee_socket, direct_factory=make_direct_socket,
              http=default_http):
    """The lamp for this config, or None (with at most one log line)."""
    if ha_mode(cfg):
        if not cfg.lamp_ip:
            log("Home Assistant mode needs GOVEE_LAMP_IP (the lamp's address); no lamp.")
            return None
        ha = HaLamp(cfg.ha_url, cfg.ha_token, cfg.ha_lamp, http)
        return Lamp(direct_factory(), cfg.lamp_ip, log=log, ha=ha)
    try:
        return Lamp(sock_factory(), cfg.lamp_ip, log=log)
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            log("Port 4002 is busy (Home Assistant's Govee integration?): "
                "set GOVEE_LAMP_IP and SOUNDLIGHTS_HA_LAMP.")
        else:
            log("Lamp port is not available; the lamp is skipped.")
        return None


def build_lights(cfg, log, sock_factory=make_govee_socket, direct_factory=make_direct_socket,
                 http=default_http):
    lights = []
    lamp = make_lamp(cfg, log, sock_factory, direct_factory, http)
    if lamp:
        lights.append(lamp)
    if cfg.wled_url:
        lights.append(Wled(cfg.wled_url, log=log))
    return lights


def sleep_stop(stop, seconds):
    stop.wait(seconds)


def run(cfg, dry_run, log=print, stop=None):
    stop = stop or threading.Event()
    lights = [] if dry_run else build_lights(cfg, log)
    engine = Engine(lights, cfg.delay_ms, cfg.max_fps, log)
    each = Reporter(engine) if dry_run else None

    def on_signal(signum, frame):
        stop.set()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    complained = False
    try:
        while not stop.is_set():
            if not dry_run and not lights:
                if not complained:
                    log("No lights set up; waiting quietly.")
                    complained = True
                sleep_stop(stop, 300)
                continue
            why = run_capture(engine, stop, each=each)
            if stop.is_set():
                break
            if not complained:
                log("Cannot hear the Pi's sound (pw-record %s); trying again every 30 seconds."
                    % ("missing" if why == "missing" else "stopped"))
                complained = True
            engine.stop()
            sleep_stop(stop, CAPTURE_RETRY_S)
            continue
    finally:
        engine.stop()
    return 0


def once_status(cfg, log=print):
    lines = []
    if ha_mode(cfg):
        ha = HaLamp(cfg.ha_url, cfg.ha_token, cfg.ha_lamp)
        ok = ha.snapshot() is not None
        lines.append("Lamp: " + ("answers (through Home Assistant)" if ok
                                 else "did not answer (through Home Assistant)"))
        if not cfg.lamp_ip:
            lines.append("Lamp address: GOVEE_LAMP_IP is needed")
            ok = False
    else:
        try:
            lamp = Lamp(make_govee_socket(), cfg.lamp_ip, log=lambda *_: None)
            ok = (bool(lamp.ip) or lamp.discover()) and lamp.status() is not None
            lines.append("Lamp: " + ("answers" if ok else "did not answer (LAN Control on?)"))
        except OSError:
            ok = False
            lines.append("Lamp: port 4002 is busy (set GOVEE_LAMP_IP and SOUNDLIGHTS_HA_LAMP)")
    if cfg.wled_url:
        w = Wled(cfg.wled_url, log=lambda *_: None)
        got = w.begin()
        if got:
            w.end()
        lines.append("Plant wall: " + ("answers" if got else "did not answer"))
    else:
        lines.append("Plant wall: not set")
    for l in lines:
        log(l)
    return 0 if ok else 1


def test_lamp(cfg, log=print, sleep=time.sleep):
    quiet = lambda *_: None
    lights, names = [], []
    lamp = make_lamp(cfg, quiet)
    if lamp:
        lamp.threaded = False          # put back before the program exits
        lights.append(("Lamp", lamp))
    if cfg.wled_url:
        lights.append(("Plant wall", Wled(cfg.wled_url, log=quiet)))
    answered = []
    for name, l in lights:
        if l.begin():
            answered.append((name, l))
    try:
        steps = 20
        for i in range(steps):                         # 2 seconds, 10 a second
            rgb = hsv_rgb(i / steps * 0.8, 0.9, 1.0)
            for _, l in answered:
                l.frame(Out(rgb, 0.7, 0.0))
            sleep(0.1)
        for _, l in answered:
            l.frame(Out((255, 255, 255), 1.0, 1.0))
        sleep(0.3)
    finally:
        for _, l in answered:
            l.end()
    got = [n for n, _ in answered]
    log("Answered: " + (", ".join(got) if got else "nothing (LAN Control on?)"))
    return 0 if got else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Lights follow the Pi's sound.")
    ap.add_argument("--dry-run", action="store_true", help="no lights; one summary line a second")
    ap.add_argument("--test-lamp", action="store_true", help="2 second sweep and a white flash")
    ap.add_argument("--once-status", action="store_true", help="say what answers, then exit")
    ap.add_argument("--env", default=DEFAULT_ENV, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    cfg = load_config(args.env)
    if args.once_status:
        return once_status(cfg)
    if args.test_lamp:
        return test_lamp(cfg)
    if not cfg.enabled and not args.dry_run:
        print("Sound lights are off (SOUNDLIGHTS=off).", flush=True)
        return 0
    return run(cfg, args.dry_run, log=lambda s: print(s, flush=True))


if __name__ == "__main__":
    sys.exit(main())
