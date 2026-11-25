# Spanish flashcards and "engage on OK"

The first Spanish study widget (plan: `/mnt/project-files/spanish-center/plan.md`, step 2 without Review due and Streak) and the first tile used in place with the remote.

## Engage on OK (app/hub.js)

Most tiles only show something, so OK on them opens the panel at once, as before. A widget that sets `engage: true` (or a function of its size) is interactive on its tile:

| Key on the focused tile | Not engaged | Engaged |
| --- | --- | --- |
| short OK | engages it: the ring turns sky blue with a halo, the widget's hint fades in at the tile's foot | the widget's own action (Flashcards: flip) |
| hold OK | opens the panel | leaves and opens the panel |
| Left / Right | move to the next tile | the widget's own (Flashcards: Again / Got it); a held arrow counts once |
| Up / Down | move | leave, then move |
| Back | nothing (home) | leave |

Short or long: a keyup within 550 ms is short; a key repeat, or no keyup by 550 ms, is long. Until the TV has sent one keyup, only a repeat counts as long, and a press with neither keyup nor repeat is short after one second (so a remote without keyup still works, a little slower). **Untested on the real remote:** check that a quick OK engages (no delay of a second), that holding OK opens the page, and that holding OK on another tile never presses inside its panel.

Only Flashcards opts in. Tablet mode (the Dragon) never engages: the tile's buttons take taps. Hooks: `engage`, `onEngagedKey(key, ctx)`, `onEngage`, `onDisengage`, `engageHint`; `ctx.engaged()`, `ctx.disengage()`. The widget leaves its last 1.6rem for the hint.

## Flashcards

- Cards: `app/spanish-cards.js`, built by `node dev/build-spanish-cards.js ../conjugate-me/data/verbs.json` from Conjugate Me: 70 everyday verbs, presente, pretérito, imperfecto, futuro, five persons (no vosotros) = 1,400 cards; 821 have a real Tatoeba sentence (shortest kept). Forms CC BY-NC-SA 3.0 (Jehle, Ghidinelli), sentences CC BY 2.0 FR.
- Rounds (`app/flash-math.js`): due cards first, then new ones in teaching order (all presente first), 10 new a day, 20 a round. Again brings the card back a few cards later. Got it moves it up a box: due again in 1, 3, 7, 14, 30 days. Again resets it to today. After a round: Done for now and Ten more.
- Progress: `pi/spanish.js`, one SQLite table in `data/spanish.db` (`id, box, due, misses, first, last`), the Pi's local day. `GET /spanish/progress`, `POST /spanish/ops` (touch door: TV, Dragon and phone). Unsent answers are kept and sent again every minute; the tile says "Not saved yet".
- Phone: the touch app's Flashcards view (tap the card, Again, Got it).
- Layout: "Spanish" in the switcher (Word of the day, Flashcards, and everyday tiles).
- Tests: `node dev/flashcards-test.js`, `node pi/spanish-test.js`.
