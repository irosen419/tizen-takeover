'use strict';
// The one place the dev tests get the hub's version from: package.json.
// `node dev/bump.js` (run at merge, never in a PR) edits package.json, package-lock.json, app/hub.js (BUILD), service.js (VERSION)
// and the README example; the tests follow by themselves.
// dev/version-test.js checks that those places agree.
const pkg = require('../package.json');
const VERSION = pkg.version;
const VERSION_RE = VERSION.replace(/\./g, '\\.');
module.exports = { VERSION: VERSION, VERSION_RE: VERSION_RE };
