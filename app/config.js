/*
 * Home Hub settings. Edit this file to change what shows on the TV.
 *
 * The home screen is a grid of widget tiles (12 columns by 6 rows). Each
 * layout entry places one widget: x and y are the top-left cell, w and h
 * the size in cells. A layout entry for a widget that doesn't exist is
 * skipped. This is the built-in layout: a layout sent from the Pi
 * (./hub layout set) takes its place until ./hub layout reset.
 */

/* The Raspberry Pi on the home network. Home Assistant and the later widget
   apps live here. Change it in this one place. */
var HUB_PI = 'http://192.168.1.219';

var HUB_CONFIG = {
  title: 'Living room',
  pi: HUB_PI,

  /* The picture behind the tiles: a file next to hub.html or a full URL.
     Any 1920x1080 picture works. '' or null = no picture (plain dark). */
  background: 'backgrounds/ocean.jpg',

  /* true = frosted-glass tiles that show a soft blur of the picture.
     false = solid dark cards, even with a picture. */
  glass: true,

  /* How opening a widget looks:
       'auto'    start with 'push', time it on the TV, and step down to
                 'expand', then 'fade', if the TV can't keep up (the default)
       'push'    the widget grows in the middle and the other tiles slide aside
       'expand'  the widget grows over a dimmed screen
       'fade'    a plain fade (lightest on slow TVs) */
  motion: 'auto',

  // The tile that has focus when the hub opens.
  start: 'entertainment',

  /* Live updates: the hub server on the Raspberry Pi, which can change what
     the screen shows and keeps the to-do list (see docs/live-updates.md).
     '' turns live updates off, and the hub works exactly as before. */
  live: { server: HUB_PI + ':8097' },

  /* Ian and Ember, as clay puppets, now and then wander onto the home screen
     while nobody is using the remote, do a short scene and leave (see
     docs/clay.md). Any key press sends them away at once.
       idleAfter   seconds without a key press before the first visit
       every       seconds between visits: a random wait in [shortest, longest]
       nightEvery  the same from 10 PM to 6 AM, when Ember just naps in a corner
     clay: false (or on: false) turns them off; so does ?clay=off on the address. */
  clay: { on: true, idleAfter: 20, every: [90, 240], nightEvery: [300, 600] },

  layout: [
    { widget: 'today',         x: 0, y: 0, w: 3, h: 1 },
    { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
    { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
    { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
    { widget: 'todo',          x: 0, y: 1, w: 3, h: 4 },
    { widget: 'mirror',        x: 9, y: 2, w: 3, h: 4 },
    { widget: 'ambiance',      x: 3, y: 4, w: 6, h: 1 },
    { widget: 'nowplaying',    x: 0, y: 5, w: 3, h: 1 },
    { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
  ],

  /* Saved layouts for the switcher: press Up on a top tile (or Left on a
     left-most one) and a bar of pills drops from the top. Pick one and it is applied (and sent to the Pi, so it
     is remembered). "Stock" is the built-in layout above. Copy a layout here
     from the Layout Studio's saved list; widgets this hub doesn't have are
     skipped, and a layout may leave widgets out to hide them. */
  layouts: [
    { id: 'stock', name: 'Stock', layout: null },
    { id: 'main', name: 'Main', layout: [
      { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
      { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
      { widget: 'todo',          x: 0, y: 2, w: 3, h: 4 },
      { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
      { widget: 'nowplaying',    x: 9, y: 2, w: 3, h: 2 },
      { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
      { widget: 'ambiance',      x: 3, y: 4, w: 3, h: 2 },
      { widget: 'mirror',        x: 6, y: 4, w: 3, h: 2 },
      { widget: 'entertainment', x: 9, y: 4, w: 3, h: 2 }
    ] },
    { id: 'get-ready', name: 'Get ready', layout: [
      { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
      { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
      { widget: 'todo',          x: 0, y: 2, w: 3, h: 4 },
      { widget: 'mirror',        x: 3, y: 0, w: 6, h: 4 },
      { widget: 'calendar',      x: 3, y: 4, w: 6, h: 2 },
      { widget: 'nowplaying',    x: 9, y: 2, w: 3, h: 2 },
      { widget: 'ambiance',      x: 9, y: 4, w: 3, h: 2 }
    ] }
  ],

  widgets: {
    /*
     * Entertainment: the app launcher.
     *
     * Each app item finds its app on the TV by name, so no app IDs are needed.
     * "match" is a list of names to look for (case does not matter). The first
     * installed app whose name equals or contains one of them is used.
     *
     * Item kinds:
     *   app        opens an installed TV app
     *   tizentube  opens TizenTube through TizenBrew
     *   input      switches the TV to an input (sends a remote key)
     *   webhook    asks Home Assistant to do something (POSTs to a webhook url)
     *   dashboard  opens a web page full screen inside the hub (Back returns)
     *   allApps    lists every app on the TV
     *
     * "logo" picks the brand logo from logos.js. Without one, the item shows
     * its first letter.
     */
    entertainment: {
      sub: 'Apps, Xbox and live TV',
      sections: [
        {
          label: 'Watch',
          items: [
            { kind: 'app', label: 'Netflix', match: ['Netflix'], logo: 'netflix' },
            { kind: 'app', label: 'Prime Video', match: ['Prime Video', 'Amazon Prime Video', 'Amazon'], logo: 'primevideo' },
            { kind: 'app', label: 'Disney+', match: ['Disney+', 'Disney Plus', 'Disney'], logo: 'disneyplus' },
            { kind: 'app', label: 'Hulu', match: ['Hulu'], logo: 'hulu' },
            { kind: 'app', label: 'Peacock', match: ['Peacock TV', 'Peacock'], logo: 'peacock' },
            { kind: 'app', label: 'Apple TV', match: ['Apple TV', 'Apple TV+'], logo: 'appletv' },
            { kind: 'tizentube', label: 'YouTube', sub: 'No ads', logo: 'youtube' }
          ]
        },
        {
          label: 'Play',
          items: [
            /* The TV won't let the hub press keys itself, so Home Assistant (already trusted by the TV)
               switches the input. url is the Home Assistant webhook on the Pi, e.g.
               HUB_PI + ':8123/api/webhook/tv-switch-to-xbox' */
            { kind: 'webhook', label: 'Xbox', sub: 'HDMI 1', busy: 'Switching to the Xbox', url: HUB_PI + ':8123/api/webhook/hub_xbox',
              hint: 'Press the Xbox button on your controller. With Anynet+ on, the TV switches to HDMI 1 by itself.', logo: 'xbox' }
          ]
        },
        {
          label: 'Free TV',
          items: [
            { kind: 'app', label: 'Pluto TV', match: ['Pluto TV', 'Pluto'], logo: 'plutotv' },
            { kind: 'app', label: 'Twitch', match: ['Twitch'], logo: 'twitch' }
          ]
        },
        /* A dashboard example. Replace the url with a page the TV can reach, then remove the slashes.
        {
          label: 'Dashboards',
          items: [
            { kind: 'dashboard', label: 'Home', sub: 'Home Assistant', url: HUB_PI + ':8123' }
          ]
        },
        */
        {
          label: 'More',
          items: [
            { kind: 'allApps', label: 'All apps', sub: 'On this TV', logo: 'allapps' }
          ]
        }
      ]
    },

    /*
     * To-do: a list kept on this TV. Nothing to set up. sub is the small line
     * under the title.
     */
    todo: { sub: 'On this TV' },

    /*
     * Weather: today on the tile, the next hours and the week in the panel.
     * Forecasts come from Open-Meteo, free and without an account.
     */
    weather: {
      /* Where the forecast is for. One setting, three ways to fill it:
           ''                        the TV finds its own city from its internet address
                                     (the answer is kept on the TV, not in this file)
           'Lisbon' or 'Portland, Oregon'   a city name, looked up once
           { name: 'Home', latitude: 38.72, longitude: -9.14 }   an exact spot */
      location: { name: 'Deep Ellum', latitude: 32.78, longitude: -96.78 },
      // 'fahrenheit' (wind in mph) or 'celsius' (wind in km/h)
      units: 'fahrenheit'
    }
  }
};
