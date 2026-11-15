/*
 * White line icons, 24x24, drawn with the current text color.
 * Use them with el.innerHTML = HUB_ICONS.name inside a sized element.
 */
var HUB_ICONS = (function () {
  'use strict';
  function svg(body) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  return {
    tv: svg('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
    'sun-cloud': svg('<path d="M10 2.5v1.5"/><path d="M3.6 5.1l1.1 1.1"/><path d="M2 11.5h1.5"/>' +
      '<path d="M16.4 5.1l-1.1 1.1"/><path d="M6.6 12.4a3.6 3.6 0 0 1 6.5-3.3"/>' +
      '<path d="M17.5 20.5h-8a3.5 3.5 0 1 1 .9-6.9 4.5 4.5 0 0 1 8.4 1.5 2.7 2.7 0 0 1-1.3 5.4z"/>'),
    'check-list': svg('<path d="M3.5 6l1.5 1.5 2.5-2.5"/><path d="M3.5 12l1.5 1.5 2.5-2.5"/>' +
      '<path d="M3.5 18l1.5 1.5 2.5-2.5"/><path d="M11 6.5h9.5"/><path d="M11 12.5h9.5"/><path d="M11 18.5h9.5"/>'),
    calendar: svg('<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M16 2.5v4"/><path d="M8 2.5v4"/>' +
      '<path d="M3 10h18"/><path d="M7.5 14h.01"/><path d="M12 14h.01"/><path d="M16.5 14h.01"/><path d="M7.5 17.5h.01"/><path d="M12 17.5h.01"/>'),
    music: svg('<path d="M9 18V5.5l11-2v12.5"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    globe: svg('<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/>' +
      '<path d="M12 2.5a14.5 14.5 0 0 1 3.8 9.5 14.5 14.5 0 0 1-3.8 9.5 14.5 14.5 0 0 1-3.8-9.5A14.5 14.5 0 0 1 12 2.5z"/>'),
    sparkle: svg('<path d="M11 3l1.8 4.9L17.5 9.7l-4.7 1.8L11 16.5l-1.8-5L4.5 9.7l4.7-1.8z"/>' +
      '<path d="M18.5 14.5l.8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9z"/>'),
    camera: svg('<path d="M21.5 18.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h3.2L9.5 4h5l1.8 2.5h3.2a2 2 0 0 1 2 2z"/>' +
      '<circle cx="12" cy="13" r="3.8"/>'),
    clock: svg('<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>'),
    expand: svg('<path d="M14.5 3.5h6v6"/><path d="M9.5 20.5h-6v-6"/><path d="M20.5 3.5l-7 7"/><path d="M3.5 20.5l7-7"/>'),
    shrink: svg('<path d="M4.5 13.5h6v6"/><path d="M19.5 10.5h-6v-6"/><path d="M13.5 10.5l7-7"/><path d="M3.5 20.5l7-7"/>'),
    back: svg('<path d="M19.5 12h-15"/><path d="M11 18.5L4.5 12 11 5.5"/>'),
    grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/>' +
      '<rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>')
  };
})();
