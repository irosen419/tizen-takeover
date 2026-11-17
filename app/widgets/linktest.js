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
 * {name} in a recipe is filled from linkTests.ids. A recipe still holding a
 * <placeholder> says "needs id" and never fires. Plain ES5. English only:
 * it is a tool for the owner and Claude, not part of the everyday screen.
 */
(function () {
  'use strict';

  var KEY = 'homeHub.linkTests';
  var MAX_KEPT = 50;
  var OUTCOMES = [
    { id: 'title', label: 'Opened the title', short: 'opened the title' },
    { id: 'app', label: 'Only opened the app', short: 'only opened the app' },
    { id: 'nothing', label: 'Nothing', short: 'nothing happened' }
  ];
  var PLACEHOLDER = /<[^<>]*>/;

  var S = { C: null, host: null, pending: null, results: [] };

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

  // The recipes, ready to fire: { id, app, name, op, uri, key, val, needsId }.
  function recipes() {
    var c = conf();
    var list = isArr(c.recipes) ? c.recipes : [];
    var ids = c.ids && typeof c.ids === 'object' ? c.ids : {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || typeof r.op !== 'string') continue;
      var o = {
        id: r.id, app: String(r.app || ''), name: String(r.name || r.id), op: r.op,
        uri: r.uri ? fillIds(String(r.uri), ids) : '',
        key: r.key ? String(r.key) : '',
        val: r.key ? fillIds(String(r.val || ''), ids) : ''
      };
      o.needsId = PLACEHOLDER.test(o.uri) || PLACEHOLDER.test(o.val);
      out.push(o);
    }
    return out;
  }

  /* ---------- kept answers ---------- */

  function load() {
    try {
      var d = JSON.parse((window.localStorage && localStorage.getItem(KEY)) || 'null');
      if (d && typeof d === 'object') {
        S.results = isArr(d.results) ? d.results.slice(0, MAX_KEPT) : [];
        S.pending = typeof d.pending === 'string' ? d.pending : null;
      }
    } catch (e) { S.results = []; S.pending = null; }
  }

  function save() {
    try {
      if (window.localStorage) localStorage.setItem(KEY, JSON.stringify({ results: S.results.slice(0, MAX_KEPT), pending: S.pending }));
    } catch (e) { /* kept for this visit only */ }
  }

  function lastFor(id) {
    for (var i = 0; i < S.results.length; i++) if (S.results[i].id === id) return S.results[i];
    return null;
  }

  function outcomeText(id) {
    for (var i = 0; i < OUTCOMES.length; i++) if (OUTCOMES[i].id === id) return OUTCOMES[i].short;
    return id === 'error' ? 'could not be tried' : id;
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
      id: rec.id, app: rec.app, name: rec.name, outcome: outcome, op: rec.op,
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), build: window.HUB_BUILD || '', sent: false
    };
    if (rec.uri) r.uri = rec.uri;
    if (rec.key) r.data = rec.key + '=' + rec.val;
    if (detail) r.detail = String(detail).substring(0, 140);
    S.results.unshift(r);
    S.results = S.results.slice(0, MAX_KEPT);
    S.pending = null;
    save();
    sendUnsent(function (err) {
      if (S.C) S.C.toast(err ? 'Saved on this TV. The Pi couldn’t be reached (' + err + '); it is sent next time.' : 'Saved, and sent to the Pi.', 4000);
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
    if (rec.needsId) return 'needs id';
    var app = appFor(rec);
    if (app === undefined) return 'looking for the app';
    if (!app) return 'app not installed';
    var last = lastFor(rec.id);
    return last ? 'last: ' + outcomeText(last.outcome) : 'not tried';
  }

  // OK on a recipe. Returns what happened, for the tests:
  // 'needsid', 'waiting', 'missing' or 'fired'.
  function fire(rec) {
    var C = S.C;
    if (rec.needsId) { C.toast('This one needs an id first: edit widgets.entertainment.linkTests in config.js.', 6000); return 'needsid'; }
    var app = appFor(rec);
    if (app === undefined) { C.toast('Still looking for your apps. Try again in a second.', 3500); return 'waiting'; }
    if (!app) { C.toast(rec.app + ' isn’t on this TV.', 4500); return 'missing'; }
    S.pending = rec.id;
    save();
    C.redrawPanel();
    S.host.launchControl({ id: app.id, op: rec.op, uri: rec.uri || null, key: rec.key || null, val: rec.key ? rec.val : null }, function (err) {
      if (err) {
        record(rec, 'error', err);
        C.toast(rec.app + ' couldn’t be opened that way (' + err + ').', 6000);
      }
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
    el('div', 'lt-intro', root, 'Each test opens one app a different way. Come back to the hub, then say what happened. Answers go to the Pi (./hub linktests).');
    var list = recipes();
    if (!list.length) {
      el('div', 'lt-empty', root, 'No recipes. Add them under widgets.entertainment.linkTests in config.js.');
      return;
    }
    var focusSet = false;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      var st = stateText(rec);
      var row = el('div', 'lt-row f' + (rec.needsId || st === 'app not installed' ? ' is-off' : ''), root);
      row.setAttribute('data-key', 'lt:run:' + rec.id);
      var main = el('div', 'lt-main', row);
      el('div', 'lt-name', main, rec.app + ' · ' + rec.name);
      el('div', 'lt-detail', main, shortOp(rec.op) + (rec.uri ? ' · ' + rec.uri : '') + (rec.key ? ' · ' + rec.key + '=' + rec.val : ''));
      el('span', 'lt-state' + (rec.needsId ? ' is-needs' : ''), row, st);
      if (S.pending === rec.id) {
        var ask = el('div', 'lt-ask', root);
        el('div', 'lt-q', ask, 'What happened with ' + rec.app + '?');
        var opts = el('div', 'lt-opts', ask);
        for (var j = 0; j < OUTCOMES.length; j++) {
          var b = el('div', 'lt-opt f', opts, OUTCOMES[j].label);
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
    title: function () { return 'Watch link test'; },
    renderPanel: renderPanel,
    onSelect: onSelect,
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
      return 'OK to open · ' + tried + ' of ' + ready + ' tried' + (ready < list.length ? ' (' + (list.length - ready) + ' need an id)' : '');
    },
    _test: { recipes: recipes, fire: fire, record: record, state: function () { return S; }, stateText: stateText }
  };
})();
