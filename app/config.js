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

  /* The picture behind the tiles:
       'auto'   a picture from app/backgrounds/backgrounds.js: a day picture in
                the day look and a night picture in the night look, a new one
                each day (the default). ?bg=day/3 or ?bg=night/0 on the address
                shows one by its place in the list (counting from 0).
       a file next to hub.html or a full URL: that one picture, in both looks.
       '' or null = no picture (plain dark).
     Any 1920x1080 picture works. */
  background: 'auto',

  /* true = the current picture's title in small grey type in the bottom-right
     corner of the home screen, so a picture can be named while trying them.
     It hides while a panel or a dashboard is open. false = no label (the
     About panel's "Picture" line still has the title and credit). */
  pictureLabel: true,

  /* true = frosted-glass tiles that show a soft blur of the picture.
     false = solid dark cards, even with a picture. */
  glass: true,

  /* The look of the glass tiles (app/theme.css), when glass is on and there
     is a picture:
       'auto'   day (light glass, dark text) between sunrise and sunset, night
                (dark glass) otherwise. Sunrise and sunset come from the
                Weather widget; without them, day is 7:00 AM to 6:00 PM (the default)
       'day'    always light
       'night'  always dark
     ?theme=day or ?theme=night on the address tries one without editing this. */
  theme: 'auto',

  /* How opening a widget looks:
       'auto'    start with 'push', time it on the TV, and step down to
                 'expand', then 'fade', if the TV can't keep up, and tries push again after a day (the default)
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

  // Focus starts on the top-left tile of whatever layout is showing (app/hub.js topLeftIndex).

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

  /* A pixel-art character (app/agents.js, docs/agents.md) swoops in beside
     a tile's working or arrival chip ("Working on to-dos", "Incoming
     to-do"), stays while the chip does, and glides out when it ends. The
     chip itself is unchanged. Only when the screen keeps full speed; on a
     slow screen or in fade mode the chip shows alone.
       who   which character: 'lift' (Lift and Wyndle, from Stormlight);
             a name not in the roster turns them off
     agents: false (or on: false) turns them off; so does ?agent=off on the
     address. Off, nothing of theirs loads. */
  agents: { on: true, who: 'lift' },

  layout: [
    { widget: 'today',         x: 0, y: 0, w: 3, h: 1 },
    { widget: 'calendar',      x: 3, y: 0, w: 3, h: 4 },
    { widget: 'awws',          x: 6, y: 0, w: 3, h: 4 },
    { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
    { widget: 'todo',          x: 0, y: 1, w: 3, h: 4 },
    { widget: 'mirror',        x: 9, y: 2, w: 3, h: 2 },
    { widget: 'wotd',          x: 9, y: 4, w: 3, h: 2 },
    { widget: 'ambience',      x: 3, y: 4, w: 6, h: 1 },
    { widget: 'nowplaying',    x: 0, y: 5, w: 3, h: 1 },
    { widget: 'entertainment', x: 3, y: 5, w: 6, h: 1 }
  ],

  /* Saved layouts for the switcher: press Up on a top tile (or Left on a
     left-most one) and a bar of pills drops from the top. Pick one and it is applied (and sent to the Pi, so it
     is remembered). "Default" is the built-in layout above (id 'stock', kept so a saved pick still matches). Copy a layout here
     from the Layout Studio's saved list; widgets this hub doesn't have are
     skipped, and a layout may leave widgets out to hide them. */
  layouts: [
    { id: 'stock', name: 'Default', layout: null },
    { id: 'main', name: 'Main', layout: [
      { widget: 'today',          x: 0, y: 0, w: 3, h: 1 },
      { widget: 'entertainment',  x: 0, y: 5, w: 3, h: 1 },
      { widget: 'weather',        x: 0, y: 2, w: 3, h: 2 },
      { widget: 'todo',           x: 3, y: 3, w: 3, h: 2 },
      { widget: 'calendar',       x: 3, y: 0, w: 3, h: 3 },
      { widget: 'awws',           x: 6, y: 0, w: 3, h: 3 },
      { widget: 'ambience',       x: 3, y: 5, w: 3, h: 1 },
      { widget: 'wotd',           x: 0, y: 1, w: 3, h: 1 },
      { widget: 'budget-room',    x: 9, y: 3, w: 3, h: 3 },
      { widget: 'investments',    x: 9, y: 0, w: 3, h: 3 },
      { widget: 'nowplaying',      x: 0, y: 4, w: 3, h: 1 },
      { widget: 'grocery',        x: 6, y: 3, w: 3, h: 3 }
    ] },
    { id: 'get-ready', name: 'Get ready', layout: [
      { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
      { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
      { widget: 'todo',          x: 0, y: 2, w: 3, h: 4 },
      { widget: 'mirror',        x: 3, y: 0, w: 6, h: 4 },
      { widget: 'calendar',      x: 3, y: 4, w: 6, h: 2 },
      { widget: 'nowplaying',    x: 9, y: 2, w: 3, h: 2 },
      { widget: 'ambience',      x: 9, y: 4, w: 3, h: 2 }
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
      { widget: 'budget-goals',  x: 8, y: 0, w: 4, h: 3 },
      { widget: 'budget-lab',    x: 0, y: 3, w: 4, h: 3 },
      { widget: 'calendar',      x: 4, y: 3, w: 4, h: 3 },
      { widget: 'today',         x: 8, y: 3, w: 4, h: 1 },
      { widget: 'entertainment', x: 8, y: 4, w: 4, h: 2 }
    ] },
    // Plant sun alone, to try it out (a new widget gets a layout of its own first).
    { id: 'plant-wall', name: 'Plants', layout: [
      { widget: 'sunpath',       x: 0, y: 0, w: 12, h: 6 }
    ] },
    /* A test layout: Ambience (app/widgets/ambience.js, the room's lights)
       on its own, filling the screen, to try it before it joins a real
       layout. New widgets are tried the same way: one layout, one widget. */
    { id: 'ambience-test', name: 'Ambience test', layout: [
      { widget: 'ambience',      x: 0, y: 0, w: 12, h: 6 }
    ] },
    /* Architecture (app/widgets/architecture.js, the map of the whole system,
       driven by the remote) on its own; it opens straight into a window (hub.js
       openSolo). The id still says test so a saved pick still matches. */
    { id: 'architecture-test', name: 'Hub architecture', layout: [
      { widget: 'architecture', x: 0, y: 0, w: 12, h: 6 }
    ] },
    /* A test layout: Groceries (app/widgets/grocery.js, the list kept on the
       Pi) among everyday tiles, so its panel opens in place and pushes them
       aside. Not alone at 12x6: that would open straight to full screen. */
    { id: 'grocery-test', name: 'Groceries test', layout: [
      { widget: 'today',         x: 0, y: 0, w: 3, h: 2 },
      { widget: 'grocery',       x: 3, y: 0, w: 3, h: 4 },
      { widget: 'calendar',      x: 6, y: 0, w: 3, h: 4 },
      { widget: 'weather',       x: 9, y: 0, w: 3, h: 2 },
      { widget: 'todo',          x: 0, y: 2, w: 3, h: 4 },
      { widget: 'nowplaying',    x: 9, y: 2, w: 3, h: 2 },
      { widget: 'entertainment', x: 3, y: 4, w: 6, h: 2 },
      { widget: 'wotd',          x: 9, y: 4, w: 3, h: 2 }
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
     *   schedule   the TV shows on the Pi's list: today, this week, this month
     *              and coming soon (app/widgets/shows.js; the list is kept on
     *              the Pi with ./hub shows add|remove, see pi/README.md)
     *
     * "logo" picks the brand logo from logos.js. Without one, the item shows
     * its first letter.
     */
    entertainment: {
      // OK on the tile opens straight to full screen (apps beside the
      // Schedule); Back closes it. Any widget takes openMode: 'full' or
      // 'panel' here to skip or keep the small panel in between.
      openMode: 'full',
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
            { kind: 'schedule', label: 'Schedule', sub: 'Your shows', logo: 'schedule' },
            { kind: 'allApps', label: 'All apps', sub: 'On this TV', logo: 'allapps' }
          ]
        }
      ],

      /*
       * Schedule: a show opens in its watch app (the service on the Pi's
       * list). watchAliases sends every show of one service to another app
       * instead: Hulu titles open in Disney+ here. The app it came from shows
       * as "Also on Hulu" beside the episode (Right, then OK, opens it).
       */
      watchAliases: { 'Hulu': 'Disney+' },

      /*
       * When a show from a TV channel streams. TVmaze dates each episode by
       * its first broadcast (Hell's Kitchen: FOX, Thursday 7 PM; the Baking
       * Show: Channel 4 in the UK, Tuesday). When that channel isn't a
       * streaming app, the Schedule lists the episode on the day it reaches
       * the show's app and adds "Airs live on FOX · Thu 7 PM" under it.
       * A rule per show (by name) wins over one per app; anything else
       * streams the next day. { days: n } counts days after the broadcast,
       * { weekday: 'fri' } is the first Friday after it, at: '02:00' adds the
       * hour when it is known (without it only the day shows), and
       * { live: true } keeps the broadcast time (watched live).
       */
      streamAfterAir: {
        apps: { 'Disney+': { days: 1 }, 'Hulu': { days: 1 }, 'Peacock': { days: 1 } },
        shows: { 'The Great British Baking Show': { weekday: 'fri' } }
      },

      /*
       * Prime Video Channels: a service billed through another app opens in
       * that app. The badge still names the service, with a small "via
       * Prime Video" beside the episode, and Watch opens Prime Video. One
       * show alone can say so on the Pi instead (./hub shows add "X"
       * --service "HBO Max" --via "Prime Video"). An example only; uncomment
       * and change it to match the subscriptions on this TV:
       */
      // watchVia: { 'HBO Max': 'Prime Video' },

      /*
       * Watch link test (About panel: Left on a left-most tile, then OK on
       * "Watch link test"). Each recipe opens one app with an app control:
       * op (the operation), and optionally uri, or key + val (one data
       * item). app is the Entertainment item's label (its match names find
       * the app). {name} is filled from ids below. A value still in
       * <angle brackets> is a placeholder: its recipes say "needs id" and
       * never fire. Answers go to the Pi: ./hub linktests. The ids in
       * editable also get a text box at the top of the test, so one can be
       * changed with the remote (kept on that TV, over the one here).
       */
      linkTests: {
        editable: ['primeGti'],
        ids: {
          // EDIT: the Prime Video title id (GTI) the Prime recipe opens.
          primeGti: 'amzn1.dv.gti.50f41028-8256-4293-9d0d-14556b501136',
          // A Netflix title id, as seen in netflix.com/title/<id>.
          netflixTitle: '81505776',
          // Apple TV show ids: unverified, edit here if they don't open.
          appleFoundation: 'umc.cmc.5983fiap1xtpb4p1dp4w7w3zd',
          appleForAllMankind: 'umc.cmc.6wsi780sz5tsh3jmcixqwr5o2',
          // Placeholders until someone finds the real ids.
          disneyHellsKitchen: '<Disney+ series id>',
          hulu: '<Hulu series id>',
          peacock: '<Peacock series id>'
        },
        recipes: [
          { id: 'prime-resume', app: 'Prime Video', name: 'Title by GTI (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: '{"values":"{primeGti}"}' },
          { id: 'netflix-resume', app: 'Netflix', name: 'Title by id (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: 'm=https://www.netflix.com/title/{netflixTitle}&source_type=4' },
          { id: 'netflix-view', app: 'Netflix', name: 'Title page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://www.netflix.com/title/{netflixTitle}' },
          { id: 'appletv-view', app: 'Apple TV', name: 'Foundation page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://tv.apple.com/us/show/foundation/{appleFoundation}' },
          { id: 'appletv-resume', app: 'Apple TV', name: 'Foundation by id (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: '{"values":"{appleFoundation}"}' },
          { id: 'appletv-fam', app: 'Apple TV', name: 'For All Mankind page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://tv.apple.com/us/show/for-all-mankind/{appleForAllMankind}' },
          { id: 'disney-view', app: 'Disney+', name: 'Hell’s Kitchen page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://www.disneyplus.com/series/hells-kitchen/{disneyHellsKitchen}' },
          { id: 'disney-resume', app: 'Disney+', name: 'Hell’s Kitchen by id (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: '{"values":"{disneyHellsKitchen}"}' },
          { id: 'hulu-view', app: 'Hulu', name: 'Series page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://www.hulu.com/series/{hulu}' },
          { id: 'peacock-view', app: 'Peacock', name: 'Series page (view)',
            op: 'http://tizen.org/appcontrol/operation/view', uri: 'https://www.peacocktv.com/watch/asset/tv/{peacock}' },
          // Added after the first TV results: Netflix eden_resume and view only
          // opened the app; Apple TV did nothing at all.
          { id: 'netflix-watch-resume', app: 'Netflix', name: 'Watch url (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: 'm=https://www.netflix.com/watch/{netflixTitle}&source_type=4' },
          { id: 'netflix-json-resume', app: 'Netflix', name: 'Title url in JSON (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: '{"values":"m=https://www.netflix.com/title/{netflixTitle}&source_type=4"}' },
          { id: 'netflix-default-op', app: 'Netflix', name: 'Title by id (default)',
            op: 'http://tizen.org/appcontrol/operation/default', key: 'PAYLOAD', val: 'm=https://www.netflix.com/title/{netflixTitle}&source_type=4' },
          { id: 'appletv-resume-url', app: 'Apple TV', name: 'Foundation url in JSON (eden_resume)',
            op: 'http://samsung.com/appcontrol/operation/eden_resume', key: 'PAYLOAD', val: '{"values":"https://tv.apple.com/us/show/foundation/{appleFoundation}"}' },
          { id: 'appletv-default-op', app: 'Apple TV', name: 'Foundation by id (default)',
            op: 'http://tizen.org/appcontrol/operation/default', key: 'PAYLOAD', val: '{"values":"{appleFoundation}"}' },
          // No app control at all: the TV's plain /launch, to see whether the
          // matched app id itself opens.
          // Two-step launch, driven by the Pi (the TV refuses its own key
          // presses): open the app, wait, Enter (the default profile), wait,
          // then the link while the app is running. Waits default to 10 s and 5 s.
          { id: 'netflix-2step-dial', app: 'Netflix', name: 'Open, Enter, then DIAL watch link',
            pi: { link: 'dial', dialApp: 'Netflix', payload: 'm=https://www.netflix.com/watch/{netflixTitle}&source_type=4' } },
          { id: 'netflix-2step-watch', app: 'Netflix', name: 'Open, Enter, then deep link (watch url)',
            pi: { link: 'deeplink', payload: 'm=https://www.netflix.com/watch/{netflixTitle}&source_type=4' } },
          { id: 'netflix-2step-title', app: 'Netflix', name: 'Open, Enter, then deep link (title url)',
            pi: { link: 'deeplink', payload: 'm=https://www.netflix.com/title/{netflixTitle}&source_type=4' } },
          { id: 'netflix-pi-dial-cold', app: 'Netflix', name: 'DIAL watch link only (no open first)',
            pi: { open: false, enter: false, waitOpen: 0, waitAfter: 0, link: 'dial', dialApp: 'Netflix', payload: 'm=https://www.netflix.com/watch/{netflixTitle}&source_type=4' } },
          { id: 'prime-2step-gti', app: 'Prime Video', name: 'Open, Enter, then deep link (GTI)',
            pi: { link: 'deeplink', payload: '{"values":"{primeGti}"}' } },
          { id: 'prime-2step-gti-noenter', app: 'Prime Video', name: 'Open, then deep link (GTI), no Enter',
            pi: { enter: false, link: 'deeplink', payload: '{"values":"{primeGti}"}' } },
          { id: 'plain-netflix', app: 'Netflix', name: 'Plain open', plain: true },
          { id: 'plain-appletv', app: 'Apple TV', name: 'Plain open', plain: true },
          { id: 'plain-prime', app: 'Prime Video', name: 'Plain open', plain: true },
          { id: 'plain-disney', app: 'Disney+', name: 'Plain open', plain: true },
          { id: 'plain-hulu', app: 'Hulu', name: 'Plain open', plain: true },
          { id: 'plain-peacock', app: 'Peacock', name: 'Plain open', plain: true }
        ]
      }
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
     * Personal budget: Daily room, Card day, Goals and Budget lab (budget-room,
     * budget-card, budget-goals, budget-lab, on the "Budget" layout; the lab
     * is the pace streak and a daily cap to try out), and a banner across
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
     * Plant sun: when direct sun reaches the plant wall (the "Plants"
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
     *
     * Care view (the panel's fourth view, and one small line on the tile):
     *   careEvent  the title of the weekly calendar event whose notes hold
     *              the care for each plant (case and spacing ignored; the
     *              next one that has not ended is used). Default
     *              'Water plants'. Its notes come from the hub server's
     *              "calendar" live data: paragraphs before the first plant
     *              are shown on top, a plant is a paragraph whose short
     *              first line (48 characters or fewer, not ending in . ! ?
     *              or :) is its name and whose other lines are its care,
     *              paragraphs after are shown last as a warning.
     *   light      each plant's sunlight, shown as "Light" on its card. The
     *              key is a lowercase word that appears in the plant's
     *              name (the first key found in it is used); no match, no
     *              line.
     */
    /*
     * Architecture: the map of the whole system, opened with the remote (app/widgets/architecture.js).
     * OK on its tile opens straight to full screen; Back goes up a level and closes at the Big picture.
     * It is on the "Hub architecture" layout only; the map's data loads when it is first opened.
     */
    architecture: { openMode: 'full' },

    /*
     * Groceries: the grocery list kept on the Pi (app/widgets/grocery.js).
     * touch: true = it has a phone and tablet view in the touch app
     * (app/touch.html, served by the Pi at http://<Pi>:8097/); every other
     * widget shows there as "TV only". The TV tile is on the "Groceries
     * test" layout only; its changes need Pi server 0.26.1.
     */
    grocery: { touch: true },

    /*
     * Pantry: what is at home, kept on the Pi in SQLite (app/widgets/pantry.js,
     * pi/pantrydb.js). Phone and tablet only for now (no TV tile yet); a low
     * item goes on the grocery list by itself. Needs Pi server 0.30.0.
     */
    pantry: { touch: true },

    sunpath: {
      roofAngle: 40,
      gapFeet: 2.0,
      placeholder: true,
      plantFromWindowFeet: [2.0, 6],      // PLACEHOLDER: nearest and furthest plant
      plantHeightFeet: 3,
      plants: ['4in Birkin philodendron', 'Golden pothos', 'Maranta Gold Lines'],
      keepOutOfSun: 'Maranta Gold Lines',
      careEvent: 'Water plants',
      light: {
        maranta: 'Bright, indirect light. Direct sun bleaches and scorches its stripes.',
        birkin: 'Bright, indirect light. Too little light fades its white stripes.',
        pothos: 'Low to bright indirect light. Grows faster and more golden in brighter spots.',
        cuttings: 'Bright, indirect light. Keep them out of hot direct sun so the water stays cool.'
      }
    }
  }
};
