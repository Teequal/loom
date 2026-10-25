# Loom (rebuild) — Project Brief

This file is the shared context for building Loom. Read it fully before planning or writing code. Keep it updated as decisions are made.

## Who I am

Jacob. Production supervisor in pharmaceutical manufacturing (Sydney), operational-excellence background. Comfortable with tech and AI-assisted building; not a full-time software engineer. Building this on weekends and afternoons, so scope must stay small and every step should produce something testable.

## The product in one line

**When players go off-script, Loom finds the threads already in play and shows the DM how to tie the new moment back to them.**

Generic AI tools generate fresh content, which makes the story drift. Loom's job is the opposite: callbacks, payoffs and connections to what already exists.

## Why this matters (the canonical example)

In my first campaign I gave one player a potion that made him believe he couldn't die (he could). It was hilarious: he dived into every danger and the party had to reel him in. But it started derailing the plot. Another potion had made a second player (his girlfriend in real life) unable to speak. The fix: I gave each of them the other's cure, so they had to cure each other. The solution came from threads already on the table, and it paid off far better than inventing something new.

The general lesson: players always want to find something. When I hadn't planned for it, everything got made up fresh and the game snaked away. When things tied back to earlier events, it always paid off better.

Loom should produce that kind of moment, on demand.

## Target users

- **Newer DMs** who haven't built their own methods and struggle to improvise coherently.
- **DMs who run games online** (Discord, Roll20, Foundry, etc.), who already live in digital tools.
- Not the target: seasoned veteran DMs with established systems. They're unlikely to adopt new tools.

## What "magic" looks like (acceptance criteria for the whole product)

1. **At the table:** players do something unexpected. I type it into a single free-text box. Within a few seconds I get 2–3 short, playable options that fit the campaign and match the energy of the moment, each tied to a named existing thread, with a one-line "why this fits".
2. **Between sessions:** I paste rough session recap notes. Loom updates the campaign's threads (new, progressed, resolved) and suggests payoffs, complications and fun things to do with the players based on where each of them currently is.

## Core design principles

- **The core unit is the open thread, not the entity.** A thread is anything with unspent narrative payoff: an unresolved hook, a player condition ("believes he can't die", "can't speak"), an NPC promise, a mystery item, a grudge, a debt, a secret. Characters, locations and items matter mainly as things threads attach to.
- **Retrieval does the heavy lifting; the model writes a little.** Finding which threads are relevant to a moment should be cheap (database queries, graph links, small embeddings). The LLM only sees a small, well-chosen context and writes a few sentences. Inference cost must stay low enough for a hobby-priced product.
- **Fast and glanceable at the table.** The live mode is used mid-session. Short output, no walls of text, a few seconds at most.
- **The DM stays in charge.** Loom suggests; it never decides. Everything editable.
- **Simple enough for the least enthusiastic user.** Lesson from a previous project of mine: I built a tool that suited my own detail-oriented style and nobody else wanted to use it. Minimal input, minimal setup.
- **The string board is the visual layer, not the engine.** Show what's dangling and what's connected. Build it after the engine works.
- **Manual and extracted data are equal citizens.** DMs can type anything by hand or let Loom extract it; manual features are highly valued and must never be removed. Every value records its source, extraction never overwrites a DM entry (it proposes instead), and blanks beat guesses.
- **Skeleton and intuition.** Structured entity data (status, locations, relationships, traits) is the skeleton that keeps continuity and prevents slips. Embeddings are the intuition that finds relevance by meaning. Both matter; richer structure makes better embeddings. Full design: [docs/entity-model.md](docs/entity-model.md).
- **UX a class above.** Cut through the nonsense and get the DM to the magic fast. Show the essentials first and fold the depth away.

## Rough data model (starting point, not final)

- **Campaign**
- **Thread**: title, kind (hook / condition / promise / mystery / grudge / item / other), status (open / progressing / resolved), summary, payoff ideas, links to entities, first seen (session), last touched (session).
- **Entity**: name, type (player character / NPC / location / item / faction / other), short description.
- **Player state**: per player character, current conditions, wants, recent actions (could be modelled as threads attached to the PC).
- **Session**: date, raw recap text, extracted changes.
- **Links**: thread ↔ entity, thread ↔ thread.

## Lessons from the previous attempt (repo: Teequal/loom, 2025)

- It built auth, Stripe payments, dashboards and export before the core idea existed. The "AI context" just grabbed the 20 most important entities regardless of the question; no graph traversal, no embeddings, no recap extraction. **Do not repeat this. Core engine first, scaffolding last.**
- A `backend/.env` was committed to that repo, and `node_modules`/`.history` were committed too. In this repo: `.env` and dependencies in `.gitignore` from the first commit; secrets never committed.

## Competitive landscape (as of Oct 2026)

AI campaign tools exist: LoreKeeper (upload your world, AI assistant), Jenova (agents for worlds, NPCs, plots, recaps), Taskade campaign templates with mind-map views, plus classic tools like World Anvil and Kanka. Most are chat-style generators or filing cabinets. Reported weakness: conversational memory degrades as campaigns grow, while structured notes survive. Loom's angle: **structure-first threads + callbacks, built for newer and online DMs.**

## Phase 1: the spike (2–3 weekends)

Goal: prove the magic before building anything else. **No accounts, no payments, no deployment, no polish.** Local only, single user, single campaign.

1. **Recap → threads.** Paste session notes; get a clean list of open threads, entities and player states that I'd agree with. Store them.
2. **The improv box.** Type an off-script player action; retrieve the most relevant open threads; get 2–3 tied-back options with a one-line reason each.
3. **Between-session suggestions.** Given the current threads and player states, suggest payoffs and complications.
4. **The test.** Run it on my real campaign notes. Feed in moments that actually happened (including the potion situation) and some invented ones.

**Spike passes if:**
- I'd genuinely use at least one suggestion most of the time.
- The improv box answers in a few seconds.
- Suggestions visibly tie back to existing threads rather than inventing new material.
- Cost per call is small (track it from day one).

If it passes: show it to a handful of newer/online DMs (DM communities online), then plan Phase 2 (string board, persistence across campaigns, accounts, VTT/Discord integrations). If it fails: adjust the approach or stop, having lost weekends rather than months.

## Tech guidance

- Choose the simplest stack that does the job; propose options and trade-offs before committing. A lean TypeScript or Python app with SQLite locally is likely enough for the spike.
- Keep the LLM behind a small provider-agnostic interface so models can be swapped for cost/speed.
- Log every LLM call's latency and token usage.
- Keep a small set of saved test scenarios (from my real campaign) so changes can be compared over time.

## How to work with me

- Plan first, then build in small steps that I can run and see.
- Explain decisions briefly in plain language; I'll ask if I want depth.
- Push back if I'm drifting into scaffolding before the core works.

## Open questions

- Where my old campaign notes are and how rough they are (to be supplied as test data).
- Exact format of the improv output (I'll judge by feel during the spike).
- Pricing and business model: deferred until after the spike and DM feedback.

## Decisions (Oct 2026)

- **Stack: TypeScript + Next.js (App Router)**, chosen because a full website is the end goal, so the spike shouldn't need rewriting later.
- **Engine lives in `src/core/`** and is framework-agnostic. The spike CLI (`scripts/loom.ts`, run with `npm run loom -- <cmd>`) and later the web pages both call it.
- **Database: SQLite via libSQL + Drizzle ORM.** Local file `data/loom.db` (gitignored). libSQL can later point at a hosted database without changing code. Schema in `src/core/db/schema.ts`; after changing it, run `npm run db:generate`. Migrations apply on startup.
- **Player states are threads** of kind `condition` linked to a PC entity; there is no separate table for them.
- **Thread history** lives in `thread_events` (new / progressed / resolved / edited, per session).
- **LLM: Anthropic, with a model per feature** (`FEATURE_MODELS` in `src/core/llm/index.ts`):
  - **Recaps: Opus 5.5**, chosen because Jacob wants the smartest model for the once-per-session job.
  - **Improv: Haiku 5.5** (since blind run 3, 24 Oct), with Opus 5.5 as the upgrade tier (`--model opus`).
  - **Between-session suggestions: Opus 5.5.**
  - **Everything else: Haiku 5.5.**
  - Override with `--model` or `LOOM_MODEL_<FEATURE>`.
  - Sonnet and Opus calls use server-side refusal fallback.
  - The provider sits behind a small interface; every call is logged to `llm_calls` with the model that actually answered.
- **Model comparison (Oct 2026, 4 Duradan moments):**

  | Model | Speed | Cost per moment |
  |---|---|---|
  | Haiku | 3–6 s | ~$0.0005 |
  | Sonnet | 4–5 s | ~$0.009 |
  | Opus | 6–7 s | ~$0.018 |

  Haiku mentions threads, while Sonnet and Opus pay them off. Jacob judged Opus tangibly better. Its figurine option (Khayiulad's hand won't let go) is exactly how he'd play it: the cost of a power grows with use.
- **Scenario run 1 (Oct 2026, 10 Duradan moments, Jacob's "would use" ticks):**

  | Model | Options ticked | Moments with at least one usable option |
  |---|---|---|
  | Opus | 14/30 | 10/10 |
  | Haiku | 9/30 | 8/10 |
  | Sonnet | 6/30 | 6/10 |

  One run each, so results are noisy. Sonnet doing worse than Haiku contradicts the earlier 4-moment impression; rerun before settling the improv default.
- **Scenario run 2 (blind: options shuffled, models hidden, player-agency rule added):**

  | Model | Options ticked | Moments with at least one usable option |
  |---|---|---|
  | Opus | 13/30 | 9/10 |
  | Haiku | 11/30 | 8/10 |
  | Sonnet | 7/30 | 6/10 |

  Same ranking as run 1, so Sonnet's last place is real, not position bias. Haiku is about 20× cheaper than Sonnet and faster. The agency rule reduced but didn't eliminate PC-puppeting: Haiku wrote "Salaena lunges for the ledge", and Sonnet wrote "Khayiulad steps between them". (NPCs acting, followed by asking a player to respond, is correct practice.) Blind runs: `scenarios <file> --blind`, then `score <file>-blind.md`.
- **Player agency (Jacob's feedback):** some options decided what player characters do or say ("Salaena lunges for his collar"). The GM controls the world, NPCs and consequences; players control their characters. A PC acts against their will only through an established condition or a failed roll (e.g. the figurine madness roll).
- **Player-agency harness (Jacob's design):** improv options come back structured, not as free text.
  - `setup` beats are typed: `world`, `npc` or `outcome`. `outcome` is the result of what the players already declared.
  - `hand_off` is a question to a player or a roll.
  - `on_fail` says what happens after a failed roll.
  - Code rejects any option where a PC is the subject of a world/npc beat, or of an outcome with a choosing, speaking or perceiving verb (`AGENCY_VERBS` in `src/core/improv.ts`). It retries once if fewer than 2 options survive.
  - The prompt now labels every name PC/NPC and includes a party roster with each PC's conditions.
  - Haiku runs improv with thinking off (`fast`). With it on, structured output took 8–13 s; off, it takes 5–7 s.
  - Known gaps: possessive phrasings ("Khayiulad's fingers tighten…") slip past the check. NPCs sometimes get dropped into scenes they couldn't be in (Zara at the Woods ritual site). Labels can still narrate PC feelings.
- **Product idea (Phase 2, needs accounts and billing):** improv on Haiku by default, with Opus as an upgrade tier and a free trial or allowance of Opus calls (Jacob, 24 Oct; Sonnet came last in all three blind runs).
- **Recap changes are proposed, not applied.** The DM approves each one.
- **Improv options must cite a real thread id** from the retrieved set; the code rejects any that don't.
- **Retrieval starts cheap:** entity/alias mention matching, graph hops and SQLite full-text search. Embeddings only if the test scenarios show they're needed.
- Real campaign notes live in `Old Campaign Notes/` (gitignored, private). The test fixture campaign (`npm run loom -- seed`) is the potion example with invented names.

## Phase 1 progress

- [x] Step 1: Project setup, schema, potion fixture, `seed` / `campaigns` / `threads` commands
- [x] Step 2: LLM interface + call logging (`ping`, `costs`). All calls go through `callLlm` in `src/core/llm/`, return Zod-validated JSON and default to effort `low`. Prices live in `PRICES` there.
- [x] Step 3: Recap → proposed thread changes → approve (`recap`, `apply`; logic in `src/core/recap.ts`, effort `medium`, ~18 s and ~$0.002–0.003 per session). Per-session text files are in `Old Campaign Notes/sessions/`. Duradan sessions 1–2 are applied; session 2 includes Jacob's DM-only corrections, added by hand.
- Learned in step 3: recaps only hold what players saw. DM secrets (e.g. "microfractures in reality cause the madness"; "the mind control causes the leaders' illness") have to be entered separately, and they matter for good suggestions. A DM-notes input is planned; for now, edit the proposal JSON before applying.

### Design feedback from testing (backlog)

1. **Clarifying questions after a recap.** Notes are summaries and miss details. When unsure, the model should ask the DM 2–3 short questions (e.g. "Were the ghostly butterflies a microfracture or a feature of the Woods?") rather than guess. Answers get folded in before applying. This replaces hand-editing JSON and fits the "minimal input" principle.
2. **Don't assert causes the notes don't state.** It labelled the butterflies a microfracture event, a guess presented as fact (it was actually a location effect). Uncertain links should become a question (see 1), not a claim.
3. **DM-notes input** for secrets the players haven't seen (see above).
4. **Missed a set-up consequence in terse notes.** Session 5 says "Darius consumed two unidentified potions… potential consequences set up" in bullet fragments, and extraction skipped it (added by hand). Explicit "setup / consequences" phrasing should always become a thread; a second "anything missed?" pass or a clarifying question could catch these.
5. **GM mechanics belong in threads.** Jacob runs hidden rolls: a madness roll on every figurine use, and resist-then-effect rolls for microfractures. Suggestions that use these mechanics land best, so capture them (DM notes or clarifying questions).
6. Weak "everything is legal trouble" links show up (session 1 Gary→Festival, session 3 bounty→Gary). The prompt could demand a concrete connection.
- [x] Step 4: Improv box (`improv "<moment>"`, `--why`, `--all`). Retrieval in `src/core/retrieval.ts` is in-memory scoring (entity/alias mentions, rare-word overlap, link hops, recency) rather than SQLite FTS. That's simpler at tens of threads; revisit when campaigns grow. Top 8 threads are sent to the model, and options citing threads that weren't sent are dropped. First results on Duradan: 3–6 s, ~$0.0005 per call.
- [x] Step 5: Scenario runner (`scenarios <file> --models haiku,sonnet,opus`). Scenario files are in `scenarios/`; real-campaign ones go in `scenarios/private/` (gitignored). Each moment lists `expect` pieces of thread titles. The runner checks whether retrieval found them and whether options used them, then writes a side-by-side Markdown report with "would use" checkboxes to `data/runs/`. Results depend on the campaign's current threads, so rerun all models together when comparing.
- [x] Step 6: Between-session suggestions (`suggest`, logic in `src/core/suggest.ts`, Opus by default). It returns 3 collisions (2+ threads paying each other off), one idea per PC, and ways back into threads quiet for 2+ sessions. Every open thread is sent, since prep isn't latency-sensitive: ~20–36 s, ~$0.04–0.09 per run.
  - **Potion fixture:** found a near-match for the real cure swap ("matched-pair potions; neither can be cured without the other"). The prompt hints at the general pattern (one PC's affliction may hold the key to another's), not the answer.
  - **Duradan:** strong hidden connections, e.g. Khayiulad's stolen Ka'Anshar book may be the Codex the Whisperer wants, and the Lodestone may anchor the party's madness at a risk. Collisions tend to stack 4–5 threads; 2–3 is probably tighter.
- [x] Step 7: Real-campaign test (Darkness in Duradan, sessions 1–5). **Verdict: pass, with speed as the weak criterion.** See [docs/spike-verdict.md](docs/spike-verdict.md) for the evidence and the fix list before showing other DMs.
- [x] Step 8: One-box local web page (24 Oct). `npm run dev`, then http://localhost:3000.
  - **Page** (`src/app/improv-box.tsx`): one box (Enter to ask), Quick (Haiku) / Best (Opus) toggle, campaign picker. Cards appear as each option is written, with thread chips, the "why" line, a ⟲ callback chip and a Copy button for pasting into Discord. Notes about records that disagree go below the cards. Light and dark, works at phone width. Campaign and model choice are remembered per browser.
  - **Streaming:** `callLlm` takes `onText` (the Anthropic stream's text snapshots). `improv` pulls each finished option object out of the JSON as it's written (`completedOptions`), checks it, and calls `onOption` straight away, up to 3. With safety lines set, options wait for the safety check. If the answer goes wrong partway, options that arrived whole still count.
  - **API:** `POST /api/improv` streams newline-delimited JSON (`option` … `done` or `error`); `GET /api/campaigns`. Migrations run once per server process (`src/server/db.ts`).
  - **Measured (Haiku):** about 0.5 s of setup, about 1.4 s to the model's first token, then about 1.3 s per option. **The first option shows at ~3 s**, down from 6–7 s for the full set.
  - **Who's in the scene (Jacob's testing, 24 Oct).** NPCs with unknown whereabouts counted as present, and so did anyone recorded at the party's place, which goes stale between sessions. Vex'ahlia (last recorded at the outpost) turned up in most scenes, and "Mysterious Skilled Guard" was a separate record for the same person.
    - **Presence** (`scene.ts`) is now `with-party` / `nearby` / `elsewhere` / `unknown`. With the party = recorded at the party's place *and* tied to a PC by ally, serves, family, romance, loves or trusts (Tomas). Nearby = recorded at the party's place without such a tie (Vex'ahlia).
    - **Only companions and NPCs the moment names act directly.** Everyone else has to arrive or act from afar, and the prompt says to bring one in only to pay off their thread, at most one per option.
    - **`entity merge "<duplicate>" "<real one>"`** (`mergeEntities` in `entities.ts`): moves threads, relationships, moments and rules to the real record, makes the duplicate's names aliases, then deletes it. It can't be undone; the DB was backed up first. Mysterious Skilled Guard is merged into Vex'ahlia.
    - **`--secret`** for when the players don't know they're the same person. Threads stay unlinked from the real record, since a prompt would otherwise show "Involves: Vex'ahlia" on the mystery. The identity goes into the real record's GM-only secrets. Aliases are never shown to the model; they're only used to work out who a name means. Duradan's guard merge was redone this way (Jacob: the players don't know). Live, 6 runs about the guard: no option named her as the guard. Options dropped breadcrumbs ("the sigil matches one seen near the ritual site"), and one offered a reveal as a choice ("the fighter was the one who ambushed Darius").
    - **Measured:** 8 new crafted checks (87/87 pass). Live, across 5 moments, Vex'ahlia appeared only in the one that names her, and no NPC was dropped into a scene.
    - **Possessive inside a tag:** the model sometimes writes `{Professor Aldric Vex|Vex's} apartment`. The checks only knew `{…}'s` as "belongs to", so this read as Vex acting, and the same form let body slips like "{Khayiulad|Khayiulad's} knees buckle" through. `tag()` now moves the possessive outside the tag. 90/90 crafted checks pass.
  - **On a phone (same Wi-Fi):** `npm run dev:lan`, then open http://<the Mac's LAN address>:3000 (currently 192.168.0.100; `ipconfig getifaddr en0` to check). `allowedDevOrigins` in `next.config.ts` allows 192.168.x.x, 10.x.x.x and .local names. There's no login, so anyone on the same network can use it (and the API key): home Wi-Fi only.
  - The desktop app's preview runner can't read the Desktop folder (macOS permission), so run the dev server from a terminal; `.claude/launch.json` attaches the preview to port 3000.

- [x] **Step 9: Between-sessions page** (`/prep`, 24 Oct). This is what lets other DMs bring their own campaign.
  - **Shared shell** (`src/app/shell.tsx`): an "At the table" / "Between sessions" switch, and a campaign picker with "+ New campaign" (remembered per browser).
  - **After the session:** paste notes (the session number is pre-filled) and Read notes (Opus, ~25–30 s, ~$0.08–0.09). The review is by tier:
    - **Needs your yes:** risky items one by one, with the reason, the quote and whether it's in the notes. Default No; a yes is saved as the DM's own entry.
    - **Confirm:** ordinary changes grouped by thread or character, all ticked, untick per item or per group.
    - **Added automatically:** folded away, still untickable.
    - Then Save N changes, a summary of what was saved (including values kept because the DM had set them), and Undo all of this.
  - **Prep ideas:** collisions, one idea per player (quiet ones badged), callbacks and quiet threads, as cards with thread chips (Opus, ~20 s, ~$0.045).
  - **Recent changes:** the last 12 batches with an Undo each; a blocked undo says which later change is in the way.
  - **API:** `POST /api/recap/propose` (stores the split proposal in `data/proposals/web-c<id>-s<n>.json`), `/api/recap/apply`, `/api/undo`, `/api/suggest`, `/api/prep`, and `POST /api/campaigns` to create one. `src/server/prep.ts` wraps the engine; `src/server/route.ts` validates input and turns failures into short messages.
  - **Tested on the fixture**, light and dark, desktop and phone width:
    - A session of 27 proposals: untick one, save 26, then one undo reversed all 47 writes exactly.
    - A risky session: "Tobin dead" with Yes was saved as ✎; "close the bridge thread" with No left it open.
    - Prep ideas found the cure swap again ("The Other Half of the Pair").
    - The fixture was reseeded afterwards.
  - **Gaps:** Duradan's recaps before session 6 predate the change log, so they aren't in Recent changes.
  - **Bug from Jacob's session 6 (24 Oct):** extraction proposed "Zara leads Iresia" (meaning she guided her to the palace). `leads` only points at factions, so `setRelation` threw. That stopped the save halfway, and the review stayed open, so each retry saved the threads again: 4 partial saves and every session 6 thread ×4. Fixed:
    - `applyEntityChanges` skips any update, relationship or party move that breaks a rule, with a warning, and carries on.
    - The extraction prompt lists what each constrained type can point at (generated from `RELATION_LAWS`) and says guiding someone is an event, not "leads".
    - A proposal can only be saved once: the file is marked `savedAs` before writing, and the review closes if a save fails.
    - The next session number skips a session whose saves were all undone.
    - Duradan was repaired: all 4 session 6 saves undone (DB backed up first). Session 6 needs reading again.
    - Tested on the fixture: a bad "leads" relationship is skipped with a warning while the valid one beside it saves; a second save of the same notes is refused.

- [x] **Step 10: Live sessions, Develop and the campaign page** (Jacob's feedback after one real session, 24 Oct; built together because they're tested together at the table).
  - **Three tiers:** Quick (Haiku) / Balanced (Sonnet) / Best (Opus). Jacob found Opus "pulls things that fit more often".
  - **Length follows input** (`lengthFor` in `improv.ts`): ≤10 words gets 1 beat under 20 words; ≤35 words gets 1–2 beats under 35; longer gets 2–3 beats up to 60 and may tie in more threads. Measured: 25–29 words vs 80–85 words.
  - **Tone slider** (Grounded · Restrained · Balanced · Dramatic · Theatrical, default Restrained, since Jacob found the default "a bit theatrical"). It changes only the wording instructions.
  - **Where the story is heading:** `campaigns.direction` (migration `0007`), written on the campaign page. Improv, Develop and prep ideas all steer by it.
  - **Live session log** (`src/core/live.ts`, table `live_entries`): every moment asked is logged.
    - **Use this** on a card, or **✎ None of these. Write what happened**, or **+ Note** (something that happened without asking) logs the choice and extracts it straight away in the background. It uses the recap extractor in `live` mode (Sonnet, ~10–15 s; Next's `after()`; one at a time per campaign).
    - Auto and confirm-tier changes are applied (batch `live s<n> HH:MM #e<id>`); must-tier changes wait as questions on the timeline. A yes is saved as the DM's own entry.
    - **Take back** undoes what a choice added. Changing your pick undoes the old one first.
    - The next suggestion gets THIS SESSION SO FAR: the last 8 choices.
    - **Timeline:** a strip of small icons above the box (✓ used, ✎ own, · asked, a pulse while extracting, a red dot for a question). Tapping one opens the moment, what was added, questions, Develop and Take back. "N to check" jumps to the questions.
    - **Wrap up →** goes to the Between sessions page, which shows what the table logged and asks only for what's missing. The extraction is told what's ALREADY RECORDED, so it isn't added twice. The stored notes are the log plus the additions. "Nothing to add: wrap up as it is" saves the log as the notes.
    - Live proposals use `kind: "live"`: quotes are checked against the moment itself, and a session created mid-play gets its notes only at wrap-up.
  - **Develop ↳** on any card or logged choice (`src/core/develop.ts`, Opus, ~15–25 s, ~$0.03–0.05): a read-aloud intro, 2–3 setups and 2–3 directions with their threads. A **reach slider** (Next few minutes · This scene · Next session · The arc) sets how far ahead it plans. It uses the session so far and the story direction; tested, it called back a vial detail logged earlier that session.
  - **Campaign page** (`/campaign`, `src/server/campaign.ts`): one search across everything; tabs with counts.
    - **Threads:** open / resolved, each with its history by session.
    - **Cast:** filter by type; details and relationships, GM-only items marked 🔒.
    - **Moments:** ☆ suggested with one-tap ★ / ×, plus starred ones.
    - **Sessions:** the stored notes, with search matches highlighted.
    - **Activity:** moments asked and used, saves and undos, cost by feature.
    - The direction box autosaves. LLM calls now record their campaign (`llm_calls.campaign_id`) for per-campaign cost.
  - **Real players stay out:** the fixture's "Played by Sam." reached the prompt and an option said "Ask Sam whether…". `PLAYED_BY` now strips "played/run by X" from cards, and any option naming a player handle or a played-by name is rejected. 3 new checks.
  - Also: an actor of "world" in a non-world beat rendered as "world A council runner…"; fixed. Nav labels shorten on phones.
  - **Tested on the fixture, then reseeded:**
    - Ask, use an option and watch it land; take back and re-pick; own choice; a question answered yes (saved as ✎); Develop at "Next session".
    - Campaign page: search, expand, direction autosave.
    - Wrap up as it is: the session's notes became the log and the next session started.
    - 94/94 crafted checks pass.
  - **Cost per live session** (estimate): ~$0.001 per Quick ask, plus ~$0.03–0.05 per extracted choice on Sonnet.

- [x] **Step 11: The loom you can walk, branching and a tighter table** (25 Oct, from Jacob's feedback; review in [docs/review-2026-10-25.md](docs/review-2026-10-25.md)). Backup first: git tag `backup-2026-10-25-before-review` and `data/backups/loom-2026-10-25-before-review.db`.
  - **Loom inspector** (`src/app/loom-ui.tsx`, `src/core/loom.ts`, `/api/loom` and `/api/loom/node`): every thread, character, place, item, faction, key moment and session is a node.
    - `RefLink`: hover (or focus) for a preview card, click to open.
    - `Linked`: auto-links every name and alias inside any text, using one pattern built per campaign.
    - The inspector is a side panel on desktop and a bottom sheet on a phone, with a breadcrumb trail, Back, Escape and Backspace.
    - **Node views:**
      - Entity: where it is (as a chain of places), ties as sentences, threads, holds/contains, details (🔒 GM-only), key moments, change history.
      - Thread: summary, stakes and deadline, who's involved, connected threads (two-way links merged), history linked to sessions, moments.
      - Moment and session views.
    - Long lists fold ("Show all N"). Used on the table, prep and campaign pages.
    - Tested: Khayiulad › Microfractures › Darius (health: critical).
  - **Campaign page overview:**
    - Party cards with health, conditions and condition threads; In play now; Gone quiet; Who matters; Recent sessions with "N moments to star".
    - Inline settings: tone, and auto-approve.
    - The index rows (threads, cast, moments) open the inspector; session notes fold out with names linked.
  - **Branching** (migration `0008`: `live_entries.parent_id`, `developments`; `campaigns.auto_approve`):
    - Every piece of a Develop result (the opening, each setup, each direction) has **Use this ↳**, which logs it as a child entry (`logBranch`, `choiceKind: "branch"`) and extracts it. **Develop ↳** develops from that piece (nested up to 5 levels).
    - Developing an option you haven't used uses it first, so the tree has a root.
    - Develop results are saved on the entry, so they survive a reload.
    - On the timeline, children follow their parent with a connector. The entry view shows "Continued with". The wrap-up draft indents branches ("- Then: …").
    - Tested two levels deep. The second level already cited threads the first branch had added.
  - **Questions tray:** pending questions are pinned above the box (which sticks to the top), one at a time ("1 of N"), with the reason and the quote. They stay until answered. **Auto-approve** (tray checkbox or campaign setting) applies risky changes as the DM's own entries, marked "(auto-approved)" and undoable with Take back.
  - **The box stays in reach:** sticky, grows as you type, "/" focuses it from anywhere, and after you use something it says "What happened next?".
  - Also: two-way thread links merged in the inspector, no nested list items in Develop, quick notes draft as one line (`NOTED`).
  - 94/94 crafted checks pass; the fixture was reseeded after testing.

- [x] **Step 12: Wrap-up questions first, quiet controls, UX review** (25 Oct). Review and roadmap: [docs/ux-review-2026-10-25.md](docs/ux-review-2026-10-25.md).
  - **Wrap-up:** unanswered table questions appear first on Between sessions ("Before you wrap up · N to answer", Yes / No / No to all). Read-and-wrap and "wrap up as it is" stay disabled until they're answered, and the server refuses too.
  - **Controls** (`src/app/controls.tsx`): `Steps` (dots on a thread), `Choice` (text tabs), `Switch`, `Tune` (a quiet trigger with a small panel), `Field`. Native range sliders and checkboxes are gone.
    - On the table page, model, tone and "ask before recording risky changes" live behind one line under the box ("Quick · Restrained"); the shortcut hint moved into that panel.
    - Develop's reach, the tray's auto-approve and the campaign settings use the same controls.
  - **Story typeface:** Newsreader (`.story`, `--font-newsreader`) for options, developments, ideas, descriptions and notes; Geist for the interface.
  - Quiet campaign picker (`select.quiet`) and session number field; change batches read as "Session 3 notes · 24 Oct, 12:51" (`batchLabel` in `shell.tsx`).

- [x] **Step 13: Polish sprint** (25 Oct; P1 items 1–5 and ⌘K from the UX review).
  - **Visual vocabulary:** one icon set (`src/app/icons.tsx`) replaces every unicode glyph. Three button styles (`btn-primary`, `btn-secondary`, `btn-tertiary` in `globals.css`). One focus ring.
  - **First run:**
    - An empty campaign shows a welcome with three ways in: add notes; start at the table; open the sample.
    - The sample is `POST /api/campaigns/sample`, which opens the potion fixture and never resets it.
    - The sample shows three example moments to tap. The campaign page has its own empty state.
  - **Compact flow:** once an option (or your own) is used, the others fold into "N other options", and the chosen card stays in view. Nested Develop draws as an indented thread, not boxes in boxes.
  - **Notices:** when a choice lands in the loom, a quiet notice says what was added (tap it to open that moment) and the timeline dot glows. Each notice lasts about 6 s.
  - **Mobile:** the box shrinks to one line while you scroll and it's empty. The inspector sheet has a handle and swipes down to close.
  - **Jump anywhere:** ⌘K / Ctrl+K, or the search button in the header, searches the loom index (cast, places, threads, moments, sessions), grouped by kind with arrow keys and Enter. Results open in the inspector.
  - **Header:** short page names (Table, Prep, Campaign) with full names as tooltips, so the header fits on one line everywhere.
  - 94/94 checks pass. The fixture was reseeded after testing, and a temporary "Welcome Test" campaign was deleted. A test "vex" typed into Duradan's box by mistake was removed from its log (it was only asked, nothing was used or extracted).

- [x] **Step 14: Game tools for newer DMs** (25 Oct; plan in [docs/plan-2026-10-25-game-tools.md](docs/plan-2026-10-25-game-tools.md); migration `0009`).
  - **Relationship history:** opposite ties replace each other (`OPPOSITE_TIES` in `rules.ts`: ally/enemy, loves/hates, trusts/distrusts…). The old tie is logged as removed, and extraction proposes rather than removing a DM-entered tie. The inspector shows each tie's story ("ally · was enemy until 3 sessions ago", or "since session 4") and any former ties. Tested: enmity, then reconciliation, left only "ally", and the grudge thread's closing came up as a question.
  - **Results that follow through:**
    - A used choice that sets up a fight or a roll waits for its result (`needsResult` in `live.ts`; fight wording beats a roll hand-off; `awaiting`/`resultState` on `live_entries`).
    - The tray shows "How did it go?" with quick outcomes (Won / Fled / Lost / Talked it out, or Succeeded / Failed / Partly) and a detail line. It folds to one line while the fight is still running. "skip" is a small text link.
    - A result is a child entry (`choiceKind: "result"`), extracted like any choice. Tested: it moved the thread, added Captain Mora and made Bram bloodied.
    - Wrap-up asks for pending results like questions, and notes how many were skipped.
  - **Fights** (`encounter.ts`, `encounter-math.ts`, `src/app/fight.tsx`; Sonnet):
    - Enemies come from who's in play, with compact stats and a trick, marked SRD when stock. There's a terrain line and a twist tied to a thread.
    - The difficulty dial (2014 Easy → Deadly, 2024 Low → High from the edition toggle) rings Loom's suggestion with a reason. Moving it rescales counts in code, and the −/+ counts recompute live.
    - XP is exact: DMG thresholds per level, CR → XP, and the 2014 group multiplier with party-size shift, checked against the DMG examples. The model is given the party's XP budget, so its picks land in the suggested step.
    - PC levels are asked once, inline. "Set up a fight" is a quiet link on any used choice that wasn't detected as one.
  - **Rules panel** (`rules-qa.ts`, Sonnet, ~5 s, ~$0.008): "Rules" in the header, `?`, or the "Ask as a rules question" chip when table text reads like one (it never reroutes). Answers come with the rule named, "at your table" (using the scene, conditions, toggles, house rules and recent moments), an SRD flag, and "worth checking".
    - Haiku got class spell lists wrong in testing (Revivify), so this stays on Sonnet.
    - **After editing `FEATURE_MODELS`, restart the dev server:** hot reload kept the old map.
  - **Fresh ideas** (`fresh.ts`, Opus, ~17 s, ~$0.03): on Prep, five ideas (theme / thread / character / connection), each tied to existing threads and one tap from the loom (`addThread`, logged and undoable). Develop at "The arc" may propose one new thread, marked as new.
  - 94/94 crafted checks pass; the fixture was reseeded after testing.
- **Agency in plans** (25 Oct, caught by Jacob on his phone): Develop wrote "The party drags Darius into Tomas's smuggling cellar". Prose results (Develop, fight terrain and twists, fresh ideas) never went through the scaffold.
  - `planSlips` (`src/core/plan-agency.ts`) flags a sentence where the party or a PC (by name, first name or alias) is the subject of an action, at the start of a sentence or a clause. It allows conditions ("If the party…", "When Dahlia…"), modals ("they can…"), perception and discovery ("learns", "finds"), and possessives.
  - Develop retries once with the offending lines and an instruction to rewrite them as conditions, then drops any sentences still slipping. Fights and fresh ideas drop them directly. The Develop prompt now gives the right form ("If the party hides in Tomas's cellar…").
  - 12 crafted cases (106/106 checks pass). A live rerun of the same kind of scene came back all conditional.
  - **Phone access:** `npm run dev:lan`, then http://<the Mac's LAN address>:3000.
- **Record notes you can act on** (25 Oct, Jacob on his phone): "This moment has Darius restrained; your records don't." was a dead end, because the CLI's update command had been stripped for the page.
  - `buildLists` now also returns `fixes` (`RecordFix`: what Loom did, a button label, and a structured fix for a moment-stated condition or an item that changed hands). The CLI still prints its text notes.
  - The page shows "Loom treated Darius as restrained for these options, because the moment says so…" with **Record Darius as restrained** (`POST /api/records`, saved as the DM's own entry) or **Just this moment**.
  - Results no longer repeat their outcome ("Partly. Partly.").
  - A roll instruction that colours the PC's effort ("Bram makes a death save as he tries to rise", in the sample campaign) is fine by Jacob; not a slip to fix.

- [x] **Step 15: Less to read at the table, more to steer** (25 Oct; from a friend's test: "a little much reading all the scenarios").
  - **Headlines first:** each option comes with a `headline` (under 12 words) and a `flavour` (payoff / twist / callback / character / tense / funny / mystery / fight). The table shows headline rows; tap one to read it in full. Swipe sideways, or use ‹ n/3 ›, to move between options; × goes back to the headlines. A headline that decides for the players falls back to the label.
  - **The mix** (`MIXES` in `improv.ts`, "Kinds of option" in the tune panel): the default asks for one payoff, one twist, and one callback or character beat. Action / Mystery / Light / Character lean it.
  - **Steering chips:** "Not quite?" darker · funnier · smaller stakes · bring in <someone from the threads in play>. One tap re-weaves the same moment (`steer`).
  - **Develop in two steps** (Jacob's design: three sections, mix and match):
    - `developIdeas` (Sonnet) gives three headlines each for Open, Set up and Lead to. The GM picks one per section (or skips a section).
    - `develop` with `picks` writes only those out, in a readable layout: the opening as a large read-aloud quote, then Set up and Lead to.
    - Each piece has **Rework** (More grounded / More dramatic / Darker / Funnier / Shorter, or "say how"; `reworkPiece`, Sonnet). A rework replaces that piece in the saved entry (`replaceLatestDevelopment`).
  - **Start from a random hook** (`hook.ts`, Opus writes it, Sonnet reads it in): on an empty campaign's welcome, with optional fields for who's playing and any flavour (the button then reads "Invent the hook"). It writes a small premise as session 0 notes, reads it into the loom with everything applied, and shows the opening to read aloud, then Begin. After Begin the opening stays in view, quieter, until the first moment. Meant for non-DM testers standing in for brand-new DMs.
  - **Out of credit:** a plain "Loom's AI credit has run out. Top up at console.anthropic.com…" everywhere, instead of "no options got past the checks". Improv stops retrying when this happens.
  - **Live fixes:**
    - Headlines sometimes narrated PCs ("Bram sings himself into danger", sample campaign). Prompt rule: a headline's subject is the world or an NPC. The fallback is now the first scaffold beat.
    - `planSlips` catches pronoun clauses whose nearest named character is a PC ("…, and he tries to climb the toll gate").
    - "Bring in <NPC>" was ignored, so the steer is now binding (every option brings them in, by arrival or from afar).
    - Leaned mixes ask for three of four options in that flavour; streaming and ranking prefer options that fit. Still partly scene-dependent.
    - The hook took 53 s and $0.15. With Sonnet reading it in, it takes ~28 s and ~$0.06.
    - Duradan names ("Iresia…") were in the UI hint text for every campaign; replaced with generic wording.
  - **Verified live** (throwaway campaigns, since deleted; desktop and phone width):
    - The first headline arrives in ~3 s, all three by ~6–7 s. The default mix gave payoff, twist and character.
    - Tap to open; ‹ n/3 › and swipe move between options. Darker and bring-in steers work.
    - Develop ideas take ~5 s; writing out the picks ~7 s (~$0.017); a rework ~4 s, saved back.
    - Hook start from the welcome: "The Lantern Fair Debt" (random) and "The Camel Who Knew Too Much" (desert caravan flavour).
  - **Seen, not fixed:**
    - One phone improv call took 13 s (retries).
    - On a phone, a long headline title wraps to three lines beside the ‹ › controls.
    - Entity names starting "The" keep the capital mid-sentence ("of The Ledger").
  - **Review on the sample campaign (8 moments, before → after):**
    - Headlines drifted from their option in ~6 of 22 (a "street mime" headline over a scribe offering a pen; "a stall-keeper" over a fishmonger). The cause: the headline was written before the option. It's now written after the hand-off, as a summary using the option's own characters and objects. After: 0 of 24 drifted, and every moment had 3 options (2 had only 2 before).
    - `planSlips` catches contractions with an -ing word ("…, and he's already moving"); headlines can't say "walk-on".
    - The fallback headline is never cut off with "…": it's the first beat, its first clause or the label, whichever fits in 13 words.
    - Speed and cost unchanged: first option 2.3–5.1 s, all ~5–7 s, ~$0.0009 per call.
    - **Hand-offs leave the choice to the player** (`checkHandOff` in `improv.ts`, plus a prompt line). Rejected: a roll that says what the PC does for it ("makes a reckless grab for the merchant's arm"); a roll or question that narrates the reaction ("; he feels no pain and keeps pushing", "…as he surfaces, grinning"); a question asking the players what an NPC does ("whether the guard asks…"). 13 crafted cases. Live rerun: none of these appeared, and the check dropped one option.
    - **Extras render properly:** a beat whose actor is "world" or "walk-on" is treated as the world or an extra, whatever kind it says. Before, it rendered with no subject ("Ambles along the bank…") or was dropped as "a player character (world)". "A walk-on merchant" reads "A merchant".
    - **Still open:**
      - A roll's purpose can still decide for a PC the moment isn't about ("Bram makes a Strength contest against Ysolde to block her grab", in Kira's theft).
      - One garbled hand-off ("Ask Bram whether he surfaces, but nobody has to decide yet").
      - Rolls asked for NPCs' perception ("Roll a dice to see if the bandits notice").
      - 2 of 8 moments still came back with 2 options, mostly from the older checks: an absent Ysolde acting, or a PC used as an NPC.
    - The nearest-name pronoun rule misreads "she" after a male PC's name and "he" meaning an unnamed extra; the cost is a stand-in headline or a dropped plan sentence.
  - 119/119 crafted checks and 25/25 adversarial cases pass; lint and types are clean. The checks reseed the sample campaign.

- [ ] **Step 16: Scaffold v2** (25 Oct; Jacob: "look deeper at our controls system and scaffolding"). Make the wrong option impossible to write instead of catching it afterwards. Awaiting Jacob's blind ticks.
  - **Root cause found:** the Anthropic SDK helper we used (`betaZodOutputFormat`, SDK 1.1) turns every `enum` and `const` into a hint in the description. So none of the per-request lists (who may act, which threads, hand-off targets, relationship types in recaps…) were ever enforced while the model wrote. They were only checked afterwards, and a value outside a list made the whole answer unparseable. `outputFormat` in `src/core/llm/anthropic.ts` now sends them as real constraints, for every feature. All feature formats compile; fights weren't reachable in the smoke test. On its own this cut rejections from ~1.0 to 0.63 per call.
  - **Rejection log** (`option_rejections`, migration `0010`): every option the checks drop, with its reason, model, moment and how many options the call kept. Never blocks the call.
  - **A separate list per beat kind:** each kind of beat is its own shape with only its own actors. `npc`: NPCs here; `arrival`/`remote`: absent, living NPCs (or a walk-on); `outcome`: the PCs whose action the moment is; `world`/`walk_on`: no named actor. An absent NPC acting here, or a PC as an NPC, can no longer be chosen. A beat whose actor is "world" or "walk-on" is treated as the world or an extra, whatever kind it says.
  - **Structured hand-offs** (`Hand`, `handText` in `improv.ts`): the model picks a kind and fills a few fields; code writes the sentence.
    - Kinds: `question` ("Ask Kira's player: what do you do about the heckling patron?"), `choice` ("…: do you write a note, or wave him off?"), `check`/`contest`/`attack` (only for the PC whose declared action it is, or the table when the moment is the whole party), `notice` (perception or knowledge, for anyone; "to notice / to read / to work out / to recall what they know about…"), `save` (anyone facing a danger), `rule` (a house rule's roll), `death_save` (only someone dying).
    - Rolls are for PCs only. The skill sets the ability (Athletics → Strength).
    - The few words the model writes (what they face, the two choices, the target) are checked for a PC acting. The flavour pass keeps Loom's hand-off sentence.
    - One flat shape, with code checking who each kind may go to: a union per kind made the format too big for the API to compile ("compiled grammar is too large").
  - **Other fixes:**
    - Past-tense verbs after a name are back-references, not acting ("the potion {Mother Ysolde} sold him").
    - More PC-body slips are caught ("Kira's hand shoots out", "…is already on the railing", "eyes go wide").
    - Empty beats are rejected ("The Red Hand nothing.").
    - Headlines that open with a PC fall back.
    - The prompt says who checks may go to.
  - **Measured, sample campaign (16 calls each):**

    | | Rejected per call | Options shown | Calls under 3 | First / all |
    |---|---|---|---|---|
    | Before (4 earlier runs, hand-counted) | ~1.0 | 2.75 | 2 of 8 | 2.4 / 5.6 s |
    | Enforced lists | 0.63 | 3.00 | 0 | 2.4 / 5.6 s |
    | + per-kind actors | 0.44 | 2.88 | 2 | 3.1 / 6.3 s |
    | + structured hand-offs | 0.50 | 2.94 | 1 | 3.1 / 6.3 s |

    No live hand-off decided for a PC, narrated a reaction, or asked for an NPC's roll. Most remaining rejections are a check asked of a PC who didn't declare it, which the code now catches.
  - **Duradan blind run 4** (`data/runs/2026-10-25-04-00-duradan-blind.md`, waiting for Jacob's ticks): expected threads 10/10 for all three models. Haiku 8.2 s avg (6.6 s in a Haiku-only rerun), $0.019; Sonnet 10.9 s, $0.37; Opus 13.2 s, $0.75. Dropped: 11 / 7 / 4.
  - **Speed:** enforcing the lists isn't slower (A/B on Duradan Haiku: 6.6 s enforced, 7.2 s loose, and the loose run lost 3 moments to unusable answers). The full answer is ~1.3 s slower than run 3 because of the extra fields (titles, kinds, the hand-off parts). The first option still shows in ~3 s on the page.
  - **Still open:**
    - `on_fail` may still move a PC for a failed social roll ("his fingers close around the figurine and he pockets it").
    - Investigation is the go-to notice skill.
    - PCs acting inside the model's own sentences still rely on the text checks.
  - 132/132 crafted checks and 25/25 adversarial cases pass; lint and types are clean.

- [ ] **Engine build** (planned 25 Oct; plan in [docs/plan-2026-10-25-engine.md](docs/plan-2026-10-25-engine.md)). Jacob: code has the first say on what's true and what can happen; the model's pass is second (phrasing, flavour, context). No more fixing slips one at a time.
  - **Decisions (Jacob):** chips shown as chips, icons or hidden (Settings page); the engine's reason for a move is shown, reworded by the model; a wildcard move is always offered.
  - [x] **Phase A: one scene model** (25 Oct).
    - **Moment reading** (`src/core/moment-reading.ts`): reads the moment once, in code. It works out who the moment brings in, who it only refers to ("Bhen's mother", "looks for Bhen", "asks about Professor Vex"), who it contacts from afar, which PCs act, what's in whose hand, what's used, conditions, and where the party goes. The rules are a table (`READING_RULES`), each with its own example moments, run by `npm run test:engine` (18/18).
    - **The scene model** (`src/core/situation.ts`): `loadWorld` + `buildSituation(world, moment, overrides)`. It holds presence with a reason (here / with the party / nearby / elsewhere / unknown), who may act, who was contacted, the acting PCs, holders (a lost item has no holder; the moment or the GM can put one in a hand), live house rules ("on use" rules only when the moment uses their source), conditions the moment states, and record fixes.
    - `buildScene` reads the Situation instead of the database, and so do improv, the flavour pass, Develop, fights and rules questions (each passes its own text as the moment). `buildLists` is a thin adapter, and throws if it's given a different moment from the scene's.
    - **Laws enforced:** lost items have no holder, and nobody can use them; holding one clears "lost" (write laws in `entities.ts`). A rule's roll is rejected if its trigger hasn't happened.
    - **Chips** (`src/app/scene-chips.tsx`, `POST /api/situation`, no model call): under the box as you type, e.g. "Tomas here · Bhen not here · Khayiulad: Knight figurine · Figurine madness". Tapping one corrects it (an override sent with the ask; steering reuses it).
    - **Settings page** (`/settings`, `src/app/prefs.ts`, per browser): chips / icons / hidden, model, kinds of option, tone, show why, Develop's starting reach. Linked from the header and the tune panel.
    - **Measured:** set-up before the model call is 25–40 ms warm, so the in-memory index was deferred (not needed for speed). Sample campaign, 16 calls: 0.38 rejected per call (was 0.50), 3.00 options per call, first 3.4 s, all 6.6 s. Duradan rerun of blind run 4's faults (Haiku): Bhen no longer appears when only mentioned; madness is rolled only when a figurine is used; the lost Knight figurine isn't put in anyone's hand.
    - **Left for Phase B:** names in free text (a headline still named the lost Knight figurine "warming in someone's pocket"); PC body reactions ("Khayiulad's eyes roll back"); selling a figurine doesn't count as "use" (tap the rule chip if you'd call it).
    - 133/133 crafted checks and 25/25 adversarial cases pass; lint and types are clean.
  - [x] **Phase B (bridge, committed as a checkpoint):** entity profiles (`profiles.ts`), the role law, and the PC-body allowlist. Superseded by the world model below.
  - **Phases B and C are replaced by the world model** (Jacob, 25 Oct). Design: [docs/design-2026-10-25-world-model.md](docs/design-2026-10-25-world-model.md). Typed node objects with nested properties, one link per connection (with a role for threads), tags the engine calculates from, and suggestions built from engine plans with slots.
    - [x] **Stage 1:** types and the graph, read from today's tables.
      - `src/core/world/` holds `nodes.ts`, `links.ts` (link laws and 27 thread roles, open-ended) and `load.ts` (`loadGraph`).
      - `npm run test:world -- 3 --report` passes on the sample campaign and Duradan.
      - **Finding:** the data is thin. Duradan has 0 of 18 characters with mood or goals, 0 of 32 threads with stakes, and every thread link is "involved". An enrichment pass should fill these before Stage 3.
    - **Enriched test copy** (25 Oct, Jacob's request). `scripts/copy-campaign.ts` copies a campaign's world. "Duradan (enriched test copy)" (campaign 12) was filled by `scenarios/private/duradan-enrichment.ts`: moods, health, ranked goals, beliefs, item holders, places, stakes levels on all 32 threads, and 93 thread roles. The real Duradan is untouched. Migration `0011` added `thread_entities.role` and `secret`, `threads.stakes_level`, and the traits `mood`, `goals` and `beliefs`. Scenario file: `scenarios/private/duradan-copy.json`.
    - [x] **Stage 2: the engine's questions on the graph** (`src/core/world/engine.ts`).
      - A `View` is the graph for one moment, with what the moment changes (conditions, items in hand, a place it moves to) and the GM's corrections.
      - Questions: `presenceOf` (here / reachable / remembered / player, with where and why), `holdersOf` (direct, through a set, or through a piece), `capabilities`, `liveRules`, `threadsOf` (a node's roles in threads), `heat` (stakes, recency, progress, deadline; flags ripe threads), and `profileOf`/`profileLine`.
      - `situation.ts` is now the engine's answers in the shapes the rest of Loom reads (`loadWorld` also loads the graph), and `profiles.ts` is gone.
      - The scene prompt lists each entity with its standing, mood, goals, beliefs, holdings and its roles in threads (e.g. `key in "Khayiulad's soul trapped in the reality crack" (ripe)`).
      - A captured or missing PC is still the players' but not with the party, so what they hold isn't here.
      - **Measured (Haiku, the 10 Duradan scenario moments):**

        | | Dropped | Avg latency | Cost |
        |---|---|---|---|
        | Real Duradan | 6 | 8.3 s | $0.020 |
        | Enriched copy | 3 | 8.4 s | $0.022 |

        The enriched options use the data: the Wand at Khayiulad's belt, the Shard in Iresia's hands, the Monk figurine sensing a soul (its "key" role), Darius's unidentified potions. Sample campaign, 16 calls: 0.38 rejected per call, 2.94 options per call.
      - **Left for Stage 3:** Tomas is in almost every option (the only NPC with the party, so the model's default); missing articles ("Monk figurine hums"); a check where a save fits ("a Wisdom check against the figurine's pull").
      - 149/149 crafted, 25/25 adversarial, 18/18 reading rules, and the world tests on Duradan and the copy all pass.
    - [ ] Stage 3: plans and slots for improv.
    - [ ] Stage 4: storage, extraction and typed editing.
    - [ ] Stage 5: plans for Develop, fights and prep ideas.

## Entity model build (docs/entity-model.md)

- [x] Step 1: Schema with provenance (migration `drizzle/0001`):
  - **Entities:** tier-1 columns (status, attitude, importance, last-known / actual / parent location) plus a `traits` JSON validated by `TraitsSchema` in `src/core/entity-fields.ts`.
  - **Relationships:** `entity_relations` with a fixed type list, note, strength (-3…+3), secret flag and source.
  - **Threads:** deadline, stakes and a secret flag.
  - **Campaign:** party location, in-game date, tone, mechanics and safety lines.
  - **Provenance:** every value records its source in `field_meta`. All writes go through `src/core/entities.ts` (`updateEntity`, `setRelation`, `updateCampaign`), which applies the rule: DM always writes; extraction fills blanks, proposes over DM values, and never erases.
  - `isWithin` walks the location hierarchy.
  - `seed` now keeps the fixture's campaign id, so reseeding doesn't change which campaign is the default.
- [x] Step 2: Manual entry commands (`scripts/entity-cli.ts`). Everything entered here is recorded as the DM's.
  - `entity list | show | new | set` (location fields take names; list fields take `,` or `;`; `--secret field`; an empty value clears)
  - `relate` / `unrelate`
  - `campaign show | set | mechanic add/remove`
  - `thread set <id> deadline= stakes= secret=`
  - `entity show` marks every value ✎ (entered by you), ⚙ (extracted, with session) or 🔒 (GM-only).
  - Shared loader in `src/core/entity-card.ts` (`findEntity`, `loadEntityCard`), to be reused for prompt cards in step 4.
- [x] Step 3: Extraction proposes entity details, relationships and the party's location (`src/core/entity-extraction.ts`).
  - `recap` now proposes these alongside thread changes, in the same numbered approve flow.
  - `enrich` re-reads every stored recap to backfill a campaign (Opus, ~$0.10 for Duradan).
  - Changes apply as source "extracted": where the notes disagree with a DM entry, the DM's value is kept and the difference is reported (tested: Ysolde hand-set "hostile", notes said "friendly").
  - Requests over 16k output tokens now stream automatically (SDK requirement).
  - **Duradan backfilled:** 23 entities with details, 15 relationships, 2 new places, location hierarchy (Ritual Site › Time Pocket › Hidden Cave › Whispering Woods), Gary dead, party at the Northern Gate Outpost. Skipped one item that put Dahlia's abilities in an item-only field.
  - **To check:** Professor Vex marked "captured", which the notes only imply.
  - **Abilities field added**, after the backfill put Dahlia's wildshape in an item-only field. Dahlia's and Darius's abilities are fixed in Duradan.
  - **5e story fields added** to traits: background, personality traits, languages, health band, conditions, notable gear, wealth, passive Perception/Insight. Character-sheet numbers (scores, AC, HP, slots) are deliberately not stored; importing from D&D Beyond or Foundry is the Phase 2 path for those.
- [x] Step 4: Scene and slip checks.
  - **The scene** (`src/core/scene.ts`, `buildScene`) is the opening block of both the improv and suggest prompts: where the party is (with the location chain), NPCs known to be here, the dead, tone, safety lines, the GM's mechanics, a party roster (health, abilities, story conditions), and up to 10 compact cards for entities in play. Secret fields are tagged `[GM secret]`.
  - **Slip checks** in `improv.ts` `validate`, on top of the agency checks: a dead NPC acting; an absent, captured or missing NPC acting without arriving or acting from afar (`ARRIVAL`, checked in npc beats and in world beats that open with an NPC); a PC's body forced before any roll ("Khayiulad's fingers tighten…"); asking an unconscious PC what they do. When the moment itself sets up remote contact with a named NPC (sending, scrying, a message…), that NPC may act from afar (`REMOTE_CONTACT`).
  - 13 crafted cases pass. Live: Gary never acted, Zara stayed away, a captured Vex was stopped from commenting freely, and Sending to Zara works.
  - Jacob's two hidden mechanics are recorded on Duradan as campaign mechanics.
  - **Stress test (23 Oct): the rule-based checks are too brittle.**
    - 16 adversarial crafted options: only 4 handled correctly, and all 12 misses let a slip through. Misses: pronouns ("She lunges…"), PCs after an opener or in a later clause ("Without hesitation, Salaena…", "…and Salaena shouts"), class titles ("The cleric…"), epithets ("The thief Gary…"), innocent arrival words ("Zara sends Tomas a look", "appears calm"), anything in `on_fail` (a dead NPC stabbing someone), unlisted verbs, and rolls asked of an unconscious PC.
    - Live: (1) **stale scene**. "The party heads back to the Resistance HQ to confront Zara" had all 4 Zara options falsely rejected, because the stored party location hadn't moved; the moment itself changes the scene. (2) **Safety lines aren't enforced in code**: with "harm to children" set, an option had a guard drawing a blade on the boy. (3) Mechanics were stretched ("speaking to a spirit is a figurine-style strain").
    - Proposed fix was an LLM judge; Jacob's scaffold-and-tags design replaced it (below).
- [x] Step 4b: **Scaffold, tags and flavour pass (Jacob's design).** Make the wrong sentence impossible to write, instead of catching it afterwards.
  - **Scaffold** (`src/core/improv.ts`): the answer format is built per request.
    - Only allowed values can be chosen: the beat's actor (world / walk-on / NPCs here / absent NPCs / PCs), the thread, the hand-off target (conscious PCs only) and the mechanic.
    - Beat kinds are `world`, `npc`, `walk_on`, `arrival`, `remote` and `outcome`. Code checks the combinations: PCs only in `outcome` for their own declared action; absent NPCs only arrive or act remotely; the dead never act.
    - NPCs named in the moment count as present (fixes "go to HQ and confront Zara").
    - Code puts each beat's actor in front of its sentence when rendering.
  - **Tags** (`src/core/scaffold.ts`): every name is written `{Name}` or `{Name|how it reads}`. Untagged capitalised names are tagged automatically, and so are PC titles like "the cleric". The checks then look for any tagged character followed by an action word (`PASSIVE_NEXT` lists the allowed non-actions, including involuntary ones like "shimmers"), a PC's limbs making deliberate motions (`FORCED_BODY`), pronoun-led world beats, and `on_fail` effects where anyone but the roller acts.
  - **Safety lines:** a fast Haiku check runs only when the GM has set lines. If it blocks options, Loom regenerates once with an instruction to steer away, and says so.
  - **Flavour pass** (`src/core/flavour.ts`, `flavor <n>`, Opus by default, ~5 s, ~$0.015): rewrites the chosen option as read-aloud prose from the tagged entities' cards (voice, appearance, mechanic text). Each beat is re-checked with its original actor and falls back to the plain line if it adds a character or breaks a rule.
  - **Stress results:** crafted adversarial cases went from 4/16 to 25/25. Live: the HQ/Zara confrontation, charm-spell effects, Gary's wake and the figurine sale all came out clean.
  - **Remaining issues:** mechanics still get misapplied ("Figurine madness" roll for a crowd's hum, for Iresia); Sonnet scaffolds can take ~10 s (Haiku ~5 s); capitalised "Resistance" resolves to Resistance Headquarters rather than the faction.
- Steps 5–6 (embeddings, final tests) are folded into the layered model build below.

## Layered model build (docs/loom-model.md)

Jacob approved the model on 24 Oct 2026: layers L0 Rules › L1 Identity › L2 State › L3 Relationships and laws › L4 Narrative › L5 Moment, plus P Players; hierarchy with inheritance; detail by graph distance.
- Rules: 5e first, then DM toggles, then structured house rules (free text doesn't work).
- History: an automatic change log, plus key moments the DM flags (a star in the UI) as the source for callbacks.
- The player layer is in scope.

- [x] **Step 1: L0 rules core and the figurine split** (migration `drizzle/0002`).
  - `src/core/rules.ts`: the 15 SRD conditions as capabilities (act / move / speak / aware / sees / hears, plus narrative laws); `capabilitiesOf` combines status, health band and conditions. 11 story-relevant toggles (`campaign toggle`), stored in `campaigns.rule_toggles`.
  - **Effects table** (structured house rules): source (entity or thread), trigger, applies-to (holder / user / everyone-except-holder / everyone-present / party / listed / source-target), check, on fail/success, escalation, duration, plain-words rule, secret. `src/core/effects.ts` works out who each effect reaches *right now*, from `holds` relationships inherited down the hierarchy, and only while the party is at a place-bound source.
  - `rule list | add | remove | draft`. `draft` turns plain words into the structure (Sonnet), asks a clarifying question if needed, and saves on the DM's confirmation. The old `campaign mechanic` commands now point to it.
  - **Generic hierarchy:** `entities.parent_id` for every type (the place hierarchy was copied over; `parent_location_id` is kept unused for now). A parent must be the same type; loops are rejected.
  - **Scene:** a "RULES IN PLAY" section lists the toggles that differ from 5e and each effect with who it reaches now. Cards spell out what a condition means right now.
  - **Scaffold checks:** an effect's roll only goes to someone it reaches now (or "table" if it's table-wide); the failure lands on whoever rolled; characters who can't act or speak don't; questions need a PC who can act; rolls need awareness (except death saves). Only effects that reach someone can be chosen.
  - **Tagging fixes:** first-name shortcuts only for characters (no more "Resistance roll" → Resistance Headquarters); no possessive first words; auto-tags keep the original wording (`{Zara the Unbound|Zara}`); doubled articles collapse.
  - **Duradan data:** the figurines are split into Knight (Khayiulad) and Monk (Salaena) under the set; both are linked to the figurine threads. Rules: *Figurine madness* (set, on use, user) and *Reality Microfractures* (thread #23, on exposure, everyone present, GM-only; drafted from Jacob's words). The old free-text mechanics are cleared.
  - **Tests:** 16/16 new rule and capability cases (Iresia's figurine roll rejected; Salaena's and Khayiulad's accepted; everyone-except-holder reaches all but the holder) and 25/25 earlier cases. Live: the Bhen moment no longer misapplies Figurine madness; Salaena using the Monk figurine gets her own madness roll.
- [x] **Step 2: L3 relationship laws**
  - `RELATION_LAWS` in `src/core/rules.ts` says, per type, what it can connect, its cardinality and whether it's two-way:
    - `holds`: one holder per item, unless the item has `possession=shared`.
    - `lives_at` / `located_at`: one place.
    - `leads`: one leader.
    - `family`, `romance`, `ally`, `enemy`, `rivals`: two-way.
  - **On write** (`setRelation`): wrong types are rejected; a new holder, home or leader replaces the old one (reported as "replaces: …"); two-way links are recorded and removed both ways; you can't hold a set while someone holds a piece of it, or the reverse. Extraction never overrides the DM's holder; it proposes instead.
  - **At generation** (`checkPossession` in `scaffold.ts`): an item can only be used, carried "in someone's hand/pack", or called "X's item" by whoever holds it (holding a piece counts for its set, and the set for its pieces). Hand-overs in a beat ("snatches", "tosses … to") count from then on, including for item rules: a hand-over to Iresia makes her Figurine madness roll valid.
  - **Moment overrides:** if the moment puts an item with a PC, the moment wins for that call, and the GM gets a note with the command to update the records. The prompt lists who holds what.
  - **Tests:** 7/7 write-law cases on the fixture; 13/13 crafted possession cases; the earlier 25/25 still pass. Live: "Iresia grabs the monk figurine" gives a records note and a valid madness roll for Iresia; "Khayiulad sells the monk figurine" does the same for Khayiulad.
- [x] **Step 3: L4 history, key moments and callbacks** (migration `drizzle/0003`).
  - **Change log** (`state_changes`, `src/core/history.ts`): every write through `entities.ts` is recorded automatically, with before/after, source and session. That covers entity fields, relationships added/removed/changed (including replaced holders), campaign settings, thread fields, and entities created by hand or by recaps. `entity history "<name>"` shows the timeline.
  - **Key moments** (`key_moments`, `src/core/moments.ts`): title, description, tone, callback idea, entities, threads, session; status key ★ / suggested ☆ / dismissed.
    - `moment list | add | from-improv <n> | star | dismiss`. `from-improv` flags an option you used: the CLI's star button.
    - Recaps and `enrich` suggest 0–3 moments per session, as ☆ items in the approve flow.
  - **Callbacks:** `suggest` has a CALLBACKS section built from ★ moments (validated ids). Each improv option can name a ★ moment it calls back (an id chosen from up to 3 relevant moments), shown as ⟲.
  - **Duradan:** `enrich` suggested 6 moments (Gary's death, Salaena's shield, the stick horse, Salaena kicking Darius, the duplicates reveal, Dahlia's window entrance). **All are ☆, waiting for Jacob to star.** A test with two temporary stars produced strong callbacks (the stick horse half-visible in the Knight figurine's light; "Salaena's kick, but worse"); both were reverted afterwards.
- [x] **Step 4: Player layer and spotlight** (migration `drizzle/0004`).
  - `players` table: handle, enjoys (combat / social / exploration / mystery / comedy / drama, 0–3), personal lines, table notes. PCs link to their player through `entities.player_id`. DM-only: players are never named in prompts or output.
  - `player list | add | set | remove`.
  - **Spotlight** (`src/core/players.ts` `tableSeats`): a PC's last moment of their own comes from key moments (★ or ☆) involving them, plus threads about at most two PCs that moved that session. That gives "quiet for N sessions".
  - **Improv:** each option states its pillar. Options are ranked by what the hand-off player enjoys plus a boost for quiet players (`spotlightScore`). The prompt gets THE TABLE block, and when someone is quiet for 2+ sessions, asks for at least one option handing off to them. Output marks these with ◎.
    - A hand-off to "table" whose text names one PC counts as that PC.
    - Options that leak table notes ("a quiet soul", "spotlight") are rejected.
  - **Suggest:** per-player ideas are ordered quietest first and marked ◎; players' personal lines join the safety check (tested: "spiders" steered a web-filled cellar).
  - **Duradan:** Iresia has been quiet since session 1, which matches the notes. Suggest now leads with her, and the open camp moment led with her hand-off. **Jacob still needs to add the real players** (`player add`).
  - Also closed: a captured NPC can only reach out or arrive by escaping or getting word out (bribing a guard, smuggling a note).
- [x] **Step 5: Context by graph distance** (`src/core/graph.ts`).
  - `distancesFrom` walks relationships, parents, locations and small shared threads (up to 4 entities) out from seeds.
  - `BUDGETS` per feature:
    - improv: depth 2, 4 full cards, 6 briefs, 10 names, 6 threads (3 in full).
    - suggest: depth 3, larger.
    - flavour: full cards for tagged entities only.
  - The scene shows distance-0 entities as full cards, distance 1 as briefs (state, abilities, goal, 2 ties), distance 2 as "ALSO NEARBY" names. PCs not in the moment get brief lines. Only rules that reach someone or have a nearby source appear. Two-way relationships print once; rules skip the plain-words copy when structured.
  - Improv's allowed-actor list is limited to entities within reach, plus anyone named and the PCs. A malformed answer now counts as a failed attempt and is retried (it used to crash the call).
  - **Measured (10 Duradan moments, Haiku):** expected-thread hits 9/9 → 9/9; input tokens −7 to −15%; speed per call ~5.2–5.4 s, unchanged.
  - **Finding:** latency is dominated by output (~850–920 tokens for three structured options), so context size isn't the speed lever. What it buys is relevance, and prompts that stay bounded as campaigns grow. Real speed levers: stream options as they're written (web UI), shorten the scaffold (fewer/shorter fields), or fewer options.
- [x] **Step 5b: Adaptive thread selection** (`selectThreads` in `retrieval.ts`; budgets in `graph.ts`).
  - Threads tied to anything the moment names are always kept.
  - Plus everything scoring at least a share of the best match, with a floor and a ceiling. A moment naming nothing gets at least 6.
  - The strongest few go in full; the rest as one-liners.
  - Modes:
    - wide (default): depth 3, more cards, min 8, max 20, cutoff 0.15, 6 full.
    - `--focused`: depth 2, min 4, max 12, cutoff 0.35, 4 full.
    - `--threads N`: exactly N plus the guaranteed ones.
  - `--why` marks each thread full/line and ★ when guaranteed. The scenario runner also takes `--focused`.
  - **Measured (10 Duradan moments, Haiku):**

    | | Hits | Retrieval misses | Input tokens | Speed | Cost | Rejected |
    |---|---|---|---|---|---|---|
    | Fixed 6 | 9/9 | 3 | ~6.2k | 5.2 s | — | — |
    | Focused | 9/9 | 2 | ~6.45k | 5.3 s | $0.0123 | 10 |
    | Wide | 9/9 | 1 | ~7.5k | 5.2 s | $0.0133 | 5 |

    The heresy bounty is recovered via guaranteed threads. **Wide is no slower and costs ~8% more, so it's now the default** (Jacob, 24 Oct); `--focused` is the lighter option.
- [x] **Tiered review and undo** (Jacob's request: confirmations without friction; migration `drizzle/0005`).
  - **Evidence:** every proposed entity, thread, thread update, entity update, relationship and party move carries a short exact quote from the notes. `checkEvidence` (`src/core/review.ts`) marks each as in the notes / close / not found.
  - **Tiers** (`reviewProposal`):
    - **Added automatically:** filling blanks with quoted facts, new non-PC entities, structural relationships (member_of, located_at, lives_at, made, knows_about), suggested moments, a first party location.
    - **Confirm in groups:** new threads, progress, links, other relationships, changes to extracted values.
    - **Need a yes:** changes to the DM's own entries; dead / captured / missing / destroyed; alignment, secrets, true properties; a held item changing hands; closing a thread; a new PC; any quote not found in the notes.
  - `splitRisky` gives each risky field its own item, so declining one keeps the safe details beside it. A yes on a must-confirm is applied as the DM's own entry.
  - **Review screen:** a digest of automatic additions; groups accepted with Enter (or numbers to skip); risky items one at a time with the reason and the evidence check. Piped answers work for scripts.
  - **Undo** (`src/core/undo.ts`): every write is logged with a batch label (one per recap or enrich). `changes` lists recent batches; `undo` reverses the latest; `undo --batch "<label>"` or `undo <id>` reverse others. Undo reverses fields, relationships (both directions for two-way ones), created entities and threads, thread progress (and its event), links and suggested moments, and marks rows undone. It refuses when a later change touched the same thing (unless `--force`).
  - **Tested on the fixture:** a crafted session sorted 15 / 8 / 4 across the tiers with all quotes verified. Declining Ysolde's attitude change kept her other details; a confirmed vial hand-over overrode the DM's holder as intended; one `undo` reversed all 43 changes; undo blocked an out-of-order reversal. The 25 earlier cases still pass.
  - Not yet: manual CLI writes aren't batched (undo them by id); learning which kinds of change a DM always accepts.
- [x] **Step 6: Embeddings as entry points** (migration `drizzle/0006`, `src/core/embeddings/`).
  - **Providers** behind one interface (`LOOM_EMBEDDINGS=local|voyage|off`, `--embed` on improv and scenarios):
    - **local** (default): BAAI bge-small through Transformers.js. 384 dims, ~35 MB downloaded once into `data/models`, offline after.
    - **voyage**: `voyage-3.5-lite`, needs `VOYAGE_API_KEY`. Built but **untested: no key yet**.
  - **Storage:** a derived property in its own `embeddings` table (owner type and id, chunk, model, text hash, the embedded text, Float32 vector). What gets embedded: threads, entity cards, key and suggested moments, and recap scenes (paragraph chunks). `ensureEmbeddings` re-embeds only what changed (hash) and drops what's gone. A full Duradan embed (137 items) takes ~1.7 s; a no-change refresh ~12 ms. Similarity is computed in code (hundreds of vectors).
  - **Blending** (`searchByMeaning` gives z-scores within each kind, so no per-model thresholds):
    - A thread unusually close in meaning gains score.
    - Entities close in meaning (z ≥ 1.5, up to 3) become graph seeds and boost their threads.
    - The closest recap scenes are quoted in the prompt ("FROM YOUR NOTES"), and **non-PC characters named in those scenes boost their threads**. That's the bridge that closed the tavern → Professor Vex miss.
    - Key moments close in meaning become callback candidates.
    - `--why` shows what meaning search found. `embed` refreshes; `embed search "<text>"` shows the nearest matches.
  - **Measured (10 Duradan moments, Haiku, wide):**

    | | Hits | Retrieval misses | Input tokens | Model latency | End to end | Cost |
    |---|---|---|---|---|---|---|
    | Off | 9/9 | 1 | ~7.4k | 5.20 s | 5.2 s | $0.0121 |
    | Local | 9/9 | **0** (first ever) | ~8.0k | 5.25 s | 5.9 s | $0.0138 |

    The extra ~0.7 s end to end is loading the embedding model in each CLI process; in a long-running web server it loads once.
  - Still to do: the Voyage comparison once a key exists.
- [x] **Step 7: Stress tests and blind run 3** (24 Oct).
  - **Crafted checks:** 41/41 across agency, rules and conditions, possession, relationship laws and undo, and meaning search (`scenarios/private/checks.ts`, no LLM calls).
  - **Live cross-layer moments (Haiku):**
    - Conditions stated in the moment aren't applied ("Iresia, at 0 HP and unconscious…" still asked her player what she does).
    - The spotlight is too strong: quiet Iresia gets most hand-offs, even in Khayiulad's own figurine scene.
    - Retries cost ~6 s (11–12 s total).
    - Failure text for table-wide rolls uses a bare "she/him".
    - Capitalised verbs after names ("Vex'ahlia Uses").
    - Vex'ahlia's records contradict each other: she "fled by invisibility" but is `located_at` the outpost as "defeated there", so she turns up in most scenes.
  - **Blind run 3 (wide context, scaffold, embeddings off):**

    | Model | Options ticked | Rate | Moments with at least one usable option | Avg latency | Cost (10 moments) |
    |---|---|---|---|---|---|
    | Haiku | 14/29 | 48% | 8/10 | 5.3 s | $0.013 |
    | Opus | 14/29 | 48% | 9/10 | 10.2 s | $0.52 |
    | Sonnet | 10/23 | 43% | 8/10 | 10.2 s | $0.32 |

    Haiku caught up with Opus (run 2: 11 vs 13), at ~1/40th of the cost and half the latency. Sonnet is last for the third run and had 17 options dropped by the checks.
  - **Fixes after run 3** (Jacob: Haiku → Opus tiers, plus all fixes):
    - Improv default is Haiku.
    - **Spotlight:** exposure is recency-weighted (each session of theirs fades by half per session since). The quiet nudge is at most 0.6, below one point of what a player enjoys. A hand-off to a PC the moment names gets +0.7. The prompt asks for *exactly one* option for the quietest PC.
    - **Fewer retries:** the model writes 4 options and the best 3 are kept; it retries only if fewer than 2 survive. Every living PC stays in the hand-off list, so one bad name fails one option, not the whole answer (that had caused two unparseable attempts).
    - **Conditions stated in the moment** ("at 0 HP and unconscious", paralyzed, restrained…) apply for that call, are stated in the prompt, and come with a records note (`momentConditions` in `improv.ts`).
    - Table-wide rolls can't have he/she in the failure text. Verbs after a name are lowercased. An empty walk-on reads "Someone".
    - Vex'ahlia's description now covers session 5 (defeated at the outpost); the notes' spelling "Vex'halia" is an alias. A `knight-again` scenario tests repeated figurine use.
    - **Measured:** 46/46 crafted checks. Live on Haiku: 5.9–7.0 s with no retries in 7 moments; the quiet PC gets one option per moment, and the moment's own PC comes first. Repeated Knight use gives a madness roll, but not yet "it won't let go".
    - **Still open:** the escalation of a rule with use isn't tracked.
  - **PC body reactions (24 Oct, two forks compared, then both merged).** Rule: before the hand-off, describe what happens *to* a PC (sensations, forces), not how they react; after a failed roll the body may move.
    - **Prompt line** in SYSTEM, with a before/after example. Alone it halved live slips (4/41 → 2/42), with no change in speed or cost, and the body effects moved into the failure text ("her grip will not loosen").
    - **Code check** (`pcReaction` in `scaffold.ts`): sway, brace, stagger, flinch, clutch, recoil, stumble… after a PC's name or title, a PC's body part, a pronoun or posed limb whose nearest named character is a PC, or inside an outcome beat. NPC reactions and failure text are still allowed. 33 crafted cases (20 slips, 13 sensations) all pass.
    - **Parse failures:** `callback` and `on_fail.target` are now free text, normalised in code. A single odd value ("none" when no key moments exist, "everyone" as a failure target) used to make the whole answer unparseable; that caused most retries.
    - **Combined, live (8 provoking moments × 2, Haiku):** 45 options shown; 1 clear slip ("Salaena lets out a sharp breath") and 2 borderline involuntary ones ("collapses to one knee", "her cat form lurches"); 1 parse failure (now fixed); 6.0–7.3 s per call; ~$0.0014 per call. All 79 crafted checks pass.
    - **Seen in passing:** Vex'ahlia's status is "alive" rather than captured, so she still appears free (on a rooftop); "Ask {Salaena} whether…" inside a beat is flagged as Salaena acting, which may be a false positive.
