# Home Hub for a Samsung Tizen TV

A custom home screen that runs as a [TizenBrew](https://github.com/reisxd/TizenBrew) app module. One screen of widget tiles, remote friendly.

![The Home Hub home screen: a grid of dark widget tiles](docs/screenshots/1-home.png)

Out of the box:

- **Today:** the time, the date and the build.
- **Entertainment:** Netflix, Prime Video, Disney+, Hulu, Peacock, Apple TV, YouTube (TizenTube), Xbox on HDMI 1, Pluto TV, Twitch and a list of every app on the TV.
- **Coming soon:** Weather, To-do, Calendar, Now Playing, A World Worth Saving, Ambiance and Mirror. These tiles hold their spot with a "Soon" tag until they're built.

Press OK on a tile to open it in a panel in the middle of the screen; the other tiles slide out of the way. The panel has a **Full screen** button. The tiles sit on a picture of the ocean, frosted like glass.

## Install on the TV

1. Open TizenBrew and go to **Module Manager**.
2. Choose **Add GitHub Module** and type `irosen419/tizen-takeover@main`. The `@main` matters. Without it, jsDelivr can keep serving an old copy that purging doesn't clear.
3. Back on the TizenBrew list, open **Home Hub**.

Apps that aren't installed show dimmed with "Not installed". Install the app from the Samsung store and reopen the hub.

## Remote

| Button | Home | Widget panel | Full screen | All apps list | Dashboard |
| --- | --- | --- | --- | --- | --- |
| Arrows | Move between tiles | Move between items and the Full screen button | Same as the panel | Up and down | |
| OK | Open the widget | Open the item, or switch to full screen | Open the item, or leave full screen | Open the app | |
| Back | Stays on the hub | Close the panel | Back to the panel | Back to the apps grid | Close the dashboard |

The Home button always goes to Samsung's own home bar. Open the hub from TizenBrew, or set it to start on its own (below).

## Xbox

The TV refuses remote key presses from an app running on itself, so the hub can't switch inputs directly. Two things make the Xbox item work:

1. Turn on HDMI-CEC: Anynet+ on the TV and HDMI-CEC on the Xbox. Then pressing the Xbox button on the controller switches the TV to HDMI 1 by itself.
2. Put a Home Assistant webhook URL in the Xbox item's `url` in `app/config.js`. The item posts to it, Home Assistant wakes the Xbox, and CEC switches the input.

Until `url` is set, the item shows a tip instead.

## Start the hub when the TV turns on

1. In TizenBrew, open **Settings**, then **Autolaunch Settings**, and pick Home Hub.
2. On the TV, turn on **Autorun Last App** (usually under Settings, General, Smart Features).

To get back to TizenBrew's own menu once autolaunch is on, close the hub, open TizenBrew and keep tapping Up while it connects. Up is the only key that skips autolaunch. **Disable Autolaunch** sits at the bottom of Autolaunch Settings.

Do this last, after everything else works, so TizenBrew's own menus stay easy to reach while you set things up. Samsung can still decide to show its own home bar after some updates.

## Settings

Everything lives in `app/config.js`.

### The Raspberry Pi

`HUB_PI` at the top is the Pi's address on the home network. Home Assistant runs there, and so will the later widget apps. Change it in that one place; the Xbox webhook is built from it.

### Layout

`layout` places each widget on a grid 12 columns wide and 6 rows tall. `x` and `y` are the top-left cell, `w` and `h` the size in cells. Make the tiles cover the whole grid so there are no gaps. `start` is the tile that has focus when the hub opens.

### Background and glass

`background` is the picture behind the tiles: a file next to `index.html` (the default is `backgrounds/ocean.jpg`) or a full web address. Any 1920x1080 picture works; drop it in `app/backgrounds/` and point `background` at it. Set `background: ''` for the plain dark look. If the picture can't load, the hub falls back to the plain dark look by itself.

`glass: true` makes the tiles and panels frosted glass that show a soft blur of the picture behind them. `glass: false` keeps solid dark cards over the picture. A picture from another website still shows, but its glass is a plain tint without the blur, because the TV won't let the hub read pixels from another site.

### Motion

`motion` picks how a panel opens:

- `'push'`: the widget grows into the middle of the screen and the other tiles slide aside and shrink into a ring around it.
- `'expand'`: the widget grows over a dimmed screen.
- `'fade'`: a plain fade, the lightest on slow TVs.
- `'auto'` (the default) starts with push and times it on the TV. If push stutters twice, it drops to expand and times that; if expand stutters twice, it drops to fade for good. Three smooth runs keep the current one. The result is remembered until the next version of the hub.

Set `motion: 'fade'` (or `'expand'`) to pick one yourself. On a laptop, `?motion=push`, `?motion=expand`, `?motion=fade` or `?motion=auto` at the end of the address does the same for one visit.

### The status line

The two small lines at the bottom of the Today tile show the hub version and the TV's browser, then the motion choice, for example `v0.6.1 · Chrome 63 · Tizen 5.0` and `Motion: push (auto, 57 fps)`. `measuring` means auto is still timing; `(config)` or `(URL)` means the mode was set by hand.

### Entertainment

`widgets.entertainment.sections` lists the items, in groups. Each item has a `kind`:

- `app` opens an installed app. `match` lists names to look for. The first exact match wins, otherwise the shortest name that contains the text.
- `tizentube` opens the TizenTube module through TizenBrew.
- `input` presses a remote key. This TV refuses key presses from the hub, so it's kept only for TVs that allow it.
- `webhook` posts to a URL, for example a Home Assistant webhook.
- `dashboard` opens a web page full screen, for example Home Assistant or Grafana.
- `allApps` opens the list of every app.

`logo` picks a brand logo from `app/logos.js`. Without one, the item shows its first letter. `sub` is the small line under the name.

The home tile shows the first six logos. The panel shows them all; full screen groups them by section.

#### Adding a dashboard

Uncomment the Dashboards example and point `url` at the page. Some sites refuse to load inside another page. If yours shows blank, that site blocks framing and needs its own setting changed.

## Writing a widget

A widget is one file in `app/widgets/` that registers itself, a `<script>` tag for it in `index.html` before `hub.js`, and a `layout` entry. To replace a "Soon" placeholder, register a widget with the same `id`; a real widget always wins over a placeholder.

```js
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push({
  id: 'weather',           // matches the layout entry and HUB_CONFIG.widgets.weather
  title: 'Weather',
  icon: 'sun-cloud',       // a name from app/icons.js
  expandable: true,        // false: a static tile that focus skips
  init: function (ctx) {},              // once at start: timers, loading data
  renderTile: function (el, ctx) {},    // fill the tile body (the hub draws icon and title)
  renderPanel: function (el, ctx) {},   // fill the panel body each time it opens
  onSelect: function (target, ctx) {},  // OK on one of your focusable elements
  onBack: function (ctx) { return false; }, // return true if you handled Back
  onMode: function (mode, ctx) {},      // 'panel' or 'full'
  onClose: function (ctx) {}
});
```

Only `id` and `title` are required. Give every element the remote should reach the class `f`, and `data-autofocus` to the one that gets focus first. Arrows move between them by position. Other optional hooks and fields: `planned`, `head: false`, `sub`, `onFocus` and `onStatus`; the comment at the top of `hub.js` lists them all.

`ctx` gives each widget: `config` (its part of `HUB_CONFIG.widgets`), `toast(text, ms)`, `service(path, ms, cb)` for the TV's service, `getJSON(url, ms, cb)` for any other address, `pi(path)` to build an address on the Pi (`ctx.pi('/todo/')`, `ctx.pi(':8123/api/x')`), `openFrame(url)`, `isOpen()`, `mode()`, `setMode(mode)`, `close()`, `redrawTile()`, `redrawPanel()`, `setSub(text)`, `focus(el)`, `browser()` (the TV's browser, for example `Chrome 63 · Tizen 5.0`), `hasTizen` and `registerKeys(keys)`.

A widget gets its data from the Pi in one of two ways. It either draws itself from JSON fetched with `ctx.getJSON(ctx.pi('/...'))` (the Pi must send an `Access-Control-Allow-Origin` header), or it opens a page hosted on the Pi full screen with `ctx.openFrame(ctx.pi('/...'))`.

A widget that throws an error shows a short message instead of stopping the hub.

Keep to plain ES5 JavaScript (`var`, `function`, no arrow functions or `fetch`) and animate only `transform` and `opacity`. The TV's browser is old and its graphics chip is slow.

## Preview on a laptop

```
node dev/preview.js
```

Then open http://127.0.0.1:8090/. It serves `app/` and pretends to be the TV's service with a made-up app list (Peacock is left out on purpose so "Not installed" shows). Launches, keys and webhooks are printed in the terminal instead of happening. Arrows move, Enter is OK and Escape is Back; the mouse works too. Add `?motion=push`, `?motion=expand`, `?motion=fade` or `?motion=auto` to the address to try each animation. YouTube can't open in the preview because there's no TizenBrew.

## Updating

TizenBrew loads modules through jsDelivr, which caches each branch for a while. After pushing a change, wait a bit or purge the cache for each changed file at `https://purge.jsdelivr.net/gh/irosen419/tizen-takeover@main/app/<file>`, then reopen the hub. There are more files now, so purge every one you changed: `index.html`, `style.css`, `config.js`, `icons.js`, `logos.js`, `hub.js`, each file in `widgets/` (for example `.../app/widgets/entertainment.js`) and the picture, `backgrounds/ocean.jpg`.

## How it works

- `app/index.html` is the page. It loads, in order: `config.js`, `icons.js`, `logos.js`, the files in `widgets/`, then `hub.js`.
- `app/config.js` holds the settings.
- `app/icons.js` holds the white line icons; `app/logos.js` the app logos.
- `app/widgets/` holds one file per widget: `today.js`, `entertainment.js` and `planned.js` (the "Soon" placeholders).
- `app/hub.js` builds the home screen, moves focus, opens panels and runs the animations.
- `app/style.css` holds all the styles.
- `app/backgrounds/` holds the background picture.
- `service.js` runs inside TizenBrew's Node service on the TV. It listens on `127.0.0.1:8095` only and lists apps, opens apps and calls webhooks when the page can't do it directly.
- `dev/preview.js` is for previewing on a laptop and isn't used on the TV.

All of `app/` is plain ES5 JavaScript so the TV's older browser can run it.
