/*
 * For the tests that read the clock tile's status lines (version, motion,
 * live updates, updates): the layout from before Ian's, with the clock two
 * rows tall. Ian's layout (app/config.js) makes the clock a one-row strip,
 * which has no room for those lines.
 *
 *   const clockLayout = require('./clock-layout');
 *   await clockLayout.route(context);   // config.js is served with this layout
 */
'use strict';

const LAYOUT = [
  { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
  { widget: 'entertainment', x: 3, y: 0, w: 6, h: 2 },
  { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
  { widget: 'todo',          x: 0, y: 2, w: 3, h: 4 },
  { widget: 'calendar',      x: 3, y: 2, w: 3, h: 4 },
  { widget: 'nowplaying',    x: 6, y: 2, w: 3, h: 2 },
  { widget: 'awws',          x: 9, y: 2, w: 3, h: 2 },
  { widget: 'ambiance',      x: 6, y: 4, w: 3, h: 2 },
  { widget: 'mirror',        x: 9, y: 4, w: 3, h: 2 }
];

// config.js's text with its layout swapped for LAYOUT.
function rewrite(text) {
  const out = text.replace(/\n  layout: \[[\s\S]*?\n  \],/, '\n  layout: ' + JSON.stringify(LAYOUT) + ',');
  if (out === text) throw new Error('config.js has no layout list');
  return out;
}

// Serves every config.js the context loads (preview or pretend proxy) with LAYOUT.
async function route(context) {
  await context.route(/\/config\.js(\?.*)?$/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: rewrite(await res.text()) });
  });
}

module.exports = { LAYOUT, rewrite, route };
