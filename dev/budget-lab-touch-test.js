/*
 * Budget lab's cap on the wall tablet (tablet mode, a touch screen):
 * node dev/budget-lab-touch-test.js
 *
 * Runs the real hub in headless Chromium against the real hub server from
 * pi/, with the clock at the real now and every date relative to today,
 * fingers sent as CDP touch events (as Chrome 52 gets them). Checks:
 *   - the cap shows a knob on its line, a Save button and the drag hint;
 *   - a tap on the big number, the label, the hint or a merchant row never
 *     saves (the Pi's goal file stays as it was);
 *   - a tap on the line sets the cap there ($5 steps); a drag along it
 *     scrubs it and the saved $60 mark catches it ("Saved"); a sideways drag
 *     from the big number moves it by the finger's distance; an up or down
 *     swipe leaves it alone; a tap on an arrow moves it $1;
 *   - Save right after a drag is ignored; a deliberate Save saves the cap
 *     on the slider as the daily goal and says "Saved";
 *   - Guest mode: no Save button, a drag and an arrow change nothing, OK on
 *     the remote saves nothing;
 *   - the TV (no tablet mode): no knob and no Save, Right and OK as before;
 *   - Spanish, and Spanish 25% longer: the Save button and the hint whole,
 *     accents whole, nothing outside the cap's box.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
function chicagoToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: H.sample.TZ }).format(new Date(AT)); }
function day(offset) {
  const t = Date.parse(chicagoToday() + 'T12:00:00Z') + offset * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const LAYOUT = [{ widget: 'budget-lab', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-room', x: 4, y: 0, w: 4, h: 3 }];

function snapshot() {
  const sentAt = new Date(AT - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const t = new Date(Date.parse(chicagoToday() + 'T12:00:00Z'));
  return {
    v: 1, sentAt: sentAt,
    lab: {
      room: 4000, spentToday: 20, daysLeft: 10, cardDate: day(10), monthDay: t.getUTCDate(),
      merchants: [{ label: 'DoorDash', spent: 120, count: 6 }, { label: 'Amazon', spent: 90, count: 3 }]
    },
    // The goal history reaches the lab through pace (the Pi adds pace.goals).
    pace: { asOf: sentAt, days: [-7, -6, -5, -4, -3, -2, -1].map((o) => ({ date: day(o), spent: 40 + 3 * o * o, cap: 70 })) }
  };
}

// What the cap shows now.
function cap(page) {
  return page.evaluate(() => {
    const T = window.HUB_BUDGET_LAB_TEST;
    const r = T.result();
    const save = document.querySelector('#panel .bl-save');
    return {
      cap: r && r.cap, capMax: r && r.capMax, c0: r && r.c0,
      big: (document.querySelector('#panel .bl-big') || {}).textContent,
      save: save ? { text: save.textContent, cls: save.className, shown: getComputedStyle(save).display !== 'none' } : null,
      knob: !!document.querySelector('#panel .bl-knob') && getComputedStyle(document.querySelector('#panel .bl-knob')).display !== 'none'
    };
  });
}
function rectOf(page, sel) {
  return page.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
}
function goalFile(env) {
  try { return fs.readFileSync(path.join(env.dataDir, 'budget-goal.json'), 'utf8'); } catch (e) { return ''; }
}
function lastGoal(env) {
  const h = JSON.parse(goalFile(env) || '{"history":[]}').history || [];
  return h.length ? h[h.length - 1].goal : null;
}
function toast(page) {
  return page.evaluate(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') ? t.textContent : (t ? t.textContent : ''); });
}

async function finger(cdp, pts, gap) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y }] });
  for (let i = 1; i < pts.length; i++) {
    await H.sleep(gap || 16);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pts[i].x, y: pts[i].y }] });
  }
  await H.sleep(20);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await H.sleep(120);
}
function line(a, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
  return out;
}
async function tap(cdp, x, y) { await finger(cdp, [{ x: x, y: y }]); }

async function openLab(page) {
  await H.sleep(800);
  await H.openPanel(page, 'budget-lab');
  if (await page.evaluate(() => window.HUB_TEST.mode()) !== 'full') await H.fullScreen(page);
  await H.sleep(300);
}

async function main() {
  const env = await H.start({ at: AT, snapshot: false, calendars: false, budgetGoals: [{ from: day(-20), goal: 60 }] });
  try {
    await env.setBudget(snapshot());
    let page = await env.newPage({ layout: LAYOUT, touch: true, query: 'as=tablet', storage: { 'homeHub.budget.seen.v1': '[]' } });
    try {
      await openLab(page);
      const cdp = await page.ctx.newCDPSession(page);
      const before = goalFile(env);

      await check('tablet: a knob on the line, a Save button with the cap, the drag hint', async () => {
        const c = await cap(page);
        assert.ok(c.knob, 'no knob');
        assert.ok(c.save && c.save.shown, JSON.stringify(c.save));
        assert.ok(c.capMax >= 300, 'want a wide slider, got ' + c.capMax);
        assert.strictEqual(c.save.text, 'Save $' + Math.floor(c.cap));
        const hint = await page.evaluate(() => document.querySelector('#panel .bl-hint').textContent);
        assert.ok(/^Drag along the line/.test(hint), hint);
        assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#panel .bl-hero .bl-keyhint').length), 0);
      });

      await check('tablet: taps on the number, the label, the hint and a merchant row never save', async () => {
        const c0 = await cap(page);
        for (const sel of ['#panel .bl-big', '#panel .bl-label', '#panel .bl-hint', '#panel .bl-result', '#panel .bl-cut']) {
          const r = await rectOf(page, sel);
          if (!r) { if (sel === '#panel .bl-cut') continue; throw new Error('no ' + sel); }
          await tap(cdp, r.x + r.w / 2, r.y + r.h / 2);
          await tap(cdp, r.x + r.w / 2 + 3, r.y + r.h / 2);      // a quick second tap
        }
        await H.sleep(400);
        assert.strictEqual(goalFile(env), before, 'the goal changed');
        assert.strictEqual((await cap(page)).cap, c0.cap);
        assert.strictEqual(await page.evaluate(() => window.HUB_TEST.open()), 'budget-lab');
      });

      const tr = await rectOf(page, '#panel .bl-track');
      const at = (f) => ({ x: tr.x + tr.w * f, y: tr.y + tr.h / 2 });

      await check('tablet: a tap on the line sets the cap there, in $5 steps', async () => {
        const p = at(0.25);
        await tap(cdp, p.x, p.y);
        const c = await cap(page);
        assert.strictEqual(c.cap % 5 === 0 || c.cap === c.capMax, true, String(c.cap));
        assert.ok(Math.abs(c.cap - 0.25 * c.capMax) <= 5, c.cap + ' vs ' + 0.25 * c.capMax);
        assert.strictEqual(goalFile(env), before);
      });

      await check('tablet: a tap just under the drawn line still lands on it (a wide touch area)', async () => {
        const p = at(0.5);
        await tap(cdp, p.x, p.y + tr.h / 2 + 18);
        const c = await cap(page);
        assert.ok(Math.abs(c.cap - 0.5 * c.capMax) <= 5, c.cap + ' vs ' + 0.5 * c.capMax);
      });

      await check('tablet: a drag along the line scrubs the cap; the saved $60 mark catches it and Save says Saved', async () => {
        const c1 = await cap(page);
        const to = at(61 / c1.capMax);
        await finger(cdp, line(at(0.8), to, 14));
        let c = await cap(page);
        assert.strictEqual(c.cap, 60);
        assert.strictEqual(c.big, '$60');
        assert.ok(/\bis-done\b/.test(c.save.cls) && c.save.text === 'Saved', JSON.stringify(c.save));
        // From 560-ish down to 60 is one drag, not hundreds of taps.
        await finger(cdp, line(at(0.5), at(0.6), 6));
        c = await cap(page);
        assert.ok(c.cap > 60 && c.save.text === 'Save $' + Math.floor(c.cap), JSON.stringify(c));
        assert.strictEqual(goalFile(env), before);
      });

      await check('tablet: a sideways drag from the big number moves the cap by the finger\'s distance', async () => {
        await tap(cdp, at(0.5).x, at(0.5).y);
        const c1 = await cap(page);
        const b = await rectOf(page, '#panel .bl-big');
        const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        await finger(cdp, line(from, { x: from.x - tr.w * 0.1, y: from.y + 4 }, 8));
        const c = await cap(page);
        assert.ok(Math.abs((c1.cap - c.cap) - 0.1 * c.capMax) <= 6, c1.cap + ' -> ' + c.cap);
      });

      await check('tablet: an up or down swipe on the cap leaves it alone', async () => {
        const c1 = await cap(page);
        const p = at(0.3);
        await finger(cdp, line({ x: p.x, y: p.y - 10 }, { x: p.x + 6, y: p.y - 160 }, 8));
        assert.strictEqual((await cap(page)).cap, c1.cap);
        // The swipe scrolled the page: back to the top for the next checks.
        await page.evaluate(() => { document.querySelector('#panel .panel-body').scrollTop = 0; });
        await H.sleep(100);
      });

      await check('tablet: a tap on an arrow moves the cap $1, never saves', async () => {
        const c1 = await cap(page);
        const a = await rectOf(page, '#panel .bl-arrow.is-right');
        await page.touchscreen.tap(a.x + a.w / 2, a.y + a.h / 2);
        await H.sleep(150);
        assert.strictEqual((await cap(page)).cap, Math.floor(c1.cap) + 1);
        assert.strictEqual(goalFile(env), before);
      });

      await check('tablet: Save right after a drag is ignored; a deliberate Save saves the cap as the daily goal', async () => {
        await finger(cdp, line(at(0.2), at(0.15), 4));
        const c1 = await cap(page);
        const s = await rectOf(page, '#panel .bl-save');
        await page.touchscreen.tap(s.x + s.w / 2, s.y + s.h / 2);       // within 400 ms of the drag
        await H.sleep(150);
        assert.strictEqual(goalFile(env), before, 'saved too soon');
        await H.sleep(500);
        await page.touchscreen.tap(s.x + s.w / 2, s.y + s.h / 2);
        await H.until(() => lastGoal(env) === Math.floor(c1.cap), 4000, 'the goal was not saved').catch(async (e) => { throw new Error(e.message + ' ' + JSON.stringify({ c1: c1, now: await cap(page), file: goalFile(env), toast: await toast(page) })); });
        await H.until(() => cap(page).then((c) => c.save && c.save.text === 'Saved'), 4000, 'Save never said Saved');
        assert.ok(/Your cap saved/.test(await toast(page)), await toast(page));
      });

      await check('tablet: no console errors', async () => {
        assert.deepStrictEqual(H.errorsOf(page, true), []);
      });
    } finally { await page.ctx.close(); }

    // Guest mode: read only.
    page = await env.newPage({ layout: LAYOUT, touch: true, query: 'as=tablet', storage: { 'homeHub.budget.seen.v1': '[]', 'homeHub.guest.v1': 'on' } });
    try {
      await openLab(page);
      const cdp = await page.ctx.newCDPSession(page);
      await check('guest: no Save button; a drag, a tap on the line, an arrow and OK change and save nothing', async () => {
        const before = goalFile(env);
        const c1 = await cap(page);
        assert.ok(c1.save && !c1.save.shown, JSON.stringify(c1.save));
        const tr = await rectOf(page, '#panel .bl-track');
        await finger(cdp, line({ x: tr.x + tr.w * 0.7, y: tr.y }, { x: tr.x + tr.w * 0.1, y: tr.y }, 10));
        await tap(cdp, tr.x + tr.w * 0.3, tr.y);
        const a = await rectOf(page, '#panel .bl-arrow.is-left');
        await page.touchscreen.tap(a.x + a.w / 2, a.y + a.h / 2);
        await H.sleep(200);
        assert.strictEqual((await cap(page)).cap, c1.cap);
        await H.key(page, 'Enter');
        await H.sleep(500);
        assert.strictEqual(goalFile(env), before);
        assert.ok(/Guest mode is on/.test(await toast(page)), await toast(page));
      });
    } finally { await page.ctx.close(); }

    // The TV: as before.
    page = await env.newPage({ layout: LAYOUT, storage: { 'homeHub.budget.seen.v1': '[]' } });
    try {
      await openLab(page);
      await check('TV: no knob, no Save, the key hint; Right moves the cap $1 and OK saves it', async () => {
        const c1 = await cap(page);
        assert.strictEqual(c1.save, null);
        assert.strictEqual(c1.knob, false);
        assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#panel .bl-hero .bl-keyhint').length), 1);
        assert.ok(/^Hold/.test(await page.evaluate(() => document.querySelector('#panel .bl-hint').textContent)));
        await H.key(page, 'ArrowRight');
        const c2 = await cap(page);
        assert.strictEqual(c2.cap, Math.floor(c1.cap) + 1);
        await H.key(page, 'Enter');
        await H.until(() => lastGoal(env) === c2.cap, 4000, 'OK did not save');
      });
    } finally { await page.ctx.close(); }

    for (const longer of [false, true]) {
      page = await env.newPage({ layout: LAYOUT, touch: true, query: 'as=tablet', lang: 'es', storage: { 'homeHub.lang': 'es', 'homeHub.budget.seen.v1': '[]' },
        config: longer ? function () {
          // Runs before app/i18n.js: wrap localize as it arrives.
          let held;
          Object.defineProperty(window, 'HUB_I18N', { configurable: true, get: () => held, set: (t) => {
            held = t;
            const orig = t.localize;
            t.localize = function (en, prefix, l) {
              const out = orig.call(t, en, prefix, l);
              if (prefix !== 'budgetLab') return out;
              ['capHintTouch', 'saveCap', 'savedCap', 'capLabel'].forEach((k) => { const v = out[k]; out[k] = v.replace(/ \{n\}$/, '') + ' ÁÉñ' + v.replace(/\{n\}/g, '').slice(0, Math.ceil(v.length / 4)) + (/\{n\}/.test(v) ? ' {n}' : ''); });
              return out;
            };
          } });
        } : undefined });
      try {
        await openLab(page);
        await check('Spanish' + (longer ? ' 25% longer' : '') + ': Save and the hint whole, accents whole, inside the cap', async () => {
          const out = await page.evaluate(() => {
            const box = document.querySelector('#panel .bl-hero').getBoundingClientRect();
            const bad = [];
            ['.bl-save', '.bl-hint', '.bl-label', '.bl-big'].forEach((s) => {
              const big = s === '.bl-big';     // big digits: line height 1.1 by design
              const n = document.querySelector('#panel ' + s);
              const r = n.getBoundingClientRect();
              if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(s + ' outside');
              if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow === 'hidden') bad.push(s + ' clipped');
              const cs = getComputedStyle(n);
              if (!big && parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) < 1.25) bad.push(s + ' line height');
            });
            return { bad: bad, save: document.querySelector('#panel .bl-save').textContent, hint: document.querySelector('#panel .bl-hint').textContent };
          });
          assert.deepStrictEqual(out.bad, [], JSON.stringify(out));
          assert.ok(longer ? /^Guardar ÁÉñ.* \$\d/.test(out.save) : /^Guardar \$\d/.test(out.save), out.save);
          assert.ok(/^Arrastra por la línea/.test(out.hint), out.hint);
        });
      } finally { await page.ctx.close(); }
    }
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
