/*
 * The Pi's host name or address as app/config.js names it (HUB_PI), for the
 * browser suites' blocked-host lists, so no test file carries the real
 * address. Falls back to a name that never resolves.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let host = 'hub-pi.invalid';
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'config.js'), 'utf8');
  const m = /var HUB_PI = '[a-z]+:\/\/([^':\/]+)/.exec(src);
  if (m) host = m[1];
} catch (e) { /* keep the fallback */ }

module.exports = host;
