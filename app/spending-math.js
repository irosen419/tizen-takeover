/*
 * The Spending widget's arithmetic (app/widgets/spending.js): every figure
 * the Spending tile and its Trend page show, worked out from the budget
 * snapshot's pace section (one spending total per day, docs/budget-snapshot.md)
 * and a dated goal history. No DOM, no clock, no storage and no words: the
 * widget brings today's date and says it all in the hub's language. Plain ES5
 * for the TV's browser; node loads the same file for dev/spending-math-test.js.
 *
 *   HUB_SPENDING_MATH.compute({ pace, history, today })   everything, below
 *   HUB_SPENDING_MATH.readDays(pace, today)    the usable days
 *   HUB_SPENDING_MATH.readHistory(list)        the usable goal entries
 *   HUB_SPENDING_MATH.goalFor(history, date)   the goal in force that day
 *   HUB_SPENDING_MATH.judgedDays(days, history)
 *   HUB_SPENDING_MATH.avgOver(days, end, n), avg7, avg30, avg7Series
 *   HUB_SPENDING_MATH.median(cents list), typical(days, end)
 *   HUB_SPENDING_MATH.underCount, streak, kept, direction
 *
 * The rules, decided once here:
 *   - Money is worked in whole cents (integers), so sums never drift; figures
 *     come back as dollars rounded to the cent.
 *   - A row is used when its date is a real YYYY-MM-DD and spent is a finite
 *     number 0 or more. Anything else (null, NaN, a negative amount, text) is
 *     skipped. A date sent twice keeps its first row.
 *   - Today is partial (the day is not over), so a row dated today or later
 *     is left out of everything: averages, judging, the streak and the chart.
 *     The last day used ("end") is the latest complete day in the data.
 *   - Windows are calendar days ending at end: the 7-day average is the mean
 *     of the days present among the last 7 dates. A missing date is no data,
 *     not $0: it is left out of the mean (the Pi was off, not a day of no
 *     spending). A day sent with spent 0 is a real $0 day and counts.
 *   - Goal history: [{ from: 'YYYY-MM-DD', goal: dollars }]. The goal for a
 *     day is the last entry on or before it, so changing the goal adds an
 *     entry and never rewrites a past day. Days before the first entry have
 *     no goal: not judged, not counted, drawn grey. A goal is more than $0.
 *   - Judged: a day present with a goal. Under means spent at or under the
 *     goal (a tie counts as under).
 *   - Under goal "N of M": over the last 14 calendar days to end, M is the
 *     judged days among them, N those at or under. Kept is the sum of
 *     (goal - spent) over the same days; it can be negative.
 *   - Streak: judged days at or under, back from end without a break; a day
 *     over, a missing date or a day with no goal ends it.
 *   - Typical day: the median of the days present in the last 30 (even
 *     count: the mean of the middle two, rounded to the cent).
 *   - Direction: the 7-day against the 30-day average in whole dollars,
 *     'down', 'up' or 'level'; null until the 30-day window holds 14 days.
 */
(function () {
  'use strict';

  var DAY_MS = 86400000;
  var CHART_DAYS = 31;
  var MIN_DAYS = 3;          // fewer complete days than this: "Trend starts building"
  var DIRECTION_MIN = 14;    // days in the 30-day window before a direction is said
  var JUDGE_WINDOW = 14;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 'YYYY-MM-DD' to a day number (days since 1970-01-01), or NaN.
  function dayNum(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return NaN;
    var y = +m[1];
    var mo = +m[2];
    var d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
    return Math.round(t / DAY_MS);
  }

  function dateOf(n) {
    var d = new Date(n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function toCents(x) { return Math.round(x * 100); }
  function dollars(c) { return c / 100; }

  /* ---------- reading ---------- */

  // The usable days, oldest first: { date, n (day number), c (cents) }.
  function readDays(pace, today) {
    var list = pace && isArr(pace.days) ? pace.days : isArr(pace) ? pace : [];
    var cut = dayNum(today);
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r !== 'object') continue;
      var n = dayNum(r.date);
      if (isNaN(n) || !isNum(r.spent) || r.spent < 0) continue;
      if (!isNaN(cut) && n >= cut) continue;
      if (seen[n]) continue;
      seen[n] = true;
      out.push({ date: r.date, n: n, c: toCents(r.spent) });
    }
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }

  // The usable goal entries, oldest first: { from, n, c }. One per date (the
  // last one sent for a date wins: that is how "change it today" replaces).
  function readHistory(list) {
    var src = isArr(list) ? list : [];
    var byDay = {};
    var days = [];
    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      if (!e || typeof e !== 'object') continue;
      var n = dayNum(e.from);
      if (isNaN(n) || !isNum(e.goal) || !(e.goal > 0)) continue;
      if (!byDay.hasOwnProperty(n)) days.push(n);
      byDay[n] = { from: e.from, n: n, c: toCents(e.goal) };
    }
    days.sort(function (a, b) { return a - b; });
    var out = [];
    for (i = 0; i < days.length; i++) out.push(byDay[days[i]]);
    return out;
  }

  function hist(h) {
    // Accept the raw list or one read already.
    if (isArr(h) && h.length && h[0] && typeof h[0].n === 'number' && typeof h[0].c === 'number') return h;
    return readHistory(h);
  }

  // The goal in force on a day, in cents, or null (before the first entry).
  function goalCents(h, n) {
    var g = null;
    for (var i = 0; i < h.length; i++) {
      if (h[i].n <= n) g = h[i].c; else break;
    }
    return g;
  }

  // The goal in force on a date, in dollars, or null.
  function goalFor(history, date) {
    var n = dayNum(date);
    if (isNaN(n)) return null;
    var c = goalCents(hist(history), n);
    return c === null ? null : dollars(c);
  }

  function daysOf(days, today) {
    if (isArr(days) && (!days.length || (days[0] && typeof days[0].n === 'number' && typeof days[0].c === 'number'))) return days;
    return readDays(days, today);
  }

  // The days that have a goal: { date, spent, goal, under, by } in dollars;
  // by is goal - spent (negative when over).
  function judgedDays(days, history) {
    var d = daysOf(days);
    var h = hist(history);
    var out = [];
    for (var i = 0; i < d.length; i++) {
      var g = goalCents(h, d[i].n);
      if (g === null) continue;
      out.push({ date: d[i].date, spent: dollars(d[i].c), goal: dollars(g), under: d[i].c <= g, by: dollars(g - d[i].c) });
    }
    return out;
  }

  /* ---------- the figures ---------- */

  function endOf(d) { return d.length ? d[d.length - 1].n : NaN; }

  function endNum(d, end) {
    if (typeof end === 'string') return dayNum(end);
    if (isNum(end)) return end;
    return endOf(d);
  }

  // The days present in the window of n calendar days ending at end.
  function windowOf(d, end, n) {
    var out = [];
    for (var i = 0; i < d.length; i++) if (d[i].n <= end && d[i].n > end - n) out.push(d[i]);
    return out;
  }

  function meanCents(list) {
    if (!list.length) return null;
    var s = 0;
    for (var i = 0; i < list.length; i++) s += list[i].c;
    return Math.round(s / list.length);
  }

  // Mean spend of the days present in the last n days to end, or null.
  function avgOver(days, end, n) {
    var d = daysOf(days);
    var e = endNum(d, end);
    if (isNaN(e)) return null;
    var m = meanCents(windowOf(d, e, n));
    return m === null ? null : dollars(m);
  }

  function avg7(days, end) { return avgOver(days, end, 7); }
  function avg30(days, end) { return avgOver(days, end, 30); }

  // The 7-day average at each day from..to (day numbers or dates): a value
  // once a whole 7-day window lies after the first day of data, else null.
  function avg7Series(days, from, to) {
    var d = daysOf(days);
    var out = [];
    if (!d.length) return out;
    var a = endNum(d, from);
    var b = endNum(d, to);
    var first = d[0].n;
    for (var n = a; n <= b; n++) {
      if (n - 6 < first) { out.push(null); continue; }
      var m = meanCents(windowOf(d, n, 7));
      out.push(m === null ? null : dollars(m));
    }
    return out;
  }

  // The median of a list of cents, in dollars, or null.
  function median(cents) {
    var a = [];
    for (var i = 0; i < (cents || []).length; i++) if (isNum(cents[i])) a.push(cents[i]);
    if (!a.length) return null;
    a.sort(function (p, q) { return p - q; });
    var mid = Math.floor(a.length / 2);
    var c = a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
    return dollars(c);
  }

  function typical(days, end) {
    var d = daysOf(days);
    var e = endNum(d, end);
    if (isNaN(e)) return null;
    var w = windowOf(d, e, 30);
    var c = [];
    for (var i = 0; i < w.length; i++) c.push(w[i].c);
    return median(c);
  }

  // { under, judged } over the last n (14) calendar days to end.
  function underCount(days, history, end, n) {
    var d = daysOf(days);
    var h = hist(history);
    var e = endNum(d, end);
    var out = { under: 0, judged: 0 };
    if (isNaN(e)) return out;
    var w = windowOf(d, e, n || JUDGE_WINDOW);
    for (var i = 0; i < w.length; i++) {
      var g = goalCents(h, w[i].n);
      if (g === null) continue;
      out.judged++;
      if (w[i].c <= g) out.under++;
    }
    return out;
  }

  // Sum of (goal - spent) over the judged days of the last n days, in
  // dollars (negative when over on balance), or null with none judged.
  function kept(days, history, end, n) {
    var d = daysOf(days);
    var h = hist(history);
    var e = endNum(d, end);
    if (isNaN(e)) return null;
    var w = windowOf(d, e, n || JUDGE_WINDOW);
    var s = 0;
    var any = false;
    for (var i = 0; i < w.length; i++) {
      var g = goalCents(h, w[i].n);
      if (g === null) continue;
      any = true;
      s += g - w[i].c;
    }
    return any ? dollars(s) : null;
  }

  function streak(days, history, end) {
    var d = daysOf(days);
    var h = hist(history);
    var e = endNum(d, end);
    if (isNaN(e)) return 0;
    var byN = {};
    for (var i = 0; i < d.length; i++) byN[d[i].n] = d[i];
    var count = 0;
    for (var n = e; byN[n]; n--) {
      var g = goalCents(h, n);
      if (g === null || byN[n].c > g) break;
      count++;
    }
    return count;
  }

  // 'down', 'up' or 'level' from the two averages in whole dollars.
  function direction(a7, a30) {
    if (!isNum(a7) || !isNum(a30)) return null;
    var x = Math.round(a7);
    var y = Math.round(a30);
    return x < y ? 'down' : x > y ? 'up' : 'level';
  }

  /* ---------- everything at once ---------- */

  /*
   * compute({ pace, history, today }) returns:
   *   ok        false with fewer than 3 complete days (then only days and
   *             building are worth reading)
   *   days      complete days used (count)
   *   building  true while ok is false and there is at least one day
   *   end       the last complete day, 'YYYY-MM-DD' or null
   *   avg7, avg30, typical    dollars or null
   *   avg30Days the days present in the 30-day window
   *   dir       'down' | 'up' | 'level' | null
   *   hasGoal   a goal is in force on end (or any chart day)
   *   goal      the goal in force on end, dollars or null
   *   under     { under, judged } over 14 days; kept dollars or null
   *   streak    whole days
   *   history   [{ from, goal }] newest first (dollars)
   *   chart     [{ date, spent (dollars or null: no data), goal (or null),
   *               over (dollars above the goal, 0 when under, null unjudged),
   *               avg7 (or null) }] for the last 31 calendar days to end
   *               (fewer when the data starts later)
   *   max       the chart's top in dollars (spend, goal and line, plus 8%)
   *   change    index in chart of the last day the goal changed (> 0), or -1
   */
  function compute(input) {
    input = input || {};
    var d = readDays(input.pace, input.today);
    var h = readHistory(input.history);
    var out = { ok: false, days: d.length, building: d.length > 0 && d.length < MIN_DAYS, end: null,
      avg7: null, avg30: null, typical: null, avg30Days: 0, dir: null, hasGoal: false, goal: null,
      under: { under: 0, judged: 0 }, kept: null, streak: 0, history: [], chart: [], max: 0, change: -1 };
    var i;
    for (i = h.length - 1; i >= 0; i--) out.history.push({ from: h[i].from, goal: dollars(h[i].c) });
    if (!d.length) return out;
    var e = endOf(d);
    out.end = dateOf(e);
    out.avg7 = avg7(d, e);
    out.avg30 = avg30(d, e);
    out.avg30Days = windowOf(d, e, 30).length;
    out.typical = typical(d, e);
    out.dir = out.avg30Days >= DIRECTION_MIN ? direction(out.avg7, out.avg30) : null;
    var gEnd = goalCents(h, e);
    out.goal = gEnd === null ? null : dollars(gEnd);
    out.under = underCount(d, h, e, JUDGE_WINDOW);
    out.kept = kept(d, h, e, JUDGE_WINDOW);
    out.streak = streak(d, h, e);

    var start = Math.max(d[0].n, e - CHART_DAYS + 1);
    var byN = {};
    for (i = 0; i < d.length; i++) byN[d[i].n] = d[i];
    var series = avg7Series(d, start, e);
    var top = 0;
    var prev = null;
    for (var n = start, k = 0; n <= e; n++, k++) {
      var row = byN[n];
      var g = goalCents(h, n);
      var c = row ? row.c : null;
      out.chart.push({ date: dateOf(n), spent: c === null ? null : dollars(c), goal: g === null ? null : dollars(g),
        over: c === null || g === null ? null : dollars(Math.max(0, c - g)), avg7: series[k] });
      if (g !== null) out.hasGoal = true;
      if (k > 0 && g !== prev && g !== null) out.change = k;
      prev = g;
      if (c !== null && c > top) top = c;
      if (g !== null && g > top) top = g;
      if (series[k] !== null && toCents(series[k]) > top) top = toCents(series[k]);
    }
    out.max = top > 0 ? dollars(Math.round(top * 1.08)) : 1;
    out.ok = d.length >= MIN_DAYS;
    return out;
  }

  var api = {
    CHART_DAYS: CHART_DAYS,
    MIN_DAYS: MIN_DAYS,
    JUDGE_WINDOW: JUDGE_WINDOW,
    DIRECTION_MIN: DIRECTION_MIN,
    compute: compute,
    readDays: readDays,
    readHistory: readHistory,
    goalFor: goalFor,
    judgedDays: judgedDays,
    avgOver: avgOver,
    avg7: avg7,
    avg30: avg30,
    avg7Series: avg7Series,
    median: median,
    typical: typical,
    underCount: underCount,
    kept: kept,
    streak: streak,
    direction: direction,
    dayNum: dayNum,
    dateOf: dateOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HUB_SPENDING_MATH = api;
})();
