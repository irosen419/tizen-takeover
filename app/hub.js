/*
 * Home Hub. Runs inside TizenBrew on the TV. Plain ES5 so older Tizen
 * browsers (2017 to 2019 sets) can run it.
 */
(function () {
  'use strict';

  var SERVICE = 'http://127.0.0.1:8095';
  var TIZENBREW_WS = 'ws://127.0.0.1:8081';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8 };

  var cfg = window.HUB_CONFIG || { title: '', rows: [] };
  var rowsEl = document.getElementById('rows');
  var toastEl = document.getElementById('toast');
  var overlayEl = document.getElementById('allApps');
  var listEl = document.getElementById('appList');
  var frameWrap = document.getElementById('frameWrap');
  var frameEl = document.getElementById('frame');

  var rows = [];          // [{ el, tilesEl, tiles: [{ cfg, el, subEl, appId }] }]
  var pos = { r: 0, c: 0 };
  var mode = 'grid';      // grid | list | frame
  var apps = null;        // [{ id, name }] once loaded
  var listIndex = 0;
  var toastTimer = null;

  var hasPageTizen = (function () {
    try { return typeof tizen !== 'undefined' && !!tizen.application; } catch (e) { return false; }
  })();

  /* ---------- helpers ---------- */

  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.className = 'toast is-shown';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, ms || 3500);
  }

  function getJSON(path, timeoutMs, cb) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function done(err, data) { if (finished) return; finished = true; cb(err, data); }
    xhr.open('GET', SERVICE + path, true);
    xhr.timeout = timeoutMs;
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status === 200 && data && data.ok) return done(null, data);
      done((data && data.error) || ('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { done('service not reachable'); };
    xhr.ontimeout = function () { done('timed out'); };
    xhr.send();
  }

  function registerKeys(keys) {
    if (!keys || !hasPageTizen || !tizen.tvinputdevice) return;
    for (var i = 0; i < keys.length; i++) {
      try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- clock ---------- */

  function tick() {
    var now = new Date();
    document.getElementById('time').textContent =
      now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    document.getElementById('date').textContent =
      now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  /* ---------- build ---------- */

  function build() {
    document.getElementById('place').textContent = cfg.title || '';
    for (var r = 0; r < cfg.rows.length; r++) {
      var rowCfg = cfg.rows[r];
      if (!rowCfg.tiles || !rowCfg.tiles.length) continue;

      var rowEl = document.createElement('section');
      rowEl.className = 'row';
      var label = document.createElement('h2');
      label.className = 'row-label';
      label.textContent = rowCfg.label || '';
      var tilesEl = document.createElement('div');
      tilesEl.className = 'tiles';
      rowEl.appendChild(label);
      rowEl.appendChild(tilesEl);

      var row = { el: rowEl, tilesEl: tilesEl, tiles: [] };
      for (var t = 0; t < rowCfg.tiles.length; t++) {
        var tc = rowCfg.tiles[t];
        var el = document.createElement('div');
        el.className = 'tile tone-' + (tc.tone || 'slate');
        var name = document.createElement('div');
        name.className = 'tile-label';
        name.textContent = tc.label;
        var sub = document.createElement('div');
        sub.className = 'tile-sub';
        sub.textContent = tc.sub || (tc.kind === 'app' ? 'Looking for it' : '');
        el.appendChild(name);
        el.appendChild(sub);
        tilesEl.appendChild(el);
        row.tiles.push({ cfg: tc, el: el, subEl: sub, appId: null });
      }
      rowsEl.appendChild(rowEl);
      rows.push(row);
    }
    focusTile(0, 0);
  }

  /* ---------- app lookup ---------- */

  function findApp(match) {
    if (!apps || !match) return null;
    // Exact names beat partial ones. Visible apps beat hidden built-ins
    // (Samsung TV Plus can be one of those).
    return exactIn(match, false) || exactIn(match, true) ||
      containsIn(match, false) || containsIn(match, true);
  }

  function exactIn(match, hidden) {
    for (var i = 0; i < match.length; i++) {
      var m = match[i].toLowerCase();
      for (var j = 0; j < apps.length; j++) {
        if (!!apps[j].hidden === hidden && (apps[j].name || '').toLowerCase() === m) return apps[j];
      }
    }
    return null;
  }

  function containsIn(match, hidden) {
    for (var i = 0; i < match.length; i++) {
      var m = match[i].toLowerCase();
      var best = null;
      for (var j = 0; j < apps.length; j++) {
        var lower = (apps[j].name || '').toLowerCase();
        if (!!apps[j].hidden !== hidden || lower.indexOf(m) === -1) continue;
        if (!best || lower.length < best.name.length) best = apps[j];
      }
      if (best) return best;
    }
    return null;
  }

  function resolveTiles() {
    for (var r = 0; r < rows.length; r++) {
      for (var t = 0; t < rows[r].tiles.length; t++) {
        var tile = rows[r].tiles[t];
        if (tile.cfg.kind !== 'app') continue;
        var found = findApp(tile.cfg.match);
        tile.appId = found ? found.id : null;
        tile.subEl.textContent = found ? (tile.cfg.sub || '') : 'Not installed';
        tile.el.className = tile.el.className.replace(/\s?is-missing/g, '') + (found ? '' : ' is-missing');
      }
    }
  }

  function markLookupFailed() {
    for (var r = 0; r < rows.length; r++) {
      for (var t = 0; t < rows[r].tiles.length; t++) {
        var tile = rows[r].tiles[t];
        if (tile.cfg.kind === 'app' && !tile.appId) tile.subEl.textContent = 'Couldn’t check';
      }
    }
  }

  function loadApps(attempt) {
    attempt = attempt || 1;
    if (hasPageTizen && attempt === 1) {
      try {
        tizen.application.getAppsInfo(function (infos) {
          apps = [];
          for (var i = 0; i < infos.length; i++) {
            apps.push({ id: infos[i].id, name: infos[i].name, hidden: infos[i].show === false });
          }
          resolveTiles();
        }, function () { loadApps(2); });
        return;
      } catch (e) { /* fall through to the service */ }
    }
    // The service starts a moment after the page, so keep trying for a while.
    getJSON('/apps', 4000, function (err, data) {
      if (!err) { apps = data.apps; resolveTiles(); return; }
      if (attempt < 25) return setTimeout(function () { loadApps(attempt + 1); }, 800);
      markLookupFailed();
      toast('Couldn’t read the app list (' + err + '). Try closing and reopening the hub.', 6000);
    });
  }

  /* ---------- actions ---------- */

  function launchById(id, label) {
    function viaService() {
      getJSON('/launch?id=' + encodeURIComponent(id), 8000, function (err) {
        if (err) toast('Couldn’t open ' + label + ' (' + err + ').', 5000);
      });
    }
    if (hasPageTizen) {
      try {
        tizen.application.launch(id, function () {}, viaService);
        return;
      } catch (e) { /* fall back */ }
    }
    viaService();
  }

  function openTizenBrewModule(pattern, label) {
    var ws;
    var handled = false;
    var timer = setTimeout(function () {
      if (handled) return;
      handled = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      toast('TizenBrew didn’t answer, so ' + label + ' couldn’t open.', 5000);
    }, 7000);

    try {
      ws = new WebSocket(TIZENBREW_WS);
    } catch (e) {
      clearTimeout(timer);
      return toast('Couldn’t reach TizenBrew.', 4000);
    }

    ws.onopen = function () { ws.send(JSON.stringify({ type: 4, payload: false })); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 4 || handled) return;
      if (!msg.payload) { ws.send(JSON.stringify({ type: 4, payload: true })); return; }

      var mod = null;
      for (var i = 0; i < msg.payload.length; i++) {
        if (pattern.test(msg.payload[i].appName || '') || pattern.test(msg.payload[i].fullName || '')) {
          mod = msg.payload[i];
          break;
        }
      }
      handled = true;
      clearTimeout(timer);
      if (!mod) return toast(label + ' isn’t added in TizenBrew.', 4000);

      // Same two steps TizenBrew's own menu takes when you pick a module.
      registerKeys(mod.keys);
      ws.send(JSON.stringify({ type: 5, payload: mod }));
      setTimeout(function () { location.href = mod.appPath; }, 200);
    };
    ws.onerror = function () {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      toast('Couldn’t reach TizenBrew.', 4000);
    };
  }

  function pressInputKey(tc) {
    toast('Switching to ' + (tc.sub || tc.label) + '. If the TV asks, choose Allow.', 6000);
    getJSON('/key?k=' + encodeURIComponent(tc.key), 170000, function (err) {
      if (err) toast('Couldn\u2019t switch input. ' + err, 15000);
    });
  }

  function callWebhook(tc) {
    if (!tc.url) return toast(tc.label + ' has no webhook address yet. Add one in config.js.', 6000);
    toast((tc.busy || 'Working on it') + '\u2026', 4000);
    getJSON('/webhook?url=' + encodeURIComponent(tc.url), 15000, function (err) {
      if (err) toast('Couldn\u2019t reach Home Assistant. ' + err, 10000);
    });
  }

  function openDashboard(tc) {
    mode = 'frame';
    frameEl.src = tc.url;
    frameWrap.hidden = false;
  }

  function closeDashboard() {
    frameEl.src = 'about:blank';
    frameWrap.hidden = true;
    mode = 'grid';
  }

  function activate(tile) {
    var tc = tile.cfg;
    tile.el.className += ' is-pressed';
    setTimeout(function () { tile.el.className = tile.el.className.replace(/\s?is-pressed/g, ''); }, 160);

    if (tc.kind === 'app') {
      if (!apps) return toast('Still looking for your apps. Try again in a second.');
      if (!tile.appId) return toast(tc.label + ' isn’t on this TV. Open All apps to see what is.', 4500);
      return launchById(tile.appId, tc.label);
    }
    if (tc.kind === 'tizentube') return openTizenBrewModule(/tizentube/i, tc.label);
    if (tc.kind === 'input') return pressInputKey(tc);
    if (tc.kind === 'dashboard') return openDashboard(tc);
    if (tc.kind === 'webhook') return callWebhook(tc);
    if (tc.kind === 'allApps') return openList();
  }

  /* ---------- grid focus ---------- */

  function focusTile(r, c) {
    if (!rows.length) return;
    var prev = rows[pos.r] && rows[pos.r].tiles[pos.c];
    if (prev) prev.el.className = prev.el.className.replace(/\s?is-focused/g, '');
    if (rows[pos.r]) rows[pos.r].el.className = 'row';

    pos.r = Math.max(0, Math.min(rows.length - 1, r));
    pos.c = Math.max(0, Math.min(rows[pos.r].tiles.length - 1, c));
    var tile = rows[pos.r].tiles[pos.c];
    tile.el.className += ' is-focused';
    rows[pos.r].el.className = 'row is-active';
    keepInView();
  }

  function keepInView() {
    var row = rows[pos.r];

    // offset* values ignore transforms, so these are the resting positions.
    // Vertical: slide the rows up just enough to keep the active row on screen.
    var rowBottom = rowsEl.offsetTop + row.el.offsetTop + row.el.offsetHeight;
    var shift = pos.r === 0 ? 0 : Math.max(0, rowBottom - (window.innerHeight - 40));
    rowsEl.style.transform = 'translateY(' + (-shift) + 'px)';

    // Horizontal: slide the row if the focused tile would run off the right edge.
    var tile = row.tiles[pos.c].el;
    var tileRight = rowsEl.offsetLeft + tile.offsetLeft + tile.offsetWidth;
    var dx = pos.c === 0 ? 0 : Math.max(0, tileRight - (window.innerWidth - 60));
    row.tilesEl.style.transform = 'translateX(' + (-dx) + 'px)';
  }

  /* ---------- all apps list ---------- */

  function openList() {
    if (!apps) return toast('Still looking for your apps. Try again in a second.');
    // Your apps first, then hidden built-in ones at the bottom.
    var sorted = apps.slice().sort(function (a, b) {
      if (!!a.hidden !== !!b.hidden) return a.hidden ? 1 : -1;
      return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
    });
    listEl.innerHTML = '';
    for (var i = 0; i < sorted.length; i++) {
      var li = document.createElement('li');
      var n = document.createElement('span');
      n.textContent = sorted[i].name || sorted[i].id;
      var id = document.createElement('span');
      id.className = 'app-id';
      id.textContent = sorted[i].id + (sorted[i].hidden ? ' (hidden)' : '');
      li.appendChild(n);
      li.appendChild(id);
      li.setAttribute('data-id', sorted[i].id);
      li.setAttribute('data-name', sorted[i].name || sorted[i].id);
      listEl.appendChild(li);
    }
    overlayEl.hidden = false;
    mode = 'list';
    focusListItem(0);
  }

  function closeList() {
    overlayEl.hidden = true;
    mode = 'grid';
  }

  function focusListItem(i) {
    var items = listEl.children;
    if (!items.length) return;
    if (items[listIndex]) items[listIndex].className = '';
    listIndex = Math.max(0, Math.min(items.length - 1, i));
    var li = items[listIndex];
    li.className = 'is-focused';
    var top = li.offsetTop;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + li.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = top + li.offsetHeight - listEl.clientHeight;
    }
  }

  /* ---------- keys ---------- */

  function isBack(code) { return code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE; }

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;

    if (mode === 'frame') {
      if (isBack(code)) { e.preventDefault(); closeDashboard(); }
      return;
    }

    if (mode === 'list') {
      e.preventDefault();
      if (code === KEY.UP) focusListItem(listIndex - 1);
      else if (code === KEY.DOWN) focusListItem(listIndex + 1);
      else if (code === KEY.ENTER) {
        var li = listEl.children[listIndex];
        if (li) launchById(li.getAttribute('data-id'), li.getAttribute('data-name'));
      } else if (isBack(code)) closeList();
      return;
    }

    if (code === KEY.LEFT) { e.preventDefault(); focusTile(pos.r, pos.c - 1); }
    else if (code === KEY.RIGHT) { e.preventDefault(); focusTile(pos.r, pos.c + 1); }
    else if (code === KEY.UP) { e.preventDefault(); focusTile(pos.r - 1, pos.c); }
    else if (code === KEY.DOWN) { e.preventDefault(); focusTile(pos.r + 1, pos.c); }
    else if (code === KEY.ENTER) { e.preventDefault(); activate(rows[pos.r].tiles[pos.c]); }
    else if (isBack(code)) { e.preventDefault(); /* the hub is home; Back stays here */ }
  });

  /* ---------- start ---------- */

  build();
  tick();
  setInterval(tick, 15000);
  loadApps(1);
})();
