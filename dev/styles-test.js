/*
 * Stylesheets that arrive broken are fetched again: node dev/styles-test.js
 *
 * Starts the preview on its own ports and breaks app/widgets/weather.css on
 * the way to the page (failed, cut short, empty), the way TizenBrew's proxy
 * sometimes does on the TV. STYLES_TEST_SHOTS=dir keeps screenshots.
 */
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var playwright = require('playwright');

var PAGE_PORT = 8390;
var SERVICE_PORT = 8395;
var SHOTS = process.env.STYLES_TEST_SHOTS || '';
var CSS = fs.readFileSync(path.join(__dirname, '..', 'app', 'widgets', 'weather.css'), 'utf8');

function assert(ok, text) { if (!ok) throw new Error(text); }

// kind: fail | cut | empty; times: how many fetches of weather.css break (Infinity = all).
async function open(browser, kind, times, file) {
  var which = new RegExp('widgets/' + (file || 'weather') + '\\.css');
  var page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  var seen = 0;
  await page.route('**/*', function (route) {
    var u = route.request().url();
    if (!/127\.0\.0\.1|localhost/.test(u)) return route.abort();
    if (which.test(u)) {
      seen += 1;
      if (seen <= times) {
        if (kind === 'fail') return route.abort();
        if (kind === 'empty') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        return route.fulfill({ status: 200, contentType: 'text/css', body: CSS.slice(0, 9000) });
      }
    }
    if (u.indexOf(':8095/') >= 0) return route.continue({ url: u.replace(':8095/', ':' + SERVICE_PORT + '/') });
    route.continue();
  });
  await page.goto('http://127.0.0.1:' + PAGE_PORT + '/hub.html');
  return { page: page, fetches: function () { return seen; } };
}

function look(page) {
  return page.evaluate(function () {
    var tile = document.querySelector('[data-widget="weather"]');
    // The weather drawing itself (the tile head's icon is sized by style.css).
    var svg = tile ? tile.querySelector('.tile-body svg') : null;
    var a = tile.getBoundingClientRect();
    var b = svg ? svg.getBoundingClientRect() : null;
    return {
      status: window.HUB_STYLES.status(),
      inside: !!b && b.bottom <= a.bottom + 1 && b.right <= a.right + 1,
      links: document.querySelectorAll('link[rel="stylesheet"]').length,
      order: Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        return (l.getAttribute('data-file') || l.getAttribute('href')).split('?')[0];
      }).join(' ')
    };
  });
}

var ORDER = 'style.css widgets/today.css widgets/todo.css widgets/weather.css widgets/calendar.css widgets/nowplaying.css widgets/nowplaying-band.css widgets/awws.css widgets/wotd.css widgets/budget.css widgets/shows.css widgets/soundctl.css widgets/sunpath.css widgets/budget-lab.css widgets/ambience.css widgets/architecture.css widgets/investments.css widgets/spending.css widgets/grocery.css widgets/pantry.css widgets/pantry-tv.css widgets/photos.css pin.css agents.css theme.css tablet.css';

var CHECKS = [
  ['Every stylesheet ends with the .css-end rule', async function () {
    var dir = path.join(__dirname, '..', 'app');
    var files = ORDER.split(' ');
    for (var i = 0; i < files.length; i++) {
      var text = fs.readFileSync(path.join(dir, files[i]), 'utf8').replace(/\s+$/, '');
      assert(/\.css-end \{ top: 0; \}$/.test(text), files[i] + ' does not end with .css-end');
    }
  }],
  ['A clean load fetches nothing twice and says nothing', async function (browser) {
    var o = await open(browser, 'fail', 0);
    await o.page.waitForTimeout(6500);
    var s = await look(o.page);
    assert(o.fetches() === 1, 'fetches: ' + o.fetches());
    assert(s.status === '' && s.inside && s.links === ORDER.split(' ').length && s.order === ORDER, JSON.stringify(s));
    await o.page.close();
  }],
  ['A failed stylesheet is fetched again and the tile is drawn properly', async function (browser) {
    var o = await open(browser, 'fail', 3);
    await o.page.waitForTimeout(1200);
    if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'styles-1-broken.png') });
    var before = await look(o.page);
    assert(!before.inside, 'the tile should be broken before the retry');
    await o.page.waitForTimeout(5000);
    var s = await look(o.page);
    if (SHOTS) await o.page.screenshot({ path: path.join(SHOTS, 'styles-2-mended.png') });
    assert(o.fetches() === 4, 'fetches: ' + o.fetches());
    assert(s.inside && s.links === ORDER.split(' ').length && s.order === ORDER, JSON.stringify(s));
    assert(s.status === 'widgets/weather.css loaded on a later try', s.status);
    await o.page.close();
  }],
  ['A stylesheet cut short is fetched again', async function (browser) {
    var o = await open(browser, 'cut', 1);
    await o.page.waitForTimeout(6500);
    var s = await look(o.page);
    assert(o.fetches() === 2 && s.inside && s.links === ORDER.split(' ').length, o.fetches() + ' ' + JSON.stringify(s));
    assert(s.status === 'widgets/weather.css loaded on a later try', s.status);
    await o.page.close();
  }],
  ['An empty stylesheet is fetched again', async function (browser) {
    var o = await open(browser, 'empty', 1);
    await o.page.waitForTimeout(6500);
    var s = await look(o.page);
    assert(o.fetches() === 2 && s.inside && s.links === ORDER.split(' ').length, o.fetches() + ' ' + JSON.stringify(s));
    await o.page.close();
  }],
  ['Any stylesheet is covered: the Now Playing one fails twice and is fetched again', async function (browser) {
    var o = await open(browser, 'fail', 2, 'nowplaying');
    await o.page.waitForTimeout(6500);
    var s = await look(o.page);
    assert(o.fetches() === 3 && s.links === ORDER.split(' ').length && s.order === ORDER, o.fetches() + ' ' + JSON.stringify(s));
    assert(s.status === 'widgets/nowplaying.css loaded on a later try', s.status);
    await o.page.close();
  }],
  ['A stylesheet that never arrives: four fetches, then the About panel says so', async function (browser) {
    var o = await open(browser, 'fail', Infinity);
    await o.page.waitForTimeout(9000);
    var s = await look(o.page);
    assert(o.fetches() === 4, 'fetches: ' + o.fetches());
    assert(s.status === 'widgets/weather.css did not load' && s.links === ORDER.split(' ').length, JSON.stringify(s));
    await o.page.close();
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
