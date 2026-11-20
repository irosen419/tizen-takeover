# Asset storage

Big or growing pictures live in the public Cloudflare R2 bucket **home-hub-pictures**, not in this repository. It keeps the repository small: jsDelivr serves it to the TV and refuses packages over 150 MB and files over 20 MB. The free tier stores 10 GB, and downloads cost nothing.

Public address: `https://pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev/` (r2.dev is rate-limited, which is fine at this scale; a custom domain can replace it later with one line per manifest). Anyone can read it (GET and HEAD, CORS `*`), so private reference art and photos never go here.

## Folders

One top-level folder per kind:

| Folder | What | Who reads it |
| --- | --- | --- |
| `day/`, `night/`, `CREDITS.md` | background pictures (PR 95; at the root because they came first) | the hub, through `app/backgrounds/backgrounds.js` |
| `clay/source/v1/` | clay source art: `raw/` pose sheets and `models/` turnarounds | `art/clay/tools/fetch_source.py`, checked against `art/clay/source.sha256` |
| `clay/sprites/vN/` | (later) clay sprites, if they outgrow the repo | the hub |
| `agents/<name>/vN/` | (later) pixel character art, such as `agents/lift/v2/` | the hub |

## Rules

- **Versioned paths, never overwritten.** A changed set goes in a new `vN/` folder; old ones stay, so an older hub build keeps working. Objects are uploaded with `Cache-Control: public, max-age=31536000, immutable` (backgrounds use 7 days).
- **The hub never depends on the bucket.** Anything the TV loads from it has a fallback in the repo, like the ocean picture for backgrounds. A character whose art can't load skips its visit, and the chip or tile stays as it was.
- **Small art the hub needs at start stays in the repo**, next to the code that uses it (today: clay sprites 0.75 MB, Lift 0.05 MB). Move a family to the bucket when it passes about 5 MB or grows every week.
- **One manifest names the base address**, so moving hosts is a one-line change.
- **Upload** with the Cloudflare R2 API: `PUT .../r2/buckets/home-hub-pictures/objects/<url-encoded key>` with the right `Content-Type` and `Cache-Control`. Claude threads can do it; no Pi step is needed.
- Every new folder or reader goes on the Architecture page (`studio/architecture/data.json`, node `cloud.pictures`).
