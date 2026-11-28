/*
 * The lit plant wall, drawn for Moods (app/widgets/moods.js on the TV and the
 * wall tablet, app/widgets/moods-touch.js on a phone). One SVG, built from the
 * wall map the Pi sends in the live resource "moods" (wall.geometry, inches,
 * y measured up from the floor; wall.zones, inclusive LED ranges), so a fix to
 * the wall map on the Pi moves the drawing too. Nothing here is hard-coded to
 * the wall but the look.
 *
 *   var view = HUB_MOODS_WALL.build(host, wall)   draws the dark wall into host
 *   HUB_MOODS_WALL.paint(view, pv, opts)          lights it with a mood's preview
 *        pv:   { z: { zone: ['#hex', ...] }, pat: { zone: 'solid|gradient|stripe|dots' },
 *                glint: '#hex' | null, anim: 'still|twinkle|breathe|drift', lvl: n | { zone: n } }
 *              or null for the wall off (every bulb dark)
 *        opts: { level: 0..1 (the mood's brightness), night: 1..8 (Menorah candles) }
 *   HUB_MOODS_WALL.bulbs(wall)                    [{ led, zone, x, y, kind }] (tests)
 *
 * Bulbs are placed by walking each zone's path at even steps (the way the
 * artifact's tail() does). Halo bulbs sit behind the paintings, so they are
 * soft glows drawn UNDER the dark canvas panes: light spills out from behind
 * the frames. Vases are a glass outline with seven beads and a glow; the
 * wire-run and drop bulbs are small lights in the open. Colours are set as
 * attributes, never animated. Motion is opacity only, by class (moods.css):
 * one overlay of glint dots in three phase groups (twinkle), one whole-layer
 * fade (breathe, drift); the CSS turns it off under the motion fallback rungs
 * and for reduced motion. The wall stays a night scene in the day theme.
 *
 * Plain ES5, no DOM until build() is called.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var seq = 0;

  var HALO_R = 3.3;     // inches: a bulb's glow behind a painting
  var FREE_R = 1.5;     // a wire-run or drop bulb's glow
  var BEAD_R = 0.95;    // a vase bead's glow
  var DARK = '#2b2f36'; // an unlit bulb

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function mk(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(n);
    return n;
  }

  /* ---------- colour ---------- */

  function rgb(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  function hex(c) {
    var s = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.max(0, Math.min(255, Math.round(c[i])));
      s += (v < 16 ? '0' : '') + v.toString(16);
    }
    return s;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  // A glow colour, rounded so a gradient's many in-between shades share a few defs.
  function bucket(c) { return [Math.round(c[0] / 12) * 12, Math.round(c[1] / 12) * 12, Math.round(c[2] / 12) * 12]; }

  // The colour of bulb i of n in a zone, by its pattern.
  function colourAt(cols, pat, i, n) {
    if (!cols.length) return null;
    if (cols.length === 1 || pat === 'solid') return cols[0];
    if (pat === 'dots') return cols[i % cols.length];
    if (pat === 'stripe') return cols[Math.floor(i / 3) % cols.length];
    var f = n > 1 ? i / (n - 1) : 0;
    var pos = f * (cols.length - 1);
    var k = Math.min(cols.length - 2, Math.floor(pos));
    return mix(cols[k], cols[k + 1], pos - k);
  }

  /* ---------- where the bulbs are ---------- */

  // The LEDs of a zone, one list per range ([[0, 8], [27, 28]] -> two lists).
  function rangesOf(zone) {
    var out = [];
    var total = 0;
    var r = zone && isArr(zone.r) ? zone.r : [];
    for (var i = 0; i < r.length; i++) {
      var one = [];
      if (isArr(r[i]) && r[i].length >= 2) {
        for (var n = Math.round(r[i][0]); n <= Math.round(r[i][1]) && total < 400; n++) { one.push(n); total += 1; }
      }
      out.push(one);
    }
    return out;
  }

  // A path: [[x, y], ...] or a list of them (one per range).
  function polylines(p) {
    if (!isArr(p) || !p.length) return [];
    if (isArr(p[0]) && isArr(p[0][0])) return p;
    return [p];
  }

  // The bulb positions of a zone that is not a vase. The Pi's wall map
  // (pi/moods/wall.json) gives range k of a zone its own path "zone#k" (or
  // "zone" for a one-range zone), the way pi/moods/catalog.js pathFor() reads
  // it; an older map gave "zone" a list of lines, one per range. Each range
  // is walked along its own line; with no line per range, the whole zone is
  // walked along "zone".
  function zonePoints(paths, name, ranges, count) {
    var whole = polylines(paths[name]);
    var per = [];
    var k;
    for (k = 0; k < ranges.length; k++) {
      var p = paths[name + '#' + k];
      if (!p && ranges.length > 1 && whole.length === ranges.length) p = whole[k];
      if (!p && ranges.length === 1) p = paths[name];
      if (!p) { per = null; break; }
      per.push(polylines(p));
    }
    if (!per) return walk(whole, count);
    var out = [];
    for (k = 0; k < ranges.length; k++) out = out.concat(walk(per[k], ranges[k].length));
    return out;
  }

  function lengthOf(line) {
    var L = 0;
    for (var i = 1; i < line.length; i++) L += Math.sqrt(Math.pow(line[i][0] - line[i - 1][0], 2) + Math.pow(line[i][1] - line[i - 1][1], 2));
    return L;
  }

  // The point d along a polyline.
  function at(line, d) {
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var seg = Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
      if (d <= seg || i === line.length - 1) {
        var t = seg ? Math.max(0, Math.min(1, d / seg)) : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      d -= seg;
    }
    return line.length ? [line[0][0], line[0][1]] : [0, 0];
  }

  // n points at even steps along the lines (each bulb in the middle of its step).
  function walk(lines, n) {
    var out = [];
    var i;
    if (!n || !lines.length) return out;
    var total = 0;
    for (i = 0; i < lines.length; i++) total += lengthOf(lines[i]);
    if (!total) {
      for (i = 0; i < n; i++) out.push([lines[0][0][0], lines[0][0][1]]);
      return out;
    }
    var step = total / n;
    for (i = 0; i < n; i++) {
      var d = (i + 0.5) * step;
      for (var k = 0; k < lines.length; k++) {
        var L = lengthOf(lines[k]);
        if (d <= L || k === lines.length - 1) { out.push(at(lines[k], Math.min(d, L))); break; }
        d -= L;
      }
    }
    return out;
  }

  // Seven beads on the lower arc inside a vase (centre cx, cy; y up).
  function beads(cx, cy, n) {
    var out = [];
    for (var k = 0; k < n; k++) {
      var a = Math.PI * (0.14 + 0.72 * (n > 1 ? k / (n - 1) : 0.5));
      out.push([cx - Math.cos(a) * 1.55, cy - 0.35 - Math.sin(a) * 0.95]);
    }
    return out;
  }

  // Every bulb the wall map places: [{ led, zone, x, y, kind }], LED order.
  function bulbs(wall) {
    var out = [];
    var zones = wall && wall.zones && typeof wall.zones === 'object' ? wall.zones : {};
    var g = wall && wall.geometry && typeof wall.geometry === 'object' ? wall.geometry : {};
    var paths = g.paths && typeof g.paths === 'object' ? g.paths : {};
    var vases = isArr(g.vases) ? g.vases : [];
    var vaseAt = {};
    for (var v = 0; v < vases.length; v++) if (vases[v] && typeof vases[v].zone === 'string') vaseAt[vases[v].zone] = vases[v];
    var leds = typeof wall.leds === 'number' ? wall.leds : 999;
    for (var name in zones) {
      if (!zones.hasOwnProperty(name)) continue;
      var ranges = rangesOf(zones[name]);
      var list = [].concat.apply([], ranges);
      var pts = [];
      var kind = /^halo\./.test(name) ? 'halo' : vaseAt[name] ? 'vase' : 'free';
      if (vaseAt[name]) pts = beads(num(vaseAt[name].x, 0), num(vaseAt[name].y, 0), list.length);
      else pts = zonePoints(paths, name, ranges, list.length);
      for (var i = 0; i < list.length && i < pts.length; i++) {
        if (list[i] < 0 || list[i] >= leds) continue;
        out.push({ led: list[i], zone: name, x: pts[i][0], y: pts[i][1], kind: kind, i: i, n: list.length });
      }
    }
    out.sort(function (a, b) { return a.led - b.led; });
    return out;
  }

  /* ---------- the drawing ---------- */

  function bounds(g, list) {
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    function take(x, y) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    var cv = isArr(g.canvases) ? g.canvases : [];
    for (var i = 0; i < cv.length; i++) {
      take(num(cv[i].x, 0), num(cv[i].y, 0));
      take(num(cv[i].x, 0) + num(cv[i].w, 0), num(cv[i].y, 0) + num(cv[i].h, 0));
    }
    var vs = isArr(g.vases) ? g.vases : [];
    for (i = 0; i < vs.length; i++) { take(num(vs[i].x, 0) - 3, num(vs[i].y, 0) - 3); take(num(vs[i].x, 0) + 3, num(vs[i].y, 0) + 3.5); }
    for (i = 0; i < list.length; i++) take(list[i].x, list[i].y);
    if (!isFinite(x0)) { x0 = 0; x1 = 88; y0 = 52; y1 = 80; }
    // Room for the glows to spill round the frames.
    return { x0: x0 - 4.2, x1: x1 + 4.2, y0: y0 - 3.4, y1: y1 + 3.2 };
  }

  function build(host, wall) {
    var id = 'mw' + (++seq);
    var g = wall && wall.geometry && typeof wall.geometry === 'object' ? wall.geometry : {};
    var list = bulbs(wall || {});
    var B = bounds(g, list);
    var W = B.x1 - B.x0, H = B.y1 - B.y0;
    function X(x) { return Math.round((x - B.x0) * 100) / 100; }
    function Y(y) { return Math.round((B.y1 - y) * 100) / 100; }

    var svg = mk('svg', { viewBox: '0 0 ' + Math.round(W * 100) / 100 + ' ' + Math.round(H * 100) / 100, preserveAspectRatio: 'xMidYMid meet',
      'class': 'mw-svg', 'aria-hidden': 'true', focusable: 'false' });
    var defs = mk('defs', {}, svg);
    var bgGrad = mk('linearGradient', { id: id + '-bg', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    mk('stop', { offset: 0, 'stop-color': '#121419' }, bgGrad);
    mk('stop', { offset: 1, 'stop-color': '#0a0b0e' }, bgGrad);
    var paneGrad = mk('linearGradient', { id: id + '-pane', x1: 0, y1: 0, x2: 0.35, y2: 1 }, defs);
    mk('stop', { offset: 0, 'stop-color': '#1e2026' }, paneGrad);
    mk('stop', { offset: 1, 'stop-color': '#121317' }, paneGrad);

    mk('rect', { x: 0, y: 0, width: W, height: H, rx: 2.2, fill: 'url(#' + id + '-bg)', 'class': 'mw-bg' }, svg);
    // Layers, back to front. Everything that glows sits in mw-lit, the one
    // layer the breathe and drift fades move.
    var lit = mk('g', { 'class': 'mw-lit' }, svg);
    var haloG = mk('g', { 'class': 'mw-halos' }, lit);
    var paneG = mk('g', { 'class': 'mw-panes' }, svg);
    var lit2 = mk('g', { 'class': 'mw-lit' }, svg);
    var vaseGlowG = mk('g', { 'class': 'mw-vglow' }, lit2);
    var freeGlowG = mk('g', { 'class': 'mw-fglow' }, lit2);
    var plantG = mk('g', { 'class': 'mw-plants' }, svg);
    var freeG = mk('g', { 'class': 'mw-free' }, svg);
    var vaseG = mk('g', { 'class': 'mw-vases' }, svg);
    var glintG = mk('g', { 'class': 'mw-glints' }, svg);
    var glints = [mk('g', { 'class': 'mw-ph mw-ph1' }, glintG), mk('g', { 'class': 'mw-ph mw-ph2' }, glintG), mk('g', { 'class': 'mw-ph mw-ph3' }, glintG)];

    var view = { id: id, svg: svg, defs: defs, bulbs: [], byLed: {}, vases: [], grads: {}, glints: glints, glintDots: [], wall: wall || {} };

    // A wire bulb behind a painting (the run from the controller) is hidden by it too.
    var cvs = isArr(g.canvases) ? g.canvases : [];
    function behind(x, y) {
      for (var k = 0; k < cvs.length; k++) {
        var c0 = cvs[k];
        if (x > num(c0.x, 0) && x < num(c0.x, 0) + num(c0.w, 0) && y > num(c0.y, 0) && y < num(c0.y, 0) + num(c0.h, 0)) return true;
      }
      return false;
    }

    // Halo bulbs: a glow and a core, under the panes.
    var i, b;
    for (i = 0; i < list.length; i++) {
      b = list[i];
      var rec = { led: b.led, zone: b.zone, kind: b.kind, i: b.i, n: b.n, x: X(b.x), y: Y(b.y), glow: null, core: null };
      if (b.kind === 'free' && behind(b.x, b.y)) {
        rec.glow = mk('circle', { cx: rec.x, cy: rec.y, r: FREE_R, 'class': 'mw-glow', opacity: 0 }, haloG);
        rec.core = mk('circle', { cx: rec.x, cy: rec.y, r: 0.3, 'class': 'mw-core mw-wire', fill: DARK, 'data-led': b.led }, haloG);
      } else if (b.kind === 'halo') {
        rec.glow = mk('circle', { cx: rec.x, cy: rec.y, r: HALO_R, 'class': 'mw-glow', opacity: 0 }, haloG);
        rec.core = mk('circle', { cx: rec.x, cy: rec.y, r: 0.32, 'class': 'mw-core', fill: DARK, 'data-led': b.led }, haloG);
      } else if (b.kind === 'free') {
        rec.glow = mk('circle', { cx: rec.x, cy: rec.y, r: FREE_R, 'class': 'mw-glow', opacity: 0 }, freeGlowG);
        rec.core = mk('circle', { cx: rec.x, cy: rec.y, r: 0.3, 'class': 'mw-core mw-wire', fill: DARK, 'data-led': b.led }, freeG);
      }
      view.bulbs.push(rec);
      view.byLed[b.led] = rec;
    }

    // The paintings: plain dark rounded panes with a lighter top edge.
    var cv = isArr(g.canvases) ? g.canvases : [];
    for (i = 0; i < cv.length; i++) {
      var c = cv[i];
      var cx = X(num(c.x, 0)), cy = Y(num(c.y, 0) + num(c.h, 0));
      mk('rect', { x: cx, y: cy, width: num(c.w, 0), height: num(c.h, 0), rx: 0.55, fill: 'url(#' + id + '-pane)', 'class': 'mw-pane' }, paneG);
      mk('rect', { x: cx + 0.06, y: cy + 0.06, width: Math.max(0, num(c.w, 0) - 0.12), height: Math.max(0, num(c.h, 0) - 0.12), rx: 0.5, 'class': 'mw-pane-rim' }, paneG);
    }

    // The vases: a soft glow, a trailing plant, the glass, the beads.
    var vs = isArr(g.vases) ? g.vases : [];
    for (i = 0; i < vs.length; i++) {
      var v = vs[i];
      var vx = X(num(v.x, 0)), vy = Y(num(v.y, 0));
      var left = num(v.x, 0) < W / 2 + B.x0;
      var dir = left ? -1 : 1;
      var vrec = { zone: v.zone, glow: mk('circle', { cx: vx, cy: vy + 0.3, r: 6.5, 'class': 'mw-glow mw-vase-glow', opacity: 0 }, vaseGlowG), water: null, beads: [] };
      var leaves = [[dir * 2.1, -2.9, -32], [dir * 2.9, -0.7, 38], [dir * 2.5, 1.9, -34], [dir * 1.9, 4.1, 28], [-dir * 1.8, -3.2, 30], [-dir * 2.7, -1.2, -40]];
      mk('path', { d: 'M' + vx + ' ' + (vy - 2.4) + ' C ' + (vx + dir * 3) + ' ' + (vy - 3.8) + ', ' + (vx + dir * 2.8) + ' ' + (vy + 1.8) + ', ' + (vx + dir * 1.6) + ' ' + (vy + 4.6), 'class': 'mw-stem' }, plantG);
      for (var L = 0; L < leaves.length; L++) {
        mk('ellipse', { cx: vx + leaves[L][0], cy: vy + leaves[L][1], rx: 1.05, ry: 0.5, transform: 'rotate(' + leaves[L][2] + ' ' + (vx + leaves[L][0]) + ' ' + (vy + leaves[L][1]) + ')', 'class': 'mw-leaf' + (L % 3 === 0 ? ' is-hi' : '') }, plantG);
      }
      var vg = mk('g', { 'class': 'mw-vase', 'data-zone': v.zone }, vaseG);
      vrec.water = mk('path', { d: 'M' + (vx - 2.1) + ' ' + (vy + 0.2) + ' A 2.15 1.9 0 0 0 ' + (vx + 2.1) + ' ' + (vy + 0.2) + ' Z', 'class': 'mw-water', opacity: 0 }, vg);
      mk('ellipse', { cx: vx, cy: vy, rx: 2.45, ry: 2.25, 'class': 'mw-glass' }, vg);
      mk('rect', { x: vx - 0.95, y: vy - 2.75, width: 1.9, height: 0.65, rx: 0.25, 'class': 'mw-neck' }, vg);
      mk('path', { d: 'M' + (vx - 1.35) + ' ' + (vy - 1.15) + ' Q ' + (vx - 1.75) + ' ' + (vy - 0.2) + ' ' + (vx - 1.35) + ' ' + (vy + 0.75), 'class': 'mw-shine' }, vg);
      view.vases.push(vrec);
    }
    // Beads after the glass outlines, so they sit inside them.
    for (i = 0; i < view.bulbs.length; i++) {
      b = view.bulbs[i];
      if (b.kind !== 'vase') continue;
      b.glow = mk('circle', { cx: b.x, cy: b.y, r: BEAD_R, 'class': 'mw-glow', opacity: 0 }, freeGlowG);
      b.core = mk('circle', { cx: b.x, cy: b.y, r: 0.2, 'class': 'mw-core mw-bead', fill: DARK, 'data-led': b.led }, vaseG);
    }

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(svg);
    return view;
  }

  // One shared radial gradient per (rounded) colour, made on first use.
  function gradFor(view, c) {
    var key = hex(bucket(c)).slice(1);
    if (view.grads[key]) return view.grads[key];
    var gid = view.id + '-g' + key;
    var gr = mk('radialGradient', { id: gid }, view.defs);
    mk('stop', { offset: 0, 'stop-color': '#' + key, 'stop-opacity': 0.95 }, gr);
    mk('stop', { offset: 0.38, 'stop-color': '#' + key, 'stop-opacity': 0.42 }, gr);
    mk('stop', { offset: 1, 'stop-color': '#' + key, 'stop-opacity': 0 }, gr);
    view.grads[key] = 'url(#' + gid + ')';
    return view.grads[key];
  }

  function zoneColours(pv, zone) {
    var src = pv && pv.z && isArr(pv.z[zone]) ? pv.z[zone] : [];
    var out = [];
    for (var i = 0; i < src.length && out.length < 16; i++) { var c = rgb(src[i]); if (c) out.push(c); }
    return out;
  }

  function zoneLevel(pv, zone) {
    var l = pv ? pv.lvl : null;
    if (l && typeof l === 'object') l = l[zone];
    return Math.max(0, Math.min(1, num(l, 0.8)));
  }

  function clearGlints(view) {
    for (var i = 0; i < view.glintDots.length; i++) {
      var d = view.glintDots[i];
      if (d.parentNode) d.parentNode.removeChild(d);
    }
    view.glintDots = [];
  }

  function paint(view, pv, opts) {
    if (!view || !view.svg) return;
    opts = opts || {};
    var master = Math.max(0.15, Math.min(1, num(opts.level, 1)));
    var anim = pv && typeof pv.anim === 'string' ? pv.anim : 'still';
    var i, b;
    // Lit core: the colour lifted toward white; the glow follows the level.
    function light(b, c, lvl) {
      var k = lvl * master;
      if (!c || k <= 0.01) { off(b); return; }
      if (b.core) {
        b.core.setAttribute('fill', hex(mix(mix([22, 24, 28], c, Math.min(1, 0.45 + k)), [255, 255, 255], 0.18 + 0.32 * k)));
        b.core.setAttribute('class', b.core.getAttribute('class').replace(/\s*is-on/g, '') + ' is-on');
      }
      if (b.glow) {
        b.glow.setAttribute('fill', gradFor(view, c));
        b.glow.setAttribute('opacity', Math.round(Math.min(1, 0.18 + 0.82 * k) * 100) / 100);
      }
    }
    function off(b) {
      if (b.core) { b.core.setAttribute('fill', DARK); b.core.setAttribute('class', b.core.getAttribute('class').replace(/\s*is-on/g, '')); }
      if (b.glow) b.glow.setAttribute('opacity', 0);
    }

    var colours = {}, levels = {};
    for (i = 0; i < view.bulbs.length; i++) {
      b = view.bulbs[i];
      if (!colours.hasOwnProperty(b.zone)) { colours[b.zone] = pv ? zoneColours(pv, b.zone) : []; levels[b.zone] = zoneLevel(pv, b.zone); }
      var pat = pv && pv.pat && typeof pv.pat[b.zone] === 'string' ? pv.pat[b.zone] : 'gradient';
      b.colour = colourAt(colours[b.zone], pat, b.i, b.n);
      b.level = levels[b.zone];
      light(b, b.colour, b.level);
    }

    // Menorah: the first N candles (numbered from the right) and the shamash.
    var meno = view.wall && view.wall.menorah;
    if (pv && opts.night && meno && isArr(meno.candles)) {
      var gold = rgb((pv && pv.glint) || '#ffb347') || [255, 179, 71];
      var n = Math.max(0, Math.min(meno.candles.length, Math.round(opts.night)));
      for (i = 0; i < n; i++) { b = view.byLed[meno.candles[i]]; if (b) { light(b, gold, 1); b.candle = true; } }
      var sh = isArr(meno.shamash) ? meno.shamash : [];
      for (i = 0; i < sh.length; i++) { b = view.byLed[sh[i]]; if (b) light(b, mix(gold, [255, 255, 255], 0.35), 1); }
    }

    // A vase's own glow and water: its beads' colour.
    for (i = 0; i < view.vases.length; i++) {
      var vr = view.vases[i];
      var vc = pv ? zoneColours(pv, vr.zone) : [];
      var vl = zoneLevel(pv, vr.zone) * master;
      if (vc.length && vl > 0.01) {
        vr.glow.setAttribute('fill', gradFor(view, vc[0]));
        vr.glow.setAttribute('opacity', Math.round(Math.min(0.9, 0.15 + 0.6 * vl) * 100) / 100);
        vr.water.setAttribute('fill', hex(vc[0]));
        vr.water.setAttribute('opacity', Math.round(Math.min(0.55, 0.12 + 0.4 * vl) * 100) / 100);
      } else {
        vr.glow.setAttribute('opacity', 0);
        vr.water.setAttribute('opacity', 0);
      }
    }

    // Glints: a few bright dots over the lit halos and vases, in three phases.
    clearGlints(view);
    var gl = pv && anim === 'twinkle' ? rgb(pv.glint) : null;
    if (gl) {
      var k = 0;
      for (i = 0; i < view.bulbs.length; i++) {
        b = view.bulbs[i];
        if (!b.colour || b.kind === 'free' || b.candle) continue;
        if ((b.led * 7) % 5 !== 0 && (b.kind !== 'vase' || b.i % 3 !== 1)) continue;
        var r = b.kind === 'halo' ? 1.5 : 0.75;
        var dot = mk('circle', { cx: b.x, cy: b.y, r: r, fill: gradFor(view, gl), 'class': 'mw-glint' }, view.glints[k % 3]);
        view.glintDots.push(dot);
        k += 1;
      }
    }
    view.svg.setAttribute('class', 'mw-svg mw-a-' + (pv ? anim.replace(/[^a-z]/g, '') : 'off') + (pv ? '' : ' is-off'));
    view.pv = pv;
  }

  window.HUB_MOODS_WALL = { build: build, paint: paint, bulbs: bulbs };
})();
