// Pictures of the Look choice on the Clock page: node dev/look-shots.js --out <folder> [--tag before|after]
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');
const clockPage = require('./clock-page');
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(arg('--out') || 'look-shots');
const TAG = arg('--tag') || 'after';
function mainLayout() {
  const vm = require('vm');
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', box);
  return box.C.layouts.filter((l) => l.id === 'main')[0].layout;
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start();
  try {
    for (const [lang, look] of [['en', 'night'], ['en', 'day'], ['es', 'day']]) {
      const page = await env.newPage({ layout: mainLayout(), storage: { 'homeHub.lang': lang, 'homeHub.budget.seen.v1': '["a-1042"]', 'homeHub.look': look } });
      await page.goto(page.url() + (TAG === 'before' ? '&theme=' + look : ''));
      await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
      await H.sleep(1500);
      await clockPage.open(page);
      await H.sleep(900);
      await page.screenshot({ path: path.join(OUT, 'clock-' + lang + '-' + look + '-' + TAG + '.png') });
      await page.context().close();
    }
  } finally { await env.stop(); }
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
