# Tablet mode

The hub (`app/hub.html`, served by the Pi at `:8097/app/hub.html`) on a wall tablet: Dragon Touch TM15, Android 7.1.2, Fully Kiosk Browser on the system WebView (Chrome 52). No remote, no Tizen API, no `service.js`.

## When it turns on

- `?as=tablet` in the address: always on. `?as=tv`: always off.
- Otherwise, on its own: no Tizen API, no Tizen/webOS in the user agent, a touch screen (or Android), and `service.js` (`127.0.0.1:8095/ping`) does not answer within 3 s. A TV never qualifies, and nor does a laptop browser without a touch screen (so the browser tests are unchanged).
- When on: `html` and `body` get the class `tablet`; every widget's `ctx.tablet` is true, and `ctx.noHelper` too when `service.js` did not answer. Tiles are drawn again once it turns on.

## What changes (only in tablet mode)

- **Closing a panel.** The tablet's Back button leaves Fully, so the Back chip says "Tap to close" (or "Tap to shrink", "Tap to stop typing") and a tap does what Back does. A tap on the dark around a panel does the same.
- **Web pages full screen** (`ctx.openFrame`, a dashboard item): the chip says "Tap to close" and closes the page at a tap; Back still does too.
- **Menu.** A small tab on the bottom edge ("Menu"). Tap it, or drag it up, and a full-screen sheet slides up. Left: Settings (Look Auto/Light/Dark, Language, Guest mode behind its PIN: the same setters as the Clock page, which keeps its own controls), then About this hub (with the watch link test). Right: the layouts (Photos among them), then Photos with Start slideshow. The About strip and the layout bar themselves move into the sheet while it is up. Tap a layout to use it. Each column scrolls by touch on its own (bottom padding keeps the last row clear). Close: the Close pill at the top, a drag down on it, or Back on a keyboard.
- **Slideshow.** Start slideshow shows every photo full screen with the Photo album's own crossfade and blurred fill (`HUB_PHOTOS.slideshow` in `app/widgets/photos.js`), until a tap anywhere or Back. A short "Tap to close" shows at first.
- **No `service.js`: apps open on the TV through the Pi.** The apps tile and every button stay as they are. Opening something (an app, YouTube through TizenBrew, an input key, a webhook item, or Watch on a show in the Schedule) goes through one seam, `ctx.launchOnTv(req)` in `app/hub.js`: it says "Opening Netflix on the TV…" and posts `{ kind, name, match?, key?, url? }` to the Pi's `POST /tv/launch`, which is to turn the TV on if it is off, wait until it is ready, and open it through Home Assistant. A failure says so in one line ("Couldn't open Netflix on the TV (the Pi needs an update)" when the Pi is too old to have the route, else the Pi's own reason).

  **`POST /tv/launch` contract.** Body `{ kind: 'app' | 'tizentube' | 'key' | 'webhook', name, match?, key?, url? }`. The Pi answers at once with `202 { ok: true, queued: true }` and does the work in the background (turn the TV on if it is off, wait until it has stayed on, open the app through Home Assistant, retry; the TV can take a minute to wake). The client counts 202 (or any 2xx with `ok: true`) as success and keeps "Opening X on the TV…" up for about 15 s. Any other answer, or none within 10 s, shows the failure line. "All apps" says "All apps works on the TV" (the list comes from the TV itself). The "Couldn't read the app list" toast is not shown. With `service.js` (a TV), nothing changes: apps open on the device as before. The Pi side is `pi/tvlaunch.js` (server 0.33.0): Home Assistant turns the TV on (`media_player.turn_on`, entity `TV_ENTITY`; the default is the usual name, set it if yours differs) and waits until it stays on, then opens the app with `select_source` using the name in the TV's source list (the first of `match` that fits). An app the list lacks, or one that did not open, goes through the Pi's own remote link (`pi/tvremote.js`, by app name). Keys use `play_media` `send_key`; a webhook is a POST to the same path on Home Assistant. YouTube (`tizentube`) opens a TizenTube source if there is one, else YouTube. One launch at a time (409 while busy). See what the TV can open with the mailbox `tv.status`.
- **To-do "Completed".** Chrome 52's flex box let the tile grow with its content, so the Completed section ran past the tile. The tile now measures against its own bottom.
- **Sliders.** Ambience: a tap on a light's bar sets that level, a drag scrubs it; neither turns the light off (a tap on the name still does, as OK). Budget lab: a tap on the cap's arrows moves it, as Left and Right do.

Styles: `app/tablet.css` (every rule needs `.tablet` or an element only tablet mode makes). Code: "tablet mode" near the end of `app/hub.js`. Test: `node dev/tablet-test.js`.

## Not covered

- Back on the tablet still leaves Fully (Fully's own setting decides). A later step could push a history entry while a panel is open.
- The weather tile tries a direct fetch before `service.js`, so it works when the tablet can reach the weather service itself.
