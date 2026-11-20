# Home Hub design reference

Extracted from what already ships (`app/style.css`, `app/theme.css`, `app/motion.js`, `app/hub.js`) and Ian's decisions. Nothing new is designed here. Values live in `docs/design-tokens.css` (reference only, not loaded; the shipped CSS wins if they differ). Anything marked **candidate** is not a rule.

## Look
- **Night window.** Tiles are small dark rounded panes over a picture. Night is the default; `body.theme-day` (set by hub.js between sunrise and sunset) gives light glass and dark ink.
- **Attribute first.** The datum leads, the label recedes: tile titles are quiet (1rem, weight 500, `--text-2`), big data is light (weight 300, tabular numbers). Labels are sentence case on a hairline. Badges are sentence case with no tracking (uppercase tracking costs ~20% width, which Spanish cannot spare).
- **No thick coloured side bars.** Use a dot in the line's colour. The must-do alert is one line, not a card in a card.
- **Concentric radii.** Outer tile 2.2rem = inner 0.8rem + 1.4rem padding. Inner window radius = outer minus rim.
- **Alpha hairlines, light from above.** Borders are translucent (`0.06rem`). On dark, depth is a lighter top edge, never a shadow. The tile border stays `--edge` wide in every state (focus ring, accent and glass origin measure it).
- **Masked edges, not "...".** Long text fades (mask gradient) where it can; titles still take a short form (hub.js `fitTitle`) before ending in an ellipsis.
- **Colours** are designed in OKLCH and shipped as the sRGB hex they map to (the TV engine has no `oklch()`). Status: must (red), optional (amber), passive (green), sky (blue). Day versions are darker for contrast.
- **"Soon" tiles** are an empty dashed pane so the picture shows through.
- Real brand logos are fine for app tiles (the hub is private).

## Tiles and layout
- Screen is 80rem x 45rem (`html { font-size: calc(100vw / 80) }`). Grid is 12 columns x 6 rows; a tile's size in cells picks how it draws (strip = 1 row, standard = 2, tall = 3+; narrow 1-2 cols, standard 3-5, wide 6+; 1-col tiles get `tile-w1`: one number, time or icon). See `docs/tile-sizes.md`.
- Tiles are small dark rounded widgets. Click expands **in place**: the tile grows and pushes its neighbours aside (keep this). OK opens a panel of 46 x 26rem; Full screen fills the screen. `openMode: 'full'` in config.js skips the panel.
- Each widget declares itself via `window.HUB_WIDGETS.push(...)`; tiles are listed in `app/config.js`.

## Motion
- Animate **transform and opacity only**. No filters, no animated layout.
- **Focus changes are instant** (plain border and colour swap). The only focus motion is the gliding ring (190ms).
- Easing `cubic-bezier(0.2, 0.7, 0.2, 1)`. Open: push 320ms, expand 260ms, fade 140ms (auto steps down a rung when the TV stutters; always keep the quick-fade fallback).
- Panel items stagger 35ms apart, all in by 500ms. Ambient loops (glow, breathing) are opacity only, and are off under the fallback rungs.

## TV engine constraints (Chromium-63 class)
Plain ES5. No CSS grid, no flex gap, no `oklch()`, no `dvh`, no filters. `mask-image`, `mix-blend-mode`: only with a tested fallback.

## Text expansion (Spanish +25%) and diacritics
- Every string can grow 25%: size boxes for it, never to the English width. Prefer wrap, mask-fade or a short form over a clipped or ellipsised word. Test both languages (`app/i18n.js`, `i18n-dyn.js`).
- Diacritics must not clip: `line-height` at least 1.3 on text; where a clip is needed (one-line titles) add vertical padding inside the clip and cancel it with the same negative margin (see `.tile-title`).
- No uppercase-with-tracking labels. Money keeps `$1,265`; names from outside (merchants, goals) stay as sent.

## Loader and CSS rules
- Every CSS file ends with `.css-end { top: 0; }` and is listed in `dev/styles-test.js` `ORDER` (and linked in `app/index.html`). A broken or short stylesheet is refetched; the marker is how the loader knows it arrived whole.
- `theme.css` loads last and overrides `style.css` (e.g. title size/weight).
- Large pictures live in the R2 bucket, not the repo.

## Process
- Before/after mock-ups change **only** the thing changed.
- Screenshots at milestones, in English and Spanish, night and day where it matters.
- Never push `main`; version number is a label set at merge.

## Candidates (not rules)
From `home-hub-style-ideas.md` (Ian, 2026-11-18): OKLCH gradients; dynamic viewport units; blurred icon swap; `mix-blend-mode: multiply` on product shots; icon stroke matching title weight (already 2px on tile icons). Each needs a TV test with a fallback before it becomes a rule.
