/*
 * Card day receipt: node dev/budget-receipt-test.js
 *
 * The tile is a three line receipt with no "Transfers"; OK opens the receipt
 * at full screen, each line a focusable row; OK on a line shows what is
 * behind it (rent among the bills, each card's autopay), the Back hint says
 * "Back to the receipt", Back returns with focus on that line and a second
 * Back closes; the lines add up to the bottom line; a receipt that does not
 * add up is ignored (the old tile); Guest mode hides all of it; Spanish.
 * Needs Playwright and port 8095 free. Every figure is made up.
 */
'use strict';

const H = require('./awws-harness');

const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const LAYOUT = [{ widget: 'budget-card', x: 0, y: 0, w: 4, h: 3 }, { widget: 'budget-room', x: 4, y: 0, w: 4, h: 3 }];
let passed = 0;
let failed = 0;

function assert(c, m) { if (!c) throw new Error(m); }

async function check(name, fn) {
  try { await fn(); passed++; console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

function snap(kind, tweak) {
  const s = H.budgetSample.snapshot({ sentAt: FRESH, payday: true, receipt: kind });
  Object.keys(s).forEach((k) => { if (s[k] && typeof s[k] === 'object' && s[k].asOf) s[k].asOf = FRESH; });
  if (tweak) tweak(s);
  return s;
}

async function inject(page, s) {
  await page.evaluate((d) => { const t = window.HUB_BUDGET_TEST; t.store.data = d; t.refresh(); }, s);
  await H.sleep(300);
}

const focusedKey = (page) => page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f && f.getAttribute('data-key'); });
const panelText = (page) => page.evaluate(() => document.querySelector('#panel .panel-body').textContent);

async function main() {
  const env = await H.start({});
  try {
    await env.setBudget(snap());
    const page = await env.newPage({ layout: LAYOUT, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
    try {
      await check('the Pi keeps the receipt and the TV gets it with no help', async () => {
        await env.setBudget(snap('autopay'));
        await H.sleep(1500);
        const r = await page.evaluate(() => { const d = window.HUB_BUDGET_TEST.store.data; return d && d.cardDay && d.cardDay.receipt; });
        assert(r && r.lines && r.lines.length === 7 && r.bottom === -897, 'receipt did not come through the Pi: ' + JSON.stringify(r && r.bottom));
      });
      await inject(page, snap('autopay'));
      await check('the tile is a receipt of three lines and never says Transfers', async () => {
        const t = await page.evaluate(() => document.querySelector('.cell[data-widget="budget-card"] .tile-body').textContent);
        assert(/Short \$897 on Dec 1/.test(t) && /covered by autopay/.test(t), 'hero: ' + t);
        assert(/Checking now\$5,210/.test(t) && /Cards and bills to Dec 3.\$6,107/.test(t) && /Left to spend.\$897/.test(t), 'mini receipt: ' + t);
        assert(!/Transfers/.test(t), 'says Transfers');
      });
      await check('the lines add up to the bottom line', async () => {
        const r = (await page.evaluate(() => window.HUB_BUDGET_TEST.store.data.cardDay.receipt));
        assert(Math.abs(r.lines.reduce((a, l) => a + l.amount, 0) - r.bottom) < 0.005, 'sums differ');
        r.lines.forEach((l) => { if (l.items && l.items.length) assert(Math.abs(l.items.reduce((a, i) => a + i.amount, 0) + l.amount) < 0.005, l.key + ' items differ'); });
      });
      await check('OK opens the receipt at full screen, every line a focusable row, in the budget app\'s order', async () => {
        await H.openPanel(page, 'budget-card');
        assert(await page.evaluate(() => window.HUB_TEST.mode()) === 'full', 'not full screen');
        const rows = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bu-rrow.f'), (n) => n.getAttribute('data-key')));
        assert(rows.join() === 'rc-checking,rc-paychecks,rc-billsBefore,rc-cardsToday,rc-cardCharges,rc-billsAfter,rc-buys,rc-bottom', rows.join());
        const t = await panelText(page);
        assert(/Pay on Dec 1/.test(t) && /Leave for autopay/.test(t) && /nothing here pays a card/.test(t) && /Next paycheck Thu, Dec 3/.test(t), 'plan: ' + t);
        assert(!/Transfers/.test(t), 'says Transfers');
      });
      await check('OK on the bills line shows rent; Back returns with focus on that line; Back again closes', async () => {
        for (let n = 0; n < 8 && await focusedKey(page) !== 'rc-billsAfter'; n++) await H.key(page, 'ArrowDown');
        assert(await focusedKey(page) === 'rc-billsAfter', 'could not focus the bills line');
        await H.key(page, 'Enter');
        await H.sleep(500);
        const t = await panelText(page);
        assert(/Rent/.test(t) && /\$1,450/.test(t) && /Total/.test(t), 'detail: ' + t);
        assert(await page.evaluate(() => document.querySelector('#panel .panel-hint').textContent) === 'Back to the receipt', 'hint');
        await H.key(page, 'Escape');
        await H.sleep(400);
        assert(await focusedKey(page) === 'rc-billsAfter', 'focus not on the line: ' + await focusedKey(page));
        assert(await page.evaluate(() => !!document.querySelector('#panel .bu-rrow[data-key="rc-buys"]')), 'receipt not back');
        await H.key(page, 'Escape');
        await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'did not close');
      });
      await check('the cards line shows each card\'s autopay day and what the plan pays', async () => {
        await H.openPanel(page, 'budget-card');
        for (let n = 0; n < 8 && await focusedKey(page) !== 'rc-cardsToday'; n++) await H.key(page, 'ArrowDown');
        await H.key(page, 'Enter');
        await H.sleep(500);
        const t = await panelText(page);
        assert(/Sapphire Reserve/.test(t) && /Autopay Dec 7/.test(t) && /You pay \$874 on Dec 1/.test(t) && /Autopay takes \$897/.test(t) && /plus \$82 in recurring charges before Dec 1/.test(t), t);
        await H.key(page, 'Escape');
        await H.key(page, 'Escape');
        await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'did not close');
      });
      await check('a covered card day: green "left to spend" with a daily figure', async () => {
        await inject(page, snap('covered'));
        const t = await page.evaluate(() => document.querySelector('.cell[data-widget="budget-card"] .tile-body').textContent);
        assert(/\$1,103 left to spend/.test(t) && /about \$65 a day/.test(t), t);
        assert(await page.evaluate(() => !!document.querySelector('.cell[data-widget="budget-card"] .bu-hero-num.is-ok')), 'not green');
      });
      await check('a receipt that does not add up is ignored: the old tile', async () => {
        await inject(page, snap('autopay', (s) => { s.cardDay.receipt.bottom = -800; s.cardDay.transfers = [{ label: 'From checking', amount: 310 }]; }));
        const t = await page.evaluate(() => document.querySelector('.cell[data-widget="budget-card"] .tile-body').textContent);
        assert(!/Left to spend/.test(t) && /Short \$897/.test(t), t);
      });
      await check('Guest mode hides the receipt', async () => {
        await inject(page, snap('autopay'));
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(400);
        const t = await page.evaluate(() => document.querySelector('.cell[data-widget="budget-card"] .tile-body').textContent);
        assert(/Hidden for guests/.test(t) && !/Checking now|5,210/.test(t), t);
        await page.evaluate(() => window.HUB_GUEST.set(false));
      });
      await check('outlook math: catch-up day, behind case, savings', async () => {
        await inject(page, snap('autopay', (x) => { x.cardDay = x.cardDay; }));
        const r = await page.evaluate((o) => {
          const t = window.HUB_BUDGET_TEST; const d = t.outlookData({ outlook: o });
          const a = t.outlookCalc(d, 110); const b = t.outlookCalc(d, 400);
          return { catch: a.catchDay, cm: a.catchMonth, nth: a.catchNth, left: a.months.map((m) => m.left), save: a.months.map((m) => m.save), note: a.months[0].note, bCatch: b.catchDay };
        }, H.budgetSample.snapshot({ receipt: 'autopay', outlook: true }).cardDay.outlook);
        assert(r.catch !== null && r.cm === 0 && r.nth === 3, JSON.stringify(r));
        assert(r.left[0] === 4713 && r.left[1] === 1178 && r.left[2] === 1508, JSON.stringify(r.left));
        assert(r.save[0] === 2630 && r.note === 2083 && r.save[1] === 1178, JSON.stringify(r.save));
        assert(r.bCatch === null, 'never caught up at $400 a day');
      });
      await check('outlook page: Right opens it, Down changes the daily amount, Left returns, Guest hides it', async () => {
        await inject(page, snap('autopay', (x) => { x.cardDay.outlook = H.budgetSample.snapshot({ receipt: 'autopay', outlook: true }).cardDay.outlook; }));
        await H.openPanel(page, 'budget-card');
        let t = await panelText(page);
        assert(/Next 3 months/.test(t) && /Checking now/.test(t), 'tab strip on the receipt');
        await H.key(page, 'ArrowRight'); await H.sleep(400);
        t = await panelText(page);
        assert(/Back on top by Dec 30/.test(t) && /\$110 a day/.test(t), t);
        await H.key(page, 'ArrowDown'); await H.sleep(300);
        t = await panelText(page);
        assert(/\$105 a day/.test(t) && /save \$150 more a month/.test(t), t);
        await H.key(page, 'ArrowLeft'); await H.sleep(400);
        assert(/Checking now/.test(await panelText(page)), 'back on the receipt');
        await H.key(page, 'ArrowRight'); await H.sleep(300);
        await page.evaluate(() => window.HUB_GUEST.set(true)); await H.sleep(400);
        t = await panelText(page);
        assert(/Hidden for guests/.test(t) && !/\$/.test(t), t);
        await page.evaluate(() => window.HUB_GUEST.set(false)); await H.sleep(300);
        while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(400); }
      });
      await check('outlook ahead start: cushion, headline, Spanish wording; still behind; empty months', async () => {
        const base = H.budgetSample.snapshot({ receipt: 'autopay', outlook: 'ahead' }).cardDay.outlook;
        const r = await page.evaluate((o) => {
          const t = window.HUB_BUDGET_TEST; const d = t.outlookData({ outlook: o });
          const c = t.outlookCalc(d, 110);
          const lowAhead = t.outlookData({ outlook: Object.assign({}, o, { months: [] }) });
          const bad = t.outlookData({ outlook: Object.assign({}, o, { start: { date: '2026-12-01', behind: 0, ahead: -1 } }) });
          return { ahead: d.ahead, behind: d.behind, left: c.months.map((m) => m.left), save: c.months.map((m) => m.save), catchDay: c.catchDay, empty: lowAhead, bad: bad };
        }, base);
        assert(r.ahead === 640 && r.behind === 0 && r.catchDay === null, JSON.stringify(r));
        assert(r.save[0] === 4713 && r.empty === null && r.bad === null, JSON.stringify(r));
        await inject(page, snap('autopay', (x) => { x.cardDay.outlook = base; }));
        await H.openPanel(page, 'budget-card');
        await H.key(page, 'ArrowRight'); await H.sleep(400);
        let t = await panelText(page);
        assert(/Ahead by \$640 on Dec 1/.test(t) && /Starting Dec 1: \$640 ahead/.test(t) && !/catches you up/.test(t), t);
        // Still behind after 3 months at a high daily amount.
        
        while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(400); }
        await inject(page, snap('autopay', (x) => { x.cardDay.outlook = H.budgetSample.snapshot({ receipt: 'autopay', outlook: true }).cardDay.outlook; x.cardDay.outlook.dailyAverage = 330; }));
        await H.openPanel(page, 'budget-card');
        await H.key(page, 'ArrowRight'); await H.sleep(400);
        t = await panelText(page);
        assert(/Still behind by Feb 28/.test(t) && /Try a lower daily amount/.test(t), t);
        while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(400); }
        // An empty months list: no tab strip.
        await inject(page, snap('autopay', (x) => { x.cardDay.outlook = H.budgetSample.snapshot({ receipt: 'autopay', outlook: true }).cardDay.outlook; x.cardDay.outlook.months = []; }));
        await H.openPanel(page, 'budget-card');
        { const pt = await panelText(page); assert(!/Next \d months/.test(pt), 'empty strip shown: ' + pt.slice(0, 120)); }
        while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(400); }
      });
      await check('no outlook in the snapshot: no tab strip', async () => {
        await inject(page, snap('autopay'));
        await H.openPanel(page, 'budget-card');
        { const pt = await panelText(page); assert(!/Next 3 months/.test(pt), 'strip shown: ' + pt.slice(0, 200)); }
        while (await page.evaluate(() => window.HUB_TEST.open())) { await H.key(page, 'Escape'); await H.sleep(400); }
      });
      assert(!H.errorsOf(page, false).length, 'console: ' + H.errorsOf(page, false).join(' | '));
    } finally { await page.ctx.close(); }
    const es = await env.newPage({ layout: LAYOUT, lang: 'es', storage: { 'homeHub.lang': 'es', 'homeHub.budget.seen.v1': '["a-1042"]' } });
    try {
      await inject(es, snap('autopay'));
      await check('Spanish: the receipt lines and the Back hint', async () => {
        await H.openPanel(es, 'budget-card');
        const t = await panelText(es);
        ['En la cuenta corriente ahora', 'Sueldos antes del 1 dic', 'Tarjetas hoy, con lo pendiente', 'Queda para gastar', 'Plan de pagos'].forEach((w) => assert(t.indexOf(w) >= 0, 'missing ' + w));
        for (let n = 0; n < 8 && await focusedKey(es) !== 'rc-billsAfter'; n++) await H.key(es, 'ArrowDown');
        await H.key(es, 'Enter');
        await H.sleep(500);
        assert(await es.evaluate(() => document.querySelector('#panel .panel-hint').textContent) === 'Atrás para volver al recibo', 'hint');
      });
    } finally { await es.ctx.close(); }
  } finally { await env.stop(); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
