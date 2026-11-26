#!/usr/bin/env python3
"""
Tests for pi-health.py. Run from the repo root:

    python3 pi/health/test_pi_health.py

The pure parts (scrubbing, throttle bits, reboot detection, week stats) are
tested directly. Then the whole script runs once against a fake hub server and
a fake Home Assistant on 127.0.0.1, both of which leak on purpose (IP
addresses, tokens, a budget amount, entity ids), and the report must hold none
of it. Nothing leaves this computer; standard library only.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'pi-health.py')

sys.argv = [sys.argv[0]]  # the module reads its flags at import
spec = importlib.util.spec_from_file_location('pihealth', SCRIPT)
ph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ph)

HUB_TOKEN = 'hubtoken-0123456789abcdef'
HA_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake-ha-token.signature'
MAILBOX_SECRET = 'R2secretValue/abcdefghij'
CAL_NAME = 'Family Shared Calendar'
BUDGET_AMOUNT = '1234.56'


class Fake(BaseHTTPRequestHandler):
    routes = {}

    def log_message(self, *a):
        pass

    def answer(self):
        path = self.path.split('?')[0]
        for prefix, fn in self.routes.items():
            if path == prefix or (prefix.endswith('*') and path.startswith(prefix[:-1])):
                auth = self.headers.get('Authorization', '')
                body = None
                n = int(self.headers.get('Content-Length') or 0)
                if n:
                    body = json.loads(self.rfile.read(n))
                status, out = fn(auth, body, self.path)
                data = json.dumps(out).encode() if not isinstance(out, str) else out.encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_response(404)
        self.end_headers()

    do_GET = answer
    do_POST = answer


def serve(routes):
    handler = type('H', (Fake,), {'routes': routes})
    s = HTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def need(token):
    def wrap(fn):
        def inner(auth, body, path):
            if auth != 'Bearer ' + token:
                return 401, {'ok': False}
            return fn(body, path)
        return inner
    return wrap


def today(offset=0):
    import datetime
    return (datetime.date.today() - datetime.timedelta(days=offset)).isoformat()


class Pure(unittest.TestCase):
    def test_scrub(self):
        t = ph.scrub('from 192.168.1.40 fe80::1 aa:bb:cc:dd:ee:ff sensor.cpu_temp at 10:22:01 '
                     'budget.service hub-update.service ian@example.com https://x.y/z tok-123456', {'tok-123456'})
        for bad in ('192.168', 'fe80', 'aa:bb', 'sensor.cpu', 'example.com', 'https', 'tok-123456'):
            self.assertNotIn(bad, t)
        for good in ('10:22:01', 'budget.service', 'hub-update.service'):
            self.assertIn(good, t)

    def test_secret_values(self):
        s = ph.secret_values({'HA_URL': 'http://homeassistant.local:8123', 'HUB_PORT': '8097', 'HUB_TIMEZONE': 'America/Chicago', 'X': 'short'})
        self.assertIn('homeassistant.local', s)
        self.assertNotIn('8097', s)
        self.assertNotIn('America/Chicago', s)
        self.assertNotIn('short', s)

    def test_throttled(self):
        d = ph.decode_throttled(0x50000)
        self.assertTrue(d['underVoltageSinceBoot'])
        self.assertTrue(d['throttledSinceBoot'])
        self.assertFalse(d['underVoltageNow'])

    def test_unclean_boots(self):
        ev = ph.parse_last(
            'reboot   system boot  6.6 Tue Nov 19 01:10:11 2026   still running\n'
            'reboot   system boot  6.6 Mon Nov 18 01:10:11 2026 - Tue Nov 19 01:00:00 2026  (23:49)\n'
            'shutdown system down  6.6 Sun Nov 17 05:00:00 2026 - Mon Nov 18 01:10:11 2026  (20:10)\n'
            'reboot   system boot  6.6 Sun Nov 17 01:10:11 2026 - Sun Nov 17 05:00:00 2026  (03:49)\n'
            '\nwtmp begins Sun Nov 17 01:10:11 2026\n')
        self.assertEqual([k for _, k in ev], ['reboot', 'shutdown', 'reboot', 'reboot'])
        self.assertEqual(len(ph.unexpected_boots(ev, 0)), 1)  # Nov 19 came after a boot, not a shutdown

    def test_week_stats(self):
        w = ph.week_stats([(0, 40.0), (100, 60.0)], 400)
        self.assertEqual(w['min'], 40.0)
        self.assertEqual(w['max'], 60.0)
        self.assertEqual(w['mean'], 55.0)  # 40 for 100 s, 60 for 300 s


class WholeRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='pi-health-test-')
        data = os.path.join(cls.tmp, 'data')
        os.makedirs(data)
        with open(os.path.join(data, 'translate-usage.json'), 'w') as f:
            json.dump({'v': 1, 'days': {today(1): {'lines': 1900, 'calls': 4, 'inTok': 100, 'outTok': 50},
                                        today(0): {'lines': 12, 'calls': 1, 'inTok': 10, 'outTok': 5}}}, f)
        hub = serve({
            '/api/status': need(HUB_TOKEN)(lambda b, p: (200, {
                'ok': True, 'server': '0.15.0', 'uptime': 7200,
                'screens': [{'since': '2026-11-19T10:00:00Z', 'via': 'events', 'address': '192.168.1.60'}],
                'calendar': {'configured': True, 'calendars': 5, 'lastRefresh': '2020-01-01T00:00:00Z'},
                'mailbox': {'configured': True, 'connected': True, 'bucket': 'home-hub-mailbox', 'host': 'abc.r2.cloudflarestorage.com',
                            'lastOkAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'lastError': None, 'pendingResults': 0},
                'spotify': {'configured': True, 'signedIn': True, 'user': 'Ian Somebody', 'track': {'title': 'A Song'}, 'state': 'playing'},
                'shows': {'shows': 4, 'lastRefresh': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                'ambience': {'configured': True, 'lights': 3, 'answering': 2}})),
            '/api/log': need(HUB_TOKEN)(lambda b, p: (200, {'ok': True, 'errors24h': 25, 'lines': [
                {'t': '2026-11-19T10:00:00Z', 'text': 'calendar: [name] could not be read from 10.0.0.5', 'level': 'error'}]})),
            '/api/translate/usage': need(HUB_TOKEN)(lambda b, p: (200, {'ok': True, 'enabled': True, 'paused': False, 'cached': 300, 'cap': 2000})),
            '/api/budget': need(HUB_TOKEN)(lambda b, p: (200, {'ok': True, 'data': {'sentAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'room': {'perDay': BUDGET_AMOUNT}}})),
            '/api/awws': need(HUB_TOKEN)(lambda b, p: (200, {'ok': True, 'data': None})),
        })
        states = [
            {'entity_id': 'sensor.system_monitor_processor_temperature', 'state': '61.2',
             'attributes': {'friendly_name': 'System Monitor Processor temperature', 'device_class': 'temperature', 'unit_of_measurement': '°C'}},
            {'entity_id': 'sensor.system_monitor_memory_usage', 'state': '41.0',
             'attributes': {'friendly_name': 'System Monitor Memory usage', 'unit_of_measurement': '%'}},
            {'entity_id': 'binary_sensor.rpi_power_status', 'state': 'off',
             'attributes': {'friendly_name': 'RPi Power status', 'device_class': 'problem'}},
            {'entity_id': 'light.geeni_lamp', 'state': 'unavailable', 'attributes': {'friendly_name': 'Lamp'}},
            {'entity_id': 'light.plant_wall', 'state': 'on', 'attributes': {'friendly_name': 'Plant wall'}},
            {'entity_id': 'update.home_assistant_core_update', 'state': 'on', 'attributes': {'friendly_name': 'Home Assistant Core Update'}},
        ]
        hist = [
            [{'entity_id': 'sensor.system_monitor_processor_temperature', 'state': '55.0', 'last_changed': '2026-11-13T00:00:00+00:00'},
             {'state': '83.4', 'last_changed': '2026-11-15T00:00:00+00:00'}, {'state': '61.2', 'last_changed': '2026-11-15T01:00:00+00:00'}],
            [{'entity_id': 'binary_sensor.rpi_power_status', 'state': 'off', 'last_changed': '2026-11-13T00:00:00+00:00'},
             {'state': 'on', 'last_changed': '2026-11-14T00:00:00+00:00'}, {'state': 'off', 'last_changed': '2026-11-14T00:01:00+00:00'}],
        ]
        ha = serve({
            '/api/config': need(HA_TOKEN)(lambda b, p: (200, {'version': '2026.11.2', 'state': 'RUNNING', 'latitude': 29.7, 'location_name': 'Home'})),
            '/api/template': need(HA_TOKEN)(lambda b, p: (200, json.dumps([
                ['systemmonitor', 'sensor.system_monitor_processor_temperature'], ['systemmonitor', 'sensor.system_monitor_memory_usage'],
                ['rpi_power', 'binary_sensor.rpi_power_status']]))),
            '/api/states': need(HA_TOKEN)(lambda b, p: (200, states)),
            '/api/history/period/*': need(HA_TOKEN)(lambda b, p: (200, hist)),
        })
        cls.servers = [hub, ha]
        env_file = os.path.join(cls.tmp, '.env')
        with open(env_file, 'w') as f:
            f.write('HUB_TOKEN=%s\nHUB_PORT=%d\nHA_URL=http://127.0.0.1:%d\nHA_TOKEN=%s\n'
                    'HUB_MAILBOX_SECRET_ACCESS_KEY=%s\nCALENDAR_1_NAME="%s"\nHUB_TIMEZONE=America/Chicago\n'
                    % (HUB_TOKEN, hub.server_port, ha.server_port, HA_TOKEN, MAILBOX_SECRET, CAL_NAME))
        checks = os.path.join(cls.tmp, 'checks.d')
        os.makedirs(checks)
        with open(os.path.join(checks, 'storm.sh'), 'w') as f:
            f.write('#!/bin/sh\necho \'{"status":"warn","flags":[{"level":"warn","area":"storm","text":"speaker at 192.168.1.50 did not answer"}]}\'\n')
        with open(os.path.join(checks, 'broken.sh'), 'w') as f:
            f.write('#!/bin/sh\necho not json\n')
        with open(os.path.join(checks, 'skipped.sh.example'), 'w') as f:
            f.write('#!/bin/sh\nexit 1\n')
        for n in os.listdir(checks):
            os.chmod(os.path.join(checks, n), 0o755)
        cls.out = os.path.join(data, 'health')
        os.makedirs(cls.out)
        for i in range(14):  # old reports: only the newest 12 dated files are kept
            with open(os.path.join(cls.out, '2025-01-%02d.json' % (i + 1)), 'w') as f:
                f.write('{}')
        env = dict(os.environ, PI_HEALTH_ENV=env_file, PI_HEALTH_DATA=data, PI_HEALTH_CHECKS=checks)
        cls.proc = subprocess.run([sys.executable, SCRIPT], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  universal_newlines=True, timeout=300)
        with open(os.path.join(cls.out, 'latest.json')) as f:
            cls.text = f.read()
        cls.rep = json.loads(cls.text)

    @classmethod
    def tearDownClass(cls):
        for s in cls.servers:
            s.shutdown()
            s.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def flag_texts(self):
        return [f['text'] for f in self.rep['flags']]

    def test_ran_and_wrote(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)
        self.assertEqual(self.rep['kind'], 'pi-health')
        self.assertEqual(self.rep['scriptErrors'], [])
        self.assertTrue(os.path.exists(os.path.join(self.out, 'latest.txt')))
        self.assertTrue(os.path.exists(os.path.join(self.out, self.rep['generated'][:10] + '.json')))
        dated = [n for n in os.listdir(self.out) if n[:2] == '20' and n.endswith('.json')]
        self.assertEqual(len(dated), 12)
        self.assertIn(self.rep['summary']['overall'], ('ok', 'warn', 'bad'))

    def test_nothing_private(self):
        for secret in (HUB_TOKEN, HA_TOKEN, MAILBOX_SECRET, CAL_NAME, BUDGET_AMOUNT, '192.168.', '10.0.0.5', 'r2.cloudflarestorage',
                       'home-hub-mailbox', 'Ian Somebody', 'A Song', 'sensor.system_monitor', 'binary_sensor.rpi', 'light.geeni',
                       'latitude', 'location_name'):
            self.assertNotIn(secret, self.text, secret)
        self.assertNotIn('127.0.0.1', self.text)

    def test_hub(self):
        hub = self.rep['hub']
        self.assertEqual(hub['server'], '0.15.0')
        self.assertEqual(hub['screensListening'], 1)
        self.assertEqual(hub['translate']['peakDayLines'], 1900)
        self.assertEqual(hub['translate']['cap'], 2000)
        self.assertGreater(hub['dataAgeHours']['calendar'], 1000)
        self.assertLess(hub['dataAgeHours']['budget'], 1)
        t = ' | '.join(self.flag_texts())
        self.assertIn('The busiest day used 1900 of the 2000 new translation lines a day', t)
        self.assertIn('25 problems in the hub log in the last 24 hours', t)
        self.assertIn('The calendar data on the hub is', t)

    def test_home_assistant(self):
        ha = self.rep['homeAssistant']
        self.assertEqual(ha['version'], '2026.11.2')
        names = [s['name'] for s in ha['piSensors']]
        self.assertIn('System Monitor Processor temperature', names)
        temp = [s for s in ha['piSensors'] if s['deviceClass'] == 'temperature'][0]
        self.assertEqual(temp['week']['max'], 83.4)
        self.assertEqual(ha['domains']['light'], {'total': 2, 'unavailable': 1})
        self.assertEqual(ha['updatesWaiting'], ['Home Assistant Core Update'])
        t = ' | '.join(self.flag_texts())
        self.assertIn('System Monitor Processor temperature reached 83.4 this week (Home Assistant)', t)
        self.assertIn('RPi Power status was on this week (1 time(s))', t)

    def test_extras(self):
        ex = self.rep['extras']
        self.assertEqual(ex['storm']['status'], 'warn')
        self.assertIn('error', ex['broken'])
        self.assertNotIn('skipped', ex)
        t = ' | '.join(self.flag_texts())
        self.assertIn('speaker at [address] did not answer', t)
        self.assertIn('Extra check broken did not print a JSON object', t)

    def test_flags_sorted(self):
        levels = [f['level'] for f in self.rep['flags']]
        self.assertEqual(levels, sorted(levels, key=lambda l: 0 if l == 'bad' else 1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
