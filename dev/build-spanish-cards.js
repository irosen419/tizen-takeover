/*
 * Builds app/spanish-cards.js, the Flashcards widget's deck, from Conjugate
 * Me's data/verbs.json (irosen419/conjugate-me):
 *
 *   node dev/build-spanish-cards.js ../conjugate-me/data/verbs.json
 *
 * Keeps VERBS (everyday verbs, in teaching order) in four tenses (presente,
 * pretérito, imperfecto, futuro) and five persons (no vosotros). For each
 * slot it keeps the shortest real sentence from the Tatoeba corpus that
 * Conjugate Me tagged (none when there is none; the made-up frame sentences
 * are left out). Deterministic: the same input gives the same file.
 *
 * Licences: the forms are Fred Jehle's Spanish Verb Database (compiled by
 * Brian Ghidinelli, CC BY-NC-SA 3.0); the sentences are Tatoeba's (CC BY
 * 2.0 FR). The file's header says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERBS = ('ser estar tener hacer ir decir poder dar saber querer ver llegar pasar deber poner parecer quedar ' +
  'creer hablar llevar dejar seguir encontrar llamar venir pensar salir volver tomar conocer vivir sentir mirar ' +
  'contar empezar esperar buscar entrar trabajar escribir perder entender pedir recibir recordar terminar ' +
  'conseguir servir necesitar leer caer abrir oír acabar ganar traer morir preguntar jugar comer beber dormir ' +
  'comprar viajar ayudar gustar escuchar pagar estudiar cocinar').split(' ');
// Conjugate Me's tense index -> the deck's tense key.
const TENSES = [[0, 'pres'], [1, 'pret'], [2, 'imp'], [3, 'fut']];
const PERSONS = [0, 1, 2, 3, 5];
const MAX_SENTENCE = 72;

function build(src) {
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  const byName = {};
  data.verbs.forEach((v) => { byName[v.i] = v; });
  const out = [];
  VERBS.forEach((name) => {
    const v = byName[name];
    if (!v) throw new Error('no verb ' + name + ' in ' + src);
    const forms = TENSES.map((t) => {
      const row = v.c.filter((c) => c[0] === t[0])[0];
      if (!row) throw new Error(name + ': no tense ' + t[1]);
      return PERSONS.map((p) => row[2][p]);
    });
    const ex = {};
    (v.ts || []).forEach((s) => {
      const ti = TENSES.findIndex((t) => t[0] === s[0]);
      const pi = PERSONS.indexOf(s[1]);
      if (ti < 0 || pi < 0 || s[2].length > MAX_SENTENCE) return;
      const k = ti + '' + pi;
      if (!ex[k] || s[2].length < ex[k][0].length || (s[2].length === ex[k][0].length && s[2] < ex[k][0])) ex[k] = [s[2], s[3]];
    });
    // The first English meaning, short: "to have", not the whole list.
    const en = (v.m && v.m[0]) || String(v.e).split(/[;,]/)[0];
    out.push([name, en.trim(), forms, ex]);
  });
  return out;
}

function main() {
  const src = process.argv[2];
  if (!src) { console.error('usage: node dev/build-spanish-cards.js <conjugate-me>/data/verbs.json'); process.exit(2); }
  const verbs = build(src);
  const head = [
    '/*',
    ' * The Flashcards deck (app/widgets/flashcards.js). Made by',
    ' * dev/build-spanish-cards.js from Conjugate Me\'s data; do not edit by hand.',
    ' *',
    ' * Each verb: [infinitive, English, forms, examples]. forms[tense][person]:',
    ' * tenses presente, pretérito, imperfecto, futuro; persons yo, tú, él/ella,',
    ' * nosotros, ellos. examples["<tense><person>"] = [Spanish, English].',
    ' *',
    ' * Forms: Fred Jehle Spanish Verb Database, compiled by Brian Ghidinelli,',
    ' * CC BY-NC-SA 3.0 (https://github.com/ghidinelli/fred-jehle-spanish-verbs).',
    ' * Sentences: Tatoeba (https://tatoeba.org), CC BY 2.0 FR.',
    ' */',
    'window.HUB_SPANISH_CARDS = {',
    '  tenses: ' + JSON.stringify(TENSES.map((t) => t[1])) + ',',
    '  verbs: ['
  ];
  const rows = verbs.map((v) => '    ' + JSON.stringify(v));
  const text = head.join('\n') + '\n' + rows.join(',\n') + '\n  ]\n};\n';
  const file = path.join(__dirname, '..', 'app', 'spanish-cards.js');
  fs.writeFileSync(file, text);
  const n = verbs.reduce((a, v) => a + Object.keys(v[3]).length, 0);
  console.log('wrote ' + path.relative(process.cwd(), file) + ': ' + verbs.length + ' verbs, ' + verbs.length * 20 + ' cards, ' + n + ' sentences, ' + Math.round(text.length / 1024) + ' KB');
}

if (require.main === module) main();
module.exports = { VERBS, TENSES, PERSONS };
