/*
 * Moods on a phone, tablet or computer: the touch view of the plant wall's
 * moods (app/touch.html; the TV and the wall tablet keep app/widgets/moods.js).
 * The same resource "moods" from the Pi, read from GET /touch/state, and the
 * same door: a tap POSTs /moods/set ({ id } or { off: true }, with bri,
 * night and pair), shown at once ("Sending..."), confirmed by the Pi's next
 * state or put back with a plain line.
 *
 * The phone (390 px): the lit wall on top (app/moods-wall.js), the mood's
 * name and description, a real slider for brightness, the Lamp and bars
 * switch and, for Menorah, the night; then "Whole wall" and "Vases" as cards
 * in two columns, Off first. Every target is 2.75rem or more.
 *
 * Words come from app/i18n.js (keys 'moods.'); mood names and descriptions
 * carry their own Spanish (es, descEs). Plain ES5.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var PENDING_MS = 12000;

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isHex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }
  function str(v, max) { var s = typeof v === 'string' ? v : ''; return s.length > max ? s.slice(0, max) : s; }
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function rgba(hex, a) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? 'rgba(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ', ' + a + ')' : 'transparent';
  }

  function moodsOf(d) {
    var out = [];
    var src = d && isArr(d.moods) ? d.moods : [];
    for (var i = 0; i < src.length && out.length < 40; i++) {
      var m = src[i];
      if (!m || typeof m.id !== 'string' || m.hidden === true || m.id === 'off') continue;
      var sw = [];
      for (var k = 0; isArr(m.sw) && k < m.sw.length && sw.length < 4; k++) if (isHex(m.sw[k])) sw.push(m.sw[k]);
      var tags = [];
      for (var t = 0; isArr(m.tags) && t < m.tags.length; t++) if (/^(mic|song|pi|approx)$/.test(m.tags[t])) tags.push(m.tags[t]);
      var night = m.param && m.param.night && typeof m.param.night === 'object' ? m.param.night : null;
      out.push({ id: m.id, name: str(m.name, 48) || m.id, es: str(m.es, 60), desc: str(m.desc, 140), descEs: str(m.descEs, 170),
        group: m.group === 'vases' ? 'vases' : 'wall', sw: sw, tags: tags, bri: typeof m.bri === 'number' ? m.bri : 100,
        night: night ? { min: Math.max(1, night.min | 0 || 1), max: Math.min(8, night.max | 0 || 8) } : null,
        pv: m.pv && typeof m.pv === 'object' ? m.pv : null });
    }
    return out;
  }
  function find(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function nowId(d) { var n = d && d.now; return n && typeof n.id === 'string' && n.id && n.id !== 'off' ? n.id : null; }

  function renderTouch(host, ctx) {
    var t = ctx.t;
    var st = { pending: null, note: null, bri: null, night: null, pair: null, dragging: false, sig: '' };
    var root = el('div', 'mt-root', host);

    function T(key, en, vars) { return t('moods.' + key, en, vars); }
    function es() { return ctx.lang() === 'es'; }
    function nameOf(m) { return !m ? T('off', 'Off') : es() && m.es ? m.es : m.name; }
    function descOf(m) { return !m ? T('offDesc', 'The wall goes back to how it was.') : es() && m.descEs ? m.descEs : m.desc; }
    function tagWord(x) {
      return x === 'mic' ? T('tag.mic', 'Mic') : x === 'song' ? T('tag.song', 'Song') : x === 'pi' ? T('tag.pi', 'Pi-drawn') : T('tag.approx', 'Approximate');
    }
    function current(d) {
      if (st.pending && new Date().getTime() - st.pending.at < PENDING_MS) return st.pending.id === 'off' ? null : st.pending.id;
      return nowId(d);
    }
    function briOf(d, m) {
      if (st.bri !== null) return st.bri;
      var n = d && d.now;
      return n && m && n.id === m.id && typeof n.bri === 'number' ? Math.round(n.bri) : (m ? m.bri : 100);
    }
    function pairOn(d) { if (st.pair !== null) return st.pair; var n = d && d.now; return !(n && n.pair === false); }
    function nightOf(d, m) {
      if (!m || !m.night) return null;
      var n = d && d.now;
      var v = st.night !== null ? st.night : (n && n.id === m.id && typeof n.night === 'number' ? n.night : m.night.min);
      return Math.max(m.night.min, Math.min(m.night.max, Math.round(v)));
    }

    // The Pi's refusals are English sentences (pi/moods/controller.js); the
    // phone says them in its own words, in the chosen language.
    function failText(msg) {
      var s = String(msg || '');
      if (/slow down/i.test(s)) return T('errBusy', 'Too many presses. Try again in a moment.');
      if (/not set up|WLED_URL/.test(s)) return T('errNotSet', 'The wall isn’t set up on the Pi yet.');
      if (/saved mood|no mood with that id/i.test(s)) return T('errGone', 'That mood isn’t saved on the Pi any more.');
      if (/wall (did not|didn’t) answer|wall refused|wall isn/i.test(s)) return T('errWall', 'The wall didn’t answer. Nothing changed.');
      return T('errPi', 'Couldn’t reach the Pi. Nothing changed.');
    }

    function send(body, done) {
      ctx.call('POST', '/moods/set', body).then(function (j) {
        if (j && j.result === 'failed') throw new Error('the wall did not answer');
        done(null, j);
      }).then(null, function (e) { done(failText(e && e.message)); });
    }

    function apply(id, d) {
      var ms = moodsOf(d);
      var m = id === 'off' ? null : find(ms, id);
      st.pending = { id: id, at: new Date().getTime() };
      st.bri = null;
      st.note = { text: T('sending', 'Sending…'), kind: '' };
      draw(true);
      var body = id === 'off' ? { off: true } : { id: id };
      if (st.pair !== null) body.pair = st.pair;
      if (m && m.night) body.night = nightOf(d, m);
      send(body, function (err) {
        if (err) { st.pending = null; st.note = { text: err, kind: 'bad' }; }
        else st.note = { text: m ? T('moodOn', '{name} is on', { name: nameOf(m) }) : T('offDone', 'The wall is back to how it was'), kind: '' };
        draw(true);
        ctx.refresh();
      });
    }

    function sendFor(id, extra) {
      var body = { id: id };
      for (var k in extra) if (extra.hasOwnProperty(k)) body[k] = extra[k];
      send(body, function (err) {
        if (err) { st.bri = null; st.night = null; st.note = { text: err, kind: 'bad' }; draw(true); }
        ctx.refresh();
      });
    }

    function draw(force) {
      var d = ctx.data();
      var sig = JSON.stringify([ctx.lang(), ctx.status(), d && d.now, d && d.state, st.pending && st.pending.id, st.note && st.note.text, st.bri, st.night, st.pair]);
      if (!force && (sig === st.sig || st.dragging)) return;
      st.sig = sig;
      // The Pi's state confirms what was on its way.
      if (st.pending && nowId(d) === (st.pending.id === 'off' ? null : st.pending.id)) st.pending = null;
      while (root.firstChild) root.removeChild(root.firstChild);
      if (!d || !isArr(d.moods)) {
        el('div', 'mt-name', root, ctx.status() === 'offline' ? T('offline', 'Can’t reach the Pi') : T('waiting', 'Waiting for the Pi'));
        el('div', 'mt-desc', root, T('waitingHint', 'The moods come from the Pi.'));
        return;
      }
      var ms = moodsOf(d);
      if (d.state === 'notset' || !ms.length) {
        el('div', 'mt-name', root, T('notSet', 'Not set up'));
        el('div', 'mt-desc', root, T('notSetHint', 'The Pi doesn’t know the wall’s address yet.'));
        return;
      }
      var curId = current(d);
      var m = find(ms, curId);
      var hero = el('div', 'mt-hero', root);
      var wallHost = el('div', 'mt-hero-wall', hero);
      var W = window.HUB_MOODS_WALL;
      if (W && d.wall && d.wall.geometry) {
        var box = el('div', 'md-wallbox', wallHost);
        var view = W.build(box, d.wall);
        W.paint(view, m ? m.pv : null, { level: m ? briOf(d, m) / 100 : 1, night: nightOf(d, m) });
      }
      var pend = st.pending && st.pending.id === (curId || 'off');
      var chip = el('div', 'md-chip' + (m ? ' is-on' : ' is-off') + (pend ? ' is-pending' : ''), hero);
      var dot = el('i', 'md-chip-dot', chip);
      if (m && m.sw[0]) dot.style.backgroundColor = m.sw[0];
      el('span', 'md-chip-text', chip, pend ? T('sending', 'Sending…') : m ? T('onNow', 'On now') : T('offNow', 'Off now'));

      var cap = el('div', 'mt-cap', root);
      el('div', 'mt-name', cap, nameOf(m));
      el('div', 'mt-desc', cap, descOf(m));
      var noteText = st.note ? st.note.text : '', noteKind = st.note ? st.note.kind : '';
      if (!noteText && d.state === 'error') { noteText = T('wallAway', 'The wall isn’t answering'); noteKind = 'bad'; }
      else if (!noteText && d.now && d.now.stale) { noteText = T('changed', 'Changed somewhere else'); noteKind = 'warn'; }
      if (noteText) el('div', 'mt-note' + (noteKind ? ' is-' + noteKind : ''), cap, noteText);

      var ctls = el('div', 'mt-ctls', root);
      // Brightness: a real slider.
      var row = el('label', 'mt-ctl', ctls);
      el('span', 'mt-ctl-label', row, T('bri', 'Brightness'));
      var range = el('input', 'mt-range', row);
      range.type = 'range';
      range.min = '10';
      range.max = '100';
      range.step = '10';
      range.value = String(m ? briOf(d, m) : 100);
      range.disabled = !m;
      range.setAttribute('aria-label', T('bri', 'Brightness'));
      if (m && m.sw[0]) range.style.accentColor = m.sw[0];
      var val = el('span', 'mt-ctl-value', row, m ? T('pct', '{n}%', { n: range.value }) : T('offShort', 'Off'));
      range.addEventListener('input', function () { st.dragging = true; val.textContent = T('pct', '{n}%', { n: range.value }); });
      range.addEventListener('change', function () {
        st.dragging = false;
        st.bri = Number(range.value);
        if (m) sendFor(m.id, { bri: st.bri });
        draw(true);
      });
      // Lamp and bars.
      var prow = el('div', 'mt-ctl', ctls);
      el('span', 'mt-ctl-label', prow, T('pair', 'Lamp and bars'));
      var on = pairOn(d);
      var sw = el('button', 'mt-switch', prow, on ? T('pairWith', 'With the mood') : T('pairLeave', 'Leave as they are'));
      sw.type = 'button';
      sw.setAttribute('aria-pressed', on ? 'true' : 'false');
      sw.addEventListener('click', function () {
        st.pair = !on;
        if (m) sendFor(m.id, { pair: st.pair });
        draw(true);
      });
      // Menorah's night.
      if (m && m.night) {
        var n = nightOf(d, m);
        var nrow = el('div', 'mt-ctl', ctls);
        el('span', 'mt-ctl-label', nrow, T('night', 'Night'));
        var step = el('div', 'mt-step', nrow);
        var dn = el('button', 'mt-step-btn', step, '−');
        dn.type = 'button';
        dn.disabled = n <= m.night.min;
        dn.setAttribute('aria-label', T('nightLess', 'One night less'));
        el('span', 'mt-step-value', step, T('nightOf', '{n} of {max}', { n: n, max: m.night.max }));
        var up = el('button', 'mt-step-btn', step, '+');
        up.type = 'button';
        up.disabled = n >= m.night.max;
        up.setAttribute('aria-label', T('nightMore', 'One night more'));
        var stepBy = function (k) { return function () { st.night = Math.max(m.night.min, Math.min(m.night.max, n + k)); sendFor(m.id, { night: st.night }); draw(true); }; };
        dn.addEventListener('click', stepBy(-1));
        up.addEventListener('click', stepBy(1));
      }

      var groups = [['wall', T('rowWall', 'Whole wall')], ['vases', T('rowVases', 'Vases')]];
      for (var g = 0; g < groups.length; g++) {
        var sec = el('section', 'mt-sec', root);
        el('h3', 'mt-label', sec, groups[g][1]);
        var cards = el('div', 'mt-cards', sec);
        if (g === 0) card(cards, null, curId, d);
        for (var i = 0; i < ms.length; i++) if (ms[i].group === groups[g][0]) card(cards, ms[i], curId, d);
      }
    }

    function card(parent, m, curId, d) {
      var id = m ? m.id : 'off';
      var active = m ? curId === m.id : !curId;
      var b = el('button', 'mt-card' + (active ? ' is-active' : ''), parent);
      b.type = 'button';
      b.setAttribute('data-mood', id);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      var inner = el('span', 'mt-card-in', b);
      var top = el('span', 'md-card-top', inner);
      if (m) {
        var row = el('span', 'md-sw md-sw-card', top);
        for (var i = 0; i < 4; i++) {
          var s = el('i', 'md-sw-dot' + (m.sw[i] ? '' : ' is-dark'), row);
          if (m.sw[i]) { s.style.backgroundColor = m.sw[i]; s.style.boxShadow = '0 0 0.45rem ' + rgba(m.sw[i], 0.55); }
        }
      } else {
        el('span', 'md-sw-dot is-dark', top);
      }
      el('span', 'md-card-name', inner, nameOf(m));
      el('span', 'md-card-desc', inner, descOf(m));
      var foot = el('span', 'md-tags md-card-foot', inner);
      var sending = st.pending && st.pending.id === id;
      if (sending) el('span', 'md-state is-pending', foot, T('sending', 'Sending…'));
      else if (active) el('span', 'md-state is-on', foot, m ? T('onNow', 'On now') : T('offNow', 'Off now'));
      var tags = m ? m.tags : [];
      for (var k = 0; k < tags.length && k < (sending || active ? 1 : 2); k++) el('span', 'md-tag', foot, tagWord(tags[k]));
      b.addEventListener('click', function () { if (!active) apply(id, ctx.data()); });
    }

    draw(true);
    return { update: function () { draw(false); }, destroy: function () { while (root.firstChild) root.removeChild(root.firstChild); } };
  }

  var w = {
    id: 'moods',
    title: 'Moods',
    titleKey: 'moods.title',
    resource: 'moods',
    touchIcon: 'M11 3l1.8 4.9L17.5 9.7l-4.7 1.8L11 16.5l-1.8-5L4.5 9.7l4.7-1.8zM18.5 14.5l.8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9z',
    renderTouch: renderTouch,
    summary: function (d, t) {
      var id = nowId(d);
      var m = find(moodsOf(d), id);
      var lang = window.HUB_I18N && window.HUB_I18N.lang ? window.HUB_I18N.lang() : 'en';
      return m ? (lang === 'es' && m.es ? m.es : m.name) : t('moods.off', 'Off');
    }
  };
  return w;
})());
