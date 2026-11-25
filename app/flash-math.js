/*
 * Flashcards math, no DOM (app/widgets/flashcards.js, the touch app, the
 * tests): the cards of the deck (app/spanish-cards.js), the day's queue and
 * the spaced repetition boxes. pi/spanish.js keeps the same rule for what
 * it saves; dev/flashcards-test.js checks the two agree.
 *
 *   box      0 new or missed, 1..5 known; a card in box b is due again
 *            INTERVALS[b] days after it was last answered (1, 3, 7, 14, 30).
 *   progress { id: [box, due 'YYYY-MM-DD', misses] } from GET /spanish/progress.
 *   queue    due cards first (oldest due first), then new ones in teaching
 *            order (every presente card first, then pretérito, ...), at most
 *            NEW_PER_DAY new a day and SESSION cards a round.
 *
 * Plain ES5. Exposes window.HUB_FLASH_MATH, or module.exports under Node.
 */
(function (root) {
  'use strict';

  var INTERVALS = [0, 1, 3, 7, 14, 30];
  var NEW_PER_DAY = 10;
  var SESSION = 20;
  var TENSE_WORDS = { pres: 'presente', pret: 'pretérito', imp: 'imperfecto', fut: 'futuro' };
  var PERSON_WORDS = ['yo', 'tú', 'él / ella', 'nosotros', 'ellos'];
  var ID_RE = /^[a-záéíóúüñ]{2,20}\.(pres|pret|imp|fut)\.[0-4]$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // The local day of a Date, 'YYYY-MM-DD'.
  function dayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  // 'YYYY-MM-DD' plus n days (calendar days, so a clock change never skips one).
  function addDays(day, n) {
    var p = String(day).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n, 12);
    return dayOf(d);
  }

  // Every card, in teaching order: tense by tense, verb by verb, person by person.
  function cards(data) {
    var out = [];
    if (!data || !data.verbs || !data.tenses) return out;
    for (var t = 0; t < data.tenses.length; t++) {
      for (var v = 0; v < data.verbs.length; v++) {
        var row = data.verbs[v];
        var forms = row[2][t] || [];
        for (var p = 0; p < forms.length; p++) {
          if (!forms[p]) continue;
          var ex = row[3] ? row[3][String(t) + String(p)] : null;
          out.push({
            id: row[0] + '.' + data.tenses[t] + '.' + p,
            verb: row[0], en: row[1], tense: data.tenses[t], person: p,
            tenseWord: TENSE_WORDS[data.tenses[t]] || data.tenses[t],
            personWord: PERSON_WORDS[p] || '',
            form: forms[p], ex: ex || null
          });
        }
      }
    }
    return out;
  }

  // A card's next [box, due, misses] after an answer on day `today`.
  // result: 'got' moves it up a box; 'again' sends it back to box 0, due today.
  function apply(rec, result, today) {
    var box = rec ? rec[0] : 0;
    var misses = rec ? rec[2] : 0;
    if (result === 'again') return [0, today, misses + 1];
    box = Math.min(box + 1, INTERVALS.length - 1);
    return [box, addDays(today, INTERVALS[box]), misses];
  }

  // The ids for a round. intro: how many new cards were started today already.
  function queue(list, progress, today, opts) {
    opts = opts || {};
    var size = opts.size || SESSION;
    var newLeft = Math.max(0, (opts.newPerDay === undefined ? NEW_PER_DAY : opts.newPerDay) - (opts.intro || 0));
    var skip = opts.skip || {};
    var due = [];
    var fresh = [];
    progress = progress || {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (skip[c.id]) continue;
      var rec = progress[c.id];
      if (rec) { if (rec[1] <= today) due.push({ id: c.id, due: rec[1], box: rec[0], at: i }); }
      else if (fresh.length < newLeft) fresh.push(c.id);
    }
    due.sort(function (a, b) {
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (a.box !== b.box) return a.box - b.box;
      return a.at - b.at;
    });
    var out = [];
    for (var d = 0; d < due.length && out.length < size; d++) out.push(due[d].id);
    for (var f = 0; f < fresh.length && out.length < size; f++) out.push(fresh[f]);
    return out;
  }

  // How many cards are due today (for the tile's line), and how many never seen.
  function counts(list, progress, today) {
    var due = 0, fresh = 0;
    progress = progress || {};
    for (var i = 0; i < list.length; i++) {
      var rec = progress[list[i].id];
      if (!rec) fresh++;
      else if (rec[1] <= today) due++;
    }
    return { due: due, fresh: fresh, total: list.length };
  }

  var api = {
    INTERVALS: INTERVALS, NEW_PER_DAY: NEW_PER_DAY, SESSION: SESSION, ID_RE: ID_RE,
    TENSE_WORDS: TENSE_WORDS, PERSON_WORDS: PERSON_WORDS,
    dayOf: dayOf, addDays: addDays, cards: cards, apply: apply, queue: queue, counts: counts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HUB_FLASH_MATH = api;
})(typeof window !== 'undefined' ? window : this);
