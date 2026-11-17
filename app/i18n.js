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

    /* ---- The hub's own words: tile badges and the panel's head (app/hub.js) ----
     * Key 'hub.<name>'; the English is in hub.js (hubWord). The Back chip and
     * the button are small, so keep these short. */
    'hub.soon': 'Pronto',
    'hub.full': 'Pantalla completa',
    'hub.exitFull': 'Salir de pantalla completa',
    'hub.backClose': 'Atrás para cerrar',
    'hub.backShrink': 'Atrás para reducir',
    'hub.backTyping': 'Atrás para dejar de escribir',

    /* ---- Weather tile header (app/widgets/weather.js) ----
     * The title is the place's name, as the lookup sends it (not translated);
     * these are the badge words. */
    'weather.sample': 'Muestra',
    'weather.asOf': 'datos de las {t}',

    /* ---- Now Playing's header (app/widgets/nowplaying.js) ----
     * The title is "Spotify" in both languages; the badge says the state,
     * in capitals, so keep each to a word or two. */
    'nowplaying.badge.off': 'Sin configurar',
    'nowplaying.badge.signin': 'Sin conectar',
    'nowplaying.badge.idle': 'Sin música',
    'nowplaying.badge.error': 'Sin Spotify',
    'nowplaying.badge.waiting': 'Esperando',
    'nowplaying.badge.offline': 'Sin la Pi',
    'nowplaying.badge.update': 'Necesita la Pi',

    /* ---- Guest mode on the Clock page (app/guest.js, app/widgets/today.js) ---- */
    'guest.label': 'Modo invitados',
    'guest.off': 'No',
    'guest.on': 'Sí',

    'wotd.title': 'Palabra del día',
    // Short form: only when "Palabra del día" doesn't fit the tile on one line.
    'wotd.titleShort': 'Palabra',
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
    'wotd.none': 'No hay palabra para hoy.',

    /* ---- Budget tiles: Daily room, Card day, Goals and the "New charge" banner (app/widgets/budget.js) ----
     * Key 'budget.<path in STRINGS>'; the English is STRINGS at that path in
     * budget.js. Amounts keep their US form ($1,265): cash, thousands and minus
     * are left out on purpose, and so is anything the budget app sends (goal
     * names, goal texts, transfer labels, merchant names). Weekday and month
     * names come from the lists below. */
    'budget.titles.room': 'Margen diario',
    'budget.titles.card': 'Pago de tarjeta',
    'budget.titles.goals': 'Metas',
    // Short forms: only when the title doesn't fit the tile on one line.
    'budget.titlesShort.room': 'Margen',
    'budget.titlesShort.card': 'Tarjeta',
    'budget.titlesShort.goals': 'Metas',
    'budget.dateLong': '{dow} {d} {mon}',
    'budget.dateShort': '{d} {mon}',
    'budget.am': 'a. m.',
    'budget.pm': 'p. m.',
    'budget.asOf': 'datos de: {t}',
    'budget.more': '+{n} más',
    'budget.aDay': 'al día',
    'budget.roomADay': 'disponible al día',
    'budget.ofCap': 'de {n} al día',
    'budget.capShort': 'tope {n}',
    'budget.daysLeft': 'quedan {n} días',
    'budget.daysLeft1': 'queda 1 día',
    'budget.daysLeft0': 'último día',
    'budget.through': 'hasta el {d}',
    'budget.refund': 'unos {n} cuando entre el reembolso pendiente',
    'budget.refundShort': 'unos {n} tras el reembolso',
    'budget.refundTiny': '{n} tras reembolso',
    'budget.underCap': 'por debajo del tope',
    'budget.overBudget': 'por encima del presupuesto',
    'budget.covered': 'Cubierto',
    'budget.coveredWord': 'cubierto',
    'budget.shortBy': 'Faltan {n}',
    'budget.shortWord': 'faltan {n}',
    'budget.today': 'hoy',
    'budget.tomorrow': 'mañana',
    'budget.inDays': 'en {n} días',
    'budget.todayCap': 'Hoy',
    'budget.cardOn': 'Pago de tarjeta: {d}',
    'budget.transfersHead': 'Transferencias',
    'budget.nextPay': 'Próximo sueldo: {d}',
    'budget.nextPayShort': 'Sueldo: {d}',
    'budget.paychecksHead': 'Sueldos',
    'budget.noTransfers': 'No hace falta transferir',
    'budget.goalStates.clean': 'Sin gastar',
    'budget.goalStates.on-pace': 'A buen ritmo',
    'budget.goalStates.over': 'Excedida',
    'budget.goalStates.under': 'Por debajo',
    'budget.overN': '{n} excedidas',
    'budget.overN1': '1 excedida',
    'budget.goalsN': '{n} metas',
    'budget.goals1': '1 meta',
    'budget.allOnTrack': 'todo en orden',
    'budget.noGoals': 'Sin metas todavía',
    'budget.overWord': 'excedidas',
    'budget.goalsWord': 'metas',
    'budget.newCharge': 'Cargo nuevo: {label}',
    'budget.moreCharges': '+{n} más',
    'budget.states.off.head': 'Necesita la Pi',
    'budget.states.off.line': 'El presupuesto viene del servidor del hub en la Raspberry Pi. Las actualizaciones en vivo están apagadas en esta TV: pon la dirección de la Pi en live.server de config.js.',
    'budget.states.off.short': 'Actualizaciones en vivo apagadas.',
    'budget.states.quiet.head': 'Necesita la Pi',
    'budget.states.quiet.line': 'Esta TV todavía no se conecta al servidor del hub en la Pi. Sigue intentando sin avisar.',
    'budget.states.quiet.short': 'Esperando a la Pi.',
    'budget.states.lost.head': 'No hay conexión con la Pi',
    'budget.states.lost.line': 'Estos mosaicos se llenan en cuanto la Pi vuelva a responder.',
    'budget.states.lost.short': 'Reintentando sin avisar.',
    'budget.states.loading.head': 'Cargando…',
    'budget.states.waiting.head': 'Esperando la app de presupuesto',
    'budget.states.waiting.line': 'La app de presupuesto de la Pi envía aquí sus totales. docs/budget-snapshot.md explica cómo.',
    'budget.states.waiting.short': 'Envía sus totales a la Pi.',
    'budget.states.hidden.head': 'Presupuesto oculto',
    'budget.states.hidden.line': 'widgets.budget.show está apagado en config.js, así que esta TV no muestra cifras del presupuesto.',
    'budget.states.hidden.short': 'Apagado en config.js.',
    'budget.states.guest.head': 'Oculto para invitados',
    'budget.states.guest.line': 'El modo invitados está activado, así que no se muestran cifras del presupuesto. Apágalo en la página del reloj.',
    'budget.states.guest.short': 'Modo invitados activado.',
    'budget.broken': '{title}: no se pudo mostrar',
    // The activity chip when new figures arrive (one line at 22 px in a 3-column tile;
    // its English is in app/motion.js's kinds table).
    'budget.activity': 'Presupuesto nuevo',

    /* ---- Earned vs spent tile (awws-money in app/widgets/awws.js) ----
     * Key 'awws.<path in STRINGS>'; the English is STRINGS at that path in
     * awws.js. Only the Earned vs spent tile and its panel read these for
     * now; the other A World Worth Saving tiles stay English until their
     * keys are added here (the same 'awws.' keys). Amounts keep their US
     * form (thousands is left out). */
    'awws.titles.money': 'Ganado y gastado',
    // Every A World Worth Saving tile's title follows the language (the
    // headers only; the rest of those tiles stays English for now).
    'awws.titles.awws': 'Un mundo que vale la pena salvar',
    'awws.titles.visits': 'Próxima visita',
    'awws.titles.agenda': 'Esta semana',
    'awws.titles.todo': 'Tablero de tareas',
    'awws.titles.outreach': 'Bibliotecarias',
    'awws.titles.pipeline': 'Libros',
    'awws.titles.reach': 'Alcance',
    // Short forms, used only when the full title doesn't fit on one line
    // (Ian, 2026-11-17: the full name whenever it fits, otherwise AWWS;
    // never a half name).
    'awws.titlesShort.awws': 'AWWS',
    'awws.titlesShort.visits': 'Visita',
    'awws.titlesShort.agenda': 'Semana',
    'awws.titlesShort.todo': 'Tareas',
    'awws.titlesShort.money': 'Dinero',
    'awws.dateLong': '{dow} {d} {mon}',
    'awws.dateShort': '{d} {mon}',
    'awws.dateFull': '{dowLong}, {d} de {month}',
    'awws.am': 'a. m.',
    'awws.pm': 'p. m.',
    'awws.asOf': 'datos de: {t}',
    'awws.netWord': 'neto',
    'awws.netSoFar': 'neto hasta hoy',
    'awws.earnedSpent': 'ganado {earned} · gastado {spent}',
    'awws.earnedSpentShort': 'entró {earned} · salió {spent}',
    'awws.earnedOnly': 'ganado {earned}',
    'awws.moneyHeads.net': 'Neto hasta hoy',
    'awws.moneyHeads.months': 'Por mes',
    'awws.moneyHeads.next': 'Próxima transferencia',
    'awws.moneyHeads.tools': 'Claude este mes',
    'awws.earnedWord': 'Ganado',
    'awws.spentWord': 'Gastado',
    'awws.nextTransfer': 'Próxima transferencia: {d}',
    'awws.nextTransferAmt': 'Próxima transferencia: {d} · {n}',
    'awws.moneyStates.hidden.head': 'Dinero oculto',
    'awws.moneyStates.hidden.line': 'showMoney está apagado en config.js, así que esta TV no muestra cifras de dinero.',
    'awws.moneyStates.hidden.short': 'showMoney está apagado en config.js.',
    'awws.moneyStates.guest.head': 'Oculto para invitados',
    'awws.moneyStates.guest.line': 'El modo invitados está activado, así que no se muestran cifras de dinero. Apágalo en la página del reloj.',
    'awws.moneyStates.guest.short': 'Modo invitados activado.',
    'awws.moneyStates.nodata.head': 'Todavía no hay datos de dinero',
    'awws.moneyStates.nodata.line': 'Las cifras llegan con la próxima sincronización que envíe la sección de dinero. docs/awws-snapshot.md explica cómo.',
    'awws.moneyStates.nodata.short': 'Esperando la próxima sincronización.',
    'awws.states.off.head': 'Necesita la Pi',
    'awws.states.off.line': 'Los datos vienen del servidor del hub en la Raspberry Pi. Las actualizaciones en vivo están apagadas en esta TV: pon la dirección de la Pi en live.server de config.js.',
    'awws.states.off.short': 'Actualizaciones apagadas. Pon live.server en config.js.',
    'awws.states.quiet.head': 'Necesita la Pi',
    'awws.states.quiet.line': 'Esta TV todavía no se conecta al servidor del hub en la Pi. Sigue intentando sin avisar. Cómo instalarlo está en pi/README.md.',
    'awws.states.quiet.short': 'Esperando el servidor de la Pi.',
    'awws.states.lost.head': 'No hay conexión con la Pi',
    'awws.states.lost.line': '{live}. Estos mosaicos se llenan en cuanto la Pi vuelva a responder.',
    'awws.states.lost.short': 'Reintentando sin avisar.',
    'awws.states.refused.head': 'Necesita la Pi',
    'awws.states.loading.head': 'Cargando…',
    'awws.states.notsetup.head': 'Sin sincronizar todavía',
    'awws.states.notsetup.line': 'Los datos llegan cuando la sincronización esté lista. docs/awws-snapshot.md explica cómo.',
    'awws.broken': '{title}: no se pudo mostrar',

    /* ---- To-do (app/widgets/todo.js) ----
     * Key 'todo.<path in EN>'; the English is in todo.js. The MUST pill and
     * the strip are small, so keep 'mustPill' to one short word. */
    'todo.title': 'Tareas',
    'todo.sub': 'En esta TV',
    'todo.subSynced': 'Sincronizada',
    'todo.subToSend': 'Guardada aquí, {n} por enviar',
    'todo.subSaved': 'Guardada aquí',
    'todo.heroOne': 'por hacer ahora',
    'todo.heroMany': 'por hacer ahora',
    'todo.allClear': 'Nada pendiente por ahora',
    'todo.metaDone': '{n} hechas hoy',
    'todo.emptyTitle': 'La lista está vacía.',
    'todo.emptyHint': 'Pulsa OK para añadir algo.',
    'todo.more': '+{n} más',
    'todo.overdue': 'Atrasada',
    'todo.dueToday': 'Vence hoy',
    'todo.dueOn': 'Vence el {d}',
    'todo.today': 'Hoy',
    'todo.tomorrow': 'Mañana',
    'todo.dateShort': '{d} {mon}',
    'todo.sections.must': 'Para hoy',
    'todo.sections.optional': 'Si puedes',
    'todo.sections.done': 'Hechas hoy',
    'todo.comingUp': 'Próximamente',
    'todo.mustPill': 'CLAVE',
    'todo.alertOne': '{n} tarea clave para hoy: {t}',
    'todo.alertMany': '{n} tareas clave para hoy: {t}',
    'todo.moveTo.must': 'A Para hoy',
    'todo.moveTo.optional': 'A Si puedes',
    'todo.moveTo.passive': 'A Próximamente',
    'todo.remove': 'Quitar',
    'todo.removeArmed': 'Confirmar',
    'todo.addPlaceholder': 'Añadir una tarea',
    'todo.hintOk': 'OK para escribir',
    'todo.hintTyping': 'Listo o Intro la añade',
    'todo.emptyMust': 'Nada obligatorio para hoy.',
    'todo.emptyNow': 'Nada por ahora.',
    'todo.emptySection': 'Nada aquí.',
    'todo.listFull': 'La lista está llena. Marca o quita algo primero.',
    'todo.warnNoStore': 'Esta TV no guarda la lista. Se queda hasta que se cierre el hub.',
    'todo.warnSaveFail': 'No se pudo guardar el último cambio. Puede que el almacenamiento de esta TV esté lleno.',
    'todo.warnCorrupt': 'No se pudo leer la lista guardada, así que se empezó una nueva.',
    'todo.error': 'La lista de tareas tuvo un problema.',

    /* ---- Motion extras: the activity chips and the About panel's Motion row (app/motion.js) ----
     * The chips' English is in motion.js's kinds table (KIND_TABLE), each row
     * naming its key here; the rest is 'motion.<path in STRINGS>'. Each chip
     * is one line at 22 px in a 3-column tile, so keep these short. A kind
     * may name a key in its widget's own section instead (for example
     * 'budget.activity'). */
    'motion.activity.todo': 'Nueva tarea',
    'motion.activity.calendar': 'Actualizando el calendario',
    'motion.activity.awws': 'Sincronizando datos',
    'motion.activity.nowplaying': 'Canción nueva',
    'motion.working.todo': 'Preparando tareas',
    'motion.working.calendar': 'Revisando el calendario',
    'motion.working.awws': 'Reuniendo datos',
    'motion.extrasOn': 'extras activados',
    'motion.extrasOff': 'extras desactivados ({why})',
    'motion.why.fade': 'modo fundido',
    'motion.why.slow': 'pantalla lenta'
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

  var NAME_LISTS = { days: DAYS, daysShort: DAYS_SHORT, months: MONTHS, monthsShort: MONTHS_SHORT };

  function isList(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function localize(english, prefix, l) {
    l = pickLang(l);
    function walk(src, path) {
      if (typeof src === 'string') {
        return l === 'es' && ES.hasOwnProperty(path) ? ES[path] : src;
      }
      if (isList(src)) {
        var name = path.substring(path.lastIndexOf('.') + 1);
        var names = NAME_LISTS.hasOwnProperty(name) ? NAME_LISTS[name][l] : null;
        if (l !== 'en' && names && names.length === src.length) return names.slice();
        return src.slice();
      }
      if (src && typeof src === 'object') {
        var out = {};
        for (var k in src) if (src.hasOwnProperty(k)) out[k] = walk(src[k], path + '.' + k);
        return out;
      }
      return src;
    }
    return walk(english, prefix);
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
    // localize(english, 'budget'): a copy of a widget's STRINGS in the hub's
    // language. Each text at path p becomes t('budget.' + p, its English);
    // lists of seven or twelve names named days/daysShort/months/monthsShort
    // become this file's lists. English (or no Spanish key) keeps the text.
    localize: localize,
    strings: { es: ES }
  };
})();
