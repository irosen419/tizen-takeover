/*
 * The A World Worth Saving tiles, end to end: node dev/awws-test.js
 *
 * Runs the real hub in headless Chromium against the preview (dev/preview.js)
 * and the real hub server from pi/ (its clock set to Monday 16 November 2026,
 * 10:40 AM in Chicago, see dev/awws-pi.js), with the sample calendars and
 * snapshot from dev/awws-sample.js sent the way a sync sends them (POST /api/awws)
 * (POST /api/awws). Checks:
 *   every AWWS widget at every size, in English and in Spanish: no console
 *   errors, never blank, nothing clipped, no type under 0.85rem on a tile or
 *   1rem in a panel, line height 1.25 or more wherever text is cut;
 *   a Family event never shows; the countdown across midnight in Chicago;
 *   overdue in amber; partial data (calendar only, snapshot only, neither);
 *   an old Pi with no awws resource; a malformed snapshot; a repeated
 *   snapshot that doesn't redraw; the launcher, a view and Back; the owner
 *   filter with Left and Right; full screen; the layout switcher with five
 *   layouts, to AWWS desk and back.
 * Needs Playwright. Prints one line per check and "N passed, M failed";
 * exits 1 on a failure. Nothing here reaches the internet.
 */
'use strict';

const H = require('./awws-harness');

const REAL = ['awws', 'awws-visits', 'awws-agenda', 'awws-todo'];
const PLACEHOLDERS = ['awws-outreach', 'awws-pipeline', 'awws-money', 'awws-reach'];
const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 4], [6, 4], [9, 6]];
const DESK = [
  { widget: 'awws-visits', x: 0, y: 0, w: 3, h: 2 }, { widget: 'awws-agenda', x: 3, y: 0, w: 6, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'awws-todo', x: 0, y: 2, w: 4, h: 4 },
  { widget: 'calendar', x: 4, y: 2, w: 5, h: 4 }, { widget: 'today', x: 9, y: 2, w: 3, h: 1 },
  { widget: 'awws', x: 9, y: 3, w: 3, h: 3 }
];

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e));
  }
}

function assert(ok, text) { if (!ok) throw new Error(text); }

function noErrors(page, allowNetwork) {
  const errs = H.errorsOf(page, allowNetwork);
  assert(!errs.length, 'console: ' + errs.join(' | '));
}

// Packs tiles of one size into pages of the 12 x 6 grid.
function pages(ids, w, h) {
  const out = [];
  let list = [];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    if (x + w > 12) { x = 0; y += h; }
    if (y + h > 6) { out.push(list); list = []; x = 0; y = 0; }
    list.push({ widget: id, x: x, y: y, w: w, h: h });
    x += w;
  }
  if (list.length) out.push(list);
  return out;
}

/*
 * In the page: every element with text of its own, under the roots, for
 * type size, line height, text cut without an ellipsis, and text pushed out
 * of a box that hides overflow. Scrolling boxes (a panel's list) are fine.
 */
function inspect(args) {
  const sel = args[0];
  const minRem = args[1];
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const out = [];
  const roots = document.querySelectorAll(sel);
  function cuts(cs) { return cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none'); }
  function hides(cs) { return cs.overflowX === 'hidden' || cs.overflowY === 'hidden'; }
  // The hub's panel body scrolls by script, to the focused row.
  function scrolls(cs, el) { return /auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflowX) || el.classList.contains('panel-body'); }
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (const el of all) {
      let txt = '';
      for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent;
      txt = txt.trim();
      if (!txt) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;            // not shown
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const label = '"' + txt.slice(0, 28) + '"';
      const fs = parseFloat(cs.fontSize);
      if (fs < minRem * rem - 0.05) out.push((fs / rem).toFixed(2) + 'rem type: ' + label);
      if (hides(cs) || cuts(cs)) {
        const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / fs;
        if (lh < 1.245) out.push('line height ' + lh.toFixed(2) + ': ' + label);
        if (!cuts(cs) && cs.display !== 'inline' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
          out.push('cut without an ellipsis: ' + label);
        }
      }
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (scrolls(acs, a)) break;
        if (!hides(acs) || cuts(acs)) continue;
        const ar = a.getBoundingClientRect();
        if (r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1) {
          out.push('clipped by .' + String(a.className).split(' ').join('.') + ': ' + label);
          break;
        }
      }
    }
  }
  return out;
}

async function tileProblems(page) {
  return page.evaluate(inspect, ['.cell[data-widget^="awws"] .tile-body', 0.85]);
}

async function panelProblems(page) {
  return page.evaluate(inspect, ['#panel .panel-body', 1]);
}

async function blankTiles(page) {
  return page.evaluate(() => {
    const out = [];
    const cells = document.querySelectorAll('.cell[data-widget^="awws"]');
    for (let i = 0; i < cells.length; i++) {
      const body = cells[i].querySelector('.tile-body');
      if (!body || !body.textContent.trim()) out.push(cells[i].getAttribute('data-widget'));
    }
    return out;
  });
}

function text(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => n.textContent).join(' | '), sel);
}

async function main() {
  let env = await H.start({});
  try {
    /* ---------- every widget at every size ---------- */
    for (const es of [false, true]) {
      const lang = es ? 'Spanish' : 'English';
      for (const size of SIZES) {
        const w = size[0];
        const h = size[1];
        const ids = w === 9 ? ['awws'] : REAL.concat(PLACEHOLDERS);
        const sheets = pages(ids, w, h);
        await check(lang + ': every AWWS widget at ' + w + ' x ' + h, async () => {
          for (const sheet of sheets) {
            const page = await env.newPage({ layout: sheet, spanish: es });
            try {
              const blank = await blankTiles(page);
              assert(!blank.length, 'blank: ' + blank.join(', '));
              const p = await tileProblems(page);
              assert(!p.length, p.slice(0, 6).join('; '));
              const fam = await text(page, '.cell[data-widget^="awws"] .tile-body');
              assert(fam.indexOf('Family') < 0, 'a Family event shows: ' + fam.slice(0, 120));
              noErrors(page);
            } finally { await page.ctx.close(); }
          }
        });
      }
    }

    /* ---------- the panels, their views, full screen ---------- */
    for (const es of [false, true]) {
      const lang = es ? 'Spanish' : 'English';
      await check(lang + ': the Glance launcher opens a view, and Back returns to it', async () => {
        const page = await env.newPage({ layout: DESK, spanish: es });
        try {
          await H.openPanel(page, 'awws');
          const rows = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .aw-lrow.f'), (n) => n.getAttribute('data-key')));
          assert(rows.join() === 'go-visits,go-agenda,go-todo', 'launcher rows: ' + rows.join());
          const money = await text(page, '#panel .aw-lrow');
          assert(!/Money|Dinero/.test(money), 'Money shows with showMoney false');
          let p = await panelProblems(page);
          assert(!p.length, 'launcher: ' + p.slice(0, 4).join('; '));
          await H.key(page, 'ArrowDown');
          await H.key(page, 'Enter');
          await H.idle(page);
          assert(await page.evaluate(() => !!document.querySelector('#panel .aw-pview-agenda .aw-arow')), 'This week did not open');
          p = await panelProblems(page);
          assert(!p.length, 'this week: ' + p.slice(0, 4).join('; '));
          const fam = await text(page, '#panel .panel-body');
          assert(fam.indexOf('Family') < 0, 'a Family event shows in This week');
          await H.key(page, 'Escape');
          await H.idle(page);
          const back = await page.evaluate(() => {
            const f = document.querySelector('#panel .is-focused');
            return { open: window.HUB_TEST.open(), focus: f && f.getAttribute('data-key') };
          });
          assert(back.open === 'awws' && back.focus === 'go-agenda', 'after Back: ' + JSON.stringify(back));
          await H.key(page, 'Escape');
          await H.idle(page);
          assert(await page.evaluate(() => window.HUB_TEST.open() === null), 'a second Back did not close the panel');
          noErrors(page);
        } finally { await page.ctx.close(); }
      });

      await check(lang + ': the to-do filter moves with Left and Right', async () => {
        const page = await env.newPage({ layout: DESK, spanish: es });
        try {
          await H.openPanel(page, 'awws-todo');
          const on = () => page.evaluate(() => (document.querySelector('#panel .aw-filter.is-on') || {}).textContent);
          const S = await page.evaluate(() => window.HUB_AWWS_TEST.STRINGS);
          assert(await on() === S.filters.all, 'starts on ' + await on());
          await H.key(page, 'ArrowRight');
          await H.idle(page);
          assert(await on() === S.filters.ian, 'Right gave ' + await on());
          const owners = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .aw-chip'), (n) => n.textContent));
          assert(owners.every((o) => o === S.owners.ian || o === S.ownersShort.ian), 'other owners under Ian: ' + owners.join());
          await H.key(page, 'ArrowRight', 2);
          await H.idle(page);
          assert(await on() === S.filters.both, 'two more Rights gave ' + await on());
          await H.key(page, 'ArrowRight');
          await H.idle(page);
          assert(await on() === S.filters.both, 'Right past the end moved to ' + await on());
          await H.key(page, 'ArrowLeft', 3);
          await H.idle(page);
          assert(await on() === S.filters.all, 'three Lefts gave ' + await on());
          const p = await panelProblems(page);
          assert(!p.length, p.slice(0, 4).join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      });

      await check(lang + ': full screen for each view fits', async () => {
        const page = await env.newPage({ layout: DESK, spanish: es });
        try {
          for (const id of REAL) {
            await H.openPanel(page, id);
            await H.fullScreen(page);
            const p = await panelProblems(page);
            assert(!p.length, id + ': ' + p.slice(0, 4).join('; '));
            const fam = await text(page, '#panel .panel-body');
            assert(fam.indexOf('Family') < 0, 'a Family event shows in ' + id);
            await H.key(page, 'Escape');
            await H.idle(page);
            if (await page.evaluate(() => window.HUB_TEST.open() !== null)) { await H.key(page, 'Escape'); await H.idle(page); }
          }
          noErrors(page);
        } finally { await page.ctx.close(); }
      });
    }

    /* ---------- time ---------- */
    await check('the countdown says 15 days on Monday morning', async () => {
      const page = await env.newPage({ layout: DESK });
      try {
        const t = await text(page, '.cell[data-widget="awws-visits"] .aw-hero');
        assert(/^15\s*days/.test(t.trim()), 'hero: ' + t);
      } finally { await page.ctx.close(); }
    });

    for (const zone of ['America/Chicago', 'Asia/Tokyo']) {
      await check('across midnight in Chicago (TV set to ' + zone + '): Tomorrow, then Today', async () => {
        // 11:50 PM on Monday 30 November in Chicago; the visit is 12:15 PM on the 1st.
        const page = await env.newPage({ layout: DESK, at: Date.parse('2026-12-01T05:50:00Z'), tvZone: zone });
        try {
          const hero = () => text(page, '.cell[data-widget="awws-visits"] .aw-hero');
          assert(/Tomorrow/.test(await hero()), 'before midnight: ' + await hero());
          await page.clock.setFixedTime(new Date(Date.parse('2026-12-01T06:10:00Z')));
          await page.evaluate(() => window.HUB_AWWS_TEST.refresh());
          assert(/Today/.test(await hero()), 'after midnight: ' + await hero());
          noErrors(page, true);
        } finally { await page.ctx.close(); }
      });
    }

    await check('overdue items are amber', async () => {
      const page = await env.newPage({ layout: DESK });
      try {
        const c = await page.evaluate(() => {
          const n = document.querySelector('.cell[data-widget="awws-todo"] .aw-meta-part.is-late, .cell[data-widget="awws-todo"] .aw-late-count');
          const plain = document.querySelector('.cell[data-widget="awws-todo"] .aw-trow-title');
          return n && plain ? [getComputedStyle(n).color, getComputedStyle(plain).color, n.textContent] : null;
        });
        assert(c, 'no overdue mark on the to-do tile');
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c[0]);
        assert(m && +m[1] > 200 && +m[1] > +m[2] && +m[2] > +m[3] + 40, 'not amber: ' + c[0] + ' on ' + c[2]);
        assert(c[0] !== c[1], 'same color as a plain title');
      } finally { await page.ctx.close(); }
    });

    /* ---------- the snapshot arriving again ---------- */
    await check('the same snapshot sent again does not redraw; a change does', async () => {
      const page = await env.newPage({ layout: DESK });
      try {
        const before = await page.evaluate(() => window.HUB_AWWS_TEST.redraws());
        const snap = H.sample.snapshot();
        snap.sentAt = new Date(H.MONDAY - 30000).toISOString().replace(/\.\d+Z$/, 'Z');
        await env.setSnapshot(snap);
        await H.until(() => page.evaluate((s) => (window.HUB_LIVE.get('awws') || {}).sentAt === s, snap.sentAt), 5000, 'the new copy did not arrive');
        await H.sleep(300);
        const same = await page.evaluate(() => window.HUB_AWWS_TEST.redraws());
        assert(same === before, 'redrew ' + (same - before) + ' times for the same contents');
        snap.todos.items[0].title = 'Print 31 activity sheets';
        await env.setSnapshot(snap);
        await H.until(async () => (await text(page, '.cell[data-widget="awws-todo"]')).indexOf('Print 31') >= 0, 5000, 'the change did not show');
        await env.setSnapshot(H.sample.snapshot());
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    /* ---------- an old Pi, and a malformed snapshot ---------- */
    await check('an old Pi with no awws resource: Not synced yet, nothing blank', async () => {
      const page = await env.newPage({ layout: DESK, route: (ctx) => ctx.route(/\/live\/(state|poll)/, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        if (body && body.resources) delete body.resources.awws;
        await route.fulfill({ response: res, json: body });
      }) });
      try {
        const t = await text(page, '.cell[data-widget="awws-todo"] .tile-body');
        assert(/Not synced yet/.test(t), 'to-do tile: ' + t);
        const v = await text(page, '.cell[data-widget="awws-visits"] .aw-hero');
        assert(/15/.test(v), 'the visits should still come from the calendar: ' + v);
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    const BAD = [
      { v: 1, sentAt: '2026-11-16T15:10:00Z', todos: 'nope', outreach: [1, 2], pipeline: { items: 'x' }, khaya: { total: 'a' } },
      { v: 1, sentAt: '2026-11-16T15:10:00Z', todos: { items: [null, 5, { title: { a: 1 }, owner: 'ian', section: 'now' }, { title: 'x', owner: 'nobody', section: 'now' }],
        totals: { ian: 'many' } }, handoffs: { open: -3, blocked: null }, reach: { visits: 7 } },
      { v: 1, sentAt: 'yesterday', todos: { items: [{ id: 1, title: 'A '.repeat(400), owner: 'IAN', section: 'NOW', due: 7, dueISO: 'soon', done: 'yes' }] } }
    ];
    for (let i = 0; i < BAD.length; i++) {
      await check('malformed snapshot ' + (i + 1) + ' does not blank a tile', async () => {
        const page = await env.newPage({ layout: DESK, route: (ctx) => ctx.route(/\/live\/(state|poll)/, async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          if (body && body.resources && body.resources.awws) body.resources.awws.data = BAD[i];
          await route.fulfill({ response: res, json: body });
        }) });
        try {
          assert(!(await blankTiles(page)).length, 'a blank tile');
          await H.openPanel(page, 'awws-todo');
          assert(await page.evaluate(() => document.querySelector('#panel .panel-body').textContent.trim().length > 0), 'a blank panel');
          noErrors(page);
        } finally { await page.ctx.close(); }
      });
    }

    await check('a broken cache on the TV does not blank a tile', async () => {
      const page = await env.newPage({ layout: DESK, live: 'off', storage: { 'homeHub.awws.v1': '{"v":1,"snap":[', 'homeHub.calendar.v1': '7' } });
      try {
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page, true);
      } finally { await page.ctx.close(); }
    });

    /* ---------- the layout switcher ---------- */
    await check('the switcher shows five layouts; to AWWS desk and back', async () => {
      const page = await env.newPage({});
      try {
        const start = await page.evaluate(() => document.querySelectorAll('.cell').length);
        // Up from the top-left tile drops the bar.
        const openSwitcher = async () => {
          await H.focusTile(page, await page.evaluate(() => {
            let best = null;
            document.querySelectorAll('#grid .cell').forEach((c) => {
              const r = c.getBoundingClientRect();
              if (!best || r.top < best.t - 2 || (Math.abs(r.top - best.t) <= 2 && r.left < best.l)) best = { t: r.top, l: r.left, id: c.getAttribute('data-widget') };
            });
            return best.id;
          }));
          await H.key(page, 'ArrowUp');
          await H.until(() => page.evaluate(() => document.querySelectorAll('.switcher-item').length > 0), 3000, 'the switcher did not open');
          await H.sleep(400);
        };
        await openSwitcher();
        const bar = await page.evaluate(() => {
          const b = document.querySelector('.switcher-bar');
          const items = Array.prototype.map.call(document.querySelectorAll('.switcher-item'), (n) => {
            const r = n.getBoundingClientRect();
            const name = n.querySelector('.switcher-name');
            return { name: n.textContent, left: r.left, right: r.right, cut: name.scrollWidth > name.clientWidth + 1 };
          });
          return { items: items, over: b.scrollWidth > b.clientWidth + 1, width: window.innerWidth,
            active: (document.querySelector('.switcher-item.is-active') || {}).textContent };
        });
        assert(bar.items.length === 5, 'layouts: ' + bar.items.map((i) => i.name).join(', '));
        assert(!bar.over, 'the bar overflows');
        for (const it of bar.items) assert(it.left >= 0 && it.right <= bar.width && !it.cut, 'pill cut: ' + it.name);
        const was = bar.active;
        const widgets = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell'), (c) => c.getAttribute('data-widget')).sort().join());
        // To AWWS desk: a different set of widgets, so the page reloads.
        const pick = async (name) => {
          for (let i = 0; i < 6; i++) {
            const f = await page.evaluate(() => (document.querySelector('.switcher-item.is-focused') || {}).textContent);
            if (f === name) break;
            await H.key(page, bar.items.findIndex((x) => x.name === name) > bar.items.findIndex((x) => x.name === f) ? 'ArrowRight' : 'ArrowLeft');
          }
          const before = await widgets();
          await H.key(page, 'Enter');
          // A different set of widgets: the page reloads, so wait for the new set.
          await H.until(async () => (await widgets()) !== before, 15000, 'the layout did not change from ' + name);
          await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
          await H.idle(page);
        };
        await pick('AWWS desk');
        const desk = await widgets();
        assert(desk === 'awws-agenda,awws-todo,awws-visits,calendar,entertainment,today,weather', 'desk: ' + desk);
        await openSwitcher();
        await pick(was);
        const back = await page.evaluate(() => document.querySelectorAll('.cell').length);
        assert(back === start, 'back on ' + was + ': ' + back + ' tiles, not ' + start);
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }

  /* ---------- partial data: other hub servers ---------- */
  env = await H.start({ snapshot: false });
  try {
    await check('calendar only (an empty Pi snapshot): visits show, the board says Not synced yet', async () => {
      const raw = await env.control('GET', '/api/awws');
      const data = raw && raw.data;
      assert(data && data.sentAt === null, 'the empty Pi should give sentAt null: ' + JSON.stringify(raw).slice(0, 120));
      const page = await env.newPage({ layout: DESK });
      try {
        assert(/15/.test(await text(page, '.cell[data-widget="awws-visits"] .aw-hero')), 'no countdown');
        assert(/Not synced yet/.test(await text(page, '.cell[data-widget="awws-todo"] .tile-body')), 'to-do tile');
        assert(/Not synced yet/.test(await text(page, '.cell[data-widget="awws"] .tile-body')), 'the Glance should say the board is missing');
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
    await check('a snapshot with sentAt but no sections: Not synced yet', async () => {
      // The Pi refuses to store one, so this one is put in on the way to the TV.
      const page = await env.newPage({ layout: DESK, route: (ctx) => ctx.route(/\/live\/(state|poll)/, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        if (body && body.resources && body.resources.awws) body.resources.awws.data = { v: 1, sentAt: '2026-11-16T15:10:00Z', receivedAt: '2026-11-16T15:10:12Z' };
        await route.fulfill({ response: res, json: body });
      }) });
      try {
        assert(/Not synced yet/.test(await text(page, '.cell[data-widget="awws-todo"] .tile-body')), 'to-do tile');
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }

  env = await H.start({ snapshot: false, calendars: false });
  try {
    await check('neither: every tile says why', async () => {
      const page = await env.newPage({ layout: DESK });
      try {
        assert(!(await blankTiles(page)).length, 'a blank tile');
        const t = await text(page, '.cell[data-widget^="awws"] .tile-body');
        assert(/Not synced yet/.test(t) && /calendar/i.test(t), 'messages: ' + t);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
    await check('snapshot only: the board shows, the visit tiles say which calendar is missing', async () => {
      await env.setSnapshot(H.sample.snapshot());
      const page = await env.newPage({ layout: DESK });
      try {
        assert(/9/.test(await text(page, '.cell[data-widget="awws-todo"] .aw-hero')), 'to-do count');
        const v = await text(page, '.cell[data-widget="awws-visits"] .tile-body');
        assert(/School Visits/.test(v), 'visits tile: ' + v);
        assert(!(await blankTiles(page)).length, 'a blank tile');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
