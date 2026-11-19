# Extra health checks

`pi-health.py` runs every executable file in this folder once a week (skipping
`*.md`, `*.example` and `*.disabled`) and keeps what it prints under
`extras.<file name without extension>` in the report. This is where new parts of
the Pi add their own checks, so the main script never needs to know about them:
the Bluetooth storm speaker, the room lights, and whatever comes next.

## The contract

- Print exactly one JSON object on standard output, and nothing else.
- Finish within 90 seconds. `--quick` is passed on test runs: skip slow work then.
- Exit code does not matter; a crash or non-JSON output shows up in the report as an error.
- Shape (only `status` is needed):

```json
{
  "status": "ok",
  "summary": "Speaker paired and trusted; last storm show played Nov 21",
  "data": { "paired": true, "lastPlayAt": "2026-11-21T20:14:00-06:00" },
  "flags": [{ "level": "warn", "area": "storm", "text": "The speaker did not connect on 2 of 5 tries" }]
}
```

`flags` with level `warn` or `bad` join the report's own list, so the weekly
summary picks them up with everything else.

## Rules (same as the rest of the report)

- Never print a token, a key, anything from `pi/.env`, an IP or MAC address, a
  Wi-Fi name, a Home Assistant entity id, a link, or what plays. The report is
  scrubbed once more anyway, but do not lean on that.
- Counts, states and times only.
- Read only: a check never changes anything.

## Example

`bluetooth.sh.example` is a starting point for the storm speaker. To use it:
copy it to `bluetooth.sh`, `chmod +x bluetooth.sh`, and commit.
