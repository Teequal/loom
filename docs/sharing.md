# Sharing Loom with invited testers

Loom runs on this Mac and is reached through a Cloudflare quick tunnel: a public `https://….trycloudflare.com` address, invite-only. No accounts or hosting bill. The Mac has to be on and awake (the share script keeps it awake while it runs).

## Start, update and stop

```bash
npm run share
```

```bash
npm run share:update
```

- `share` builds the shared copy if there isn't one (into `.next-share`, separate from the dev server's), then starts the production server on port 3100 with invites on, the tunnel, and `caffeinate`. It prints the public address and writes it to `data/public-url.txt`.
- `share:update` after code changes: rebuilds the shared copy and restarts its server. **The address stays the same**, since the tunnel keeps running. Testers see a few seconds of errors at most.
- Ctrl+C on `share` stops everything. The dev server on port 3000 is separate, with no invite needed at home.
- **The address changes only when `share` itself starts again.** Invite codes never change, so run `invite list` for the new links and resend them.
- Right after a start, this Mac may say the address doesn't exist for a minute (its DNS remembers an early miss). Other devices are fine.

## Invites

```bash
npm run loom -- invite add "Sam" --cap 2
```

| Command | What it does |
|---|---|
| `invite add "<name>" [--cap 2]` | A link for a tester: their own campaigns, and a cap in US$ on their model calls |
| `invite add "<name>" --owner` | A link for you, from outside: your campaigns, no cap |
| `invite list` | Everyone, what they've spent, their links |
| `invite cap "<name>" <dollars>` | Change a cap |
| `invite revoke "<name>"` / `restore` | Switch a link off or back on (their campaigns are kept) |
| `invite remove "<name>"` | Delete them and their campaigns (can't be undone) |

## What a tester gets

- Opening the link remembers the code in their browser for 60 days.
- They start with an empty "My campaign" and the welcome: start from a hook, paste notes, start typing, or open the sample. The sample is their own copy ("Sample: The Potion Swap"); a reseed never touches it.
- They see only their own campaigns. Every API request is checked: each campaign, entry, character, thread and key moment it names must be theirs (`mayTouch` in `src/server/access.ts`).
- At their cap, Loom says "You've used this test's AI allowance…" and stops calling the model. Everything else still works.

## How it knows who's outside

The tunnel adds a `cf-connecting-ip` header to every request. With `LOOM_INVITES=on`, a request with that header needs a working invite cookie. Requests from this Mac or the home network don't. Pages are gated in `src/proxy.ts`, the API in the route helpers (`src/server/route.ts`), and the cap in `callLlm` (`checkAllowance` in `src/core/access.ts`). Each call records its tester in `llm_calls.tester_id`.

## Limits

- One Mac, one SQLite file: fine for a handful of testers, not for many at once.
- If the Mac sleeps, loses Wi-Fi or restarts, Loom is offline until `npm run share` runs again, with a new address.
- The first ask after a start is slower (~8 s) while the server warms up.
- For something always on, move to a host (Fly.io with a disk for the database was the other option).
