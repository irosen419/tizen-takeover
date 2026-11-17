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
 *
 * The symbols (R, T, D, E, c0, c, F, ce, P, K, M, cs) are the plan's, section
 * (a). Dollars come in and go out rounded to cents; the work in between is
 * exact, so the calculated cap keeps exactly nothing (K = 0, not -0.06) and a
 * keep goal is kept to the cent. Whole dollar display (room rounded down, a
 * shortfall rounded up) is wholeDown / wholeUp here, done once, on cents.
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
    return {
      R: lab.room,
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
    res.effectiveCap = toCents(ce);
    res.planned = toCents(P);
    res.keep = toCents(K);
    res.covered = res.keep >= 0;
    res.short = res.covered ? 0 : wholeUp(-K);
    res.saved = saved ? { keep: toCents(saved.keep), cap: toCents(saved.cap), cardDate: saved.cardDate, at: saved.at } : null;
    res.monthly = { calculated: toCents(Mc0), saved: Ms === null ? null : toCents(Ms), session: toCents(Mc) };
    res.gapBase = saved ? 'saved' : 'calculated';
    res.gap = toCents((saved ? Ms : Mc) - Mc0);
    res.destinations = destinations(K, L.split);
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
      cut: 0
    };
  }

  // Where K goes, in one order: a card day shortfall first (nothing is free),
  // then the split's buckets in their order, then anything past them as extra.
  function destinations(K, split) {
    var Kc = toCents(K);
    var left = Kc > 0 ? Kc : 0;
    var buckets = [];
    for (var i = 0; i < split.items.length; i++) {
      var s = split.items[i];
      var funded = Math.min(left, s.amount);
      left = toCents(left - funded);
      buckets.push({ key: s.key, planned: toCents(s.amount), funded: toCents(funded) });
    }
    return { short: Kc < 0 ? toCents(-Kc) : 0, buckets: buckets, extra: toCents(left), splitSource: split.source };
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
      var v = step(isNum(s.cuts[label]) ? Math.min(s.cuts[label], r.projected) : 0, dir, size || CAP_TICK, 0, r.projected);
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
    runwayLine: runwayLine,
    toCents: toCents,
    wholeDown: wholeDown,
    wholeUp: wholeUp,
    addDays: addDays
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HUB_BUDGET_LAB_MATH = api;
})();
