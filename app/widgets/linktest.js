/*
 * Watch link test: which deep links open a show straight in its app on this
 * TV. Opened from the About panel (Left on a left-most tile, then OK on
 * "Watch link test"); drawn in the Entertainment panel.
 *
 * Each recipe (HUB_CONFIG.widgets.entertainment.linkTests.recipes) is one
 * app control: an operation, an optional URI and one optional data key and
 * value, sent to an app found by name the way Entertainment finds apps. OK
 * fires it; back in the hub, three buttons ask what happened: "Opened the
 * title", "Only opened the app" or "Nothing". The answers are kept on the TV
 * (localStorage homeHub.linkTests) and sent to the Pi (POST /linktests), where
 * ./hub linktests and the mailbox's linktests.show read them.
 *
 * {name} in a recipe is filled from linkTests.ids. The ids named in
 * linkTests.editable (the Prime title id by default) also get a text box at
 * the top of the list; what is typed there is kept on this TV and wins over
 * config.js. A recipe still holding a <placeholder> says "needs id" and
 * never fires. Plain ES5. English only:
 * it is a tool for the owner and Claude, not part of the everyday screen.
 */
(function () {
  'use strict';

  var KEY = 'homeHub.linkTests';
  var MAX_KEPT = 50;
  var OUTCOMES = [
    { id: 'title', label: 'outTitle', short: 'shortTitle' },
    { id: 'app', label: 'outApp', short: 'shortApp' },
    { id: 'nothing', label: 'outNothing', short: 'shortNothing' }
  ];
  var PLACEHOLDER = /<[^<>]*>/;
  // A typed id: printable, no spaces, quotes or angle brackets, at most 200.
  var ID_RE = /^[\x21\x23-\x3b\x3d\x3f-\x7e]{1,200}$/;
  var DEFAULT_EDITABLE = ['primeGti'];

  var S = { C: null, host: null, pending: null, results: [], ids: {}, rowError: null, lastError: '' };

  // English here; Spanish through the hub's table (app/i18n.js).
  var WORDS = {
    stale: 'The TV helper is out of date. Unplug the TV for 30 seconds, then try again.',
    cantOpen: 'Couldn’t open: {error}',
    lastError: 'Last error: {error}',
    title: 'Watch link test',
    intro: 'Each test opens one app a different way. Come back to the hub, then say what happened. Answers go to the Pi (./hub linktests).',
    empty: 'No recipes. Add them under widgets.entertainment.linkTests in config.js.',
    ownId: ' (typed on this TV; empty for config.js’s)',
    okEdit: ' (OK to edit)',
    total: '{n} tests, numbered on the left. Same app’s tests are together.',
    plain: 'plain open · no app control',
    ask: 'What happened with {app}?',
    outTitle: 'Opened the title', outApp: 'Only opened the app', outNothing: 'Nothing',
    shortTitle: 'opened the title', shortApp: 'only opened the app', shortNothing: 'nothing happened',
    couldNot: 'could not be tried',
    needsId: 'needs id', looking: 'looking for the app', notInstalled: 'app not installed',
    lastOutcome: 'last: {what}', notTried: 'not tried',
    toastNeedsId: 'This one needs an id first: edit widgets.entertainment.linkTests in config.js.',
    toastLooking: 'Still looking for your apps. Try again in a second.',
    toastMissing: '{app} isn’t on this TV.',
    toastSavedNoPi: 'Saved on this TV. The Pi couldn’t be reached ({err}); it is sent next time.',
    toastSaved: 'Saved, and sent to the Pi.',
    notSaved: 'Not saved: {err}.',
    savedHere: 'Saved on this TV.',
    about: 'OK to open · {tried} of {ready} tried',
    badId: 'an id has no spaces, quotes or angle brackets and is at most 200 characters',
    noEdit: 'that id can’t be changed here'
  };

  function word(key, vars) {
    var english = WORDS[key];
    var I = window.HUB_I18N;
    if (I && typeof I.t === 'function') {
      try { return String(I.t('linktest.' + key, english, vars)); } catch (e) { /* English below */ }
    }
    return english.replace(/\{(\w+)\}/g, function (all, k) { return vars && vars.hasOwnProperty(k) ? vars[k] : all; });
  }

  // "0.29.9" or "v0.29.10" as [0, 29, 10]; null when it isn't a version.
  function parseVersion(v) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  // True only when both are versions and the service's is the older.
  var LAUNCH_CONTROL_SINCE = 'v0.28.16';

  function isOlder(service, build) {
    var a = parseVersion(service);
    var b = parseVersion(build);
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }

  // Shows what went wrong on the recipe's row until the next key, and keeps
  // the last one at the top of the list.
  function showError(rec, text) {
    S.rowError = { id: rec.id, text: text };
    S.lastError = text;
    save();
    if (S.C && S.C.isOpen()) S.C.redrawPanel();
    function clear() {
      document.removeEventListener('keydown', clear, true);
      setTimeout(function () {
        if (S.rowError && S.rowError.id === rec.id) {
          S.rowError = null;
          if (S.C && S.C.isOpen()) S.C.redrawPanel();
        }
      }, 0);
    }
    document.addEventListener('keydown', clear, true);
  }

  function failText(err) {
    if (err === 'not found' || err === 'HTTP 404') return word('stale');
    return word('cantOpen', { error: err });
  }

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function conf() {
    var c = S.C && S.C.config && S.C.config.linkTests;
    return c && typeof c === 'object' ? c : { ids: {}, recipes: [] };
  }

  function fillIds(text, ids) {
    if (typeof text !== 'string') return text;
    return text.replace(/\{(\w+)\}/g, function (all, k) {
      return ids && ids.hasOwnProperty(k) && typeof ids[k] === 'string' && ids[k] ? ids[k] : '<' + k + '>';
    });
  }

  // The ids that get a text box: [{ name, value, own (typed on this TV) }].
  function editable() {
    var c = conf();
    var names = isArr(c.editable) ? c.editable : DEFAULT_EDITABLE;
    var base = c.ids && typeof c.ids === 'object' ? c.ids : {};
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (typeof n !== 'string' || !/^\w{1,40}$/.test(n)) continue;
      var own = S.ids.hasOwnProperty(n) ? S.ids[n] : null;
      out.push({ name: n, value: own !== null ? own : (typeof base[n] === 'string' ? base[n] : ''), own: own !== null });
    }
    return out;
  }

  // config.js's ids, with the ones typed on this TV over them.
  function allIds() {
    var c = conf();
    var base = c.ids && typeof c.ids === 'object' ? c.ids : {};
    var out = {};
    for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
    var ed = editable();
    for (var i = 0; i < ed.length; i++) if (ed[i].own) out[ed[i].name] = ed[i].value;
    return out;
  }

  // A typed id: '' goes back to config.js's. Returns null, or what is wrong.
  function setId(name, value) {
    var ed = editable();
    var ok = false;
    for (var i = 0; i < ed.length; i++) if (ed[i].name === name) ok = true;
    if (!ok) return word('noEdit');
    var v = String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
    if (v === '') delete S.ids[name];
    else if (!ID_RE.test(v)) return word('badId');
    else S.ids[name] = v;
    save();
    return null;
  }

  // The recipes, ready to fire: { id, app, name, op, uri, key, val, needsId }.
  function recipes() {
    var c = conf();
    var list = isArr(c.recipes) ? c.recipes : [];
    var ids = allIds();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || (!r.plain && typeof r.op !== 'string')) continue;
      var o = {
        id: r.id, app: String(r.app || ''), name: String(r.name || r.id), op: r.plain ? '' : r.op, plain: !!r.plain,
        uri: r.uri ? fillIds(String(r.uri), ids) : '',
        key: r.key ? String(r.key) : '',
        val: r.key ? fillIds(String(r.val || ''), ids) : ''
      };
      o.needsId = PLACEHOLDER.test(o.uri) || PLACEHOLDER.test(o.val);
      out.push(o);
    }
    // One app's tests together (apps in the order they first appear), so a
    // person scrolling finds all of Apple TV in one place.
    var apps = [];
    for (var a = 0; a < out.length; a++) if (apps.indexOf(out[a].app) < 0) apps.push(out[a].app);
    var grouped = [];
    for (var g = 0; g < apps.length; g++) for (var b = 0; b < out.length; b++) if (out[b].app === apps[g]) grouped.push(out[b]);
    return grouped;
  }

  // Which app a test opened, for the answer sent to the Pi: its name and id
  // on this TV, and the other apps whose name shares the first word, so a
  // wrong match shows up in ./hub linktests.
  function appDetail(rec) {
    var app = appFor(rec);
    if (!app) return '';
    var t = 'opened ' + app.name + ' ' + app.id + (app.hidden ? ' (hidden)' : '');
    var host = S.host;
    var first = String(rec.app || '').split(' ')[0].toLowerCase();
    var all = host && typeof host.apps === 'function' ? host.apps() || [] : [];
    var others = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i] || all[i].id === app.id || !first) continue;
      if (String(all[i].name || '').toLowerCase().indexOf(first) >= 0) others.push(all[i].name + ' ' + all[i].id + (all[i].hidden ? ' (hidden)' : ''));
    }
    if (others.length) t += '; also ' + others.join(', ');
    return t;
  }

  /* ---------- kept answers ---------- */

  function load() {
    try {
      var d = JSON.parse((window.localStorage && localStorage.getItem(KEY)) || 'null');
      if (d && typeof d === 'object') {
        S.results = isArr(d.results) ? d.results.slice(0, MAX_KEPT) : [];
        S.pending = typeof d.pending === 'string' ? d.pending : null;
        S.ids = {};
        S.lastError = typeof d.lastError === 'string' ? d.lastError.substring(0, 200) : '';
        if (d.ids && typeof d.ids === 'object') {
          for (var k in d.ids) if (d.ids.hasOwnProperty(k) && typeof d.ids[k] === 'string' && ID_RE.test(d.ids[k])) S.ids[k] = d.ids[k];
        }
      }
    } catch (e) { S.results = []; S.pending = null; S.ids = {}; }
  }

  function save() {
    try {
      if (window.localStorage) localStorage.setItem(KEY, JSON.stringify({ results: S.results.slice(0, MAX_KEPT), pending: S.pending, ids: S.ids, lastError: S.lastError }));
    } catch (e) { /* kept for this visit only */ }
  }

  function lastFor(id) {
    for (var i = 0; i < S.results.length; i++) if (S.results[i].id === id) return S.results[i];
    return null;
  }

  function outcomeText(id) {
    for (var i = 0; i < OUTCOMES.length; i++) if (OUTCOMES[i].id === id) return word(OUTCOMES[i].short);
    return id === 'error' ? word('couldNot') : id;
  }

  // Sends every answer the Pi hasn't got yet, oldest first.
  function sendUnsent(cb) {
    var Lv = S.C && S.C.live;
    var list = [];
    for (var i = S.results.length - 1; i >= 0; i--) if (!S.results[i].sent) list.push(S.results[i]);
    if (!list.length) { if (cb) cb(null); return; }
    if (!Lv || typeof Lv.post !== 'function') { if (cb) cb('live updates are off'); return; }
    (function next(n) {
      if (n >= list.length) { save(); if (cb) cb(null); return; }
      var r = list[n];
      var body = {};
      for (var k in r) if (r.hasOwnProperty(k) && k !== 'sent') body[k] = r[k];
      Lv.post('/linktests', { result: body }, function (err) {
        if (err) { save(); if (cb) cb(err); return; }
        r.sent = true;
        next(n + 1);
      });
    })(0);
  }

  function record(rec, outcome, detail) {
    var r = {
      id: rec.id, app: rec.app, name: rec.name, outcome: outcome, op: rec.plain ? 'plain open' : rec.op,
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), build: window.HUB_BUILD || '', sent: false
    };
    if (rec.uri) r.uri = rec.uri;
    if (rec.key) r.data = rec.key + '=' + rec.val;
    if (!detail) { try { detail = appDetail(rec); } catch (e) { detail = ''; } }
    if (detail) r.detail = String(detail).substring(0, 140);
    S.results.unshift(r);
    S.results = S.results.slice(0, MAX_KEPT);
    S.pending = null;
    save();
    sendUnsent(function (err) {
      if (S.C) S.C.toast(err ? word('toastSavedNoPi', { err: err }) : word('toastSaved'), 4000);
      if (S.C && S.C.isOpen()) S.C.redrawPanel();
    });
  }

  /* ---------- firing ---------- */

  function byId(id) {
    var list = recipes();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function appFor(rec) {
    var host = S.host;
    if (!host || !host.appsReady()) return undefined;
    var match = (typeof host.matchFor === 'function' && host.matchFor(rec.app)) || [rec.app];
    return host.findApp(match);
  }

  function stateText(rec) {
    if (rec.needsId) return word('needsId');
    var app = appFor(rec);
    if (app === undefined) return word('looking');
    if (!app) return word('notInstalled');
    var last = lastFor(rec.id);
    return last ? word('lastOutcome', { what: outcomeText(last.outcome) }) : word('notTried');
  }

  // OK on a recipe. Returns what happened, for the tests:
  // 'needsid', 'waiting', 'missing' or 'fired'.
  function fire(rec) {
    var C = S.C;
    if (rec.needsId) { C.toast(word('toastNeedsId'), 6000); return 'needsid'; }
    var app = appFor(rec);
    if (app === undefined) { C.toast(word('toastLooking'), 3500); return 'waiting'; }
    if (!app) { C.toast(word('toastMissing', { app: rec.app }), 4500); return 'missing'; }
    S.rowError = null;
    // A plain open has no app control: the TV's own /launch, then the question.
    if (rec.plain) {
      S.pending = rec.id;
      save();
      C.redrawPanel();
      S.host.launch(app.id, rec.app);
      return 'fired';
    }
    function go() {
      S.pending = rec.id;
      save();
      C.redrawPanel();
      S.host.launchControl({ id: app.id, op: rec.op, uri: rec.uri || null, key: rec.key || null, val: rec.key ? rec.val : null }, function (err) {
        if (err) {
          record(rec, 'error', err);
          showError(rec, failText(err));
        }
      });
    }
    // A service.js from before /launch-control (0.28.16) can't do this: ask
    // its version first. Only that matters: every release bumps the version,
    // and a helper one release behind still has /launch-control. (A service
    // that doesn't answer is left for the launch itself to report.)
    C.service('/ping', 3000, function (err, data) {
      if (!err && data && isOlder(data.version, LAUNCH_CONTROL_SINCE)) { showError(rec, word('stale')); return; }
      go();
    });
    return 'fired';
  }

  /* ---------- drawing ---------- */

  function shortOp(op) {
    var m = /\/operation\/([A-Za-z0-9_]+)$/.exec(op || '');
    return m ? m[1] : op;
  }

  function renderPanel(body) {
    var root = el('div', 'lt', body);
    if (S.lastError) el('div', 'lt-lasterr', root, word('lastError', { error: S.lastError }));
    el('div', 'lt-intro', root, word('intro'));
    var list = recipes();
    if (!list.length) {
      el('div', 'lt-empty', root, word('empty'));
      return;
    }
    var focusSet = false;
    var ed = editable();
    for (var e = 0; e < ed.length; e++) {
      var field = el('label', 'lt-field', root);
      el('span', 'lt-field-name', field, ed[e].name + (ed[e].own ? word('ownId') : word('okEdit')));
      var box = el('input', 'lt-input f', field);
      box.setAttribute('type', 'text');
      box.setAttribute('spellcheck', 'false');
      box.setAttribute('autocomplete', 'off');
      box.setAttribute('data-key', 'lt:id:' + ed[e].name);
      box.value = ed[e].value;
    }
    el('div', 'lt-total', root, word('total', { n: list.length }));
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      var st = stateText(rec);
      var row = el('div', 'lt-row f' + (rec.needsId || st === word('notInstalled') ? ' is-off' : ''), root);
      // While its question is up the row's key changes, so the redraw puts
      // focus on the first answer rather than back on the row.
      row.setAttribute('data-key', 'lt:run:' + rec.id + (S.pending === rec.id ? ':asked' : ''));
      el('span', 'lt-num', row, String(i + 1));
      var main = el('div', 'lt-main', row);
      el('div', 'lt-name', main, rec.app + ' · ' + rec.name);
      el('div', 'lt-detail', main, (rec.plain ? word('plain') : shortOp(rec.op)) + (rec.uri ? ' · ' + rec.uri : '') + (rec.key ? ' · ' + rec.key + '=' + rec.val : ''));
      el('span', 'lt-state' + (rec.needsId ? ' is-needs' : ''), row, st);
      if (S.rowError && S.rowError.id === rec.id) el('div', 'lt-rowerr', main, S.rowError.text);
      if (S.pending === rec.id) {
        var ask = el('div', 'lt-ask', root);
        el('div', 'lt-q', ask, word('ask', { app: rec.app }));
        var opts = el('div', 'lt-opts', ask);
        for (var j = 0; j < OUTCOMES.length; j++) {
          var b = el('div', 'lt-opt f', opts, word(OUTCOMES[j].label));
          b.setAttribute('data-key', 'lt:ans:' + rec.id + ':' + OUTCOMES[j].id);
          if (j === 0) { b.setAttribute('data-autofocus', ''); focusSet = true; }
        }
      }
    }
    if (!focusSet) root.querySelector('.lt-row').setAttribute('data-autofocus', '');
  }

  function onSelect(target) {
    var key = (target && target.getAttribute('data-key')) || '';
    var p = key.split(':');
    if (p[0] !== 'lt') return false;
    var rec = byId(p[2]);
    if (!rec) return true;
    if (p[1] === 'run') fire(rec);
    else if (p[1] === 'ans') record(rec, p[3] === 'title' || p[3] === 'app' ? p[3] : 'nothing');
    return true;
  }

  // Done on an id's text box: keep it, and the recipes use it at once.
  function onSubmit(box) {
    var key = (box && box.getAttribute('data-key')) || '';
    if (key.indexOf('lt:id:') !== 0) return false;
    var err = setId(key.substring(6), box.value);
    if (S.C) {
      S.C.toast(err ? word('notSaved', { err: err }) : word('savedHere'), err ? 6000 : 3000);
      if (!err) S.C.redrawPanel();
    }
    return true;
  }

  // Back while the question is up: drop the question first.
  function onBack() {
    if (!S.pending) return false;
    S.pending = null;
    save();
    if (S.C) S.C.redrawPanel();
    return true;
  }

  function attach(ctx, host) {
    S.C = ctx;
    S.host = host;
    load();
    // Answers the Pi missed last time go once the line is up.
    setTimeout(function () { sendUnsent(null); }, 15000);
  }

  window.HUB_LINKTEST = {
    attach: attach,
    title: function () { return word('title'); },
    renderPanel: renderPanel,
    onSelect: onSelect,
    onSubmit: onSubmit,
    onBack: onBack,
    // The About panel's row: how far the test has come.
    aboutText: function () {
      var list = recipes();
      if (!list.length) return '';
      var tried = 0;
      var ready = 0;
      for (var i = 0; i < list.length; i++) {
        if (lastFor(list[i].id)) tried++;
        if (!list[i].needsId) ready++;
      }
      // Short: one line in the About strip (the list says which need an id).
      return word('about', { tried: tried, ready: ready });
    },
    _test: { isOlder: isOlder, recipes: recipes, fire: fire, record: record, setId: setId, editable: editable, state: function () { return S; }, stateText: stateText }
  };
})();
