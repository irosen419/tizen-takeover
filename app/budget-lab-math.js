/*
 * Budget lab's arithmetic: every equation and edge case the Budget lab tile
 * and panel need, worked out from the budget snapshot's lab, merchants, pace
 * and room sections (docs/budget-snapshot.md) plus the session and the saved
 * cap. No DOM, no clock, no storage and no words: the widget brings today's
 * date, keeps the session in memory, stores the saved cap and says it all in
 * the hub's language. Plain ES5 for the TV's browser; node loads the same file
 * for dev/budget-lab-math-test.js.
 *
 *   HUB_BUDGET_LAB_MATH.compute(input)       everything the tab shows, below
 *   HUB_BUDGET_LAB_MATH.newSession()         the calculated cap, no cuts
 *   HUB_BUDGET_LAB_MATH.nudgeCap / nudgeKeep / nudgeCut / toggleMode
 *                                            a key press on a slider or pill,
 *                                            as a new session
 *   HUB_BUDGET_LAB_MATH.normalizeSession     a session after new data:
 *                                            cuts clamped, gone merchants
 *                                            dropped, the cap kept in range
 *   HUB_BUDGET_LAB_MATH.makePref / readPref  the saved cap, as a keep amount
 *   HUB_BUDGET_LAB_MATH.holdStep(ms, mode)   the step for a held key
 *   HUB_BUDGET_LAB_MATH.runwayLine(runway)   the headroom step line
 *   HUB_BUDGET_LAB_MATH.goalTrend(pace, today)
 *                                            spending against the daily
 *                                            goal (pace.goals, by date), the
 *                                            averages and the 31 day series;
 *                                            compute's result.trend
 *   HUB_BUDGET_LAB_MATH.nudgeGoal(v, dir, size) / goalStart(trend)
 *                                            the goal control's step and start
 *   HUB_BUDGET_LAB_MATH.runwayChart(runway, result)
 *                                            that line by day from this
 *                                            morning to card day, with the
 *                                            fixed y range for the chart
 *
 * The symbols (R, T, D, E, c0, c, F, ce, P, K, M, cs) are the plan's, section
 * (a). Dollars come in and go out rounded to cents; the work in between is
 * exact, so the calculated cap keeps exactly nothing (K = 0, not -0.06) and a
 * keep goal is kept to the cent. Whole dollar display (room rounded down, a
 * shortfall rounded up) is wholeDown / wholeUp here, done once, on cents.
 *
 * Autopay days: when lab.room is below zero and lab.autopayRoom is sent, R is
 * lab.autopayRoom and result.autopay is { firstShort, date } (the whole dollars
 * short on the 1st, and lab.autopayDate); otherwise result.autopay is null.
 *
 * compute({ lab, merchants, pace, room, cardDay, session, pref, today }):
 *   lab, merchants, pace, room, cardDay  the snapshot's sections (any absent)
 *   session   { mode: 'cap' | 'keep', cap: null (calculated) | dollars,
 *               keep: dollars | null, cuts: { label: dollars } }
 *   pref      the saved cap as stored, { v: 1, cardDate, keep, at }, or null
 *   today     'YYYY-MM-DD' on the TV; the streak ends the day before it
 * It never throws on broken data; result.ok is false with result.reason
 * 'noLab' (no lab section: no payday or no checking) or 'cardDayToday'
 * (D = 0: no equation, result.cardDayToday has the outcome), and the
 * merchants, streak and yesterday still come back.
 */
(function () {
  'use strict';

  // The owner's split as the contract's fallback (docs/budget-snapshot.md,
  // lab.split): used only when the snapshot sends no split at all. The figures
  // are the owner's own plan, held in the budget app's settings; a split that
  // is sent always wins, even with fewer keys.
  var DEFAULT_SPLIT = [
    { key: 'savings', amount: 500 },
    { key: 'awws', amount: 150 },
    { key: 'buffer', amount: 350 }
  ];
  var SPLIT_KEYS = ['savings', 'awws', 'buffer', 'extra'];
  var CAP_TICK = 1;            // $ a step on the cap and the cuts, at rest
  var KEEP_TICK = 5;           // $ a step on the keep goal, at rest
  var CAP_SPAN = 100;          // the cap slider reaches max(2 c0, c0 + 100)
  var EARLY_DAYS = 3;          // E under this: no projection from m_i
  var SKIP_SHARE = 0.2;        // a merchant at 20% of the cap earns a "skip"
  var PACE_MAX = 31;           // pace.days holds at most this many days
  var HOLD = {                 // [ms held, step] for a held key, by mode
    cap: [[0, 1], [800, 5], [2000, 25]],
    keep: [[0, 5], [800, 25], [2000, 100]]
  };
  var EPS = 1e-9;

  /* ---------- numbers ---------- */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // Round to cents, the same way for a figure and its negative.
  function toCents(x) {
    var c = Math.round(Math.abs(x) * 100 + EPS) / 100;
    return x < 0 && c !== 0 ? -c : c;
  }

  // Whole dollars for the screen: room rounds down, a shortfall rounds up.
  // Both work on the cents figure, so float noise never moves a dollar.
  function wholeDown(x) { return Math.floor(toCents(x) + EPS); }
  function wholeUp(x) { return Math.ceil(toCents(x) - EPS); }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // One step of a slider: to the next multiple of size in that direction,
  // then clamped. From 95.29 a $1 step right is 96, left 95; at either end
  // the value stops (no wrap), and the top is reachable even off the grid.
  function step(value, dir, size, min, max) {
    var q = value / size;
    var next;
    if (dir > 0) {
      next = Math.floor(q + EPS) * size + size;
    } else {
      next = Math.ceil(q - EPS) * size - size;
    }
    return clamp(next, min, max);
  }

  // The step for a held key: presses less than 250 ms apart are one hold
  // (the widget times them); this says how big a step is after heldMs.
  function holdStep(heldMs, mode) {
    var table = HOLD[mode === 'keep' ? 'keep' : 'cap'];
    var size = table[0][1];
    for (var i = 0; i < table.length; i++) {
      if (heldMs >= table[i][0]) size = table[i][1];
    }
    return size;
  }

  /* ---------- dates (strings only, no clock) ---------- */

  function parseDate(s) {
    var m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function addDays(s, n) {
    var t = parseDate(s);
    if (isNaN(t)) return null;
    var d = new Date(t + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /* ---------- reading the sections ---------- */

  function readLab(lab) {
    if (!lab || typeof lab !== 'object') return null;
    if (!isNum(lab.room) || !isNum(lab.daysLeft) || lab.daysLeft < 0) return null;
    var D = Math.floor(lab.daysLeft);
    var E = isNum(lab.monthDay) && lab.monthDay >= 1 ? Math.floor(lab.monthDay) : 1;
    // Short on the 1st but the cards can wait for their autopay days: the
    // equations then run from the autopay room (still below zero when even
    // that falls short). The room as sent for the 1st is kept as "first".
    var byAuto = lab.room < 0 && isNum(lab.autopayRoom);
    return {
      R: byAuto ? lab.autopayRoom : lab.room,
      autopay: byAuto ? { first: lab.room, date: typeof lab.autopayDate === 'string' ? lab.autopayDate : null } : null,
      T: isNum(lab.spentToday) ? lab.spentToday : 0,
      D: D,
      E: E,
      cardDate: typeof lab.cardDate === 'string' ? lab.cardDate : null,
      split: readSplit(lab.split)
    };
  }

  function readSplit(split) {
    if (!split || !split.length) {
      return { source: 'default', items: DEFAULT_SPLIT.map(function (s) { return { key: s.key, amount: s.amount }; }) };
    }
    var items = [];
    var seen = {};
    for (var i = 0; i < split.length; i++) {
      var s = split[i];
      if (!s || SPLIT_KEYS.indexOf(s.key) < 0 || seen[s.key] || !isNum(s.amount) || s.amount < 0) continue;
      seen[s.key] = true;
      items.push({ key: s.key, amount: s.amount });
    }
    return { source: 'snapshot', items: items };
  }

  function readMerchants(merchants) {
    var items = merchants && merchants.items;
    var out = [];
    if (!items || !items.length) return { items: out, combined: null };
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.label !== 'string' || !isNum(it.mtd) || it.mtd < 0) continue;
      out.push({ label: it.label, mtd: it.mtd, count: isNum(it.count) ? it.count : 0 });
    }
    return { items: out, combined: isNum(merchants.combined) && merchants.combined >= 0 ? merchants.combined : null };
  }

  // p_i: the merchant's projected spend for the rest of the window, whole
  // dollars. On the 1st and 2nd there is too little month to project from,
  // so the month to date is the most a cut can be.
  function projected(mtd, D, E) {
    if (E < EARLY_DAYS) return toCents(mtd);
    return Math.round(mtd / E * D);
  }

  /* ---------- the session ---------- */

  function newSession() {
    return { mode: 'cap', cap: null, keep: null, cuts: {} };
  }

  function copySession(s) {
    var out = newSession();
    if (!s) return out;
    out.mode = s.mode === 'keep' ? 'keep' : 'cap';
    out.cap = isNum(s.cap) ? s.cap : null;
    out.keep = isNum(s.keep) ? s.keep : null;
    if (s.cuts) {
      for (var k in s.cuts) {
        if (Object.prototype.hasOwnProperty.call(s.cuts, k) && isNum(s.cuts[k]) && s.cuts[k] > 0) out.cuts[k] = s.cuts[k];
      }
    }
    return out;
  }

  /* ---------- the saved cap ---------- */

  // Stored as a keep amount, not a dollar a day, so each morning it
  // re-averages: cs = max(0, (R - keep) / D). It is what this cap keeps by
  // itself, cuts left out: cuts are session only, so the saved cap is the
  // cap that was on the slider ("Cap saved: $80 a day").
  function makePref(result, at) {
    if (!result || !result.ok) return null;
    return { v: 1, cardDate: result.cardDate, keep: toCents(result.exact.R - result.exact.c * result.D), at: at || null };
  }

  // The saved cap for this cycle, or null: none saved, a broken copy, or a
  // copy from another cycle (cardDate moved on: dropped, never carried over).
  function readPref(pref, lab) {
    var L = lab && lab.R !== undefined ? lab : readLab(lab);
    if (!pref || typeof pref !== 'object' || pref.v !== 1 || !isNum(pref.keep)) return null;
    if (!L || !L.cardDate || pref.cardDate !== L.cardDate || L.D <= 0) return null;
    var cs = Math.max(0, (L.R - pref.keep) / L.D);
    return { keep: pref.keep, cap: cs, cardDate: pref.cardDate, at: pref.at || null };
  }

  /* ---------- the pace streak ---------- */

  function under(day) {
    return Math.round(day.spent * 100) <= Math.round(day.cap * 100);
  }

  // Consecutive under days ending yesterday. A day with no logged cap (the
  // Pi was off) or no entry at all is skipped: it neither counts nor breaks.
  // A day over breaks it. open: no break in the whole list, so the streak
  // may run further back than the list (shown "31+" once the list is full).
  function streakOf(pace, today) {
    var days = readPace(pace, today);
    var count = 0;
    var logged = 0;
    var broken = false;
    for (var i = days.length - 1; i >= 0; i--) {
      var d = days[i];
      if (!isNum(d.cap)) continue;
      logged++;
      if (broken) continue;
      if (under(d)) count++; else broken = true;
    }
    return { count: count, open: !broken, full: !broken && days.length >= PACE_MAX, logged: logged };
  }

  function readPace(pace, today) {
    var list = pace && pace.days;
    var out = [];
    if (!list || !list.length) return out;
    var cut = parseDate(today);
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d || isNaN(parseDate(d.date)) || !isNum(d.spent)) continue;
      if (!isNaN(cut) && parseDate(d.date) >= cut) continue;
      out.push({ date: d.date, spent: d.spent, cap: isNum(d.cap) && d.cap > 0 ? d.cap : null });
    }
    out.sort(function (a, b) { return parseDate(a.date) - parseDate(b.date); });
    return out;
  }

  // Yesterday against its morning cap: { spent, cap, under, by }, cap null
  // when none was logged; null when the list has no yesterday.
  function yesterdayOf(pace, today) {
    var days = readPace(pace, today);
    if (!days.length) return null;
    var want = today ? addDays(today, -1) : days[days.length - 1].date;
    var d = days[days.length - 1];
    if (d.date !== want) return null;
    if (d.cap === null) return { date: d.date, spent: toCents(d.spent), cap: null, under: null, by: null };
    return {
      date: d.date,
      spent: toCents(d.spent),
      cap: toCents(d.cap),
      under: under(d),
      by: toCents(Math.abs(d.cap - d.spent))
    };
  }

  /* ---------- the fixed goal and the spending trend ---------- */

  var GOAL_WINDOW = 14;        // "9 of the last 14 days"
  var AVG_SHORT = 7;           // the 7 day average
  var AVG_LONG = 30;           // against up to 30 days
  var FLAT = 0.03;             // within 3% of the 30 day average: steady

  // The goal history as the Pi sends it (pace.goals: [{ from, goal }],
  // oldest first), cleaned: bad entries dropped, sorted, a date once.
  function readGoals(pace) {
    var list = pace && pace.goals;
    var byDate = {};
    var dates = [];
    if (!list || !list.length) return [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || isNaN(parseDate(e.from)) || !isNum(e.goal) || !(e.goal > 0)) continue;
      if (!Object.prototype.hasOwnProperty.call(byDate, e.from)) dates.push(e.from);
      byDate[e.from] = e.goal;
    }
    dates.sort();
    return dates.map(function (d) { return { from: d, goal: toCents(byDate[d]) }; });
  }

  // The goal in force on a date: the last entry from that date or before;
  // null before the first entry (no goal yet).
  function goalFor(goals, date) {
    var g = null;
    for (var i = 0; i < goals.length; i++) if (goals[i].from <= date) g = goals[i].goal;
    return g;
  }

  function mean(list) {
    if (!list.length) return null;
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i];
    return toCents(sum / list.length);
  }

  function overBy(spent, goal) { return Math.round(spent * 100) > Math.round(goal * 100); }

  // Spending per day against the daily goal, from pace.days' spent figures
  // and the Pi's goal history (pace.goals); the morning caps play no part.
  // Each day is judged against the goal in force that day, so a change never
  // rewrites a past day. Every window ends yesterday and counts back in
  // calendar days; a day with no entry, or before the first goal, is skipped
  // (neither under nor over).
  //   goal       the goal in force today, or null (none set yet)
  //   goals      the cleaned history
  //   goalDays   { under, of } over the last 14 days, or null with no goal
  //   streak     { count, open } days under in a row ending yesterday, or
  //              null; open: nothing over back to the first judged day
  //   avg7, avg30  mean spent per logged day over the last 7 / 30 days, or null
  //   n7, n30    how many logged days each average has
  //   trend      'falling' | 'rising' | 'flat' (within 3% of avg30), or null
  //              without a longer history than the 7 days
  //   series     the last 31 days, oldest first: { date, spent (null when
  //              missing), goal (that day's, or null), over (null when not judged) }
  //   hi         the graph's top: the biggest day or goal, whichever is more
  //   yesterday  { spent, goal, over } or null
  function goalTrend(pace, today) {
    var days = readPace(pace, today);
    var goals = readGoals(pace);
    var end = today && !isNaN(parseDate(today)) ? addDays(today, -1) : (days.length ? days[days.length - 1].date : null);
    var g = today && !isNaN(parseDate(today)) ? goalFor(goals, today) : (goals.length ? goals[goals.length - 1].goal : null);
    var out = { goal: g, goals: goals, goalDays: null, streak: null, avg7: null, avg30: null, n7: 0, n30: 0,
      trend: null, series: [], hi: g || 0, yesterday: null };
    if (!end) return out;
    var byDate = {};
    for (var i = 0; i < days.length; i++) byDate[days[i].date] = days[i].spent;
    var tEnd = parseDate(end);
    var a7 = [];
    var a30 = [];
    var under = 0;
    var of = 0;
    for (i = 0; i < PACE_MAX; i++) {
      var date = addDays(end, -(PACE_MAX - 1 - i));
      var has = Object.prototype.hasOwnProperty.call(byDate, date);
      var spent = has ? toCents(byDate[date]) : null;
      var dg = goalFor(goals, date);
      var back = PACE_MAX - 1 - i;
      out.series.push({ date: date, spent: spent, goal: dg, over: has && dg !== null ? overBy(spent, dg) : null });
      if (dg !== null && dg > out.hi) out.hi = dg;
      if (!has) continue;
      if (spent > out.hi) out.hi = spent;
      if (back < AVG_SHORT) a7.push(spent);
      if (back < AVG_LONG) a30.push(spent);
      if (back < GOAL_WINDOW && dg !== null) { of++; if (!overBy(spent, dg)) under++; }
    }
    out.avg7 = mean(a7);
    out.avg30 = mean(a30);
    out.n7 = a7.length;
    out.n30 = a30.length;
    if (out.avg7 !== null && out.n30 > out.n7) {
      var diff = out.avg7 - out.avg30;
      var tol = Math.max(out.avg30 * FLAT, 0.005);
      out.trend = Math.abs(diff) <= tol ? 'flat' : diff < 0 ? 'falling' : 'rising';
    }
    var last = days.length ? days[days.length - 1] : null;
    if (last && last.date === end) {
      var yg = goalFor(goals, end);
      out.yesterday = { spent: toCents(last.spent), goal: yg, over: yg === null ? null : overBy(last.spent, yg) };
    }
    if (g !== null || goals.length) {
      out.goalDays = { under: under, of: of };
      var count = 0;
      var broken = false;
      for (i = days.length - 1; i >= 0; i--) {
        if (parseDate(days[i].date) > tEnd) continue;
        var gg = goalFor(goals, days[i].date);
        if (gg === null) continue;
        if (overBy(days[i].spent, gg)) { broken = true; break; }
        count++;
      }
      out.streak = { count: count, open: !broken };
    }
    return out;
  }

  // One step of the goal control: whole dollars, GOAL_MIN to GOAL_MAX (the
  // Pi's own limits, pi/budgetgoal.js), the same held-key sizes as the cap.
  var GOAL_MIN = 1;
  var GOAL_MAX = 1000;
  function nudgeGoal(value, dir, size) {
    var v = isNum(value) ? Math.round(value) : GOAL_MIN;
    return step(clamp(v, GOAL_MIN, GOAL_MAX), dir, size || CAP_TICK, GOAL_MIN, GOAL_MAX);
  }

  // Where the goal control starts with no goal yet: the 30 day average
  // rounded down to $5, else $50.
  function goalStart(trend) {
    var a = trend && isNum(trend.avg30) ? Math.floor(trend.avg30 / 5) * 5 : 0;
    return a >= 5 ? clamp(a, GOAL_MIN, GOAL_MAX) : 50;
  }

  /* ---------- the main sum ---------- */

  function compute(input) {
    input = input || {};
    var L = readLab(input.lab);
    var M = readMerchants(input.merchants);
    var session = copySession(input.session);
    var res = {
      ok: false,
      reason: null,
      streak: streakOf(input.pace, input.today),
      yesterday: yesterdayOf(input.pace, input.today),
      trend: goalTrend(input.pace, input.today),
      merchants: [],
      move: null
    };

    if (!L) {
      res.reason = 'noLab';
      res.merchants = M.items.map(function (m) { return merchantRow(m, null); });
      return res;
    }
    res.R = toCents(L.R);
    res.T = toCents(L.T);
    res.D = L.D;
    res.E = L.E;
    res.cardDate = L.cardDate;
    // { firstShort, date } when the room is the autopay room, else null.
    res.autopay = L.autopay ? { firstShort: wholeUp(-L.autopay.first), date: L.autopay.date } : null;

    if (L.D === 0) {
      res.reason = 'cardDayToday';
      res.cardDayToday = cardDayOutcome(input.cardDay);
      res.merchants = M.items.map(function (m) { return merchantRow(m, null); });
      return res;
    }

    var R = L.R;
    var D = L.D;
    var E = L.E;
    var c0Raw = R / D;
    var c0 = Math.max(0, c0Raw);
    var capMax = Math.ceil(Math.max(2 * c0, c0 + CAP_SPAN) - EPS);

    // The cuts: each to its own p_i, then all together to the five's
    // combined total over the window (never the sum of the mtd figures).
    var rows = M.items.map(function (m) { return merchantRow(m, { D: D, E: E }); });
    var asked = 0;
    for (var i = 0; i < rows.length; i++) {
      var want = session.cuts[rows[i].label];
      rows[i].cut = isNum(want) ? clamp(want, 0, rows[i].projected) : 0;
      asked += rows[i].cut;
    }
    var combinedLimit = M.combined === null ? null : (E < EARLY_DAYS ? M.combined : M.combined * D / E);
    var Fwant = combinedLimit === null ? asked : Math.min(asked, combinedLimit);

    // The cap: set directly, or solved from the keep goal.
    var c;
    var keepGoal = null;
    var calculated = false;
    if (session.mode === 'keep') {
      keepGoal = isNum(session.keep) ? session.keep : R - c0 * D + Fwant;
      c = clamp((R + Fwant - keepGoal) / D, 0, capMax);
    } else if (session.cap === null) {
      c = c0;
      calculated = true;
    } else {
      c = clamp(session.cap, 0, capMax);
    }

    // Cuts come out of the cap and cannot make spending negative. With the
    // cap at 0 there is nothing left to cut from: the sliders lock at 0.
    var locked = c <= EPS;
    var F = locked ? 0 : Math.min(Fwant, c * D);

    // How far each cut may go from here: its own p_i, and what the five
    // together have left under combined (and under the cap's c * D, so a cut
    // never asks for spending below zero), in whole dollars. A key press on
    // a cut stops there; locked, nothing moves.
    var cutsMax = combinedLimit === null ? c * D : Math.min(combinedLimit, c * D);
    for (i = 0; i < rows.length; i++) {
      var others = toCents(asked - rows[i].cut);
      var left = Math.floor(toCents(cutsMax - others) + EPS);
      rows[i].max = locked ? 0 : Math.max(0, Math.min(rows[i].projected, left));
    }
    var ce = c - F / D;
    var P = c * D - F;
    var K = R - P;

    var saved = readPref(input.pref, L);
    var Mc0 = c0 * D;
    var Mc = c * D;
    var Ms = saved ? saved.cap * D : null;

    res.ok = true;
    res.mode = session.mode;
    res.exact = { R: R, c0: c0, c: c, F: F, K: K };
    res.c0 = toCents(c0);
    res.c0Raw = toCents(c0Raw);
    res.capMax = capMax;
    res.cap = toCents(c);
    res.capIsCalculated = calculated;
    res.keepGoal = keepGoal === null ? null : toCents(keepGoal);
    res.keepMin = toCents(R - capMax * D + F);
    res.keepMax = toCents(R + F);
    res.locked = locked;
    res.merchants = rows.map(function (r) {
      r.cut = locked ? 0 : toCents(r.cut);
      return r;
    });
    res.cutsAsked = toCents(asked);
    res.cuts = toCents(F);
    res.cutsLimited = toCents(F) < toCents(asked);
    res.cutsLimit = combinedLimit === null ? null : toCents(combinedLimit);
    res.effectiveCap = toCents(ce);
    res.planned = toCents(P);
    res.keep = toCents(K);
    res.covered = res.keep >= 0;
    res.short = res.covered ? 0 : wholeUp(-K);
    res.saved = saved ? { keep: toCents(saved.keep), cap: toCents(saved.cap), cardDate: saved.cardDate, at: saved.at } : null;
    res.monthly = { calculated: toCents(Mc0), saved: Ms === null ? null : toCents(Ms), session: toCents(Mc) };
    res.gapBase = saved ? 'saved' : 'calculated';
    res.gap = toCents((saved ? Ms : Mc) - Mc0);
    res.destinations = destinations(K, L.split, c * D - R);
    res.roomCap = roomCapNote(input.room, res.c0);
    res.move = suggestedMove(res, rows, D, R, c, F, combinedLimit);
    return res;
  }

  function merchantRow(m, win) {
    var p = win ? projected(m.mtd, win.D, win.E) : null;
    return {
      label: m.label,
      mtd: toCents(m.mtd),
      count: m.count,
      runCost: m.count > 0 ? toCents(m.mtd / m.count) : null,
      projected: p,
      cut: 0,
      max: p
    };
  }

  // Where K goes, in one order: a card day shortfall first (nothing is free),
  // then the split's buckets in their order, then anything past them as extra.
  // need is what card day is short at the session cap before any cut
  // (c * D - R, when above 0): card.planned is that, card.funded the part
  // the cuts cover, so a freed dollar fills card day before savings. With
  // K short, card day still lacks short = planned - funded.
  function destinations(K, split, need) {
    var Kc = toCents(K);
    var left = Kc > 0 ? Kc : 0;
    var cardPlanned = isNum(need) && need > 0 ? toCents(need) : 0;
    var cardShort = Kc < 0 ? toCents(-Kc) : 0;
    var card = { planned: cardPlanned, funded: toCents(Math.max(0, cardPlanned - cardShort)) };
    var buckets = [];
    for (var i = 0; i < split.items.length; i++) {
      var s = split.items[i];
      var funded = Math.min(left, s.amount);
      left = toCents(left - funded);
      buckets.push({ key: s.key, planned: toCents(s.amount), funded: toCents(funded) });
    }
    return { short: cardShort, card: card, buckets: buckets, extra: toCents(left), splitSource: split.source };
  }

  // The Daily room tile's cap when it is not the lab's calculated one (a
  // pinned hub_daily_cap, or the budget app's no-room stand-in), so the two
  // numbers on screen are not a mystery. null when they agree.
  function roomCapNote(room, c0) {
    if (!room || !isNum(room.cap)) return null;
    if (Math.abs(toCents(room.cap) - c0) < 0.005) return null;
    return { cap: toCents(room.cap) };
  }

  // Card day is today: the outcome comes from the cardDay section.
  function cardDayOutcome(cardDay) {
    if (!cardDay || typeof cardDay.covered !== 'boolean') return null;
    if (cardDay.covered) return { covered: true, short: 0 };
    return { covered: false, short: isNum(cardDay.shortBy) ? wholeUp(cardDay.shortBy) : null };
  }

  // Exactly one suggestion, the first rule that fires, as data for the
  // widget to word:
  //   moveMoney    { amount }           short even at $0 a day
  //   skipMerchant { amount, merchant } one merchant's rest of window covers it
  //   spendLess    { perDay }           a lower cap covers it
  //   newStreak    { cap }              yesterday was over
  //   keepStreak   { cap, days, skip }  skip: a merchant name or null
  function suggestedMove(res, rows, D, R, c, F, combinedLimit) {
    var i;
    if (!res.covered) {
      if (res.c0 <= 0) {
        return { kind: 'moveMoney', amount: wholeUp(-R) };
      }
      var X = wholeUp(-res.exact.K);
      for (i = 0; i < rows.length; i++) {
        var room = rows[i].projected - rows[i].cut;
        var fits = combinedLimit === null || F + X <= combinedLimit + EPS;
        if (room + EPS >= X && fits && F + X <= c * D + EPS) {
          return { kind: 'skipMerchant', amount: X, merchant: rows[i].label };
        }
      }
      return { kind: 'spendLess', perDay: wholeUp(-res.exact.K / D) };
    }
    var cap = wholeDown(c);
    if (res.yesterday && res.yesterday.under === false) {
      return { kind: 'newStreak', cap: cap };
    }
    var skip = null;
    if (c > EPS) {
      for (i = 0; i < rows.length; i++) {
        if (rows[i].projected / D >= SKIP_SHARE * c - EPS) { skip = rows[i].label; break; }
      }
    }
    return { kind: 'keepStreak', cap: cap, days: res.streak.count + 1, skip: skip };
  }

  /* ---------- key presses, as new sessions ---------- */

  function nudgeCap(session, result, dir, size) {
    var s = copySession(session);
    if (!result || !result.ok) return s;
    var from = s.mode === 'cap' && s.cap !== null ? clamp(s.cap, 0, result.capMax) : result.exact.c;
    s.mode = 'cap';
    s.cap = step(from, dir, size || CAP_TICK, 0, result.capMax);
    return s;
  }

  function nudgeKeep(session, result, dir, size) {
    var s = copySession(session);
    if (!result || !result.ok) return s;
    var from = isNum(s.keep) ? s.keep : result.exact.K;
    s.mode = 'keep';
    s.keep = step(from, dir, size || KEEP_TICK, result.keepMin, result.keepMax);
    return s;
  }

  function nudgeCut(session, result, label, dir, size) {
    var s = copySession(session);
    if (!result || !result.ok || result.locked) return s;
    for (var i = 0; i < result.merchants.length; i++) {
      var r = result.merchants[i];
      if (r.label !== label) continue;
      var hi = isNum(r.max) ? r.max : r.projected;
      var v = step(isNum(s.cuts[label]) ? Math.min(s.cuts[label], hi) : 0, dir, size || CAP_TICK, 0, hi);
      if (v > 0) s.cuts[label] = v; else delete s.cuts[label];
    }
    return s;
  }

  // The mode pills. Neither figure jumps: into keep mode the goal starts at
  // what the cap keeps now; back to cap mode the cap stays where the goal put it.
  function toggleMode(session, result) {
    var s = copySession(session);
    if (!result || !result.ok) return s;
    if (s.mode === 'cap') {
      s.mode = 'keep';
      s.keep = result.exact.K;
    } else {
      s.mode = 'cap';
      s.cap = result.exact.c;
    }
    return s;
  }

  // After new data: in cap mode the cap stays (inside the new range), in keep
  // mode the goal stays and compute re-solves the cap; cuts above a new p_i
  // clamp down and a merchant gone from the five loses its cut.
  function normalizeSession(session, result) {
    var s = copySession(session);
    if (!result || !result.ok) return s;
    if (s.mode === 'cap' && s.cap !== null) s.cap = clamp(s.cap, 0, result.capMax);
    var cuts = {};
    for (var i = 0; i < result.merchants.length; i++) {
      var r = result.merchants[i];
      if (isNum(s.cuts[r.label]) && r.projected > 0) cuts[r.label] = Math.min(s.cuts[r.label], r.projected);
    }
    s.cuts = cuts;
    return s;
  }

  /* ---------- the runway ---------- */

  // The headroom step line: today's start, then two points per step (the
  // level before and after it). end is the headroom on card day, which the
  // budget app makes equal to lab.room to the cent.
  function runwayLine(runway) {
    if (!runway || !isNum(runway.start) || !runway.steps) return null;
    var v = runway.start;
    var pts = [{ date: null, value: toCents(v) }];
    for (var i = 0; i < runway.steps.length; i++) {
      var st = runway.steps[i];
      if (!st || !isNum(st.delta)) continue;
      pts.push({ date: st.date, value: toCents(v), kind: st.kind });
      v += st.delta;
      pts.push({ date: st.date, value: toCents(v), kind: st.kind });
    }
    return { points: pts, end: toCents(v), endDate: runway.end || null };
  }

  // The runway chart's data, in days and dollars (the widget turns them into
  // pixels): the headroom line by day, 0 this morning to D on card day, with
  // a last point on card day when no step falls there; the paydays (the top
  // of each pay step); one tick a day with its weekday (0 Sunday); and the
  // y range, fixed for as long as the panel is open: 0, every headroom
  // point, and the most the owed line can reach, capMax * D, since the owed
  // line runs from 0 this morning to P = ce * D on card day and P never
  // passes c * D <= capMax * D. Steps are taken in date order (ties keep
  // their order); a step before this morning counts this morning and one
  // after card day on card day. null when there is no equation (result not
  // ok, D = 0), no usable runway, or a runway for another card day.
  function runwayChart(runway, result) {
    if (!result || !result.ok || !(result.D > 0) || !runway || !runway.steps || typeof runway.steps.length !== 'number') return null;
    if (typeof runway.end === 'string' && result.cardDate && runway.end !== result.cardDate) return null;
    var D = result.D;
    var start = addDays(result.cardDate, -D);
    if (!start) return null;
    var t0 = parseDate(start);
    var steps = [];
    for (var i = 0; i < runway.steps.length; i++) {
      var st = runway.steps[i];
      if (st && isNum(st.delta)) steps.push({ i: i, t: parseDate(st.date), st: st });
    }
    steps.sort(function (a, b) {
      var ta = isNaN(a.t) ? -Infinity : a.t;
      var tb = isNaN(b.t) ? -Infinity : b.t;
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
    });
    var line = runwayLine({ start: runway.start, end: runway.end, steps: steps.map(function (s) { return s.st; }) });
    if (!line) return null;
    function dayOf(date) {
      var t = parseDate(date);
      return isNaN(t) ? 0 : clamp(Math.round((t - t0) / 86400000), 0, D);
    }
    var points = [];
    var paydays = [];
    var lo = 0;
    var hi = 0;
    for (i = 0; i < line.points.length; i++) {
      var p = line.points[i];
      var pt = { day: p.date === null ? 0 : dayOf(p.date), value: p.value };
      points.push(pt);
      if (p.value < lo) lo = p.value;
      if (p.value > hi) hi = p.value;
      // The second point of a pay step is the level after the pay.
      if (p.kind === 'pay' && i % 2 === 0) paydays.push({ day: pt.day, date: p.date, value: p.value });
    }
    if (points[points.length - 1].day < D) points.push({ day: D, value: line.end });
    var owedMax = toCents(result.capMax * D);
    if (owedMax > hi) hi = owedMax;
    if (hi <= lo) hi = lo + 1;
    var dow0 = new Date(t0).getUTCDay();
    var ticks = [];
    for (i = 0; i <= D; i++) ticks.push({ day: i, dow: (dow0 + i) % 7 });
    return { days: D, start: start, cardDate: result.cardDate, points: points, end: line.end, paydays: paydays,
      lo: toCents(lo), hi: toCents(hi), owedMax: owedMax, ticks: ticks };
  }

  var api = {
    DEFAULT_SPLIT: DEFAULT_SPLIT,
    compute: compute,
    newSession: newSession,
    normalizeSession: normalizeSession,
    nudgeCap: nudgeCap,
    nudgeKeep: nudgeKeep,
    nudgeCut: nudgeCut,
    toggleMode: toggleMode,
    makePref: makePref,
    readPref: readPref,
    holdStep: holdStep,
    step: step,
    streak: streakOf,
    yesterday: yesterdayOf,
    goalTrend: goalTrend,
    goalFor: goalFor,
    nudgeGoal: nudgeGoal,
    goalStart: goalStart,
    runwayLine: runwayLine,
    runwayChart: runwayChart,
    toCents: toCents,
    wholeDown: wholeDown,
    wholeUp: wholeUp,
    addDays: addDays
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HUB_BUDGET_LAB_MATH = api;
})();
