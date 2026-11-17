/*
 * Home Hub updates: always run the newest commit of the branch, all of it.
 *
 * TizenBrew opens the hub through its local proxy, which fetches each file
 * from jsDelivr. An address like .../gh%2Fowner%2Frepo%40main/... is cached
 * per file for up to 12 hours, so after a push the TV can get a mix of old and
 * new files. An address pinned to a commit (@<40 hex>) is always whole and
 * right. So the page TizenBrew opens (app/index.html, the "shell") only asks
 * GitHub for the branch's newest commit and moves on to that commit's hub
 * page (app/hub.html). If anything goes wrong it goes to the last commit that
 * started, or to the branch's own hub.html, which is what happened before.
 *
 * Plain ES5, loaded by both pages. On the shell (<html data-boot>) it runs
 * the boot by itself. On the hub page it arms a watchdog and waits for
 * hub.js (the last script, which calls started() as its last step):
 *
 *   - Parsing finished but no started(): hub.js or a script before it broke
 *     (a crash). It gives up at once.
 *   - After 15 s the page is still loading files (a slow connection): it
 *     waits on, checking every 5 s, up to 60 s in all.
 *   - Giving up: a small notice says why on top of the page for 12 s
 *     ("Version 0.18.1 didn't start", how long it waited, how many files had
 *     loaded, the first error), then it goes back to the last commit that
 *     started. That commit is held: 6 hours after a crash, 20 minutes after
 *     a slow start (or until a newer commit comes). The reason is kept in
 *     homeHub.release.why, so the About panel can show it after the fallback.
 *
 * The only DOM it touches is that notice.
 *
 *   HUB_UPDATE.started({ version })   hub.js has started: this commit is good
 *   HUB_UPDATE.watch({ idle, onStatus })   check for a newer commit now and then;
 *                              idle() says when a reload would bother nobody
 *   HUB_UPDATE.check()         check now (tests, and a forced check)
 *   HUB_UPDATE.restart()       load the hub again through the shell
 *   HUB_UPDATE.status()        { managed, pinned, sha, state, text, newest, checkedAt, why }
 *                              (why: when held, why that commit didn't start, else '')
 *
 * States: off (not under TizenBrew's proxy, or nothing known), current,
 * unreachable, held, notready, waiting. text is what the About panel shows for the version check.
 *
 * The commit to load only ever comes from https://api.github.com for the
 * owner, repo and branch in the page's own address. Everything read back from
 * localStorage or the network is checked before it goes into an address.
 */
(function () {
  'use strict';

  var STORE_KEY = 'homeHub.release';
  var WHY_KEY = 'homeHub.release.why';  // why the held commit didn't start (survives the fallback)
  var LOOKUP_MS = 3000;            // GitHub's answer
  var PREFLIGHT_MS = 6000;         // a commit jsDelivr hasn't seen takes a moment
  var BOOT_DEADLINE_MS = 8000;     // the shell gives up and takes the fallback
  var HOLD_MS = 6 * 3600000;       // a commit that crashed isn't tried again for this long
  var SLOW_HOLD_MS = 20 * 60000;   // one that was only slow to load, this long
  var WATCHDOG_MS = 15000;         // hub.js should call started() within this...
  var WATCHDOG_AGAIN_MS = 5000;    // ...but while files are still loading, look again this often
  var WATCHDOG_MAX_MS = 60000;     // and give up after this long in all
  var CRASH_GRACE_MS = 1000;       // parsing done and no started() this long after: it broke
  var NOTICE_MS = 12000;           // the notice stays this long before going back
  var CHECK_EVERY_MS = 15 * 60000;
  var STALE_MS = 5 * 60000;        // on becoming visible, check if the last check is older
  var IDLE_RETRY_MS = 20000;
  var DEFAULT_PAGE = 'app/hub.html';

  var TEXT = {
    unreachable: 'Updates: can\'t reach GitHub',
    held: 'Updates: a newer version didn\'t start',
    notready: 'Updates: a newer version isn\'t ready yet',
    waiting: 'Updates: a newer version is ready'
  };

  var SHA_RE = /^[0-9a-f]{40}$/;
  var NAME_RE = /^[A-Za-z0-9_.\-]+$/;
  var REF_RE = /^[A-Za-z0-9_.\-\/]+$/;
  var PAGE_RE = /^[A-Za-z0-9_\-.\/]+\.html$/;
  var VERSION_RE = /^[A-Za-z0-9_.+\-]{1,40}$/;
  var KINDS = { crash: 1, slow: 1 };

  // Tests only: window.HUB_UPDATE_TEST_SCALE (a number between 0 and 1, set
  // before this file runs) shortens the watchdog and the notice. Nothing on
  // the TV sets it.
  var SCALE = 1;
  try {
    var testScale = window.HUB_UPDATE_TEST_SCALE;
    if (typeof testScale === 'number' && testScale > 0 && testScale < 1) SCALE = testScale;
  } catch (e) { SCALE = 1; }

  /* ---------- small helpers ---------- */

  function now() { return new Date().getTime(); }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Updates: ' + text); } catch (e) { /* ignore */ }
  }

  function isSha(s) { return typeof s === 'string' && SHA_RE.test(s); }

  function isName(s) { return typeof s === 'string' && NAME_RE.test(s) && !/^\.+$/.test(s); }

  function isRef(s) {
    return typeof s === 'string' && REF_RE.test(s) && s.indexOf('..') < 0 && s.indexOf('//') < 0 &&
      s.charAt(0) !== '/' && s.charAt(s.length - 1) !== '/';
  }

  function isPage(s) {
    return typeof s === 'string' && s.length <= 200 && PAGE_RE.test(s) && s.indexOf('..') < 0 &&
      s.indexOf('//') < 0 && s.charAt(0) !== '/';
  }

  function isTime(n) { return typeof n === 'number' && isFinite(n) && n > 0; }

  function trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }

  // One line of plain text: no control characters, at most n characters.
  function plain(s) { return String(s).replace(/[\u0000-\u001f\u007f]+/g, ' '); }

  function cut(s, n) {
    s = plain(s);
    return s.length > n ? s.substring(0, Math.max(0, n - 1)) + '\u2026' : s;
  }

  function shortSha(sha) { return isSha(sha) ? sha.substring(0, 7) : ''; }

  function hiddenPage() {
    try {
      var h = document.hidden;
      if (h === undefined) h = document.webkitHidden;
      return !!h;
    } catch (e) { return false; }
  }

  function tail() {
    try { return (location.search || '') + (location.hash || ''); } catch (e) { return ''; }
  }

  /* ---------- where am I ---------- */

  // A path under TizenBrew's proxy: /module/<encodeURIComponent(module)>/<page>,
  // where module is gh/<owner>/<repo> with an optional @<ref>. Anything else
  // (the laptop preview, a file, an odd path) is "unmanaged".
  function parsePath(pathname) {
    var m = /^\/module\/([^\/]+)\/(.+)$/.exec(String(pathname || ''));
    if (!m) return null;
    var mod;
    try { mod = decodeURIComponent(m[1]); } catch (e) { return null; }
    var r = /^gh\/([^\/@]+)\/([^\/@]+)(?:@(.+))?$/.exec(mod);
    if (!r || !isName(r[1]) || !isName(r[2])) return null;
    var ref = r[3] === undefined ? '' : r[3];
    if (ref !== '' && !isRef(ref)) return null;
    return {
      owner: r[1],
      repo: r[2],
      ref: ref,
      pinned: isSha(ref),
      page: m[2],
      path: String(pathname)
    };
  }

  var here = null;
  try {
    var parsed = parsePath(location.pathname);
    if (parsed && /^https?:$/.test(location.protocol) && location.host) {
      here = parsed;
      here.origin = location.protocol + '//' + location.host;
    }
  } catch (e) { here = null; }

  var managed = !!here;
  var pinned = managed && here.pinned;
  var mySha = pinned ? here.ref : '';

  // The address of one commit's page, on this same proxy.
  function pinnedUrl(sha, page) {
    return here.origin + '/module/' + encodeURIComponent('gh/' + here.owner + '/' + here.repo + '@' + sha) + '/' + page;
  }

  // An entry (the shell's own path) is only usable for this same repo, and
  // only when it follows a branch rather than one commit.
  function entryFits(entry) {
    var e = typeof entry === 'string' && entry.length <= 400 ? parsePath(entry) : null;
    return !!e && !!here && !e.pinned && isPage(e.page) && e.owner === here.owner && e.repo === here.repo;
  }

  /* ---------- memory ---------- */

  // Reads the one key, keeping only fields that pass their checks. A record
  // without a usable entry (the shell writes one every time) is ignored whole:
  // it is from another repo, or damaged.
  function readRecord() {
    var out = {};
    var raw = null;
    try { raw = window.localStorage ? localStorage.getItem(STORE_KEY) : null; } catch (e) { raw = null; }
    if (!raw) return out;
    var data = null;
    try { data = JSON.parse(raw); } catch (e2) { return out; }
    if (!data || typeof data !== 'object' || data.v !== 1) return out;
    if (!entryFits(data.entry)) return out;
    out.entry = data.entry;
    if (isSha(data.good) && isPage(data.goodPage)) {
      out.good = data.good;
      out.goodPage = data.goodPage;
      out.goodVersion = typeof data.goodVersion === 'string' && VERSION_RE.test(data.goodVersion) ? data.goodVersion : '';
    }
    if (isSha(data.trying) && isTime(data.triedAt)) {
      out.trying = data.trying;
      out.triedAt = data.triedAt;
      // Both belong to that try; a record without them reads as before.
      if (typeof data.tryingVersion === 'string' && VERSION_RE.test(data.tryingVersion)) out.tryingVersion = data.tryingVersion;
      if (typeof data.holdKind === 'string' && KINDS.hasOwnProperty(data.holdKind)) out.holdKind = data.holdKind;
    }
    if (isSha(data.newest) && isTime(data.checkedAt)) {
      out.newest = data.newest;
      out.checkedAt = data.checkedAt;
    }
    if (typeof data.note === 'string' && TEXT.hasOwnProperty(data.note) && data.note !== 'waiting') out.note = data.note;
    return out;
  }

  // Changes some fields and writes the record back. Only under the proxy.
  function writeRecord(changes) {
    if (!managed) return;
    try {
      if (!window.localStorage) return;
      var rec = readRecord();
      for (var k in changes) {
        if (changes.hasOwnProperty(k)) rec[k] = changes[k];
      }
      var out = { v: 1 };
      var keys = ['entry', 'good', 'goodPage', 'goodVersion', 'trying', 'triedAt', 'tryingVersion', 'holdKind',
        'newest', 'checkedAt', 'note'];
      for (var i = 0; i < keys.length; i++) {
        var v = rec[keys[i]];
        if (v !== undefined && v !== null && v !== '') out[keys[i]] = v;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) {
      warn('could not save: ' + (e && e.message));
    }
  }

  // A commit that was tried lately, didn't start, and has a good one to fall
  // back on. Held 20 minutes when it was only slow, otherwise 6 hours.
  function isHeld(rec, sha) {
    if (rec.trying !== sha || !rec.good || rec.good === sha) return false;
    var age = now() - rec.triedAt;
    return age >= 0 && age < (rec.holdKind === 'slow' ? SLOW_HOLD_MS : HOLD_MS);
  }

  // Why the held commit didn't start: { sha, kind, why, text }, or null.
  function readWhy() {
    try {
      var raw = window.localStorage ? localStorage.getItem(WHY_KEY) : null;
      if (!raw || raw.length > 1000) return null;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || d.v !== 1 || !isSha(d.sha) || !KINDS.hasOwnProperty(d.kind)) return null;
      if (typeof d.why !== 'string' || d.why.length > 240) return null;
      return { sha: d.sha, kind: d.kind, why: plain(d.why), text: typeof d.text === 'string' ? plain(d.text) : '' };
    } catch (e) { return null; }
  }

  function writeWhy(sha, kind, why, text) {
    try {
      if (!managed || !window.localStorage) return;
      var data = { v: 1, sha: sha, kind: kind, why: cut(why, 200), text: text };
      var json = JSON.stringify(data);
      // At most about 400 characters: the overlay's text goes first.
      if (json.length > 400) {
        data.text = cut(text, Math.max(0, text.length - (json.length - 400) - 1));
        json = JSON.stringify(data);
      }
      localStorage.setItem(WHY_KEY, json);
    } catch (e) {
      warn('could not save why: ' + (e && e.message));
    }
  }

  /* ---------- requests ---------- */

  // cb(text) with the body of a 2xx answer, or cb(null). Never more than once,
  // and never later than ms: the proxy can hang for ever.
  function get(url, ms, accept, cb) {
    var finished = false;
    var xhr = null;
    var timer = null;
    function done(text) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { cb(text); } catch (e) { warn('a reply handler failed: ' + (e && e.message)); }
    }
    timer = setTimeout(function () {
      try { if (xhr) xhr.abort(); } catch (e) { /* ignore */ }
      done(null);
    }, ms + 500);
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = ms;
      if (accept) xhr.setRequestHeader('Accept', accept);
      xhr.onload = function () {
        done(xhr.status >= 200 && xhr.status < 300 ? String(xhr.responseText || '') : null);
      };
      xhr.onerror = function () { done(null); };
      xhr.ontimeout = function () { done(null); };
      xhr.onabort = function () { done(null); };
      xhr.send(null);
    } catch (e) {
      setTimeout(function () { done(null); }, 0);
    }
  }

  // The branch's newest commit from GitHub: cb(sha) or cb('') when unreachable.
  function lookup(ref, cb) {
    var url = 'https://api.github.com/repos/' + here.owner + '/' + here.repo + '/commits/' + (ref || 'HEAD');
    get(url, LOOKUP_MS, 'application/vnd.github.sha', function (text) {
      if (text === null) return cb('');
      var t = trim(text);
      if (isSha(t)) return cb(t);
      try {
        var data = JSON.parse(t);
        if (data && typeof data === 'object' && isSha(data.sha)) return cb(data.sha);
      } catch (e) { /* not JSON */ }
      cb('');
    });
  }

  // Can jsDelivr serve this commit? Its package.json must parse and carry a
  // version. cb({ page, legacy, version }) or cb(null).
  function preflight(sha, cb) {
    get(pinnedUrl(sha, 'package.json'), PREFLIGHT_MS, null, function (text) {
      if (text === null) return cb(null);
      var data = null;
      try { data = JSON.parse(text); } catch (e) { return cb(null); }
      if (!data || typeof data !== 'object' || typeof data.version !== 'string') return cb(null);
      // Made before this file existed: its index.html is the whole hub.
      var legacy = typeof data.hubPage !== 'string';
      var page = legacy ? data.appPath : data.hubPage;
      if (!isPage(page)) page = DEFAULT_PAGE;
      cb({ page: page, legacy: legacy, version: VERSION_RE.test(data.version) ? data.version : '' });
    });
  }

  /* ---------- leaving ---------- */

  var leaving = false;

  // The one navigation this page will ever start. replace(), so Back never
  // comes back here.
  function go(url) {
    if (leaving) return;
    leaving = true;
    try {
      location.replace(url);
    } catch (e) {
      try { location.href = url; } catch (e2) { warn('could not leave: ' + (e2 && e2.message)); }
    }
  }

  /* ---------- the shell ---------- */

  function boot() {
    if (!managed || pinned) {
      go('hub.html' + tail());
      return;
    }
    var rec = readRecord();
    // A record from another branch or repo doesn't apply here: start afresh.
    if (rec.entry !== here.path) {
      rec = {};
      writeRecord({ entry: here.path, good: '', goodPage: '', goodVersion: '', trying: '', triedAt: '',
        tryingVersion: '', holdKind: '', newest: '', checkedAt: '', note: '' });
    }
    var phase = 'unreachable';

    function fallback(note) {
      if (leaving) return;
      writeRecord({ entry: here.path, note: note });
      if (rec.good) go(pinnedUrl(rec.good, rec.goodPage) + tail());
      else go('hub.html' + tail());
    }

    setTimeout(function () {
      try { fallback(phase); } catch (e) { go('hub.html' + tail()); }
    }, BOOT_DEADLINE_MS);

    lookup(here.ref, function (n) {
      if (leaving) return;
      if (!n) return fallback('unreachable');
      writeRecord({ entry: here.path, newest: n, checkedAt: now() });
      if (n === rec.good) {
        writeRecord({ note: '' });
        go(pinnedUrl(rec.good, rec.goodPage) + tail());
        return;
      }
      if (isHeld(rec, n)) return fallback('held');
      phase = 'notready';
      preflight(n, function (info) {
        if (leaving) return;
        if (!info) return fallback('notready');
        var changes = { trying: n, triedAt: now(), tryingVersion: info.version, holdKind: '', note: '' };
        if (info.legacy) {
          // It can never report in, so it counts as good straight away.
          changes.good = n;
          changes.goodPage = info.page;
          changes.goodVersion = info.version;
        }
        writeRecord(changes);
        go(pinnedUrl(n, info.page) + tail());
      });
    });
  }

  /* ---------- the hub page ---------- */

  var startedCalled = false;
  var watchdog = null;
  var watching = null;          // { idle, onStatus } once watch() is called
  var state = 'off';
  var checkedAt = 0;
  var checking = false;
  var checkTimer = null;
  var idleTimer = null;
  var checkGen = 0;

  function status() {
    return {
      managed: managed,
      pinned: pinned,
      sha: mySha,
      state: state,
      text: TEXT[state] || '',
      newest: state === 'current',
      checkedAt: checkedAt,
      why: state === 'held' ? heldWhy() : ''
    };
  }

  // Why the held commit didn't start, when the stored reason is about it.
  function heldWhy() {
    try {
      var w = readWhy();
      if (!w) return '';
      var rec = readRecord();
      return rec.trying === w.sha ? w.why : '';
    } catch (e) { return ''; }
  }

  function setState(next) {
    if (next === state) return;
    state = next;
    if (watching && typeof watching.onStatus === 'function') {
      try { watching.onStatus(status()); } catch (e) { warn('a status listener failed: ' + (e && e.message)); }
    }
  }

  // What the shell found, until this page's own first check.
  function stateFromRecord() {
    if (!managed) return;
    var rec = readRecord();
    if (rec.checkedAt) checkedAt = rec.checkedAt;
    if (rec.note) state = rec.note;
    else if (pinned && rec.newest === mySha) state = 'current';
  }

  // The branch this page follows: its own, or the stored shell's for a pinned page.
  function followedRef() {
    if (!managed) return null;
    if (!pinned) return here.ref;
    var rec = readRecord();
    if (!rec.entry) return null;
    var e = parsePath(rec.entry);
    return e ? e.ref : null;
  }

  /* ---------- the watchdog ---------- */

  var armedAt = 0;
  var givingUp = false;
  var errors = [];              // the first few errors on this page, as text

  // The part of an address worth showing: app/hub.js, not the whole proxy path.
  function fileOf(url) {
    var u = String(url || '').split('?')[0].split('#')[0];
    var m = /\/module\/[^\/]+\/(.+)$/.exec(u);
    return cut(m ? m[1] : u.substring(u.lastIndexOf('/') + 1), 60);
  }

  // Script errors, and scripts or stylesheets that failed to load. Capture
  // phase, so a failed file (which doesn't bubble) is seen too.
  function onError(e) {
    try {
      if (errors.length >= 3 || startedCalled) return;
      var t = e && e.target;
      var text = '';
      if (t && t !== window && t.tagName) {
        var tag = String(t.tagName).toUpperCase();
        if (tag !== 'SCRIPT' && tag !== 'LINK') return;   // a picture that failed doesn't stop the hub
        text = 'could not load ' + fileOf(t.src || t.href);
      } else {
        text = String((e && e.message) || 'error');
        if (e && e.filename) text += ' (' + fileOf(e.filename) + (e.lineno ? ' line ' + e.lineno : '') + ')';
      }
      errors.push(cut(text, 120));
    } catch (err) { /* ignore */ }
  }

  function stillParsing() {
    try { return document.readyState === 'loading'; } catch (e) { return false; }
  }

  // How far loading got: { loaded, of, waitingFor } from the resource timings
  // and the scripts and stylesheets in the page so far. Null when unknown.
  function filesSoFar() {
    try {
      if (!window.performance || typeof performance.getEntriesByType !== 'function') return null;
      var done = {};
      var list = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < list.length; i++) done[String(list[i].name).split('#')[0]] = true;
      var els = document.querySelectorAll('script[src], link[rel="stylesheet"][href]');
      var loaded = 0;
      var waitingFor = '';
      for (var j = 0; j < els.length; j++) {
        var url = els[j].src || els[j].href;
        if (done[url]) loaded += 1;
        else if (!waitingFor) waitingFor = fileOf(url);
      }
      return { loaded: loaded, of: els.length, waitingFor: waitingFor };
    } catch (e) { return null; }
  }

  // A script of the page failed to load and is being fetched again, or the
  // page is about to load again for it (hub.html, HUB_SCRIPTS): no verdict yet.
  function scriptsPending() {
    try {
      var S = window.HUB_SCRIPTS;
      return !!S && typeof S.pending === 'function' && S.pending() === true;
    } catch (e) { return false; }
  }

  function secs(ms) { return Math.max(1, Math.round(ms / 1000)) + ' s'; }

  // The notice: a few lines of large text, drawn once, no animation, above
  // everything, never in the way of a click.
  function showNotice(lines) {
    try {
      var host = document.body || document.documentElement;
      if (!host) return;
      var box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;left:50%;top:50%;width:62vw;max-width:62vw;box-sizing:border-box;' +
        'transform:translate(-50%,-50%);-webkit-transform:translate(-50%,-50%);z-index:2147483000;' +
        'pointer-events:none;padding:2.2vw 2.6vw;border-radius:1.6vw;background:rgba(10,12,16,0.95);' +
        'border:0.12vw solid rgba(255,255,255,0.28);color:#f4f5f7;text-align:left;' +
        'font-family:"SamsungOne","Samsung Sans","Helvetica Neue",Arial,sans-serif;' +
        'font-size:1.45vw;line-height:1.45;font-weight:400;word-wrap:break-word;overflow-wrap:break-word;white-space:normal';
      for (var i = 0; i < lines.length; i++) {
        var p = document.createElement('div');
        p.textContent = lines[i];
        p.style.cssText = i === 0 ? 'font-size:2.1vw;font-weight:600;line-height:1.35;margin:0 0 0.9vw 0' : 'margin:0.35vw 0 0 0;color:#d6d9df';
        box.appendChild(p);
      }
      host.appendChild(box);
    } catch (e) { warn('could not show the notice: ' + (e && e.message)); }
  }

  // This commit didn't start: say why, remember it, go back to the good one.
  function giveUp(kind) {
    if (givingUp || startedCalled || leaving) return;
    var rec = readRecord();
    if (!rec.good || rec.good === mySha) return;   // nothing to go back to
    givingUp = true;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    var waited = now() - armedAt;
    var files = filesSoFar();
    var name = rec.trying === mySha && rec.tryingVersion ? rec.tryingVersion : shortSha(mySha);
    var goodName = rec.goodVersion || shortSha(rec.good);
    var lines = ['Version ' + name + ' didn\'t start'];
    var why;
    if (kind === 'slow') {
      lines.push('It was still loading after ' + secs(waited) + '.');
      why = 'still loading after ' + secs(waited);
    } else {
      lines.push('It broke while starting (after ' + secs(waited) + ').');
      why = errors.length ? 'error: ' + errors[0] : 'broke while starting';
    }
    if (files) {
      if (files.waitingFor && stillParsing()) {
        lines.push(files.loaded + ' of ' + files.of + ' files had loaded so far; still waiting for ' + files.waitingFor + '.');
        if (kind === 'slow') why += ', waiting for ' + files.waitingFor;
      } else {
        lines.push(files.loaded + ' of ' + files.of + ' files had loaded.');
      }
    }
    if (errors.length) lines.push('Error: ' + errors[0]);
    lines.push('Going back to version ' + goodName + ' in ' + secs(NOTICE_MS) + '.');
    lines.push(kind === 'slow' ? 'It will be tried again in 20 minutes, or when a newer version comes.'
      : 'It will be tried again in 6 hours, or when a newer version comes.');
    warn('version ' + name + ' did not start (' + why + '); going back to ' + goodName);

    var changes = { note: 'held', holdKind: kind };
    if (rec.trying !== mySha) {
      changes.trying = mySha;
      changes.triedAt = now();
      changes.tryingVersion = '';
    }
    writeRecord(changes);
    writeWhy(mySha, kind, name + ': ' + why, lines.join(' '));
    showNotice(lines);
    var back = pinnedUrl(rec.good, rec.goodPage) + tail();
    setTimeout(function () {
      try { go(back); } catch (e) { warn('could not go back: ' + (e && e.message)); }
    }, NOTICE_MS * SCALE);
  }

  function watchdogFires() {
    watchdog = null;
    try {
      if (startedCalled || leaving || givingUp) return;
      // Still waiting for files: a slow connection, not a broken build. Wait on, up to a limit.
      if ((stillParsing() || scriptsPending()) && now() - armedAt < WATCHDOG_MAX_MS * SCALE) {
        watchdog = setTimeout(watchdogFires, WATCHDOG_AGAIN_MS * SCALE);
        return;
      }
      giveUp(stillParsing() && !errors.length ? 'slow' : 'crash');
    } catch (e) {
      warn('watchdog failed: ' + (e && e.message));
    }
  }

  // Every script has run once parsing is done; hub.js reports at its end.
  // Unless one of them failed to load and is being fetched again: then the
  // page loads again when it comes, and this looks again until that is over.
  function onParsed() {
    try {
      if (startedCalled || givingUp || leaving) return;
      var verdict = function () {
        try {
          if (startedCalled || givingUp || leaving) return;
          if (scriptsPending() && now() - armedAt < WATCHDOG_MAX_MS * SCALE) {
            setTimeout(verdict, CRASH_GRACE_MS * SCALE);
            return;
          }
          giveUp('crash');
        } catch (e) { warn('watchdog failed: ' + (e && e.message)); }
      };
      setTimeout(verdict, CRASH_GRACE_MS * SCALE);
    } catch (e) { /* ignore */ }
  }

  function armWatchdog() {
    if (!pinned) return;
    armedAt = now();
    try { window.addEventListener('error', onError, true); } catch (e) { /* ignore */ }
    try {
      if (stillParsing()) document.addEventListener('DOMContentLoaded', onParsed, false);
      else onParsed();
    } catch (e2) { /* the timer below still runs */ }
    watchdog = setTimeout(watchdogFires, WATCHDOG_MS * SCALE);
  }

  function started(info) {
    try {
      if (startedCalled || givingUp) return;    // too late once the notice is up
      startedCalled = true;
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      if (!pinned) return;
      var rec = readRecord();
      // Without the shell's record (opened by its pinned address, or no
      // storage) there is nothing to keep this in.
      if (!rec.entry) return;
      var version = info && typeof info.version === 'string' && VERSION_RE.test(info.version) ? info.version : '';
      var changes = { good: mySha, goodPage: isPage(here.page) ? here.page : DEFAULT_PAGE, goodVersion: version };
      // Only this commit's own try is over; a newer one that failed stays held.
      if (rec.trying === mySha) {
        changes.trying = '';
        changes.triedAt = '';
        changes.tryingVersion = '';
        changes.holdKind = '';
      }
      writeRecord(changes);
    } catch (e) {
      warn('started failed: ' + (e && e.message));
    }
  }

  function clearTimers() {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleCheck() {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(function () {
      checkTimer = null;
      if (hiddenPage()) return;     // checked again on becoming visible
      check();
    }, CHECK_EVERY_MS);
  }

  function isIdle() {
    if (hiddenPage()) return false;
    try {
      return !!(watching && typeof watching.idle === 'function' && watching.idle());
    } catch (e) {
      return false;
    }
  }

  // Wait for a quiet moment, then move to the newer commit.
  function goWhenIdle(sha, page, legacy, version, myGen) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (myGen !== checkGen || leaving) return;
    if (!isIdle()) {
      idleTimer = setTimeout(function () {
        idleTimer = null;
        goWhenIdle(sha, page, legacy, version, myGen);
      }, IDLE_RETRY_MS);
      return;
    }
    var rec = readRecord();
    if (sha !== rec.good) {
      var changes = { trying: sha, triedAt: now(), tryingVersion: version, holdKind: '', note: '' };
      if (legacy) {
        changes.good = sha;
        changes.goodPage = page;
        changes.goodVersion = version;
      }
      writeRecord(changes);
    } else {
      writeRecord({ note: '' });
    }
    go(pinnedUrl(sha, page) + tail());
  }

  function check() {
    try {
      if (!watching || !managed || leaving || checking) return;
      var ref = followedRef();
      if (ref === null) return;
      clearTimers();
      checkGen += 1;
      var myGen = checkGen;
      checking = true;
      lookup(ref, function (n) {
        checking = false;
        if (myGen !== checkGen || leaving) return;
        checkedAt = now();
        scheduleCheck();
        if (!n) {
          setState('unreachable');
          return;
        }
        writeRecord({ newest: n, checkedAt: checkedAt });
        if (pinned && n === mySha) {
          setState('current');
          return;
        }
        var rec = readRecord();
        if (isHeld(rec, n)) {
          setState('held');
          return;
        }
        if (n === rec.good) {
          // Known to start: no need to ask jsDelivr first.
          setState('waiting');
          goWhenIdle(n, rec.goodPage, false, rec.goodVersion, myGen);
          return;
        }
        preflight(n, function (info) {
          if (myGen !== checkGen || leaving) return;
          if (!info) {
            setState('notready');
            return;
          }
          setState('waiting');
          goWhenIdle(n, info.page, info.legacy, info.version, myGen);
        });
      });
    } catch (e) {
      checking = false;
      warn('check failed: ' + (e && e.message));
    }
  }

  function onVisible() {
    if (hiddenPage() || !watching) return;
    if (now() - checkedAt > STALE_MS) check();
  }

  function watch(options) {
    try {
      if (watching || !managed) return;
      watching = {
        idle: options && options.idle,
        onStatus: options && options.onStatus
      };
      if (followedRef() === null) return;
      try {
        document.addEventListener('visibilitychange', onVisible, false);
        document.addEventListener('webkitvisibilitychange', onVisible, false);
      } catch (e) { /* ignore */ }
      scheduleCheck();
    } catch (e2) {
      warn('could not watch: ' + (e2 && e2.message));
    }
  }

  function restart() {
    try {
      var rec = readRecord();
      if (managed && rec.entry) {
        go(rec.entry + tail());
        return;
      }
    } catch (e) { /* fall through */ }
    if (leaving) return;
    leaving = true;
    try { location.reload(); } catch (e2) { warn('could not reload: ' + (e2 && e2.message)); }
  }

  window.HUB_UPDATE = {
    started: started,
    watch: watch,
    check: check,
    restart: restart,
    status: status
  };

  /* ---------- start ---------- */

  var isShell = false;
  try { isShell = document.documentElement.hasAttribute('data-boot'); } catch (e) { isShell = false; }

  if (isShell) {
    try {
      boot();
    } catch (e) {
      warn('boot failed: ' + (e && e.message));
      go('hub.html' + tail());
    }
  } else {
    try {
      stateFromRecord();
      armWatchdog();
    } catch (e) {
      warn('could not start: ' + (e && e.message));
    }
  }
})();
