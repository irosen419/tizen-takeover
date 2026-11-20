/*
 * news.js: the newest NPR News Now newscast, for ./hub news and the mailbox's
 * "news". NPR posts a five minute newscast every hour to a public podcast
 * feed; this reads the feed and hands back the newest episode's title and
 * audio address, which the TV plays with the "play" command.
 *
 * The feed also carries an old "NPR News: Trailer" item, so the newest is
 * picked by pubDate, never by position.
 */
'use strict';

const https = require('https');
const http = require('http');

const FEED_URL = 'https://feeds.npr.org/500005/podcast.xml';
const SHOW_NAME = 'NPR News Now';
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

function decode(s) {
  return String(s)
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? decode(m[1]) : '';
}

// Every episode in the feed that has an http(s) audio address and a date,
// newest first.
function episodes(xml) {
  const items = String(xml).match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  const out = [];
  items.forEach((block) => {
    const enc = block.match(/<enclosure\b[^>]*\burl\s*=\s*"([^"]+)"/);
    const url = enc ? decode(enc[1]) : '';
    const when = Date.parse(tag(block, 'pubDate'));
    if (!/^https?:\/\//i.test(url) || !isFinite(when)) return;
    out.push({ title: tag(block, 'title'), url: url, published: new Date(when).toISOString() });
  });
  out.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return out;
}

function newest(xml) {
  return episodes(xml)[0] || null;
}

// The title the TV shows, such as "NPR News Now, 7pm ET, November 19".
function playTitle(ep) {
  return ep.title ? SHOW_NAME + ', ' + ep.title : SHOW_NAME;
}

function fetchText(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const lib = /^https:/i.test(url) ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'home-hub/1 (+podcast reader)' }, timeout: TIMEOUT_MS }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('the news feed redirected too many times'));
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('the news feed answered ' + code));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_FEED_BYTES) { req.destroy(new Error('the news feed is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the news feed did not answer in time')));
    req.on('error', reject);
  });
}

// { title, url, published } of the newest newscast. The feed address can be
// changed with NEWS_FEED_URL (the tests point it at a local stand-in).
async function latest(feedUrl) {
  const xml = await fetchText(feedUrl || process.env.NEWS_FEED_URL || FEED_URL);
  const ep = newest(xml);
  if (!ep) throw new Error('the news feed has no episode to play');
  return ep;
}

module.exports = { FEED_URL: FEED_URL, SHOW_NAME: SHOW_NAME, episodes: episodes, newest: newest, playTitle: playTitle, latest: latest, fetchText: fetchText };
