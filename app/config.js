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

  /* Motion extras on top of that (app/motion.js), each on or off. They only
     move when 'motion' runs at its best (push, at 40 frames a second or
     more); in 'fade', or on a TV that measured slow, things change at once.
       quietTiles  waiting tiles ("needs the Pi", "Soon") are one quiet line
       ring        the focus ring glides from tile to tile
       stagger     a panel's items arrive one by one when it opens
       cover       the Now Playing cover flies to the full-screen card
       bloom       an app's icon fills the screen while the app opens
       activity    a tile says what is updating when a sync brings new data
       edge        a faint blue border around a tile with something new
                   (an update, an event within the hour) for about a minute
     motionFx: false turns them all off; so does ?fx=off on the address. */
  motionFx: { quietTiles: true, ring: true, stagger: true, cover: true, bloom: true, activity: true, edge: true },

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
                   (at most 2.5 minutes by default)
       nightEvery  the same from 10 PM to 6 AM, when Ember just naps in a corner
     clay: false (or on: false) turns them off; so does ?clay=off on the address. */
  clay: { on: true, idleAfter: 20, every: [90, 150], nightEvery: [300, 600] },

  layout: [
    { widget: 'today',         x: 0, y: 0, w: 3, h: 1 },
    { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
    { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
    { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
    { widget: 'todo',          x: 0, y: 1, w: 3, h: 4 },
    { widget: 'mirror',        x: 9, y: 2, w: 3, h: 2 },
    { widget: 'wotd',          x: 9, y: 4, w: 3, h: 2 },
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
    ] },
    { id: 'awws-desk', name: 'AWWS desk', layout: [
      { widget: 'awws-visits',   x: 0, y: 0, w: 3, h: 2 },
      { widget: 'awws-agenda',   x: 3, y: 0, w: 6, h: 2 },
      { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
      { widget: 'awws-todo',     x: 0, y: 2, w: 4, h: 4 },
      { widget: 'calendar',      x: 4, y: 2, w: 5, h: 4 },
      { widget: 'today',         x: 9, y: 2, w: 3, h: 1 },
      { widget: 'entertainment', x: 9, y: 3, w: 3, h: 3 }
    ] },
    { id: 'awws-one-screen', name: 'AWWS one screen', layout: [
      { widget: 'awws',          x: 0, y: 0, w: 9, h: 6 },
      { widget: 'today',         x: 9, y: 0, w: 3, h: 1 },
      { widget: 'weather',       x: 9, y: 1, w: 3, h: 2 },
      { widget: 'calendar',      x: 9, y: 3, w: 3, h: 3 }
    ] },
    { id: 'awws-money', name: 'AWWS money', layout: [
      { widget: 'awws',          x: 0, y: 0, w: 3, h: 3 },
      { widget: 'awws-money',    x: 3, y: 0, w: 6, h: 3 },
      { widget: 'calendar',      x: 9, y: 0, w: 3, h: 6 },
      { widget: 'awws-todo',     x: 0, y: 3, w: 6, h: 3 },
      { widget: 'entertainment', x: 6, y: 3, w: 3, h: 3 }
    ] },
    { id: 'budget', name: 'Budget', layout: [
      { widget: 'budget-room',   x: 0, y: 0, w: 4, h: 3 },
      { widget: 'budget-card',   x: 4, y: 0, w: 4, h: 3 },
      { widget: 'budget-goals',  x: 8, y: 0, w: 4, h: 6 },
      { widget: 'calendar',      x: 0, y: 3, w: 5, h: 3 },
      { widget: 'today',         x: 5, y: 3, w: 3, h: 1 },
      { widget: 'entertainment', x: 5, y: 4, w: 3, h: 2 }
    ] },
    // Plant sun alone, to try it out (a new widget gets a layout of its own first).
    { id: 'plant-wall', name: 'Plant wall', layout: [
      { widget: 'sunpath',       x: 0, y: 0, w: 12, h: 6 }
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
     * A World Worth Saving: the awws tiles (awws, awws-visits, awws-agenda,
     * awws-todo, awws-reach, awws-money, and the placeholders awws-outreach
     * and awws-pipeline). One setting for all of them. Reach is on no layout
     * yet: place it with the Layout Studio or ./hub layout set. Money
     * (Earned vs spent) is on the "AWWS money" layout.
     *
     * calendars: which of the Pi's calendars to use, by the name given in the
     * Pi's .env (CALENDAR_n_NAME; case and spaces at the ends don't matter).
     * "visits" feeds Next visit; both lists together feed This week and the
     * coming dates on the Glance. Everything else comes from the snapshot
     * described in docs/awws-snapshot.md.
     *
     * showMoney: the owner said yes to money figures on the TV on
     * 2026-11-16. Set it to false to keep them off the TV (for guests, say):
     * the Glance drops its money line and Earned vs spent says it is hidden.
     */
    awws: {
      calendars: {
        visits: ['School Visits'],
        awws: ['A World Worth Saving']
      },
      showMoney: true
    },

    /*
     * Personal budget: Daily room, Card day and Goals (budget-room,
     * budget-card, budget-goals, on the "Budget" layout), and a banner across
     * the top when a charge posts at a merchant that was cut ("New charge:
     * ...", never an amount; OK dismisses it). The budget app on the Pi sends
     * only totals to the hub server there (docs/budget-snapshot.md).
     *
     * show: false hides all of it on this TV (the tiles say so, and the
     * banner never shows).
     */
    budget: { show: true },

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
      units: 'fahrenheit',
      // The picture behind the weather: 'auto' (moving, but still on a TV too
      // slow for it), 'calm' (always still), 'full' (always moving) or 'off'.
      scene: 'auto'
    },

    /*
     * Now Playing: what plays on Spotify (set up on the Pi, see pi/README.md).
     *
     * visualizer: a classic-style light show (trails, tunnels, kaleidoscopes)
     * in the album's colors that moves with the song, filling the full screen
     * page only, with the song as a small card in the corner. true lets the
     * TV pick how much it can show (it checks its own frame rate); false
     * turns it off; 'radiant' (or 'full'; glow, bloom and motes), 'sharp'
     * (a 960 x 540 canvas, crisp lines, no bloom), 'native' (the same, drawn at
     * the screen's own 1920 x 1080 pixels, so nothing is stretched), 'sharplite' (or
     * 'sharp-lite'; a little smaller), 'classic' (the older flat look),
     * 'lite' (smaller and lighter), 'glow' (soft glows only) or 'wash' (a
     * still wash of color, with the big picture) fixes a level.
     * ?viz=off|wash|glow|lite|classic|sharplite|sharp|native|radiant on the address
     * tries one for a visit.
     */
    nowplaying: { visualizer: true },

    /*
     * Plant sun: when direct sun reaches the plant wall (the "Plant wall"
     * layout). The sun's position is worked out on the TV (NOAA formulas)
     * for the weather location above, rounded; latitude and longitude here
     * would take its place. The window itself (faces about 306 degrees
     * true, 23 in wide, sill 28.5 in, 4.5 ft tall) is in sunpath.js.
     *
     * PLACEHOLDERS, not measured yet:
     *   roofAngle  the balcony roof blocks the sun above this angle (degrees)
     *   gapFeet    from the right window's right edge to the plant wall (ft)
     *   plantFromWindowFeet  (below) where the plants start and end
     * While placeholder is true the tile's badge says "Estimate" and the
     * panel says which numbers are estimates. Put in the measured numbers
     * and set placeholder to false.
     *
     *   plantFromWindowFeet  [nearest, furthest]: how far into the room
     *              the plants run along the wall (ft). "Sun on the plants"
     *              means the beam lands anywhere in that stretch. One number
     *              (a single plant spot) still works.
     *
     * plantHeightFeet: how high the plants sit (3 ft up). plants: shown in
     * the panel's note; keepOutOfSun: the one to keep out of the summer
     * evening beam.
     */
    sunpath: {
      roofAngle: 40,
      gapFeet: 2.0,
      placeholder: true,
      plantFromWindowFeet: [2.0, 6],      // PLACEHOLDER: nearest and furthest plant
      plantHeightFeet: 3,
      plants: ['4in Birkin philodendron', 'Golden pothos', 'Maranta Gold Lines'],
      keepOutOfSun: 'Maranta Gold Lines'
    }
  }
};
