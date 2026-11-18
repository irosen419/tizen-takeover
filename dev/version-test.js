'use strict';
// The version lives in package.json (dev tests read it from there). This
// checks the three other places that must say the same: BUILD in app/hub.js,
// VERSION in service.js, and the version in the README example line.
const fs = require('fs');
const path = require('path');
const V = require('./version');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let bad = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) bad++; }

const build = (read('app/hub.js').match(/var BUILD = 'v([^']+)'/) || [])[1];
const svc = (read('service.js').match(/var VERSION = '([^']+)'/) || [])[1];
const readme = (read('README.md').match(/\*\*Version\*\* \(for example `v([^ `]+) \(newest\)`/) || [])[1];
check('app/hub.js BUILD is ' + V.VERSION + ' (found ' + build + ')', build === V.VERSION);
check('service.js VERSION is ' + V.VERSION + ' (found ' + svc + ')', svc === V.VERSION);
check('README example is ' + V.VERSION + ' (found ' + readme + ')', readme === V.VERSION);
if (bad) { console.log(bad + ' failed'); process.exit(1); }
console.log('version-test: all passed');
