/*
 * Tests for the NPR News Now reader (news.js), ./hub news's words and the
 * mailbox's play, stop and news. Run from the repo root:
 *
 *   node pi/news-test.js
 *
 * The feed is a stand-in on 127.0.0.1 serving pi/fixtures/npr-news-now.xml
 * (nothing reaches the internet). It prints one line per check, then
 * "N passed, 0 failed".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const news = require('./news');
const hubctl = require('./hubctl');

const XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'npr-news-now.xml'), 'utf8');
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
}

function standIn() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/feed.xml') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(XML); return; }
    if (req.url === '/moved') { res.writeHead(302, { location: '/feed.xml' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (req.url === '/empty.xml') { res.writeHead(200); res.end('<rss><channel></channel></rss>'); return; }
    res.writeHead(500); res.end('down');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({ base: base, hits: () => hits, close: () => new Promise((r) => server.close(r)) });
  }));
}

async function main() {
  await check('the newest episode is picked by date, not position; the trailer and no-audio items are skipped', () => {
    const list = news.episodes(XML);
    assert.deepStrictEqual(list.map((e) => e.title), ['7pm ET, November 19', '6pm ET, November 19', 'NPR News: Trailer']);
    assert.deepStrictEqual(news.newest(XML), { title: '7pm ET, November 19', url: 'https://example.test/seven.mp3', published: '2026-11-20T00:09:35.000Z' });
  });

  await check('the same-every-hour "| The latest headlines from NPR" is dropped from the title', () => {
    assert.strictEqual(news.newest(XML).title, '7pm ET, November 19');
  });

  await check('CDATA titles and &amp; in addresses are decoded', () => {
    const six = news.episodes(XML)[1];
    assert.strictEqual(six.title, '6pm ET, November 19');
    assert.strictEqual(six.url, 'https://example.test/six.mp3?a=1&b=2');
  });

  await check('an empty or broken feed has no newest episode', () => {
    assert.strictEqual(news.newest('<rss><channel></channel></rss>'), null);
    assert.strictEqual(news.newest('not xml at all'), null);
    assert.deepStrictEqual(news.episodes('<item><title>x</title><enclosure url="javascript:alert(1)"/><pubDate>Fri, 20 Nov 2026 00:09:35 +0000</pubDate></item>'), []);
  });

  await check('the title on the TV and the line ./hub news prints', () => {
    const ep = news.newest(XML);
    assert.strictEqual(news.playTitle(ep), 'NPR News Now, 7pm ET, November 19');
    assert.strictEqual(news.playTitle({ title: '', url: 'https://x/' }), 'NPR News Now');
    assert.deepStrictEqual(hubctl.newsPlay(ep), { url: 'https://example.test/seven.mp3', title: 'NPR News Now, 7pm ET, November 19' });
    assert.strictEqual(hubctl.newsText(ep, { delivered: 1 }), 'NPR News Now, 7pm ET, November 19. Sent. 1 screen showed it.');
  });

  const feed = await standIn();
  await check('latest() reads the feed, following a redirect', async () => {
    assert.strictEqual((await news.latest(feed.base + '/feed.xml')).title, '7pm ET, November 19');
    assert.strictEqual((await news.latest(feed.base + '/moved')).title, '7pm ET, November 19');
  });

  await check('latest() says plainly when the feed is down, loops or is empty', async () => {
    await assert.rejects(news.latest(feed.base + '/down'), /answered 500/);
    await assert.rejects(news.latest(feed.base + '/loop'), /redirected too many times/);
    await assert.rejects(news.latest(feed.base + '/empty.xml'), /no episode to play/);
  });

  await check('NEWS_FEED_URL points latest() at another feed', async () => {
    const before = process.env.NEWS_FEED_URL;
    process.env.NEWS_FEED_URL = feed.base + '/feed.xml';
    try {
      assert.strictEqual((await news.latest()).url, 'https://example.test/seven.mp3');
    } finally {
      if (before === undefined) delete process.env.NEWS_FEED_URL; else process.env.NEWS_FEED_URL = before;
    }
  });
  await feed.close();

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
