/*
 * Word of the day: one Spanish word a day (Latin American Spanish), with
 * its English, from app/wotd-data.js. The same word all day: it is picked
 * by the local day of the year (1 January is the first word), so the words
 * start easy (A1) in January and reach B1 by December.
 *
 * Spanish is always the big word, the language being learned; English is
 * the smaller companion. When the hub is in Spanish (app/i18n.js) the
 * title, labels and the first definition switch to Spanish.
 *
 *   1 column   only the Spanish word, as large as fits
 *   strip      "el gato · the cat" on one line
 *   standard   the word, "the cat · noun", and the Spanish example
 *   tall       adds the pronunciation hint, the definition and the
 *              example's English
 *   panel      everything: the date and level, both definitions, both examples
 *   full       the same, bigger
 *
 * Everything that can't fit is left out, lowest first (never cut sideways):
 * the tile is measured after drawing, never each second. Nothing animates.
 * A minute timer redraws it when the day changes.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var POS_EN = {
    noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', phrase: 'phrase',
    prep: 'preposition', pron: 'pronoun', conj: 'conjunction', interj: 'interjection', num: 'number'
  };
  var MIN_TILE_PX = 0.85;   // rem: no type under this on a tile...
  var MIN_ONE_COL = 0.8;    // ...except the one word in a 1-column tile

  var shownDay = '';

  /* ---------- languages ---------- */

  function I18N() {
    var L = window.HUB_I18N;
    return L && typeof L.t === 'function' ? L : null;
  }

  function T(key, en, vars) {
    var L = I18N();
    if (L) return L.t(key, en, vars);
    return String(en).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  function lang() {
    var L = I18N();
    return L && typeof L.lang === 'function' ? L.lang() : 'en';
  }

  function title() { return T('wotd.title', 'Word of the day'); }

  // Only when the title doesn't fit its tile on one line (the hub measures).
  function shortTitle() { return T('wotd.titleShort', 'Word'); }

  function posText(pos) { return T('wotd.pos.' + pos, POS_EN[pos] || pos || ''); }

  /* ---------- the day's word ---------- */

  // 0 on 1 January, 365 on 31 December of a leap year; local time. Rounded,
  // so a daylight-saving day (23 or 25 hours) doesn't shift it.
  function dayOfYear(d) {
    var start = new Date(d.getFullYear(), 0, 1);
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((day.getTime() - start.getTime()) / 86400000);
  }

  function list() {
    var L = window.HUB_WOTD_DATA;
    return L && L.length ? L : [];
  }

  function pickIndex(d, n) {
    n = n === undefined ? list().length : n;
    return n > 0 ? dayOfYear(d) % n : -1;
  }

  // A1 January to March, A2 April to August, B1 September to December.
  function level(i) { return i < 90 ? 'A1' : i < 243 ? 'A2' : 'B1'; }

  function wordFor(d) {
    var i = pickIndex(d);
    var w = i >= 0 ? list()[i] : null;
    return w ? { i: i, w: w, level: level(i) } : null;
  }

  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  /* ---------- small helpers ---------- */

  function div(cls, parent, text) {
    var el = document.createElement('div');
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function span(cls, parent, text) {
    var el = document.createElement('span');
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function rem() {
    return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  }

  function fontPx(el) { return parseFloat(window.getComputedStyle(el).fontSize) || 16; }

  // Shrinks el's text until fits() (or the smallest size). Measured once per draw.
  function shrink(el, minRem, fits) {
    var min = minRem * rem();
    var size = fontPx(el);
    for (var i = 0; i < 30 && !fits() && size > min; i++) {
      size = Math.max(min, size * 0.92);
      el.style.fontSize = size.toFixed(1) + 'px';
    }
    return fits();
  }

  function fitsWidth(el) { return el.scrollWidth <= el.clientWidth + 1; }

  // Clamp a block to whole lines (old WebKit's line clamp ends in "...").
  function clamp(el, lines) {
    el.style.display = '-webkit-box';
    el.style.webkitBoxOrient = 'vertical';
    el.style.webkitLineClamp = String(lines);
    el.style.overflow = 'hidden';
  }

  function lineHeight(el) {
    var cs = window.getComputedStyle(el);
    return parseFloat(cs.lineHeight) || fontPx(el) * 1.4;
  }

  // The tile's own title follows the language (the hub draws it once).
  function setTileTitle(body, ctx) {
    if (ctx && typeof ctx.retitle === 'function') { ctx.retitle(); return; }
    var tile = body && body.parentNode;
    var t = tile && tile.querySelector ? tile.querySelector('.tile-title') : null;
    if (t && t.textContent !== title()) t.textContent = title();
  }

  /* ---------- the tile ---------- */

  function drawOneColumn(body, w) {
    var box = div('wotd-one', body);
    var word = div('wotd-es', box, w.es);
    var avail = function () { return box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1 && word.scrollWidth <= word.clientWidth + 1; };
    if (!shrink(word, MIN_ONE_COL, avail)) word.style.wordWrap = 'break-word';
  }

  // Every part of the line inside it (inline spans can poke out by a pixel
  // that scrollWidth rounds away), and the line inside the body's height.
  function lineFits(line, body) {
    if (line.scrollWidth > line.clientWidth) return false;
    var r = line.getBoundingClientRect();
    for (var i = 0; i < line.childNodes.length; i++) {
      var c = line.childNodes[i];
      if (!c.getBoundingClientRect) continue;
      var cr = c.getBoundingClientRect();
      if (cr.right > r.right + 0.25 || cr.left < r.left - 0.25) return false;
    }
    return line.offsetHeight <= body.clientHeight + 1;
  }

  // "el gato · the cat" on one line, as large as fits down to 1.1rem; a
  // longer pair wraps between words (a word is never cut), as large as fits.
  function drawStrip(body, w) {
    var line = div('wotd-line', body);
    span('wotd-es', line, w.es);
    // A no-break space keeps the dot with the Spanish when the line wraps.
    var sep = span('wotd-sep', line, ' · ');
    var en = span('wotd-en', line, w.en);
    var fits = function () { return lineFits(line, body); };
    if (shrink(line, 1.1, fits)) return;
    line.style.fontSize = '';
    line.className += ' is-wrapped';
    if (shrink(line, MIN_TILE_PX, fits)) return;
    // Still too long at the smallest size: Spanish alone, then "...".
    line.removeChild(sep);
    line.removeChild(en);
    line.style.fontSize = '';
    if (!shrink(line, MIN_TILE_PX, fits)) line.className += ' is-cut';
  }

  // Standard and tall: blocks top to bottom, then the ones that don't fit
  // leave, lowest first. Clampable ones first give up lines.
  function drawBlocks(body, w, tall) {
    var es = lang() === 'es';
    var box = div('wotd-box', body);
    var word = div('wotd-es', box, w.es);
    var say = tall && w.say ? div('wotd-say', box, '[' + w.say + ']') : null;
    var enLine = div('wotd-enline', box);
    span('wotd-en', enLine, w.en);
    var pos = w.pos ? span('wotd-pos', enLine, ' · ' + posText(w.pos)) : null;
    var def = tall ? div('wotd-def', box, es ? (w.defEs || w.defEn) : (w.defEn || w.defEs)) : null;
    var ex = w.exEs ? div('wotd-ex', box, w.exEs) : null;
    var exEn = tall && w.exEn ? div('wotd-ex-en', box, w.exEn) : null;

    // The big word on one line: it shrinks to the width.
    shrink(word, 1.2, function () { return fitsWidth(word); });
    if (!fitsWidth(word)) word.style.whiteSpace = 'normal';

    var room = body.clientHeight;
    var over = function () { return box.offsetHeight > room + 1; };
    if (!room || !over()) return;

    function drop(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
    // Gives el as many lines as fit (at least min), or drops it.
    function squeeze(el, min) {
      if (!el || !el.parentNode || !over()) return;
      var lh = lineHeight(el);
      var free = room - (box.offsetHeight - el.offsetHeight);
      var lines = Math.floor((free + 0.5) / lh);
      if (lines >= min) clamp(el, lines);
      else drop(el);
    }

    if (over()) drop(exEn);
    if (over()) drop(say);
    squeeze(def, 2);
    squeeze(ex, 1);
    if (over() && pos) drop(pos);
    if (over()) drop(enLine);
    if (over()) shrink(word, MIN_TILE_PX, function () { return !over(); });
  }

  function renderTile(body, ctx) {
    setTileTitle(body, ctx);
    var now = new Date();
    shownDay = dayKey(now);
    var pick = wordFor(now);
    var size = ctx && ctx.size ? ctx.size() : { cols: 3, rows: 2, tier: 'standard', width: 'standard' };
    // A redraw starts from the hub's own class (hub.js empties the body only).
    body.className = 'tile-body wotd-tile';
    if (!pick) { div('wotd-none', body, T('wotd.none', 'No word for today.')); return; }
    var w = pick.w;
    body.setAttribute('data-word', String(pick.i));
    if (size.cols === 1) { body.className += ' wotd-tile-one'; drawOneColumn(body, w); return; }
    if (size.tier === 'strip') { body.className += ' wotd-tile-strip'; drawStrip(body, w); return; }
    body.className += size.tier === 'tall' ? ' wotd-tile-tall' : ' wotd-tile-standard';
    drawBlocks(body, w, size.tier === 'tall');
  }

  /* ---------- the panel ---------- */

  function section(parent, label) {
    var s = div('wotd-sec', parent);
    div('wotd-sec-label', s, label);
    return s;
  }

  function renderPanel(body, ctx) {
    var now = new Date();
    var pick = wordFor(now);
    var full = ctx && ctx.mode && ctx.mode() === 'full';
    var es = lang() === 'es';
    var root = div('wotd-panel' + (full ? ' is-full' : ''), body);
    if (!pick) { div('wotd-none', root, T('wotd.none', 'No word for today.')); return; }
    var w = pick.w;
    var I = I18N();
    var date = I && I.longDate ? I.longDate(now) : now.toDateString();
    date = date.charAt(0).toUpperCase() + date.slice(1);

    var left = div('wotd-col wotd-col-word', root);
    div('wotd-p-date', left, date + ' · ' + T('wotd.level', 'Level {level}', { level: pick.level }));
    var word = div('wotd-es', left, w.es);
    if (w.say) div('wotd-say', left, '[' + w.say + ']');
    var enLine = div('wotd-enline', left);
    span('wotd-en', enLine, w.en);
    if (w.pos) span('wotd-pos', enLine, ' · ' + posText(w.pos));

    var right = div('wotd-col wotd-col-text', root);
    var mean = section(right, T('wotd.meaning', 'What it means'));
    div('wotd-def', mean, es ? w.defEs : w.defEn);
    div('wotd-def-other', mean, es ? w.defEn : w.defEs);
    var exs = section(right, T('wotd.example', 'Example'));
    div('wotd-ex', exs, w.exEs);
    div('wotd-ex-en', exs, w.exEn);

    // The big word on one line where it can; it wraps rather than run off.
    shrink(word, full ? 2.4 : 1.6, function () { return fitsWidth(word); });
    if (!fitsWidth(word)) word.style.whiteSpace = 'normal';
  }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'wotd',
    icon: 'speech',

    init: function (ctx) {
      var L = I18N();
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () {
          ctx.redrawTile();
          if (ctx.isOpen()) {
            ctx.redrawPanel();
            // The panel's title is the hub's; it is drawn on open.
            var t = document.querySelector('#panel .panel-title');
            if (t) t.textContent = title();
          }
        });
      }
      // A new day, a new word: checked once a minute.
      setInterval(function () {
        if (dayKey(new Date()) === shownDay) return;
        ctx.redrawTile();
        if (ctx.isOpen()) ctx.redrawPanel();
      }, 60000);
    },

    renderTile: function (body, ctx) {
      try {
        renderTile(body, ctx);
      } catch (e) {
        if (window.console && console.warn) console.warn('Word of the day: ' + (e && e.message));
        body.innerHTML = '';
        div('wotd-none', body, T('wotd.none', 'No word for today.'));
      }
    },

    renderPanel: function (body, ctx) { renderPanel(body, ctx); },

    onMode: function (mode, ctx) { ctx.redrawPanel(); }
  };

  // The title follows the language: the hub reads it when it draws the
  // tile and each time the panel opens.
  try {
    Object.defineProperty(widget, 'title', { get: title, enumerable: true, configurable: true });
    Object.defineProperty(widget, 'shortTitle', { get: shortTitle, enumerable: true, configurable: true });
  } catch (e) {
    widget.title = 'Word of the day';
  }

  // For the tests (dev/wotd-test.js).
  window.HUB_WOTD = { dayOfYear: dayOfYear, pickIndex: pickIndex, wordFor: wordFor, level: level };

  return widget;
})());
