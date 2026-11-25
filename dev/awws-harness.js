/*
 * What dev/awws-test.js and dev/awws-shots.js share: the preview, the sample
 * calendars, the Pi's hub server with its clock at the fixed moment, and a
 * headless Chromium page of the hub with a chosen layout and language.
 * Needs Playwright (require('playwright')) and port 8095 free (the preview's
 * pretend service.js). Nothing here reaches the internet.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const sample = require('./awws-sample');
const budgetSample = require('./budget-sample');

const TOKEN = 'preview-token-not-a-secret-000000';
// Monday 16 November 2026, 10:40 AM in Chicago.
const MONDAY = Date.parse('2026-11-16T16:40:00Z');
const BLOCKED = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev', require('./pi-host')];

/* Spanish for the stress screenshots and checks: real words, with accents,
   most of them longer than the English. The TV itself stays English. */
const SPANISH = {
  titles: { awws: 'Un mundo que vale la pena salvar', visits: 'Próxima visita', agenda: 'Esta semana', todo: 'Tablero de tareas',
    outreach: 'Bibliotecarias', pipeline: 'Libros', money: 'Ganado y gastado', reach: 'Alcance' },
  days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  daysShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  monthsShort: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
  dateLong: '{dow} {d} {mon}',
  dateShort: '{d} {mon}',
  dateFull: '{dowLong}, {d} de {month}',
  am: 'a. m.',
  pm: 'p. m.',
  thousands: '.',
  today: 'Hoy',
  tomorrow: 'Mañana',
  now: 'Ahora',
  allDay: 'Todo el día',
  untilT: 'hasta las {t}',
  days1: '1 día',
  daysN: '{n} días',
  daysShortN: '{n} d',
  unitDays: 'días',
  inDays: 'en {n} días',
  todayAt: 'hoy a las {t}',
  tomorrowAt: 'mañana a las {t}',
  onNow: 'ahora mismo',
  noTitle: '(Sin título)',
  more: '+{n} más',
  asOf: 'datos de las {t}',
  nowForYou: 'ahora para ti',
  nowForYouHead: 'Ahora para ti',
  nowCount: '{n} ahora para ti',
  nowCountShort: '{n} ahora',
  nowWord: 'ahora',
  todayCap: 'hoy',
  comingUp: 'Próximamente',
  figuresHead: 'Avance',
  then: 'Después',
  noVisits: 'Ninguna visita reservada',
  noVisitsWhen: 'en los próximos 60 días',
  nothingNow: 'Nada pendiente para ti',
  replies1: '1 respuesta en espera',
  repliesN: '{n} respuestas en espera',
  booked: '{n} reservadas',
  figures: { outreach: 'Bibliotecarias', pipeline: 'Libros', khaya: 'Reescritura', handoffs: 'Traspasos', money: 'Dinero', reach: 'Alcance' },
  spreads: '{done} de {total} páginas dobles',
  handoffsLine: 'abiertos: {open} · bloqueados: {blocked}',
  bookBlocked: '{title}, {format}',
  waitingOn: 'esperando: {name}',
  bookStage: '{title}: {stage}',
  allLive: 'Los {n} publicados',
  moneyLine: 'Gastado {spent} · ganado {earned}',
  moneyLineShort: 'sale {spent} · entra {earned}',
  netWord: 'neto',
  netSoFar: 'neto hasta hoy',
  earnedSpent: 'ganado {earned} · gastado {spent}',
  earnedSpentShort: 'entra {earned} · sale {spent}',
  earnedOnly: 'ganado {earned}',
  moneyHeads: { net: 'Neto hasta hoy', months: 'Por mes', next: 'Próxima transferencia', tools: 'Claude este mes' },
  earnedWord: 'Ganado',
  spentWord: 'Gastado',
  nextTransfer: 'Próxima transferencia: {d}',
  nextTransferAmt: 'Próxima transferencia: {d} · {n}',
  moneyStates: {
    hidden: { head: 'El dinero está oculto', line: 'showMoney está apagado en config.js, así que esta TV no muestra cifras de dinero.', short: 'showMoney está apagado en config.js.' },
    nodata: { head: 'Todavía no hay datos de dinero', line: 'Las cifras llegan con la próxima sincronización que envíe la sección de dinero.', short: 'Esperando la próxima sincronización.' }
  },
  reachLine: '{n} visitas esta semana',
  reachLine1: '1 visita esta semana',
  reachSubs: '{n} suscriptores',
  reachSubs1: '1 suscriptor',
  reachClicks: '{n} clics de compra',
  reachClicks1: '1 clic de compra',
  reachScans: '{n} escaneos del folleto',
  reachScans1: '1 escaneo del folleto',
  notSynced: 'Sin sincronizar todavía',
  soon: 'Pronto',
  views: { visits: 'Próxima visita', agenda: 'Esta semana', todo: 'Tablero de tareas', reach: 'Alcance' },
  nothingToday: 'Nada hoy',
  nothingWeek: 'Nada esta semana',
  nothingTwoWeeks: 'Nada en las próximas dos semanas',
  weekCount: '{n} fechas',
  weekCount1: '1 fecha',
  dueCount: '{n} tareas con fecha',
  dueCount1: '1 tarea con fecha',
  due: 'Vence',
  owners: { ian: 'Ian', claude: 'Claude', both: 'Ambos' },
  ownersShort: { ian: 'I', claude: 'C', both: 'A' },
  filters: { all: 'Todas', ian: 'Ian', claude: 'Claude', both: 'Ambos' },
  filterHint: '← → persona',
  ownerCount: '{name} {n}',
  sections: { now: 'Ahora', next: 'Después', later: 'Más adelante' },
  overdue: 'Atrasada',
  overdueCount: '{n} atrasadas',
  overdueCount1: '1 atrasada',
  doneWeek: '{n} hechas esta semana',
  doneWeek1: '1 hecha esta semana',
  byStream: 'Abiertas por área',
  noStream: 'Otras',
  emptyBoard: 'Nada en el tablero',
  emptySection: 'Nada aquí',
  emptyFilter: 'Nada para {name}',
  visitsWord: 'visitas',
  visitsWord1: 'visita',
  visitsWeek: 'visitas esta semana',
  visitsWeek1: 'visita esta semana',
  clicksWord: 'clics de compra',
  clicksWord1: 'clic de compra',
  clicksWordShort: 'clics',
  clicksWeek: 'clics de compra esta semana',
  clicksWeek1: 'clic de compra esta semana',
  subsWord: 'suscriptores',
  subsWord1: 'suscriptor',
  subsWordShort: 'suscr.',
  scansWord: 'escaneos del folleto',
  scansWord1: 'escaneo del folleto',
  changeUp: 'subió {n}',
  changeDown: 'bajó {n}',
  changeSame: 'igual que la semana pasada',
  changeSameShort: 'igual',
  vsLast: 'frente a {n} la semana pasada',
  vsLastShort: 'frente a {n}',
  weekVsLast: '{n} la semana pasada',
  lastCheck: 'según el último recuento, del {d}',
  lastCheckShort: 'contados el {d}',
  lastDays: 'Últimos {n} días',
  scansHead: 'Escaneos del folleto',
  reachHeads: { visits: 'Visitas al sitio', clicks: 'Clics de compra', scans: 'Escaneos del folleto en escuelas', subs: 'Suscriptores del boletín' },
  trafficLater: 'Las visitas al sitio y los clics de compra aparecen aquí cuando la sincronización los envíe.',
  states: {
    off: { head: 'Necesita la Pi',
      line: 'Las visitas y el tablero vienen del servidor de la Raspberry Pi. Las actualizaciones en vivo están apagadas en esta TV: pon en live.server de config.js la dirección de la Pi.',
      short: 'Actualizaciones apagadas. Pon live.server en config.js.' },
    quiet: { head: 'Necesita la Pi',
      line: 'Esta TV todavía no ha llegado al servidor de la Pi. Sigue intentándolo sin molestar. Cómo instalarlo está en pi/README.md.',
      short: 'Esperando el servidor de la Pi.' },
    lost: { head: 'No se llega a la Pi', line: '{live}. Estos mosaicos se llenan en cuanto la Pi responda.', short: 'Lo intenta de nuevo sin molestar.' },
    refused: { head: 'Necesita la Pi', line: '{live}.', short: '{live}.' },
    loading: { head: 'Cargando…', line: '', short: '' },
    nocalendar: { head: 'La Pi no envía calendario', line: 'El servidor de la Pi todavía no envía un calendario. Actualízalo (pi/README.md).', short: 'Actualiza el servidor de la Pi.' },
    missing: { head: 'No hay calendario “{name}” en la Pi',
      line: 'Añádelo al archivo .env de la Pi como CALENDAR_n_NAME={name} con su CALENDAR_n_URL y reinicia el servidor. Los pasos están en pi/README.md.',
      short: 'Añádelo al archivo .env de la Pi.' },
    error: { head: '{name}: no se pudo leer', line: 'La Pi no pudo leer el calendario {name}{why}. Lo vuelve a intentar cada pocos minutos.',
      short: 'La Pi lo intenta de nuevo cada pocos minutos.' },
    notsetup: { head: 'Sin sincronizar todavía',
      line: 'Los datos del tablero llegan cuando la sincronización esté lista. docs/awws-snapshot.md explica cómo.', short: '' }
  },
  calBad: '{name}: no se pudo leer',
  broken: '{title}: no se pudo mostrar',
  planned: {
    outreach: 'Las respuestas que esperan por ti, y cuántas escuelas respondieron, reservaron y recibieron la visita.',
    pipeline: 'Cada libro y descarga, desde la escritura hasta la publicación, y qué espera cada uno.'
  },
  plannedNote: 'Aún no está hecho. Este lugar está reservado.'
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}

/*
 * Starts everything. opts: { at (UTC ms, default MONDAY), snapshot (false =
 * none; default the sample), calendars (false = a Pi with no calendars),
 * budgetGoals (the Pi's daily goal history, [{ from, goal }]) }. Returns an env with control(), setSnapshot(), feeds, the
 * addresses, newPage() and stop().
 */
async function start(opts) {
  opts = opts || {};
  const env = { at: opts.at || MONDAY, problems: [] };
  env.PAGE_PORT = await spare();
  env.LIVE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.LIVE = 'http://127.0.0.1:' + env.LIVE_PORT;
  env.DEAD = 'http://127.0.0.1:' + (await spare());
  // opts.ownService: the preview's service on a free port instead of 8095 (the
  // page still asks 8095; openHub sends those requests to the free port), so
  // a test can run beside another that holds 8095.
  env.SERVICE_PORT = opts.ownService ? await spare() : 8095;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: String(env.SERVICE_PORT), HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  env.feeds = await sample.feedServer({ today: () => sample.chicagoToday(env.at) });
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-awws-'));
  // opts.budgetGoals: the Pi's daily goal history (pi/budgetgoal.js), there from the start.
  if (opts.budgetGoals) fs.writeFileSync(path.join(env.dataDir, 'budget-goal.json'), JSON.stringify({ v: 1, history: opts.budgetGoals }));
  env.pi = await sample.startPi({ at: env.at, port: env.LIVE_PORT, token: TOKEN, origins: [env.PAGE],
    dataDir: env.dataDir, calendars: opts.calendars === false ? [] : env.feeds.calendars });
  env.control = (method, route, body) => control(env, method, route, body);
  env.setSnapshot = async (snap) => {
    const r = await env.control('POST', '/api/awws', { snapshot: snap });
    if (!r || !r.ok) throw new Error('the hub server refused the snapshot: ' + JSON.stringify(r));
    return r;
  };
  env.setBudget = async (snap) => {
    const r = await env.control('POST', '/api/budget', { snapshot: snap });
    if (!r || !r.ok) throw new Error('the hub server refused the budget snapshot: ' + JSON.stringify(r));
    return r;
  };
  env.feedMode = async (mode) => {
    env.feeds.setMode(mode);
    await env.control('POST', '/api/calendar/refresh', {});
  };
  if (opts.calendars !== false) {
    await until(async () => {
      const d = await env.control('GET', '/api/calendar');
      return d && JSON.stringify(d).indexOf('Maple Grove') > 0;
    }, 15000, 'the hub server did not read the sample calendars');
  }
  if (opts.snapshot !== false) await env.setSnapshot(sample.snapshot());
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();
  env.newPage = (o) => openHub(env, o || {});
  env.stop = async () => {
    try { if (env.browser) await env.browser.close(); } catch (e) { /* ignore */ }
    try { await env.pi.close(); } catch (e) { /* ignore */ }
    try { await env.feeds.close(); } catch (e) { /* ignore */ }
    try { env.preview.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(env.dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };
  return env;
}

function control(env, method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: env.LIVE_PORT, path: route, method: method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('not JSON: ' + out.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/*
 * A page of the hub. o: { layout: [...] (kept as if picked in the switcher),
 * spanish, at, live ('off' | address; default the hub server), motion
 * (default 'fade'), lang ('es' for the hub in Spanish), storage
 * { key: value }, route(context), scale, video { dir }, config (a function
 * run on HUB_CONFIG before the hub starts), waitLive (default true), query
 * (more of the address, e.g. 'as=tablet'), touch (a touch screen) }.
 */
async function openHub(env, o) {
  const context = await env.browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: o.scale || 1, hasTouch: !!o.touch, timezoneId: o.tvZone || sample.TZ,
    recordVideo: o.video ? { dir: o.video.dir, size: { width: 1920, height: 1080 } } : undefined
  });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const host = new URL(route.request().url()).hostname;
    if (BLOCKED.indexOf(host) >= 0) return route.abort();
    return route.fallback();
  });
  if (env.SERVICE_PORT !== 8095) {
    await context.route('http://127.0.0.1:8095/**', (route) => {
      return route.continue({ url: route.request().url().replace('127.0.0.1:8095', '127.0.0.1:' + env.SERVICE_PORT) });
    });
  }
  if (o.route) await o.route(context);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  await page.clock.setFixedTime(new Date(o.at || env.at));
  const storage = Object.assign({}, o.storage || {});
  if (o.layout) {
    storage['homeHub.layout'] = JSON.stringify(o.layout);
    storage['homeHub.layoutChoice'] = JSON.stringify({ id: 'test', piSig: '' });
  }
  // Once per tab: a reload (a new layout from the switcher) keeps what the hub saved.
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('awws-test-seeded')) return;
      sessionStorage.setItem('awws-test-seeded', '1');
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, storage);
  if (o.spanish) await page.addInitScript((s) => { window.HUB_AWWS_STRINGS = s[0]; window.HUB_BUDGET_STRINGS = s[1]; }, [SPANISH, budgetSample.SPANISH]);
  if (o.config) await page.addInitScript(o.config);
  const live = o.live === undefined ? env.LIVE : o.live;
  await page.goto(env.PAGE + '/?motion=' + (o.motion || 'fade') + '&live=' + encodeURIComponent(live) + (o.lang ? '&lang=' + o.lang : '') + (o.query ? '&' + o.query : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
  if (o.waitLive !== false && live !== 'off') {
    await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'the hub did not go live');
  }
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  await sleep(400);
  page.ctx = context;
  return page;
}

// Console errors other than the blocked weather services and an expected
// unreachable Pi.
function errorsOf(page, allowNetwork) {
  return page.ctx.errors.filter((e) => !/net::ERR_FAILED/.test(e) &&
    !(allowNetwork && /Failed to load resource|ERR_CONNECTION_REFUSED|Live: /.test(e)));
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) {
    await page.keyboard.press(k);
    await sleep(70);
  }
}

async function idle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 6000, 'the hub stayed busy');
  await sleep(300);
}

// Moves focus to a tile with the arrows (by where the tiles are on screen).
async function focusTile(page, id) {
  for (let i = 0; i < 16; i++) {
    const step = await page.evaluate((want) => {
      const f = document.querySelector('#grid .tile.is-focused');
      const t = document.querySelector('.cell[data-widget="' + want + '"] .tile');
      if (!t) return 'missing';
      if (f === t) return 'done';
      const a = f.getBoundingClientRect();
      const b = t.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      if (b.right < a.left + 4 && Math.abs(b.top - a.top) < a.height) return 'ArrowLeft';
      if (b.left > a.right - 4 && Math.abs(b.top - a.top) < a.height) return 'ArrowRight';
      if (b.bottom < ay) return 'ArrowUp';
      if (b.top > ay) return 'ArrowDown';
      return b.left + b.width / 2 < ax ? 'ArrowLeft' : 'ArrowRight';
    }, id);
    if (step === 'done') return true;
    if (step === 'missing') throw new Error('no tile ' + id);
    await key(page, step);
  }
  throw new Error('could not focus ' + id);
}

async function openPanel(page, id) {
  await focusTile(page, id);
  await key(page, 'Enter');
  await until(() => page.evaluate((w) => window.HUB_TEST.open() === w, id), 5000, 'the panel of ' + id + ' did not open');
  await idle(page);
}

async function fullScreen(page) {
  // Up until the hub's Full screen button has focus, then OK.
  for (let i = 0; i < 12; i++) {
    const on = await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && !document.querySelector('#panel .panel-body').contains(f); });
    if (on) break;
    await key(page, 'ArrowUp');
  }
  await key(page, 'Enter');
  await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'full screen did not open');
  await idle(page);
}

module.exports = { start, sleep, until, key, idle, focusTile, openPanel, fullScreen, errorsOf, SPANISH, MONDAY, TOKEN, sample, budgetSample };
