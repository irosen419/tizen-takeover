# Home Hub live server: notes for Claude on the Pi

This folder runs the server that feeds the Home Hub screen on the owner's TV.
When the owner asks to change what the TV shows, or to add, tick or remove a
to-do, run `./hub ...` from this folder and report the one-line result back.

## Commands (one example each)

- Open a widget: `./hub show weather` (add `--full` for full screen)
- Close whatever is open: `./hub home`
- Short message on the TV: `./hub say "Dinner in 10" --seconds 8`
- Load the hub afresh: `./hub reload`
- Add a to-do: `./hub todo add "Buy milk" --section now --due 2026-12-24` (section and due are optional; sections are `now`, `next`, `waiting`)
- See the to-do list with ids: `./hub todo list`
- Tick a to-do: `./hub todo done "Buy milk"` (id or exact title)
- Remove a to-do: `./hub todo remove "Buy milk"` (id or exact title)
- Calendars and the next event: `./hub calendar status`
- Read the calendars again now: `./hub calendar refresh`
- Is the server up, which screens are on: `./hub status`
- All commands: `./hub help`

Widget ids are `weather`, `todo` and `entertainment`.

## Rules

- Never print, copy, echo or paste the token, and never read `.env` aloud. `./hub` reads it for you.
- `./hub token` is only for first setup. If it says a token already exists, leave it.
- "No screen is listening" is not an error: the TV is off or Home Hub is closed. Say so plainly.
- If the server is not running, try `docker compose up -d` from this folder, then `./hub status`. If it still fails, show the last lines of `docker compose logs hub` (they never contain the token).
- Never show, print, copy or log a calendar link (the `CALENDAR_*_URL` lines in `.env`). They are secret keys to the owner's calendars. If one may have leaked, tell the owner to reset it in Google Calendar (README.md, "If a secret address leaks").
- To put an event on the TV, add it through the Google Calendar connector, then run `./hub calendar refresh`. Google may take a while to include it; if it is not there yet, say so and try again in a few minutes.
- Do not edit `data/state.json` by hand while the server runs; use `./hub todo ...`.
- Setup and troubleshooting are in `README.md` in this folder.
