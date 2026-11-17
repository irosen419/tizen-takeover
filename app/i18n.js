/*
 * Home Hub languages: English (the default) and Spanish (Latin American).
 *
 *   HUB_I18N.t('wotd.title', 'Word of the day')       // 'Palabra del día' in Spanish
 *   HUB_I18N.t('x.days', '{n} days', { n: 3 })        // {name} is filled in from vars
 *   HUB_I18N.lang()                                   // 'en' or 'es'
 *   HUB_I18N.setLang('es')                            // remembered on this TV; true when it changed
 *   HUB_I18N.onChange(function (lang) { ... })        // returns a function that stops listening
 *   HUB_I18N.dayName(date, short), monthName(date, short), longDate(date)
 *
 * A key missing from the Spanish table falls back to the English text the
 * caller gave, so a widget never shows a key or nothing. Spanish day and
 * month names are our own lists: the TV's browser may not know Spanish
 * dates (toLocaleDateString is not used for Spanish).
 *
 * The choice is kept in localStorage 'homeHub.lang' (when the TV allows
 * it). ?lang=es (or en) on the page's address overrides it for that load
 * only, for testing; picking a language on the Clock page still saves.
 *
 * Loaded in hub.html before the widgets. Plain ES5.
 */
(function () {
  'use strict';

  var KEY = 'homeHub.lang';
  var LANGS = ['en', 'es'];

  // Spanish for every key. English lives with the callers, as the fallback.
  var ES = {
    'lang.label': 'Idioma',
    'lang.en': 'English',
    'lang.es': 'Español',

    'wotd.title': 'Palabra del día',
    'wotd.meaning': 'Qué significa',
    'wotd.example': 'Ejemplo',
    'wotd.say': 'Cómo se dice',
    'wotd.level': 'Nivel {level}',
    'wotd.inEnglish': 'En inglés',
    'wotd.inSpanish': 'En español',
    'wotd.pos.noun': 'sustantivo',
    'wotd.pos.verb': 'verbo',
    'wotd.pos.adj': 'adjetivo',
    'wotd.pos.adv': 'adverbio',
    'wotd.pos.phrase': 'expresión',
    'wotd.pos.prep': 'preposición',
    'wotd.pos.pron': 'pronombre',
    'wotd.pos.conj': 'conjunción',
    'wotd.pos.interj': 'interjección',
    'wotd.pos.num': 'número',
    'wotd.none': 'No hay palabra para hoy.'
  };

  var DAYS = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
  };
  var DAYS_SHORT = {
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
  };
  var MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
  };
  var MONTHS_SHORT = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic']
  };

  var listeners = [];

  function valid(l) { return LANGS.indexOf(l) >= 0; }

  function readQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec((window.location && location.search) || '');
    try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
  }

  function loadSaved() {
    var v = null;
    try { v = window.localStorage ? localStorage.getItem(KEY) : null; } catch (e) { v = null; }
    return valid(v) ? v : null;
  }

  function save(l) {
    try { if (window.localStorage) localStorage.setItem(KEY, l); } catch (e) { /* not kept; fine */ }
  }

  var override = readQuery('lang');
  if (!valid(override)) override = null;
  var current = override || loadSaved() || 'en';

  function markPage() {
    try { document.documentElement.setAttribute('lang', current); } catch (e) { /* ignore */ }
  }
  markPage();

  function fill(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, function (all, name) {
      return vars.hasOwnProperty(name) && vars[name] !== null && vars[name] !== undefined ? String(vars[name]) : all;
    });
  }

  function t(key, fallback, vars) {
    var text = current === 'es' && ES.hasOwnProperty(key) ? ES[key] : null;
    if (text === null) text = fallback !== undefined && fallback !== null ? fallback : key;
    return fill(text, vars);
  }

  function setLang(l) {
    if (!valid(l)) return false;
    override = null;
    save(l);
    if (l === current) return false;
    current = l;
    markPage();
    var list = listeners.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](current); } catch (e) {
        if (window.console && console.warn) console.warn('Language change: ' + (e && e.message));
      }
    }
    return true;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function pickLang(l) { return valid(l) ? l : current; }

  function dayName(date, short, l) {
    l = pickLang(l);
    return (short ? DAYS_SHORT : DAYS)[l][date.getDay()];
  }

  function monthName(date, short, l) {
    l = pickLang(l);
    return (short ? MONTHS_SHORT : MONTHS)[l][date.getMonth()];
  }

  // "Tuesday, November 17" or "martes, 17 de noviembre".
  function longDate(date, l) {
    l = pickLang(l);
    if (l === 'es') return dayName(date, false, l) + ', ' + date.getDate() + ' de ' + monthName(date, false, l);
    return dayName(date, false, l) + ', ' + monthName(date, false, l) + ' ' + date.getDate();
  }

  window.HUB_I18N = {
    t: t,
    lang: function () { return current; },
    setLang: setLang,
    onChange: onChange,
    langs: function () { return LANGS.slice(); },
    has: function (key) { return ES.hasOwnProperty(key); },
    dayName: dayName,
    monthName: monthName,
    longDate: longDate,
    strings: { es: ES }
  };
})();
