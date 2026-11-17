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

  /* Weather icons. Every cloud is the same shape (three bumps on a flat
     base), only moved and scaled, so the set reads as one family. Accent
     parts sit in a wx-a-* group that weather.css colors; without it they
     stay white. */
  var CLOUD = '<path d="M6.75 18.75H16.75A4 4 0 1 0 16.5 10.76A5.25 5.25 0 1 0 6.11 11.81A3.5 3.5 0 0 0 6.75 18.75z"/>';
  // Raised, to leave room for rain, snow, lightning or fog underneath.
  var CLOUD_UP = '<path d="M7.59 13.64H15.99A3.36 3.36 0 1 0 15.78 6.93A4.41 4.41 0 1 0 7.05 7.81A2.94 2.94 0 0 0 7.59 13.64z"/>';
  // Low on the right, in front of a sun or moon.
  var CLOUD_PART = '<path d="M11.23 19.36H18.83A3.04 3.04 0 1 0 18.64 13.29A3.99 3.99 0 1 0 10.74 14.09A2.66 2.66 0 0 0 11.23 19.36z"/>';

  var weather = {
    'wx-clear-day': svg('<g class="wx-a-sun"><circle cx="12" cy="12" r="4.25"/>' +
      '<path d="M18.9 12H21.4M16.88 16.88L18.65 18.65M12 18.9V21.4M7.12 16.88L5.35 18.65M5.1 12H2.6M7.12 7.12L5.35 5.35M12 5.1V2.6M16.88 7.12L18.65 5.35"/></g>'),
    'wx-clear-night': svg('<g class="wx-a-moon"><path d="M19.44 13.76A8.25 8.25 0 1 1 10.24 4.56A6.6 6.6 0 0 0 19.44 13.76z"/></g>'),
    // The sun stops short of the cloud, as if behind it; the moon's bite faces the cloud.
    'wx-partly-day': svg('<g class="wx-a-sun"><path d="M8.09 12.38A3.5 3.5 0 1 1 12 7.2"/>' +
      '<path d="M5.11 12.89L4.23 13.77M3.5 9H2.25M5.11 5.11L4.23 4.23M9 3.5V2.25M12.89 5.11L13.77 4.23"/></g>' + CLOUD_PART),
    'wx-partly-night': svg('<g class="wx-a-moon"><path d="M7.14 13.43A5.5 5.5 0 1 1 13.26 6.39A5 5 0 0 0 7.14 13.43z"/></g>' + CLOUD_PART),
    'wx-cloudy': svg(CLOUD),
    'wx-fog': svg(CLOUD_UP + '<path d="M4.5 17.25h15M7 20.75h10"/>'),
    'wx-drizzle': svg(CLOUD_UP + '<g class="wx-a-rain"><path d="M8.6 16.6l-.6 1.4M12.6 16.6l-.6 1.4M16.6 16.6l-.6 1.4M10.6 19.9l-.6 1.4M14.6 19.9l-.6 1.4"/></g>'),
    'wx-rain': svg(CLOUD_UP + '<g class="wx-a-rain"><path d="M8.9 16.5l-1.4 3.8M12.9 17.5l-1.4 3.8M16.9 16.5l-1.4 3.8"/></g>'),
    'wx-snow': svg(CLOUD_UP + '<g class="wx-a-snow"><path d="M8.5 16.1V21.1M6.33 17.35L10.67 19.85M10.67 17.35L6.33 19.85' +
      'M15.5 16.1V21.1M13.33 17.35L17.67 19.85M17.67 17.35L13.33 19.85"/></g>'),
    'wx-storm': svg(CLOUD_UP + '<g class="wx-a-bolt"><path d="M13.1 16l-2.35 3h3.5l-2.35 3"/></g>'),
    'wx-wind': svg('<path d="M3 9h10a2.75 2.75 0 1 0-2.75-2.75"/><path d="M3 13h15a2.75 2.75 0 1 1-2.75 2.75"/><path d="M3 17h6.5"/>'),
    'wx-sunrise': svg('<path d="M12 3v6.25M9 6l3-3 3 3"/><path d="M3.5 19h17"/>' +
      '<g class="wx-a-sun"><path d="M8 19a4 4 0 0 1 8 0"/><path d="M7.1 14.89L5.57 13.6M16.9 14.89L18.43 13.6"/></g>'),
    'wx-sunset': svg('<path d="M12 3v6.25M9 6.25l3 3 3-3"/><path d="M3.5 19h17"/>' +
      '<g class="wx-a-sun"><path d="M8 19a4 4 0 0 1 8 0"/><path d="M7.1 14.89L5.57 13.6M16.9 14.89L18.43 13.6"/></g>'),
    'wx-drop': svg('<path d="M12 3.75c-3.4 4.3-5.75 7.6-5.75 10.75a5.75 5.75 0 0 0 11.5 0c0-3.15-2.35-6.45-5.75-10.75z"/>'),
    'wx-refresh': svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M18.25 3.25v3.75h-3.75"/>'),
    'wx-pin': svg('<path d="M12 21.25c-3.9-3.9-6.25-7.4-6.25-10.5a6.25 6.25 0 0 1 12.5 0c0 3.1-2.35 6.6-6.25 10.5z"/><circle cx="12" cy="10.75" r="2.25"/>')
  };

  var icons = {
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
    wallet: svg('<path d="M19.5 7.5V5.5a2 2 0 0 0-2-2h-12a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H5.5"/>' +
      '<path d="M16.5 14h.01"/>'),
    expand: svg('<path d="M14.5 3.5h6v6"/><path d="M9.5 20.5h-6v-6"/><path d="M20.5 3.5l-7 7"/><path d="M3.5 20.5l7-7"/>'),
    shrink: svg('<path d="M4.5 13.5h6v6"/><path d="M19.5 10.5h-6v-6"/><path d="M13.5 10.5l7-7"/><path d="M3.5 20.5l7-7"/>'),
    back: svg('<path d="M19.5 12h-15"/><path d="M11 18.5L4.5 12 11 5.5"/>'),
    grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/>' +
      '<rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>')
  };
  for (var name in weather) {
    if (weather.hasOwnProperty(name)) icons[name] = weather[name];
  }
  return icons;
})();
