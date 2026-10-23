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
  - **Improv: Sonnet 5.5**, with Opus 5.5 available per call (`--model opus`).
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
- **Product idea (Phase 2, needs accounts and billing):** improv on Sonnet by default, with Opus as an upgrade tier and a free trial or allowance of Opus calls.
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
- [ ] Step 8 (optional): One-box local web page

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
- [ ] Step 3: Extraction proposes entity and relationship changes; backfill Duradan
- [ ] Step 4: Entity cards and party location in prompts; slip checks
- [ ] Step 5: Embeddings and hybrid retrieval
- [ ] Step 6: Test on known slips; blind rerun
