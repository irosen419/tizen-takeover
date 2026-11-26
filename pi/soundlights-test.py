#!/usr/bin/env python3
"""
Tests for soundlights.py. Run from the repo root:

    python3 pi/soundlights-test.py

No network, no real clock, no real sockets: a fake clock and fake sockets.
One test starts a tiny Python program as a stand-in for pw-record.
"""
import array
import importlib.util
import json
import math
import os
import random
import socket
import struct
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("soundlights", os.path.join(HERE, "soundlights.py"))
sl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sl)


def pcm(level, seconds, noise=True, seed=1):
    """s16 mono PCM at the given RMS (0..1)."""
    rnd = random.Random(seed)
    n = int(sl.RATE * seconds)
    amp = level * 32768
    if noise:
        vals = [int(max(-32768, min(32767, rnd.gauss(0, amp)))) for _ in range(n)]
    else:
        vals = [int(amp * 1.414 * math.sin(2 * math.pi * 80 * i / sl.RATE)) for i in range(n)]
    return array.array("h", vals).tobytes()


class FakeSock:
    def __init__(self, replies=None):
        self.sent = []
        self.replies = list(replies or [])
        self.timeout = None

    def settimeout(self, t):
        self.timeout = t

    def sendto(self, data, addr):
        self.sent.append((json.loads(data)["msg"], addr))

    def recvfrom(self, n):
        if not self.replies:
            raise socket.timeout()
        return self.replies.pop(0), ("x", 4002)

    def cmds(self):
        return [m["cmd"] for m, _ in self.sent]


def reply(cmd, data):
    return json.dumps({"msg": {"cmd": cmd, "data": data}}).encode()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Env(unittest.TestCase):
    def test_parse(self):
        e = sl.parse_env('# c\nexport A=1\nB="two words" # x\nC=\'q\'\nD=v #note\n\nbad\nE=a=b\n')
        self.assertEqual(e, {"A": "1", "B": "two words", "C": "q", "D": "v", "E": "a=b"})

    def test_config_defaults_and_clamps(self):
        c = sl.Config({})
        self.assertTrue(c.enabled)
        self.assertEqual((c.delay_ms, c.max_fps, c.lamp_ip, c.wled_url), (150, 10, "", ""))
        c = sl.Config({"SOUNDLIGHTS": "OFF", "SOUNDLIGHTS_DELAY_MS": "5000",
                       "SOUNDLIGHTS_MAX_FPS": "1", "WLED_URL": "plant.local/"})
        self.assertFalse(c.enabled)
        self.assertEqual((c.delay_ms, c.max_fps, c.wled_url), (1000, 2, "http://plant.local"))
        self.assertEqual(sl.Config({"SOUNDLIGHTS_DELAY_MS": "x"}).delay_ms, 150)

    def test_missing_file(self):
        self.assertTrue(sl.load_config("/nonexistent/.env").enabled)


class Govee(unittest.TestCase):
    def test_message_shapes(self):
        self.assertEqual(json.loads(sl.msg_scan()), {"msg": {"cmd": "scan", "data": {"account_topic": "reserve"}}})
        self.assertEqual(json.loads(sl.msg_turn(True))["msg"], {"cmd": "turn", "data": {"value": 1}})
        self.assertEqual(json.loads(sl.msg_turn(False))["msg"]["data"]["value"], 0)
        self.assertEqual(json.loads(sl.msg_brightness(250))["msg"]["data"]["value"], 100)
        self.assertEqual(json.loads(sl.msg_brightness(0))["msg"]["data"]["value"], 1)
        self.assertEqual(json.loads(sl.msg_color(1, 2, 3))["msg"],
                         {"cmd": "colorwc", "data": {"color": {"r": 1, "g": 2, "b": 3}, "colorTemInKelvin": 0}})
        self.assertEqual(json.loads(sl.msg_status())["msg"], {"cmd": "devStatus", "data": {}})

    def test_scan_reply_and_preference(self):
        a = sl.parse_scan_reply(reply("scan", {"ip": "10.0.0.5", "device": "d1", "sku": "H6008"}))
        b = sl.parse_scan_reply(reply("scan", {"ip": "10.0.0.6", "device": "d2", "sku": "H6076"}))
        self.assertEqual(a["ip"], "10.0.0.5")
        self.assertEqual(sl.pick_device([a, b])["sku"], "H6076")
        self.assertEqual(sl.pick_device([a])["sku"], "H6008")
        self.assertIsNone(sl.pick_device([]))
        for bad in (b"junk", reply("devStatus", {}), reply("scan", {}), b'{"msg":1}'):
            self.assertIsNone(sl.parse_scan_reply(bad))

    def test_discover_and_rate_limit(self):
        clk = Clock()
        s = FakeSock([reply("scan", {"ip": "10.0.0.5", "sku": "H6008"}),
                      b"junk",
                      reply("scan", {"ip": "10.0.0.6", "sku": "H6076"})])
        lamp = sl.Lamp(s, clock=clk, log=lambda m: None)
        self.assertTrue(lamp.discover())
        self.assertEqual(lamp.ip, "10.0.0.6")
        self.assertEqual(s.sent[0][1], sl.GOVEE_MULTICAST)
        lamp.ip = ""
        self.assertFalse(lamp.discover())          # inside 5 minutes: no scan
        self.assertEqual(len(s.sent), 1)
        clk.t += 301
        s.replies = []
        self.assertFalse(lamp.discover())          # scans again, nothing
        self.assertEqual(len(s.sent), 2)

    def test_snapshot_restore_on_lamp(self):
        st = {"onOff": 1, "brightness": 40, "color": {"r": 9, "g": 8, "b": 7}, "colorTemInKelvin": 0}
        s = FakeSock([reply("scan", {"ip": "1.1.1.1"}), reply("devStatus", st)])
        s.replies.insert(1, reply("devStatus", st))   # spare, read by status()
        lamp = sl.Lamp(s, "1.1.1.1", log=lambda m: None)
        self.assertTrue(lamp.begin())
        s.sent.clear()
        lamp.frame(sl.Out((200, 100, 0), 0.5, 0))
        self.assertEqual(s.sent[0][0]["data"]["color"], {"r": 100, "g": 50, "b": 0})
        s.sent.clear()
        lamp.end()
        self.assertEqual([m["cmd"] for m, _ in s.sent], ["colorwc", "brightness", "turn"])
        self.assertEqual(s.sent[0][0]["data"]["color"], {"r": 9, "g": 8, "b": 7})
        self.assertEqual(s.sent[1][0]["data"]["value"], 40)
        self.assertEqual(s.sent[2][0]["data"]["value"], 1)
        self.assertEqual(s.sent[0][1], ("1.1.1.1", 4003))

    def test_restore_white_kelvin_and_off(self):
        s = FakeSock([reply("devStatus", {"onOff": 1, "brightness": 80, "color": {"r": 0, "g": 0, "b": 0},
                                          "colorTemInKelvin": 2700})])
        lamp = sl.Lamp(s, "1.1.1.1", log=lambda m: None)
        lamp.begin(); s.sent.clear(); lamp.end()
        self.assertEqual(s.sent[0][0]["data"]["colorTemInKelvin"], 2700)
        s = FakeSock([reply("devStatus", {"onOff": 0, "brightness": 80, "color": {"r": 1, "g": 1, "b": 1}})])
        lamp = sl.Lamp(s, "1.1.1.1", log=lambda m: None)
        lamp.begin()
        self.assertEqual(s.cmds()[-2:], ["turn", "brightness"])   # on during
        s.sent.clear(); lamp.end()
        self.assertEqual(s.cmds(), ["turn"])
        self.assertEqual(s.sent[0][0]["data"]["value"], 0)         # off after

    def test_no_answer_logs_once_and_recovers(self):
        logs = []
        s = FakeSock()
        lamp = sl.Lamp(s, "1.1.1.1", log=logs.append)
        self.assertFalse(lamp.begin()); self.assertFalse(lamp.begin())
        self.assertEqual(logs, ["Lamp did not answer (LAN Control on?)."])
        s.replies = [reply("devStatus", {"onOff": 1, "brightness": 5})]
        self.assertTrue(lamp.begin())
        self.assertEqual(logs[-1], "Lamp answers again.")

    def test_brightness_command_is_occasional(self):
        clk = Clock()
        s = FakeSock([reply("devStatus", {"onOff": 1, "brightness": 5})])
        lamp = sl.Lamp(s, "1.1.1.1", clock=clk, log=lambda m: None)
        lamp.begin(); s.sent.clear()
        for _ in range(5):
            lamp.frame(sl.Out((1, 2, 3), 1, 0))
        self.assertEqual(set(s.cmds()), {"colorwc"})
        clk.t += 11
        lamp.frame(sl.Out((1, 2, 3), 1, 0))
        self.assertIn("brightness", s.cmds())


class FakeHttp:
    def __init__(self, state=None, fail=False):
        self.calls = []
        self.state = state
        self.fail = fail

    def __call__(self, method, url, body=None, timeout=1.5):
        self.calls.append((method, url, body))
        if self.fail:
            raise OSError("down")
        return self.state


class WledTests(unittest.TestCase):
    STATE = {"on": False, "bri": 77, "seg": [{"id": 0, "col": [[1, 2, 3], [0, 0, 0], [0, 0, 0]],
                                                "fx": 12, "pal": 4, "sx": 90, "ix": 60, "n": "name"}]}

    def test_snapshot_and_restore(self):
        h = FakeHttp(self.STATE)
        w = sl.Wled("http://w", h, log=lambda m: None, threaded=False)
        self.assertTrue(w.begin())
        w.frame(sl.Out((10, 20, 30), 0.5, 0))
        m, url, body = h.calls[-1]
        self.assertEqual((m, url), ("POST", "http://w/json/state"))
        self.assertEqual(body, {"on": True, "bri": 128, "tt": 0, "seg": [{"col": [[10, 20, 30]]}]})
        w.end()
        body = h.calls[-1][2]
        self.assertEqual(body["on"], False)
        self.assertEqual(body["bri"], 77)
        self.assertEqual(body["seg"][0], {"id": 0, "col": [[1, 2, 3], [0, 0, 0], [0, 0, 0]],
                                          "fx": 12, "pal": 4, "sx": 90, "ix": 60})
        n = len(h.calls)
        w.frame(sl.Out((1, 1, 1), 1, 0))      # after end: nothing
        self.assertEqual(len(h.calls), n)

    def test_in_flight_frame_dropped(self):
        h = FakeHttp(self.STATE)
        w = sl.Wled("http://w", h, log=lambda m: None, threaded=False)
        w.begin(); n = len(h.calls)
        w.busy = True
        w.frame(sl.Out((1, 1, 1), 1, 0))
        self.assertEqual(len(h.calls), n)

    def test_threaded_frame_reaches_http(self):
        h = FakeHttp(self.STATE)
        w = sl.Wled("http://w", h, log=lambda m: None, threaded=True)
        w.begin(); w.frame(sl.Out((1, 1, 1), 1, 0)); w.end()
        self.assertEqual(h.calls[-1][2]["on"], False)

    def test_down_logs_once(self):
        logs = []
        w = sl.Wled("http://w", FakeHttp(fail=True), log=logs.append, threaded=False)
        self.assertFalse(w.begin()); self.assertFalse(w.begin())
        self.assertEqual(logs, ["Plant wall did not answer."])


class Analysis(unittest.TestCase):
    def run_blocks(self, an, data, t0=0.0):
        t, frames = t0, []
        size = sl.BLOCK_SAMPLES * 2
        for i in range(0, len(data) - size + 1, size):
            s = array.array("h"); s.frombytes(data[i:i + size])
            t += sl.BLOCK_S
            frames.append(an.process(s, t))
        return frames

    def test_gate_keeps_silence_dark(self):
        fr = self.run_blocks(sl.Analyzer(), pcm(0.001, 1))
        self.assertTrue(all(not f.gate and f.level == 0 for f in fr))
        self.assertEqual(sum(f.flash for f in fr), 0)

    def test_normalization_and_floor(self):
        an = sl.Analyzer()
        fr = self.run_blocks(an, pcm(0.2, 1))
        self.assertAlmostEqual(fr[-1].level, 1.0, delta=0.5)
        self.assertTrue(0 < fr[-1].level <= 1.0)
        # a quiet sound after silence is bright only relative to the floor
        quiet = self.run_blocks(sl.Analyzer(), pcm(0.01, 1))
        self.assertLess(quiet[-1].level, 0.5)
        # peak decays: after 20 s of quiet the same sound reads brighter
        an = sl.Analyzer(); self.run_blocks(an, pcm(0.5, 0.5))
        p = an.peak
        self.run_blocks(an, pcm(0.01, 1)); self.assertLess(an.peak, p)

    def test_bass_share(self):
        low = self.run_blocks(sl.Analyzer(), pcm(0.2, 1, noise=False))
        hi = self.run_blocks(sl.Analyzer(), pcm(0.2, 1, noise=True))
        self.assertGreater(low[-1].bass_share, 0.7)
        self.assertLess(hi[-1].bass_share, 0.4)

    def test_transient_and_refractory(self):
        an = sl.Analyzer()
        data = pcm(0.02, 2)
        data += pcm(0.5, 0.1, seed=2)             # clap
        data += pcm(0.02, 0.1, seed=3)
        data += pcm(0.5, 0.1, seed=4)             # too soon (about 0.1-0.2 s later)
        data += pcm(0.02, 1.0, seed=5)
        data += pcm(0.5, 0.1, seed=6)             # a real second clap
        fr = self.run_blocks(an, data)
        self.assertEqual(sum(f.flash for f in fr), 2)

    def test_steady_loud_is_not_a_flash(self):
        fr = self.run_blocks(sl.Analyzer(), pcm(0.3, 0.05) + pcm(0.3, 3, seed=9))
        self.assertLessEqual(sum(f.flash for f in fr), 1)   # only the very start may

    def test_small_jump_below_floor_is_not_flash(self):
        fr = self.run_blocks(sl.Analyzer(), pcm(0.005, 1) + pcm(0.03, 0.5))
        self.assertEqual(sum(f.flash for f in fr), 0)


class Output(unittest.TestCase):
    def frame(self, level, share=0.5, flash=False):
        return sl.Frame(level * 0.3, level, level, share, level > 0, flash)

    def test_attack_faster_than_release(self):
        lk = sl.Look(); t = 0.0
        for _ in range(4):
            t += 0.025; lk.update(self.frame(1.0), t)
        up = lk.cur
        self.assertGreater(up, 0.4)
        t += 0.025; lk.update(self.frame(0.0), t)
        self.assertGreater(lk.cur, up * 0.85)             # slow release

    def test_warm_for_bass_cool_for_highs(self):
        def hue_rgb(share):
            lk = sl.Look(); t = 0.0
            for _ in range(400):
                t += 0.025; o = lk.update(self.frame(0.8, share), t)
            return o.rgb
        warm, cool = hue_rgb(0.95), hue_rgb(0.05)
        self.assertGreater(warm[0], warm[2])
        self.assertGreater(cool[2], cool[0])

    def test_flash_white_then_decay(self):
        lk = sl.Look()
        lk.update(self.frame(0.2), 1.0)
        o = lk.update(self.frame(0.2, flash=True), 1.025)
        self.assertEqual((o.rgb, o.bri), ((255, 255, 255), 1.0))
        o = lk.update(self.frame(0.2), 1.1)
        self.assertEqual(o.flash, 1.0)
        o = lk.update(self.frame(0.2), 1.3)
        self.assertTrue(0 < o.flash < 1)
        o = lk.update(self.frame(0.2), 1.6)
        self.assertEqual(o.flash, 0)

    def test_rate_limit_and_meaningful_change(self):
        th = sl.Throttle(10)
        a = sl.Out((200, 0, 0), 1.0, 0)
        self.assertTrue(th.should_send(a, 0.0))
        self.assertFalse(th.should_send(sl.Out((0, 200, 0), 1.0, 0), 0.05))   # too soon
        self.assertFalse(th.should_send(sl.Out((201, 0, 0), 1.0, 0), 0.2))     # tiny change
        self.assertTrue(th.should_send(sl.Out((100, 0, 0), 1.0, 0), 0.3))
        sent = sum(th.should_send(sl.Out((i % 2 * 255, 0, 0), 1.0, 0), 1 + i * 0.01) for i in range(100))
        self.assertLessEqual(sent, 11)                                          # 1 s at 10 fps

    def test_delay_queue_order(self):
        q = sl.DelayQueue()
        q.push(2.0, "b"); q.push(1.0, "a"); q.push(2.0, "c"); q.push(5.0, "z")
        self.assertEqual(q.pop_due(0.5), [])
        self.assertEqual(q.pop_due(2.0), ["a", "b", "c"])
        self.assertEqual(len(q), 1)
        q.clear(); self.assertEqual(len(q), 0)


class FakeLight:
    def __init__(self, ok=True):
        self.ok, self.events = ok, []

    def begin(self):
        self.events.append("begin"); return self.ok

    def frame(self, out):
        self.events.append(("frame", out.rgb))

    def end(self):
        self.events.append("end")


class Sessions(unittest.TestCase):
    def test_session_lifecycle_delay_and_restore(self):
        logs = []; light = FakeLight()
        e = sl.Engine([light], delay_ms=200, max_fps=10, log=logs.append)
        now = 100.0
        e.feed(pcm(0.001, 0.5), now)                       # silence: nothing
        self.assertEqual(light.events, [])
        for _ in range(8):                                 # about 1 s of music
            now += 0.1; e.feed(pcm(0.2, 0.1, seed=int(now)), now)
        self.assertEqual(light.events[0], "begin")
        self.assertIn("Following the sound.", logs)
        frames = [x for x in light.events if isinstance(x, tuple)]
        self.assertTrue(0 < len(frames) <= 9)
        # the delay: right after the first frame was queued nothing was sent
        e2 = sl.Engine([FakeLight()], delay_ms=1000, max_fps=10, log=lambda m: None)
        n = 100.0
        for _ in range(8):
            n += 0.1; e2.feed(pcm(0.2, 0.1, seed=5), n)
        self.assertEqual([x for x in e2.lights[0].events if isinstance(x, tuple)], [])
        # silence for 8 s puts things back
        e.tick(now + 7); self.assertNotIn("end", light.events)
        e.tick(now + 9); self.assertEqual(light.events[-1], "end")
        self.assertIn("Quiet, lights put back.", logs)
        self.assertFalse(e.active)

    def test_restore_on_stop(self):
        light = FakeLight(); e = sl.Engine([light], 0, 10, lambda m: None)
        now = 0.0
        for _ in range(8):
            now += 0.1; e.feed(pcm(0.2, 0.1), now)
        self.assertTrue(e.active)
        e.stop()
        self.assertEqual(light.events[-1], "end")
        n = len(light.events); e.stop()
        self.assertEqual(len(light.events), n)

    def test_light_that_will_not_start_is_skipped_then_retried_later(self):
        light = FakeLight(ok=False); e = sl.Engine([light], 0, 10, lambda m: None)
        now = 0.0
        for _ in range(20):
            now += 0.1; e.feed(pcm(0.2, 0.1), now)
        self.assertEqual(light.events.count("begin"), 1)    # not hammered
        self.assertFalse(e.active)
        for _ in range(300):
            now += 0.1; e.feed(pcm(0.2, 0.1), now)
        self.assertGreater(light.events.count("begin"), 1)

    def test_no_lights_configured(self):
        logs = []; e = sl.Engine([], 150, 10, logs.append)
        now = 0.0
        for _ in range(10):
            now += 0.1; e.feed(pcm(0.2, 0.1), now)
        e.tick(now + 20); e.stop()
        self.assertEqual(logs, [])
        self.assertFalse(e.active)

    def test_lamp_and_wled_together_with_fakes(self):
        st = {"onOff": 1, "brightness": 30, "color": {"r": 1, "g": 2, "b": 3}, "colorTemInKelvin": 0}
        s = FakeSock([reply("devStatus", st)])
        lamp = sl.Lamp(s, "1.1.1.1", log=lambda m: None)
        h = FakeHttp(WledTests.STATE)
        w = sl.Wled("http://w", h, log=lambda m: None, threaded=False)
        e = sl.Engine([lamp, w], 0, 10, lambda m: None)
        now = 0.0
        for _ in range(10):
            now += 0.1; e.feed(pcm(0.2, 0.1), now)
        e.stop()
        self.assertEqual(s.cmds()[-3:], ["colorwc", "brightness", "turn"])
        self.assertEqual(h.calls[-1][2]["bri"], 77)


class Capture(unittest.TestCase):
    def test_wav_header_skipped(self):
        hdr = b"RIFF" + struct.pack("<I", 0xFFFFFFF0) + b"WAVE" + \
              b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + \
              b"data" + struct.pack("<I", 0xFFFFFFFF)
        w = sl.WavSkip()
        out = w.push(hdr[:20]) + w.push(hdr[20:] + b"\x01\x02") + w.push(b"\x03\x04")
        self.assertEqual(out, b"\x01\x02\x03\x04")
        w = sl.WavSkip()
        self.assertEqual(w.push(b"\x00\x01\x02\x03\x04"), b"\x00\x01\x02\x03\x04")

    def test_fake_capture_process(self):
        script = ("import sys,array,random\n"
                  "r=random.Random(1)\n"
                  "q=array.array('h',[int(r.gauss(0,600)) for _ in range(16000)])\n"
                  "l=array.array('h',[max(-32768,min(32767,int(r.gauss(0,16000)))) for _ in range(1600)])\n"
                  "sys.stdout.buffer.write(q.tobytes()+l.tobytes()+q.tobytes());sys.stdout.flush()\n")
        old = sl.CAPTURE_CMD
        sl.CAPTURE_CMD = [sys.executable, "-c", script]
        try:
            e = sl.Engine([], 0, 10, lambda m: None)
            why = sl.run_capture(e, threading.Event())
        finally:
            sl.CAPTURE_CMD = old
        self.assertEqual(why, "exited")
        self.assertGreaterEqual(e.flashes, 1)

    def test_missing_command(self):
        old = sl.CAPTURE_CMD
        sl.CAPTURE_CMD = ["/nonexistent/pw-record"]
        try:
            self.assertEqual(sl.run_capture(sl.Engine([], 0, 10, print), threading.Event()), "missing")
        finally:
            sl.CAPTURE_CMD = old


if __name__ == "__main__":
    unittest.main(verbosity=1)
