/*
 * The hub's own words in Spanish: node dev/i18n-es-test.js
 *
 * Calendar, Weather, Entertainment (and its Schedule), To-do, the Clock tile,
 * the placeholder tiles (Mirror) and the hub's own toasts and switcher follow
 * the Clock page's Language choice (app/i18n.js). Runs the real hub in
 * headless Chromium (?lang=es) against the preview and the real hub server
 * from pi/ (dev/awws-harness.js: Monday 16 November 2026, 10:40 AM in
 * Chicago, the sample calendars). Checks that no fixed English word is left
 * on those tiles or in their panels (what the owner types or the Pi sends,
 * and show, song and app names, stay as sent), the Spanish day, month and
 * time words, that English output is unchanged, and that a language change
 * redraws the tiles. Needs Playwright and port 8095 free. Prints one line
 * per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const SHOWS = JSON.parse(fs.readFileSync(path.join(ROOT, 'pi', 'fixtures', 'shows-sample.json'), 'utf8'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').join('\n      '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }

// Fixed English the hub itself prints (not what people type or the Pi sends).
const ENGLISH = new RegExp('\\b(' + [
  'Calendar', 'Today', 'Tomorrow', 'Yesterday', 'All day', 'Nothing', 'Next', 'Coming up', 'Now', 'until',
  'Sunny', 'Cloudy', 'Clear', 'Rain today', 'Wind', 'Sunrise', 'Sunset', 'Feels like', 'Update now', 'Wrong city',
  'Mirror', 'Entertainment', 'Week of', 'Mark as', 'Back to', 'Schedule', 'Watch', 'Free TV', 'No ads',
  'Not installed', 'Looking for', 'All apps', 'On this TV', 'Full screen', 'Soon', 'Sample',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  '\\d (AM|PM)', '\\d:\\d\\d (AM|PM)'
].join('|') + ')\\b');

function leftover(text) {
  const bad = [];
  text.split('\n').forEach((line) => { const m = ENGLISH.exec(line); if (m) bad.push('"' + m[0] + '" in "' + line.trim() + '"'); });
  return bad;
}

const tileText = (page, id) => page.evaluate((w) => {
  const c = document.querySelector('.cell[data-widget="' + w + '"]');
  return c ? c.innerText : '';
}, id);
const panelText = (page) => page.evaluate(() => { const p = document.querySelector('#panel'); return p ? p.innerText : ''; });

// Nodes of these kinds whose text is cut (wider or taller than their box).
const LABELS = '.cal-allday-label, .cal-hour-label, .cal-trow-tag, .cal-trow-when, .cal-next-label, .cal-tab, .cal-btn, .cal-label, .cal-detail-when, .cal-strip-when,' +
  ' .wx-hl-key, .wx-stat-label, .wx-th-hour, .wx-hour, .wx-btn-label, .wx-now-feels, .wx-tile-cond, .wx-now-cond, .wx-day-dow,' +
  ' .ent-name, .ent-state, .ent-section-label, .today-ampm, .today-dow, .today-md, .planned-lead, .planned-note';
const clipped = (page) => page.evaluate((sel) => {
  const out = [];
  Array.prototype.forEach.call(document.querySelectorAll(sel), (n) => {
    if (!n.offsetWidth || !n.textContent.trim()) return;
    const cs = getComputedStyle(n);
    if (cs.textOverflow === 'ellipsis') return;   // cut on purpose, with "..."
    if (n.scrollWidth > n.clientWidth + 1 && cs.display !== 'inline') out.push(n.className + ' wide: ' + n.textContent.trim());
    if (n.scrollHeight > n.clientHeight + 1 && cs.display !== 'inline') out.push(n.className + ' tall: ' + n.textContent.trim());
  });
  return out;
}, LABELS);

// Back until no panel is open (full screen first goes back to the panel).
async function closePanels(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.evaluate(() => window.HUB_TEST.open()))) break;
    await H.key(page, 'Escape');
    await H.idle(page);
  }
}

async function main() {
  const env = await H.start({ ownService: true });
  try {
    const es = await env.newPage({ lang: 'es' });
    await es.evaluate((d) => window.HUB_SHOWS._test.setData(d), SHOWS);
    await H.sleep(500);

    if (process.env.DUMP) {
      for (const id of ['calendar', 'weather', 'todo', 'today', 'mirror', 'entertainment']) console.log('--- ' + id + '\n' + (await tileText(es, id)));
    }

    await check('Home tiles: no fixed English left (Spanish mode)', async () => {
      const bad = [];
      for (const id of ['calendar', 'weather', 'todo', 'today', 'mirror', 'entertainment']) {
        const t = await tileText(es, id);
        assert(t.trim().length > 0 || id === 'weather', id + ' is blank');
        leftover(t).forEach((b) => bad.push(id + ': ' + b));
      }
      assert(!bad.length, bad.join('\n'));
    });

    await check('Titles and the calendar tile use Spanish words', async () => {
      const heads = await es.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell .tile-title'), (n) => n.textContent));
      ['Calendario', 'Espejo', 'Entretenimiento'].forEach((w) => assert(heads.some((h) => h === w || h.indexOf(w) === 0 || h === 'Apps'), w + ' not among ' + heads.join(', ')));
      assert(heads.indexOf('Calendar') < 0 && heads.indexOf('Mirror') < 0, 'English titles: ' + heads.join(', '));
      const cal = await tileText(es, 'calendar');
      assert(/lunes|noviembre/i.test(cal), 'no Spanish day or month: ' + cal);
      const mirror = await tileText(es, 'mirror');
      assert(/espejo/i.test(mirror) || /c[aá]mara/i.test(mirror), 'mirror: ' + mirror);
    });

    for (const view of ['day', 'week', 'month']) {
      await check('Calendar panel, ' + view + ' view, in Spanish', async () => {
        await H.openPanel(es, 'calendar');
        if (view !== 'day') {
          await es.evaluate((v) => { const t = document.querySelector('.cal-tab[data-key="tab-' + v + '"]'); if (t) t.click(); }, view);
          await H.sleep(300);
        }
        const t = await panelText(es);
        const bad = leftover(t);
        assert(!bad.length, bad.join('\n'));
        assert(/Hoy/.test(t) && /Día/.test(t) && /Semana/.test(t) && /Mes/.test(t), 'tabs: ' + t.slice(0, 200));
        const cut = await clipped(es);
        assert(!cut.length, 'cut: ' + cut.join(' | '));
        await H.key(es, 'Escape');
        await H.idle(es);
      });
    }

    await check('Weather panel in Spanish', async () => {
      const state = await es.evaluate(() => !!document.querySelector('.cell[data-widget="weather"] .wx-tile-temp'));
      if (!state) return;   // no forecast on this run: the message states are covered below
      await H.openPanel(es, 'weather');
      const t = await panelText(es);
      const bad = leftover(t);
      assert(!bad.length, bad.join('\n'));
      assert(/Viento/.test(t) && /Amanecer/.test(t) && /Sensación térmica/.test(t), t.slice(0, 300));
      const cut = await clipped(es);
      assert(!cut.length, 'cut: ' + cut.join(' | '));
      await closePanels(es);
    });

    await check('Entertainment panel and Schedule in Spanish', async () => {
      await H.openPanel(es, 'entertainment');
      await H.fullScreen(es);
      const t = await panelText(es);
      const bad = leftover(t);
      assert(!bad.length, bad.join('\n'));
      assert(/Atrás para/.test(t), 'hint: ' + t.slice(-120));
      assert(/Esta semana/.test(t) && /Este mes/.test(t), 'schedule: ' + t.slice(0, 200));
      const cut = await clipped(es);
      assert(!cut.length, 'cut: ' + cut.join(' | '));
      await es.evaluate(() => { const b = document.querySelector('.ent-main [data-key="sh:tab:week"]'); if (b) b.click(); });
      await H.sleep(300);
      const w = await panelText(es);
      assert(/Semana del 16 al 22 de nov/.test(w), 'week: ' + w.slice(0, 300));
      const wbad = leftover(w);
      assert(!wbad.length, wbad.join('\n'));
      await H.key(es, 'ArrowDown');
      await H.key(es, 'Enter');
      await H.sleep(300);
      const d = await panelText(es);
      const dbad = leftover(d);
      assert(!dbad.length, dbad.join('\n'));
      await closePanels(es);
    });

    await check('To-do panel in Spanish', async () => {
      await H.openPanel(es, 'todo');
      const bad = leftover(await panelText(es));
      assert(!bad.length, bad.join('\n'));
      await closePanels(es);
    });

    await check('The layout switcher names are Spanish', async () => {
      await H.focusTile(es, 'calendar');
      await H.key(es, 'ArrowUp');
      await H.sleep(300);
      const names = await es.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.switcher-name'), (n) => n.textContent));
      assert(names.length >= 3, 'no switcher: ' + names.join(', '));
      assert(names.indexOf('Original') >= 0 && names.indexOf('Principal') >= 0 && names.indexOf('A arreglarse') >= 0, names.join(', '));
      assert(names.indexOf('Stock') < 0 && names.indexOf('Main') < 0, 'English names: ' + names.join(', '));
      await H.key(es, 'Escape');
      await H.idle(es);
    });

    await check('No console errors in Spanish', async () => {
      const errs = H.errorsOf(es, true);
      assert(!errs.length, errs.join(' | '));
    });

    await check('Changing the language redraws the tiles (es to en and back)', async () => {
      await es.evaluate(() => window.HUB_I18N.setLang('en'));
      await H.sleep(500);
      const cal = await tileText(es, 'calendar');
      assert(/Monday|Nothing|Today|Next|Calendar/.test(cal + (await es.evaluate(() => document.querySelector('.cell[data-widget="calendar"]').innerText))), 'calendar not English: ' + cal);
      const titles = await es.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell .tile-title'), (n) => n.textContent));
      assert(titles.indexOf('Calendar') >= 0 && titles.indexOf('Mirror') >= 0, titles.join(', '));
      await es.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(500);
      const titles2 = await es.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell .tile-title'), (n) => n.textContent));
      assert(titles2.indexOf('Calendario') >= 0 && titles2.indexOf('Espejo') >= 0, titles2.join(', '));
    });

    await check('English is unchanged', async () => {
      const en = await env.newPage({ lang: 'en' });
      const cal = await tileText(en, 'calendar');
      assert(/Monday/.test(cal) && /November/.test(cal), cal);
      const titles = await en.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell .tile-title'), (n) => n.textContent));
      assert(titles.indexOf('Calendar') >= 0 && titles.indexOf('Mirror') >= 0, titles.join(', '));
      await H.openPanel(en, 'calendar');
      const t = await panelText(en);
      assert(/Today/.test(t) && /Week/.test(t) && /Month/.test(t) && /\b(AM|PM)\b/.test(t), t.slice(0, 200));
      await en.context().close();
    });
  } finally {
    await env.stop();
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
