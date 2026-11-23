/*
 * The Guest mode PIN pop-up. Turning Guest mode on or off on the Clock page
 * (app/widgets/today.js) asks for a 4-digit PIN first; the Pi checks it
 * (POST /guest/pin, pi/guestpin.js), never this file.
 *
 *   HUB_PIN.ask({ on: true, post: ctx.live.post }, function (ok) { ... })
 *       on    true when Guest mode is being turned on (the title says which)
 *       post  POST JSON to the Pi: post(path, body, cb(err, data, status));
 *             HUB_LIVE.post when left out
 *       ok    true once the PIN was right (or a new one was created);
 *             false when cancelled. Never called twice.
 *   HUB_PIN.isOpen()     the pop-up is showing
 *   HUB_PIN.cancel()     closes it as if Back was pressed with no digits
 *   HUB_PIN.state()      { stage, filled, message, locked, busy, focus } (tests)
 *
 * Input: the remote's number keys (keyCode 48-57, and the numpad's 96-105)
 * or the on-screen keypad (arrows and OK, or a click). Only four dots show,
 * never a digit, and there is no text box, so nothing but digits can get
 * in. Back, Escape or Backspace takes the last digit off, or cancels when
 * there is none. The fourth digit sends it. While open, every key is
 * caught here first (capture phase) and kept from the hub's own handler.
 *
 * Stages: 'enter' (a PIN is set), 'create' then 'confirm' (none yet: the
 * Pi says so). Wrong: the dots clear with a short nudge and "Wrong PIN".
 * Locked by the Pi (3 wrong in a row): "Too many tries. Try again in 25 s",
 * counting down once a second, digits ignored meanwhile. The Pi not
 * answering: "Can't reach the hub. Try again." and nothing changes (fails
 * closed).
 *
 * Animates only opacity and transform; body.motion-fade and reduced motion
 * keep the fade only. Loads before the widgets and after i18n.js. Plain ES5.
 */
(function () {
  'use strict';

  var LENGTH = 4;
  var ROUTE = '/guest/pin';
  var DIGIT_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  // The keypad, row by row: 'c' is Cancel, 'd' Delete.
  var PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'c', '0', 'd'];
  var COLS = 3;
  var LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/>' +
    '<path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75"/><path d="M12 14.5v2.25"/></svg>';

  var S = null;            // the open pop-up, or null
  var registered = false;  // the remote's number keys asked for (Tizen)

  function T(key, english, vars) {
    var L = window.HUB_I18N;
    var s = english;
    try { if (L && typeof L.t === 'function') s = String(L.t('pin.' + key, english, vars)); } catch (e) { s = english; }
    if (vars && s === english) {
      for (var k in vars) if (vars.hasOwnProperty(k)) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function now() { return new Date().getTime(); }

  // The remote's number keys reach a Tizen web app only once asked for.
  function registerDigits() {
    if (registered) return;
    registered = true;
    try {
      if (window.tizen && tizen.tvinputdevice) {
        for (var i = 0; i < DIGIT_KEYS.length; i++) {
          try { tizen.tvinputdevice.registerKey(DIGIT_KEYS[i]); } catch (e) { /* not on this remote */ }
        }
      }
    } catch (e) { /* not a TV */ }
  }

  /* ---------- drawing ---------- */

  function build(on) {
    var wrap = el('div', 'pin-wrap');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    var card = el('div', 'pin-card', wrap);
    var info = el('div', 'pin-info', card);
    var icon = el('div', 'pin-icon', info);
    icon.innerHTML = LOCK_SVG;
    var title = el('div', 'pin-title', info, on ? T('titleOn', 'Turn on Guest mode') : T('titleOff', 'Turn off Guest mode'));
    var sub = el('div', 'pin-sub', info);
    var dots = el('div', 'pin-dots', info);
    var dotEls = [];
    for (var i = 0; i < LENGTH; i++) {
      var d = el('span', 'pin-dot', dots);
      el('span', 'pin-dot-fill', d);
      dotEls.push(d);
    }
    var msg = el('div', 'pin-msg', info);
    msg.setAttribute('aria-live', 'polite');
    el('div', 'pin-hint', info, T('hint', 'The number keys on the remote work too.'));

    var pad = el('div', 'pin-pad', card);
    var keys = [];
    var row = null;
    for (var k = 0; k < PAD.length; k++) {
      if (k % COLS === 0) row = el('div', 'pin-row', pad);
      var v = PAD[k];
      var cls = 'pin-key' + (v === 'c' || v === 'd' ? ' pin-key-word' : '');
      var key = el('div', cls, row, v === 'c' ? T('cancel', 'Cancel') : v === 'd' ? T('delete', 'Delete') : v);
      key.setAttribute('data-pin', v);
      key.addEventListener('click', (function (index) {
        return function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!S) return;
          setFocus(index);
          activate(PAD[index]);
        };
      })(k));
      keys.push(key);
    }
    // A click on the dimmed screen around the card does nothing (no stray close).
    wrap.addEventListener('click', function (e) { e.stopPropagation(); });
    return { wrap: wrap, card: card, title: title, sub: sub, dots: dots, dotEls: dotEls, msg: msg, keys: keys };
  }

  function drawSub() {
    var text = S.stage === 'create' ? T('create', 'Create a 4-digit PIN') :
      S.stage === 'confirm' ? T('confirm', 'Enter it again to confirm') : T('enter', 'Enter your 4-digit PIN');
    if (S.ui.sub.textContent !== text) S.ui.sub.textContent = text;
  }

  function drawDots() {
    for (var i = 0; i < LENGTH; i++) {
      var want = 'pin-dot' + (i < S.digits.length ? ' is-filled' : '');
      if (S.ui.dotEls[i].className !== want) S.ui.dotEls[i].className = want;
    }
  }

  function setMessage(text, kind) {
    S.message = text || '';
    S.ui.msg.textContent = S.message;
    S.ui.msg.className = 'pin-msg' + (S.message ? ' is-shown' : '') + (kind ? ' is-' + kind : '');
  }

  function setFocus(index) {
    if (index < 0 || index >= S.ui.keys.length) return;
    if (S.focus >= 0) S.ui.keys[S.focus].className = S.ui.keys[S.focus].className.replace(/ is-focused/g, '');
    S.focus = index;
    S.ui.keys[index].className += ' is-focused';
  }

  // The short sideways nudge on a wrong PIN or a mismatch: the class comes
  // off and on again so the animation runs each time.
  function nudge() {
    var d = S.ui.dots;
    d.className = 'pin-dots';
    void d.offsetWidth;
    d.className = 'pin-dots is-wrong';
  }

  function pressKey(index) {
    var key = S.ui.keys[index];
    if (!key) return;
    key.className += ' is-pressed';
    setTimeout(function () { key.className = key.className.replace(/ is-pressed/g, ''); }, 140);
  }

  /* ---------- the countdown after too many tries ---------- */

  function lockFor(seconds) {
    S.lockedUntil = now() + Math.max(1, seconds) * 1000;
    tickLock();
  }

  function tickLock() {
    if (!S) return;
    if (S.lockTimer) { clearTimeout(S.lockTimer); S.lockTimer = null; }
    var left = Math.ceil((S.lockedUntil - now()) / 1000);
    if (left <= 0) {
      S.lockedUntil = 0;
      setMessage('');
      return;
    }
    setMessage(T('locked', 'Too many tries. Try again in {n} s', { n: left }), 'error');
    // Text only, once a second, just after each whole second left.
    var ms = (S.lockedUntil - now()) % 1000 || 1000;
    S.lockTimer = setTimeout(tickLock, ms + 20);
  }

  function locked() { return !!S && S.lockedUntil > now(); }

  /* ---------- talking to the Pi ---------- */

  function send(body, cb) {
    var post = S.post;
    var mine = S;
    S.busy = true;
    S.ui.card.className = 'pin-card is-busy';
    var finished = false;
    function done(err, data, code) {
      if (finished) return;
      finished = true;
      if (S !== mine) return;          // closed meanwhile
      S.busy = false;
      S.ui.card.className = 'pin-card';
      cb(err, data || null, code || 0);
    }
    try {
      if (typeof post !== 'function') throw new Error('no line to the Pi');
      post(ROUTE, body, function (err, data, code) { done(err || (data && data.ok === true ? null : 'bad reply'), data, code); });
    } catch (e) {
      setTimeout(function () { done('not reachable', null); }, 0);
    }
  }

  function unreachable() {
    S.digits = '';
    drawDots();
    setMessage(T('unreachable', 'Can’t reach the hub. Try again.'), 'error');
  }

  function askStatus() {
    send({ action: 'status' }, function (err, data) {
      if (err) { unreachable(); return; }
      if (data.set === false && S.stage === 'enter' && !S.digits) { S.stage = 'create'; drawSub(); }
      if (data.locked_for > 0) lockFor(data.locked_for);
    });
  }

  function submit() {
    var pin = S.digits;
    if (S.stage === 'create') {
      S.first = pin;
      S.digits = '';
      S.stage = 'confirm';
      drawSub();
      drawDots();
      return;
    }
    if (S.stage === 'confirm') {
      if (pin !== S.first) {
        S.first = '';
        S.digits = '';
        S.stage = 'create';
        drawSub();
        drawDots();
        nudge();
        setMessage(T('mismatch', 'The PINs didn’t match. Start again.'), 'error');
        return;
      }
      send({ action: 'set', pin: pin }, function (err, data, code) {
        S.first = '';
        if (err && code !== 409) {
          S.stage = 'create';
          drawSub();
          unreachable();
          return;
        }
        if (err) {
          // One was set meanwhile (409): ask for it like any other time.
          S.stage = 'enter';
          S.digits = '';
          drawSub();
          drawDots();
          setMessage('');
          return;
        }
        finish(true);
      });
      return;
    }
    send({ action: 'check', pin: pin }, function (err, data) {
      if (err) { unreachable(); return; }
      if (data.match === true) { finish(true); return; }
      S.digits = '';
      drawDots();
      if (data.set === false) {
        // No PIN on the Pi (reset meanwhile): create one.
        S.stage = 'create';
        drawSub();
        setMessage('');
        return;
      }
      nudge();
      if (data.locked_for > 0) lockFor(data.locked_for);
      else setMessage(T('wrong', 'Wrong PIN'), 'error');
    });
  }

  /* ---------- input ---------- */

  function digit(d) {
    if (S.busy || locked() || S.digits.length >= LENGTH) return;
    if (S.digits.length === 0 && S.message) setMessage('');
    if (S.ui.dots.className !== 'pin-dots') S.ui.dots.className = 'pin-dots';
    S.digits += d;
    drawDots();
    if (S.digits.length === LENGTH) submit();
  }

  function back() {
    if (S.busy) return;
    if (S.digits.length) {
      S.digits = S.digits.slice(0, -1);
      drawDots();
      return;
    }
    finish(false);
  }

  function activate(v) {
    if (!S) return;
    pressKey(S.focus);
    if (v === 'c') finish(false);
    else if (v === 'd') back();
    else digit(v);
  }

  function move(dx, dy) {
    var r = Math.floor(S.focus / COLS);
    var c = S.focus % COLS;
    var rows = Math.ceil(PAD.length / COLS);
    r = Math.max(0, Math.min(rows - 1, r + dy));
    c = Math.max(0, Math.min(COLS - 1, c + dx));
    setFocus(r * COLS + c);
  }

  function digitOf(e) {
    var c = e.keyCode;
    if (e.ctrlKey || e.metaKey || e.altKey) return '';
    // Shift+1 is "!" on a keyboard: go by the character when there is one.
    if (e.key && e.key !== 'Unidentified' && e.key.length === 1 && !/^[0-9]$/.test(e.key)) return '';
    if (c >= 48 && c <= 57) return String(c - 48);
    if (c >= 96 && c <= 105) return String(c - 96);
    return '';
  }

  function onKey(e) {
    if (!S) return;
    // Every key is ours while the pop-up shows; the hub never sees it.
    e.preventDefault();
    e.stopPropagation();
    var c = e.keyCode;
    var d = digitOf(e);
    if (d) { if (!e.repeat) digit(d); return; }
    if (c === 10009 || c === 27 || c === 8) { if (!e.repeat) back(); return; }
    if (c === 13) { if (!e.repeat) activate(PAD[S.focus]); return; }
    if (c === 37) move(-1, 0);
    else if (c === 39) move(1, 0);
    else if (c === 38) move(0, -1);
    else if (c === 40) move(0, 1);
  }

  /* ---------- open and close ---------- */

  function finish(ok) {
    if (!S) return;
    var s = S;
    S = null;
    if (s.lockTimer) clearTimeout(s.lockTimer);
    if (s.ui.wrap.parentNode) s.ui.wrap.parentNode.removeChild(s.ui.wrap);
    try { s.done(!!ok); } catch (e) {
      try { if (window.console && console.warn) console.warn('Guest PIN: ' + (e && e.message)); } catch (e2) { /* ignore */ }
    }
  }

  function ask(opts, done) {
    opts = opts || {};
    if (S) finish(false);
    registerDigits();
    var post = opts.post;
    if (typeof post !== 'function' && window.HUB_LIVE && typeof window.HUB_LIVE.post === 'function') {
      post = function (p, b, cb) { return window.HUB_LIVE.post(p, b, cb); };
    }
    var ui = build(!!opts.on);
    S = {
      ui: ui, post: post, done: typeof done === 'function' ? done : function () {},
      stage: 'enter', digits: '', first: '', message: '', busy: false,
      lockedUntil: 0, lockTimer: null, focus: -1
    };
    drawSub();
    drawDots();
    setFocus(0);
    document.body.appendChild(ui.wrap);
    // One frame later, so the fade in has something to start from.
    var mine = S;
    setTimeout(function () { if (S === mine) ui.wrap.className = 'pin-wrap is-shown'; }, 20);
    askStatus();
  }

  document.addEventListener('keydown', onKey, true);

  window.HUB_PIN = {
    ask: ask,
    isOpen: function () { return !!S; },
    cancel: function () { finish(false); },
    state: function () {
      if (!S) return null;
      return { stage: S.stage, filled: S.digits.length, message: S.message, locked: locked(), busy: S.busy,
        focus: S.focus >= 0 ? PAD[S.focus] : '' };
    }
  };
})();
