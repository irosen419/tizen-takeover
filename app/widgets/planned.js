/*
 * Placeholders for widgets that aren't built yet. Each one keeps its spot on
 * the home screen and shows a "Soon" tag. A real widget registered with the
 * same id replaces its placeholder, whatever order the files load in.
 */
(function () {
  'use strict';

  var PLANNED = [
    { id: 'weather', title: 'Weather', icon: 'sun-cloud', text: 'Today at a glance, then the day or the week.' },
    { id: 'todo', title: 'To-do', icon: 'check-list', text: 'Everything on your list, like the morning brief.' },
    { id: 'calendar', title: 'Calendar', icon: 'calendar', text: 'Today’s schedule, then day, week or month.' },
    { id: 'nowplaying', title: 'Now Playing', icon: 'music', text: 'What’s playing on Spotify.' },
    { id: 'awws', title: 'A World Worth Saving', icon: 'globe', text: 'Open any of the dashboards, starting with the to-do app.' },
    { id: 'ambiance', title: 'Ambiance', icon: 'sparkle', text: 'Pick the light vibe from the TV.' },
    { id: 'mirror', title: 'Mirror', icon: 'camera', text: 'A camera mirror for mornings and nights out.' }
  ];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function outer(node) {
    var cs = window.getComputedStyle(node);
    if (cs.position === 'absolute' || cs.display === 'none') return 0;
    return node.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }

  // Clamps the text to the lines that fit in the body (old WebKit's line
  // clamp ends the last one in "..."). Measured, because a longer language
  // or a bigger TV font changes how many lines there are. In a tall tile the
  // mark sits above the text; if even then nothing fits, the mark goes.
  function fitLines(body, text, mark) {
    var room = body.clientHeight;
    if (!room) return;
    var lh = parseFloat(window.getComputedStyle(text).lineHeight) || 20;
    var lines = Math.max(1, Math.floor((room - outer(mark) - outer(text) + text.offsetHeight) / lh));
    function clamp(n) {
      text.style.display = '-webkit-box';
      text.style.webkitBoxOrient = 'vertical';
      text.style.webkitLineClamp = String(n);
      text.style.overflow = 'hidden';
    }
    if (text.offsetHeight <= lines * lh + 1) return;
    clamp(lines);
    if (outer(mark) && outer(mark) + outer(text) > room + 1) {
      mark.style.display = 'none';
      clamp(Math.max(1, Math.floor((room - outer(text) + text.offsetHeight) / lh)));
    }
  }

  function placeholder(p) {
    return {
      id: p.id,
      title: p.title,
      icon: p.icon,
      expandable: true,
      planned: true,

      renderTile: function (body, ctx) {
        var text = el('p', 'planned-text', p.text);
        body.appendChild(text);
        var mark = el('span', 'planned-mark');
        mark.innerHTML = (window.HUB_ICONS && HUB_ICONS[p.icon]) || '';
        body.appendChild(mark);
        var size = ctx && ctx.size ? ctx.size() : null;
        // A strip has one line that ends in "..." (CSS); other sizes get as
        // many whole lines as fit, then "...".
        if (!size || size.tier !== 'strip') fitLines(body, text, mark);
      },

      renderPanel: function (body) {
        var wrap = el('div', 'planned-panel');
        wrap.appendChild(el('p', 'planned-lead', p.text));
        wrap.appendChild(el('p', 'planned-note', 'Not built yet. This spot is reserved for it.'));
        body.appendChild(wrap);
        var mark = el('span', 'planned-mark planned-mark-panel');
        mark.innerHTML = (window.HUB_ICONS && HUB_ICONS[p.icon]) || '';
        body.appendChild(mark);
      }
    };
  }

  var list = (window.HUB_WIDGETS = window.HUB_WIDGETS || []);
  for (var i = 0; i < PLANNED.length; i++) list.push(placeholder(PLANNED[i]));
})();
