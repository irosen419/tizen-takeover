/*
 * Scripts that fail to load are fetched again and the page loads again:
 * node dev/scripts-test.js
 *
 * Starts the preview on its own ports and breaks a script on the way to the
 * page (failed, cut short, the proxy's own words, empty), the way TizenBrew's
 * proxy sometimes does on the TV (seen with logos.js: every app a letter).
 * SCRIPTS_TEST_SHOTS=dir keeps screenshots.
 */
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var playwright = require('playwright');

var PAGE_PORT = 8490;
var SERVICE_PORT = 8495;
var SHOTS = process.env.SCRIPTS_TEST_SHOTS || '';
var APP = path.join(__dirname, '..', 'app');
var WORDS = "Couldn't find the requested file /app/logos.js in owner/repo.";

function assert(ok, text) { if (!ok) throw new Error(text); }

/*
 * rules: [{ file: 'logos.js', kind: fail | cut | words | empty | throws,
 *           tag: n, xhr: n }]  how many fetches by the page's tag, and by the
 * retry's request, break (Infinity = all). Returns counts and page loads.
 */
async function open(browser, rules) {
  var context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  var page = await context.newPage();
  var seen = {};
  var loads = 0;
  page.on('framenavigated', function (f) { if (f === page.mainFrame()) loads += 1; });
  await page.route('**/*', function (route) {
    var req = route.request();
    var u = req.url();
    if (!/127\.0\.0\.1|localhost/.test(u)) return route.abort();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (u.split('?')[0].slice(-('/' + r.file).length) !== '/' + r.file) continue;
      var how = req.resourceType() === 'script' ? 'tag' : 'xhr';
      var s = seen[r.file] = seen[r.file] || { tag: 0, xhr: 0 };
      s[how] += 1;
      if (s[how] <= (r[how] || 0)) {
        if (r.kind === 'fail') return route.abort();
        var whole = fs.readFileSync(path.join(APP, r.file), 'utf8');
        var body = r.kind === 'empty' ? '' : r.kind === 'words' ? WORDS : r.kind === 'throws' ? "throw new Error('pretend');\n"
          : whole.slice(0, Math.floor(whole.length / 2));
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: body });
      }
    }
    if (u.indexOf(':8095/') >= 0) return route.continue({ url: u.replace(':8095/', ':' + SERVICE_PORT + '/') });
    route.continue();
  });
  await page.goto('http://127.0.0.1:' + PAGE_PORT + '/hub.html');
  return {
    page: page,
    seen: function (file) { return seen[file] || { tag: 0, xhr: 0 }; },
    loads: function () { return loads; },
    close: function () { return context.close(); }
  };
}

function look(page) {
  return page.evaluate(function () {
    var letters = [];
    var c = document.querySelectorAll('.ent-chip .logo-text');
    for (var i = 0; i < c.length; i++) if (!/^\+/.test(c[i].textContent)) letters.push(c[i].textContent);
    var kept = null;
    try { kept = window.sessionStorage.getItem('homeHub.scripts'); } catch (e) { kept = 'unreadable'; }
    return {
      status: window.HUB_SCRIPTS.status(),
      pending: window.HUB_SCRIPTS.pending(),
      logos: document.querySelectorAll('.ent-chip .logo-face svg').length,
      letters: letters.join(''),
      tiles: document.querySelectorAll('#grid .tile').length,
      started: !!window.HUB_TEST,
      kept: kept
    };
  });
}

// The About panel's rows, as { label: value }.
async function aboutRows(page) {
  var rows = await page.evaluate(function () {
    window.HUB_TEST.about.open();
    return window.HUB_TEST.about.rows();
  });
  var out = {};
  for (var i = 0; i < rows.length; i++) out[rows[i].label] = rows[i].value;
  return out;
}

// Waits out the retries and reloads: nothing pending for a second and a half.
async function settled(o, ms) {
  var end = Date.now() + (ms || 20000);
  var quiet = 0;
  while (Date.now() < end) {
    await o.page.waitForTimeout(300);
    var p = true;
    try { p = await o.page.evaluate(function () { return !window.HUB_SCRIPTS || !window.HUB_TEST && !window.HUB_SCRIPTS.status() ? true : window.HUB_SCRIPTS.pending(); }); } catch (e) { p = true; }
    quiet = p ? 0 : quiet + 300;
    if (quiet >= 1500) return;
  }
  throw new Error('the page never settled');
}

async function mended(browser, kind, name) {
  var o = await open(browser, [{ file: 'logos.js', kind: kind, tag: 1 }]);
  if (SHOTS && kind === 'fail') {
    await o.page.waitForTimeout(250);
    try { await o.page.screenshot({ path: path.join(SHOTS, 'scripts-1-letters.png') }); } catch (e) { /* it was loading again */ }
  }
  await settled(o);
  var s = await look(o.page);
  if (SHOTS && kind === 'fail') await o.page.screenshot({ path: path.join(SHOTS, 'scripts-2-mended.png') });
  var n = o.seen('logos.js');
  assert(o.loads() === 2, name + ': page loads ' + o.loads());
  assert(n.tag === 2 && n.xhr === 1, name + ': fetches ' + JSON.stringify(n));
  assert(s.logos >= 3 && s.letters === '', name + ': ' + JSON.stringify(s));
  assert(s.status === 'logos.js loaded on a later try', name + ': ' + s.status);
  var rows = await aboutRows(o.page);
  assert(rows.Scripts === 'logos.js loaded on a later try', name + ': About rows ' + JSON.stringify(rows));
  await o.close();
}

var CHECKS = [
  ['Every script tag in hub.html is one the retry looks after, and every file ends the way a whole one does', async function () {
    var html = fs.readFileSync(path.join(APP, 'hub.html'), 'utf8');
    var tags = html.match(/<script[^>]*src="[^"]+"[^>]*>/g) || [];
    assert(tags.length >= 18, 'script tags: ' + tags.length);
    for (var i = 0; i < tags.length; i++) {
      assert(!/\basync\b|\bdefer\b/.test(tags[i]), tags[i] + ' is async or defer');
      var file = /src="([^"]+)"/.exec(tags[i])[1];
      assert(/^[A-Za-z0-9_.\-\/]{1,80}$/.test(file), file + ' has a name the retry refuses');
      var text = fs.readFileSync(path.join(APP, file), 'utf8').replace(/\s+$/, '');
      assert(/[;})]$/.test(text), file + ' does not end with ; } or )');
    }
  }],
  ['A clean load fetches nothing twice, says nothing and keeps nothing', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'fail', tag: 0 }]);
    await o.page.waitForTimeout(5000);
    var s = await look(o.page);
    var n = o.seen('logos.js');
    assert(o.loads() === 1 && n.tag === 1 && n.xhr === 0, o.loads() + ' ' + JSON.stringify(n));
    assert(s.status === '' && !s.pending && s.logos >= 3 && s.kept === null, JSON.stringify(s));
    var rows = await aboutRows(o.page);
    assert(!('Scripts' in rows), 'a Scripts row on a clean load: ' + JSON.stringify(rows));
    await o.close();
  }],
  ['Without logos.js every app is a letter (what the TV showed)', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'fail', tag: Infinity, xhr: Infinity }]);
    await o.page.waitForTimeout(1500);
    var s = await look(o.page);
    assert(s.logos === 0 && /^NPDHP/.test(s.letters), JSON.stringify(s));
    await o.close();
  }],
  ['A script whose fetch fails once: fetched again, the page loads again, the logos are there', function (browser) { return mended(browser, 'fail', 'failed'); }],
  ['A script cut short once: the same', function (browser) { return mended(browser, 'cut', 'cut'); }],
  ['A script that came as the proxy\'s own words once: the same', function (browser) { return mended(browser, 'words', 'words'); }],
  ['A script that came empty once: the same', function (browser) { return mended(browser, 'empty', 'empty'); }],
  ['A script that never comes: three more fetches, no reload, the About panel says so', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'fail', tag: Infinity, xhr: Infinity }]);
    await settled(o);
    var s = await look(o.page);
    var n = o.seen('logos.js');
    assert(o.loads() === 1 && n.tag === 1 && n.xhr === 3, o.loads() + ' ' + JSON.stringify(n));
    assert(s.status === 'logos.js did not load' && s.logos === 0 && s.started, JSON.stringify(s));
    var rows = await aboutRows(o.page);
    assert(rows.Scripts === 'logos.js did not load', JSON.stringify(rows));
    await o.close();
  }],
  ['A fetch that keeps coming cut short is not taken for the script', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'cut', tag: Infinity, xhr: Infinity }]);
    await settled(o);
    var s = await look(o.page);
    var n = o.seen('logos.js');
    assert(o.loads() === 1 && n.tag === 1 && n.xhr === 3 && s.status === 'logos.js did not load', o.loads() + ' ' + JSON.stringify(n) + ' ' + s.status);
    await o.close();
  }],
  ['No reload loop: a tag that always fails though the fetch works stops after two reloads', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'fail', tag: Infinity, xhr: 0 }]);
    await settled(o, 30000);
    await o.page.waitForTimeout(4000);
    var s = await look(o.page);
    var n = o.seen('logos.js');
    assert(o.loads() === 3 && n.tag === 3 && n.xhr === 3, o.loads() + ' ' + JSON.stringify(n));
    assert(s.status === 'logos.js did not load' && s.started && !s.pending, JSON.stringify(s));
    await o.close();
  }],
  ['Two scripts fail at once: one reload for both', async function (browser) {
    var o = await open(browser, [{ file: 'logos.js', kind: 'fail', tag: 1 }, { file: 'widgets/weather.js', kind: 'cut', tag: 1 }]);
    await settled(o);
    var s = await look(o.page);
    assert(o.loads() === 2, 'page loads ' + o.loads());
    assert(s.status === 'logos.js, widgets/weather.js loaded on a later try' || s.status === 'widgets/weather.js, logos.js loaded on a later try', s.status);
    var weather = await o.page.evaluate(function () { return !!document.querySelector('[data-widget="weather"]'); });
    assert(weather && s.logos >= 3, 'weather tile ' + weather + ' ' + JSON.stringify(s));
    await o.close();
  }],
  ['hub.js itself fails once: the page loads again and the hub starts', async function (browser) {
    var o = await open(browser, [{ file: 'hub.js', kind: 'fail', tag: 1 }]);
    await settled(o);
    var s = await look(o.page);
    assert(o.loads() === 2 && s.started && s.tiles >= 8 && s.status === 'hub.js loaded on a later try', o.loads() + ' ' + JSON.stringify(s));
    await o.close();
  }],
  ['config.js fails once (the hub can\'t start without it): the page loads again and the hub starts', async function (browser) {
    var o = await open(browser, [{ file: 'config.js', kind: 'words', tag: 1 }]);
    await settled(o);
    var s = await look(o.page);
    assert(o.loads() === 2 && s.started && s.tiles >= 8 && s.status === 'config.js loaded on a later try', o.loads() + ' ' + JSON.stringify(s));
    await o.close();
  }],
  ['A script that throws while running is not fetched again', async function (browser) {
    var o = await open(browser, [{ file: 'widgets/planned.js', kind: 'throws', tag: Infinity, xhr: Infinity }]);
    await o.page.waitForTimeout(5000);
    var s = await look(o.page);
    var n = o.seen('widgets/planned.js');
    assert(o.loads() === 1 && n.tag === 1 && n.xhr === 0 && s.status === '' && !s.pending, o.loads() + ' ' + JSON.stringify(n) + ' ' + JSON.stringify(s));
    await o.close();
  }],
  ['A script added later by a script is left to whoever added it', async function (browser) {
    var o = await open(browser, []);
    await o.page.waitForTimeout(1500);
    await o.page.evaluate(function () {
      var s = document.createElement('script');
      s.src = 'no-such-file.js?x=1';
      document.body.appendChild(s);
    });
    await o.page.route('**/no-such-file.js*', function (route) { route.abort(); });
    await o.page.waitForTimeout(3000);
    var s = await look(o.page);
    assert(o.loads() === 1 && s.status === '' && !s.pending, o.loads() + ' ' + JSON.stringify(s));
    await o.close();
  }],
  ['What an earlier page left is not trusted: odd names, a wrong count and an old time are ignored', async function (browser) {
    var context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    var page = await context.newPage();
    await page.route('**/*', function (route) {
      var u = route.request().url();
      if (!/127\.0\.0\.1|localhost/.test(u)) return route.abort();
      if (u.indexOf(':8095/') >= 0) return route.continue({ url: u.replace(':8095/', ':' + SERVICE_PORT + '/') });
      route.continue();
    });
    var url = 'http://127.0.0.1:' + PAGE_PORT + '/hub.html';
    await page.goto(url);
    var cases = [
      [{ n: 1, at: 'now', files: ['<img src=x onerror=alert(1)>', 'logos.js', 7, 'a b.js'] }, 'logos.js loaded on a later try'],
      [{ n: 9, at: 'now', files: ['logos.js'] }, ''],
      [{ n: 1, at: 'old', files: ['logos.js'] }, ''],
      ['not json', '']
    ];
    for (var i = 0; i < cases.length; i++) {
      await page.evaluate(function (c) {
        var v = c;
        if (typeof v === 'object') { v.at = v.at === 'now' ? new Date().getTime() - 2000 : new Date().getTime() - 600000; v = JSON.stringify(v); }
        window.sessionStorage.setItem('homeHub.scripts', v);
      }, cases[i][0]);
      await page.goto(url);
      await page.waitForTimeout(1200);
      var status = await page.evaluate(function () { return window.HUB_SCRIPTS.status(); });
      assert(status === cases[i][1], 'case ' + i + ': ' + status);
    }
    await context.close();
  }]
];

(async function () {
  var preview = spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: String(SERVICE_PORT), HUB_LIVE_PORT: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  await new Promise(function (r) { setTimeout(r, 1500); });
  var browser = await playwright.chromium.launch();
  var failed = 0;
  for (var i = 0; i < CHECKS.length; i++) {
    var t = Date.now();
    try {
      await CHECKS[i][1](browser);
      console.log('ok    ' + (i + 1) + '. ' + CHECKS[i][0] + ' (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
    } catch (e) {
      failed += 1;
      console.log('FAIL  ' + (i + 1) + '. ' + CHECKS[i][0] + '\n      ' + e.message);
    }
  }
  await browser.close();
  preview.kill();
  console.log((CHECKS.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
