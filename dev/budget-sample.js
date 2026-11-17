/*
 * The made-up budget snapshot for the tests, the screenshots and the preview,
 * and the Spanish words for the budget tiles.
 *
 *   node dev/budget-sample.js [--covered|--short] [--negative] | \
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

/*
 * opts: { sentAt, short (card day not covered, short by $120), negative
 * (room below zero), under (room under the cap; the default), atCap,
 * noRefund, goals (a list to use instead), alerts (a list), only [section
 * names to keep] }.
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
  if (opts.only) for (const k of ['room', 'cardDay', 'goals', 'alerts']) if (opts.only.indexOf(k) < 0) delete s[k];
  // Section times follow sentAt, so an old snapshot is old all through.
  for (const k of ['room', 'cardDay', 'goals', 'alerts']) if (s[k]) s[k].asOf = s.sentAt;
  return s;
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
    short: args.indexOf('--short') >= 0, negative: args.indexOf('--negative') >= 0 });
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
}
