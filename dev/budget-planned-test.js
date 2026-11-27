/*
 * Budget lab's planned buys on the TV (app/widgets/budget-planned.js):
 * node dev/budget-planned-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/ and a stand-in budget app (the list's only home), with the clock at
 * the real now and every date relative to today. Checks:
 *   - the list at full screen in the reading column, in the owner's order;
 *     the state lines (a day, no date, after card day, overdue, bought at a
 *     shop); the Add row;
 *   - with the remote: Down from the cap reaches the list, OK on Add opens
 *     the form, typing the label, Left/Right on the amount and the date,
 *     Save sends it to the budget app and its list shows at once;
 *   - OK on a row opens it filled in; Back leaves the form, not the lab;
 *     Remove needs OK twice; a bought buy says which charge and offers
 *     "Not this charge"; OK on the date clears it;
 *   - a budget app that refuses: its reason in a toast, the form stays;
 *   - Guest mode: amounts blurred, no row takes focus, no Add row;
 *   - Spanish, and Spanish 25% longer: nothing clipped, accents whole.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const H = require('./awws-harness');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

const AT = Date.now();
// The dates are the TV's own (Chicago, as the harness sets it), from today.
function chicagoToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: H.sample.TZ }).format(new Date(AT)); }
function day(offset) {
  const t = Date.parse(chicagoToday() + 'T12:00:00Z') + offset * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const LAYOUT = [{ widget: 'budget-lab', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-room', x: 4, y: 0, w: 4, h: 3 }];

function snapshot(items) {
  const sentAt = new Date(AT - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const t = new Date(Date.parse(chicagoToday() + 'T12:00:00Z'));
  return {
    v: 1, sentAt: sentAt,
    lab: { room: 1400, spentToday: 20, daysLeft: 10, cardDate: day(10), monthDay: t.getUTCDate() },
    planned: { items: items }
  };
}

function fakeBudgetApp(env) {
  const app = { seen: [], refuse: false, items: [
    { id: 'a0000001', label: 'Gift for Sam', amount: 40, date: day(-2), match: null, state: 'overdue' },
    { id: 'a0000002', label: 'Concert tickets', amount: 85, date: day(2), match: null, state: 'upcoming' },
    { id: 'a0000003', label: 'Winter boots', amount: 120, date: day(6), match: 'zappos', state: 'upcoming' },
    { id: 'a0000004', label: 'Desk lamp', amount: 35, date: day(-4), match: 'Lamp Shop', state: 'matched', matchedDate: day(-3), matchedAmount: 34.5 },
    { id: 'a0000005', label: 'Sofa', amount: 900, date: day(20), match: null, state: 'later' },
    { id: 'a0000006', label: 'Haircut', amount: 30, date: null, match: null, state: 'upcoming' }
  ], next: 7 };
  app.srv = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', async () => {
      const body = text ? JSON.parse(text) : null;
      app.seen.push({ method: req.method, url: req.url, body: body });
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (app.refuse) return send(400, { error: 'that date is too far off' });
      const m = /^\/api\/planned(?:\/([^/]+))?(\/unmatch)?$/.exec(req.url);
      let code = 200;
      const plain = (i) => { const o = Object.assign({}, i, { state: 'upcoming' }); delete o.matchedDate; delete o.matchedAmount; return o; };
      if (req.method === 'POST' && m[2]) app.items = app.items.map((i) => (i.id === m[1] ? plain(i) : i));
      else if (req.method === 'POST') { app.items.push(Object.assign({ id: 'a000000' + app.next++, date: null, match: null, state: 'upcoming' }, body)); code = 201; }
      else if (req.method === 'PUT') app.items = app.items.map((i) => (i.id === m[1] ? Object.assign({}, i, body) : i));
      else if (req.method === 'DELETE') app.items = app.items.filter((i) => i.id !== m[1]);
      send(code, { asOf: new Date().toISOString(), cardDay: day(10), items: app.items });
    });
  });
  return new Promise((resolve) => app.srv.listen(0, '127.0.0.1', () => { app.port = app.srv.address().port; resolve(app); }));
}

// What the section shows: each row's label, amount, state line and classes.
function rows(page) {
  return page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bp-row'), (r) => ({
    label: (r.querySelector('.bp-label') || r.querySelector('.bp-add-text') || {}).textContent,
    amount: (r.querySelector('.bp-amount') || {}).textContent,
    when: (r.querySelector('.bp-when') || {}).textContent,
    cls: r.className
  })));
}
function focusedKey(page) {
  return page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') : null; });
}
async function focusTo(page, key, dir, max) {
  for (let i = 0; i < (max || 12); i++) {
    if ((await focusedKey(page)) === key) return;
    await H.key(page, dir || 'ArrowDown');
  }
  throw new Error('focus never reached ' + key + ' (at ' + (await focusedKey(page)) + ')');
}

// Text that spills out of its box (clipped), anywhere in the section.
function clipped(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#panel .bp-sec *').forEach((n) => {
      if (!n.childNodes.length || n.tagName === 'INPUT') return;
      const cs = getComputedStyle(n);
      if (cs.overflow === 'hidden' && (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)) out.push(n.className);
      const box = n.closest('.bp-sec').getBoundingClientRect();
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(n.className + ' outside');
    });
    return out;
  });
}

async function main() {
  const env0 = {};
  const app = await fakeBudgetApp(env0);
  const env = await H.start({ at: AT, snapshot: false, calendars: false, budgetApp: { url: 'http://127.0.0.1:' + app.port, token: 'budget-app-token' } });
  try {
    await env.setBudget(snapshot(app.items));
    let page = await env.newPage({ layout: LAYOUT, storage: { 'homeHub.budget.seen.v1': '[]' } });
    try {
      await H.sleep(800);
      await H.openPanel(page, 'budget-lab');
      if (await page.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page);

      await check('list: in the reading column, the owner\'s order, state lines, Add last', async () => {
        const r = await rows(page);
        assert.deepStrictEqual(r.map((x) => x.label), ['Gift for Sam', 'Concert tickets', 'Winter boots', 'Desk lamp', 'Sofa', 'Haircut', 'Add a planned buy']);
        assert.strictEqual(r[0].amount, '$40');
        assert.ok(/overdue$/.test(r[0].when) && /is-over/.test(r[0].cls), JSON.stringify(r[0]));
        assert.ok(/ · in 2 days$/.test(r[1].when), r[1].when);
        assert.ok(/^Bought .* at Lamp Shop · \$34\.50$/.test(r[3].when) && /is-bought/.test(r[3].cls), r[3].when);
        assert.ok(/ · after card day$/.test(r[4].when), r[4].when);
        assert.strictEqual(r[5].when, 'No date');
        const col = await page.evaluate(() => {
          const sec = document.querySelector('#panel .bp-sec');
          const cols = document.querySelectorAll('#panel .bu-pcol');
          return { inRight: cols.length === 2 && cols[1].contains(sec), head: sec.querySelector('.bu-label').textContent };
        });
        assert.ok(col.inRight, 'in the right column');
        assert.strictEqual(col.head, 'Planned buys');
      });

      await check('add with the remote: Down reaches the list, OK on Add, type, amount and date with the arrows, Save', async () => {
        await focusTo(page, 'planned-add');
        await H.key(page, 'Enter');
        await H.sleep(300);
        assert.strictEqual(await focusedKey(page), 'planned-what');
        await H.key(page, 'Enter'); // OK starts typing
        await page.keyboard.type('Rain jacket');
        // Down while typing stops it and moves on (the page's clock stands
        // still here, so an OK right after Done would read as the keyboard's
        // stray Enter).
        await H.key(page, 'ArrowDown');
        await H.sleep(150);
        assert.strictEqual(await focusedKey(page), 'planned-shop');
        await H.key(page, 'Enter');
        await page.keyboard.type('REI');
        await H.key(page, 'ArrowDown');
        await H.sleep(150);
        assert.strictEqual(await focusedKey(page), 'planned-amount');
        await H.key(page, 'ArrowRight', 3);
        await H.key(page, 'ArrowLeft');
        await H.key(page, 'ArrowDown');
        assert.strictEqual(await focusedKey(page), 'planned-date');
        await H.key(page, 'ArrowRight');
        const form = await page.evaluate(() => window.HUB_BUDGET_PLANNED.form());
        assert.deepStrictEqual([form.label, form.match, form.amount, form.date], ['Rain jacket', 'REI', 2, day(8)]);
        await H.key(page, 'ArrowDown');
        assert.strictEqual(await focusedKey(page), 'planned-save');
        await H.key(page, 'Enter');
        try {
          await H.until(async () => (await rows(page)).some((x) => x.label === 'Rain jacket'), 5000, 'the new buy never showed');
        } catch (e) {
          throw new Error(e.message + ' (seen ' + JSON.stringify(app.seen) + ', toast ' + (await page.evaluate(() => document.getElementById('toast').textContent)) + ', errors ' + JSON.stringify(page.ctx.errors) + ')');
        }
        const last = app.seen[app.seen.length - 1];
        assert.deepStrictEqual(last, { method: 'POST', url: '/api/planned', body: { label: 'Rain jacket', amount: 2, date: day(8), match: 'REI' } });
        assert.strictEqual(await page.evaluate(() => window.HUB_BUDGET_PLANNED.editing()), false);
      });

      await check('edit: OK on a row opens it filled in; Back leaves the form and keeps the lab open', async () => {
        await focusTo(page, 'planned-a0000003', 'ArrowUp');
        await H.key(page, 'Enter');
        await H.sleep(300);
        const form = await page.evaluate(() => window.HUB_BUDGET_PLANNED.form());
        assert.deepStrictEqual([form.id, form.label, form.match, form.amount, form.date], ['a0000003', 'Winter boots', 'zappos', 120, day(6)]);
        assert.strictEqual(await page.evaluate(() => document.querySelector('#panel .bp-sec .bu-label').textContent), 'Planned buy');
        await H.key(page, 'Escape');
        await H.sleep(300);
        assert.strictEqual(await page.evaluate(() => window.HUB_TEST.open()), 'budget-lab');
        assert.strictEqual(await page.evaluate(() => window.HUB_BUDGET_PLANNED.editing()), false);
        assert.strictEqual(await focusedKey(page), 'planned-a0000003');
      });

      await check('OK on the date clears it; Save sends date null', async () => {
        await focusTo(page, 'planned-a0000002', 'ArrowUp');
        await H.key(page, 'Enter');
        await H.sleep(300);
        await focusTo(page, 'planned-date');
        await H.key(page, 'Enter');
        assert.strictEqual(await page.evaluate(() => document.querySelector('#panel .bp-dtext').textContent), 'No date');
        await H.key(page, 'ArrowDown');
        await H.key(page, 'Enter');
        await H.until(async () => (await rows(page)).some((x) => x.label === 'Concert tickets' && x.when === 'No date'), 5000, 'not cleared');
        assert.deepStrictEqual(app.seen[app.seen.length - 1], { method: 'PUT', url: '/api/planned/a0000002', body: { label: 'Concert tickets', amount: 85, date: null, match: null } });
      });

      await check('a refusal: the budget app\'s reason in a toast, the form stays open', async () => {
        await focusTo(page, 'planned-a0000003', 'ArrowDown');
        await H.key(page, 'Enter');
        await H.sleep(300);
        await focusTo(page, 'planned-save');
        app.refuse = true;
        await H.key(page, 'Enter');
        await H.until(() => page.evaluate(() => /too far off/.test(document.getElementById('toast').textContent)), 5000, 'no toast');
        assert.strictEqual(await page.evaluate(() => window.HUB_BUDGET_PLANNED.editing()), true);
        app.refuse = false;
      });

      await check('remove: Right to Remove, OK arms it, OK again removes it from the budget app', async () => {
        await focusTo(page, 'planned-save');
        await H.key(page, 'ArrowRight');
        assert.strictEqual(await focusedKey(page), 'planned-remove');
        await H.key(page, 'Enter');
        await H.sleep(200);
        assert.strictEqual(await page.evaluate(() => document.querySelector('#panel .bp-btn.is-remove').textContent), 'OK again to remove');
        assert.strictEqual(await focusedKey(page), 'planned-remove');
        await H.key(page, 'Enter');
        await H.until(async () => !(await rows(page)).some((x) => x.label === 'Winter boots'), 5000, 'still listed');
        assert.deepStrictEqual(app.seen[app.seen.length - 1], { method: 'DELETE', url: '/api/planned/a0000003', body: null });
      });

      await check('a bought buy says which charge, and "Not this charge" asks the budget app to look again', async () => {
        await focusTo(page, 'planned-a0000004', 'ArrowUp');
        await H.key(page, 'Enter');
        await H.sleep(300);
        const f = await page.evaluate(() => ({
          btns: Array.prototype.map.call(document.querySelectorAll('#panel .bp-btn'), (b) => b.textContent),
          note: document.querySelector('#panel .bp-note').textContent,
          amount: document.querySelector('#panel .bp-ainput').value
        }));
        assert.deepStrictEqual(f.btns, ['Save', 'Not this charge', 'Remove', 'Cancel']);
        assert.ok(/at Lamp Shop · \$34\.50\. It stays out of your daily goal\.$/.test(f.note), f.note);
        assert.strictEqual(f.amount, '35');
        await focusTo(page, 'planned-save');
        await H.key(page, 'ArrowRight');
        assert.strictEqual(await focusedKey(page), 'planned-unmatch');
        await H.key(page, 'Enter');
        await H.until(async () => (await rows(page)).some((x) => x.label === 'Desk lamp' && !/is-bought/.test(x.cls)), 5000, 'still matched');
        assert.deepStrictEqual(app.seen[app.seen.length - 1], { method: 'POST', url: '/api/planned/a0000004/unmatch', body: null });
      });

      await check('guest mode: amounts blurred, no row takes focus, no Add row', async () => {
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(600);
        const g = await page.evaluate(() => ({
          amounts: Array.prototype.map.call(document.querySelectorAll('#panel .bp-amount'), (a) => a.textContent),
          blurs: document.querySelectorAll('#panel .bp-amount .guest-blur').length,
          rowsF: document.querySelectorAll('#panel .bp-row.f').length,
          add: document.querySelectorAll('#panel .bp-add').length,
          rows: document.querySelectorAll('#panel .bp-row').length
        }));
        assert.ok(g.rows >= 3, 'rows still listed');
        assert.strictEqual(g.blurs, g.rows);
        assert.ok(g.amounts.every((t) => !/\d/.test(t)), JSON.stringify(g.amounts));
        assert.strictEqual(g.rowsF, 0);
        assert.strictEqual(g.add, 0);
        await page.evaluate(() => window.HUB_GUEST.set(false));
        await H.sleep(300);
      });

      assert.deepStrictEqual(H.errorsOf(page, true), []);
    } finally { await page.ctx.close(); }

    for (const longer of [false, true]) {
      const page2 = await env.newPage({ layout: LAYOUT, lang: 'es', storage: { 'homeHub.lang': 'es', 'homeHub.budget.seen.v1': '[]' },
        config: longer ? function () {
          // Every planned buy string 25% longer, with accents.
          const t = window.HUB_I18N;
          const orig = t.localize;
          t.localize = function (en, prefix, l) {
            const out = orig.call(t, en, prefix, l);
            if (prefix !== 'budgetPlanned') return out;
            Object.keys(out).forEach((k) => { if (typeof out[k] === 'string' && out[k].length > 3 && !/\{/.test(out[k])) out[k] = out[k] + ' ÁÉñ' + out[k].slice(0, Math.ceil(out[k].length / 4)); });
            return out;
          };
        } : undefined });
      try {
        await H.sleep(800);
        await H.openPanel(page2, 'budget-lab');
        if (await page2.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page2);
        await check('Spanish' + (longer ? ' 25% longer' : '') + ': the list and the form, nothing clipped, accents whole', async () => {
          const head = await page2.evaluate(() => document.querySelector('#panel .bp-sec .bu-label').textContent);
          assert.ok(/^Compras previstas/.test(head), head);
          assert.deepStrictEqual(await clipped(page2), []);
          await focusTo(page2, 'planned-add');
          await H.key(page2, 'Enter');
          await H.sleep(300);
          assert.ok(/^Nueva compra prevista/.test(await page2.evaluate(() => document.querySelector('#panel .bp-sec .bu-label').textContent)));
          assert.deepStrictEqual(await clipped(page2), []);
          const lh = await page2.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bp-sec .bp-fname, #panel .bp-btn, #panel .bp-dtext'), (n) => parseFloat(getComputedStyle(n).lineHeight) / parseFloat(getComputedStyle(n).fontSize)));
          assert.ok(lh.every((x) => x >= 1.25), JSON.stringify(lh));
        });
      } finally { await page2.ctx.close(); }
    }
  } finally {
    await env.stop();
    app.srv.close();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
