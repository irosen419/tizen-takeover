/*
 * The touch app (app/touch.html): Home Hub on a phone, tablet or computer,
 * served by the Pi. Never loaded by the TV.
 *
 *   device    Tizen in the user agent = tv; else by width: phone (< 600 px,
 *             one widget at a time), tablet (< 1200, two side by side),
 *             desktop (three). ?as=phone|tablet|tv overrides.
 *   widgets   every widget in app/config.js (the layouts and the widgets
 *             settings). One with renderTouch (window.HUB_WIDGETS, e.g.
 *             app/widgets/grocery.js) opens here; the rest say "TV only".
 *   phone     opens on the menu; #/<id> shows one widget with a back button.
 *   data      GET /touch/state every 3 s (paused while the tab is hidden);
 *             changes POST /<resource>/ops with an optimistic update. The
 *             state's products (catalog entries for codes on the lists)
 *             reach widgets as ctx.products(); ctx.call() reaches the rest
 *             of the Pi (app/scan.js: product lookup and save).
 *
 * Touch only, so it may use what the TV lacks (fetch, CSS grid), but it is
 * plain ES5 like the rest of app/.
 */
(function () {
  'use strict';

  var POLL_MS = 3000;
  var TIMEOUT_MS = 8000;
  var cfg = window.HUB_CONFIG || {};
  var I = window.HUB_I18N;
  var rootEl = document.getElementById('touch-root');

  function T(key, english, vars) {
    try { return I && I.t ? String(I.t(key, english, vars)) : english; } catch (e) { return english; }
  }

  // English names of the TV's widgets and the key of each one's Spanish.
  var NAMES = {
    today: ['today.title', 'Clock'], calendar: ['calendar.title', 'Calendar'], weather: ['weather.title', 'Weather'],
    todo: ['todo.title', 'To-do'], nowplaying: ['nowplaying.title', 'Now Playing'], entertainment: ['entertainment.title', 'Entertainment'],
    ambience: ['ambience.title', 'Ambience'], wotd: ['wotd.title', 'Word of the day'], mirror: ['planned.mirror.title', 'Mirror'],
    awws: ['awws.titles.awws', 'A World Worth Saving'], 'awws-visits': ['awws.titles.visits', 'Next visit'],
    'awws-agenda': ['awws.titles.agenda', 'This week'], 'awws-todo': ['awws.titles.todo', 'To-do board'],
    'awws-reach': ['awws.titles.reach', 'Reach'], 'awws-money': ['awws.titles.money', 'Earned vs spent'],
    'budget-room': ['budget.titles.room', 'Daily room'], 'budget-card': ['budget.titles.card', 'Card day'],
    'budget-goals': ['budget.titles.goals', 'Goals'], 'budget-lab': ['budgetLab.titles.lab', 'Budget lab'],
    allsounds: ['allsounds.title', 'All sounds'], soundctl: ['soundctl.title', 'Sound control'],
    sunpath: ['sunpath.title', 'Plant sun'], architecture: ['touch.name.architecture', 'Architecture'],
    investments: ['investments.title', 'Investments'], shows: ['shows.title', 'Schedule']
  };

  /* ---------- device ---------- */

  function query(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  var forced = { phone: 1, tablet: 1, tv: 1 }[query('as')] ? query('as') : '';

  function device() {
    if (forced) return forced;
    if (/Tizen/i.test(navigator.userAgent)) return 'tv';
    var w = window.innerWidth || document.documentElement.clientWidth;
    return w < 600 ? 'phone' : w < 1200 ? 'tablet' : 'desktop';
  }

  var COLS = { phone: 1, tablet: 2, desktop: 3, tv: 3 };

  /* ---------- widgets ---------- */

  function touchWidgets() {
    var out = {};
    var list = window.HUB_WIDGETS || [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i], c = cfg.widgets && cfg.widgets[w.id];
      if (w && typeof w.renderTouch === 'function' && !(c && c.touch === false)) out[w.id] = w;
    }
    return out;
  }

  // Every widget the config names, touch ones first, then layout order.
  function catalog() {
    var touch = touchWidgets(), seen = {}, out = [];
    function add(id) {
      if (!id || seen[id]) return;
      if (!touch[id] && !NAMES[id]) return; // a settings group (budget), not a widget
      seen[id] = 1;
      out.push(id);
    }
    Object.keys(touch).forEach(add);
    (cfg.layout || []).forEach(function (e) { add(e.widget); });
    (cfg.layouts || []).forEach(function (l) { (l.layout || []).forEach(function (e) { add(e.widget); }); });
    Object.keys(cfg.widgets || {}).forEach(add);
    return out.map(function (id) { return { id: id, widget: touch[id] || null }; });
  }

  function nameOf(entry) {
    var w = entry.widget;
    if (w) return T(w.titleKey || (w.id + '.title'), w.title || w.id);
    var n = NAMES[entry.id];
    return n ? T(n[0], n[1]) : entry.id;
  }

  /* ---------- data ---------- */

  // products: the Pi's catalog entries for codes on the lists ({ upc: product }).
  var store = { data: {}, rev: {}, status: 'loading', pending: 0, products: {}, productsKey: '' };
  var mounted = [];
  var pollTimer = null, polling = false;

  function request(method, url, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error(T('touch.offline', 'Offline'))); } }, timeoutMs || TIMEOUT_MS);
      // X-Hub-Touch: the Pi serves its touch routes (products, grocery) only to this app.
      var opts = { method: method, cache: 'no-store', headers: { 'X-Hub-Touch': '1' } };
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      fetch(url, opts).then(function (res) {
        return res.json().then(function (j) { return { ok: res.ok, j: j }; }, function () { return { ok: false, j: {} }; });
      }).then(function (r) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (r.ok && r.j && r.j.ok !== false) resolve(r.j);
        else reject(new Error((r.j && r.j.error) || 'the hub said no'));
      }, function () {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(new Error(T('touch.offline', 'Offline')));
      });
    });
  }

  function setStatus(s) {
    if (store.status === s) return false;
    store.status = s;
    return true;
  }

  function refresh() {
    mounted.forEach(function (m) { try { m.inst.update(); } catch (e) { /* one widget never stops the rest */ } });
    paintChrome();
  }

  function poll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (document.hidden || polling) return;
    polling = true;
    request('GET', '/touch/state').then(function (j) {
      var changed = setStatus('ok');
      if (j.products && typeof j.products === 'object') {
        var pk = JSON.stringify(j.products);
        if (pk !== store.productsKey) { store.productsKey = pk; store.products = j.products; changed = true; }
      }
      if (!store.pending) {
        Object.keys(touchWidgets()).forEach(function (id) {
          var res = touchWidgets()[id].resource || id;
          var r = j[res];
          if (r && r.data && store.rev[res] !== r.rev) { store.rev[res] = r.rev; store.data[res] = r.data; changed = true; }
        });
      }
      if (changed) refresh();
    }, function () {
      if (setStatus('offline')) refresh();
    }).then(function () {
      polling = false;
      if (!document.hidden) pollTimer = setTimeout(poll, POLL_MS);
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } } else poll();
  });

  function sendOps(res, ops, optimistic, cb) {
    var before = store.data[res];
    store.data[res] = optimistic;
    store.pending += 1;
    refresh();
    request('POST', '/' + res + '/ops', { ops: ops }).then(function (j) {
      store.pending -= 1;
      setStatus('ok');
      // The last answer holds every change before it, so only it is drawn.
      if (!store.pending && j.items) { store.data[res] = { items: j.items }; store.rev[res] = j.rev; }
      refresh();
      cb(null);
    }, function (e) {
      store.pending -= 1;
      if (!store.pending) store.data[res] = before;
      refresh();
      cb(e.message);
      poll();
    });
  }

  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function mount(host, entry, compact) {
    var w = entry.widget, res = w.resource || w.id;
    var ctx = {
      id: w.id,
      compact: compact,
      config: (cfg.widgets && cfg.widgets[w.id]) || {},
      t: T,
      lang: function () { return I && I.lang ? I.lang() : 'en'; },
      data: function () { return store.data[res] || null; },
      status: function () { return store.status; },
      send: function (ops, optimistic, cb) { sendOps(res, ops, optimistic, cb || function () {}); },
      // Any other call to the Pi (product lookup, save): resolves to its JSON.
      call: request,
      products: function () { return store.products; },
      reduced: reduced
    };
    var inst = w.renderTouch(host, ctx) || {};
    if (typeof inst.update !== 'function') inst.update = function () {};
    mounted.push({ id: w.id, inst: inst });
  }

  function unmountAll() {
    mounted.forEach(function (m) { try { if (m.inst.destroy) m.inst.destroy(); } catch (e) { /* ignore */ } });
    mounted = [];
  }

  /* ---------- drawing ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  function svg(d, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', cls || 't-ic');
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  var CHEVRON_R = 'M9.5 5.5L16 12l-6.5 6.5';
  var CHEVRON_L = 'M14.5 5.5L8 12l6.5 6.5';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Bits redrawn on every data or status change without rebuilding the view.
  var chrome = { pills: [], datums: [] };

  function statusPill() {
    var p = el('button', 't-pill');
    p.type = 'button';
    p.addEventListener('click', function () { if (store.status !== 'ok') { setStatus('loading'); paintChrome(); poll(); } });
    chrome.pills.push(p);
    return p;
  }

  function paintChrome() {
    var s = store.status;
    chrome.pills.forEach(function (p) {
      p.className = 't-pill is-' + s;
      p.disabled = s === 'ok';
      p.textContent = '';
      p.appendChild(el('span', 't-pill-dot'));
      p.appendChild(el('span', 't-pill-word', s === 'ok' ? T('touch.live', 'Live') : s === 'offline' ? T('touch.offline', 'Offline') : T('touch.connecting', 'Connecting…')));
      if (s === 'offline') p.appendChild(el('span', 't-pill-retry', T('touch.retry', 'Try again')));
    });
    chrome.datums.forEach(function (d) {
      var w = d.widget, data = store.data[w.resource || w.id];
      d.node.textContent = w.summary && data ? w.summary(data, T) : '';
    });
  }

  function langToggle() {
    var box = el('div', 't-lang');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', T('lang.label', 'Language'));
    var cur = I && I.lang ? I.lang() : 'en';
    [['en', 'English'], ['es', 'Español']].forEach(function (l) {
      var b = el('button', 't-lang-btn', l[1]);
      b.type = 'button';
      b.lang = l[0];
      b.setAttribute('aria-pressed', cur === l[0] ? 'true' : 'false');
      b.addEventListener('click', function () { if (I && I.setLang) I.setLang(l[0]); });
      box.appendChild(b);
    });
    return box;
  }

  function hello(extra) {
    var h = el('header', 't-hello');
    var text = el('div', 't-hello-text');
    var date = I && I.longDate ? I.longDate(new Date()) : '';
    text.appendChild(el('p', 't-date', date ? date.charAt(0).toUpperCase() + date.slice(1) : ''));
    text.appendChild(el('h1', 't-h1', 'Home Hub'));
    h.appendChild(text);
    var side = el('div', 't-hello-side');
    side.appendChild(statusPill());
    if (extra) side.appendChild(extra);
    h.appendChild(side);
    return h;
  }

  function section(label, count) {
    var h = el('h2', 't-section');
    h.appendChild(el('span', 't-section-word', label));
    if (count != null) h.appendChild(el('span', 't-section-count', String(count)));
    return h;
  }

  // The list of every widget. linkTouch: a touch row opens its view.
  function directory(list, linkTouch) {
    var wrap = el('div', 't-dir');
    var touch = list.filter(function (e) { return e.widget; });
    var tv = list.filter(function (e) { return !e.widget; });
    if (linkTouch && touch.length) {
      wrap.appendChild(section(T('touch.sectionHere', 'On this screen')));
      var ul = el('ul', 't-rows');
      touch.forEach(function (e) {
        var li = el('li');
        var a = el('a', 't-row is-touch');
        a.href = '#/' + e.id;
        a.setAttribute('data-widget', e.id);
        var ic = el('span', 't-row-ic');
        ic.appendChild(svg(e.widget.icon || 'M12 12h.01'));
        a.appendChild(ic);
        a.appendChild(el('span', 't-row-name', nameOf(e)));
        var datum = el('span', 't-row-datum');
        chrome.datums.push({ widget: e.widget, node: datum });
        a.appendChild(datum);
        a.appendChild(svg(CHEVRON_R, 't-ic t-chev'));
        li.appendChild(a);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    wrap.appendChild(section(T('touch.sectionTv', 'On the TV'), tv.length));
    var tul = el('ul', 't-rows t-rows-tv');
    tv.forEach(function (e) {
      var li = el('li', 't-row is-tv');
      li.setAttribute('aria-disabled', 'true');
      li.setAttribute('data-widget', e.id);
      li.appendChild(el('span', 't-row-dot'));
      li.appendChild(el('span', 't-row-name', nameOf(e)));
      li.appendChild(el('span', 't-badge', T('touch.tvOnly', 'TV only')));
      tul.appendChild(li);
    });
    wrap.appendChild(tul);
    wrap.appendChild(el('p', 't-hint', T('touch.tvOnlyHint', 'Open it on the TV. A touch view comes later.')));
    return wrap;
  }

  function routeId() {
    var m = /^#\/([\w-]+)/.exec(location.hash || '');
    return m ? m[1] : '';
  }

  var lastShape = '';
  function draw(animate) {
    unmountAll();
    chrome = { pills: [], datums: [] };
    var dev = device();
    var list = catalog();
    var touch = touchWidgets();
    rootEl.innerHTML = '';
    var app = el('div', 't-app is-' + dev);
    rootEl.appendChild(app);
    document.title = 'Home Hub';

    if (dev === 'phone') {
      var id = routeId();
      if (id && touch[id]) {
        var view = el('section', 't-view' + (animate && !reduced() ? ' is-entering' : ''));
        var bar = el('header', 't-bar');
        var back = el('a', 't-back');
        back.href = '#';
        back.setAttribute('aria-label', T('touch.back', 'Back to the menu'));
        back.appendChild(svg(CHEVRON_L));
        back.appendChild(el('span', 't-back-word', T('touch.menu', 'Menu')));
        bar.appendChild(back);
        var name = nameOf({ id: id, widget: touch[id] });
        bar.appendChild(el('h1', 't-bar-title', name));
        bar.appendChild(statusPill());
        view.appendChild(bar);
        var body = el('div', 't-body');
        view.appendChild(body);
        app.appendChild(view);
        document.title = name + ' · Home Hub';
        mount(body, { id: id, widget: touch[id] }, true);
      } else {
        var menu = el('section', 't-menu' + (animate && !reduced() ? ' is-back' : ''));
        menu.appendChild(hello());
        menu.appendChild(directory(list, true));
        var foot = el('footer', 't-foot');
        foot.appendChild(langToggle());
        menu.appendChild(foot);
        app.appendChild(menu);
      }
    } else {
      app.appendChild(hello(langToggle()));
      if (dev === 'tv') app.appendChild(el('p', 't-tvnote', T('touch.tvNote', 'This is the phone and tablet app. The TV runs Home Hub itself.')));
      var panes = el('main', 't-panes');
      var entries = list.filter(function (e) { return e.widget; });
      var cols = Math.max(1, Math.min(COLS[dev], entries.length + 1));
      panes.style.setProperty('--cols', String(cols));
      entries.forEach(function (e) {
        var pane = el('section', 't-pane');
        pane.id = 'w-' + e.id;
        var ph = el('header', 't-pane-head');
        ph.appendChild(svg(e.widget.icon || 'M12 12h.01'));
        ph.appendChild(el('h2', 't-pane-title', nameOf(e)));
        pane.appendChild(ph);
        var body2 = el('div', 't-body');
        pane.appendChild(body2);
        panes.appendChild(pane);
        mount(body2, e, false);
      });
      var dirPane = el('section', 't-pane t-pane-dir');
      dirPane.appendChild(directory(list, false));
      panes.appendChild(dirPane);
      app.appendChild(panes);
    }
    lastShape = dev + '|' + routeId();
    paintChrome();
  }

  window.addEventListener('hashchange', function () { draw(true); window.scrollTo(0, 0); });
  window.addEventListener('resize', function () {
    if (device() !== lastShape.split('|')[0]) draw(false);
  });
  if (I && I.onChange) I.onChange(function () { draw(false); });

  draw(false);
  poll();

  // For dev/touch-test.js.
  window.HUB_TOUCH = { device: device, catalog: catalog, store: store, poll: poll };
})();
