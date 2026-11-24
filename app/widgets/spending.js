/*
 * Spending: everyday spending day by day, against the goal that was in force
 * each day. A tile, and at full screen the Trend page (OK on the tile opens
 * it; Back closes it). Every figure comes from app/spending-math.js
 * (HUB_SPENDING_MATH): this file has the words, the drawing and the keys.
 * The data and widgets.budget.show come from budget.js through
 * window.HUB_BUDGET, like Budget lab.
 *
 * Data: the snapshot's pace.days (one total per day, oldest first; pace.spent
 * is meant to be everyday spending only, rent and bills left out by the
 * budget app). The goal per day comes from a dated goal history
 * [{ from: 'YYYY-MM-DD', goal: dollars }], read in ONE place, goalHistory()
 * below. Until the goal history lands in the snapshot, that adapter takes
 * pace.goalHistory (or a top-level goalHistory) when present, else a single
 * pace.goal number as one entry from the first day, else nothing. With no
 * goal the tile and page still show the bars, the 7-day against the 30-day
 * average and the typical day, and leave out the goal line, "under goal"
 * and "kept".
 *
 * Tile, by size (docs/tile-sizes.md):
 *   1 column   the 7-day average alone, as big as fits;
 *   strip      "$42 a day · Down from $59" as far as it fits whole;
 *   standard   "$42 a day this week", the verdict (green when down, coral
 *              when up), 14 days of bars with the stepped goal line, and
 *              "Under your goal 12 of 14 days · $306 kept" at the bottom;
 *              pieces leave from the bottom up when there is no room;
 *   6+ wide    three numbers across (7-day average, Under goal, Kept against
 *              your goal) and 31 days with the 7-day line and direct labels
 *              ("$60 goal", "7-day $42"), dates under them when tall enough.
 *
 * Trend page (full screen): four numbers (7-day average, Under goal with the
 * streak, Kept against your goal, Typical day with the 30-day average),
 * "Everyday spending, last 31 days · Rent and bills are left out", a readout
 * of the focused day ("Tue, Nov 10 · $73  $13 over the $60 goal"), the chart
 * (bars grey, only the part over the goal red, a $0 day a dot, the goal as a
 * stepped line that moves on the day it changed with "Nov 9 · $60 goal"
 * under it, the 7-day average in sky blue), then the dated goals ("Your goal
 * $60 from Nov 9 · $75 from Oct 16"). Left and Right move the focus a day
 * (the marker glides, transform only); a tap or click on a bar focuses it.
 * Room is left in the page head for the later pages (Where it goes, Month
 * vs month); none is drawn yet.
 *
 * Motion, once per open (about 1.5 s): the bars grow from the baseline one
 * after another (scaleY, with an explicit px transform-origin on each day's
 * SVG group, since Chrome 52 has no transform-box), the goal and 7-day lines
 * sweep in from the left (scaleX and opacity), the labels fade in, the four
 * numbers rise 10px and fade in while they count up (requestAnimationFrame;
 * the last frame writes the exact figure). Only transform and opacity, at
 * most about 40 moving elements. None of it under prefers-reduced-motion,
 * in the hub's fade mode or on a slow screen (HUB_FX speed), in Guest mode
 * (no count-up) or after a dropped frame (the count jumps to the end): then
 * everything is drawn in its final state at once.
 *
 * Guest mode (guest.js, 'spending' in MONEY) blurs every dollar here: the
 * figures, the readout and the chart's labels are HTML text over the SVG, so
 * the blur finds them; the bars, lines and "12 of 14 days" stay readable.
 *
 * Words: EN below; the Spanish is in app/i18n.js under 'spending.<path>'.
 * Amounts keep their US form. Plain ES5 for the TV's browser.
 */
(function () {
  'use strict';

  var EN = {
    title: 'Spending',
    titleShort: 'Spend',
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    // {mon} short month, {d} day, {dow} short weekday
    dateShort: '{mon} {d}',
    dayDate: '{dow}, {mon} {d}',
    cash: '${n}',
    minus: '−',
    sep: ' · ',
    aDay: 'a day this week',
    aDayShort: 'a day',
    down: 'Down from {n} over 30 days',
    downShort: 'Down from {n}',
    up: 'Up from {n} over 30 days',
    upShort: 'Up from {n}',
    level: 'Level with the 30-day average',
    levelShort: 'Level',
    footUnder: 'Under your goal {n} of {m} days',
    footUnderShort: '{n} of {m} days under',
    footKept: '{n} kept',
    footOver: '{n} over',
    kpi: {
      avg7: '7-day average',
      under: 'Under goal',
      kept: 'Kept against your goal',
      typical: 'Typical day',
      avg30: '30-day average'
    },
    ofDays: 'of {m} days',
    ofDay1: 'of 1 day',
    streakN: '{n} days in a row',
    streak1: '1 day in a row',
    streak0: 'Not in a row yet',
    lastDays: 'last {m} days',
    avg30Line: '30-day average {n}',
    section: 'Everyday spending, last {m} days',
    sectionNote: 'Rent and bills are left out',
    readOver: '{n} over the {g} goal',
    readUnder: '{n} under the {g} goal',
    readEven: 'Right at the {g} goal',
    readNoGoal: 'No goal that day',
    readNoData: 'No figure for this day',
    goalLabel: '{n} goal',
    avgLabel: '7-day {n}',
    changeTick: '{d} · {n} goal',
    legend: { avg: '7-day average', goal: 'Goal', note: 'Each point is that day and the 6 before it' },
    history: 'Your goal',
    from: 'from {d}',
    noGoal: 'No goal set yet: the goal line and the days under it show once there is one.',
    hint: 'Left and right move day by day',
    hintTouch: 'Tap a day to read it',
    building: { head: 'Trend starts building', line: 'The trend needs 3 days of spending; it has {n} so far.', short: 'It needs 3 days.' }
  };

  var STRINGS = EN;

  function I18N() {
    var x = window.HUB_I18N;
    return x && typeof x.localize === 'function' ? x : null;
  }

  function localizeStrings() {
    var x = I18N();
    try { STRINGS = x ? x.localize(EN, 'spending') : EN; } catch (e) { STRINGS = EN; }
  }
  localizeStrings();

  function MATH() { return window.HUB_SPENDING_MATH; }
  function B() { return window.HUB_BUDGET; }

  /* ---------- small helpers ---------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function svgEl(tag, cls, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (cls) node.setAttribute('class', cls);
    if (parent) parent.appendChild(node);
    return node;
  }

  function fill(text, map) {
    return String(text).replace(/\{(\w+)\}/g, function (all, k) {
      return map && map.hasOwnProperty(k) ? String(map[k]) : all;
    });
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function warn(text) {
    try { if (window.console && console.warn) console.warn('Spending: ' + text); } catch (e) { /* ignore */ }
  }

  function remPx() { return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16; }
  function px(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  // Whole dollars: "$42", "−$12", "$1,806".
  function cash(n) {
    var r = Math.round(n);
    var body = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (r < 0 ? STRINGS.minus : '') + fill(STRINGS.cash, { n: body });
  }

  function parts(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === 'string' ? date : '');
    if (!m) return null;
    var dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return { y: +m[1], mon: +m[2] - 1, d: +m[3], dow: dow };
  }

  function dateText(date) {
    var p = parts(date);
    return p ? fill(STRINGS.dateShort, { mon: STRINGS.monthsShort[p.mon], d: p.d }) : '';
  }

  function dayDateText(date) {
    var p = parts(date);
    return p ? fill(STRINGS.dayDate, { dow: STRINGS.daysShort[p.dow], mon: STRINGS.monthsShort[p.mon], d: p.d }) : '';
  }

  function overH(node) { return node.scrollHeight > node.clientHeight + 1; }
  function overW(node) { return node.scrollWidth > node.clientWidth + 1; }

  function fitForms(node, forms) {
    for (var i = 0; i < forms.length; i++) {
      if (!forms[i]) continue;
      node.textContent = forms[i];
      if (!overW(node)) return true;
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

  function drop(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  function sizeOf(ctx) {
    var z = ctx && ctx.size ? ctx.size() : null;
    return z || { cols: 4, rows: 3, tier: 'tall', width: 'standard' };
  }

  /* ---------- the data ---------- */

  function snapshot() {
    var b = B();
    try { return b ? b.data() : null; } catch (e) { return null; }
  }

  /*
   * The ONE place the goal history is read (see the header). Returns the raw
   * list [{ from, goal }] or []; the math module checks every entry.
   */
  function goalHistory(d) {
    var p = d && d.pace;
    if (p && isArr(p.goalHistory)) return p.goalHistory;
    if (d && isArr(d.goalHistory)) return d.goalHistory;
    if (p && isNum(p.goal) && p.goal > 0 && isArr(p.days)) {
      var first = null;
      for (var i = 0; i < p.days.length; i++) {
        var day = p.days[i];
        if (day && typeof day.date === 'string' && (first === null || day.date < first)) first = day.date;
      }
      if (first) return [{ from: first, goal: p.goal }];
    }
    return [];
  }

  // Everything the tile and page show, or null when nothing may show.
  function result() {
    var d = snapshot();
    var m = MATH();
    if (!d || !m || !d.pace) return null;
    var today = '';
    try { today = B().today(); } catch (e) { today = ''; }
    return m.compute({ pace: d.pace, history: goalHistory(d), today: today });
  }

  function emptyKey() {
    var b = B();
    if (!b) return 'waiting';
    var k = b.state();
    return k === 'hidden' || !snapshot() ? k : 'waiting';
  }

  function stateText(key, r) {
    if (key === 'building') {
      var s = STRINGS.building;
      return { head: s.head, line: fill(s.line, { n: r ? r.days : 0 }), short: s.short };
    }
    var b = B();
    try { return b ? b.stateText(key) : { head: '', line: '', short: '' }; } catch (e) { return { head: '', line: '', short: '' }; }
  }

  function asOf() { try { return B() ? B().asOf() : ''; } catch (e) { return ''; } }
  function stale() { try { return !!(B() && B().stale()); } catch (e) { return false; } }

  /* ---------- words for a result ---------- */

  function dirForms(r) {
    if (!r.dir) return [];
    var o = { n: cash(r.avg30) };
    if (r.dir === 'down') return [fill(STRINGS.down, o), fill(STRINGS.downShort, o)];
    if (r.dir === 'up') return [fill(STRINGS.up, o), fill(STRINGS.upShort, o)];
    return [STRINGS.level, STRINGS.levelShort];
  }

  function dirTone(r) { return r.dir === 'down' ? 'is-ok' : r.dir === 'up' ? 'is-neg' : ''; }

  function judged(r) { return r.hasGoal && r.under.judged > 0; }

  function ofDays(m) { return m === 1 ? STRINGS.ofDay1 : fill(STRINGS.ofDays, { m: m }); }

  function streakText(r) {
    if (r.streak === 1) return STRINGS.streak1;
    if (r.streak > 1) return fill(STRINGS.streakN, { n: r.streak });
    return STRINGS.streak0;
  }

  function keptForms(r) {
    if (r.kept === null) return null;
    if (r.kept < 0) return { text: fill(STRINGS.footOver, { n: cash(-r.kept) }), tone: 'is-neg' };
    return { text: fill(STRINGS.footKept, { n: cash(r.kept) }), tone: 'is-ok' };
  }

  /* ---------- the chart (tile and page) ---------- */

  /*
   * Draws rows (the math module's chart rows) into box, an empty block with
   * a size. o: { avg (the 7-day line), gutter (direct labels at the right
   * end), key (the goal's "— $60 goal" key above, for the small tile), axis
   * (dates under the bars), marker (the focus marker), anim }.
   * Returns refs for the focus marker, or null when there is no room.
   */
  function drawChart(box, rows, o) {
    var w = box.clientWidth;
    var h = box.clientHeight;
    var rem = remPx();
    if (!w || !h || !rows.length) return null;
    var n = rows.length;
    var i;
    var top = 0;
    for (i = 0; i < n; i++) {
      var rw = rows[i];
      if (rw.spent !== null && rw.spent > top) top = rw.spent;
      if (rw.goal !== null && rw.goal > top) top = rw.goal;
      if (o.avg && rw.avg7 !== null && rw.avg7 > top) top = rw.avg7;
    }
    top = top > 0 ? top * 1.08 : 1;
    var last = rows[n - 1];
    var labs = el('div', 'sp-labs', box);

    // Direct labels at the right end (page, wide tile) or a key above (small tile).
    var gl = null;
    var al = null;
    var gutter = 0;
    if (o.gutter) {
      if (last.goal !== null) gl = el('span', 'sp-lab is-goal', labs, fill(STRINGS.goalLabel, { n: cash(last.goal) }));
      if (o.avg && last.avg7 !== null) al = el('span', 'sp-lab is-avg', labs, fill(STRINGS.avgLabel, { n: cash(last.avg7) }));
      gutter = Math.max(gl ? gl.offsetWidth : 0, al ? al.offsetWidth : 0);
      if (gutter > w * 0.34) { drop(gl); drop(al); gl = al = null; gutter = 0; }
      if (gutter) gutter += rem * 0.7;
    }
    var keyH = 0;
    if (o.key && last.goal !== null) {
      var key = el('span', 'sp-lab is-key', labs);
      el('span', 'sp-key', key);
      key.appendChild(document.createTextNode(fill(STRINGS.goalLabel, { n: cash(last.goal) })));
      key.style.right = '0px';
      key.style.top = '0px';
      if (key.offsetWidth > w) drop(key);
      else keyH = key.offsetHeight + rem * 0.25;
    }
    var axisH = 0;
    if (o.axis) {
      var probe = el('span', 'sp-tick', labs, '0');
      axisH = probe.offsetHeight + rem * 0.35;
      drop(probe);
    }
    var X0 = 0;
    var X1 = w - gutter;
    var T = keyH + rem * 0.25;
    var base = h - axisH - rem * 0.1;
    var plotH = base - T;
    if (plotH < rem * 1.6 || X1 - X0 < n * 2) { drop(labs); return null; }
    var slot = (X1 - X0) / n;
    var bw = Math.max(2, Math.min(slot * 0.62, rem * 0.9));
    function y(v) { return base - v / top * plotH; }
    function cx(k) { return X0 + slot * k + slot / 2; }

    var svg = svgEl('svg', 'sp-svg', null);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('aria-hidden', 'true');
    box.insertBefore(svg, labs);
    var bl = svgEl('line', 'sp-base', svg);
    bl.setAttribute('x1', px(X0));
    bl.setAttribute('x2', px(X1));
    bl.setAttribute('y1', px(base));
    bl.setAttribute('y2', px(base));

    // One group per day: it grows from the baseline as one piece.
    var bars = [];
    var rr = Math.min(bw / 2, rem * 0.18);
    var step = n > 1 ? Math.min(30, 460 / (n - 1)) : 0;
    for (i = 0; i < n; i++) {
      var r = rows[i];
      bars.push(null);
      if (r.spent === null) continue;
      var g = svgEl('g', 'sp-day', svg);
      g.style.webkitTransformOrigin = '0px ' + px(base) + 'px';
      g.style.transformOrigin = '0px ' + px(base) + 'px';
      if (o.anim) g.style.animationDelay = Math.round(80 + i * step) + 'ms';
      var x = cx(i) - bw / 2;
      if (r.spent <= 0) {
        var dot = svgEl('circle', 'sp-zero', g);
        dot.setAttribute('cx', px(cx(i)));
        dot.setAttribute('cy', px(base - rem * 0.25));
        dot.setAttribute('r', px(Math.max(1.5, Math.min(bw / 2, rem * 0.16))));
        bars[i] = dot;
        continue;
      }
      var cap = r.goal !== null && r.spent > r.goal ? r.goal : r.spent;
      var grey = svgEl('rect', 'sp-bar' + (r.goal === null ? ' is-free' : ''), g);
      grey.setAttribute('x', px(x));
      grey.setAttribute('width', px(bw));
      grey.setAttribute('y', px(y(cap)));
      grey.setAttribute('height', px(Math.max(1, base - y(cap))));
      grey.setAttribute('rx', px(cap === r.spent ? rr : 0));
      bars[i] = grey;
      if (r.over) {
        var gap = base - y(cap) > 4 ? 1.5 : 0;
        var red = svgEl('rect', 'sp-over', g);
        red.setAttribute('x', px(x));
        red.setAttribute('width', px(bw));
        red.setAttribute('y', px(y(r.spent)));
        red.setAttribute('height', px(Math.max(1, y(r.goal) - y(r.spent) - gap)));
        red.setAttribute('rx', px(rr));
      }
    }

    // The goal: a stepped line that moves on the day the goal changed.
    var d = '';
    for (i = 0; i < n; i++) {
      var gv = rows[i].goal;
      if (gv === null) continue;
      var x0 = X0 + slot * i;
      d += (i > 0 && rows[i - 1].goal !== null ? 'L' : 'M') + px(x0) + ',' + px(y(gv)) + 'L' + px(x0 + slot) + ',' + px(y(gv));
    }
    var goalPath = null;
    if (d) {
      goalPath = svgEl('path', 'sp-goal', svg);
      goalPath.setAttribute('d', d);
      goalPath.style.webkitTransformOrigin = px(X0) + 'px 0px';
      goalPath.style.transformOrigin = px(X0) + 'px 0px';
    }

    // The 7-day average, from the first day it has a whole week.
    var avgEnd = null;
    if (o.avg) {
      var a = '';
      var lastPt = null;
      for (i = 0; i < n; i++) {
        var av = rows[i].avg7;
        if (av === null) continue;
        a += (i > 0 && rows[i - 1].avg7 !== null ? 'L' : 'M') + px(cx(i)) + ',' + px(y(av));
        lastPt = [cx(i), y(av)];
      }
      if (a) {
        var avgPath = svgEl('path', 'sp-avg', svg);
        avgPath.setAttribute('d', a);
        avgPath.style.webkitTransformOrigin = px(X0) + 'px 0px';
        avgPath.style.transformOrigin = px(X0) + 'px 0px';
        if (lastPt) {
          avgEnd = svgEl('circle', 'sp-avg-end', svg);
          avgEnd.setAttribute('cx', px(lastPt[0]));
          avgEnd.setAttribute('cy', px(lastPt[1]));
          avgEnd.setAttribute('r', px(rem * 0.2));
        }
      }
    }

    // Direct labels, kept apart when the two ends are close.
    if (gl || al) {
      var gy = gl ? y(last.goal) - gl.offsetHeight / 2 : 0;
      var ay = al ? y(last.avg7) - al.offsetHeight / 2 : 0;
      if (gl && al && Math.abs(gy - ay) < gl.offsetHeight) {
        var mid = (gy + ay) / 2;
        var half = gl.offsetHeight / 2 + 1;
        if (gy <= ay) { gy = mid - half; ay = mid + half; } else { gy = mid + half; ay = mid - half; }
      }
      var maxY = base - (gl ? gl.offsetHeight : al.offsetHeight);
      if (gl) { gl.style.left = px(X1 + rem * 0.5) + 'px'; gl.style.top = px(Math.max(0, Math.min(maxY, gy))) + 'px'; }
      if (al) { al.style.left = px(X1 + rem * 0.5) + 'px'; al.style.top = px(Math.max(0, Math.min(maxY, ay))) + 'px'; }
    }

    // Dates under the bars: the day the goal changed first (bold, with its
    // goal), then the first and last day, the 1st of a month, Mondays; each
    // only when it does not run into one already placed or out of the box.
    if (o.axis) {
      var placed = [];
      var ty = base + rem * 0.3;
      var want = [];
      for (i = 0; i < n; i++) {
        var p = parts(rows[i].date);
        if (!p) continue;
        var pri = -1;
        if (i === o.change) pri = 0;
        else if (i === 0 || i === n - 1) pri = 1;
        else if (p.d === 1) pri = 2;
        else if (p.dow === 1) pri = 3;
        if (pri < 0) continue;
        var text = i === 0 || p.d === 1 ? dateText(rows[i].date) : String(p.d);
        if (i === o.change) text = fill(STRINGS.changeTick, { d: dateText(rows[i].date), n: cash(rows[i].goal) });
        want.push({ i: i, pri: pri, text: text });
      }
      want.sort(function (p1, p2) { return p1.pri - p2.pri || p1.i - p2.i; });
      var gapX = rem * 0.6;
      for (var k = 0; k < want.length; k++) {
        var t = el('span', 'sp-tick' + (want[k].pri === 0 ? ' is-change' : ''), labs, want[k].text);
        var tw = t.offsetWidth;
        var left = Math.max(0, Math.min(w - tw, cx(want[k].i) - tw / 2));
        var clash = false;
        for (var q = 0; q < placed.length; q++) {
          if (left < placed[q][1] + gapX && left + tw > placed[q][0] - gapX) { clash = true; break; }
        }
        if (clash) { drop(t); continue; }
        placed.push([left, left + tw]);
        t.style.left = px(left) + 'px';
        t.style.top = px(ty) + 'px';
      }
    }

    var refs = { rows: rows, bars: bars, slot: slot, X0: X0, cx: cx, base: base, n: n, labs: labs, goal: goalPath, avgEnd: avgEnd };
    if (o.marker) {
      var cross = el('div', 'sp-cross', box);
      cross.style.height = px(base) + 'px';
      refs.cross = cross;
    }
    return refs;
  }

  // The key to the two lines: a short dash in each line's colour and its
  // name. No figures, so Guest mode leaves it alone. No goal, no Goal entry.
  function legend(parent, r, cls) {
    var box = el('div', 'sp-legend' + (cls ? ' ' + cls : ''), parent);
    var it = el('span', 'sp-leg is-avg', box);
    el('span', 'sp-leg-dash', it);
    el('span', 'sp-leg-text', it, STRINGS.legend.avg);
    if (r.hasGoal) {
      it = el('span', 'sp-leg is-goal', box);
      el('span', 'sp-leg-dash', it);
      el('span', 'sp-leg-text', it, STRINGS.legend.goal);
    }
    // The line moves each day: say so where there is room (the page).
    if (cls === 'is-page') el('div', 'sp-leg-note', box, STRINGS.legend.note);
    return box;
  }

  /* ---------- the tile ---------- */

  function mark(parent, cls) {
    var m = el('span', 'icon sp-mark' + (cls ? ' ' + cls : ''), parent);
    m.innerHTML = (window.HUB_ICONS && window.HUB_ICONS.wallet) || '';
    return m;
  }

  function tileMessage(root, size, key, r) {
    var msg = stateText(key, r);
    if (size.cols === 1) return mark(root, 'is-solo');
    if (size.tier === 'strip') {
      root.className += ' sp-strip';
      return el('div', 'sp-strip-text sp-cut is-quiet', root, msg.head);
    }
    var box = el('div', 'sp-msg', root);
    el('div', 'sp-msg-head', box, msg.head);
    var line = msg.short ? el('div', 'sp-msg-line', box, msg.short) : null;
    if (line && overH(root)) box.removeChild(line);
    if (overH(root)) box.firstChild.className += ' is-small';
    mark(root);
    return box;
  }

  function hero(parent, r, cap) {
    var box = el('div', 'sp-hero', parent);
    box.numEl = el('span', 'sp-hero-num', box, cash(r.avg7));
    if (cap) box.capEl = el('span', 'sp-hero-cap', box, cap);
    return box;
  }

  function fitHero(box) {
    fitWidth(box.numEl);
    var cap = box.capEl;
    function wrapped() { return cap.offsetLeft <= box.numEl.offsetLeft + 1 || overW(cap); }
    if (cap && cap.parentNode && wrapped()) {
      cap.textContent = STRINGS.aDayShort;
      if (wrapped()) box.removeChild(cap);
    }
  }

  function footer(parent, r) {
    if (!judged(r)) return null;
    var f = el('div', 'sp-foot', parent);
    var k = keptForms(r);
    var right = k ? el('span', 'sp-foot-kept ' + k.tone, f, k.text) : null;
    var left = el('span', 'sp-foot-under', f);
    var o = { n: r.under.under, m: r.under.judged };
    left.textContent = fill(STRINGS.footUnder, o);
    var cs = window.getComputedStyle(f);
    var line = parseFloat(cs.lineHeight) || 20;
    function twoLines() { return f.clientHeight - (parseFloat(cs.paddingTop) || 0) > line * 1.5; }
    if (twoLines()) left.textContent = fill(STRINGS.footUnderShort, o);
    if (right && twoLines()) drop(right);
    return f;
  }

  function soloTile(root, r) {
    root.className += ' sp-solo';
    var n = el('div', 'sp-solo-num', root, cash(r.avg7));
    fitWidth(n);
  }

  function stripTile(root, r, size) {
    root.className += ' sp-strip';
    var line = el('div', 'sp-strip-line', root);
    el('span', 'sp-strip-num', line, cash(r.avg7));
    var cap = el('span', 'sp-strip-cap', line, ' ' + STRINGS.aDayShort);
    var v = el('span', 'sp-strip-dir ' + dirTone(r), line);
    var forms = dirForms(r);
    for (var i = 0; i < forms.length && size.cols >= 3; i++) {
      v.textContent = STRINGS.sep + forms[i];
      if (!overW(line)) return;
    }
    v.textContent = '';
    if (overW(line)) drop(cap);
  }

  // A number with its label on a hairline and a line under it (wide tile, page).
  function kpi(parent, label, value, small, sub, subTone, cls) {
    var k = el('div', 'sp-kpi' + (cls ? ' ' + cls : ''), parent);
    el('div', 'sp-kpi-label', k, label);
    var v = el('div', 'sp-kpi-val', k);
    k.numEl = el('span', 'sp-kpi-num', v, value);
    if (small) k.smallEl = el('span', 'sp-kpi-small', v, small);
    k.valEl = v;
    if (sub) k.subEl = el('div', 'sp-kpi-sub' + (subTone ? ' ' + subTone : ''), k, sub);
    return k;
  }

  function kpiList(r, four) {
    var out = [];
    var df = dirForms(r);
    out.push({ key: 'avg7', label: STRINGS.kpi.avg7, value: r.avg7, money: true, sub: df[0] || '', subShort: df[1] || '', tone: dirTone(r) });
    if (judged(r)) {
      out.push({ key: 'under', label: STRINGS.kpi.under, value: r.under.under, small: ofDays(r.under.judged), sub: streakText(r), tone: r.streak > 0 ? 'is-ok' : '' });
      out.push({ key: 'kept', label: STRINGS.kpi.kept, value: r.kept, money: true, sub: fill(STRINGS.lastDays, { m: 14 }), numTone: r.kept < 0 ? 'is-neg' : '' });
      if (four) out.push({ key: 'typical', label: STRINGS.kpi.typical, value: r.typical, money: true, sub: r.avg30 === null ? '' : fill(STRINGS.avg30Line, { n: cash(r.avg30) }) });
    } else {
      out.push({ key: 'typical', label: STRINGS.kpi.typical, value: r.typical, money: true, sub: '' });
      out.push({ key: 'avg30', label: STRINGS.kpi.avg30, value: r.avg30, money: true, sub: '' });
    }
    return out;
  }

  function kpiRow(parent, r, four, cls) {
    var row = el('div', 'sp-kpis' + (cls ? ' ' + cls : ''), parent);
    var list = kpiList(r, four);
    var nodes = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var text = it.value === null ? '' : it.money ? cash(it.value) : String(it.value);
      var k = kpi(row, it.label, text, it.small, it.sub, it.tone, 'is-n' + list.length);
      if (it.numTone) k.numEl.className += ' ' + it.numTone;
      k.item = it;
      nodes.push(k);
    }
    for (i = 0; i < nodes.length; i++) {
      var kk = nodes[i];
      fitWidth(kk.valEl);
      if (kk.subEl && kk.item.subShort && overW(kk.subEl)) kk.subEl.textContent = kk.item.subShort;
    }
    row.items = nodes;
    return row;
  }

  function wideTile(root, r, size) {
    root.className += ' sp-wide';
    var row = kpiRow(root, r, false, 'is-tile');
    var box = el('div', 'sp-chart is-tile', root);
    var leg = legend(root, r, 'is-tile');
    if (overH(root) || overW(leg)) { drop(leg); leg = null; }
    // Short on room (2 rows): the lines under the numbers give way to the chart.
    var rem = remPx();
    if (box.clientHeight < rem * 3) {
      for (var i = 0; i < row.items.length; i++) drop(row.items[i].subEl);
      row.className += ' is-tight';
    }
    var rows = r.chart;
    var tall = box.clientHeight >= remPx() * 5.5;
    var refs = drawChart(box, rows, { avg: true, gutter: true, axis: tall, change: tall ? r.change : -1 });
    if (!refs) { drop(box); drop(leg); }
  }

  function stdTile(root, r, size) {
    var h = hero(root, r, STRINGS.aDay);
    fitHero(h);
    var verdict = el('div', 'sp-verdict ' + dirTone(r), root);
    if (!fitForms(verdict, dirForms(r))) drop(verdict);
    var box = el('div', 'sp-chart is-small', root);
    var foot = footer(root, r);
    // Room goes first to the figures, then the footer, then the chart.
    if (overH(root)) drop(box);
    if (overH(root) && foot) { drop(foot); foot = null; }
    if (overH(root) && verdict.parentNode) drop(verdict);
    if (!box.parentNode) return;
    var rows = r.chart.slice(-14);
    var refs = box.clientHeight >= remPx() * 2.4 ? drawChart(box, rows, { key: true }) : null;
    if (!refs) drop(box);
  }

  function drawTile(body, ctx) {
    var size = sizeOf(ctx);
    var root = el('div', 'sp-tile', body);
    ctx.setTileSub(asOf());
    var r = result();
    if (!r) return tileMessage(root, size, emptyKey());
    if (!r.ok) return tileMessage(root, size, 'building', r);
    if (stale()) root.className += ' is-stale';
    if (size.cols === 1) return soloTile(root, r);
    if (size.tier === 'strip') return stripTile(root, r, size);
    if (size.cols >= 6) return wideTile(root, r, size);
    return stdTile(root, r, size);
  }

  /* ---------- the Trend page ---------- */

  var S = { ctx: null, bound: false, refs: null, focusDate: null, animated: false, raf: 0, animTimer: null };

  function panelMessage(root, key, r) {
    var msg = stateText(key, r);
    var box = el('div', 'sp-pmsg', root);
    el('div', 'sp-pmsg-head', box, msg.head);
    if (msg.line) el('div', 'sp-pmsg-line', box, msg.line);
    mark(root, 'is-panel');
  }

  // Motion only when the screen keeps up and nobody asked for less.
  function canMove() {
    try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch (e) { /* move */ }
    try {
      var fx = window.HUB_FX;
      if (fx && typeof fx.state === 'function' && fx.state().speed !== 'ok') return false;
    } catch (e) { return false; }
    return !!window.requestAnimationFrame;
  }

  function guestOn() { try { return !!(window.HUB_GUEST && window.HUB_GUEST.on()); } catch (e) { return false; } }

  function readout(node, row) {
    while (node.firstChild) node.removeChild(node.firstChild);
    if (!row) return;
    el('b', 'sp-read-date', node, dayDateText(row.date));
    if (row.spent === null) {
      el('span', 'sp-read-note', node, STRINGS.readNoData);
      return;
    }
    node.appendChild(document.createTextNode(STRINGS.sep + cash(row.spent)));
    var text = '';
    var tone = '';
    if (row.goal === null) text = STRINGS.readNoGoal;
    else if (row.over > 0) { text = fill(STRINGS.readOver, { n: cash(row.over), g: cash(row.goal) }); tone = ' is-neg'; }
    else if (Math.round(row.goal) === Math.round(row.spent)) { text = fill(STRINGS.readEven, { g: cash(row.goal) }); tone = ' is-ok'; }
    else { text = fill(STRINGS.readUnder, { n: cash(row.goal - row.spent), g: cash(row.goal) }); tone = ' is-ok'; }
    el('span', 'sp-read-note' + tone, node, text);
  }

  function setFocus(i, glide) {
    var refs = S.refs;
    if (!refs || !refs.chart) return;
    var c = refs.chart;
    i = Math.max(0, Math.min(c.n - 1, i));
    if (refs.at === i) return;
    if (refs.at !== null && c.bars[refs.at]) c.bars[refs.at].setAttribute('class', String(c.bars[refs.at].getAttribute('class')).replace(/ is-focus\b/g, ''));
    refs.at = i;
    S.focusDate = c.rows[i].date;
    if (c.bars[i]) c.bars[i].setAttribute('class', c.bars[i].getAttribute('class') + ' is-focus');
    var x = c.cx(i) - 1;
    if (c.cross) {
      if (glide && refs.glide) c.cross.className = 'sp-cross is-glide';
      else c.cross.className = 'sp-cross';
      c.cross.style.webkitTransform = 'translateX(' + px(x) + 'px)';
      c.cross.style.transform = 'translateX(' + px(x) + 'px)';
    }
    readout(refs.read, c.rows[i]);
  }

  // The nearest day with a figure from i in direction d (or i itself).
  function stepDay(i, d) {
    var c = S.refs && S.refs.chart;
    if (!c) return i;
    for (var j = i + d; j >= 0 && j < c.n; j += d) if (c.rows[j].spent !== null) return j;
    return i;
  }

  function historyLine(parent, r) {
    var f = el('div', 'sp-hist', parent);
    if (!r.hasGoal || !r.history.length) {
      el('span', 'sp-hist-none', f, STRINGS.noGoal);
      return f;
    }
    el('span', 'sp-hist-label', f, STRINGS.history);
    for (var i = 0; i < r.history.length && i < 3; i++) {
      var h = r.history[i];
      var it = el('span', 'sp-hist-item' + (i > 0 ? ' is-old' : ''), f);
      el('b', 'sp-hist-goal', it, cash(h.goal));
      el('span', 'sp-hist-from', it, fill(STRINGS.from, { d: dateText(h.from) }));
    }
    return f;
  }

  // The four numbers count up from 0 (whole dollars, or whole days).
  function countUp(row) {
    if (!row || !row.items) return;
    var items = [];
    for (var i = 0; i < row.items.length; i++) {
      var k = row.items[i];
      if (k.item.value === null || !k.numEl.firstChild) continue;
      var to = k.item.money ? Math.round(k.item.value) : k.item.value;
      var finalText = k.numEl.textContent;
      k.numEl.setAttribute('aria-label', finalText);
      items.push({ node: k.numEl.firstChild, to: to, money: k.item.money, text: finalText });
    }
    if (!items.length) return;
    var t0 = 0;
    var lastTs = 0;
    var DUR = 1100;
    var DELAY = 150;
    function finish() {
      S.raf = 0;
      for (var j = 0; j < items.length; j++) items[j].node.nodeValue = items[j].text;
    }
    function frame(ts) {
      try {
        if (!t0) { t0 = ts + DELAY; lastTs = ts; }
        // A dropped frame (the TV is busy): jump to the end.
        if (ts - lastTs > 120) return finish();
        lastTs = ts;
        var p = Math.max(0, Math.min(1, (ts - t0) / DUR));
        if (p >= 1) return finish();
        var e = 1 - Math.pow(1 - p, 3);
        for (var j = 0; j < items.length; j++) {
          var v = Math.round(items[j].to * e);
          items[j].node.nodeValue = items[j].money ? cash(v) : String(v);
        }
        S.raf = window.requestAnimationFrame(frame);
      } catch (err) { finish(); }
    }
    for (var j = 0; j < items.length; j++) items[j].node.nodeValue = items[j].money ? cash(0) : '0';
    S.raf = window.requestAnimationFrame(frame);
  }

  function stopMotion() {
    if (S.raf && window.cancelAnimationFrame) { try { window.cancelAnimationFrame(S.raf); } catch (e) { /* gone */ } }
    S.raf = 0;
    if (S.animTimer) clearTimeout(S.animTimer);
    S.animTimer = null;
  }

  function drawPanel(body, ctx) {
    stopMotion();
    var full = ctx.mode && ctx.mode() === 'full';
    ctx.setSub(asOf());
    var root = el('div', 'sp-panel' + (full ? ' is-full' : ''), body);
    S.refs = null;
    var r = result();
    if (!r) return panelMessage(root, emptyKey());
    if (!r.ok) return panelMessage(root, 'building', r);
    var anim = !S.animated && canMove();
    S.animated = true;
    var page = el('div', 'sp-page' + (full ? ' is-full' : '') + (stale() ? ' is-stale' : '') + (anim ? ' sp-anim' : ''), root);
    var kp = kpiRow(page, r, true, 'is-page');
    var sec = el('div', 'sp-sec', page);
    var secL = el('div', 'sp-sec-left', sec);
    el('span', 'sp-sec-head', secL, fill(STRINGS.section, { m: r.chart.length }));
    el('span', 'sp-sec-note', secL, STRINGS.sectionNote);
    var read = el('div', 'sp-read', secL);
    legend(sec, r, 'is-page');
    var box = el('div', 'sp-chart is-page f', page);
    box.setAttribute('data-key', 'chart');
    box.setAttribute('data-autofocus', '');
    var foot = el('div', 'sp-pfoot', page);
    el('span', 'sp-hint', foot, ctx.tablet ? STRINGS.hintTouch : STRINGS.hint);
    historyLine(foot, r);
    var chart = drawChart(box, r.chart, { avg: true, gutter: true, axis: true, marker: true, change: r.change, anim: anim });
    S.refs = { read: read, chart: chart, at: null, glide: false, box: box };
    if (chart) {
      var at = chart.n - 1;
      for (var i = 0; i < chart.n; i++) if (chart.rows[i].date === S.focusDate) at = i;
      if (chart.rows[at].spent === null) at = stepDay(at, -1);
      setFocus(at, false);
      tapDays(box);
    }
    if (anim) {
      if (!guestOn()) countUp(kp);
      // The motion is over by then: the class comes off, so nothing replays.
      S.animTimer = setTimeout(function () {
        S.animTimer = null;
        page.className = page.className.replace(/ sp-anim\b/g, '');
        if (S.refs) S.refs.glide = canMove();
      }, 1700);
    } else {
      S.refs.glide = canMove();
    }
  }

  // A tap or click on the chart focuses the day under it.
  function tapDays(box) {
    box.addEventListener('click', function (e) {
      var refs = S.refs;
      if (!refs || !refs.chart || refs.box !== box) return;
      var rect = box.getBoundingClientRect();
      var k = box.offsetWidth ? rect.width / box.offsetWidth : 1;
      var x = (e.clientX - rect.left) / (k || 1);
      var c = refs.chart;
      var i = Math.floor((x - c.X0) / c.slot);
      if (i < 0 || i >= c.n) return;
      if (c.rows[i].spent === null) return;
      setFocus(i, true);
    });
  }

  function onMove(dir, from) {
    var refs = S.refs;
    if (!refs || !refs.chart || from !== refs.box) return undefined;
    if (dir !== 'left' && dir !== 'right') return undefined;
    setFocus(stepDay(refs.at, dir === 'left' ? -1 : 1), true);
    return true;
  }

  /* ---------- wiring ---------- */

  function redraw() {
    var ctx = S.ctx;
    if (!ctx) return;
    try {
      ctx.redrawTile();
      if (ctx.isOpen()) ctx.redrawPanel();
    } catch (e) { warn('redraw: ' + (e && e.message)); }
  }

  function onLang() {
    localizeStrings();
    var ctx = S.ctx;
    if (ctx && typeof ctx.retitle === 'function') ctx.retitle();
    if (ctx && ctx.isOpen()) {
      var pt = document.querySelector('#panel .panel-title');
      if (pt) pt.textContent = STRINGS.title;
    }
    redraw();
  }

  function bind(ctx) {
    S.ctx = ctx;
    if (S.bound) return;
    S.bound = true;
    try { if (B()) B().onChange(redraw); } catch (e) { warn('budget: ' + (e && e.message)); }
  }

  try {
    var lx = I18N();
    if (lx && typeof lx.onChange === 'function') lx.onChange(function () { try { onLang(); } catch (e) { warn('language: ' + (e && e.message)); } });
  } catch (e) { /* stays in the language it started in */ }

  function broken(body) {
    try {
      body.innerHTML = '';
      el('div', 'sp-msg-line', body, STRINGS.title);
    } catch (e) { /* nothing more to do */ }
  }

  var widget = {
    id: 'spending',
    icon: 'wallet',
    expandable: true,
    // OK on the tile opens the Trend page at full screen; Back closes it.
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
      try { drawPanel(body, ctx); } catch (e) {
        warn('panel: ' + (e && e.message));
        broken(body);
      }
    },
    onMove: function (dir, from) { try { return onMove(dir, from); } catch (e) { warn('move: ' + (e && e.message)); return undefined; } },
    onMode: function (mode, ctx) { ctx.redrawPanel(); },
    onClose: function () { stopMotion(); S.refs = null; S.animated = false; S.focusDate = null; }
  };
  Object.defineProperty(widget, 'title', { get: function () { return STRINGS.title; }, enumerable: true, configurable: true });
  Object.defineProperty(widget, 'shortTitle', { get: function () { return STRINGS.titleShort; }, enumerable: true, configurable: true });

  // For dev/spending-test.js. Not used by the hub.
  window.HUB_SPENDING_TEST = {
    STRINGS: EN,
    strings: function () { return STRINGS; },
    result: result,
    goalHistory: goalHistory,
    focus: function () { return S.refs && S.refs.chart ? { at: S.refs.at, date: S.focusDate, n: S.refs.chart.n } : null; }
  };

  (window.HUB_WIDGETS = window.HUB_WIDGETS || []).push(widget);
})();
