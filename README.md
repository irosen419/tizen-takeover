# Home Hub for a Samsung Tizen TV

A custom home screen that runs as a [TizenBrew](https://github.com/reisxd/TizenBrew) app module. One screen, big tiles, remote friendly.

Rows out of the box:

- **Watch:** Netflix, Prime Video, Disney+, Hulu, Peacock, YouTube (TizenTube)
- **Play:** Xbox on HDMI 1
- **Free TV:** Samsung TV Plus, Pluto TV
- **Dashboards:** empty until you add one
- **More:** every app on the TV, as a list

## Install on the TV

1. Open TizenBrew and go to **Module Manager**.
2. Choose **Add GitHub Module** and type `irosen419/tizen-takeover`.
3. Back on the TizenBrew list, open **Home Hub**.

Tiles for apps that aren't installed show dimmed with "Not installed". Install the app from the Samsung store and reopen the hub.

## Remote

| Button | Grid | All apps list | Dashboard |
| --- | --- | --- | --- |
| Arrows | Move between tiles | Up and down | |
| OK | Open | Open | |
| Back | Stays on the hub | Close the list | Close the dashboard |

The Home button always goes to Samsung's own home bar. Open the hub from TizenBrew, or set it to start on its own (below).

## Xbox tile

The Xbox tile presses the TV's own HDMI 1 key through the TV's remote control service. The first time, the TV shows a prompt asking to allow "Home Hub". Choose **Allow**. If the tile does nothing, change `key` in `app/config.js` to `KEY_SOURCE` (opens the input picker instead), or turn on HDMI-CEC (Anynet+) so the Xbox switches the TV when it turns on.

## Start the hub when the TV turns on

1. In TizenBrew, open **Settings**, then **Autolaunch Settings**, and pick Home Hub.
2. On the TV, turn on **Autorun Last App** (usually under Settings, General, Smart Features).

Do this last, after everything else works, so TizenBrew's own menus stay easy to reach while you set things up. Samsung can still decide to show its own home bar after some updates.

## Change the tiles

Everything lives in `app/config.js`. Each tile has a `kind`:

- `app` opens an installed app. `match` lists names to look for. The first exact match wins, otherwise the shortest name that contains the text.
- `tizentube` opens the TizenTube module through TizenBrew.
- `input` presses a remote key, for example `KEY_HDMI1`, `KEY_HDMI2`, `KEY_SOURCE`.
- `dashboard` opens a web page full screen, for example Home Assistant or Grafana.
- `allApps` opens the list of every app.

`tone` picks the color bar: `red`, `blue`, `indigo`, `green`, `amber` or `slate`.

### Adding a dashboard

Uncomment the example in the Dashboards row and point `url` at the page. Some sites refuse to load inside another page. If yours shows blank, that site blocks framing and needs its own setting changed.

## Updating

TizenBrew loads modules through jsDelivr, which caches each branch for a while. After pushing a change, wait a bit or purge the cache at `https://purge.jsdelivr.net/gh/irosen419/tizen-takeover@main/app/config.js` (one URL per changed file), then reopen the hub.

## How it works

- `app/` is the screen. Plain ES5 JavaScript so the TV's older browser can run it.
- `service.js` runs inside TizenBrew's Node service on the TV. It listens on `127.0.0.1:8095` only and lists apps, opens apps and presses remote keys when the page can't do it directly.
