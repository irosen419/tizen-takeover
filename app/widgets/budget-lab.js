/*
 * Budget lab: the pace streak on the tile, and a daily cap to try out in the
 * panel (the plan's rows 1 to 5 and 8: the head line, the cap slider, the
 * mode pills, the outcome, Save this cap and Back to calculated, and the
 * pace). Merchants, "Put it somewhere" and the runway chart come later.
 *
 * Tile: the streak big ("8 days under", green; "Over yesterday", coral), then
 * "Yesterday $71 of $95", then the one suggested move. A tall tile adds the
 * card day outcome ("Dec 1: Covered, $214 spare"). Strip: "8 days under ·
 * $71 of $95". One column: the number.
 *
 * Every figure comes from app/budget-lab-math.js (HUB_BUDGET_LAB_MATH): this
 * file has no arithmetic of its own, only the words, the drawing and the
 * keys. The data, Guest mode and widgets.budget.show come from budget.js
 * through window.HUB_BUDGET, so they stay in one place.
 *
 * Session: the cap, the mode and the keep goal, in this file's memory only,
 * until the hub reloads. Saved: one localStorage key, homeHub.budget.capPref.v1
 * = { v: 1, cardDate, keep, at }, a keep amount re-averaged each morning and
 * dropped when card day moves on. Guest mode hides it all and clears the
 * session; it never deletes the saved cap (a preference, not Pi data).
 *
 * Keys: Left and Right on the cap slider change it ($1 a press; a held key
 * speeds up to $5 after 0.8 s and $25 after 2 s, keep goal $5, $25, $100,
 * from the math module's holdStep). Presses on the same slider less than
 * 250 ms apart are one hold. A press changes text nodes and one transform,
 * never the whole panel.
 *
 * Words: EN below; the Spanish is in app/i18n.js under 'budgetLab.<path>'.
 * Amounts keep their US form. Plain ES5 for the TV's browser.
 */
(function () {
  'use strict';

  var EN = {
    titles: { lab: 'Budget lab' },
    titlesShort: { lab: 'Lab' },
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    // {mon} short month, {d} day
    dateShort: '{mon} {d}',
    cash: '${n}',
    minus: '−',
    sep: ' · ',
    // The streak
    daysUnder: 'days under',
    dayUnder: 'day under',
    under: 'under',
    full: '{n}+',
    overYesterday: 'Over yesterday',
    overShort: 'Over',
    starting: 'Starting your streak',
    startingShort: 'New streak',
    // Yesterday against its morning cap
    yUnder: 'Yesterday {spent} of {cap}, {by} under',
    yOver: 'Yesterday {spent} of {cap}, {by} over',
    yShort: 'Yesterday {spent} of {cap}',
    yTiny: '{spent} of {cap}',
    yNoCap: 'Yesterday {spent}, no cap logged',
    yNoCapShort: 'Yesterday {spent}',
    // The suggested move (one, the first rule that fires)
    moves: {
      moveMoney: 'Card day is {n} short even at $0 a day: move {n} into checking before {d}',
      moveMoneyShort: 'Move {n} into checking before {d}',
      skipMerchant: 'Skip {n} at {merchant} to cover {d}',
      skipMerchantShort: 'Skip {n} at {merchant}',
      spendLess: 'Spend {n} a day less to cover {d}',
      spendLessShort: 'Spend {n} a day less',
      newStreak: 'Stay under {cap} today to start a new streak',
      newStreakShort: 'Stay under {cap} today',
      keepStreak: 'Stay under {cap} today for {n} days in a row',
      keepStreak1: 'Stay under {cap} today to start a streak',
      keepStreakShort: 'Stay under {cap} today',
      skipOne: '{move} · skip one {merchant} run'
    },
    // The card day outcome
    outcomeSpare: '{d}: Covered, {n} spare',
    outcomeZero: '{d}: Covered, nothing to spare',
    outcomeShort: '{d}: Short by {n}',
    spareShort: 'Covered, {n} spare',
    zeroShort: 'Covered',
    shortShort: 'Short by {n}',
    // The panel
    today: 'today',
    tomorrow: 'tomorrow',
    inDays: 'in {n} days',
    covered: 'Covered',
    shortBy: 'Short by {n}',
    roomNote: 'The Daily room tile uses {n} a day',
    capLabel: 'Daily cap',
    keepLabel: 'Keep on {d}',
    aDay: 'a day',
    toKeep: 'to keep',
    calcTick: 'calculated {n}',
    savedTick: 'saved {n}',
    noSaved: 'no saved cap',
    capResult: 'cap {n} a day',
    modeCap: 'Set the cap',
    modeKeep: 'Set what to keep',
    keepOn: 'Keep {n} on {d}',
    nothingOn: 'Nothing to spare on {d}',
    shortOn: 'Short by {n} on {d}',
    monthly: 'Monthly remaining {n}',
    gapLess: '{n} less than calculated',
    gapMore: '{n} more than calculated',
    gapSame: 'same as calculated',
    savedGap: 'saved cap: {gap}',
    save: 'Save this cap',
    reset: 'Back to calculated',
    toastSaved: 'Cap saved: {n} a day (re-averaged each morning)',
    paceHead: 'Pace',
    noLab: 'Card day needs a payday in the budget app',
    cardToday: 'Card day is today: {state}'
  };

  // The words in the hub's language; set again when the language changes.
  var STRINGS = EN;

  function I18N() {
    var x = window.HUB_I18N;
    return x && typeof x.localize === 'function' ? x : null;
  }

  function localizeStrings() {
    var x = I18N();
    try { STRINGS = x ? x.localize(EN, 'budgetLab') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();

  var PREF_KEY = 'homeHub.budget.capPref.v1';
  var HOLD_GAP = 250;     // ms: presses closer than this on one slider are one hold

  function MATH() { return window.HUB_BUDGET_LAB_MATH; }
  function B() { return window.HUB_BUDGET; }

  /* ---------- small helpers (the same as budget.js, kept small) ---------- */

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function fill(text, map) {
    return String(text).replace(/\{(\w+)\}/g, function (all, k) {
      return map && map.hasOwnProperty(k) ? String(map[k]) : all;
    });
  }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Budget lab: ' + text); } catch (e) { /* ignore */ }
  }

  function now() { return new Date().getTime(); }

  function fmtNum(n) {
    return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // A whole dollar figure as it is given: "$80", "−$12".
  function cash(n) {
    return (n < 0 ? STRINGS.minus : '') + fill(STRINGS.cash, { n: fmtNum(Math.abs(n)) });
  }
  // Room and caps round down (never a dollar more than there is); a
  // shortfall rounds up (never smaller than it is). The math module does both.
  function down(n) { return cash(MATH().wholeDown(n)); }
  function up(n) { return cash(MATH().wholeUp(n)); }
  function near(n) { return cash(Math.round(n)); }

  function dateText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return '';
    return fill(STRINGS.dateShort, { mon: STRINGS.monthsShort[+m[2] - 1], d: +m[3] });
  }

  function overH(node) { return node.scrollHeight > node.clientHeight + 1; }
  function overW(node) { return node.scrollWidth > node.clientWidth + 1; }

  function fitForms(node, forms) {
    for (var i = 0; i < forms.length; i++) {
      if (!forms[i]) continue;
      node.textContent = forms[i];
      if (!overW(node) && !overH(node)) return true;
    }
    node.style.display = 'none';
    return false;
  }

  function fitWidth(node) {
    node.style.fontSize = '';
    if (!node.clientWidth || !overW(node)) return;
    var size = parseFloat(window.getComputedStyle(node).fontSize) || 40;
    for (var i = 0; i < 16 && overW(node); i++) {
      size = size * 0.9;
      node.style.fontSize = size.toFixed(1) + 'px';
    }
  }

  // Takes optional parts away, last first, until the box fits.
  function trim(box, parts) {
    for (var i = parts.length - 1; i >= 0 && overH(box); i--) {
      if (parts[i] && parts[i].parentNode) parts[i].parentNode.removeChild(parts[i]);
    }
  }

  function sizeOf(ctx) {
    var z = ctx && ctx.size ? ctx.size() : null;
    return z || { cols: 4, rows: 3, tier: 'tall', width: 'standard' };
  }

  /* ---------- the state: session, saved cap, hold ---------- */

  var LAB = { ctx: null, session: null, hold: null, refs: null, bound: false };

  function newSession() { return MATH() ? MATH().newSession() : { mode: 'cap', cap: null, keep: null, cuts: {} }; }
  LAB.session = newSession();

  // The saved cap as stored, or null. One from an earlier cycle (card day
  // moved on) is dropped here: never carried over.
  function readPref(lab) {
    var raw = null;
    try { raw = window.localStorage ? window.localStorage.getItem(PREF_KEY) : null; } catch (e) { raw = null; }
    if (!raw) return null;
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { p = null; }
    var cardDate = lab && typeof lab.cardDate === 'string' ? lab.cardDate : null;
    if (!p || typeof p !== 'object' || (cardDate && p.cardDate !== cardDate)) {
      try { window.localStorage.removeItem(PREF_KEY); } catch (e) { /* read as none anyway */ }
      return null;
    }
    return p;
  }

  function writePref(p) {
    try {
      if (window.localStorage) window.localStorage.setItem(PREF_KEY, JSON.stringify(p));
      return true;
    } catch (e) { return false; }
  }

  function snapshot() {
    var b = B();
    try { return b ? b.data() : null; } catch (e) { return null; }
  }

  // Everything the tab shows, from the math module; null when no figure may
  // show or the budget app has sent nothing for the lab yet.
  function result() {
    var d = snapshot();
    var m = MATH();
    if (!d || !m || (!d.lab && !d.pace)) return null;
    return m.compute({ lab: d.lab, merchants: d.merchants, pace: d.pace, room: d.room, cardDay: d.cardDay,
      session: LAB.session, pref: readPref(d.lab), today: B().today() });
  }

  // Why there is nothing to show: a key of budget.js's states.
  function emptyKey() {
    var b = B();
    if (!b) return 'waiting';
    var k = b.state();
    return k === 'guest' || k === 'hidden' || !snapshot() ? k : 'waiting';
  }

  function stateText(key) {
    var b = B();
    try { return b ? b.stateText(key) : { head: '', line: '', short: '' }; } catch (e) { return { head: '', line: '', short: '' }; }
  }

  function asOf() { try { return B() ? B().asOf() : ''; } catch (e) { return ''; } }
  function stale() { try { return !!(B() && B().stale()); } catch (e) { return false; } }

  /* ---------- the words for a result ---------- */

  // The streak: { num, caps (long first), word, tone }.
  function streakView(r) {
    var s = r.streak;
    var y = r.yesterday;
    if (s.count === 0 && y && y.under === false) {
      return { num: '0', word: STRINGS.overYesterday, words: [STRINGS.overYesterday, STRINGS.overShort], caps: [STRINGS.overShort], tone: 'is-neg' };
    }
    if (s.count === 0) {
      return { num: '0', word: STRINGS.starting, words: [STRINGS.starting, STRINGS.startingShort], caps: [STRINGS.startingShort, STRINGS.under], tone: '' };
    }
    var num = s.full ? fill(STRINGS.full, { n: s.count }) : String(s.count);
    var unit = s.count === 1 && !s.full ? STRINGS.dayUnder : STRINGS.daysUnder;
    return { num: num, caps: [unit, STRINGS.under], unit: unit, tone: 'is-ok' };
  }

  function streakForms(v) {
    if (v.word) return v.words;
    return [v.num + ' ' + v.unit, v.num + ' ' + STRINGS.under, v.num];
  }

  function yesterdayForms(r) {
    var y = r.yesterday;
    if (!y) return [];
    if (y.cap === null) return [fill(STRINGS.yNoCap, { spent: near(y.spent) }), fill(STRINGS.yNoCapShort, { spent: near(y.spent) })];
    var map = { spent: near(y.spent), cap: near(y.cap), by: near(Math.abs(Math.round(y.cap) - Math.round(y.spent))) };
    return [fill(y.under ? STRINGS.yUnder : STRINGS.yOver, map), fill(STRINGS.yShort, map), fill(STRINGS.yTiny, map)];
  }

  // The suggested move as [long, short] (the math module picks which).
  function moveForms(r) {
    var mv = r.move;
    var M = STRINGS.moves;
    if (!mv) return [];
    var d = dateText(r.cardDate);
    if (mv.kind === 'moveMoney') {
      return [fill(M.moveMoney, { n: cash(mv.amount), d: d }), fill(M.moveMoneyShort, { n: cash(mv.amount), d: d })];
    }
    if (mv.kind === 'skipMerchant') {
      var sm = { n: cash(mv.amount), merchant: mv.merchant, d: d };
      return [fill(M.skipMerchant, sm), fill(M.skipMerchantShort, sm)];
    }
    if (mv.kind === 'spendLess') {
      return [fill(M.spendLess, { n: cash(mv.perDay), d: d }), fill(M.spendLessShort, { n: cash(mv.perDay) })];
    }
    var cap = cash(mv.cap);
    if (mv.kind === 'newStreak') return [fill(M.newStreak, { cap: cap }), fill(M.newStreakShort, { cap: cap })];
    var long = fill(mv.days > 1 ? M.keepStreak : M.keepStreak1, { cap: cap, n: mv.days });
    var out = [];
    if (mv.skip) out.push(fill(M.skipOne, { move: long, merchant: mv.skip }));
    out.push(long, fill(M.keepStreakShort, { cap: cap }));
    return out;
  }

  // The card day outcome: { forms (long first), tone }.
  function outcomeView(r) {
    if (r.ok) {
      var d = dateText(r.cardDate);
      if (!r.covered) return { forms: [fill(STRINGS.outcomeShort, { d: d, n: cash(r.short) }), fill(STRINGS.shortShort, { n: cash(r.short) })], tone: 'is-neg' };
      var spare = MATH().wholeDown(r.keep);
      if (spare > 0) return { forms: [fill(STRINGS.outcomeSpare, { d: d, n: cash(spare) }), fill(STRINGS.spareShort, { n: cash(spare) })], tone: 'is-ok' };
      return { forms: [fill(STRINGS.outcomeZero, { d: d }), STRINGS.zeroShort], tone: 'is-ok' };
    }
    if (r.reason === 'cardDayToday' && r.cardDayToday) {
      var st = cardStateWord(r.cardDayToday);
      return { forms: [fill(STRINGS.cardToday, { state: st }), st], tone: r.cardDayToday.covered ? 'is-ok' : 'is-neg' };
    }
    return null;
  }

  function cardStateWord(o) {
    if (o.covered) return STRINGS.covered;
    return o.short === null ? fill(STRINGS.shortBy, { n: '' }).replace(/\s+$/, '') : fill(STRINGS.shortBy, { n: cash(o.short) });
  }

  function awayText(D) {
    return D === 0 ? STRINGS.today : D === 1 ? STRINGS.tomorrow : fill(STRINGS.inDays, { n: D });
  }

  /* ---------- the tile ---------- */

  function mark(parent, cls) {
    var m = el('span', 'icon bu-mark' + (cls ? ' ' + cls : ''), parent);
    m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.wallet) || '';
    return m;
  }

  function tileMessage(root, size, key) {
    var msg = stateText(key);
    if (size.cols === 1) return mark(root, 'is-solo');
    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      return el('div', 'bu-strip-text bu-cut is-quiet', root, msg.head);
    }
    var box = el('div', 'bu-msg', root);
    el('div', 'bu-msg-head', box, msg.head);
    var line = msg.short ? el('div', 'bu-msg-line', box, msg.short) : null;
    trim(root, [line]);
    if (overH(root)) box.firstChild.className += ' is-small';
    mark(root);
    return box;
  }

  function panelMessage(root, key) {
    var msg = stateText(key);
    var box = el('div', 'bu-pmsg', root);
    el('div', 'bu-pmsg-head', box, msg.head);
    if (msg.line) el('div', 'bu-pmsg-line', box, msg.line);
    mark(root, 'is-panel');
  }

  // The big streak: a number with its words, or a word alone.
  function streakHero(parent, v, cls) {
    var box = el('div', 'bu-hero' + (v.word ? ' is-word' : '') + (cls ? ' ' + cls : ''), parent);
    box.numEl = el('span', 'bu-hero-num' + (v.tone ? ' ' + v.tone : ''), box, v.word || v.num);
    if (!v.word) box.capEl = el('span', 'bu-hero-cap', box, v.unit);
    return box;
  }

  function fitStreak(box, v) {
    if (v.word) {
      // A word too long for the line takes its short form before it shrinks.
      if (overW(box.numEl) && v.words[1]) box.numEl.textContent = v.words[1];
      fitWidth(box.numEl);
      return;
    }
    fitWidth(box.numEl);
    var cap = box.capEl;
    if (!cap) return;
    if (overW(cap) || cap.offsetLeft <= box.numEl.offsetLeft + 1) cap.textContent = STRINGS.under;
    if (overW(cap)) box.removeChild(cap);
  }

  // A line of up to two lines: the long form when it fits, else the short.
  function twoLines(parent, cls, forms) {
    var node = el('div', cls, parent);
    for (var i = 0; i < forms.length; i++) {
      node.textContent = forms[i];
      if (!overH(node) && !overW(node)) return node;
    }
    return node;    // the last form, cut at the end of its second line
  }

  function drawTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'bu-tile bl-tile', body);
    var r = result();
    ctx.setTileSub(r ? asOf() : '');
    if (!r) return tileMessage(root, size, emptyKey());
    if (stale()) root.className += ' is-stale';
    var v = streakView(r);

    if (size.cols === 1) {
      root.className += ' bu-solo';
      var n = el('div', 'bu-solo-num' + (v.tone ? ' ' + v.tone : ''), root, v.num);
      fitWidth(n);
      var c = el('div', 'bu-solo-cap', root);
      if (!fitForms(c, v.caps)) root.removeChild(c);
      return;
    }

    if (size.tier === 'strip') {
      root.className += ' bu-strip';
      var line = el('div', 'bu-strip-line', root);
      var head = el('span', 'bl-strip-head' + (v.tone ? ' ' + v.tone : ''), line);
      fitForms(head, streakForms(v));
      head.style.display = '';
      if (size.cols >= 4) {
        var rest = el('span', 'bu-strip-rest', line);
        // "8 days under · $71 of $95": yesterday in its shortest form.
        var yf = yesterdayForms(r);
        var y = yf.length ? yf[yf.length - 1] : '';
        if (!y || !fitForms(rest, [STRINGS.sep + y])) line.removeChild(rest);
      }
      if (overW(line)) fitForms(head, streakForms(v).slice(1));
      return;
    }

    var hero = streakHero(root, v);
    var yl = r.yesterday ? el('div', 'bu-line bl-yline', root) : null;
    var mf = moveForms(r);
    var move = mf.length ? twoLines(root, 'bl-move', mf) : null;
    var out = size.tier === 'tall' ? outcomeView(r) : null;
    var foot = out ? el('div', 'bu-foot bl-foot ' + out.tone, root) : null;
    fitStreak(hero, v);
    if (yl) fitForms(yl, yesterdayForms(r));
    if (foot) fitForms(foot, out.forms);
    trim(root, [yl, move, foot]);
    if (move && move.parentNode && overH(root)) root.removeChild(move);
  }

  /* ---------- the panel ---------- */

  // Where a value sits on its slider, 0..1.
  function sliderSpan(r) {
    if (r.mode === 'keep') return { lo: r.keepMin, hi: r.keepMax };
    return { lo: 0, hi: r.capMax };
  }

  function frac(x, s) {
    if (!(s.hi > s.lo)) return 0;
    var f = (x - s.lo) / (s.hi - s.lo);
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  function pct(f) { return (Math.round(f * 10000) / 100) + '%'; }

  // A key press writes into the text node that is there, not a new one.
  function setText(node, text) {
    if (!node || node.textContent === text) return;
    var t = node.firstChild;
    if (t && t.nodeType === 3 && !t.nextSibling) t.nodeValue = text;
    else node.textContent = text;
  }

  function setTone(node, base, tone) {
    var cls = base + (tone ? ' ' + tone : '');
    if (node && node.className !== cls) node.className = cls;
  }

  function headWord(r) {
    return r.covered ? STRINGS.covered : fill(STRINGS.shortBy, { n: cash(r.short) });
  }

  function gapText(r) {
    var g = MATH().toCents(r.gap);
    var text = Math.abs(g) < 0.5 ? STRINGS.gapSame : fill(g < 0 ? STRINGS.gapLess : STRINGS.gapMore, { n: near(Math.abs(g)) });
    return r.gapBase === 'saved' ? fill(STRINGS.savedGap, { gap: text }) : text;
  }

  function outcomeLine(r) {
    var d = dateText(r.cardDate);
    if (!r.covered) return fill(STRINGS.shortOn, { n: cash(r.short), d: d });
    var spare = MATH().wholeDown(r.keep);
    return spare > 0 ? fill(STRINGS.keepOn, { n: cash(spare), d: d }) : fill(STRINGS.nothingOn, { d: d });
  }

  // The numbers of a result into the panel's text nodes and the slider's
  // one transform (its fill). Ticks move only when the mode or the saved cap changed.
  function paint(refs, r) {
    if (!refs || !r) return;
    var keep = r.mode === 'keep';
    if (refs.headState) {
      setText(refs.headState, headWord(r));
      setTone(refs.headState, 'bl-head-state', r.covered ? 'is-ok' : 'is-neg');
    }
    if (!r.ok || !refs.slider) return;
    var span = sliderSpan(r);
    setText(refs.label, keep ? fill(STRINGS.keepLabel, { d: dateText(r.cardDate) }) : STRINGS.capLabel);
    if (keep) {
      var k = r.keepGoal;
      setText(refs.big, k < 0 ? STRINGS.minus + up(-k) : down(k));
      setText(refs.unit, STRINGS.toKeep);
    } else {
      setText(refs.big, down(r.cap));
      setText(refs.unit, STRINGS.aDay);
    }
    setTone(refs.big, 'bl-big', r.covered ? '' : 'is-neg');
    // The fill grows from the left to the value: scaleX, set directly.
    var f = frac(keep ? r.keepGoal : r.cap, span);
    var tf = 'scaleX(' + (Math.round(f * 10000) / 10000) + ')';
    if (refs.fill.tf !== tf) {
      refs.fill.tf = tf;
      refs.fill.style.webkitTransform = tf;
      refs.fill.style.transform = tf;
    }
    setTone(refs.fill, 'bl-fill', r.covered ? '' : 'is-neg');
    var tickKey = r.mode + '|' + (r.saved ? r.saved.keep : '') + '|' + span.lo + '|' + span.hi;
    if (refs.tickKey !== tickKey) {
      refs.tickKey = tickKey;
      var calcAt = keep ? r.R - r.c0 * r.D : r.c0;
      refs.calcTick.style.left = pct(frac(calcAt, span));
      if (r.saved) {
        refs.savedTick.style.display = '';
        refs.savedTick.style.left = pct(frac(keep ? r.saved.keep : r.saved.cap, span));
      } else {
        refs.savedTick.style.display = 'none';
      }
    }
    var ticks = [];
    if (keep) ticks.push(fill(STRINGS.capResult, { n: down(r.cap) }));
    ticks.push(fill(STRINGS.calcTick, { n: down(r.c0) }));
    ticks.push(r.saved ? fill(STRINGS.savedTick, { n: down(r.saved.cap) }) : STRINGS.noSaved);
    setText(refs.ticks, ticks.join(STRINGS.sep));
    refs.pills[0].className = 'bl-pill' + (keep ? '' : ' is-on');
    refs.pills[1].className = 'bl-pill' + (keep ? ' is-on' : '');
    setText(refs.outcome, outcomeLine(r));
    setTone(refs.outcome, 'bl-outcome', r.covered ? 'is-ok' : 'is-neg');
    setText(refs.monthly, fill(STRINGS.monthly, { n: down(r.monthly.session) }));
    setText(refs.gap, gapText(r));
    if (refs.move) {
      var mf = moveForms(r);
      setText(refs.move, mf.length ? mf[0] : '');
    }
  }

  function section(parent, key, cls) {
    var s = el('div', 'bu-psec f' + (cls ? ' ' + cls : ''), parent);
    s.setAttribute('data-key', key);
    return s;
  }

  function drawPace(col, r, refs) {
    var sec = section(col, 'pace', 'bl-pace');
    el('div', 'bu-label', sec, STRINGS.paceHead);
    var v = streakView(r);
    var hero = streakHero(sec, v, 'is-panel');
    var yf = yesterdayForms(r);
    if (yf.length) el('div', 'bu-pline', sec, yf[0]);
    var mf = moveForms(r);
    refs.move = mf.length || r.ok ? el('div', 'bu-pline bl-pmove', sec, mf.length ? mf[0] : '') : null;
    refs.paceHero = hero;
    refs.paceView = v;
    return sec;
  }

  function drawPanel(body, ctx) {
    var full = ctx.mode && ctx.mode() === 'full';
    ctx.setSub(asOf());
    var root = el('div', 'bu-panel bl-panel' + (full ? ' is-full' : ''), body);
    LAB.refs = null;
    var r = result();
    if (!r) return panelMessage(root, emptyKey());
    var wrap = el('div', 'bu-pwrap bl-pwrap' + (full ? ' is-full is-cols' : '') + (stale() ? ' is-stale' : ''), root);
    var colA = el('div', 'bu-pcol', wrap);
    var colB = full ? el('div', 'bu-pcol', wrap) : null;
    var refs = { pills: [], full: full };

    // 1. The head line: "Dec 1 · in 14 days · Covered".
    var head = el('div', 'bl-head', colA);
    if (r.ok) {
      el('span', '', head, dateText(r.cardDate) + STRINGS.sep + awayText(r.D) + STRINGS.sep);
      refs.headState = el('span', 'bl-head-state', head);
    } else {
      var ov = outcomeView(r);
      el('span', ov ? 'bl-head-state ' + ov.tone : 'bl-head-state', head, ov ? ov.forms[0] : STRINGS.noLab);
    }
    if (r.ok && r.roomCap) el('div', 'bl-note', colA, fill(STRINGS.roomNote, { n: down(r.roomCap.cap) }));

    if (r.ok) {
      // 2. The cap slider: its label on its own line, the figure, the track.
      var sl = section(colA, 'cap', 'bl-slider');
      sl.setAttribute('data-autofocus', '');
      refs.slider = sl;
      refs.label = el('div', 'bl-label', sl);
      var val = el('div', 'bl-value', sl);
      refs.big = el('span', 'bl-big', val);
      refs.unit = el('span', 'bl-unit', val);
      var track = el('div', 'bl-track', sl);
      refs.fill = el('span', 'bl-fill', track);
      refs.calcTick = el('span', 'bl-tick is-calc', track);
      refs.savedTick = el('span', 'bl-tick is-saved', track);
      refs.ticks = el('div', 'bl-ticks', sl);

      // 3. The mode pills (OK toggles).
      var modes = refs.modes = section(colA, 'mode', 'bl-modes');
      refs.pills.push(el('span', 'bl-pill', modes, STRINGS.modeCap));
      refs.pills.push(el('span', 'bl-pill', modes, STRINGS.modeKeep));

      // 4. The outcome (not focusable).
      var oc = el('div', 'bl-oblock', colA);
      refs.outcome = el('div', 'bl-outcome', oc);
      refs.monthly = el('div', 'bu-pline', oc);
      refs.gap = el('div', 'bu-pline is-quiet', oc);

      // 5. The buttons.
      var btns = el('div', 'bl-buttons', colA);
      var save = el('span', 'bl-btn f', btns, STRINGS.save);
      save.setAttribute('data-key', 'save');
      refs.save = save;
      var reset = el('span', 'bl-btn f', btns, STRINGS.reset);
      reset.setAttribute('data-key', 'reset');
    }

    // 8. The pace.
    var pace = drawPace(colB || colA, r, refs);
    if (!r.ok) pace.setAttribute('data-autofocus', '');
    paint(refs, r);
    fitWidth(refs.paceHero.numEl);
    LAB.refs = refs;
  }

  /* ---------- keys ---------- */

  function nudge(dir) {
    var m = MATH();
    var r = result();
    if (!m || !r || !r.ok) return;
    var t = now();
    var h = LAB.hold;
    if (!h || h.dir !== dir || h.mode !== LAB.session.mode || t - h.last >= HOLD_GAP || t < h.last) {
      h = LAB.hold = { dir: dir, mode: LAB.session.mode, start: t, last: t };
    }
    h.last = t;
    var size = m.holdStep(t - h.start, LAB.session.mode);
    var d = dir === 'right' ? 1 : -1;
    LAB.session = LAB.session.mode === 'keep' ? m.nudgeKeep(LAB.session, r, d, size) : m.nudgeCap(LAB.session, r, d, size);
    paint(LAB.refs, result());
  }

  // Up and Down between the rows go in their order (the buttons sit
  // left, so a move by position could skip them for the wider Pace row).
  function rowMove(dir, from, refs) {
    var key = from && from.getAttribute ? from.getAttribute('data-key') : null;
    if (dir === 'down' && key === 'mode') return refs.save;
    if (dir === 'up' && (key === 'save' || key === 'reset')) return refs.modes;
    if (dir === 'up' && key === 'pace' && refs.save && !refs.full) return refs.save;
    return undefined;
  }

  function onMove(dir, from) {
    var refs = LAB.refs;
    if (!refs) return undefined;
    if (dir === 'up' || dir === 'down') return rowMove(dir, from, refs);
    if (!refs.slider || from !== refs.slider || (dir !== 'left' && dir !== 'right')) return undefined;
    try { nudge(dir); } catch (e) { warn('slider: ' + (e && e.message)); }
    return true;
  }

  function onSelect(target, ctx) {
    var key = target && target.getAttribute('data-key');
    var m = MATH();
    var r = result();
    if (!m || !r || !r.ok) return;
    LAB.hold = null;
    if (key === 'mode') {
      LAB.session = m.toggleMode(LAB.session, r);
    } else if (key === 'reset') {
      LAB.session = m.newSession();
    } else if (key === 'save') {
      var p = m.makePref(r, new Date(now()).toISOString());
      if (!p) return;
      writePref(p);
      // The cap the stored keep amount gives this morning, as the math module reads it.
      var saved = m.readPref(p, snapshot().lab);
      ctx.toast(fill(STRINGS.toastSaved, { n: down(saved ? saved.cap : r.cap) }), 3500);
    } else {
      return;
    }
    paint(LAB.refs, result());
  }

  /* ---------- wiring ---------- */

  function redraw() {
    var ctx = LAB.ctx;
    if (!ctx) return;
    var m = MATH();
    var r = result();
    if (m && r && r.ok) LAB.session = m.normalizeSession(LAB.session, r);
    try {
      ctx.redrawTile();
      if (ctx.isOpen()) ctx.redrawPanel();
    } catch (e) { warn('redraw: ' + (e && e.message)); }
  }

  // Guest mode: nothing of the session survives for a guest to bring back by
  // turning it off. The saved cap stays (a preference); it is hidden with the rest.
  function onGuest(on) {
    if (on) {
      LAB.session = newSession();
      LAB.hold = null;
      LAB.refs = null;
    }
    redraw();
  }

  function onLang() {
    localizeStrings();
    var ctx = LAB.ctx;
    if (ctx && typeof ctx.retitle === 'function') ctx.retitle();
    if (ctx && ctx.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = STRINGS.titles.lab;
    }
    redraw();
  }

  function bind(ctx) {
    LAB.ctx = ctx;
    if (LAB.bound) return;
    LAB.bound = true;
    try { if (B()) B().onChange(redraw); } catch (e) { warn('budget: ' + (e && e.message)); }
  }

  try { if (window.HUB_GUEST) window.HUB_GUEST.onChange(function (on) { try { onGuest(on); } catch (e) { warn('guest: ' + (e && e.message)); } }); } catch (e) { /* no Guest mode on this page */ }

  try {
    var lx = I18N();
    if (lx && typeof lx.onChange === 'function') lx.onChange(function () { try { onLang(); } catch (e) { warn('language: ' + (e && e.message)); } });
  } catch (e) { /* stays in the language it started in */ }

  function broken(body) {
    try {
      body.innerHTML = '';
      el('div', 'bu-msg-line', body, STRINGS.titles.lab);
    } catch (e) { /* nothing more to do */ }
  }

  var widget = {
    id: 'budget-lab',
    icon: 'wallet',
    expandable: true,
    init: function (ctx) { bind(ctx); },
    renderTile: function (body, ctx) {
      try {
        bind(ctx);
        drawTile(body, ctx);
      } catch (e) {
        warn('tile: ' + (e && e.message));
        broken(body);
      }
    },
    renderPanel: function (body, ctx) {
      try { drawPanel(body, ctx); } catch (e) {
        warn('panel: ' + (e && e.message));
        broken(body);
      }
    },
    onMove: function (dir, from) { return onMove(dir, from); },
    onSelect: function (target, ctx) { try { onSelect(target, ctx); } catch (e) { warn('select: ' + (e && e.message)); } },
    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    // The tile's suggested move follows the session cap: drawn again once
    // the panel closes, not on every key press.
    onClose: function (ctx) { LAB.refs = null; LAB.hold = null; ctx.redrawTile(); }
  };
  Object.defineProperty(widget, 'title', { get: function () { return STRINGS.titles.lab; }, enumerable: true, configurable: true });
  Object.defineProperty(widget, 'shortTitle', { get: function () { return STRINGS.titlesShort.lab; }, enumerable: true, configurable: true });

  // For dev/money-test.js. Not used by the hub.
  window.HUB_BUDGET_LAB_TEST = {
    STRINGS: EN,
    strings: function () { return STRINGS; },
    session: function () { return JSON.parse(JSON.stringify(LAB.session)); },
    result: result,
    PREF_KEY: PREF_KEY,
    HOLD_GAP: HOLD_GAP
  };

  (window.HUB_WIDGETS = window.HUB_WIDGETS || []).push(widget);
})();
