/*
 * Budget lab: the pace streak on the tile, and a daily cap to try out in the
 * panel (the plan's rows 1 to 8: the head line, the cap slider, the mode
 * pills, the outcome, Save this cap and Back to calculated, the merchants'
 * cut sliders, Put it somewhere, and the pace), and at full screen the runway
 * chart on the right.
 *
 * Tile: today's daily cap big ("$146 a day"), or, when even $0 a day leaves
 * card day short, the shortfall in coral ("$138 short for Nov 30"). Under it
 * the card day outcome ("Keeps Nov 30 covered", "Nov 30: Covered, $214
 * spare"), then the suggested move only when card day is short. At the
 * bottom, a small bordered streak box: with no streak just "Stay under $146
 * today" (and yesterday, quiet); with one, "3 days under" in green, a row of
 * seven dots (one lit per day, up to seven) and "Stay under $146 today to
 * make it 4". Strip: "$146 a day · 3 days under". One column: the cap.
 *
 * Every figure comes from app/budget-lab-math.js (HUB_BUDGET_LAB_MATH): this
 * file has no arithmetic of its own, only the words, the drawing and the
 * keys. The data and widgets.budget.show come from budget.js through
 * window.HUB_BUDGET, so they stay in one place. Guest mode (guest.js) blurs
 * the dollar amounts here like on every money tile; the chart's shapes stay.
 *
 * Merchants (row 6): up to five slider rows, the label on its own line above
 * the track ("Amazon · $495 so far · cut $40"), $1 a press with the same hold
 * to speed up as the cap. A cut stops at the merchant's projection p_i and at
 * what the five together have left (combined); with the cap at $0 they lock.
 * Put it somewhere (row 7, not focusable): card day, then the split's buckets
 * (savings, AWWS, buffer, from lab.split), each funded of planned, filled in
 * the math module's order: a freed dollar covers card day first.
 *
 * Session: the cap, the mode, the keep goal and the cuts, in this file's memory only,
 * until the hub reloads. Saved: 'budget.capPref' in app/prefs.js, shared by
 * every screen through the Pi = { v: 1, cardDate, keep, at }, a keep amount
 * re-averaged each morning and dropped when card day moves on. With none
 * saved, the daily goal stands in as the saved cap ("Your goal $60 a day").
 *
 * Keys: Left and Right on the cap slider change it ($1 a press; a held key
 * speeds up to $5 after 0.8 s and $25 after 2 s, keep goal $5, $25, $100,
 * from the math module's holdStep). Presses on the same slider less than
 * 250 ms apart are one hold. A press changes text nodes and one transform,
 * never the whole panel.
 *
 * Runway chart (full screen only, at the top of the right column; the panel
 * size draws none): inline SVG from createElementNS, as awws.js draws Reach.
 * The headroom step line from the snapshot's runway (start, a pay step up, a
 * bill down, the reserve down on card day, ending at R), the owed line from
 * 0 this morning up to P = ce * D at the session cap, a card day rule, a dot
 * and its date for each payday, weekday ticks under the x axis, and at the
 * right edge the one figure, the gap: "Covered, $214 spare" (green) or
 * "Short by $10" (coral). No y axis and no other figure: the runway is
 * headroom, not a balance. The days and the y range come from the math
 * module's runwayChart, fixed when the panel is drawn and wide enough for
 * the top of the cap slider, so a key press moves the owed line and never
 * the axes. A press writes only the owed line's points (its last point
 * moves) and the gap label's text, at most every 120 ms during a hold and
 * once more after the last press.
 *
 * Daily goal (pace.goals, the Pi's dated history; the math module's
 * goalTrend judges each day against the goal in force that day): with a goal
 * the tile's box shows "Under your $60 goal: 11 of last 14 days", a dot a
 * day and the run in a row, in place of the streak against the morning cap,
 * and the big figure reads "$146 safe today". In the panel, under Back to
 * calculated: the Daily goal row (Left and Right $1, the cap's hold speed-up;
 * OK posts POST /budget/goal, which applies from the Pi's today on; a tap on
 * its arrows on the tablet), the goal line, and the daily spending graph (a
 * div bar a day for 31 days, green under, coral over, grey before the first
 * goal, the goal as a dashed line, no dollar axis), with the 7 and 30 day
 * averages and the trend in words. With a goal it replaces Pace.
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
    // The tile: today's cap big, the streak in a small box at the bottom
    tileADay: 'a day',
    tileShortFor: 'short for {d}',
    tileShortWord: 'short',
    tileKeeps: 'Keeps {d} covered',
    tileKeepsShort: 'Covered',
    tileAuto: '{d} is short, using autopay days',
    tileAutoShort: 'Using autopay days',
    streakDays: '{n} days under',
    streakDay: '{n} day under',
    stayToday: 'Stay under {cap} today',
    stayMakeIt: 'Stay under {cap} today to make it {n}',
    // The card day outcome
    outcomeSpare: '{d}: Covered, {n} spare',
    outcomeZero: '{d}: Covered, nothing to spare',
    outcomeShort: '{d}: Short by {n}',
    spareShort: 'Covered, {n} spare',
    zeroShort: 'Covered',
    outcomeOnTrack: '{d}: On track at {cap} a day',
    onTrackShort: 'On track at {cap}/day',
    shortShort: 'Short by {n}',
    // The panel
    today: 'today',
    tomorrow: 'tomorrow',
    inDays: 'in {n} days',
    covered: 'Covered',
    shortBy: 'Short by {n}',
    roomNote: 'The Daily room tile uses {n} a day',
    capLabel: 'Daily cap',
    aDay: 'a day',
    // The one thing to do, under the big number (the arrows are drawn, these are words)
    capHint: 'Hold \u25C0 \u25B6 to change your daily cap',
    keyCap: '\u25C0 \u25B6 change \u00B7 OK save',
    keyCut: '\u25C0 \u25B6 cut \u00B7 OK save',
    keyOk: 'OK',
    keyMore: 'Down for merchants',
    keyGoal: 'Down for your daily goal',
    // The result right under it
    heroSpare: '{d}: covered, {n} spare',
    heroSpareShort: 'Covered, {n} spare',
    heroZero: '{d}: covered, $0 spare',
    heroZeroShort: 'Covered',
    heroOnTrack: '{d}: on track at {cap} a day',
    heroOnTrackShort: 'On track at {cap}/day',
    heroShort: '{d}: short by {n}',
    heroShortShort: 'Short by {n}',
    // Autopay days: the 1st is short, the cards wait for their own autopay day
    autoHead: '{d} is {n} short even at $0 a day, so the cards wait for autopay (through {a})',
    autoHeadNoDate: '{d} is {n} short even at $0 a day, so the cards wait for autopay',
    autoHeadShort: '{d} is short, using autopay days',
    // Reference lines
    refCalc: 'Calculated {n}',
    refSaved: 'Your cap {n} a day',
    refNoSaved: 'No cap of your own yet',
    refGoal: 'Your cap {n} a day',
    // The calculated cap and your own, side by side, under the slider
    cmpCalc: 'Calculated',
    cmpCalcNote: 're-figured each morning',
    cmpMine: 'Your cap',
    cmpMineNote: 'your daily goal, fixed',
    cmpNone: 'OK saves the cap on the slider as yours',
    cmpNoneShort: 'OK saves it as yours',
    cmpLeft: '{d}: {n} left over',
    cmpLeftShort: '{n} left',
    cmpShort: '{d}: short {n}',
    cmpShortShort: 'short {n}',
    cmpFirst: '{d}: short {n}',
    // Under the result when the cards wait for autopay: the 1st itself
    heroFirst: '{d}, every card paid by hand: short {n}',
    heroFirstShort: '{d}: short {n}',
    capSaved: 'Your cap saved: {n} a day, from today on',
    usingCalc: 'Using the calculated cap',
    reset: 'Back to calculated cap',
    toastSaved: 'Your cap saved: {n} a day, from today on',
    paceHead: 'Pace',
    // Short even at $0 a day: the plain message, the one action, and why there is no slider
    shortHead: 'You\u2019re {n} short for {d} even at $0 a day',
    shortDo: 'What to do',
    shortWhy: 'A daily cap only matters once card day is covered, so there is nothing to set yet.',
    shortWhyShort: 'There is no cap to set until card day is covered.',
    // Row 6: the merchants' cut sliders
    merchantsHead: 'Merchants',
    merchantsSub: 'Cut what you would skip before {d}',
    merchantsSubShort: 'Cut what you would skip',
    cutRow: '{merchant} · {mtd} so far',
    cutRowShort: '{merchant}',
    cutAmount: 'cut {cut}',
    soFar: '{merchant} · {mtd} so far',
    soFarShort: '{merchant} · {mtd}',
    cutsLocked: 'Nothing left to cut from: the cap is $0 a day',
    cutsLockedShort: 'Nothing left to cut from',
    cutsAfter: 'Cuts open up once you are back above $0 a day.',
    cutsAfterShort: 'Cuts open once you are above $0 a day.',
    cutsTogether: 'The five together cut at most {n} (a shared order counts once)',
    cutsTogetherShort: 'The five together: at most {n}',
    // Row 7: Put it somewhere
    destHead: 'Put it somewhere',
    destHeadBy: 'Put it somewhere, on {d}',
    destSubAuto: 'What is left once autopay has paid the cards, at the cap on the slider',
    destSubAutoShort: 'Left after autopay, at this cap',
    destAuto: '{d} short {n}, autopay pays it',
    destAutoShort: '{d} short {n}',
    dest: { card: 'Card day', cardAuto: 'Cards', savings: 'Savings', awws: 'AWWS', buffer: 'Buffer', extra: 'Extra to savings' },
    destOf: '{funded} of {planned}',
    destCovered: 'Covered',
    destOnTrack: 'On track',
    destShortBy: '{funded} of {planned} · short {short}',
    destExtra: '+{n} more to savings',
    noLab: 'Card day needs a payday in the budget app',
    cardToday: 'Card day is today: {state}',
    // The runway chart (full screen). The gap label is its only figure.
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    chartHead: 'Runway to {d}, {away}',
    chartHeadMid: 'Runway to {d}',
    chartHeadShort: 'Runway',
    chartRoom: 'Headroom',
    chartOwed: 'Spending at this cap',
    chartOwedShort: 'Spending',
    gapSpare: 'Covered, {n} spare',
    gapSpareShort: '{n} spare',
    gapZero: 'Covered, $0 spare',
    gapZeroShort: 'Covered',
    gapOnTrack: 'On track, $0 spare',
    gapOnTrackShort: 'On track',
    gapShort: 'Short by {n}',
    gapShortShort: 'Short {n}',
    // The daily goal: the Pi keeps its history, a change applies from today on
    safeToday: 'calculated',
    goalHead: 'Daily goal',
    goalSetHead: 'Set a daily goal',
    goalKeys: '\u25C0 \u25B6 change \u00B7 OK save',
    goalFirst: 'Pick what you want to stay under each day',
    goalFirstShort: 'What to stay under each day',
    goalApplies: 'OK saves it from today on; past days keep theirs',
    goalAppliesShort: 'OK saves it from today on',
    goalSame: 'A change applies from today on; past days keep theirs',
    goalSameShort: 'Changes apply from today on',
    goalSending: 'Saving\u2026',
    goalFailed: 'Couldn\u2019t save: the Pi didn\u2019t answer',
    goalSaved: 'Goal saved: {n} a day, from today on',
    goalUnder: 'Under your {goal} cap: {n} of last {of} days',
    goalUnderShort: 'Under {goal}: {n} of {of} days',
    goalUnderTiny: '{n}/{of} under {goal}',
    goalRun: '{n} days in a row under {goal}',
    goalRun1: '1 day under {goal}',
    goalRunShort: '{n} in a row',
    // The streak against your cap, with what today does to it
    goalStay: 'Stay under {goal} today to make it {n} in a row',
    goalStayShort: 'Under {goal} today: {n} in a row',
    goalStart: 'Stay under {goal} today to start a streak',
    goalStartShort: 'Stay under {goal} today',
    goalFresh: 'Your cap: {goal} a day',
    graphRun: '{n} in a row',
    // The last 7 days against both caps, each judged on its own day
    weekHead: 'Last 7 days',
    weekMine: 'Your cap {goal}: {n} in a row',
    weekMineNone: 'Your cap {goal}: none in a row',
    weekCalc: 'Calculated cap: {n} in a row',
    weekMine1: 'Your cap {goal}: 1 day',
    weekCalc1: 'Calculated cap: 1 day',
    weekCalcNone: 'Calculated cap: none in a row',
    weekSpent: 'Spent',
    weekVsMine: 'vs your cap',
    weekVsCalc: 'vs calculated',
    weekNone: '\u2014',
    weekNote: 'Each day is judged against the caps it had that day; a later change never rewrites it.',
    goalOverY: 'Over {goal} yesterday ({spent})',
    goalOverYShort: 'Over yesterday',
    graphHead: 'Daily spending, last 31 days',
    graphHeadShort: 'Daily spending',
    graphGoal: '{goal} your cap',
    avgs: '7-day avg {a} vs 30-day avg {b}',
    avgsShort: '7 days {a} \u00B7 30 days {b}',
    trend: { falling: 'coming down', rising: 'going up', flat: 'steady' },
    // What these numbers mean: the info block at full screen, with today's figures
    infoHead: 'What these numbers mean',
    info: {
      calcAuto: 'Calculated, {n} a day: checking, plus the paychecks, less rent, the other bills and every card payment due through {a}, leaves {r}. Only the {k} days before {d} share it, because what you spend from {d} on goes on next month\u2019s statements. Worked out again each morning, so it moves.',
      calc: 'Calculated, {n} a day: checking, plus the paychecks, less the bills and every card paid in full on {d}, leaves {r}, shared by the {k} days before {d}. Worked out again each morning, so it moves.',
      mine: 'Your cap, {n} a day, is the number you pick (it is your daily goal too). It stays put until you change it, and each day is judged against it.',
      mineNone: 'Your cap is a number you pick: put it on the slider and press OK. It stays put until you change it.',
      first: '{d} is {n} short even at $0 a day if you pay every card by hand that day, and each dollar you spend before then adds to it. No daily cap fixes that; the cards waiting for autopay is what covers it.',
      left: 'Left over on {d} is what stays in checking once autopay has paid the cards, at the cap on the slider. It fills Savings, AWWS and Buffer in that order.',
      leftCard: 'Left over on {d} is what stays once every card is paid that day, at the cap on the slider. It fills Savings, AWWS and Buffer in that order.',
      streak: 'The streak is the days in a row, ending yesterday, that you stayed under your cap. Today counts once it is over.',
      spending: 'On the Spending tile the dotted line is the calculated cap as it stood each morning; it climbs when you spend under it.'
    }
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

  // The day the plan is worked to: card day, or the autopay day when the 1st is short.
  function dueDate(r) {
    return r.autopay && r.autopay.date ? r.autopay.date : r.cardDate;
  }

  // The plain header when the 1st is short and the plan relies on autopay days.
  function autopayForms(r) {
    var a = r.autopay;
    if (!a) return [];
    var o = { d: dateText(r.cardDate), n: cash(a.firstShort), a: dateText(a.date) };
    return [a.date ? fill(STRINGS.autoHead, o) : fill(STRINGS.autoHeadNoDate, o), fill(STRINGS.autoHeadNoDate, o), fill(STRINGS.autoHeadShort, o)];
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

  var LAB = { ctx: null, session: null, hold: null, refs: null, bound: false, chartTimer: null, chartDirty: false,
    // The goal control: value is the figure on it before OK (null: the
    // goal in force), state '' | 'sending' | 'failed'. Kept until the panel closes.
    goal: { value: null, state: '' } };

  function newSession() { return MATH() ? MATH().newSession() : { mode: 'cap', cap: null, keep: null, cuts: {} }; }
  LAB.session = newSession();

  // The saved cap as stored, or null. One from an earlier cycle (card day
  // moved on) is dropped here: never carried over.
  // Shared by every screen (app/prefs.js, 'budget.capPref' on the Pi); without
  // prefs.js, this screen's own storage as before.
  function PREFS() { var p = window.HUB_PREFS; return p && typeof p.get === 'function' && typeof p.set === 'function' ? p : null; }

  function readPref(lab) {
    var p = null;
    if (PREFS()) {
      p = PREFS().get('budget.capPref');
    } else {
      var raw = null;
      try { raw = window.localStorage ? window.localStorage.getItem(PREF_KEY) : null; } catch (e) { raw = null; }
      if (!raw) return null;
      try { p = JSON.parse(raw); } catch (e) { p = null; }
    }
    if (!p) return null;
    var cardDate = lab && typeof lab.cardDate === 'string' ? lab.cardDate : null;
    if (typeof p !== 'object' || (cardDate && p.cardDate !== cardDate)) {
      // From an earlier cycle: dropped everywhere; the goal stands in (the math module).
      if (PREFS()) PREFS().set('budget.capPref', null);
      else { try { window.localStorage.removeItem(PREF_KEY); } catch (e) { /* read as none anyway */ } }
      return null;
    }
    return p;
  }

  function writePref(p) {
    if (PREFS()) return PREFS().set('budget.capPref', p);
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
      session: LAB.session, pref: null, today: B().today() });
  }

  // Why there is nothing to show: a key of budget.js's states.
  function emptyKey() {
    var b = B();
    if (!b) return 'waiting';
    var k = b.state();
    return k === 'hidden' || !snapshot() ? k : 'waiting';
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
    var d = dateText(dueDate(r));
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

  // Covered with nothing over: the cap is the calculated one (R / D), so the
  // result is $0 by construction. That is "on track", not "plenty".
  function onTrack(r) {
    return !!(r && r.ok && r.covered && MATH().wholeDown(r.keep) === 0 && r.R > 0);
  }

  // The card day outcome: { forms (long first), tone }.
  function outcomeView(r) {
    if (r.ok) {
      var d = dateText(dueDate(r));
      if (!r.covered) return { forms: [fill(STRINGS.outcomeShort, { d: d, n: cash(r.short) }), fill(STRINGS.shortShort, { n: cash(r.short) })], tone: 'is-neg' };
      var spare = MATH().wholeDown(r.keep);
      if (spare > 0) return { forms: [fill(STRINGS.outcomeSpare, { d: d, n: cash(spare) }), fill(STRINGS.spareShort, { n: cash(spare) })], tone: 'is-ok' };
      if (onTrack(r)) return { forms: [fill(STRINGS.outcomeOnTrack, { d: d, cap: down(r.cap) }), fill(STRINGS.onTrackShort, { cap: down(r.cap) })], tone: 'is-even' };
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

  // A line of up to two lines: the long form when it fits, else the short.
  function twoLines(parent, cls, forms) {
    var node = el('div', cls, parent);
    for (var i = 0; i < forms.length; i++) {
      node.textContent = forms[i];
      if (!overH(node) && !overW(node)) return node;
    }
    return node;    // the last form, cut at the end of its second line
  }

  // The big figure: today's cap, or the shortfall when no cap covers card day.
  // { num, caps (long first), tone }
  function capView(r) {
    var mv = r.move;
    if (r.ok && mv && mv.kind === 'moveMoney') {
      var d = dateText(dueDate(r));
      return { num: cash(mv.amount), caps: [fill(STRINGS.tileShortFor, { d: d }), STRINGS.tileShortWord], tone: 'is-neg' };
    }
    if (!r.ok) return null;
    return { num: down(r.cap), caps: [STRINGS.safeToday, STRINGS.tileADay], tone: '' };
  }

  // The line under it: the card day outcome, without repeating the cap.
  function tileOutcome(r) {
    if (r.ok && r.move && r.move.kind === 'moveMoney') return null;
    // Short on card day itself, covered only by waiting for autopay days: say
    // so (amber), never a plain "covered".
    if (r.ok && r.autopay && r.covered) {
      var ao = { d: dateText(r.cardDate) };
      return { forms: [fill(STRINGS.tileAuto, ao), STRINGS.tileAutoShort], tone: 'is-even' };
    }
    // On track ($0 spare by construction) stays amber, as before: not "plenty".
    if (r.ok && onTrack(r)) {
      var d = dateText(dueDate(r));
      return { forms: [fill(STRINGS.tileKeeps, { d: d }), STRINGS.tileKeepsShort], tone: 'is-even' };
    }
    return outcomeView(r);
  }

  // The move, only when card day needs one (the streak box covers the rest).
  function tileMoveForms(r) {
    var k = r.move && r.move.kind;
    // The big figure already says how short, so moveMoney takes its short form.
    if (k === 'moveMoney') return moveForms(r).slice(1);
    return k === 'skipMerchant' || k === 'spendLess' ? moveForms(r) : [];
  }

  // Today's cap for "Stay under", or null when no cap covers card day.
  function stayCap(r) {
    var mv = r.move;
    if (mv && (mv.kind === 'newStreak' || mv.kind === 'keepStreak')) return cash(mv.cap);
    if (!r.ok || (mv && mv.kind === 'moveMoney')) return null;
    return down(r.cap);
  }

  function streakCount(s) {
    var n = s.full ? fill(STRINGS.full, { n: s.count }) : String(s.count);
    return fill(s.count === 1 && !s.full ? STRINGS.streakDay : STRINGS.streakDays, { n: n });
  }

  // The small bordered box at the bottom: the streak when there is one, and
  // always the plain "Stay under $X today". Null when there is nothing to say.
  function streakBox(root, r) {
    var s = r.streak;
    var cap = stayCap(r);
    if (!s.count && cap === null) return null;
    var box = el('div', 'bl-sbox' + (s.count ? ' is-on' : ''), root);
    if (s.count) {
      var top = el('div', 'bl-stop', box);
      var cnt = el('span', 'bl-scount', top, streakCount(s));
      var pips = el('span', 'bl-pips', top);
      for (var i = 0; i < 7; i++) el('span', 'bl-pip' + (i < s.count ? ' is-lit' : ''), pips);
      box.countEl = cnt;
      box.pipsEl = pips;
    }
    if (cap !== null) {
      var forms = s.count && !s.full ? [fill(STRINGS.stayMakeIt, { cap: cap, n: s.count + 1 })] : [];
      forms.push(fill(STRINGS.stayToday, { cap: cap }));
      box.stayEl = el('div', 'bl-stay', box);
      box.stayForms = forms;
    }
    if (!s.count) {
      var yf = yesterdayForms(r);
      if (yf.length) { box.yEl = el('div', 'bl-sy', box); box.yForms = yf; }
    }
    return box;
  }

  function fitBox(box) {
    if (!box) return;
    if (box.pipsEl && overW(box.pipsEl.parentNode)) box.pipsEl.parentNode.removeChild(box.pipsEl);
    if (box.countEl) fitForms(box.countEl, [box.countEl.textContent]);
    if (box.stayEl) fitForms(box.stayEl, box.stayForms);
    if (box.yEl) fitForms(box.yEl, box.yForms);
  }

  /* ---------- the daily goal (the Pi's history, pace.goals) ---------- */

  // The goal row's words, or null with no goal yet: { goal, forms (long
  // first), tiny, run (forms), tone, pips (the last 14 days: 'is-under',
  // 'is-over' or '') }.
  function goalView(r) {
    var t = r && r.trend;
    if (!t || t.goal === null || !t.goalDays) return null;
    var g = cash(Math.round(t.goal));
    var gd = t.goalDays;
    var map = { goal: g, n: gd.under, of: gd.of };
    var run = [];
    var tone = '';
    var n = t.streak ? t.streak.count : 0;
    var stay = n ? [fill(STRINGS.goalStay, { goal: g, n: n + 1 }), fill(STRINGS.goalStayShort, { goal: g, n: n + 1 }), fill(STRINGS.goalStartShort, { goal: g })]
      : [fill(STRINGS.goalStart, { goal: g }), fill(STRINGS.goalStartShort, { goal: g })];
    if (n) {
      var rm = { goal: g, n: n };
      run = n === 1 ? [fill(STRINGS.goalRun1, rm), fill(STRINGS.goalRunShort, rm)] : [fill(STRINGS.goalRun, rm), fill(STRINGS.goalRunShort, rm)];
      tone = 'is-ok';
    } else if (t.yesterday && t.yesterday.over) {
      run = [fill(STRINGS.goalOverY, { goal: cash(Math.round(t.yesterday.goal)), spent: near(t.yesterday.spent) }), STRINGS.goalOverYShort];
      tone = 'is-neg';
    }
    // Set today: nothing judged yet, so the box says what the cap is and what today starts.
    var fresh = !gd.of;
    var forms = fresh ? [fill(STRINGS.goalFresh, { goal: g })]
      : [fill(STRINGS.goalUnder, map), fill(STRINGS.goalUnderShort, map), fill(STRINGS.goalUnderTiny, map)];
    var pips = [];
    for (var i = t.series.length - 14; i < t.series.length; i++) {
      var d = t.series[i];
      pips.push(d && d.over === true ? 'is-over' : d && d.over === false ? 'is-under' : '');
    }
    return { goal: g, forms: forms, fresh: fresh, tiny: fresh ? forms[0] : fill(STRINGS.goalUnderTiny, map), run: run, tone: tone, pips: pips, stay: stay };
  }

  // The tile's goal box: "Under your $60 goal: 9 of last 14 days", a dot a
  // day for those 14 (green under, coral over, hollow with no entry or no
  // goal yet), then the run in a row or "Over $60 yesterday".
  function goalBox(root, r) {
    var v = goalView(r);
    var box = el('div', 'bl-sbox bl-gbox' + (v.tone === 'is-ok' ? ' is-on' : ''), root);
    box.goal = v;
    box.lineEl = el('div', 'bl-gline', box);
    var pips = el('div', 'bl-gpips', box);
    for (var i = 0; i < v.pips.length; i++) el('span', 'bl-gpip' + (v.pips[i] ? ' ' + v.pips[i] : ''), pips);
    box.pipsEl = pips;
    if (v.run.length) box.runEl = el('div', 'bl-grun' + (v.tone ? ' ' + v.tone : ''), box);
    box.stayEl = el('div', 'bl-stay', box);
    return box;
  }

  function fitGoalBox(box) {
    fitForms(box.lineEl, box.goal.forms);
    box.lineEl.style.display = '';
    if (overW(box.pipsEl)) box.removeChild(box.pipsEl);
    if (box.runEl) fitForms(box.runEl, box.goal.run);
    if (box.stayEl) fitForms(box.stayEl, box.goal.stay);
  }

  function drawTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'bu-tile bl-tile', body);
    var r = result();
    ctx.setTileSub(r ? asOf() : '');
    if (!r) return tileMessage(root, size, emptyKey());
    if (stale()) root.className += ' is-stale';
    var v = capView(r);
    if (!v) {
      // No card day result (no payday yet): the streak alone, as before.
      var sv = streakView(r);
      v = { num: sv.word ? (sv.words[1] || sv.word) : sv.num, caps: sv.word ? [] : sv.caps, tone: sv.tone };
    }

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
      var heads = [];
      for (var hi = 0; hi < v.caps.length; hi++) heads.push(v.num + ' ' + v.caps[hi]);
      heads.push(v.num);
      fitForms(head, heads);
      head.style.display = '';
      var gv = goalView(r);
      if (size.cols >= 4 && gv) {
        var grest = el('span', 'bu-strip-rest' + (gv.tone ? ' ' + gv.tone : ''), line);
        if (!fitForms(grest, [STRINGS.sep + gv.tiny])) line.removeChild(grest);
      } else if (size.cols >= 4 && r.streak.count) {
        var rest = el('span', 'bu-strip-rest is-ok', line);
        if (!fitForms(rest, [STRINGS.sep + streakCount(r.streak)])) line.removeChild(rest);
      }
      if (overW(line)) fitForms(head, [v.num]);
      return;
    }

    var hero = el('div', 'bu-hero bl-cap', root);
    hero.numEl = el('span', 'bu-hero-num' + (v.tone ? ' ' + v.tone : ''), hero, v.num);
    hero.capEl = v.caps.length ? el('span', 'bu-hero-cap', hero, v.caps[0]) : null;
    var out = tileOutcome(r);
    var ol = out ? el('div', 'bu-line bl-oline ' + out.tone, root) : null;
    var mf = tileMoveForms(r);
    var move = mf.length ? twoLines(root, 'bl-move', mf) : null;
    // With a daily goal the box shows it (the goal replaces the streak
    // against each morning's cap); with none yet, the streak box as before.
    var box = goalView(r) ? goalBox(root, r) : streakBox(root, r);

    fitWidth(hero.numEl);
    if (hero.capEl) {
      if (overW(hero.capEl) && v.caps[1]) hero.capEl.textContent = v.caps[1];
      if (overW(hero.capEl)) hero.removeChild(hero.capEl);
    }
    if (ol) fitForms(ol, out.forms);
    if (box && box.goal) fitGoalBox(box); else fitBox(box);
    // Too tall: drop yesterday (or the goal's run, then its dots), then the
    // move, then the outcome line.
    trim(root, [ol, move, box && box.pipsEl, box && (box.yEl || box.runEl), box && box.goal && box.stayEl]);
  }

  /* ---------- the panel ---------- */

  // Where a value sits on its slider, 0..1.
  function sliderSpan(r) {
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

  // The result under the big number as [long, short]: "Dec 1: covered, $214
  // spare" (green) or "Dec 1: short by $120" (coral).
  function heroForms(r) {
    var d = dateText(dueDate(r));
    if (!r.covered) {
      return [fill(STRINGS.heroShort, { d: d, n: cash(r.short) }), fill(STRINGS.heroShortShort, { n: cash(r.short) })];
    }
    var spare = MATH().wholeDown(r.keep);
    if (spare > 0) return [fill(STRINGS.heroSpare, { d: d, n: cash(spare) }), fill(STRINGS.heroSpareShort, { n: cash(spare) })];
    if (onTrack(r)) return [fill(STRINGS.heroOnTrack, { d: d, cap: down(r.cap) }), fill(STRINGS.heroOnTrackShort, { cap: down(r.cap) })];
    return [fill(STRINGS.heroZero, { d: d }), STRINGS.heroZeroShort];
  }

  // The plain case: even $0 a day leaves card day short. The math module
  // says so with its first suggested move.
  function isShortZero(r) {
    return !!(r && r.ok && r.move && r.move.kind === 'moveMoney');
  }

  // The numbers of a result into the panel's text nodes and the slider's
  // one transform (its fill). Ticks move only when the saved cap changed.
  function paint(refs, r) {
    if (!refs || !r) return;
    if (!r.ok || !refs.slider) return;
    setText(refs.big, down(r.cap));
    setTone(refs.big, 'bl-big', r.covered ? '' : 'is-neg');
    // The arrows dim at the ends of the slider: nothing more that way.
    setTone(refs.arrL, 'bl-arrow is-left', r.cap <= 0 ? 'is-end' : '');
    setTone(refs.arrR, 'bl-arrow is-right', r.cap >= r.capMax ? 'is-end' : '');
    // The fill grows from the left to the value: scaleX, set directly.
    var span = sliderSpan(r);
    var f = frac(r.cap, span);
    var tf = 'scaleX(' + (Math.round(f * 10000) / 10000) + ')';
    if (refs.fill.tf !== tf) {
      refs.fill.tf = tf;
      refs.fill.style.webkitTransform = tf;
      refs.fill.style.transform = tf;
    }
    setTone(refs.fill, 'bl-fill', r.covered ? '' : 'is-neg');
    var tickKey = (r.saved ? r.saved.cap : '') + '|' + span.hi + '|' + r.c0;
    if (refs.tickKey !== tickKey) {
      refs.tickKey = tickKey;
      refs.calcTick.style.left = pct(frac(r.c0, span));
      if (r.saved) {
        refs.savedTick.style.display = '';
        refs.savedTick.style.left = pct(frac(r.saved.cap, span));
      } else {
        refs.savedTick.style.display = 'none';
      }
    }
    setText(refs.result, heroForms(r)[refs.heroForm || 0]);
    setTone(refs.result, 'bl-result', !r.covered ? 'is-neg' : (onTrack(r) ? 'is-even' : 'is-ok'));
    if (refs.result2 && r.autopay) {
      var fm = { d: dateText(r.cardDate), n: cash(r.autopay.shortAt) };
      setText(refs.result2, fill(refs.heroForm2 ? STRINGS.heroFirstShort : STRINGS.heroFirst, fm));
    }
    paintCompare(refs, r);
    // The row under the reference lines: a reset when something moved,
    // otherwise a quiet word. Same height either way, so nothing shifts.
    var changed = !r.capIsCalculated || r.cutsAsked > 0;
    if (refs.changed !== changed) {
      refs.changed = changed;
      if (changed) { refs.reset.classList.add('f'); refs.reset.classList.add('is-on'); }
      else { refs.reset.classList.remove('f'); refs.reset.classList.remove('is-on'); refs.reset.classList.remove('is-focused'); }
      setText(refs.resetText, changed ? STRINGS.reset : STRINGS.usingCalc);
      setText(refs.resetKey, changed ? STRINGS.keyOk : refs.cuts ? STRINGS.keyMore : '');
    }
    if (refs.move) {
      var mf = moveForms(r);
      var mk = r.move && r.move.kind;
      if (refs.moveCardOnly && mk !== 'spendLess' && mk !== 'skipMerchant') mf = [];
      setText(refs.move, mf.length ? mf[0] : '');
      if (refs.moveCardOnly) setShown(refs.move, !!mf.length);
    }
    paintCuts(refs, r);
    paintDest(refs, r);
  }

  // One transform, written only when it changed.
  function setScale(node, f) {
    var tf = 'scaleX(' + (Math.round(f * 10000) / 10000) + ')';
    if (node.tf === tf) return;
    node.tf = tf;
    node.style.webkitTransform = tf;
    node.style.transform = tf;
  }

  function setShown(node, on) {
    var d = on ? '' : 'none';
    if (node && node.style.display !== d) node.style.display = d;
  }

  // Row 6: each cut's words and its fill (cut of p_i), the locked look and
  // the one note under the rows.
  function cutForms(m) {
    var map = { merchant: m.label, mtd: near(m.mtd) };
    return [fill(STRINGS.cutRow, map), fill(STRINGS.cutRowShort, map)];
  }

  function paintCuts(refs, r) {
    if (!refs.cuts) return;
    for (var i = 0; i < refs.cuts.length; i++) {
      var c = refs.cuts[i];
      var m = r.merchants[i];
      if (!m || m.label !== c.label) continue;
      setText(c.text, cutForms(m)[c.form]);
      setText(c.amount, fill(STRINGS.cutAmount, { cut: down(m.cut) }));
      setScale(c.fill, m.projected > 0 ? frac(m.cut, { lo: 0, hi: m.projected }) : 0);
      if (c.locked !== r.locked) {
        c.locked = r.locked;
        if (r.locked) c.node.classList.add('is-locked'); else c.node.classList.remove('is-locked');
      }
    }
    var note = '';
    var forms;
    if (r.locked) {
      forms = [STRINGS.cutsLocked, STRINGS.cutsLockedShort];
    } else if (r.cutsLimit !== null && r.merchants.some(function (m) { return m.max < m.projected; })) {
      forms = [fill(STRINGS.cutsTogether, { n: down(r.cutsLimit) }), fill(STRINGS.cutsTogetherShort, { n: down(r.cutsLimit) })];
    } else {
      forms = null;
    }
    if (forms) note = forms[refs.noteForm || 0];
    setText(refs.cutNote, note);
    setShown(refs.cutNote, !!note);
    setTone(refs.cutNote, 'bl-mnote', r.locked ? 'is-neg' : '');
  }

  // Row 7: card day, then the split's buckets, funded of planned.
  function destValue(row, r, refs) {
    if (row.card && r.autopay) {
      var am = { d: dateText(r.cardDate), n: cash(r.autopay.shortAt) };
      return fill(refs && refs.destForm ? STRINGS.destAutoShort : STRINGS.destAuto, am);
    }
    if (row.card) {
      if (!(row.planned > 0)) return onTrack(r) ? STRINGS.destOnTrack : STRINGS.destCovered;
      var map = { funded: down(row.funded), planned: up(row.planned), short: up(row.short) };
      return row.short > 0 ? fill(STRINGS.destShortBy, map) : fill(STRINGS.destOf, map);
    }
    return fill(STRINGS.destOf, { funded: down(row.funded), planned: near(row.planned) });
  }

  function destRows(r) {
    var d = r.destinations;
    var rows = [{ key: 'card', card: true, planned: d.card.planned, funded: d.card.funded, short: d.short }];
    for (var i = 0; i < d.buckets.length; i++) rows.push(d.buckets[i]);
    return rows;
  }

  function paintDest(refs, r) {
    if (!refs.dest || !r.destinations) return;
    var rows = destRows(r);
    for (var i = 0; i < refs.dest.length && i < rows.length; i++) {
      var b = refs.dest[i];
      var row = rows[i];
      setText(b.val, destValue(row, r, refs));
      var f = row.planned > 0 ? frac(row.funded, { lo: 0, hi: row.planned }) : (row.card ? 1 : 0);
      setScale(b.fill, f);
      var neg = row.card && row.short > 0;
      // With the autopay plan the 1st is short whatever the cap: amber, never "covered".
      var tone = neg ? 'is-neg' : row.card && r.autopay ? 'is-even' : '';
      setTone(b.fill, 'bl-dfill', tone);
      setTone(b.val, 'bl-dval', tone);
    }
    var extra = MATH().wholeDown(r.destinations.extra);
    setText(refs.destExtra, extra > 0 ? fill(STRINGS.destExtra, { n: cash(extra) }) : '');
    setShown(refs.destExtra, extra > 0);
  }

  // Lines that wrap past two take their short form; picked once when the
  // panel is drawn, so a key press never changes how many lines a row has.
  function tooTall(node, lines) {
    var cs = window.getComputedStyle(node);
    var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return node.offsetHeight - pad > lh * lines + 1;
  }

  function fitPanelForms(refs, r) {
    var again = false;
    var i;
    for (i = 0; refs.cuts && i < refs.cuts.length; i++) {
      if (refs.cuts[i].form === 0 && tooTall(refs.cuts[i].text, 2)) { refs.cuts[i].form = 1; again = true; }
    }
    if (refs.cutNote && refs.cutNote.textContent && tooTall(refs.cutNote, 2)) { refs.noteForm = 1; again = true; }
    if (refs.msub && refs.msubForms && tooTall(refs.msub, 2)) setText(refs.msub, refs.msubForms[1]);
    if (refs.result && !refs.heroForm) {
      // The long form is picked for the widest figure this slider can show, so
      // a key press never makes the line longer than its box.
      var m = MATH();
      var d = dateText(dueDate(r));
      var wide = [fill(STRINGS.heroSpare, { d: d, n: cash(Math.max(0, m.wholeDown(r.R))) }), fill(STRINGS.heroShort, { d: d, n: cash(m.wholeUp(r.capMax * r.D)) }), fill(STRINGS.heroOnTrack, { d: d, cap: cash(m.wholeDown(r.capMax)) })];
      for (i = 0; i < wide.length; i++) {
        refs.result.textContent = wide[i];
        if (overW(refs.result) || overW(refs.slider)) { refs.heroForm = 1; again = true; }
      }
      refs.result.textContent = '';
      again = true;
    }
    if (refs.result2 && !refs.result2Form) {
      // The widest figure this slider can reach, picked once like the result.
      refs.result2.textContent = fill(STRINGS.heroFirst, { d: dateText(r.cardDate), n: cash(MATH().wholeUp(r.autopay.firstShort + r.capMax * r.D)) });
      refs.result2Form = overW(refs.result2) ? 2 : 1;
      if (refs.result2Form === 2) refs.heroForm2 = true;
      again = true;
    }
    if (refs.dest && refs.dest[0] && r.autopay && !refs.destForm && tooTall(refs.dest[0].val, 1)) { refs.destForm = 1; again = true; }
    if (refs.why && tooTall(refs.why, 2)) setText(refs.why, STRINGS.shortWhyShort);
    if (refs.after && tooTall(refs.after, 3)) setText(refs.after, STRINGS.cutsAfterShort);
    if (again) paint(refs, r);
  }

  // The big number with its arrows, the one hint, and the result under it:
  // the screen's one focal point, and the one focusable row that saves.
  function drawHero(col, r, refs) {
    var sl = section(col, 'cap', 'bl-hero');
    sl.setAttribute('data-autofocus', '');
    refs.slider = sl;
    var top = el('div', 'bl-herotop', sl);
    el('div', 'bl-label', top, STRINGS.capLabel);
    el('div', 'bl-keyhint', top, STRINGS.keyCap);
    var val = el('div', 'bl-value', sl);
    refs.arrL = el('span', 'bl-arrow is-left', val);
    var mid = el('span', 'bl-valmid', val);
    refs.big = el('span', 'bl-big', mid);
    el('span', 'bl-unit', mid, STRINGS.aDay);
    refs.arrR = el('span', 'bl-arrow is-right', val);
    var track = el('div', 'bl-track', sl);
    refs.fill = el('span', 'bl-fill', track);
    refs.calcTick = el('span', 'bl-tick is-calc', track);
    refs.savedTick = el('span', 'bl-tick is-saved', track);
    el('div', 'bl-hint', sl, STRINGS.capHint);
    refs.result = el('div', 'bl-result', sl);
    if (r.autopay) refs.result2 = el('div', 'bl-result2', sl);

    drawCompare(col, r, refs);

    // Back to calculated: a row only once something moved.
    var rs = section(col, 'reset', 'bl-reset');
    refs.reset = rs;
    refs.resetText = el('span', 'bl-reset-text', rs);
    refs.resetKey = el('span', 'bl-keyhint', rs);
    rs.classList.remove('f');
    refs.changed = null;
  }

  // The calculated cap and your own, side by side: what each leaves on the
  // day the plan runs to (and, with the autopay plan, how short the 1st is).
  // The row matching the slider lights up; the figures change only with new data.
  function cmpOutcome(x, r) {
    var d = dateText(dueDate(r));
    if (x.short > 0) return { forms: [fill(STRINGS.cmpShort, { d: d, n: cash(x.short) }), fill(STRINGS.cmpShortShort, { n: cash(x.short) })], tone: 'is-neg' };
    var n = cash(MATH().wholeDown(x.keep));
    return { forms: [fill(STRINGS.cmpLeft, { d: d, n: n }), fill(STRINGS.cmpLeftShort, { n: n })], tone: 'is-ok' };
  }

  function drawCompare(col, r, refs) {
    var box = el('div', 'bl-cmp', col);
    refs.cmp = [];
    var rows = [{ key: 'calc', x: r.compare.calc, name: STRINGS.cmpCalc, note: STRINGS.cmpCalcNote },
      { key: 'mine', x: r.compare.mine, name: STRINGS.cmpMine, note: STRINGS.cmpMineNote }];
    for (var i = 0; i < rows.length; i++) {
      var w = rows[i];
      var row = el('div', 'bl-cmp-row', box);
      el('span', 'bl-dot ' + (w.key === 'calc' ? 'is-calc' : 'is-saved'), row);
      var main = el('div', 'bl-cmp-main', row);
      var name = el('div', 'bl-cmp-name', main);
      el('span', 'bl-cmp-word', name, w.name);
      if (w.x) { name.appendChild(document.createTextNode(' ')); el('span', 'bl-cmp-val', name, down(w.x.cap) + ' ' + STRINGS.aDay); }
      el('div', 'bl-cmp-note', main, w.x ? w.note : STRINGS.cmpNone);
      var out = el('div', 'bl-cmp-out', row);
      if (w.x) {
        var o = cmpOutcome(w.x, r);
        var a = el('div', 'bl-cmp-left ' + o.tone, out, o.forms[0]);
        if (tooTall(a, 1)) a.textContent = o.forms[1];
        if (w.x.firstShort !== null) el('div', 'bl-cmp-first', out, fill(STRINGS.cmpFirst, { d: dateText(r.cardDate), n: cash(w.x.firstShort) }));
      }
      refs.cmp.push({ node: row, x: w.x });
    }
  }

  function paintCompare(refs, r) {
    if (!refs.cmp) return;
    var m = MATH();
    var c = m.wholeDown(r.cap);
    for (var i = 0; i < refs.cmp.length; i++) {
      var x = refs.cmp[i].x;
      var on = !!x && m.wholeDown(x.cap) === c;
      setTone(refs.cmp[i].node, 'bl-cmp-row', on ? 'is-on' : '');
    }
  }

  // Short even at $0 a day: the message, the one action, and why there is no
  // slider. Nothing here takes focus: there is nothing to change.
  function drawShort(col, r, refs) {
    var d = dateText(dueDate(r));
    var amount = cash(r.move.amount);
    var box = el('div', 'bl-short', col);
    el('div', 'bl-short-head is-neg', box, fill(STRINGS.shortHead, { n: amount, d: d }));
    var act = el('div', 'bl-action', box);
    el('div', 'bl-action-label', act, STRINGS.shortDo);
    el('div', 'bl-action-text', act, fill(STRINGS.moves.moveMoneyShort, { n: amount, d: d }));
    refs.why = el('div', 'bl-why', box, STRINGS.shortWhy);
    var refl = el('div', 'bl-refs', col);
    var one = el('span', 'bl-ref', refl);
    el('span', 'bl-dot is-calc', one);
    el('span', 'bl-ref-text', one, fill(STRINGS.refCalc, { n: down(r.c0) }));
  }

  function drawMerchants(col, r, refs, short) {
    if (!r.merchants.length) return;
    var head = el('div', 'bl-msec', col);
    el('div', 'bu-label', head, STRINGS.merchantsHead);
    if (!r.ok || short) {
      // No cuts to make: the five as they stand, this month so far.
      for (var j = 0; j < r.merchants.length; j++) {
        var m = r.merchants[j];
        var line1 = el('div', 'bu-pline bl-mline', head, fill(STRINGS.soFar, { merchant: m.label, mtd: near(m.mtd) }));
        // One line each: a longer language takes the short form.
        if (tooTall(line1, 1)) line1.textContent = fill(STRINGS.soFarShort, { merchant: m.label, mtd: near(m.mtd) });
        if (tooTall(line1, 1)) line1.textContent = m.label + STRINGS.sep + near(m.mtd);
      }
      if (short) refs.after = el('div', 'bl-mnote', head, STRINGS.cutsAfter);
      return;
    }
    refs.msubForms = [fill(STRINGS.merchantsSub, { d: dateText(r.cardDate) }), STRINGS.merchantsSubShort];
    refs.msub = el('div', 'bl-msub', head, refs.msubForms[0]);
    refs.cuts = [];
    for (var i = 0; i < r.merchants.length; i++) {
      var row = section(col, 'cut-' + i, 'bl-cut');
      var top = el('div', 'bl-ctop', row);
      var text = el('div', 'bl-clabel', top);
      var amount = el('div', 'bl-camount', top);
      var line = el('div', 'bl-cline', row);
      var track = el('div', 'bl-track bl-ctrack', line);
      var f = el('span', 'bl-fill bl-cfill', track);
      el('span', 'bl-keyhint', line, STRINGS.keyCut);
      refs.cuts.push({ node: row, label: r.merchants[i].label, text: text, amount: amount, fill: f, form: 0 });
    }
    refs.cutNote = el('div', 'bl-mnote', col);
    refs.noteForm = 0;
  }

  function drawDest(col, r, refs) {
    if (!r.ok || !r.destinations) return;
    var box = el('div', 'bl-dest', col);
    el('div', 'bu-label', box, r.autopay && r.autopay.date ? fill(STRINGS.destHeadBy, { d: dateText(r.autopay.date) }) : STRINGS.destHead);
    if (r.autopay) {
      var sub = el('div', 'bl-msub', box, STRINGS.destSubAuto);
      if (tooTall(sub, 2)) sub.textContent = STRINGS.destSubAutoShort;
    }
    var rows = destRows(r);
    refs.dest = [];
    for (var i = 0; i < rows.length; i++) {
      var line = el('div', 'bl-drow', box);
      var top = el('div', 'bl-drow-top', line);
      var dkey = rows[i].card && r.autopay ? 'cardAuto' : rows[i].key;
      el('span', 'bl-dname' + (dkey === 'cardAuto' ? ' is-fixed' : ''), top, STRINGS.dest[dkey] || rows[i].key);
      var val = el('span', 'bl-dval', top);
      var track = el('div', 'bl-dtrack', line);
      refs.dest.push({ val: val, fill: el('span', 'bl-dfill', track) });
    }
    refs.destExtra = el('div', 'bu-pline bl-dextra', box);
  }

  // A focusable row when its key is given; the key lets a redraw keep focus on it.
  function section(parent, key, cls) {
    var s = el('div', 'bu-psec f' + (cls ? ' ' + cls : ''), parent);
    s.setAttribute('data-key', key);
    return s;
  }

  /* ---------- the daily goal in the panel ---------- */

  // The figure on the goal control: what is being tried, else the goal in
  // force, else where the math module starts one.
  function goalValue(r) {
    if (LAB.goal.value !== null) return LAB.goal.value;
    var t = r.trend;
    return t && t.goal !== null ? Math.round(t.goal) : MATH().goalStart(t);
  }

  // Your cap's record under the comparison: "Under your $60 cap: 9 of last
  // 14 days", the run in a row, and what today does to it.
  function drawGoalSum(col, r) {
    var v = goalView(r);
    if (!v) return;
    var sum = el('div', 'bl-gsum', col);
    var stay = el('div', 'bl-gsum-stay', sum, v.stay[0]);
    if (tooTall(stay, 2)) stay.textContent = v.stay[1];
  }

  // A signed difference: "−$31" under, "+$85" over, "$0" right at it.
  function diff(n) {
    var w = Math.round(n);
    return w > 0 ? '+' + cash(w) : cash(w);
  }

  function weekDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    var dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return STRINGS.daysShort[dow] + ' ' + (+m[3]);
  }

  // The last 7 days: the two streaks (your cap, the calculated cap), then a
  // row each for what was spent and the difference against each cap, green
  // under and coral over. Each day keeps the caps it had (the math module's
  // week), so a later cap never turns a past miss into a win.
  function drawWeek(col, r, refs) {
    var wk = r.week;
    if (!wk || !wk.length) return false;
    var t = r.trend;
    var sec = el('div', 'bl-wk', col);
    el('div', 'bu-label', sec, STRINGS.weekHead);
    var heads = el('div', 'bl-wk-streaks', sec);
    if (t && t.goal !== null) {
      var gn = t.streak ? t.streak.count : 0;
      var gm = { goal: cash(Math.round(t.goal)), n: gn };
      el('div', 'bl-wk-streak is-mine' + (gn ? ' is-on' : ''), heads, fill(gn === 1 ? STRINGS.weekMine1 : gn ? STRINGS.weekMine : STRINGS.weekMineNone, gm));
    }
    if (r.streak && r.streak.logged) {
      var cn = r.streak.count;
      el('div', 'bl-wk-streak is-calc' + (cn ? ' is-on' : ''), heads, fill(cn === 1 && !r.streak.full ? STRINGS.weekCalc1 : cn ? STRINGS.weekCalc : STRINGS.weekCalcNone, { n: r.streak.full ? fill(STRINGS.full, { n: cn }) : cn }));
    }
    // A row a day, newest first: the day, what was spent, then the
    // difference against each cap (green under, coral over).
    var table = el('div', 'bl-wk-table', sec);
    function row(cls, cells) {
      var rw = el('div', 'bl-wk-row ' + cls, table);
      for (var i = 0; i < cells.length; i++) el('div', 'bl-wk-cell is-c' + i + (cells[i].tone ? ' ' + cells[i].tone : ''), rw, cells[i].text);
    }
    row('is-head', [{ text: '' }, { text: STRINGS.weekSpent }, { text: STRINGS.weekVsMine }, { text: STRINGS.weekVsCalc }]);
    for (var i = wk.length - 1; i >= 0; i--) {
      var d = wk[i];
      row('is-day', [
        { text: weekDay(d.date), tone: 'is-day' },
        { text: d.spent === null ? STRINGS.weekNone : near(d.spent) },
        d.vsGoal === null ? { text: STRINGS.weekNone, tone: 'is-none' } : { text: diff(d.vsGoal), tone: d.underGoal ? 'is-ok' : 'is-neg' },
        d.vsCap === null ? { text: STRINGS.weekNone, tone: 'is-none' } : { text: diff(d.vsCap), tone: d.underCap ? 'is-ok' : 'is-neg' }
      ]);
    }
    var note = el('div', 'bl-wk-note', sec, STRINGS.weekNote);
    if (tooTall(note, 2)) sec.removeChild(note);
    // The one suggested move (spend less, skip a run) when card day needs it.
    if (refs && r.ok) {
      refs.move = el('div', 'bu-pline bl-pmove', sec);
      refs.moveCardOnly = true;
    }
    return true;
  }

  // What these numbers mean, with today's figures, in plain sentences.
  function drawInfo(col, r) {
    if (!r.ok) return;
    var box = el('div', 'bl-info', col);
    el('div', 'bu-label', box, STRINGS.infoHead);
    var I = STRINGS.info;
    var d = dateText(r.cardDate);
    var a = r.autopay && r.autopay.date ? dateText(r.autopay.date) : d;
    var map = { n: down(r.c0), d: d, a: a, r: down(Math.max(0, r.R)), k: r.D };
    var items = [fill(r.autopay ? I.calcAuto : I.calc, map)];
    var mine = r.compare && r.compare.mine;
    items.push(mine ? fill(I.mine, { n: down(mine.cap) }) : I.mineNone);
    if (r.autopay) items.push(fill(I.first, { d: d, n: cash(r.autopay.firstShort) }));
    items.push(fill(r.autopay ? I.left : I.leftCard, { d: dateText(dueDate(r)) }));
    items.push(I.streak);
    items.push(I.spending);
    for (var i = 0; i < items.length; i++) el('div', 'bl-info-item', box, items[i]);
  }

  // The goal control's figure, its arrows and the line under it.
  function paintGoal(refs, r) {
    var g = refs && refs.goal;
    if (!g) return;
    var v = goalValue(r);
    setText(g.big, cash(v));
    setTone(g.arrL, 'bl-arrow is-left', v <= 1 ? 'is-end' : '');
    setTone(g.arrR, 'bl-arrow is-right', v >= 1000 ? 'is-end' : '');
    var t = r.trend;
    var changed = !(t && t.goal !== null && Math.round(t.goal) === v);
    var note;
    var tone = '';
    if (LAB.goal.state === 'sending') note = STRINGS.goalSending;
    else if (LAB.goal.state === 'failed') { note = STRINGS.goalFailed; tone = 'is-neg'; }
    else if (!g.has && LAB.goal.value === null) note = g.noteForm ? STRINGS.goalFirstShort : STRINGS.goalFirst;
    else if (changed) { note = g.noteForm ? STRINGS.goalAppliesShort : STRINGS.goalApplies; tone = 'is-on'; }
    else note = g.noteForm ? STRINGS.goalSameShort : STRINGS.goalSame;
    setText(g.note, note);
    setTone(g.note, 'bl-gnote', tone);
  }

  // The daily spending graph: a bar a day for the last 31 days (green under
  // that day's goal, coral over it, grey with no goal yet, nothing on a day
  // with no entry), the goal as a dashed line (a step where it changed)
  // labelled "$60 goal", then the 7 and 30 day averages and the trend in
  // words. Bars are divs, placed once; no dollar axis.
  function drawGoalGraph(col, r) {
    var t = r.trend;
    if (!t || !t.series.length) return;
    var sec = el('div', 'bl-gg-sec', col);
    var head = el('div', 'bu-label bl-gg-head', sec);
    fitForms(head, [STRINGS.graphHead, STRINGS.graphHeadShort]);
    head.style.display = '';
    var box = el('div', 'bl-gg', sec);
    var w = box.clientWidth;
    var h = box.clientHeight;
    if (!w || !h) return;
    var rem = remPx();
    var n = t.series.length;
    // The goal's label sits right of the bars, on its line.
    var gl = t.goal !== null ? el('span', 'bl-gg-glab', box, fill(STRINGS.graphGoal, { goal: cash(Math.round(t.goal)) })) : null;
    var gutter = gl ? gl.offsetWidth + rem * 0.7 : 0;
    var runN = t.streak && t.streak.count ? t.streak.count : 0;
    var topPad = rem * (runN ? 2.4 : 0.8);
    var axisH = rem * 2.2;            // the dates under the bars
    var plotH = h - topPad - axisH;
    var plotW = w - gutter;
    var hi = t.hi > 0 ? t.hi : 1;
    var slot = plotW / n;
    var gap = Math.max(2, slot * 0.22);
    function yOf(v) { return topPad + plotH - Math.min(1, v / hi) * plotH; }
    var base = el('div', 'bl-gg-base', box);
    base.style.top = px(topPad + plotH) + 'px';
    base.style.width = px(plotW) + 'px';
    for (var i = 0; i < n; i++) {
      var d = t.series[i];
      if (d.spent === null) continue;
      var bh = Math.max(rem * 0.15, Math.min(1, d.spent / hi) * plotH);
      var bar = el('div', 'bl-gg-bar' + (d.over === true ? ' is-over' : d.over === false ? ' is-under' : ''), box);
      bar.style.left = px(i * slot + gap / 2) + 'px';
      bar.style.width = px(slot - gap) + 'px';
      bar.style.top = px(topPad + plotH - bh) + 'px';
      bar.style.height = px(bh) + 'px';
    }
    // The goal line: one dashed run per stretch of days with the same goal.
    var lastLine = null;
    for (i = 0; i < n; i++) {
      var gday = t.series[i].goal;
      if (gday === null) { lastLine = null; continue; }
      if (lastLine && lastLine.goal === gday) {
        lastLine.to = i;
      } else {
        lastLine = { goal: gday, from: i, to: i, node: el('div', 'bl-gg-goal', box) };
        lastLine.node.style.top = px(yOf(gday)) + 'px';
        lastLine.node.style.left = px(i * slot) + 'px';
      }
      lastLine.node.style.width = px((lastLine.to - lastLine.from + 1) * slot) + 'px';
    }
    if (gl) gl.style.top = px(yOf(t.goal) - gl.offsetHeight / 2) + 'px';
    // The run in a row under your cap, ending yesterday: a green bracket over
    // those days with "2 in a row", so the streak is there to see.
    if (runN) {
      var from = n;
      for (var k = n - 1, left = runN; k >= 0 && left > 0; k--) {
        if (t.series[k].over === false) { from = k; left--; }
      }
      if (from < n) {
        var br = el('div', 'bl-gg-run', box);
        br.style.left = px(from * slot + gap / 2) + 'px';
        br.style.width = px((n - from) * slot - gap) + 'px';
        br.style.top = px(topPad - rem * 0.55) + 'px';
        var rl = el('span', 'bl-gg-runlab', box, fill(STRINGS.graphRun, { n: runN }));
        rl.style.right = px(Math.max(0, w - n * slot)) + 'px';
        rl.style.top = px(topPad - rem * 2.1) + 'px';
      }
    }
    // The first and last dates under the bars.
    var first = el('span', 'bl-gg-date', box, dateText(t.series[0].date));
    first.style.top = px(topPad + plotH + rem * 0.35) + 'px';
    var last = el('span', 'bl-gg-date is-end', box, dateText(t.series[n - 1].date));
    last.style.top = first.style.top;
    last.style.right = px(gutter) + 'px';
    // The averages and the trend in words.
    if (t.avg7 !== null && t.avg30 !== null) {
      var am = { a: near(t.avg7), b: near(t.avg30) };
      var avg = el('div', 'bl-gg-avg', sec);
      var at = el('span', 'bl-gg-avgt', avg, fill(STRINGS.avgs, am));
      if (t.trend) el('span', 'bl-gg-trend is-' + t.trend, avg, STRINGS.sep + STRINGS.trend[t.trend]);
      if (tooTall(avg, 2)) setText(at, fill(STRINGS.avgsShort, am));
    }
  }

  // The streak: a plain block, never focusable (nothing to change here).
  function drawPace(col, r, refs, short) {
    var sec = el('div', 'bl-pace', col);
    var v = streakView(r);
    var hero = streakHero(sec, v, 'is-panel');
    var yf = yesterdayForms(r);
    if (yf.length) el('div', 'bu-pline', sec, yf[0]);
    var mf = moveForms(r);
    // Short even at $0 a day: the action is already the headline.
    refs.move = !short && (mf.length || r.ok) ? el('div', 'bu-pline bl-pmove', sec, mf.length ? mf[0] : '') : null;
    refs.paceHero = hero;
    refs.paceView = v;
    return sec;
  }

  /* ---------- the runway chart (full screen only) ---------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CHART_EVERY = 120;   // ms: the owed line and the gap at most this often during a hold

  function svgEl(tag, cls, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (cls) node.setAttribute('class', cls);
    if (parent) parent.appendChild(node);
    return node;
  }

  function remPx() { return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16; }

  function px(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  // The gap on card day as [long, short]: the chart's one figure.
  function gapForms(r) {
    if (!r.covered) return [fill(STRINGS.gapShort, { n: cash(r.short) }), fill(STRINGS.gapShortShort, { n: cash(r.short) })];
    var spare = MATH().wholeDown(r.keep);
    if (spare > 0) return [fill(STRINGS.gapSpare, { n: cash(spare) }), fill(STRINGS.gapSpareShort, { n: cash(spare) })];
    if (onTrack(r)) return [STRINGS.gapOnTrack, STRINGS.gapOnTrackShort];
    return [STRINGS.gapZero, STRINGS.gapZeroShort];
  }

  // A label in the chart box at (x, y): its middle on x, its top at y.
  function chartLabel(box, cls, text, x, y) {
    var node = el('span', 'bl-ch-lab' + (cls ? ' ' + cls : ''), box, text);
    node.style.left = px(x) + 'px';
    node.style.top = px(y) + 'px';
    return node;
  }

  function drawChart(col, r, refs) {
    var m = MATH();
    var d = snapshot();
    var c = m.runwayChart(d && d.runway, r);
    var sec = el('div', 'bl-chart-sec', col);
    var head = el('div', 'bu-label bl-chart-head', sec);
    if (!c) {
      // No runway sent (yet): the lab's own words for a missing section.
      var msg = stateText('waiting');
      head.textContent = STRINGS.chartHeadShort;
      el('div', 'bu-pline is-quiet bl-chart-empty', sec, msg.head);
      return;
    }
    fitForms(head, [fill(STRINGS.chartHead, { d: dateText(r.cardDate), away: awayText(r.D) }), fill(STRINGS.chartHeadMid, { d: dateText(r.cardDate) }), STRINGS.chartHeadShort]);
    head.style.display = '';
    var legend = el('div', 'bl-legend', sec);
    var li = el('span', 'bl-leg', legend);
    el('span', 'bl-leg-swatch is-room', li);
    el('span', 'bl-leg-text', li, STRINGS.chartRoom);
    li = el('span', 'bl-leg', legend);
    el('span', 'bl-leg-swatch is-owed', li);
    var owedText = el('span', 'bl-leg-text', li, STRINGS.chartOwed);
    if (overH(legend) || legend.offsetHeight > owedText.offsetHeight * 1.6) owedText.textContent = STRINGS.chartOwedShort;

    var box = el('div', 'bl-chart', sec);
    var w = box.clientWidth;
    var h = box.clientHeight;
    if (!w || !h) return;
    var rem = remPx();

    // The gap label, top right: its form is picked once, for the widest gap
    // this chart can show (R and P both lie inside the y range).
    var gap = el('div', 'bl-ch-gap', box);
    var wide = cash(m.wholeUp(c.hi - c.lo));
    var form = 0;
    var tries = [fill(STRINGS.gapSpare, { n: wide }), fill(STRINGS.gapShort, { n: wide }), STRINGS.gapOnTrack];
    for (var t = 0; t < tries.length; t++) {
      gap.textContent = tries[t];
      if (overW(gap)) form = 1;
    }
    var gapH = gap.offsetHeight;

    var X0 = rem * 1.8;
    var X1 = w - rem * 0.3;
    var Y0 = gapH + rem * 0.6;
    var axisH = rem * 2.5;
    var Y1 = h - axisH;
    if (Y1 - Y0 < rem * 3) return;
    var D = c.days;
    function x(day) { return X0 + day / D * (X1 - X0); }
    function y(v) {
      var f = (c.hi - v) / (c.hi - c.lo);
      return Y0 + (f < 0 ? 0 : f > 1 ? 1 : f) * (Y1 - Y0);
    }

    var svg = svgEl('svg', 'bl-ch-svg', null);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('aria-hidden', 'true');
    box.insertBefore(svg, gap);

    // Zero (where the owed line starts), the x axis with a tick a day, and
    // the card day rule.
    var zero = svgEl('line', 'bl-ch-zero', svg);
    zero.setAttribute('x1', px(X0));
    zero.setAttribute('x2', px(X1));
    zero.setAttribute('y1', px(y(0)));
    zero.setAttribute('y2', px(y(0)));
    var axis = 'M' + px(X0) + ',' + px(Y1) + 'H' + px(X1);
    for (var i = 0; i < c.ticks.length; i++) axis += 'M' + px(x(c.ticks[i].day)) + ',' + px(Y1) + 'v' + px(rem * 0.35);
    svgEl('path', 'bl-ch-axis', svg).setAttribute('d', axis);
    var rule = svgEl('line', 'bl-ch-rule', svg);
    rule.setAttribute('x1', px(X1));
    rule.setAttribute('x2', px(X1));
    rule.setAttribute('y1', px(Y0 - rem * 0.3));
    rule.setAttribute('y2', px(Y1));

    // The headroom step line, then the owed line over it.
    var pts = [];
    for (i = 0; i < c.points.length; i++) pts.push(px(x(c.points[i].day)) + ',' + px(y(c.points[i].value)));
    svgEl('polyline', 'bl-ch-room', svg).setAttribute('points', pts.join(' '));
    var owed = svgEl('polyline', 'bl-ch-owed', svg);
    var end = svgEl('circle', 'bl-ch-end', svg);
    end.setAttribute('cx', px(X1));
    end.setAttribute('cy', px(y(c.end)));
    end.setAttribute('r', px(rem * 0.28));

    // Paydays: a dot on the step's top, its date above it (below when there
    // is no room above).
    var labH = 0;
    for (i = 0; i < c.paydays.length; i++) {
      var pd = c.paydays[i];
      var dot = svgEl('circle', 'bl-ch-pay', svg);
      dot.setAttribute('cx', px(x(pd.day)));
      dot.setAttribute('cy', px(y(pd.value)));
      dot.setAttribute('r', px(rem * 0.32));
      var pl = chartLabel(box, 'is-pay', dateText(pd.date), x(pd.day), 0);
      labH = pl.offsetHeight;
      var top = y(pd.value) - rem * 0.45 - labH;
      var half = pl.offsetWidth / 2;
      var cx = Math.max(half, Math.min(w - half, x(pd.day)));
      // Above the dot unless that runs into the box's top or the gap label.
      if (top < 0 || (top < gapH && cx + half > gap.offsetLeft)) top = y(pd.value) + rem * 0.45;
      pl.style.left = px(cx) + 'px';
      pl.style.top = px(top) + 'px';
    }

    // Weekdays under the axis, as many as fit; card day's date at its rule.
    var cardLab = chartLabel(box, 'is-card', dateText(c.cardDate), X1, Y1 + rem * 0.4);
    var cardW = cardLab.offsetWidth;
    var probe = chartLabel(box, '', STRINGS.daysShort[3], 0, 0);
    var dowW = probe.offsetWidth;
    box.removeChild(probe);
    var every = Math.max(1, Math.ceil((dowW + rem * 0.6) / ((X1 - X0) / D)));
    for (i = 0; i < c.ticks.length; i += every) {
      var tx = x(c.ticks[i].day);
      if (tx + dowW / 2 > X1 - cardW - rem * 0.4) break;
      chartLabel(box, '', STRINGS.daysShort[c.ticks[i].dow], tx, Y1 + rem * 0.4);
    }

    refs.chart = { owed: owed, owedFrom: px(X0) + ',' + px(y(0)), x1: px(X1), y: y, gap: gap, gapForm: form, pts: null };
    paintChart(refs.chart, r);
  }

  // The owed line's last point and the gap label: one points write and one
  // text node, nothing else in the chart changes.
  function paintChart(ch, r) {
    if (!ch || !r || !r.ok) return;
    var pts = ch.owedFrom + ' ' + ch.x1 + ',' + px(ch.y(r.planned));
    if (ch.pts !== pts) {
      ch.pts = pts;
      ch.owed.setAttribute('points', pts);
    }
    setText(ch.gap, gapForms(r)[ch.gapForm]);
    setTone(ch.gap, 'bl-ch-gap', !r.covered ? 'is-neg' : (onTrack(r) ? 'is-even' : 'is-ok'));
  }

  // During a hold: now, then at most every CHART_EVERY ms, and once more
  // after the last press (the trailing update on release).
  function chartSoon() {
    if (!LAB.refs || !LAB.refs.chart) return;
    if (LAB.chartTimer) { LAB.chartDirty = true; return; }
    paintChart(LAB.refs.chart, result());
    LAB.chartTimer = setTimeout(chartTick, CHART_EVERY);
  }

  function chartTick() {
    LAB.chartTimer = null;
    if (!LAB.chartDirty) return;
    LAB.chartDirty = false;
    if (!LAB.refs || !LAB.refs.chart) return;
    try { paintChart(LAB.refs.chart, result()); } catch (e) { warn('chart: ' + (e && e.message)); }
    LAB.chartTimer = setTimeout(chartTick, CHART_EVERY);
  }

  function chartStop() {
    if (LAB.chartTimer) clearTimeout(LAB.chartTimer);
    LAB.chartTimer = null;
    LAB.chartDirty = false;
  }

  // The short case has nothing to scroll with, so it must fit the screen: if a
  // longer language does not, it is drawn again a size smaller (is-tight).
  function drawPanel(body, ctx) {
    var root = buildPanel(body, ctx, false);
    if (root && LAB.refs && LAB.refs.short && body.scrollHeight > body.clientHeight + 1) {
      body.removeChild(root);
      buildPanel(body, ctx, true);
    }
  }

  function buildPanel(body, ctx, tight) {
    var full = ctx.mode && ctx.mode() === 'full';
    ctx.setSub(asOf());
    var root = el('div', 'bu-panel bl-panel' + (full ? ' is-full' : ''), body);
    LAB.refs = null;
    var r = result();
    if (!r) { panelMessage(root, emptyKey()); return null; }
    var short = isShortZero(r);
    var wrap = el('div', 'bu-pwrap bl-pwrap' + (short ? ' is-short' : '') + (tight ? ' is-tight' : '') + (full ? ' is-full is-cols' : '') + (stale() ? ' is-stale' : ''), root);
    var colA = el('div', 'bu-pcol', wrap);
    var colB = full ? el('div', 'bu-pcol', wrap) : null;
    var refs = { full: full, short: short };
    if (r.ok && r.autopay) {
      var ah = el('div', 'bl-autopay', colA);
      refs.autopay = ah;
      fitForms(ah, autopayForms(r));
      ah.style.display = '';
    }

    if (short) {
      drawShort(colA, r, refs);
    } else if (r.ok) {
      drawHero(colA, r, refs);
    } else {
      // No equation (no payday, or card day is today): the outcome in words.
      var ov = outcomeView(r);
      var head = el('div', 'bl-head', colA);
      el('span', ov ? 'bl-head-state ' + ov.tone : 'bl-head-state', head, ov ? ov.forms[0] : STRINGS.noLab);
    }

    // At full screen the left column is what you act on (the cap, then the
    // merchants, which scroll into view as focus moves down) and the right
    // one is what you read (the runway and Put it somewhere), always in view.
    // The pace sits between the cap and the merchants. Short even at $0 a
    // day there is nothing to act on, so the merchants join the readings.
    chartStop();
    var left = colA;
    var right = colB || colA;
    // The runway is worked to the 1st, not to the autopay days, so with autopay days there is no chart.
    if (colB && r.ok && !r.autopay) drawChart(colB, r, refs);
    // The daily goal (its control, its row, the graph) sits where the pace
    // was; with a goal set it replaces the streak against the morning cap.
    // Short even at $0 a day the screen must fit with nothing to act on, so
    // it waits until card day is covered again (the pace shows meanwhile).
    var hasGoal = !short && !!(r.trend && r.trend.goal !== null);
    // The 7 day tracker carries both streaks, so the older pace block (the
    // streak against the morning cap) only shows when it is not drawn.
    var weekShown = false;
    if (!short && snapshot() && snapshot().pace) {
      weekShown = drawWeek(left, r, refs);
      drawGoalSum(left, r);
      drawGoalGraph(left, r);
    }
    if (short) {
      if (!hasGoal) drawPace(left, r, refs, true);
      drawMerchants(right, r, refs, true);
    } else {
      if (!hasGoal && !weekShown) drawPace(left, r, refs, false);
      drawMerchants(left, r, refs, false);
      if (r.ok && r.roomCap) el('div', 'bl-note', left, fill(STRINGS.roomNote, { n: down(r.roomCap.cap) }));
      drawDest(right, r, refs);
    }
    // Short even at $0 a day the screen must fit with nothing to act on: no info block.
    if (full && !short) drawInfo(right, r);
    paint(refs, r);
    fitPanelForms(refs, r);
    if (refs.paceHero) fitWidth(refs.paceHero.numEl);
    if (refs.big) fitWidth(refs.big);
    LAB.refs = refs;
    return root;
  }

  /* ---------- keys ---------- */

  // slider: 'cap' or a merchant's label (its cut).
  function nudge(dir, slider) {
    var m = MATH();
    var r = result();
    if (!m || !r || !r.ok) return;
    var t = now();
    var h = LAB.hold;
    if (!h || h.dir !== dir || h.slider !== slider || t - h.last >= HOLD_GAP || t < h.last) {
      h = LAB.hold = { dir: dir, mode: 'cap', slider: slider, start: t, last: t };
    }
    h.last = t;
    var size = m.holdStep(t - h.start, 'cap');
    var d = dir === 'right' ? 1 : -1;
    if (slider !== 'cap') LAB.session = m.nudgeCut(LAB.session, r, slider, d, size);
    else LAB.session = m.nudgeCap(LAB.session, r, d, size);
    paint(LAB.refs, result());
    chartSoon();
  }

  // OK on the cap: the Pi stores your cap (the daily goal) from today on (its own date)
  // and pushes the budget again, which redraws the panel.
  function saveGoal(ctx, value) {
    var r = result();
    var L = window.HUB_LIVE;
    if (!r || LAB.goal.state === 'sending') return;
    var v = value === undefined ? goalValue(r) : value;
    if (!L || typeof L.post !== 'function') {
      LAB.goal.state = 'failed';
      paintGoal(LAB.refs, r);
      try { ctx.toast(STRINGS.goalFailed, 3500); } catch (e) { /* no toast */ }
      return;
    }
    LAB.goal.state = 'sending';
    paintGoal(LAB.refs, r);
    L.post('/budget/goal', { goal: v }, function (err) {
      LAB.goal.state = err ? 'failed' : '';
      try { ctx.toast(err ? STRINGS.goalFailed : fill(value === undefined ? STRINGS.goalSaved : STRINGS.capSaved, { n: cash(v) }), 3500); } catch (e) { /* no toast */ }
      if (!err) LAB.goal.value = null;
      try { if (LAB.refs) paintGoal(LAB.refs, result()); } catch (e) { /* closed meanwhile */ }
    });
  }

  // Tablet mode (ctx.tablet; no remote): a tap on the cap's arrows moves it
  // as Left and Right do, instead of the click that the hub treats as OK (save).
  function tapArrows(body) {
    if (body.__blTap) return;
    body.__blTap = true;
    body.addEventListener('click', function (e) {
      var refs = LAB.refs;
      if (!refs || !LAB.ctx || !LAB.ctx.tablet) return;
      for (var n = e.target; n && n !== body; n = n.parentNode) {
        if (n === refs.arrL || n === refs.arrR) {
          e.stopPropagation();
          LAB.hold = null;
          nudge(n === refs.arrL ? 'left' : 'right', 'cap');
          return;
        }
      }
    });
  }

  function cutOf(refs, node) {
    for (var i = 0; refs.cuts && i < refs.cuts.length; i++) if (refs.cuts[i].node === node) return i;
    return -1;
  }

  // The rows that take focus, in the order Up and Down visit them (the
  // columns do not matter): the cap, Back to calculated when it is showing,
  // then the merchants.
  function rowList(refs) {
    var out = [];
    if (refs.slider) out.push(refs.slider);
    if (refs.reset && refs.changed) out.push(refs.reset);
    for (var i = 0; refs.cuts && i < refs.cuts.length; i++) out.push(refs.cuts[i].node);
    return out;
  }

  function rowMove(dir, from, refs) {
    var list = rowList(refs);
    var at = list.indexOf(from);
    if (at < 0) return undefined;
    var to = at + (dir === 'down' ? 1 : -1);
    if (to >= 0 && to < list.length) return list[to];
    scrollBody(dir);
    return true;
  }

  // Past the first or last row the panel scrolls on by itself, so the chart,
  // Put it somewhere and the pace are reachable without a row of their own.
  function scrollBody(dir) {
    var body = document.querySelector('#panel .panel-body');
    if (!body) return;
    var step = Math.round(body.clientHeight * 0.7);
    body.scrollTop += dir === 'down' ? step : -step;
  }

  function onMove(dir, from) {
    var refs = LAB.refs;
    if (!refs) return undefined;
    if (dir === 'up' || dir === 'down') return rowMove(dir, from, refs);
    if (dir !== 'left' && dir !== 'right') return undefined;
    var i = cutOf(refs, from);
    var slider = from === refs.slider && refs.slider ? 'cap' : i >= 0 ? refs.cuts[i].label : null;
    // Back to calculated has nothing to change sideways, and Left and Right
    // must not jump to the other column.
    if (!slider) return from === refs.reset ? true : undefined;
    try { nudge(dir, slider); } catch (e) { warn('slider: ' + (e && e.message)); }
    return true;
  }

  function onSelect(target, ctx) {
    var key = target && target.getAttribute('data-key');
    var m = MATH();
    var r = result();
    if (!m || !r || !r.ok) return;
    LAB.hold = null;
    if (key === 'reset') {
      LAB.session = m.newSession();
    } else if (key === 'cap' || /^cut-\d+$/.test(key || '')) {
      // OK on the cap or on a merchant saves the cap as it stands as your
      // cap: the daily goal on the Pi, whole dollars, fixed from today on.
      // The old saved keep amount (re-averaged each morning) is cleared.
      if (readPref(snapshot().lab)) writePref(null);
      saveGoal(ctx, Math.max(1, Math.min(1000, m.wholeDown(r.cap))));
      return;
    } else {
      return;
    }
    var now2 = result();
    paint(LAB.refs, now2);
    chartStop();
    if (LAB.refs && LAB.refs.chart) paintChart(LAB.refs.chart, now2);
    // The reset row is gone after a reset: focus goes back to the cap.
    if (key === 'reset' && LAB.refs && LAB.refs.slider) ctx.focus(LAB.refs.slider);
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
    // A cap saved on another screen: the reference line and tick follow here
    // (paint only, so a slider being moved here keeps its place).
    try {
      if (PREFS() && typeof PREFS().onChange === 'function') {
        PREFS().onChange(function (key) {
          if (key !== 'budget.capPref' || !LAB.ctx || !LAB.ctx.isOpen() || !LAB.refs) return;
          var r = result();
          if (r && r.ok) paint(LAB.refs, r);
        });
      }
    } catch (e) { warn('prefs: ' + (e && e.message)); }
  }

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
    // OK on the tile opens straight to full screen; Back closes it.
    openMode: 'full',
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
      try { drawPanel(body, ctx); if (ctx.tablet) tapArrows(body); } catch (e) {
        warn('panel: ' + (e && e.message));
        broken(body);
      }
    },
    onMove: function (dir, from) { return onMove(dir, from); },
    onSelect: function (target, ctx) { try { onSelect(target, ctx); } catch (e) { warn('select: ' + (e && e.message)); } },
    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    // The tile's suggested move follows the session cap: drawn again once
    // the panel closes, not on every key press.
    onClose: function (ctx) { chartStop(); LAB.refs = null; LAB.hold = null; LAB.goal = { value: null, state: '' }; ctx.redrawTile(); }
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
    HOLD_GAP: HOLD_GAP,
    CHART_EVERY: CHART_EVERY
  };

  (window.HUB_WIDGETS = window.HUB_WIDGETS || []).push(widget);
})();
