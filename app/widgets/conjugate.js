/*
 * Conjugation table: every form of a Spanish verb, with a verb search that
 * needs no typing on the TV. Spanish study widget 2 (docs/spanish-study.md).
 *
 *   verbs    app/spanish-verbs.js (built by dev/build-spanish-verbs.js from
 *            Conjugate Me): the 70 Flashcards verbs plus every Word of the
 *            day verb; eight tenses, five persons (no vosotros); amber marks
 *            a form that is not the regular pattern
 *   which    today's Word of the day when it is a verb, else one of the
 *            Flashcards verbs (a new one each day); a verb picked on the
 *            page or the tile stays until the day ends
 *
 * TV, tile (3x2 or bigger): OK engages it; then Left and Right change the
 * tense, OK shows the next verb, Back leaves, holding OK opens the page.
 * A strip shows the verb and one tense's forms on a line; a narrow tile
 * the verb and its English.
 * TV, page (always full screen): a search box (the TV's keyboard, or a
 * USB one), the letters, the verbs for the focused letter, and the table.
 * Focus does the work: moving onto a letter lists its verbs, moving onto a
 * verb shows its table. A search finds a verb by its start, its English
 * ("to have") or any of its forms ("tuve" -> tener, pretérito, yo).
 * Wall tablet and phone (renderTouch): taps, and typing in the search box.
 *
 * Word of the day (app/widgets/wotd.js) draws the same table in its
 * Conjugation tab through window.HUB_CONJ.
 *
 * Spanish (the forms, the tense names) stays Spanish in both hub languages;
 * labels follow the hub (conj.* in app/i18n.js). Plain ES5, no flex gap,
 * no grid (the table is a <table>).
 */
(function (root) {
  'use strict';

  var MIN_COLS = 3;
  var MIN_ROWS = 2;
  // The table's two rows of four tenses (keys from app/spanish-verbs.js).
  var GROUPS = [['pres', 'pret', 'imp', 'fut'], ['cond', 'perf', 'subj', 'impv']];
  var TENSE_ES = {
    pres: 'Presente', pret: 'Pretérito', imp: 'Imperfecto', fut: 'Futuro',
    cond: 'Condicional', perf: 'Pretérito perfecto', subj: 'Presente de subjuntivo', impv: 'Imperativo'
  };
  // A plain hint under each tense name (conj.use.* has the Spanish).
  var TENSE_USE = {
    pres: 'now, usually', pret: 'done, finished', imp: 'used to, was -ing', fut: 'will',
    cond: 'would', perf: 'have done', subj: 'wishes, doubts', impv: 'commands'
  };
  // él/ella/usted and ellos/ustedes share their forms (Latin American Spanish).
  var WHO = ['yo', 'tú', 'él / Ud.', 'nosotros', 'ellos / Uds.'];

  function T(key, en, vars) {
    var L = root.HUB_I18N;
    if (L && typeof L.t === 'function') { try { return String(L.t(key, en, vars)); } catch (e) { /* English below */ } }
    return String(en).replace(/\{(\w+)\}/g, function (all, n) { return vars && vars.hasOwnProperty(n) ? String(vars[n]) : all; });
  }

  function title() { return T('conj.title', 'Conjugation table'); }
  function shortTitle() { return T('conj.titleShort', 'Verbs'); }

  /* ---------- the verbs ---------- */

  var data = null;

  function load() {
    if (data) return data;
    var src = root.HUB_SPANISH_VERBS;
    data = { list: [], byInf: {}, tenses: (src && src.tenses) || [], letters: [], byLetter: {} };
    if (!src || !src.verbs) return data;
    for (var i = 0; i < src.verbs.length; i++) {
      var r = src.verbs[i];
      var v = { i: i, inf: r[0], en: r[1], ger: r[2], pp: r[3], forms: r[4], irr: r[5], fc: !!r[6], key: norm(r[0]) };
      data.list.push(v);
      data.byInf[r[0]] = v;
      var l = v.key.charAt(0);
      if (!data.byLetter[l]) { data.byLetter[l] = []; data.letters.push(l); }
      data.byLetter[l].push(v);
    }
    return data;
  }

  function verbs() { return load().list; }
  function find(inf) { return load().byInf[inf] || null; }
  function tenseIndex(key) { return load().tenses.indexOf(key); }

  // Lower case, accents and ü off, ñ kept (it is its own letter).
  var PLAIN = { 'á': 'a', 'à': 'a', 'ä': 'a', 'é': 'e', 'è': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i', 'ï': 'i', 'ó': 'o', 'ò': 'o', 'ö': 'o', 'ú': 'u', 'ù': 'u', 'ü': 'u' };
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[áàäéèëíìïóòöúùü]/g, function (c) { return PLAIN[c]; }).replace(/\s+/g, ' ').replace(/^\s|\s$/g, '');
  }

  // A search: by the start of the verb, by its English, or by one of its
  // forms. Results: [{ v, hit }] where hit is { t, p } (a form) or null.
  function search(q) {
    q = norm(q);
    if (!q) return [];
    var eq = q.indexOf('to ') === 0 ? q.slice(3) : q;
    var out = [];
    var list = verbs();
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.key.indexOf(q) === 0) { out.push({ v: v, hit: null, rank: 0 }); continue; }
      var en = ' ' + norm(v.en.replace(/^to /, '')) + ' ';
      if (eq.length >= 2 && en.indexOf(' ' + eq) >= 0) { out.push({ v: v, hit: null, rank: 1 }); continue; }
      var hit = formHit(v, q);
      if (hit) out.push({ v: v, hit: hit, rank: 2 });
    }
    out.sort(function (a, b) { return a.rank - b.rank || (a.v.key < b.v.key ? -1 : a.v.key > b.v.key ? 1 : 0); });
    return out.slice(0, 40);
  }

  // "tuve" -> tener, pretérito, yo; "levanto" finds "me levanto" too.
  function formHit(v, q) {
    if (q.length < 2) return null;
    for (var t = 0; t < v.forms.length; t++) {
      for (var p = 0; p < 5; p++) {
        var f = v.forms[t][p];
        if (!f) continue;
        var n = norm(f);
        if (n === q || n.replace(/^(me|te|se|nos) /, '') === q) return { t: t, p: p };
      }
    }
    if (norm(v.ger) === q) return { t: -1, p: -1, part: 'ger' };
    if (norm(v.pp) === q) return { t: -1, p: -1, part: 'pp' };
    return null;
  }

  /* ---------- which verb ---------- */

  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  function dayOfYear(d) {
    var start = new Date(d.getFullYear(), 0, 1);
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((day.getTime() - start.getTime()) / 86400000);
  }

  // Today's Word of the day, when it is a verb this table has.
  function wotdVerb(d) {
    var W = root.HUB_WOTD;
    var pick = W && typeof W.wordFor === 'function' ? W.wordFor(d || new Date()) : null;
    return pick && pick.w && pick.w.pos === 'verb' ? find(pick.w.es) : null;
  }

  function defaultVerb(d) {
    d = d || new Date();
    var w = wotdVerb(d);
    if (w) return w;
    var fc = [];
    var list = verbs();
    for (var i = 0; i < list.length; i++) if (list[i].fc) fc.push(list[i]);
    if (!fc.length) fc = list;
    return fc.length ? fc[dayOfYear(d) % fc.length] : null;
  }

  // One state for the tile and the page on this screen.
  var S = { verb: null, day: '', tense: 0, letter: '', query: '', hit: null };

  function current() {
    var k = dayKey(new Date());
    if (S.day !== k || !S.verb) {
      S.day = k;
      S.verb = defaultVerb();
      S.hit = null;
      S.letter = S.verb ? S.verb.key.charAt(0) : '';
    }
    return S.verb;
  }

  function choose(v, hit) {
    current();
    S.verb = v;
    S.hit = hit || null;
    // The page opens on this verb's letter (a search keeps its results).
    if (v && !S.query) S.letter = v.key.charAt(0);
  }

  function nextVerb(step) {
    var list = verbs();
    var v = current();
    if (!v || !list.length) return;
    choose(list[(v.i + step + list.length) % list.length]);
  }

  function isToday(v) { return !!v && v === wotdVerb(); }

  /* ---------- small DOM helpers ---------- */

  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function hasCls(n, c) { return !!n && n.nodeType === 1 && (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0; }

  // A tap that is only this element's (the tile's own click opens the page).
  function onTap(node, fn) {
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      fn();
    });
  }

  function rem() { return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16; }

  /* ---------- the table (also Word of the day's Conjugation tab) ---------- */

  // o.perRow: 4 (two rows of four tenses) or 2 (four rows of two);
  // o.hit: { t, p } a form to ring (from a search).
  function drawTable(parent, v, o) {
    o = o || {};
    var per = o.perRow === 2 ? 2 : 4;
    var tenses = load().tenses;
    var groups = [];
    var flat = GROUPS[0].concat(GROUPS[1]);
    for (var g = 0; g < flat.length; g += per) groups.push(flat.slice(g, g + per));
    var table = el('table', 'cj-table cj-r' + per, parent);
    var body = el('tbody', '', table);
    for (var gi = 0; gi < groups.length; gi++) {
      var head = el('tr', 'cj-head' + (gi ? ' cj-head-next' : ''), body);
      el('th', 'cj-corner', head);
      for (var h = 0; h < groups[gi].length; h++) {
        var k = groups[gi][h];
        var th = el('th', 'cj-tense', head);
        el('div', 'cj-tname', th, TENSE_ES[k] || k);
        el('div', 'cj-tuse', th, T('conj.use.' + k, TENSE_USE[k] || ''));
      }
      for (var p = 0; p < 5; p++) {
        var tr = el('tr', 'cj-row', body);
        el('th', 'cj-who', tr, WHO[p]);
        for (var c = 0; c < groups[gi].length; c++) {
          var t = tenses.indexOf(groups[gi][c]);
          var f = t >= 0 ? v.forms[t][p] : null;
          var irr = t >= 0 && (v.irr[t] & (1 << p));
          var hit = o.hit && o.hit.t === t && o.hit.p === p;
          var td = el('td', 'cj-f' + (f ? '' : ' is-none') + (irr ? ' is-irr' : ''), tr, hit ? null : (f || '–'));
          // The form a search found sits in a ring of its own (the cell keeps its room).
          if (hit) el('span', 'cj-hitbox is-hit', td, f);
        }
      }
    }
    return table;
  }

  // Smaller type until the box fits its height and every form its cell
  // (measured once per draw, never on a timer).
  function fitTable(box, maxH, minRem) {
    if (!box || !maxH) return;
    var size = parseFloat(window.getComputedStyle(box).fontSize) || 16;
    var min = (minRem || 0.7) * rem();
    function fits() {
      if (box.offsetHeight > maxH + 1) return false;
      var cells = box.querySelectorAll('.cj-f, .cj-tname');
      for (var i = 0; i < cells.length; i++) if (cells[i].scrollWidth > cells[i].clientWidth + 1) return false;
      return true;
    }
    for (var n = 0; n < 24 && !fits() && size > min; n++) {
      size = Math.max(min, size * 0.94);
      box.style.fontSize = size.toFixed(1) + 'px';
    }
  }

  function partsLine(parent, v) {
    var line = el('div', 'cj-parts', parent);
    el('span', 'cj-plabel', line, T('conj.gerund', 'gerund') + ' ');
    el('span', 'cj-pform' + (S.hit && S.hit.part === 'ger' ? ' is-hit' : ''), line, v.ger);
    el('span', 'cj-psep', line, '  ·  ');
    el('span', 'cj-plabel', line, T('conj.participle', 'participle') + ' ');
    el('span', 'cj-pform' + (S.hit && S.hit.part === 'pp' ? ' is-hit' : ''), line, v.pp);
    return line;
  }

  function legend(parent) {
    var lg = el('div', 'cj-legend', parent);
    el('span', 'cj-dot', lg);
    lg.appendChild(document.createTextNode(T('conj.irregular', 'Not the regular pattern (irregular or a spelling change)')));
    return lg;
  }

  /* ---------- the TV tile ---------- */

  function bigEnough(ctx) {
    var z = ctx.size();
    return z.cols >= MIN_COLS && z.rows >= MIN_ROWS;
  }

  function tenseKey() { return load().tenses[S.tense] || 'pres'; }

  function moveTense(step) {
    var n = load().tenses.length || 1;
    S.tense = (S.tense + step + n) % n;
  }

  var tileCtx = null;
  var lastTile = '';

  function renderTile(body, ctx) {
    tileCtx = ctx;
    body.classList.add('cj-tile');
    var v = current();
    var z = ctx.size();
    if (!v) { el('div', 'cj-none', body, T('conj.none', 'No verbs')); return; }
    var t = S.tense;
    var forms = v.forms[t] || [];
    var k = tenseKey();
    if (z.rows === 1) {
      body.classList.add('cj-strip');
      var line = el('div', 'cj-line', body);
      el('span', 'cj-line-verb', line, v.inf);
      line.appendChild(document.createTextNode('  ' + forms.filter(function (f) { return !!f; }).join(', ')));
      return;
    }
    if (z.cols < MIN_COLS) {
      body.classList.add('cj-narrow');
      el('div', 'cj-verb', body, v.inf);
      el('div', 'cj-en', body, v.en);
      return;
    }
    var tall = z.rows >= 3;
    body.classList.add(tall ? 'cj-tall' : 'cj-std');
    if (z.rows >= 4) body.classList.add('cj-roomy');
    // Today's word says so in the head's badge; the English gives way when the line is full.
    if (ctx.setBadge) ctx.setBadge(isToday(v) ? T('conj.todayShort', 'Today’s word') : '');
    var top = el('div', 'cj-top', body);
    el('span', 'cj-verb', top, v.inf);
    var en = el('span', 'cj-en', top, '  ' + v.en);
    var tl = el('div', 'cj-tline', body);
    var prev = el('span', 'cj-arrow cj-prev', tl, '◀');
    el('span', 'cj-tname', tl, TENSE_ES[k] || k);
    el('span', 'cj-tuse', tl, T('conj.use.' + k, TENSE_USE[k] || ''));
    var next = el('span', 'cj-arrow cj-next', tl, '▶');
    onTap(prev, function () { moveTense(-1); ctx.redrawTile(); });
    onTap(next, function () { moveTense(1); ctx.redrawTile(); });
    var stamp = v.inf + '.' + t;
    var box = el('div', 'cj-forms' + (lastTile && lastTile !== stamp ? ' cj-in' : ''), body);
    lastTile = stamp;
    // Standard: two columns (yo, tú, él | nosotros, ellos); tall: one.
    var cols = tall ? [[0, 1, 2, 3, 4]] : [[0, 1, 2], [3, 4]];
    for (var c = 0; c < cols.length; c++) {
      var col = el('div', 'cj-col', box);
      for (var i = 0; i < cols[c].length; i++) {
        var p = cols[c][i];
        var row = el('div', 'cj-frow', col);
        el('span', 'cj-who', row, WHO[p]);
        el('span', 'cj-f' + (forms[p] ? '' : ' is-none') + ((v.irr[t] & (1 << p)) ? ' is-irr' : ''), row, forms[p] || '–');
      }
    }
    // Tall enough: the gerund and participle, without their labels (a glance).
    if (z.rows >= 4) el('div', 'cj-parts', body, v.ger + '  ·  ' + v.pp);
    el('div', 'cj-foot', body, ctx.tablet ? T('conj.tapOpen', 'Tap to search') : T('conj.okUse', 'OK to browse'));
    if (en.scrollWidth > en.clientWidth + 1) en.parentNode.removeChild(en);
    fitTile(body, box);
  }

  // Forms taller than their room: the tense hint goes, then the gerund line,
  // then the pronouns.
  function fitTile(body, box) {
    var over = function () { return box.scrollHeight > box.clientHeight + 1; };
    if (!body.clientHeight || !over()) return;
    var use = body.querySelector('.cj-tline .cj-tuse');
    if (use) use.parentNode.removeChild(use);
    if (!over()) return;
    var parts = body.querySelector('.cj-parts');
    if (parts) parts.parentNode.removeChild(parts);
    if (!over()) return;
    body.classList.add('cj-tight');
  }

  /* ---------- the page ---------- */

  var page = null;  // { list, main, input, ctx } while the page is drawn

  function letterLabel(l) { return l === 'ñ' ? 'Ñ' : l.toUpperCase(); }

  function renderPage(body, ctx, touch) {
    var v = current();
    var root2 = el('div', 'cj-page' + (touch ? ' cj-page-touch' : ''), body);
    var side = el('div', 'cj-side', root2);
    var input = el('input', 'cj-q' + (touch ? '' : ' f'), side);
    input.type = 'search';
    input.setAttribute('data-key', 'q');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.placeholder = T('conj.search', 'Search: tener, to have, tuve');
    input.value = S.query;
    // Typing (wall tablet, phone, a USB keyboard) filters as it goes.
    input.addEventListener('input', function () { S.query = input.value; drawList(); });
    var today = wotdVerb();
    if (today) {
      var chip = el('div', 'cj-today' + (touch ? '' : ' f'), side);
      chip.setAttribute('data-key', 'today');
      el('span', 'cj-today-l', chip, T('conj.today', 'Today’s word') + '  ');
      el('span', 'cj-today-v', chip, today.inf);
      if (touch) onTap(chip, function () { pickVerb(today, null); });
    }
    var letters = el('div', 'cj-letters', side);
    var L = load().letters;
    for (var i = 0; i < L.length; i++) {
      var b = el('div', 'cj-let' + (touch ? '' : ' f') + (!S.query && L[i] === S.letter ? ' is-on' : ''), letters, letterLabel(L[i]));
      b.setAttribute('data-key', 'l-' + L[i]);
      b.setAttribute('data-letter', L[i]);
      if (touch) onTap(b, (function (l) { return function () { pickLetter(l); }; })(L[i]));
    }
    var list = el('div', 'cj-list tscroll', side);
    // A short tablet screen may still need a finger to see the last row.
    var main = el('div', 'cj-main tscroll', root2);
    page = { list: list, main: main, input: input, ctx: ctx, touch: !!touch, letters: letters };
    drawList();
    drawMain();
    if (ctx && ctx.setSub) ctx.setSub(T('conj.sub', '{n} Spanish verbs · eight tenses', { n: verbs().length }));
    // Focus starts on the verb shown (or its letter).
    var on = list.querySelector('.cj-item.is-on') || letters.querySelector('.cj-let.is-on');
    if (on && !touch) on.setAttribute('data-autofocus', '1');
  }

  function items() {
    if (S.query) return search(S.query);
    var vs = load().byLetter[S.letter] || [];
    var out = [];
    for (var i = 0; i < vs.length; i++) out.push({ v: vs[i], hit: null });
    return out;
  }

  function hitText(h) {
    if (h.part) return h.part === 'ger' ? T('conj.gerund', 'gerund') : T('conj.participle', 'participle');
    var k = load().tenses[h.t];
    return (TENSE_ES[k] || k).toLowerCase() + ' · ' + WHO[h.p];
  }

  function drawList() {
    if (!page) return;
    var list = page.list;
    list.innerHTML = '';
    list.scrollTop = 0;
    var its = items();
    var v = current();
    if (!its.length) {
      el('div', 'cj-empty', list, S.query ? T('conj.noMatch', 'No verb found. Try the start of a verb, its English or a form.') : '');
      return;
    }
    for (var i = 0; i < its.length; i++) {
      var it = its[i];
      var row = el('div', 'cj-item' + (page.touch ? '' : ' f') + (it.v === v ? ' is-on' : ''), list);
      row.setAttribute('data-key', 'v-' + it.v.inf + (it.hit ? '-' + it.hit.t + '-' + it.hit.p + (it.hit.part || '') : ''));
      row.setAttribute('data-verb', it.v.inf);
      if (it.hit) {
        row.setAttribute('data-hit', it.hit.part ? it.hit.part : it.hit.t + ',' + it.hit.p);
        var f = it.hit.part ? it.v[it.hit.part] : it.v.forms[it.hit.t][it.hit.p];
        el('span', 'cj-item-form', row, f + ' → ');
      }
      el('span', 'cj-item-verb', row, it.v.inf);
      el('span', 'cj-item-en', row, it.hit ? hitText(it.hit) : it.v.en);
      if (page.touch) onTap(row, (function (x) { return function () { pickVerb(x.v, x.hit); }; })(it));
    }
    // Letters show which one is listed (none while a search is).
    var ls = page.letters.querySelectorAll('.cj-let');
    for (var j = 0; j < ls.length; j++) {
      if (!S.query && ls[j].getAttribute('data-letter') === S.letter) ls[j].classList.add('is-on'); else ls[j].classList.remove('is-on');
    }
  }

  function drawMain() {
    if (!page) return;
    var main = page.main;
    main.innerHTML = '';
    main.style.fontSize = '';
    var v = current();
    if (!v) { el('div', 'cj-none', main, T('conj.none', 'No verbs')); return; }
    var head = el('div', 'cj-mhead', main);
    el('span', 'cj-mverb', head, v.inf);
    el('span', 'cj-men', head, '  ' + v.en);
    if (isToday(v)) el('span', 'cj-badge', head, T('conj.today', 'Today’s word'));
    partsLine(main, v);
    var wrap = el('div', 'cj-twrap', main);
    drawTable(wrap, v, { perRow: page.touch ? 2 : 4, hit: S.hit });
    legend(main);
    // The TV and tablet page has a fixed height; the phone scrolls, so only the width counts there.
    fitTable(wrap, page.touch ? 1e6 : main.clientHeight - (main.scrollHeight - wrap.offsetHeight), 0.7);
    var on = page.list.querySelectorAll('.cj-item');
    for (var i = 0; i < on.length; i++) {
      if (on[i].getAttribute('data-verb') === v.inf) on[i].classList.add('is-on'); else on[i].classList.remove('is-on');
    }
  }

  function pickLetter(l) {
    S.letter = l;
    S.query = '';
    if (page && page.input) page.input.value = '';
    drawList();
  }

  function pickVerb(v, hit) {
    if (!v) return;
    choose(v, hit);
    drawMain();
    if (tileCtx) tileCtx.redrawTile();
  }

  function hitOf(node) {
    var h = node.getAttribute('data-hit');
    if (!h) return null;
    if (h === 'ger' || h === 'pp') return { t: -1, p: -1, part: h };
    var a = h.split(',');
    return { t: +a[0], p: +a[1] };
  }

  // The list is its own box: keep the focused verb inside it.
  function keepInList(node) {
    var list = page && page.list;
    if (!list || !list.contains(node)) return;
    var top = node.offsetTop;   // the list is the items' offsetParent (position: relative)
    var pad = Math.round(0.5 * rem());
    if (top < list.scrollTop + pad) list.scrollTop = Math.max(0, top - pad);
    else if (top + node.offsetHeight > list.scrollTop + list.clientHeight - pad) list.scrollTop = top + node.offsetHeight - list.clientHeight + pad;
  }

  /* ---------- the phone (app/touch.js) ---------- */

  function renderTouch(host) {
    var view = el('div', 'cj-touch', host);
    renderPage(view, null, true);
    var timer = setInterval(function () { if (S.day !== dayKey(new Date())) { view.innerHTML = ''; renderPage(view, null, true); } }, 60000);
    return {
      update: function () {},
      destroy: function () {
        clearInterval(timer);
        page = null;
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  /* ---------- the widget ---------- */

  var widget = {
    id: 'conjugate',
    icon: 'table',
    titleKey: 'conj.title',
    openMode: 'full',
    touchIcon: 'M4 5.5h16v13H4zM4 10h16M4 14.5h16M9.5 5.5v13',

    engage: function (ctx) { return bigEnough(ctx); },
    engageHint: function () { return T('conj.hint', '◀ ▶ tense · OK: verb · Hold OK: open'); },
    onEngagedKey: function (key, ctx) {
      if (key === 'left') moveTense(-1);
      else if (key === 'right') moveTense(1);
      else if (key === 'ok') nextVerb(1);
      ctx.redrawTile();
    },

    init: function (ctx) {
      load();
      current();
      var L = root.HUB_I18N;
      if (L && typeof L.onChange === 'function') {
        L.onChange(function () { ctx.redrawTile(); if (ctx.isOpen()) ctx.redrawPanel(); });
      }
      // A new day: today's verb again (current() notices).
      setInterval(function () {
        if (S.day === dayKey(new Date())) return;
        current();
        ctx.redrawTile();
        if (ctx.isOpen()) ctx.redrawPanel();
      }, 60000);
    },

    renderTile: renderTile,

    renderPanel: function (body, ctx) {
      if (!S.query) S.letter = S.letter || (current() ? current().key.charAt(0) : '');
      // Wall tablet: a tap focuses and selects a .f, so the same hooks act.
      renderPage(body, ctx, false);
    },

    // Focus does the work: a letter lists its verbs, a verb shows its table.
    onFocus: function (target) {
      if (!page) return;
      if (hasCls(target, 'cj-let')) {
        var l = target.getAttribute('data-letter');
        if (l !== S.letter || S.query) pickLetter(l);
      } else if (hasCls(target, 'cj-item')) {
        keepInList(target);
        var v = find(target.getAttribute('data-verb'));
        var hit = hitOf(target);
        if (v && (v !== S.verb || JSON.stringify(hit) !== JSON.stringify(S.hit))) pickVerb(v, hit);
      } else if (hasCls(target, 'cj-today')) {
        var w = wotdVerb();
        if (w && w !== S.verb) pickVerb(w, null);
      }
    },

    // OK on a letter goes to its first verb (a tap on the tablet only lists them).
    onSelect: function (target, ctx) {
      if (hasCls(target, 'cj-let') && page && !ctx.tablet) {
        var first = page.list.querySelector('.cj-item');
        if (first) ctx.focus(first);
      }
    },

    // Enter or Done in the search box: its results, focus on the first.
    onSubmit: function (target, ctx) {
      S.query = target.value || '';
      drawList();
      var first = page && page.list.querySelector('.cj-item');
      if (first) ctx.focus(first);
    },

    // While a search shows results, Down from the box goes to them and Up
    // from the first comes back (the letters in between would clear it).
    onMove: function (dir, from) {
      if (!page || !S.query) return undefined;
      if (dir === 'down' && hasCls(from, 'cj-q')) return page.list.querySelector('.cj-item') || undefined;
      if (dir === 'up' && hasCls(from, 'cj-item') && from === page.list.querySelector('.cj-item')) return page.input;
      return undefined;
    },

    onClose: function () { page = null; },
    onMode: function (mode, ctx) { ctx.redrawPanel(); },

    renderTouch: renderTouch,
    summary: function () { var v = current(); return v ? v.inf + ' · ' + v.en : ''; }
  };

  try {
    Object.defineProperty(widget, 'title', { get: title, enumerable: true, configurable: true });
    Object.defineProperty(widget, 'shortTitle', { get: shortTitle, enumerable: true, configurable: true });
  } catch (e) {
    widget.title = 'Conjugation table';
  }

  // For Word of the day's Conjugation tab and the tests.
  root.HUB_CONJ = {
    find: find, verbs: verbs, search: search, norm: norm, drawTable: drawTable, fitTable: fitTable,
    legend: legend, defaultVerb: defaultVerb, tenseIndex: tenseIndex, TENSE_ES: TENSE_ES,
    state: function () { var v = current(); return { verb: v && v.inf, tense: tenseKey(), letter: S.letter, query: S.query, hit: S.hit }; }
  };

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push(widget);
})(typeof window !== 'undefined' ? window : this);
