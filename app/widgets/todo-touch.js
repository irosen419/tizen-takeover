/*
 * To-do on a phone, tablet or computer: the touch view of the to-do list
 * kept on the Pi (pi/server.js, resource "todo", the same list the TV's
 * to-do widget, ./hub todo and the calendar converter change). Loaded only
 * by app/touch.html; the TV keeps app/widgets/todo.js. Two parts:
 *
 *   window.HUB_TODO_TOUCH  shared logic, no DOM: an item's level, lead,
 *                          shown title and notes (the same rules as the TV's
 *                          todo.js), the sections, and a local copy of the
 *                          Pi's ops for the optimistic update. Node can
 *                          require this file too (dev/todo-touch-test.js).
 *   renderTouch(el, ctx)   the view (app/touch.js mounts it). Changes go to
 *                          POST /touch/todo/ops (opsPath): add, set, remove,
 *                          exactly the ops the TV sends to /todo/ops.
 *
 * Sections, as on the TV: "Must today" (red), "If you can" (yellow),
 * "Coming up" (passive items with no date, or due within their lead; no tick
 * box, as on the TV; the rest wait under "Later", one tap away) and
 * "Completed" (ticked in the last 24 hours; a tap unticks). A red strip says
 * how many must-dos are due today; from 5 PM it breathes (opacity only),
 * stronger when one is late. Each row's "..." opens a tray: move it to
 * another level, or remove it (Undo for 6 seconds).
 *
 * A ticked calendar to-do is handled on the Pi (todoconvert.js): a "TODO:"
 * event is deleted in Google, "TODO!:" and "TODO~:" are kept. This view
 * only sets done; it shows a small calendar mark on rows that came from it.
 *
 * Titles and notes are what people typed: never translated, never logged.
 * Plain ES5 like the rest of app/.
 */
(function (root) {
  'use strict';

  var MAX_TITLE = 80;
  var COMING_UP_DAYS = 2;
  var MAX_LEAD = 30;
  var DONE_KEEP_MS = 24 * 60 * 60 * 1000;
  var LEVELS = ['must', 'optional', 'passive'];
  var TAG_LEVEL = /\[level:(must|optional|passive)\]/;
  var TAG_LEAD = /\[lead:(\d{1,2})\]/;
  var TAGS = /\s*\[(?:level|lead|cal):[^\]]*\]/g;
  var PREFIX = /^\s*todo([!~]?):\s*/i;
  var PREFIX_LEVEL = { '!': 'must', '': 'optional', '~': 'passive' };
  var seq = 0;

  function tidy(text) { return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, ''); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateOf(day) { return new Date(+day.substring(0, 4), +day.substring(5, 7) - 1, +day.substring(8, 10)); }
  function addDays(day, n) { var d = dateOf(day); d.setDate(d.getDate() + n); return dayOf(d); }
  function daysBetween(from, to) {
    var a = Date.UTC(+from.substring(0, 4), +from.substring(5, 7) - 1, +from.substring(8, 10));
    var b = Date.UTC(+to.substring(0, 4), +to.substring(5, 7) - 1, +to.substring(8, 10));
    return Math.round((b - a) / 86400000);
  }
  function isLead(n) { return typeof n === 'number' && n >= 0 && n <= MAX_LEAD && Math.floor(n) === n; }

  // Its level field, else the calendar prefix of its title, else a notes tag, else optional.
  function levelOf(item) {
    if (LEVELS.indexOf(item.level) >= 0) return item.level;
    var p = typeof item.title === 'string' ? PREFIX.exec(item.title) : null;
    if (p) return PREFIX_LEVEL[p[1]];
    var m = typeof item.notes === 'string' ? TAG_LEVEL.exec(item.notes) : null;
    return m ? m[1] : 'optional';
  }

  function leadOf(item) {
    if (isLead(item.lead)) return item.lead;
    var m = typeof item.notes === 'string' ? TAG_LEAD.exec(item.notes) : null;
    var n = m ? parseInt(m[1], 10) : -1;
    return isLead(n) ? n : COMING_UP_DAYS;
  }

  function fromCalendar(item) {
    return (typeof item.title === 'string' && PREFIX.test(item.title)) || (typeof item.notes === 'string' && /\[cal:/.test(item.notes));
  }

  function shownTitle(item) {
    var title = typeof item.title === 'string' ? item.title : '';
    return tidy(title.replace(PREFIX, '').replace(TAGS, ' ')) || title;
  }

  function shownNotes(item) {
    return typeof item.notes === 'string' ? tidy(item.notes.replace(TAGS, ' ')) : '';
  }

  // The view's sections for a day ('YYYY-MM-DD'): list order within each,
  // the newest tick first in done.
  function sections(items, today) {
    var out = { must: [], optional: [], coming: [], later: [], done: [], mustToday: [], late: false };
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.done) { out.done.push(it); continue; }
      var lv = levelOf(it);
      if (lv === 'passive') {
        if (!it.due || it.due <= addDays(today, leadOf(it))) out.coming.push(it);
        else out.later.push(it);
        continue;
      }
      out[lv].push(it);
      if (lv === 'must' && (!it.due || it.due <= today)) {
        out.mustToday.push(it);
        var day = it.due || (typeof it.createdAt === 'number' ? dayOf(new Date(it.createdAt)) : today);
        if (day < today) out.late = true;
      }
    }
    out.done.sort(function (a, b) { return (Number(b.doneAt) || 0) - (Number(a.doneAt) || 0); });
    out.later.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
    return out;
  }

  function newId(now) {
    seq = (seq + 1) % 1296;
    return 't' + now.toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function copy(item, over) {
    var o = {}, k;
    for (k in item) if (Object.prototype.hasOwnProperty.call(item, k)) o[k] = item[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k];
    return o;
  }

  // The Pi's ops (pi/server.js applyOps) on a copy, for the optimistic
  // update; the Pi's answer replaces it. Never throws: an op it can't
  // follow is skipped (the Pi then says why).
  function applyLocal(items, ops, now) {
    var list = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.done && typeof it.doneAt === 'number' && now - it.doneAt > DONE_KEEP_MS) continue;
      list.push(it);
    }
    function at(id) { for (var j = 0; j < list.length; j++) if (list[j].id === id) return j; return -1; }
    for (var n = 0; n < ops.length; n++) {
      var op = ops[n];
      if (!op) continue;
      if (op.op === 'add' && op.item) {
        var x = at(op.item.id);
        if (x >= 0) list[x] = copy(list[x], op.item);
        else if (op.at === 'top') list.unshift(copy(op.item, {}));
        else list.push(copy(op.item, {}));
      } else if (op.op === 'set') {
        var s = at(op.id);
        if (s < 0) continue;
        var merged = copy(list[s], op.fields || {});
        for (var f in merged) if (merged[f] === null && f !== 'doneAt') delete merged[f];
        if (op.to === 'end') { list.splice(s, 1); list.push(merged); } else list[s] = merged;
      } else if (op.op === 'remove') {
        var r = at(op.id);
        if (r >= 0) list.splice(r, 1);
      }
    }
    return list;
  }

  var Logic = {
    MAX_TITLE: MAX_TITLE, levelOf: levelOf, leadOf: leadOf, shownTitle: shownTitle, shownNotes: shownNotes,
    fromCalendar: fromCalendar, sections: sections, applyLocal: applyLocal, newId: newId,
    dayOf: dayOf, addDays: addDays, daysBetween: daysBetween
  };
  root.HUB_TODO_TOUCH = Logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof document === 'undefined') return;

  /* ---------- the view ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  var PATHS = {
    list: 'M10 6.5h10 M10 12h10 M10 17.5h10 M4 6.5l1.4 1.4L8 5.3 M4 12l1.4 1.4L8 10.8 M4 17.5l1.4 1.4L8 16.3',
    check: 'M5 12.5l4.2 4.2L19 7',
    plus: 'M12 5v14M5 12h14',
    more: 'M6 12h.01 M12 12h.01 M18 12h.01',
    bin: 'M4.5 7h15 M9.5 7V4.8h5V7 M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12',
    cal: 'M5 6.5h14v13H5z M5 10.5h14 M9 4v4 M15 4v4',
    chevron: 'M6.5 9.5L12 15l5.5-5.5'
  };

  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'tx-ic ' + (cls || ''));
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', PATHS[name]);
    s.appendChild(p);
    return s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The level picker's order: the everyday choice first.
  var PICK = ['optional', 'must', 'passive'];
  var LEVEL_WORD = {
    must: ['todo.sections.must', 'Must today'],
    optional: ['todo.sections.optional', 'If you can'],
    passive: ['todo.comingUp', 'Coming up']
  };

  function renderTouch(host, ctx) {
    var T = ctx.t;
    var I = root.HUB_I18N;
    var view = el('div', 'tx');
    host.appendChild(view);

    function word(level) { return T(LEVEL_WORD[level][0], LEVEL_WORD[level][1]); }

    // Attribute first: how many are left leads; done today recedes.
    var head = el('div', 'tx-head');
    var lead = el('div', 'tx-lead');
    var big = el('span', 'tx-big');
    var bigWord = el('span', 'tx-big-word');
    lead.appendChild(big);
    lead.appendChild(bigWord);
    var doneMeta = el('span', 'tx-meta');
    head.appendChild(lead);
    head.appendChild(doneMeta);
    view.appendChild(head);

    var alert = el('div', 'tx-alert');
    alert.setAttribute('role', 'status');
    var glow = el('span', 'tx-glow');
    var alertText = el('span', 'tx-alert-text');
    alert.appendChild(glow);
    alert.appendChild(el('span', 'tx-alert-dot'));
    alert.appendChild(alertText);
    view.appendChild(alert);

    var form = el('form', 'tx-add');
    form.setAttribute('autocomplete', 'off');
    var row1 = el('div', 'tx-add-row');
    var label = el('label', 'tx-sr', T('todo.touch.addLabel', 'Add a to-do'));
    var input = el('input', 'tx-input');
    input.type = 'text';
    input.id = 'tx-input-' + Math.floor(Math.random() * 1e6);
    input.maxLength = MAX_TITLE;
    label.setAttribute('for', input.id);
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('autocapitalize', 'sentences');
    input.placeholder = T('todo.addPlaceholder', 'Add an item');
    var addBtn = el('button', 'tx-add-btn');
    addBtn.type = 'submit';
    addBtn.appendChild(icon('plus'));
    addBtn.appendChild(el('span', 'tx-add-word', T('todo.touch.add', 'Add')));
    row1.appendChild(label);
    row1.appendChild(input);
    row1.appendChild(addBtn);
    form.appendChild(row1);

    var pickLevel = 'optional';
    var picker = el('div', 'tx-seg tx-pick');
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', T('todo.touch.levelLabel', 'Add it to'));
    var pickBtns = {};
    PICK.forEach(function (lv) {
      var b = el('button', 'tx-seg-btn is-' + lv);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.appendChild(el('span', 'tx-seg-dot'));
      b.appendChild(el('span', 'tx-seg-word', word(lv)));
      b.addEventListener('click', function () { pickLevel = lv; paintPicker(); });
      pickBtns[lv] = b;
      picker.appendChild(b);
    });
    function paintPicker() {
      PICK.forEach(function (lv) { pickBtns[lv].setAttribute('aria-checked', lv === pickLevel ? 'true' : 'false'); });
    }
    paintPicker();
    form.appendChild(picker);
    view.appendChild(form);

    var banner = el('p', 'tx-banner');
    banner.setAttribute('role', 'status');
    view.appendChild(banner);

    var lists = el('div', 'tx-lists');
    view.appendChild(lists);
    var empty = el('div', 'tx-empty');
    view.appendChild(empty);

    var toast = el('div', 'tx-toast');
    toast.setAttribute('role', 'status');
    var toastText = el('span', 'tx-toast-text');
    var undoBtn = el('button', 'tx-undo', T('todo.touch.undo', 'Undo'));
    undoBtn.type = 'button';
    toast.appendChild(toastText);
    toast.appendChild(undoBtn);
    view.appendChild(toast);

    var openId = null;        // the row whose tray is open
    var showLater = false;
    var popId = null;         // the row whose tick plays its pop on the next draw
    var failMsg = '';
    var lastRemoved = null, toastTimer = null, dayTimer = null;
    var rows = {};

    function items() { var d = ctx.data(); return d && d.items ? d.items : []; }
    function today() { return dayOf(new Date()); }

    function send(ops) {
      failMsg = '';
      ctx.send(ops, { items: applyLocal(items(), ops, Date.now()) }, function (err) {
        if (err) { failMsg = T('todo.touch.saveFailed', 'That didn’t save: {why}', { why: err }); render(); }
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = tidy(input.value).substring(0, MAX_TITLE);
      if (!title) { input.focus(); return; }
      var now = Date.now();
      var item = { id: newId(now), title: title, level: pickLevel, section: 'now', done: false, doneAt: null, createdAt: now };
      input.value = '';
      send([{ op: 'add', item: item, at: 'top' }]);
    });

    undoBtn.addEventListener('click', function () {
      if (lastRemoved) send([{ op: 'add', item: lastRemoved, at: 'top' }]);
      hideToast();
    });
    function hideToast() { lastRemoved = null; toast.className = 'tx-toast'; }
    function showToast(item) {
      lastRemoved = item;
      toastText.textContent = T('todo.touch.removed', 'Removed {t}', { t: shownTitle(item) });
      toast.className = 'tx-toast is-on';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 6000);
    }

    function shortDate(day) {
      var d = dateOf(day);
      var mon = I && I.monthName ? I.monthName(d, true) : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      return T('todo.dateShort', '{mon} {d}').replace('{mon}', mon).replace('{d}', String(d.getDate()));
    }

    // Open items: Overdue, Due today, Due Dec 3. Passive: Today, Tomorrow,
    // "Thu · in 3 days". Done: Yesterday when it was ticked before today.
    function when(item, now) {
      if (item.done) {
        return typeof item.doneAt === 'number' && dayOf(new Date(item.doneAt)) < now ? { text: T('todo.yesterday', 'Yesterday') } : null;
      }
      if (!item.due) return null;
      if (item.due < now) return { text: T('todo.overdue', 'Overdue'), late: true };
      if (levelOf(item) === 'passive') {
        var n = daysBetween(now, item.due);
        if (n === 0) return { text: T('todo.today', 'Today'), soon: true };
        if (n === 1) return { text: T('todo.tomorrow', 'Tomorrow') };
        var d = dateOf(item.due);
        var label = n < 7 && I && I.dayName ? I.dayName(d, true) : shortDate(item.due);
        return { text: label + ' · ' + T('todo.inDays', 'in {n} days').replace('{n}', String(n)) };
      }
      if (item.due === now) return { text: T('todo.dueToday', 'Due today'), soon: true };
      return { text: T('todo.dueOn', 'Due {d}').replace('{d}', shortDate(item.due)) };
    }

    function row(item, now) {
      var lv = levelOf(item);
      var name = shownTitle(item);
      var li = rows[item.id] || el('li', 'tx-row');
      li.innerHTML = '';
      li.className = 'tx-row is-' + lv + (item.done ? ' is-done' : '') + (openId === item.id ? ' is-open' : '');
      li.setAttribute('data-id', item.id);

      var line = el('div', 'tx-line');
      var main;
      if (lv === 'passive' && !item.done) {
        // As on the TV: a reminder, not a box to tick.
        main = el('div', 'tx-main');
        main.appendChild(el('span', 'tx-mark'));
      } else {
        main = el('button', 'tx-main tx-tick');
        main.type = 'button';
        main.setAttribute('aria-pressed', item.done ? 'true' : 'false');
        main.setAttribute('aria-label', item.done ? T('todo.touch.untick', 'Untick {t}', { t: name }) : T('todo.touch.tick', 'Tick {t}', { t: name }));
        var box = el('span', 'tx-box' + (popId === item.id ? ' is-pop' : ''));
        box.appendChild(icon('check'));
        main.appendChild(box);
        main.addEventListener('click', function () {
          var done = !item.done;
          if (done) popId = item.id;
          openId = null;
          send([{ op: 'set', id: item.id, fields: { done: done, doneAt: done ? Date.now() : null } }]);
        });
      }
      var text = el('span', 'tx-text');
      var title = el('span', 'tx-name', name);
      if (lv === 'must' && !item.done) {
        var pill = el('span', 'tx-pill', T('todo.mustPill', 'MUST'));
        title.appendChild(document.createTextNode(' '));
        title.appendChild(pill);
      }
      text.appendChild(title);
      var w = when(item, now);
      var notes = shownNotes(item);
      var cal = fromCalendar(item);
      if (w || notes || cal) {
        var sub = el('span', 'tx-sub');
        if (cal) {
          var c = el('span', 'tx-cal');
          c.appendChild(icon('cal'));
          c.setAttribute('title', T('todo.touch.fromCal', 'From your calendar'));
          sub.appendChild(c);
        }
        if (w) sub.appendChild(el('span', 'tx-when' + (w.late ? ' is-late' : '') + (w.soon ? ' is-soon' : ''), w.text));
        if (w && notes) sub.appendChild(el('span', 'tx-dot', '·'));
        if (notes) sub.appendChild(el('span', 'tx-notes', notes));
        text.appendChild(sub);
      }
      main.appendChild(text);
      line.appendChild(main);

      var more = el('button', 'tx-more');
      more.type = 'button';
      more.setAttribute('aria-expanded', openId === item.id ? 'true' : 'false');
      more.setAttribute('aria-label', T('todo.touch.moreFor', 'More for {t}', { t: name }));
      more.appendChild(icon('more'));
      more.addEventListener('click', function () { openId = openId === item.id ? null : item.id; render(); });
      line.appendChild(more);
      li.appendChild(line);

      if (openId === item.id) {
        var tray = el('div', 'tx-tray');
        if (!item.done) {
          var seg = el('div', 'tx-seg tx-move');
          seg.setAttribute('role', 'group');
          seg.setAttribute('aria-label', T('todo.touch.moveLabel', 'Move to'));
          PICK.forEach(function (to) {
            var b = el('button', 'tx-seg-btn is-' + to);
            b.type = 'button';
            b.setAttribute('aria-pressed', to === lv ? 'true' : 'false');
            b.appendChild(el('span', 'tx-seg-dot'));
            b.appendChild(el('span', 'tx-seg-word', word(to)));
            b.addEventListener('click', function () {
              if (to === lv) return;
              openId = null;
              send([{ op: 'set', id: item.id, fields: { level: to }, to: 'end' }]);
            });
            seg.appendChild(b);
          });
          tray.appendChild(seg);
        }
        var del = el('button', 'tx-del');
        del.type = 'button';
        del.appendChild(icon('bin'));
        del.appendChild(el('span', '', T('todo.remove', 'Remove')));
        del.addEventListener('click', function () {
          openId = null;
          send([{ op: 'remove', id: item.id }]);
          showToast(item);
        });
        tray.appendChild(del);
        li.appendChild(tray);
      }
      rows[item.id] = li;
      return li;
    }

    function group(cls, labelText, list, now, extra) {
      var sec = el('section', 'tx-sec ' + cls);
      var h = el('h3', 'tx-sec-head');
      h.appendChild(el('span', 'tx-sec-dot'));
      h.appendChild(el('span', 'tx-sec-word', labelText));
      h.appendChild(el('span', 'tx-sec-count', String(list.length)));
      sec.appendChild(h);
      var ul = el('ul', 'tx-list');
      list.forEach(function (it) { ul.appendChild(row(it, now)); });
      sec.appendChild(ul);
      if (extra) sec.appendChild(extra);
      lists.appendChild(sec);
      return sec;
    }

    // Rows that moved glide to their new place (transform only).
    function flip(before) {
      if (ctx.reduced()) return;
      Object.keys(rows).forEach(function (id) {
        var r = rows[id], b = before[id];
        if (!r.parentNode) return;
        var top = r.getBoundingClientRect().top;
        if (b === undefined) {
          r.style.transition = 'none';
          r.style.opacity = '0';
          r.style.transform = 'translateY(-6px)';
        } else if (Math.abs(b - top) > 1) {
          r.style.transition = 'none';
          r.style.transform = 'translateY(' + (b - top) + 'px)';
        } else return;
        r.getBoundingClientRect();
        r.style.transition = '';
        r.style.transform = '';
        r.style.opacity = '';
      });
    }

    // How strongly the must strip breathes: still before 5 PM, then
    // stronger toward midnight; full when a must-do is late (as on the TV).
    function pulse(s) {
      if (!s.mustToday.length) return 0;
      if (s.late) return 0.55;
      var d = new Date(), mins = d.getHours() * 60 + d.getMinutes(), from = 17 * 60;
      if (mins < from) return 0;
      return Math.round((0.15 + 0.4 * Math.min(1, (mins - from) / (24 * 60 - 1 - from))) * 100) / 100;
    }

    function render() {
      var st = ctx.status();
      var data = ctx.data();
      var now = today();
      var s = sections(items(), now);
      var before = {};
      Object.keys(rows).forEach(function (id) { if (rows[id].parentNode) before[id] = rows[id].getBoundingClientRect().top; });
      if (openId && !items().some(function (i) { return i.id === openId; })) openId = null;

      var left = s.must.length + s.optional.length;
      big.textContent = data ? String(left) : '–';
      bigWord.textContent = T('todo.touch.toDo', 'to do');
      doneMeta.textContent = s.done.length ? T('todo.metaDone', '{n} done today').replace('{n}', String(s.done.length)) : '';

      var m = s.mustToday.length;
      alert.style.display = m ? '' : 'none';
      if (m) {
        alertText.textContent = (m === 1 ? T('todo.alertOne', '{n} must-do today: {t}') : T('todo.alertMany', '{n} must-dos today: {t}'))
          .replace('{n}', String(m)).replace('{t}', shownTitle(s.mustToday[0]));
        var p = ctx.reduced() ? 0 : pulse(s);
        glow.style.opacity = String(p);
        glow.style.display = p > 0 ? '' : 'none';
        alert.className = 'tx-alert' + (s.late ? ' is-late' : '');
      }

      var msg = failMsg || (st === 'offline' ? T('todo.touch.offline', 'Can’t reach the hub. Showing the last list; changes won’t save.') : '');
      banner.textContent = msg;
      banner.className = 'tx-banner' + (msg ? ' is-on' : '');
      view.className = 'tx' + (st === 'offline' ? ' is-offline' : '');

      var keep = {};
      lists.innerHTML = '';
      function mark(list) { list.forEach(function (i) { keep[i.id] = 1; }); }
      if (s.must.length) { group('is-must', word('must'), s.must, now); mark(s.must); }
      if (s.optional.length) { group('is-optional', word('optional'), s.optional, now); mark(s.optional); }
      if (s.coming.length || s.later.length) {
        var laterBox = null;
        if (s.later.length) {
          laterBox = el('div', 'tx-later');
          var lb = el('button', 'tx-later-btn' + (showLater ? ' is-open' : ''));
          lb.type = 'button';
          lb.setAttribute('aria-expanded', showLater ? 'true' : 'false');
          lb.appendChild(el('span', '', T('todo.touch.later', 'Later · {n}', { n: s.later.length })));
          lb.appendChild(icon('chevron'));
          lb.addEventListener('click', function () { showLater = !showLater; render(); });
          laterBox.appendChild(lb);
          if (showLater) {
            var lu = el('ul', 'tx-list tx-list-later');
            s.later.forEach(function (it) { lu.appendChild(row(it, now)); });
            laterBox.appendChild(lu);
            mark(s.later);
          }
        }
        group('is-passive', word('passive'), s.coming, now, laterBox);
        mark(s.coming);
      }
      if (s.done.length) { group('is-done', T('todo.sections.done', 'Completed'), s.done, now); mark(s.done); }
      Object.keys(rows).forEach(function (id) { if (!keep[id]) delete rows[id]; });
      popId = null;

      empty.innerHTML = '';
      if (!data) {
        if (st !== 'offline') empty.appendChild(el('p', 'tx-empty-text', T('todo.touch.loading', 'Loading the list…')));
      } else if (!left) {
        empty.appendChild(icon('list', 'tx-empty-ic'));
        empty.appendChild(el('p', 'tx-empty-title', T('todo.allClear', 'All clear for now')));
        if (!s.done.length && !s.coming.length) empty.appendChild(el('p', 'tx-empty-text', T('todo.touch.emptyText', 'Add one above. Calendar events that start with TODO: show up here too.')));
      }
      empty.style.display = empty.childNodes.length ? '' : 'none';
      // The empty note sits under the head, before the lists.
      if (empty.style.display !== 'none') view.insertBefore(empty, lists);
      flip(before);
    }

    render();
    // Day changes ("Yesterday", the 5 PM pulse) without a new list.
    dayTimer = setInterval(render, 60000);
    return {
      update: render,
      destroy: function () {
        if (toastTimer) clearTimeout(toastTimer);
        if (dayTimer) clearInterval(dayTimer);
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  // The menu's line: '2 must today', '5 to do' or 'All clear'.
  function summary(data, t) {
    if (!data || !data.items) return '';
    var s = sections(data.items, dayOf(new Date()));
    if (s.mustToday.length) return t('todo.touch.summaryMust', '{n} must today', { n: s.mustToday.length });
    var n = s.must.length + s.optional.length;
    return n ? t('todo.touch.summary', '{n} to do', { n: n }) : t('todo.touch.summaryClear', 'All clear');
  }

  (root.HUB_WIDGETS = root.HUB_WIDGETS || []).push({
    id: 'todo',
    titleKey: 'todo.title',
    title: 'To-do',
    touchIcon: PATHS.list,
    resource: 'todo',
    opsPath: '/touch/todo/ops',
    summary: summary,
    renderTouch: renderTouch
  });
})(typeof window !== 'undefined' ? window : this);
