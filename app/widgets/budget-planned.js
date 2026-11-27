/*
 * Planned buys in Budget lab: the list the budget app keeps (the budget
 * snapshot's `planned` section, docs/budget-snapshot.md), and adding,
 * changing and removing one with the remote. Not a widget of its own:
 * app/widgets/budget-lab.js draws it at full screen in its right column
 * (in the panel size under the merchants) and passes it the keys.
 *
 * The budget app is the only home of the list. A change goes to the Pi
 * (POST /budget/planned, pi/budgetplanned.js), which passes it on to the
 * budget app and pushes back the budget app's whole list; nothing is kept
 * on the TV, so what shows here is always what the budget app has.
 *
 * The list: one row per buy, in the owner's order (the budget app's). Top
 * line: the label and the amount; under it the day and its state: "Fri,
 * Dec 4 · in 6 days", "No date", "Mon, Dec 7 · after card day" (later: not
 * counted yet), "Nov 22 · overdue" (coral), "Bought Nov 23 at Lamp Shop ·
 * $34.50" (matched: green, a check mark, the planned amount struck). The
 * line under the heading says bought ones stay out of the daily goal. The
 * last row is "+ Add a planned buy". Rows take focus; OK opens one.
 *
 * The form opens in place of the list (Back leaves it): What and Shop (text
 * boxes, OK types with the TV's keyboard; the shop is the words the charge
 * must hold: the budget app matches only a buy that has one, at 85 to 150%
 * of its amount), Amount (Left and Right
 * $1 a press, a held key $5 after 0.8 s and $25 after 2 s; OK types
 * digits), the Date (Left and Right a day, a held key a week; OK: no date),
 * then Save, Remove (a buy that is there already; OK twice) and Cancel side
 * by side. A bought buy says which charge it matched and adds "Not this
 * charge" (the budget app looks for another). While the form is open focus
 * stays in it.
 *
 * Guest mode (guest.js): the amounts blur like the rest of the lab, the
 * rows take no focus and there is no Add row, so nothing opens; a form that
 * is open when Guest mode turns on closes, unsaved.
 *
 * Words: EN below; the Spanish is in app/i18n.js under 'budgetPlanned.<path>'.
 * Plain ES5 for the TV's browser.
 */
(function () {
  'use strict';

  var EN = {
    head: 'Planned buys',
    sub: 'Bought ones stay out of your daily goal',
    subShort: 'Bought ones skip your goal',
    none: 'Nothing planned yet',
    add: 'Add a planned buy',
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    // {mon} short month, {d} day, {wd} short weekday
    dateShort: '{mon} {d}',
    dateDay: '{wd}, {mon} {d}',
    cash: '${n}',
    sep: ' · ',
    today: 'today',
    tomorrow: 'tomorrow',
    inDays: 'in {n} days',
    daysAgo: '{n} days ago',
    yesterday: 'yesterday',
    overdue: 'overdue',
    later: 'after card day',
    noDate: 'No date',
    bought: 'Bought {d}',
    boughtAt: 'Bought {d} at {shop}',
    // The form
    newHead: 'New planned buy',
    editHead: 'Planned buy',
    what: 'What',
    whatHint: 'e.g. Winter boots',
    shop: 'Shop, to match the charge',
    shopHint: 'Words on the charge, e.g. Zappos',
    shopNote: 'Without a shop it is never matched to a charge',
    amount: 'Amount',
    date: 'Date',
    arrowsHint: '◀ ▶ change · OK type',
    dateHint: '◀ ▶ a day · hold for a week · OK no date',
    save: 'Save',
    remove: 'Remove',
    removeArmed: 'OK again to remove',
    unmatch: 'Not this charge',
    cancel: 'Cancel',
    saving: 'Saving…',
    boughtNote: 'It stays out of your daily goal.',
    needWhat: 'Say what it is first',
    needAmount: 'Set an amount first',
    saved: 'Saved to your budget',
    removed: 'Removed from your budget',
    unmatched: 'The budget app will look for another charge',
    failed: 'Could not reach the budget app. Nothing changed.'
  };

  var STRINGS = EN;
  function localizeStrings() {
    var x = window.HUB_I18N;
    try { STRINGS = x && typeof x.localize === 'function' ? x.localize(EN, 'budgetPlanned') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();
  try {
    if (window.HUB_I18N && typeof window.HUB_I18N.onChange === 'function') window.HUB_I18N.onChange(localizeStrings);
  } catch (e) { /* stays in the language it started in */ }

  var MAX_LABEL = 24;       // the budget app's limits
  var MAX_MATCH = 40;
  var MAX_AMOUNT = 1000000;
  var HOLD_GAP = 250;       // ms: presses closer than this are one hold
  var DAY_MS = 86400000;
  var PAST_DAYS = 60;       // the date can go this far back (a buy already made)
  var AHEAD_DAYS = 400;     // and this far ahead

  // The form, while it is open: { id (null for a new one), label, amount,
  // date, matched, armed (Remove pressed once), sending }.
  var S = { form: null, hold: null, refs: null, listeners: [] };

  /* ---------- helpers ---------- */

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  function fill(text, map) {
    return String(text).replace(/\{(\w+)\}/g, function (all, k) { return map.hasOwnProperty(k) ? String(map[k]) : all; });
  }
  function warn(text) { try { console.log('Budget lab: planned: ' + text); } catch (e) { /* no console */ } }
  function guestOn() { try { return !!(window.HUB_GUEST && window.HUB_GUEST.on()); } catch (e) { return false; } }
  function B() { return window.HUB_BUDGET; }

  function fmtNum(n) {
    var s = String(Math.abs(n));
    while (/\d{4}/.test(s)) s = s.replace(/(\d)(\d{3})(?!\d)/, '$1,$2');
    return s;
  }
  // Whole dollars, rounded to the nearest; cents only when there are some on an exact figure.
  function cash(n) {
    var c = Math.round(n * 100);
    var whole = c % 100 === 0 ? fmtNum(c / 100) : fmtNum(Math.floor(c / 100)) + '.' + ('0' + (c % 100)).slice(-2);
    return fill(STRINGS.cash, { n: whole });
  }

  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  // The TV's own today, as a date.
  function todayIso() {
    try { if (B() && typeof B().today === 'function') return B().today(); } catch (e) { /* the TV's clock below */ }
    var d = new Date();
    return iso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  function daysFrom(today, s) { return Math.round((parse(s) - parse(today)) / DAY_MS); }
  function dateShort(s) {
    var d = new Date(parse(s));
    return fill(STRINGS.dateShort, { mon: STRINGS.monthsShort[d.getUTCMonth()], d: d.getUTCDate() });
  }
  function dateDay(s) {
    var d = new Date(parse(s));
    return fill(STRINGS.dateDay, { wd: STRINGS.daysShort[d.getUTCDay()], mon: STRINGS.monthsShort[d.getUTCMonth()], d: d.getUTCDate() });
  }
  function away(today, s) {
    var n = daysFrom(today, s);
    if (n === 0) return STRINGS.today;
    if (n === 1) return STRINGS.tomorrow;
    if (n === -1) return STRINGS.yesterday;
    return n > 0 ? fill(STRINGS.inDays, { n: n }) : fill(STRINGS.daysAgo, { n: -n });
  }

  /* ---------- the list ---------- */

  // The section as sent, or null (a budget app without planned buys yet).
  function section() {
    try {
      var d = B() && B().data ? B().data() : null;
      return d && d.planned && d.planned.items ? d.planned : null;
    } catch (e) { return null; }
  }

  function find(id) {
    var s = section();
    for (var i = 0; s && i < s.items.length; i++) if (s.items[i].id === id) return s.items[i];
    return null;
  }

  // The line under a row: when, and its state.
  function stateLine(it, today) {
    if (it.state === 'matched') return { text: boughtText(it), tone: 'is-bought' };
    if (it.state === 'overdue') return { text: (it.date ? dateShort(it.date) + STRINGS.sep : '') + STRINGS.overdue, tone: 'is-over' };
    if (!it.date) return { text: STRINGS.noDate, tone: '' };
    return { text: dateDay(it.date) + STRINGS.sep + (it.state === 'later' ? STRINGS.later : away(today, it.date)), tone: it.state === 'later' ? 'is-later' : '' };
  }

  // "Bought Nov 23 at Lamp Shop · $34.50": when the charge came in and what
  // it was, with the buy's own shop text (the budget app sends no merchant).
  function boughtText(it) {
    var on = it.matchedDate || it.date;
    var t = it.match ? fill(STRINGS.boughtAt, { d: dateShort(on), shop: it.match }) : fill(STRINGS.bought, { d: dateShort(on) });
    return it.matchedAmount !== undefined ? t + STRINGS.sep + cash(it.matchedAmount) : t;
  }

  // A focusable row: the key lets a redraw keep focus on it.
  function row(parent, key, cls) {
    var r = el('div', 'bu-psec bp-row' + (cls ? ' ' + cls : ''), parent);
    if (!guestOn()) {
      r.className += ' f';
      r.setAttribute('data-key', key);
    }
    return r;
  }

  function drawList(box, s) {
    var today = todayIso();
    var focus = [];
    var sub = el('div', 'bl-msub bp-sub', box, STRINGS.sub);
    sub.setAttribute('data-short', STRINGS.subShort);
    var items = s.items; // the owner's order, as the budget app keeps it
    if (!items.length) el('div', 'bp-none', box, STRINGS.none);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var r = row(box, 'planned-' + it.id, it.state === 'matched' ? 'is-bought' : it.state === 'overdue' ? 'is-over' : '');
      r.setAttribute('data-planned', it.id);
      var top = el('div', 'bp-top', r);
      if (it.state === 'matched') el('span', 'bp-check', top, '✓');
      el('span', 'bp-label', top, it.label);
      el('span', 'bp-amount', top, cash(it.amount));
      var st = stateLine(it, today);
      el('div', 'bp-when' + (st.tone ? ' ' + st.tone : ''), r, st.text);
      if (r.className.indexOf(' f') >= 0) focus.push(r);
    }
    if (!guestOn()) {
      var add = row(box, 'planned-add', 'bp-add');
      el('span', 'bp-plus', add, '+');
      el('span', 'bp-add-text', add, STRINGS.add);
      focus.push(add);
    }
    return focus;
  }

  /* ---------- the form ---------- */

  function field(box, key, name, cls) {
    var r = el('div', 'bu-psec f bp-field' + (cls ? ' ' + cls : ''), box);
    r.setAttribute('data-key', key);
    el('div', 'bp-fname', r, name);
    return r;
  }

  function drawForm(box) {
    var f = S.form;
    var refs = { focus: [] };
    var head = box.querySelector('.bu-label');
    if (head) head.textContent = f.id ? STRINGS.editHead : STRINGS.newHead;
    if (f.matched) {
      // Bought: which charge, and that it stays out of the goal. It can still be changed.
      var it = find(f.id);
      if (it) el('div', 'bl-msub bp-note', box, boughtText(it) + '. ' + STRINGS.boughtNote);
    }
    {
      // What, and the shop: the inputs are the focusables (hub.js starts typing on OK).
      refs.focus.push(textBox(box, 'planned-what', STRINGS.what, STRINGS.whatHint, MAX_LABEL, 'label'));
      refs.focus.push(textBox(box, 'planned-shop', STRINGS.shop, STRINGS.shopHint, MAX_MATCH, 'match'));
      el('div', 'bl-msub bp-shopnote', box, STRINGS.shopNote);

      // Amount: Left and Right step it; OK types digits into the box.
      var amt = el('div', 'bp-field bp-amt', box);
      el('div', 'bp-fname', amt, STRINGS.amount);
      var line = el('div', 'bp-aline', amt);
      el('span', 'bp-arrow bp-arrow-l', line, '◀');
      el('span', 'bp-dollar', line, '$');
      var ain = el('input', 'f bp-input bp-ainput', line);
      ain.setAttribute('type', 'tel');
      ain.setAttribute('data-key', 'planned-amount');
      ain.setAttribute('maxlength', '10');
      ain.setAttribute('autocomplete', 'off');
      ain.value = amountText(f.amount);
      ain.setAttribute('placeholder', '0');
      ain.addEventListener('input', function () {
        // Digits and one point; cents kept to two places.
        var m = /^(\d*)(?:[.,](\d{0,2}))?/.exec(String(ain.value).replace(/[^\d.,]/g, ''));
        var v = m ? parseFloat((m[1] || '0') + '.' + (m[2] || '0')) : 0;
        if (S.form) S.form.amount = isNaN(v) ? 0 : Math.min(MAX_AMOUNT, v);
      }, false);
      el('span', 'bp-arrow bp-arrow-r', line, '▶');
      // After the input, so CSS can light them from its focus (sibling selectors).
      el('span', 'bp-fhint bp-ahint', line, STRINGS.arrowsHint);
      el('span', 'bp-frame', line);
      refs.amount = ain;
      refs.focus.push(ain);

      // Date: Left and Right step it.
      var dt = field(box, 'planned-date', STRINGS.date, 'bp-date');
      var dl = el('div', 'bp-aline', dt);
      el('span', 'bp-arrow bp-arrow-l', dl, '◀');
      refs.dateText = el('span', 'bp-dtext', dl);
      el('span', 'bp-arrow bp-arrow-r', dl, '▶');
      refs.dateHint = el('div', 'bp-fhint bp-dhint', dt, STRINGS.dateHint);
      refs.date = dt;
      refs.focus.push(dt);
    }
    // Save, Remove, Cancel side by side: one stop for Up and Down.
    var btns = el('div', 'bp-btns', box);
    refs.buttons = [];
    function button(key, text, cls) {
      var b = el('div', 'bu-psec f bp-btn' + (cls ? ' ' + cls : ''), btns, text);
      b.setAttribute('data-key', key);
      b.setAttribute('role', 'button');
      refs.buttons.push(b);
      return b;
    }
    refs.save = button('planned-save', f.sending === 'save' ? STRINGS.saving : STRINGS.save, 'is-main');
    if (f.matched) button('planned-unmatch', f.sending === 'unmatch' ? STRINGS.saving : STRINGS.unmatch, '');
    if (f.id) refs.remove = button('planned-remove', f.sending === 'remove' ? STRINGS.saving : f.armed ? STRINGS.removeArmed : STRINGS.remove, 'is-remove' + (f.armed ? ' is-armed' : ''));
    button('planned-cancel', STRINGS.cancel, '');
    refs.focus.push(refs.buttons[0]);
    paintDate(refs);
    return refs;
  }

  // A text box with its name over it; the input is the focusable.
  function textBox(box, key, name, hint, max, prop) {
    var wrap = el('div', 'bp-field bp-what', box);
    el('div', 'bp-fname', wrap, name);
    var input = el('input', 'f bp-input', wrap);
    input.setAttribute('type', 'text');
    input.setAttribute('data-key', key);
    input.setAttribute('maxlength', String(max));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'sentences');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', hint);
    input.value = S.form[prop] || '';
    input.addEventListener('input', function () { if (S.form) S.form[prop] = input.value; }, false);
    el('span', 'bp-frame', wrap);
    return input;
  }

  function amountText(a) {
    if (!a) return '';
    return Math.round(a * 100) % 100 ? a.toFixed(2) : String(Math.round(a));
  }

  function paintDate(refs) {
    if (!refs || !refs.dateText || !S.form) return;
    var today = todayIso();
    refs.dateText.textContent = S.form.date ? dateDay(S.form.date) + STRINGS.sep + away(today, S.form.date) : STRINGS.noDate;
  }

  function clampDate(s) {
    var today = parse(todayIso());
    var t = Math.max(today - PAST_DAYS * DAY_MS, Math.min(today + AHEAD_DAYS * DAY_MS, parse(s)));
    return iso(t);
  }

  // Left and Right on the amount or the date. A held key speeds up.
  function step(dir, what) {
    var f = S.form;
    if (!f) return;
    var t = new Date().getTime();
    var h = S.hold;
    if (!h || h.dir !== dir || h.what !== what || t - h.last >= HOLD_GAP || t < h.last) h = S.hold = { dir: dir, what: what, start: t, last: t };
    h.last = t;
    var held = t - h.start;
    var d = dir === 'right' ? 1 : -1;
    if (what === 'amount') {
      var size = held >= 2000 ? 25 : held >= 800 ? 5 : 1;
      var cur = f.amount || 0;
      var a;
      // $34.50: the first press lands on $35 or $34. A bigger step lands on
      // its own multiples ($5, $10, ...), so it reads cleanly.
      if (cur % 1 && size === 1) a = d > 0 ? Math.ceil(cur) : Math.floor(cur);
      else if (size > 1) a = d > 0 ? Math.floor(cur / size) * size + size : Math.ceil(cur / size) * size - size;
      else a = Math.round(cur) + d;
      f.amount = Math.max(0, Math.min(MAX_AMOUNT, a));
      if (S.refs && S.refs.amount) S.refs.amount.value = amountText(f.amount);
    } else {
      // From no date, the first press starts at today.
      f.date = f.date ? clampDate(iso(parse(f.date) + d * (held >= 800 ? 7 : 1) * DAY_MS)) : todayIso();
      paintDate(S.refs);
    }
  }

  function post(ctx, body, kind) {
    var L = window.HUB_LIVE;
    var f = S.form;
    if (!f || f.sending) return;
    if (!L || typeof L.post !== 'function') { toast(ctx, STRINGS.failed); return; }
    f.sending = kind;
    redraw(ctx);
    L.post('/budget/planned', body, function (err, data) {
      var still = S.form === f;
      if (still) f.sending = '';
      if (err) {
        // The Pi's or the budget app's reason when it gave one (a refusal), else "could not reach".
        toast(ctx, data && data.error && /budget app said/.test(data.error) ? data.error.replace(/^the budget app said: /, '') : STRINGS.failed);
        if (still) redraw(ctx);
        return;
      }
      toast(ctx, kind === 'remove' ? STRINGS.removed : kind === 'unmatch' ? STRINGS.unmatched : STRINGS.saved);
      // A removed buy's row goes away with the next push: focus the Add row.
      if (still) close(ctx, kind === 'remove' || !body.id ? 'planned-add' : 'planned-' + body.id);
    });
  }

  function save(ctx) {
    var f = S.form;
    if (!f) return;
    var label = String(f.label || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!label) { toast(ctx, STRINGS.needWhat); return; }
    if (!(f.amount > 0)) { toast(ctx, STRINGS.needAmount); return; }
    var shop = String(f.match || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var body = { op: f.id ? 'edit' : 'add', label: label, amount: f.amount, date: f.date || null, match: shop || null };
    if (f.id) body.id = f.id;
    post(ctx, body, 'save');
  }

  function toast(ctx, text) { try { ctx.toast(text, 3500); } catch (e) { /* no toast */ } }

  function redraw(ctx) {
    var c = ctx || S.ctx;
    try { if (c && c.isOpen()) c.redrawPanel(); } catch (e) { warn('redraw: ' + (e && e.message)); }
  }

  function open(ctx, id) {
    if (guestOn()) return;
    var it = id ? find(id) : null;
    if (id && !it) return;
    S.form = it ? { id: it.id, label: it.label, match: it.match || '', amount: it.amount, date: it.date || null, matched: it.state === 'matched', armed: false, sending: '' }
      : { id: null, label: '', match: '', amount: 0, date: iso(parse(todayIso()) + 7 * DAY_MS), matched: false, armed: false, sending: '' };
    S.hold = null;
    S.focusAfter = 'planned-what';
    redraw(ctx);
  }

  function close(ctx, focusKey) {
    S.form = null;
    S.hold = null;
    S.focusAfter = focusKey || 'planned-add';
    redraw(ctx);
  }

  /* ---------- what budget-lab.js calls ---------- */

  // Draws the section into col. Returns the focusables in Up and Down order
  // (the form's buttons count once: the first), or [] when there is no
  // planned section yet.
  function draw(col, ctx) {
    S.ctx = ctx;
    S.refs = null;
    var s = section();
    if (!s) { S.form = null; return []; }
    if (S.form && guestOn()) S.form = null;
    // Removed (here, with the list arriving before the answer, or elsewhere): focus the Add row.
    if (S.form && S.form.id && !find(S.form.id)) { S.form = null; S.focusAfter = 'planned-add'; }
    var box = el('div', 'bp-sec' + (S.form ? ' is-form' : ''), col);
    el('div', 'bu-label', box, STRINGS.head);
    var focus;
    if (S.form) {
      S.refs = drawForm(box);
      focus = S.refs.focus;
    } else {
      focus = drawList(box, s);
    }
    S.box = box;
    // Focus wanted after a form opened or closed: the hub focuses it once drawn.
    if (S.focusAfter) {
      // A removed buy's row is gone: the Add row then.
      var want = box.querySelector('[data-key="' + S.focusAfter + '"]') || box.querySelector('[data-key="planned-add"]') || focus[0];
      S.focusAfter = null;
      if (want) setTimeout(function () { try { if (want.parentNode) ctx.focus(want); } catch (e) { /* closed */ } }, 0);
    }
    return focus;
  }

  // The sub line in one line: the short form when the long one wraps.
  function fit() {
    var sub = S.box && S.box.querySelector('.bp-sub');
    if (sub && sub.scrollHeight > sub.clientHeight + 1 && sub.getAttribute('data-short')) {
      var lh = parseFloat(window.getComputedStyle(sub).lineHeight) || 0;
      if (lh && sub.offsetHeight > lh * 1.5) sub.textContent = sub.getAttribute('data-short');
    }
  }

  function inSection(node) { return !!(node && S.box && S.box.contains(node)); }

  // Left and Right. Returns true when used, the node to focus, or undefined.
  function onMove(dir, from) {
    if (!inSection(from)) return undefined;
    if (dir !== 'left' && dir !== 'right') return undefined;
    var key = from.getAttribute('data-key') || '';
    if (key === 'planned-amount') { step(dir, 'amount'); return true; }
    if (key === 'planned-date') { step(dir, 'date'); return true; }
    var b = S.refs && S.refs.buttons ? S.refs.buttons.indexOf(from) : -1;
    if (b >= 0) {
      var to = b + (dir === 'right' ? 1 : -1);
      return to >= 0 && to < S.refs.buttons.length ? S.refs.buttons[to] : true;
    }
    return true; // a list row: nothing sideways, and never the other column
  }

  // OK. Returns true when it was this section's.
  function onSelect(target, ctx) {
    if (!inSection(target)) return false;
    var key = target.getAttribute('data-key') || '';
    if (key === 'planned-add') { open(ctx, null); return true; }
    if (/^planned-/.test(key) && target.getAttribute('data-planned')) { open(ctx, target.getAttribute('data-planned')); return true; }
    if (!S.form) return true;
    if (key === 'planned-save') { save(ctx); return true; }
    if (key === 'planned-cancel') { close(ctx, S.form.id ? 'planned-' + S.form.id : 'planned-add'); return true; }
    if (key === 'planned-remove') {
      if (!S.form.armed) { S.form.armed = true; redraw(ctx); return true; }
      post(ctx, { op: 'remove', id: S.form.id }, 'remove');
      return true;
    }
    if (key === 'planned-unmatch') { post(ctx, { op: 'unmatch', id: S.form.id }, 'unmatch'); return true; }
    if (key === 'planned-date') {
      // OK on the date: no date, or back to one (today).
      S.form.date = S.form.date ? null : todayIso();
      paintDate(S.refs);
      return true;
    }
    return true;
  }

  // Enter or Done in a box: the What box moves on to the amount, the amount to the date.
  function onSubmit(box, ctx) {
    if (!inSection(box) || !S.form) return false;
    var key = box.getAttribute('data-key');
    var after = { 'planned-what': 'planned-shop', 'planned-shop': 'planned-amount', 'planned-amount': 'planned-date' }[key];
    var next = after ? S.box.querySelector('[data-key="' + after + '"]') : null;
    if (next) { try { ctx.focus(next); } catch (e) { /* closed */ } }
    return true;
  }

  // Back with the form open leaves the form (unsaved).
  function onBack(ctx) {
    if (!S.form) return false;
    close(ctx, S.form.id ? 'planned-' + S.form.id : 'planned-add');
    return true;
  }

  function reset() { S.form = null; S.hold = null; S.refs = null; S.box = null; S.focusAfter = null; }

  try {
    if (window.HUB_GUEST && typeof window.HUB_GUEST.onChange === 'function') {
      window.HUB_GUEST.onChange(function (on) { if (on && S.form) { S.form = null; redraw(S.ctx); } else if (S.box) redraw(S.ctx); });
    }
  } catch (e) { /* guest mode is optional */ }

  window.HUB_BUDGET_PLANNED = {
    STRINGS: EN,
    strings: function () { return STRINGS; },
    draw: draw,
    fit: fit,
    editing: function () { return !!S.form; },
    form: function () { return S.form ? JSON.parse(JSON.stringify(S.form)) : null; },
    onMove: onMove,
    onSelect: onSelect,
    onSubmit: onSubmit,
    onBack: onBack,
    reset: reset
  };
})();
