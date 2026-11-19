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

    /* ---- Ambience: the room's lights (app/widgets/ambience.js) ----
     * Key 'ambience.<name>'; the English is in ambience.js (T). Light, scene
     * and mood names come from the Pi's settings and are never translated.
     * {names} is one name, "A y B" or "A y 2 más" (ambience.and, .andMore). */
    'ambience.title': 'Ambiente',
    'ambience.lightsOn': 'Luces encendidas',
    'ambience.lightsOff': 'Luces apagadas',
    'ambience.someOn': '{n} de {m} encendidas',
    'ambience.noLightsShort': 'Aún sin luces',
    'ambience.setUp': 'Configura las luces',
    'ambience.badge.setUp': 'Configurar',
    'ambience.noHa': 'Home Assistant aún no está conectado',
    'ambience.noLights': 'Aún no hay luces agregadas',
    'ambience.setUpHow': 'En la Pi: agrega HA_TOKEN a pi/.env y luego ./hub ambience set con tus luces (consulta pi/README.md).',
    'ambience.lastKnown': 'Último dato',
    'ambience.haAway': 'Home Assistant no responde',
    'ambience.haAuth': 'Home Assistant rechazó el token',
    'ambience.didntAnswer': '{names} no respondió',
    'ambience.didntAnswerMany': '{names} no respondieron',
    'ambience.notAnswering': '{name} no responde',
    'ambience.manyNotAnswering': '{n} luces no responden',
    'ambience.and': '{a} y {b}',
    'ambience.andMore': '{a} y {n} más',
    'ambience.scenes': 'Escenas',
    'ambience.lights': 'Iluminación del cuarto',
    'ambience.wall': 'Muro de plantas',
    'ambience.wallGone': 'no responde',
    'ambience.sending': 'Enviando…',
    'ambience.onNow': 'Activa ahora',
    'ambience.sceneOn': '{name} está activa',
    'ambience.on': 'Encendido',
    'ambience.off': 'Apagada',
    'ambience.pct': '{n} %',
    'ambience.gone': 'No responde',
    'ambience.lightGone': '{name} no responde.',
    'ambience.moodOn': 'Muro de plantas: {name}',
    'ambience.moodGone': 'El muro de plantas no respondió.',
    'ambience.hintScene': 'OK aplica la escena',
    'ambience.hintLight': '◀ ▶ más tenue o más brillante · OK la enciende o la apaga',
    'ambience.hintSwitch': 'OK lo enciende o lo apaga',
    'ambience.hintMood': 'OK cambia el muro de plantas',
    'ambience.hintGone': 'No responde, así que no se le puede enviar nada',
    'ambience.errPi': 'No se pudo conectar con la Pi. No cambió nada.',
    'ambience.errBusy': 'Demasiadas pulsaciones. Inténtalo de nuevo en un momento.',
    'ambience.errHa': 'Home Assistant aún no está conectado.',
    'ambience.errGone': 'Eso ya no está guardado en la Pi.',
    'ambience.errFailed': 'Ninguna luz respondió. No cambió nada.',
    'ambience.errRefused': 'Home Assistant lo rechazó.',
    'ambience.liveOff': 'Las actualizaciones en vivo están apagadas',
    'ambience.liveOffHint': 'Ambiente necesita la Pi. Revisa HUB_CONFIG.live en config.js.',
    'ambience.waiting': 'Esperando a la Pi',
    'ambience.waitingHint': 'Las luces vienen de la Pi.',
    'ambience.offline': 'No se puede conectar con la Pi',
    'ambience.update': 'La Pi necesita una actualización',
    'ambience.updateHint': 'En la Pi: git pull y luego docker compose restart hub.',
    'ambience.broken': 'No se pudo mostrar Ambiente.',
    /* ---- All sounds, the test widget (app/widgets/allsounds.js) ----
     * The source chip ("TuneIn", "Spotify") and the speaker's name come from
     * the Pi as they are. The badge words are in capitals: a word or two. */
    'allsounds.title': 'Todo lo que suena',
    'allsounds.playing': 'Sonando ahora',
    'allsounds.paused': 'En pausa',
    'allsounds.on': 'En {device}',
    'allsounds.unknown': 'Algo está sonando',
    'allsounds.unknownPaused': 'Algo está en pausa',
    'allsounds.stale': 'Puede que no esté al día',
    'allsounds.idle': 'Nada sonando',
    'allsounds.idleHint': 'Pon algo en un Echo o en Spotify y aparecerá aquí.',
    'allsounds.notset': 'Aún sin configurar',
    'allsounds.notsetHint': 'Agrega un token de Home Assistant (HA_TOKEN) a pi/.env en la Pi.',
    'allsounds.error': 'No se puede conectar con Home Assistant',
    'allsounds.errorHint': 'Lo sigue intentando por su cuenta.',
    'allsounds.errorAuth': 'Home Assistant rechazó el token. Crea uno nuevo y ponlo en pi/.env.',
    'allsounds.waiting': 'Esperando a la Pi',
    'allsounds.waitingHint': 'Todo lo que suena viene de la Pi.',
    'allsounds.offline': 'No se puede conectar con la Pi',
    'allsounds.offlineHint': 'Lo que suena vuelve a aparecer cuando la Pi regrese.',
    'allsounds.update': 'La Pi necesita una actualización',
    'allsounds.updateHint': 'En la Pi: git pull y luego docker compose restart hub.',
    'allsounds.liveOff': 'Las actualizaciones en vivo están apagadas',
    'allsounds.liveOffHint': 'Todo lo que suena necesita la Pi. Revisa HUB_CONFIG.live en config.js.',
    'allsounds.broken': 'No se pudo mostrar Todo lo que suena.',
    'allsounds.badge.idle': 'En silencio',
    'allsounds.badge.notset': 'Sin configurar',
    'allsounds.badge.error': 'Sin conexión',
    'allsounds.badge.waiting': 'Esperando',
    'allsounds.badge.offline': 'Sin la Pi',
    'allsounds.badge.update': 'Necesita la Pi',

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
    'budget.planHead': 'Pagos',
    'budget.autoWord': 'Faltan {n}',
    'budget.autoNote': 'para el {d}, cubierto con pago automático',
    'budget.autoNoteShort': 'cubierto con pago automático',
    'budget.autoNoteTiny': 'pago automático',
    'budget.autoSolo': 'automático',
    'budget.autoPay': 'automático',
    'budget.autoShortNote': 'faltan {n} aun con pago automático',
    'budget.autoShortNoteShort': 'faltan {n} con pago aut.',
    'budget.receipt.lines.checking': 'En la cuenta corriente ahora',
    'budget.receipt.lines.paychecks': 'Sueldos antes del {d}',
    'budget.receipt.lines.billsBefore': 'Facturas antes del {d}',
    'budget.receipt.lines.cardsToday': 'Tarjetas hoy, con lo pendiente',
    'budget.receipt.lines.cardCharges': 'Cargos fijos en las tarjetas antes del {d}',
    'budget.receipt.lines.billsAfter': 'Facturas del {d} al día de pago {e}',
    'budget.receipt.lines.billsAfterNo': 'Facturas del {d} al próximo día de pago',
    'budget.receipt.lines.buys': 'Compras previstas',
    'budget.receipt.bottom': 'Queda para gastar',
    'budget.receipt.bottomNote': 'Lo que tendrá la cuenta justo antes de tu sueldo del {e}, tras las facturas y pagar hoy el saldo completo de las tarjetas. Cada cargo nuevo sale de aquí.',
    'budget.receipt.bottomNoteNo': 'Lo que tendrá la cuenta justo antes de tu próximo sueldo, tras las facturas y pagar hoy el saldo completo de las tarjetas. Cada cargo nuevo sale de aquí.',
    'budget.receipt.miniBills': 'Tarjetas y facturas hasta el {e}',
    'budget.receipt.miniBillsNo': 'Tarjetas y facturas al próximo pago',
    'budget.receipt.heroLeft': 'Quedan {n} para gastar',
    'budget.receipt.heroDay': 'unos {n} al día',
    'budget.receipt.heroShort': 'Faltan {n} el {d}',
    'budget.receipt.heroShortPlain': 'Faltan {n}',
    'budget.receipt.heroByAutopay': 'lo cubre el pago automático',
    'budget.receipt.heroEven': 'aun con pago automático',
    'budget.receipt.noPay': 'Ninguno antes del {d}. Siguiente: {n}',
    'budget.receipt.noPayNext': 'Ninguno antes del {d}',
    'budget.receipt.planHead': 'Plan de pagos',
    'budget.receipt.payOn': 'Paga el {d}',
    'budget.receipt.leaveFor': 'Deja para el pago automático',
    'budget.receipt.planNote': 'Un plan para leer: aquí no se paga ninguna tarjeta ni se mueve dinero.',
    'budget.receipt.okHint': 'OK para ver detalles',
    'budget.receipt.backHint': 'Atrás para volver al recibo',
    'budget.receipt.nextPay': 'Siguiente sueldo {d} · {n}',
    'budget.receipt.checkingNote': 'Saldo disponible, con los cargos pendientes ya descontados.',
    'budget.receipt.checkingAsOf': 'Datos de las {t}.',
    'budget.receipt.payNote': 'El menor de los últimos tres depósitos.',
    'budget.receipt.buysNote': 'Se editan en el sitio del presupuesto.',
    'budget.receipt.newTag': 'nueva',
    'budget.receipt.total': 'Total',
    'budget.receipt.owesBal': 'Saldo {n}',
    'budget.receipt.owesPending': 'pendiente {n}',
    'budget.receipt.owesComing': 'más {n} en cargos fijos antes del {d}',
    'budget.receipt.cardAutopay': 'Pago automático {d}',
    'budget.receipt.cardNoAutopay': 'Sin día de pago automático',
    'budget.receipt.cardPays': 'Pagas {n} el {d}',
    'budget.receipt.cardAuto': 'El pago automático toma {n}',
    'budget.receipt.formula': 'En la cuenta, más sueldos, menos facturas, tarjetas, cargos y compras:',
    'budget.receipt.onCard': 'en {card}',
    'budget.receipt.empty': 'Nada aquí.',
    'budget.usingAutopay': 'según los días de pago automático',
    'budget.usingAutopayShort': 'pago automático',
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

    /* ---- Budget lab: the pace streak tile and the cap panel (app/widgets/budget-lab.js) ----
     * Key 'budgetLab.<path in STRINGS>'; the English is STRINGS at that path
     * in budget-lab.js. Amounts keep their US form ($80) and merchant names
     * stay as the budget app sends them. Lines that can be short on a tile
     * have a short form (the ...Short keys), picked when the long one does
     * not fit; the panel's labels wrap on their own line instead. */
    'budgetLab.titles.lab': 'Laboratorio',
    'budgetLab.titlesShort.lab': 'Lab',
    'budgetLab.dateShort': '{d} {mon}',
    'budgetLab.daysUnder': 'días bajo el tope',
    'budgetLab.dayUnder': 'día bajo el tope',
    'budgetLab.under': 'bajo el tope',
    'budgetLab.overYesterday': 'Ayer te pasaste',
    'budgetLab.overShort': 'Te pasaste',
    'budgetLab.starting': 'Empieza tu racha',
    'budgetLab.startingShort': 'Racha nueva',
    'budgetLab.yUnder': 'Ayer {spent} de {cap}, {by} por debajo',
    'budgetLab.yOver': 'Ayer {spent} de {cap}, {by} de más',
    'budgetLab.yShort': 'Ayer {spent} de {cap}',
    'budgetLab.yTiny': '{spent} de {cap}',
    'budgetLab.yNoCap': 'Ayer {spent}, sin tope registrado',
    'budgetLab.yNoCapShort': 'Ayer {spent}',
    'budgetLab.moves.moveMoney': 'Al pago de tarjeta le faltan {n} aun gastando $0 al día: pasa {n} a la cuenta corriente antes del {d}',
    'budgetLab.moves.moveMoneyShort': 'Pasa {n} a la cuenta antes del {d}',
    'budgetLab.moves.skipMerchant': 'Ahórrate {n} en {merchant} para cubrir el {d}',
    'budgetLab.moves.skipMerchantShort': 'Ahórrate {n} en {merchant}',
    'budgetLab.moves.spendLess': 'Gasta {n} menos al día para cubrir el {d}',
    'budgetLab.moves.spendLessShort': 'Gasta {n} menos al día',
    'budgetLab.moves.newStreak': 'Quédate bajo {cap} hoy para empezar otra racha',
    'budgetLab.moves.newStreakShort': 'Quédate bajo {cap} hoy',
    'budgetLab.moves.keepStreak': 'Quédate bajo {cap} hoy y van {n} días seguidos',
    'budgetLab.moves.keepStreak1': 'Quédate bajo {cap} hoy para empezar una racha',
    'budgetLab.moves.keepStreakShort': 'Quédate bajo {cap} hoy',
    'budgetLab.tileADay': 'al día',
    'budgetLab.tileShortFor': 'faltan para el {d}',
    'budgetLab.tileShortWord': 'faltan',
    'budgetLab.tileKeeps': 'Cubre el pago del {d}',
    'budgetLab.tileKeepsShort': 'Cubierto',
    'budgetLab.tileAuto': 'Falta para el {d}: pago automático',
    'budgetLab.tileAutoShort': 'Con pago automático',
    'budgetLab.streakDays': '{n} días bajo el tope',
    'budgetLab.streakDay': '{n} día bajo el tope',
    'budgetLab.stayToday': 'Quédate bajo {cap} hoy',
    'budgetLab.stayMakeIt': 'Quédate bajo {cap} hoy para llegar a {n}',
    'budgetLab.moves.skipOne': '{move} · sáltate un pedido de {merchant}',
    'budgetLab.outcomeSpare': '{d}: cubierto, sobran {n}',
    'budgetLab.outcomeZero': '{d}: cubierto, sin sobrante',
    'budgetLab.outcomeShort': '{d}: faltan {n}',
    'budgetLab.spareShort': 'Sobran {n}',
    'budgetLab.zeroShort': 'Cubierto',
    'budgetLab.outcomeOnTrack': '{d}: vas bien con {cap} al día',
    'budgetLab.onTrackShort': 'Bien con {cap}/día',
    'budgetLab.shortShort': 'Faltan {n}',
    'budgetLab.today': 'hoy',
    'budgetLab.tomorrow': 'mañana',
    'budgetLab.inDays': 'en {n} días',
    'budgetLab.covered': 'Cubierto',
    'budgetLab.shortBy': 'Faltan {n}',
    'budgetLab.capLabel': 'Tope diario',
    'budgetLab.roomNote': 'El mosaico Margen diario usa {n} al día',
    // The panel opens at full screen and is read from the couch: the arrows
    // are drawn, these are the words around them (the diacritics matter, so
    // the line heights leave room).
    'budgetLab.capHint': 'Mantén \u25C0 \u25B6 para cambiar tu tope diario',
    'budgetLab.keyCap': '\u25C0 \u25B6 cambiar \u00B7 OK guardar',
    'budgetLab.keyCut': '\u25C0 \u25B6 recortar \u00B7 OK guardar',
    'budgetLab.keyOk': 'OK',
    'budgetLab.keyMore': 'Abajo: comercios',
    'budgetLab.heroSpare': '{d}: cubierto, sobran {n}',
    'budgetLab.heroSpareShort': 'Sobran {n}',
    'budgetLab.heroZero': '{d}: cubierto, sobran $0',
    'budgetLab.heroZeroShort': 'Cubierto',
    'budgetLab.heroOnTrack': '{d}: vas bien con {cap} al día',
    'budgetLab.heroOnTrackShort': 'Bien con {cap}/día',
    'budgetLab.heroShort': '{d}: faltan {n}',
    'budgetLab.heroShortShort': 'Faltan {n}',
    'budgetLab.autoHead': 'El {d} faltan {n}, así que este plan cuenta con los días de pago automático hasta el {a}',
    'budgetLab.autoHeadNoDate': 'El {d} faltan {n}, así que este plan cuenta con los días de pago automático',
    'budgetLab.autoHeadShort': 'El {d} falta dinero; se usan los días de pago automático',
    'budgetLab.refCalc': 'Calculado {n} al día',
    'budgetLab.refSaved': 'Guardado {n} al día',
    'budgetLab.refNoSaved': 'Aún sin tope guardado',
    'budgetLab.usingCalc': 'Usando el tope calculado',
    'budgetLab.reset': 'Volver al tope calculado',
    'budgetLab.toastSaved': 'Tope guardado: {n} al día (se recalcula cada mañana)',
    'budgetLab.shortHead': 'Te faltan {n} para el {d} aun con $0 al día',
    'budgetLab.shortDo': 'Qué hacer',
    'budgetLab.shortWhy': 'Un tope diario solo importa cuando el pago de tarjeta está cubierto, así que todavía no hay nada que fijar.',
    'budgetLab.shortWhyShort': 'No hay tope que fijar hasta cubrir el pago de tarjeta.',
    'budgetLab.soFarShort': '{merchant} · {mtd} este mes',
    'budgetLab.cutRow': '{merchant} · {mtd} en lo que va de mes',
    'budgetLab.cutRowShort': '{merchant}',
    'budgetLab.cutAmount': 'recorte {cut}',
    'budgetLab.cutsAfter': 'Los recortes se abren cuando vuelvas a estar por encima de $0 al día.',
    'budgetLab.cutsAfterShort': 'Los recortes se abren por encima de $0 al día.',
    'budgetLab.chartHead': 'Recorrido hasta el {d}, {away}',
    'budgetLab.chartHeadMid': 'Recorrido hasta el {d}',
    'budgetLab.gapZero': 'Cubierto, sobran $0',
    'budgetLab.aDay': 'al día',
    'budgetLab.paceHead': 'Ritmo',
    'budgetLab.noLab': 'El pago de tarjeta necesita un día de pago en la app de presupuesto',
    'budgetLab.cardToday': 'Hoy es el pago de tarjeta: {state}',
    // Row 6, the merchants' cut sliders, and row 7, Put it somewhere. Merchant
    // names stay as sent; AWWS is a name and stays AWWS.
    'budgetLab.merchantsHead': 'Comercios',
    'budgetLab.merchantsSub': 'Recorta lo que te saltarías antes del {d}',
    'budgetLab.merchantsSubShort': 'Recorta lo que te saltarías',
    'budgetLab.soFar': '{merchant} · {mtd} en lo que va de mes',
    'budgetLab.cutsLocked': 'No queda nada que recortar: el tope está en $0 al día',
    'budgetLab.cutsLockedShort': 'No queda nada que recortar',
    'budgetLab.cutsTogether': 'Entre los cinco recortas como mucho {n} (un pedido compartido cuenta una vez)',
    'budgetLab.cutsTogetherShort': 'Entre los cinco: como mucho {n}',
    'budgetLab.destHead': 'A dónde va',
    'budgetLab.dest.card': 'Pago de tarjeta',
    'budgetLab.dest.savings': 'Ahorro',
    'budgetLab.dest.awws': 'AWWS',
    'budgetLab.dest.buffer': 'Colchón',
    'budgetLab.dest.extra': 'Extra al ahorro',
    'budgetLab.destOf': '{funded} de {planned}',
    'budgetLab.destCovered': 'Cubierto',
    'budgetLab.destOnTrack': 'Vas bien',
    'budgetLab.destShortBy': '{funded} de {planned} · faltan {short}',
    'budgetLab.destExtra': '+{n} más al ahorro',
    // The runway chart at full screen. The weekdays come from this file's
    // day lists; the gap label is the chart's one figure.
    'budgetLab.chartHeadShort': 'Recorrido',
    'budgetLab.chartRoom': 'Margen libre',
    'budgetLab.chartOwed': 'Gasto con este tope',
    'budgetLab.chartOwedShort': 'Gasto',
    'budgetLab.gapSpare': 'Cubierto, sobran {n}',
    'budgetLab.gapSpareShort': 'Sobran {n}',
    'budgetLab.gapZeroShort': 'Cubierto',
    'budgetLab.gapOnTrack': 'Vas bien, sobran $0',
    'budgetLab.gapOnTrackShort': 'Vas bien',
    'budgetLab.gapShort': 'Faltan {n}',
    'budgetLab.gapShortShort': 'Faltan {n}',

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
    'todo.yesterday': 'Ayer',
    'todo.emptyTitle': 'La lista está vacía.',
    'todo.emptyHint': 'Pulsa OK para añadir algo.',
    'todo.more': '+{n} más',
    'todo.overdue': 'Atrasada',
    'todo.dueToday': 'Vence hoy',
    'todo.dueOn': 'Vence el {d}',
    'todo.today': 'Hoy',
    'todo.tomorrow': 'Mañana',
    'todo.dateShort': '{d} {mon}',
    'todo.inDays': 'en {n} días',
    'todo.sections.must': 'Para hoy',
    'todo.sections.optional': 'Si puedes',
    'todo.sections.done': 'Completadas',
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

    /* ---- Entertainment's Schedule (app/widgets/shows.js) ----
     * Key 'shows.<path in STRINGS>'; the English is STRINGS there. Show
     * names, episode names and app names stay as sent. Times follow the
     * Clock tile's 12/24 choice; day and month names come from the lists
     * below. */
    'shows.title': 'Programación',
    'shows.entry': 'Programación',
    'shows.entrySub': 'Tus series',
    'shows.tabs.today': 'Hoy',
    'shows.tabs.week': 'Esta semana',
    'shows.tabs.month': 'Este mes',
    'shows.tabs.soon': 'Pronto',
    'shows.sample': 'Ejemplo',
    'shows.todayMark': 'Hoy',
    'shows.weekOf': 'Semana del {range}',
    'shows.rangeSame': '{a} al {b} de {mon}',
    'shows.rangeTwo': '{a} de {monA} al {b} de {monB}',
    'shows.dayDate': '{d} de {mon}',
    'shows.code': 'T{s} E{e}',
    'shows.codeRange': 'T{s} E{e}–{f}',
    'shows.special': 'Especial',
    'shows.am': 'a. m.',
    'shows.pm': 'p. m.',
    'shows.aired': 'Emitido',
    'shows.out': 'Ya disponible',
    'shows.streamsOn': 'Disponible en {service}',
    'shows.airsLive': 'En vivo en {channel} · {when}',
    'shows.airedLive': 'Se emitió en vivo en {channel} · {when}',
    'shows.newToday': 'Nuevo hoy: {name}',
    'shows.watched': 'Visto',
    'shows.inMin': 'en {n} min',
    'shows.now': 'Ahora',
    'shows.premiere': 'Estreno',
    'shows.watchOn': 'Ver en {service}',
    'shows.alsoOn': 'También en {service}',
    'shows.via': 'vía {service}',
    'shows.noService': 'Sin app',
    'shows.soonHead': 'Pronto',
    'shows.returns': 'Temporada {n} regresa el {date}',
    'shows.returnsNoDate': 'Temporada {n} · sin fecha aún',
    'shows.newSeason': 'Temporada nueva · sin fecha aún',
    'shows.days': 'días',
    'shows.day': 'día',
    'shows.todayChip': 'hoy',
    'shows.yourShows': 'Tus series',
    'shows.running': 'Sigue en emisión',
    'shows.ended': 'Terminada',
    'shows.tbd': 'Sigue · sin decidir',
    'shows.nextLine': 'Próximo: {code} · {when}',
    'shows.nothingToday': 'Hoy no se emite nada.',
    'shows.nothingWeek': 'Esta semana no se emite nada.',
    'shows.nothingMonth': 'No se emite nada más este mes.',
    'shows.nothingSoon': 'Todavía no hay fechas de temporada.',
    'shows.nextAiring': 'Lo próximo: {name} · {when}',
    'shows.tonight': 'Esta noche: {name} {time}',
    'shows.todayLine': 'Hoy: {name} {time}',
    'linktest.stale': 'El ayudante de la TV está desactualizado. Desconecta la TV 30 segundos y vuelve a intentarlo.',
    'linktest.cantOpen': 'No se pudo abrir: {error}',
    'linktest.lastError': 'Último error: {error}',
    'shows.finishTitle': '¿Lo terminaste?',
    'shows.finishWatched': 'Visto',
    'shows.finishNotYet': 'Todavía no',
    'shows.toCheck': '{n} por revisar',
    'shows.started': 'empezó {when}',
    'shows.startedOn': 'empezó el {day}',
    'shows.startedLastNight': 'anoche',
    'shows.startedTonight': 'esta noche',
    'shows.startedToday': 'hoy más temprano',
    'shows.startedYesterday': 'ayer',
    'shows.markWatched': 'Marcar como visto',
    'shows.unmark': 'Quitar la marca de visto',
    'shows.opensHome': '{service} se abre en su pantalla de inicio',
    'shows.searchFor': 'Busca: {name}',
    'shows.notInstalled': '{service} no está en esta TV.',
    'shows.noApp': '{name} no tiene app. Dale una en la Pi: ./hub shows add "{name}" --service Netflix',
    'shows.stillLooking': 'Todavía busco tus apps. Inténtalo en un segundo.',
    'shows.stale': 'No se pudo llegar a TVmaze; esta es la última copia buena.',
    'shows.asOf': 'datos de: {when}',
    'shows.states.off.head': 'La programación necesita la Pi',
    'shows.states.off.line': 'Las series vienen del servidor del hub en la Raspberry Pi. Las actualizaciones en vivo están apagadas en esta TV: pon la dirección de la Pi en live.server de config.js.',
    'shows.states.quiet.head': 'La programación necesita la Pi',
    'shows.states.quiet.line': 'Esta TV todavía no se conecta al servidor del hub en la Pi. Sigue intentando sin avisar. Cómo instalarlo está en pi/README.md.',
    'shows.states.lost.head': 'No hay conexión con la Pi',
    'shows.states.lost.line': '{live}. La programación se llena en cuanto la Pi vuelva a responder.',
    'shows.states.old.head': 'La programación necesita una Pi más nueva',
    'shows.states.old.line': 'El servidor del hub en la Pi todavía no envía series. Actualízalo (pi/README.md) y reinícialo.',
    'shows.states.loading.head': 'Cargando…',
    'shows.states.empty.head': 'Todavía no hay series en la lista',
    'shows.states.empty.line': 'Agrega una en la Pi: ./hub shows add "Stick" --service "Apple TV"',
    'shows.states.waiting.head': 'Buscando las series',
    'shows.states.waiting.line': 'La Pi le pregunta a TVmaze por cada serie. Tarda unos segundos.',
    'shows.states.error.head': 'No se pudo llegar a TVmaze',
    'shows.states.error.line': 'La Pi vuelve a intentarlo cada 6 horas, o ahora con ./hub shows refresh.',
    /* ---- Plant sun (app/widgets/sunpath.js) ----
     * Key 'sunpath.<path in EN>'; the English is EN in sunpath.js. Times are
     * "6:05 p. m." (am/pm below, held on one line), dates "14 mar" (month
     * names from the lists below). Plant names come from config.js and stay
     * as written. {t} {d} {plant} {list} {r} {g} {alt} {az} {n} {a} {b}
     * are filled in. The strip's line and the 1-column words are short on
     * purpose. */
    'sunpath.title': 'Sol en las plantas',
    // Short form: only when the title doesn't fit the tile on one line.
    'sunpath.titleShort': 'Sol',
    'sunpath.badge': 'Estimado',
    'sunpath.am': 'a. m.',
    'sunpath.pm': 'p. m.',
    'sunpath.dateShort': '{d} {mon}',
    'sunpath.nowHead': 'Sol en las plantas ahora',
    'sunpath.nowShort': 'Sol ahora',
    'sunpath.until': 'hasta las {t}',
    'sunpath.untilWord': 'hasta las',
    'sunpath.nextToday': 'Próximo sol a las {t}',
    'sunpath.nextTomorrow': 'Próximo sol mañana, {t}',
    'sunpath.nextDate': 'Próximo sol el {d}, {t}',
    'sunpath.nextDateShort': 'Próximo sol: {d}',
    'sunpath.nextWord': 'Próximo sol',
    'sunpath.nextTomorrowWord': 'Próximo sol mañana',
    'sunpath.atTime': 'a las {t}',
    'sunpath.noneHead': 'Sin sol directo a la vista',
    'sunpath.noneLine': 'No en el próximo año con estos ajustes.',
    'sunpath.one.now': 'Ahora',
    'sunpath.one.tomorrow': 'Mañana',
    'sunpath.one.none': 'Nada',
    'sunpath.today': 'Hoy',
    'sunpath.todayNone': 'Hoy no hay sol en las plantas',
    'sunpath.growUntil': 'Las luces de cultivo hacen el trabajo hasta entonces',
    'sunpath.keepOut': 'Aparta {plant} del rayo de sol.',
    'sunpath.range': '{a} a {b}',
    'sunpath.none': 'Nada',
    'sunpath.table.day': 'Día',
    'sunpath.table.window': 'En la ventana',
    'sunpath.table.plants': 'En las plantas',
    'sunpath.panel.time': 'Hora',
    'sunpath.panel.day': 'Día',
    'sunpath.panel.views.plan': 'Sala',
    'sunpath.panel.views.arc': 'Arco del sol',
    'sunpath.panel.views.table': 'Estaciones',
    'sunpath.status.lit': 'Sol directo en la pared. Aparta {plant} del rayo de sol.',
    'sunpath.status.room': 'Sol dentro de la sala, no en las plantas.',
    'sunpath.status.down': 'El sol ya se puso.',
    'sunpath.status.side': 'Fuera de la vista de la ventana: no entra sol directo.',
    'sunpath.status.roof': 'Por encima del techo del balcón: no entra sol directo.',
    'sunpath.status.at': 'Sol a {alt}° de altura, rumbo {az}°',
    'sunpath.plan.window': 'Ventana',
    'sunpath.plan.wall': 'Pared de las plantas',
    'sunpath.plan.plants': 'Plantas',
    'sunpath.plan.outside': 'Afuera',
    'sunpath.plan.north': 'N',
    'sunpath.plan.ft': '{n} pies',
    'sunpath.arc.view': 'Vista de la ventana',
    'sunpath.arc.roof': 'Techo sobre {r}°',
    'sunpath.arc.w': 'O',
    'sunpath.arc.nw': 'NO',
    'sunpath.arc.n': 'N',
    'sunpath.notes.plantsHead': 'Las plantas',
    'sunpath.notes.plants': '{list}. Aparta {plant} del rayo de sol de las tardes de verano.',
    'sunpath.notes.growHead': 'Luces de cultivo',
    'sunpath.notes.grow': 'De noviembre a febrero no llega sol directo a la pared: los focos de espectro completo de 11 W hacen el trabajo esos meses.',
    'sunpath.notes.placeTag': 'Provisional',
    'sunpath.notes.place': 'Ángulo del techo ({r}°) y lugar de las plantas ({a} a {b} pies): estimados.',

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
    'motion.extrasLight': 'extras: solo avisos y luz ({why})',
    'motion.why.fade': 'modo fundido',
    'motion.why.slow': 'pantalla lenta',

    /* ---- Characters: the About panel's Characters group (app/agents.js) ----
     * 'agents.<path in STRINGS>'; {who} is a character's name (never
     * translated), {where} a tile's title as shown. */
    'agents.about.group': 'Personajes',
    'agents.about.now': 'Ahora',
    'agents.about.seen': 'Pasadas',
    'agents.about.drawing': 'Dibujo',
    'agents.now': '{who}, en {where}',
    'agents.none': 'ninguno',
    'agents.loading': 'cargando imágenes',
    'agents.seenOne': '1 pasada',
    'agents.seenMany': '{n} pasadas',
    'agents.drawOn': 'activado',
    'agents.why.fade': 'modo fundido',
    'agents.why.slow': 'pantalla lenta',
    'agents.why.calm': 'se pidió menos movimiento',
    'agents.offWhy': 'desactivado ({why})',
    'agents.offConfig': 'desactivado (configuración)',
    'agents.offQuery': 'desactivado (?agent=off)',
    'agents.offUnknown': 'desactivado (no hay un personaje llamado {who})',
    'agents.offChips': 'desactivado (los avisos están apagados)',
    'agents.offFailed': 'desactivado (no cargaron las imágenes; se reintenta en 10 min)',
    'agents.tile': 'un mosaico'
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
