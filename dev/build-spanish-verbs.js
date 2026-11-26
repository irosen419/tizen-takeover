/*
 * Builds app/spanish-verbs.js, the Conjugation table's verbs, from Conjugate
 * Me's data/verbs.json (irosen419/conjugate-me):
 *
 *   node dev/build-spanish-verbs.js ../conjugate-me/data/verbs.json
 *
 * Which verbs: the 70 Flashcards verbs (dev/build-spanish-cards.js) plus
 * every verb that Word of the day (app/wotd-data.js) uses, so the word's
 * Conjugation tab always has its table. A Word of the day verb that the
 * source lacks is made from a regular model verb (MADE below).
 *
 * Which tenses: TENSES (eight: the four of Flashcards, the conditional, the
 * present perfect, the present subjunctive and the imperative); five
 * persons (no vosotros, as in Flashcards: Latin American Spanish). The
 * imperative has no yo, so its first slot is null.
 *
 * Each verb also gets a mask per tense: bit p set = that person's form is
 * not what the regular -ar / -er / -ir pattern gives (irregular or a
 * spelling change). The table shows those in amber. A reflexive verb's
 * imperative (levántate) is never marked: its accents follow other rules.
 *
 * Deterministic: the same input gives the same file. Licence: Fred Jehle's
 * Spanish Verb Database (compiled by Brian Ghidinelli, CC BY-NC-SA 3.0).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { VERBS } = require('./build-spanish-cards.js');

// Conjugate Me's tense index -> the table's tense key.
const TENSES = [[0, 'pres'], [1, 'pret'], [2, 'imp'], [3, 'fut'], [4, 'cond'], [5, 'perf'], [10, 'subj'], [16, 'impv']];
const PERSONS = [0, 1, 2, 3, 5];
// Word of the day verbs Conjugate Me lacks: [verb, model, English]. Same
// pattern as the model, its stem swapped (descargar follows cargar: descargué).
const MADE = [
  ['cantar', 'hablar', 'to sing'],
  ['mejorar', 'hablar', 'to improve'],
  ['aprovechar', 'hablar', 'to make the most of'],
  ['extrañar', 'hablar', 'to miss'],
  ['prender', 'comer', 'to turn on'],
  ['descargar', 'cargar', 'to download']
];

/* ---------- the regular pattern ---------- */

const END = {
  ar: { pres: ['o', 'as', 'a', 'amos', 'an'], pret: ['é', 'aste', 'ó', 'amos', 'aron'], imp: ['aba', 'abas', 'aba', 'ábamos', 'aban'], subj: ['e', 'es', 'e', 'emos', 'en'], impv: [null, 'a', 'e', 'emos', 'en'], pp: 'ado' },
  er: { pres: ['o', 'es', 'e', 'emos', 'en'], pret: ['í', 'iste', 'ió', 'imos', 'ieron'], imp: ['ía', 'ías', 'ía', 'íamos', 'ían'], subj: ['a', 'as', 'a', 'amos', 'an'], impv: [null, 'e', 'a', 'amos', 'an'], pp: 'ido' },
  ir: { pres: ['o', 'es', 'e', 'imos', 'en'], pret: ['í', 'iste', 'ió', 'imos', 'ieron'], imp: ['ía', 'ías', 'ía', 'íamos', 'ían'], subj: ['a', 'as', 'a', 'amos', 'an'], impv: [null, 'e', 'a', 'amos', 'an'], pp: 'ido' }
};
const FUT = ['é', 'ás', 'á', 'emos', 'án'];
const COND = ['ía', 'ías', 'ía', 'íamos', 'ían'];
const HABER = ['he', 'has', 'ha', 'hemos', 'han'];
const REFL = ['me', 'te', 'se', 'nos', 'se'];

function plain(s) { return s.replace(/í/g, 'i'); }

// The regular forms of a verb: { tense: [5 forms] }.
function regular(inf) {
  const refl = /se$/.test(inf);
  const base = refl ? inf.slice(0, -2) : inf;
  const type = plain(base).slice(-2);
  const e = END[type];
  if (!e) throw new Error('no pattern for ' + inf);
  const stem = base.slice(0, -2);
  const futBase = plain(base);
  const out = {};
  ['pres', 'pret', 'imp', 'subj', 'impv'].forEach((t) => { out[t] = e[t].map((x) => (x === null ? null : stem + x)); });
  out.fut = FUT.map((x) => futBase + x);
  out.cond = COND.map((x) => futBase + x);
  out.perf = HABER.map((h) => h + ' ' + stem + e.pp);
  if (refl) {
    Object.keys(out).forEach((t) => {
      if (t === 'impv') return;
      out[t] = out[t].map((f, p) => REFL[p] + ' ' + f);
    });
  }
  return out;
}

function mask(inf, forms) {
  const reg = regular(inf);
  const refl = /se$/.test(inf);
  return TENSES.map((t, ti) => {
    if (refl && t[1] === 'impv') return 0;
    let m = 0;
    forms[ti].forEach((f, p) => { if (f !== null && f !== reg[t[1]][p]) m |= 1 << p; });
    return m;
  });
}

/* ---------- reading the sources ---------- */

function wotdVerbs() {
  const file = path.join(__dirname, '..', 'app', 'wotd-data.js');
  const box = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), box);
  return (box.window.HUB_WOTD_DATA || []).filter((w) => w.pos === 'verb').map((w) => w.es);
}

function formsOf(v) {
  return TENSES.map((t) => {
    const row = v.c.filter((c) => c[0] === t[0])[0];
    if (!row) throw new Error(v.i + ': no tense ' + t[1]);
    return PERSONS.map((p) => (row[2][p] === undefined ? null : row[2][p]));
  });
}

// A verb the source lacks: the model's forms with the stem swapped.
function madeFrom(name, model, en) {
  const ms = model.i.slice(0, -2);
  const ns = name.slice(0, -2);
  const swap = (f) => (f === null ? null : f.split(' ').map((w) => (w.indexOf(ms) === 0 ? ns + w.slice(ms.length) : w)).join(' '));
  return {
    i: name, e: en, m: [en],
    g: [swap(model.g[0])], pp: [swap(model.pp[0])],
    c: model.c.map((c) => [c[0], '', c[2].map(swap)])
  };
}

function sortKey(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function build(src) {
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  const byName = {};
  data.verbs.forEach((v) => { byName[v.i] = v; });
  const made = {};
  MADE.forEach((m) => { made[m[0]] = m; });
  const names = [];
  const seen = {};
  const flash = {};
  VERBS.forEach((n) => { flash[n] = 1; });
  VERBS.concat(wotdVerbs()).forEach((n) => { if (!seen[n]) { seen[n] = 1; names.push(n); } });
  const out = names.map((name) => {
    let v = byName[name];
    if (!v && made[name]) {
      const model = byName[made[name][1]];
      if (!model) throw new Error('no model ' + made[name][1]);
      v = madeFrom(name, model, made[name][2]);
    }
    if (!v) throw new Error('no verb ' + name + ' in ' + src + ' (add it to MADE)');
    const forms = formsOf(v);
    const en = ((v.m && v.m[0]) || String(v.e).split(/[;,]/)[0]).trim();
    const row = [name, en, v.g[0], v.pp[0], forms, mask(name, forms)];
    if (flash[name]) row.push(1);
    return row;
  });
  out.sort((a, b) => (sortKey(a[0]) < sortKey(b[0]) ? -1 : sortKey(a[0]) > sortKey(b[0]) ? 1 : 0));
  return out;
}

function main() {
  const src = process.argv[2];
  if (!src) { console.error('usage: node dev/build-spanish-verbs.js <conjugate-me>/data/verbs.json'); process.exit(2); }
  const verbs = build(src);
  const head = [
    '/*',
    ' * The Conjugation table\'s verbs (app/widgets/conjugate.js). Made by',
    ' * dev/build-spanish-verbs.js from Conjugate Me\'s data; do not edit by hand.',
    ' * The Flashcards verbs plus every Word of the day verb, A to Z.',
    ' *',
    ' * Each verb: [infinitive, English, gerund, participle, forms, irregular',
    ' * (, 1 when Flashcards has it)]. forms[tense][person], tenses as listed',
    ' * below; persons yo, tú, él/ella/usted, nosotros, ellos/ustedes (the',
    ' * imperative has no yo: null). irregular[tense]: bit p set = person p is',
    ' * not the regular pattern.',
    ' *',
    ' * Forms: Fred Jehle Spanish Verb Database, compiled by Brian Ghidinelli,',
    ' * CC BY-NC-SA 3.0 (https://github.com/ghidinelli/fred-jehle-spanish-verbs).',
    ' */',
    'window.HUB_SPANISH_VERBS = {',
    '  tenses: ' + JSON.stringify(TENSES.map((t) => t[1])) + ',',
    '  verbs: ['
  ];
  const rows = verbs.map((v) => '    ' + JSON.stringify(v));
  const text = head.join('\n') + '\n' + rows.join(',\n') + '\n  ]\n};\n';
  const file = path.join(__dirname, '..', 'app', 'spanish-verbs.js');
  fs.writeFileSync(file, text);
  console.log('wrote ' + path.relative(process.cwd(), file) + ': ' + verbs.length + ' verbs, ' + Math.round(text.length / 1024) + ' KB');
}

if (require.main === module) main();
module.exports = { TENSES, PERSONS, regular, build };
