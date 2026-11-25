# Ian and Ember on the Now Playing page

The clay puppets come out and play along while a song plays on the Now Playing page. The code is `app/widgets/nowplaying-band.js` and `.css`; `app/widgets/nowplaying.js` tells it what the page shows (`bandSync()`). The wanderers (`app/clay.js`, `docs/clay.md`) are separate: they never come while a page is open.

## Where and what

| Page | Kind | Scenes |
| --- | --- | --- |
| Full screen with the visualizer (the small card upper left) | stage: a floor rises along the bottom, with footlights and spotlights | `outfit` (both dressed for the song's genre, and a "Dressed for punk" chip on the card), `band` (Ian on drums, Ember on guitar on her hind legs), `singer` (Ember at a mic stand in the spotlight, Ian on drums), `encore` (a clay backing band behind them: bass, two backup singers, sax, keys; Ian's knee-slide air guitar, Ember howling into a mic) |
| Expanded page, or full screen without the visualizer | corner: small, standing on the panel's bottom edge right of the chips and the button | `headphones` (both nodding along), `dance` |

The corner is measured each time: anything in the bottom strip (the picture, the times, the bar, the chips, the button) pushes them right, and with less than about 175 px of room (times the zoom) they don't come. A podcast, or nothing playing, brings no one.

## When

- A visit starts 5 s after the page opens (or changes between stage and corner), once the song plays and the remote has been left alone for 6 s.
- A stage visit lasts 30 s, a corner visit 18 s. The next comes 40 to 80 s later (stage) or 60 to 120 s (corner).
- Any key, a pause, the page closing or the visualizer going off sends them away at once (a 0.45 s fade). The wait for the next visit starts again.
- A song whose genre has an outfit brings the `outfit` scene 3 s later (once quiet), once per song; otherwise stage scenes take turns: band, singer, encore.
- They bounce, sway and drum on the song's tempo when the vibe has one (`vibe.tempo`, halved or doubled into 0.36 to 1.1 s a beat), else 0.55 s. They don't follow the beats themselves.

## Outfits

The Pi sends the first artist's Spotify genres with every song's vibe (`pi/vibe.js`; since server 0.40.0 also for songs ReccoBeats knows, and for songs kept from before, asked once; when Spotify can't answer, the song keeps its vibe and the genres are asked again 30 minutes later). The TV picks an outfit from them, in this order: `punk` (punk, emo, ska), `country` (country, americana, bluegrass), `hiphop` (hip hop, rap, trap, r&b), `synth` (synth, new wave, 80s, disco, electronic, house), `rock` (grunge, metal, rock, alternative). Nothing matches: no outfit, and the stage scenes play in everyday clothes. `HUB_CONFIG.widgets.nowplaying.bandOutfits` maps an artist's name (any case) to an outfit and wins over the genres: `{ 'Green Day': 'punk' }`.

The chip says "Dressed for punk" ("Vestidos de punk"), first among the card's chips while the scene plays (the card keeps one row of chips; the last ones give way).

Top artists from Spotify (`user-top-read`) are not used: that needs another sign-in on the Pi. The outfits only need the genres the Pi already gets.

## On the TV and the tablet

- Nothing loads until the first visit: then `app/clay/music.js` (the list) and that scene's pictures (2 to 6, plus a note and a star). A picture that fails skips the visit; the next try is 20 s later.
- Only `transform` and `opacity` animate (CSS animations, tempo set inline). No filters: the backing band is darkened in its pictures. The spotlights are border trapezoids, not `clip-path` (Chrome 52 on the tablet has none).
- The backing band, the spotlights, the footlights and the notes come only when the visualizer runs at `radiant` or `sharp`. At the lighter levels (a slow TV steps down by itself) the stage scenes have just Ian and Ember and the floor.
- Reduced motion (`prefers-reduced-motion`) keeps them still; only the fades stay.
- `?band=off` on the address, or `band: false` under `widgets.nowplaying` in `app/config.js`, turns it off. Off, nothing of it loads.

`HUB_NP_BAND.status()` gives `{ on, mode, scene, loading, dueIn, visits, outfit, problem }`.

## The art

`art/clay/tools/music.py` holds the five sheets (`mus-ian`, `mus-ember`, `mus-ian-fits`, `mus-ember-fits`, `mus-band`), kept out of `sheets.SHEETS` so the wanderers' `export.py` never sees them. `music.py gen <sheet>` asks Gemini, `music.py cut` cuts them, `music.py export` writes `app/clay/music/*.webp` at 2x (Ian standing 320 px) and `app/clay/music.js` with each one's size at 1x. The raw sheets are in the picture bucket under `clay/source/v1/raw/` (`fetch_source.py` gets them). The backing band are invented people, nobody real. 24 pictures, about 260 KB.

Test: `node dev/band-test.js` (`SHOTS=<folder>` saves screenshots).
