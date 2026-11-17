/*
 * Two small helpers for the server's recent log lines (GET /api/log, ./hub log
 * and the mailbox's log.tail):
 *
 *   level(text)            'error' or 'info' for one log line
 *   scrub(text, secrets)   the line with addresses and names taken out, for
 *                          anything that leaves the Pi
 *
 * Both are pure: no files, no network. Node 14 or newer, no npm packages.
 */
'use strict';

const MAX_SCRUBBED = 300;
const MIN_SECRET = 3;

// Words that mean something went wrong. Lines from every pi/*.js file were
// checked against this list (see the level tests in test.js).
const ERROR_RE = new RegExp([
  '\\berror\\b', 'could not', 'cannot', 'failed', 'damaged', 'unexpected', 'rejected', 'no longer good',
  'not a known', 'already in use', 'timed out', 'did not', 'refused', '\\bskipped\\b', '\\bmissing\\b',
  'must be', 'not a number', 'larger than', 'interrupted', 'does not look right', 'slow down', 'no token set'
].join('|'), 'i');

// Good news that happens to use one of the words above.
const INFO_RE = /^Claude mailbox: connected again\b|^screen (dis)?connected\b/i;

// "control GET /api/status -> 200 ..." and "Claude mailbox: todo.add (id) -> ok".
const CONTROL_RE = /^control \S+ \S+ -> (\d{3})\b/;
const MAILBOX_RE = /^Claude mailbox: \S+ \([^)]*\) -> (ok|failed)$/;

function level(text) {
  const t = String(text || '');
  const c = CONTROL_RE.exec(t);
  if (c) return Number(c[1]) >= 400 ? 'error' : 'info';
  const m = MAILBOX_RE.exec(t);
  if (m) return m[1] === 'failed' ? 'error' : 'info';
  if (INFO_RE.test(t)) return 'info';
  return ERROR_RE.test(t) ? 'error' : 'info';
}

// IPv6-looking: two or more colons between hex groups, ending in a group or a
// dotted IPv4 part (::ffff:192.168.1.5), with an optional %eth0. Kept only when
// it has "::", seven colons, or an IPv4 end, so a time like 15:10:00 stays.
const IPV6_RE = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[\w.-]+)?(?![\w:])/gi;
const IPV4_RE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w]|\.\d)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// secrets: names to hide (calendar names, the Spotify name, the bucket and
// its host). Shorter than 3 characters is skipped: it would hide too much.
function scrub(text, secrets) {
  let t = String(text === undefined || text === null ? '' : text);
  const list = (Array.isArray(secrets) ? secrets : [])
    .filter((s) => typeof s === 'string' && s.trim().length >= MIN_SECRET)
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length);
  if (list.length) t = t.replace(new RegExp(list.map(escapeRe).join('|'), 'gi'), '[name]');
  t = t.replace(IPV6_RE, (m) => {
    const colons = (m.match(/:/g) || []).length;
    return m.indexOf('::') >= 0 || colons >= 7 || /\d\.\d/.test(m) ? '[address]' : m;
  });
  t = t.replace(IPV4_RE, '[address]');
  const chars = Array.from(t);
  return chars.length > MAX_SCRUBBED ? chars.slice(0, MAX_SCRUBBED).join('') : t;
}

module.exports = { level: level, scrub: scrub, MAX_SCRUBBED: MAX_SCRUBBED };
