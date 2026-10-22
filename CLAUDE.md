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
- **LLM: Anthropic, Claude Haiku** for all features to start ($5 credit). The provider sits behind a small interface; every call is logged to `llm_calls`.
- **Recap changes are proposed, not applied.** The DM approves each one.
- **Improv options must cite a real thread id** from the retrieved set; the code rejects any that don't.
- **Retrieval starts cheap:** entity/alias mention matching, graph hops and SQLite full-text search. Embeddings only if the test scenarios show they're needed.
- Real campaign notes live in `Old Campaign Notes/` (gitignored, private). The test fixture campaign (`npm run loom -- seed`) is the potion example with invented names.

## Phase 1 progress

- [x] Step 1: Project setup, schema, potion fixture, `seed` / `campaigns` / `threads` commands
- [ ] Step 2: LLM interface + call logging (`loom costs`)
- [ ] Step 3: Recap → proposed thread changes → approve
- [ ] Step 4: Improv box (retrieval + 2–3 tied-back options)
- [ ] Step 5: Scenario runner
- [ ] Step 6: Between-session suggestions incl. thread "collisions"
- [ ] Step 7: Real-campaign test (Darkness in Duradan, sessions 1–5)
- [ ] Step 8 (optional): One-box local web page
