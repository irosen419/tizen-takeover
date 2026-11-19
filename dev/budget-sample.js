/*
 * The made-up budget snapshot for the tests, the screenshots and the preview,
 * and the Spanish words for the budget tiles.
 *
 *   node dev/budget-sample.js [--covered|--short] [--negative] [--payday] [--receipt|--receipt-covered|--receipt-short] [--outlook|--outlook-ahead] | \
 *     HUB_TOKEN=preview-token-not-a-secret-000000 node pi/hubctl.js budget set -
 *
 * prints the sample (pi/fixtures/budget-sample.json) with sentAt one minute
 * ago, for the preview's hub server. This repository is public: everything
 * here is made up.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'pi', 'fixtures', 'budget-sample.json');
// Every section the Pi keeps, the Budget lab ones (lab, merchants, pace,
// runway) included.
const SECTIONS = require('../pi/budget').SECTIONS;

/*
 * opts: { sentAt, short (card day not covered, short by $120), negative
 * (room below zero), shortZero (the Budget lab's room below zero, so even
 * $0 a day leaves card day short; a number sets the room, default -137.40; with
 * payday the runway still ends at the room), under (room under the cap; the default), atCap,
 * noRefund, goals (a list to use instead), alerts (a list), only [section
 * names to keep], shortFirst (card day is short on the 1st by this many dollars, default
 * 954.2, with the lab room at the same figure below zero: the "before" state of the
 * autopay days), autopay (on top of shortFirst: cardDay says byAutopay with its
 * payment plan, the room says basis "autopay", the lab sends autopayRoom and
 * autopayDate), payday (a 14 day window to card day on Nov 30 with a
 * payday on Nov 20 inside it, for the runway chart: its runway ends at
 * lab.room to the cent), receipt (the Card day receipt prototype: 'autopay'
 * short on Dec 1 and covered by autopay, 'covered', or 'short' even with
 * autopay, $312 more; cardDay.receipt is NOT in the Pi's validator yet, so it is
 * injected into the TV: see dev/budget-receipt-shots.js), outlook (true adds
 * cardDay.outlook, the "Next 3 months" page; 'ahead' starts it ahead of plan; needs receipt) }.
 */
function snapshot(opts) {
  opts = opts || {};
  const s = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (opts.sentAt) s.sentAt = opts.sentAt;
  if (opts.short) {
    s.cardDay.covered = false;
    s.cardDay.shortBy = 120;
  }
  if (opts.negative) {
    s.room.roomPerDay = -14;
    s.room.roomIfRefund = 3;
  }
  if (opts.atCap) s.room.roomPerDay = 64;
  if (opts.noRefund) delete s.room.roomIfRefund;
  if (opts.goals) s.goals.items = opts.goals;
  if (opts.alerts) s.alerts.items = opts.alerts;
  if (opts.payday) {
    s.runway.start = 340.25;
    s.runway.end = '2026-11-30';
    s.runway.steps = [
      { date: '2026-11-18', delta: -120, kind: 'bill' },
      { date: '2026-11-20', delta: 2400, kind: 'pay' },
      { date: '2026-11-23', delta: -95, kind: 'bill' },
      { date: '2026-11-25', delta: -64.5, kind: 'bill' },
      { date: '2026-11-30', delta: -415, kind: 'reserve' }
    ];
    // 340.25 - 120 + 2400 - 95 - 64.50 - 415 = 2045.75
    Object.assign(s.lab, { room: 2045.75, daysLeft: 14, cardDate: '2026-11-30' });
    Object.assign(s.cardDay, { date: '2026-11-30', daysAway: 14 });
  }
  if (opts.shortZero) {
    // Short even at $0 a day: the room is below zero, so no cap covers card
    // day. With payday the runway still ends at lab.room to the cent.
    const room = typeof opts.shortZero === 'number' ? opts.shortZero : -137.4;
    s.lab.room = room;
    delete s.lab.autopayRoom;
    delete s.lab.autopayDate;
    s.cardDay.covered = false;
    s.cardDay.shortBy = -room;
    if (opts.payday) s.runway.start = Math.round((room - (-120 + 2400 - 95 - 64.5 - 415)) * 100) / 100;
  }
  if (opts.shortFirst || opts.autopay) {
    const by = typeof opts.shortFirst === 'number' ? opts.shortFirst : 954.2;
    s.cardDay.covered = false;
    s.cardDay.shortBy = by;
    delete s.cardDay.plan;
    delete s.lab.autopayRoom;
    delete s.lab.autopayDate;
    s.lab.room = -by;
    if (opts.payday) s.runway.start = Math.round((-by - (-120 + 2400 - 95 - 64.5 - 415)) * 100) / 100;
  }
  if (opts.autopay) {
    s.cardDay.byAutopay = true;
    s.cardDay.plan = [
      { label: 'Sapphire Reserve', date: '2026-11-30', amount: 1200, kind: 'first' },
      { label: 'Sapphire Reserve', date: '2026-12-07', amount: 400, kind: 'autopay' },
      { label: 'Sapphire Preferred', date: '2026-12-08', amount: 1500, kind: 'autopay' },
      { label: 'Freedom Unlimited', date: '2026-12-09', amount: 950, kind: 'autopay' }
    ];
    s.room.basis = 'autopay';
    s.lab.autopayRoom = 215.8;
    s.lab.autopayDate = '2026-12-07';
  }
  if (opts.receipt) applyReceipt(s, opts.receipt === true ? 'autopay' : opts.receipt);
  if (opts.outlook && s.cardDay) applyOutlook(s, opts.outlook);
  if (opts.only) for (const k of SECTIONS) if (opts.only.indexOf(k) < 0) delete s[k];
  // Section times follow sentAt, so an old snapshot is old all through.
  for (const k of SECTIONS) if (s[k]) s[k].asOf = s.sentAt;
  return s;
}

/*
 * The Card day receipt (prototype), the budget app's own lines in its order:
 * Checking now 5210, Bills before Dec 1 -160, Cards today pending included
 * -4247, Recurring charges on the cards before Dec 1 -190, Bills from Dec 1
 * to payday Dec 3 -1450, Planned buys -60 = Left to spend -897. 'covered'
 * has 2000 more in checking; 'short' has the autopay plan short too, $312
 * less in checking. The cards owe 4437 in all (balance + pending 4247, the
 * recurring charges 190): that is the figure the old tile showed as a bare
 * "From checking".
 */
function applyReceipt(s, kind) {
  const extra = kind === 'covered' ? 2000 : kind === 'short' ? -312 : 0;
  // amount = balance + pending (what the card owes today); coming = recurring charges before card day.
  const cards = [
    { label: 'Sapphire Reserve', bal: 1602, pending: 87, coming: 82, autopay: '2026-12-07', pay: 874, auto: 897 },
    { label: 'Sapphire Preferred', bal: 1388, pending: 64, coming: 48, autopay: '2026-12-08', pay: 1500, auto: 0 },
    { label: 'Freedom Unlimited', bal: 540, pending: 0, coming: 60, autopay: '2026-12-09', pay: 600, auto: 0 },
    { label: 'Prime Visa', bal: 566, pending: 0, coming: 0, autopay: '2026-11-24', pay: 0, auto: 566 }
  ];
  cards.forEach((c) => { c.amount = c.bal + c.pending; });
  const checking = 5210 + extra;
  const bottom = checking - 160 - 4247 - 190 - 1450 - 60;
  if (kind === 'covered') { cards[0].pay = 1771; cards[0].auto = 0; }
  if (kind === 'short') { cards[0].pay -= 312; cards[0].auto += 312; }
  s.cardDay.date = '2026-12-01';
  s.cardDay.daysAway = 15;
  s.cardDay.paychecks = ['2026-12-03', '2026-12-17'];
  delete s.cardDay.transfers;
  delete s.cardDay.shortBy;
  delete s.cardDay.byAutopay;
  delete s.cardDay.autopayShortBy;
  delete s.cardDay.plan;
  s.cardDay.covered = bottom >= 0;
  const first = [0, 1, 2].filter((n) => cards[n].pay > 0).map((n) => ({ label: cards[n].label, date: '2026-12-01', amount: cards[n].pay, kind: 'first' }));
  const later = cards.filter((c) => c.auto > 0).map((c) => ({ label: c.label, date: c.autopay, amount: c.auto, kind: 'autopay' }));
  s.cardDay.plan = bottom < 0 ? first.concat(later) : first;
  if (bottom < 0) {
    s.cardDay.shortBy = -bottom;
    s.cardDay.byAutopay = kind !== 'short';
    if (kind === 'short') s.cardDay.autopayShortBy = 312;
  }
  s.cardDay.receipt = {
    asOf: '2026-11-16T12:08:00Z',
    next: { date: '2026-12-03', amount: 3595 },
    lines: [
      { key: 'checking', label: 'Checking now', amount: checking },
      { key: 'paychecks', label: 'Paychecks before Dec 1', amount: 0, items: [] },
      { key: 'billsBefore', label: 'Bills before Dec 1', amount: -160, items: [
        { label: 'Phone', date: '2026-11-22', amount: 85, new: true },
        { label: 'Internet', date: '2026-11-27', amount: 75 }
      ] },
      { key: 'cardsToday', label: 'Cards today, pending included', amount: -4247, items: cards },
      { key: 'cardCharges', label: 'Recurring charges on the cards before Dec 1', amount: -190, items: [
        { label: 'Streaming Plus', date: '2026-11-21', amount: 18, note: 'Sapphire Reserve' },
        { label: 'Gym', date: '2026-11-28', amount: 64, note: 'Sapphire Reserve' },
        { label: 'Meal kit', date: '2026-11-30', amount: 48, note: 'Sapphire Preferred' },
        { label: 'News site', date: '2026-11-23', amount: 15, note: 'Freedom Unlimited' },
        { label: 'Photo software', date: '2026-11-29', amount: 45, note: 'Freedom Unlimited' }
      ] },
      { key: 'billsAfter', label: 'Bills from Dec 1 to payday Dec 3', amount: -1450, items: [
        { label: 'Rent', date: '2026-12-01', amount: 1450 }
      ] },
      { key: 'buys', label: 'Planned buys', amount: -60, items: [{ label: 'Headphones', amount: 60 }] }
    ],
    bottom: bottom
  };
  if (bottom > 0) s.cardDay.receipt.perDay = Math.round(bottom / 17);
}

/*
 * The Card day "Next 3 months" page (prototype): only the inputs; the TV works out the rest. Paychecks of
 * 3595 every 14 days (three in December), bills 2412 a month, 190 a month of recurring card charges, 60 of
 * planned buys in December, the last 3 months averaging 110 a day of everyday card spending, 2083 behind on Dec 1.
 */
function applyOutlook(s, kind) {
  s.cardDay.outlook = {
    start: kind === 'ahead' ? { date: '2026-12-01', behind: 0, ahead: 640 } : { date: '2026-12-01', behind: 2083, ahead: 0 },
    dailyAverage: 110,
    averageMonths: 3,
    months: [
      { month: '2026-12', days: 31, paydays: ['2026-12-02', '2026-12-16', '2026-12-30'], paycheck: 3595, bills: 2412, cardRecurring: 190, planned: 60 },
      { month: '2027-01', days: 31, paydays: ['2027-01-13', '2027-01-27'], paycheck: 3595, bills: 2412, cardRecurring: 190, planned: 0 },
      { month: '2027-02', days: 28, paydays: ['2027-02-10', '2027-02-24'], paycheck: 3595, bills: 2412, cardRecurring: 190, planned: 0 }
    ]
  };
}

/* Spanish for the stress checks: most words run longer than the English. */
const SPANISH = {
  titles: { room: 'Margen diario', card: 'Día de la tarjeta', goals: 'Metas' },
  daysShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  monthsShort: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
  dateLong: '{dow} {d} {mon}',
  dateShort: '{d} {mon}',
  am: 'a. m.',
  pm: 'p. m.',
  thousands: '.',
  cash: '{n} US$',
  asOf: 'datos de las {t}',
  more: '+{n} más',
  aDay: 'al día',
  roomADay: 'de margen al día',
  ofCap: 'de {n} al día',
  capShort: 'tope {n}',
  daysLeft: 'quedan {n} días',
  daysLeft1: 'queda 1 día',
  daysLeft0: 'último día',
  through: 'hasta el {d}',
  refund: 'unos {n} cuando entre el reembolso pendiente',
  refundShort: 'unos {n} tras el reembolso',
  refundTiny: '{n} tras reembolso',
  underCap: 'por debajo del tope',
  overBudget: 'por encima del presupuesto',
  covered: 'Cubierto',
  coveredWord: 'cubierto',
  shortBy: 'Faltan {n}',
  shortWord: 'faltan {n}',
  today: 'hoy',
  tomorrow: 'mañana',
  inDays: 'en {n} días',
  todayCap: 'Hoy',
  cardOn: 'Pago de la tarjeta: {d}',
  transfersHead: 'Transferencias',
  nextPay: 'Próxima nómina: {d}',
  nextPayShort: 'Nómina: {d}',
  paychecksHead: 'Nóminas',
  noTransfers: 'No hace falta transferir',
  goalStates: { clean: 'Limpio', 'on-pace': 'Al ritmo', over: 'Pasado', under: 'Por debajo' },
  overN: '{n} pasadas',
  overN1: '1 pasada',
  goalsN: '{n} metas',
  goals1: '1 meta',
  allOnTrack: 'todo en orden',
  noGoals: 'Sin metas todavía',
  overWord: 'pasadas',
  goalsWord: 'metas',
  newCharge: 'Cargo nuevo: {label}',
  moreCharges: '+{n} más',
  okHint: 'OK',
  states: {
    off: { head: 'Necesita la Pi', line: 'El presupuesto viene del servidor de la Raspberry Pi. Las actualizaciones en vivo están apagadas en esta TV.', short: 'Actualizaciones apagadas.' },
    quiet: { head: 'Necesita la Pi', line: 'Esta TV todavía no ha llegado al servidor de la Pi. Sigue intentándolo sin molestar.', short: 'Esperando a la Pi.' },
    lost: { head: 'No se llega a la Pi', line: 'Estos mosaicos se llenan en cuanto la Pi responda.', short: 'Lo intenta de nuevo sin molestar.' },
    loading: { head: 'Cargando…', line: '', short: '' },
    waiting: { head: 'Esperando la app de presupuesto', line: 'La app de presupuesto de la Pi envía aquí sus totales. docs/budget-snapshot.md explica cómo.', short: 'Envía sus totales a la Pi.' },
    hidden: { head: 'Presupuesto oculto', line: 'widgets.budget.show está apagado en config.js.', short: 'Apagado en config.js.' }
  },
  broken: '{title}: no se pudo mostrar'
};

module.exports = { snapshot, SPANISH, FIXTURE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const s = snapshot({ sentAt: new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z'),
    short: args.indexOf('--short') >= 0, shortFirst: args.indexOf('--short-first') >= 0 || args.indexOf('--autopay') >= 0,
    autopay: args.indexOf('--autopay') >= 0, negative: args.indexOf('--negative') >= 0,
    outlook: args.indexOf('--outlook-ahead') >= 0 ? 'ahead' : args.indexOf('--outlook') >= 0, receipt: args.indexOf('--receipt-covered') >= 0 ? 'covered' : args.indexOf('--receipt-short') >= 0 ? 'short' : args.indexOf('--receipt') >= 0 ? 'autopay' : false, payday: args.indexOf('--payday') >= 0 });
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
}
