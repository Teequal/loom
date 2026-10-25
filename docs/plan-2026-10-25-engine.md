# Plan: a stronger Loom engine (25 Oct 2026)

**Principle (Jacob):** code has the first say on what is true and what can happen. The model's pass is second: phrasing, flavour and richer context, always inside what the engine allows.

**Goal:** stop fixing slips one at a time. Every option is built from one model of the scene, under laws declared once, from moves the engine finds in the loom.

## Where we are

- **Each feature works out the scene its own way.** `buildScene` (scene.ts) gives cards and presence. `buildLists` (improv.ts) works out who may act, possession, conditions stated in the moment, and the interim "does the moment bring them in" rule. Develop, fights, prep ideas and rules questions call `buildScene` but have no presence or possession laws at all: they rely on the prompt and `planSlips`.
- **One law lives in three places that drift apart:** the prompt's wording, the answer format's lists, and the code checks. Today there are ~56 rejection reasons and ~38 text patterns across scaffold.ts, improv.ts and plan-agency.ts. Relationship laws, conditions, rule triggers and roll rules are separate code.
- **The model invents each option's plot** inside the scaffold, then code checks it. Most remaining faults are text checks missing a phrasing.
- **Each moment rebuilds everything from the database:** entities, relations, effects, threads and name patterns.
- **What works and stays:** the answer format is now really enforced (step 16), each beat kind has its own actor list, hand-offs are built from parts, and the rejection log, crafted checks and blind runs exist.

## Phase A: one scene model

**What:** `src/core/situation.ts`. A `Situation` is built in code for each moment, and every feature reads it.

```
Situation
  place        where the party is, as a chain of places; the moment may move it ("heads to the HQ")
  people       per character: here | nearby | elsewhere | unknown | captive | dead,
               plus can act / speak / notice, and WHY ("travelling with the party",
               "the moment brings her in", "you said so")
  items        per item: holder or none, status, and why (lost ⇒ no holder; the moment can put it in a PC's hand)
  rules        live house rules: the trigger that fired, and who they reach now
  pcs          capabilities from records + the moment (conditions it states)
  moment       what the moment changed: brought in, only referred to, items in hand,
               conditions, place change
  overrides    the DM's corrections from the chips (they always win)
```

**How the moment is read (code):** one module, `moment-reading.ts`, replaces the scattered pieces: `momentConditions`, the moment's possession override, `REMOTE_CONTACT`, `WHOLE_PARTY` and the interim `bringsIn`.
- Every mention of a known name or alias is found once (longest names first).
- Each mention is classified by its surroundings: **brings in** (the subject, or someone the party confronts, tells, attacks or meets), **refers to** (a possessive, "looks for", "about", "a note from"), **contacts from afar** (Sending, a letter, scrying), **has in hand** (an item with a PC), **condition** (unconscious, restrained…), **goes to** (a place).
- The rules are data (a table of cue words per role), each with its own test moments, so a missed phrasing is one new row and one new test, not a new check somewhere else.

**The chips (DM in charge):** under the box, worked out as you type, with no model call. For example: `Here: Tomas · Bhen ✕ (only mentioned) · In hand: Knight figurine · Rule: Figurine madness`.
- Tapping a chip corrects it ("Bhen is here after all"), and `+` adds someone from the cast.
- Corrections go with the request as overrides, and are saved on the live entry so wrap-up sees them.
- The chips stay quiet: one line, and only when the moment names someone or something.

**Campaign index (speed):** a per-campaign index held in memory by the server: entities, relations, effects, threads, moments, name patterns and the graph.
- It's rebuilt on any write. Every write already goes through entities.ts, history.ts and the undo log, so that's one place to invalidate.
- `readSituation(index, moment, overrides)` is then a pure function: fast, and easy to test.

**Done when:**
- Improv, Develop, fights, rules questions, the re-wording pass and prep ideas all read the `Situation`. `buildLists` becomes a thin adapter over it.
- The chips are on the table page.
- The interim presence rule is gone.
- Every reading rule has test moments. The current crafted checks, plus the blind run 4 faults (Bhen, the lost Knight figurine), are reproduced as tests and pass.

## Phase B: entity profiles (revised 25 Oct, Jacob's focus)

**Jacob:** strong doesn't mean more restrictions; it means more effective ones. Put more context on every entity type, and use more of it when the code runs.

**What Phase A showed:** the records held the answer and the engine didn't use it. The Knight figurine is recorded as lost and last seen at the River Morrow, but the engine read only "lost", and treated every item without a holder (11 of Duradan's 13) as present in any scene. Each slip came from a fact the engine had and ignored, not from a missing rule.

**B1. A profile per entity, built in code** (`src/core/profiles.ts`). It's built from everything the loom holds: fields, traits, relationships, holders, places, open threads and their summaries, house rules, and the latest recorded change. Each profile has:
- **A role in this moment**, decided by code from the type and its state:
  - **here:** can act, be used or be seen now;
  - **reachable:** can arrive or send word;
  - **remembered:** can only be recalled, sought or talked about (dead, lost, destroyed, far away with no means to get here);
  - PCs are always **player** (the players decide everything they do).
- **Where it stands**, in words: "held by Salaena", "lost: last seen at the River Morrow", "with the party", "last seen at the Northern Gate Outpost", "whereabouts unknown".
- **The facts that matter for its type:**
  - Items: holder or whereabouts, set or pieces, properties, cost of use, rules from it.
  - NPCs: attitude, goal, ties to PCs, abilities, what they know.
  - Places: what's there, hazards, rules bound to it.
  - Factions: leader, members nearby.
  - PCs: health, conditions, abilities, what they hold.
- **Its open threads** (titles), so the model sees why it matters.

**Items get a real presence rule.** An item is **here** only if someone here holds it, it's at the party's place, or the moment names it. Otherwise it's **remembered** (lost) or **reachable** (whereabouts known). The same goes for places and factions: a faction is here through its members, otherwise it acts through agents (arrivals and messages).

**B2. The scene prompt is built from the profiles,** grouped by role. "IN THE SCENE", "CAN ARRIVE OR SEND WORD" and "ONLY REMEMBERED OR SOUGHT" each list entities with their state line ("Knight figurine: lost, last seen at the River Morrow"). The model sees what can and can't happen as context, before it writes anything. The cards stay for depth, ordered by graph distance as now.

**B3. One law from the profiles, for every type,** replacing the per-type checks: an entity may only do what its role allows. Remembered things never act, warm or appear in someone's hand; reachable ones only arrive or send word; here ones may act. The answer format's actor lists come from the same roles. The check covers beats, failure text and headlines alike.

**B4. A PC's body is the player's.** Instead of listing the reactions to reject (whack-a-mole), list what's allowed: when a PC's body part is the subject, only sensations (tingles, burns, aches, goes cold, goes numb) are fine. Anything else is the PC acting, unless it follows a failed roll.

**Measure:** the same sample-campaign runs and the Duradan rerun of blind run 4's faults. Then a blind run at the end of the phase.

The rest of the original Phase B (a laws registry generating the format lists, validators and prompt lines; the roll table) follows once the profiles carry the context the laws read from.

## Phase C: the engine proposes the moves

**What:** `src/core/moves.ts`. From the situation and the graph, code lists candidate moves for the moment, scores them, and gives the model the best 5–6. The model picks 3, fills the beats and hand-off within each move, and writes the words.

**The moves, each found by a pattern in the loom:**

| Move | Found when |
|---|---|
| payoff | a thread the moment touches is ripe (see lifecycle) |
| complication | a touched thread has stakes or a deadline |
| collision | two open threads share a character, item or source, and the moment touches one (the potion cure swap) |
| callback | a ★ moment shares characters or meaning with the moment |
| rule | a live rule just triggered (Figurine madness when the moment uses a figurine) |
| arrival | an absent, living NPC has a stake in a touched thread (arriving, or acting from afar) |
| consequence | a deadline is due, or a high-stakes thread has gone quiet |
| character | a PC in the scene has a condition thread (with the spotlight weighting) |
| hint | a GM secret on a touched thread or character, offered as a clue, never stated |
| wildcard | any touched thread, so the model's own ideas still have room |

Each move carries: its threads, the characters it may use (its cast), the rule if any, a code-written reason ("Two threads share Mother Ysolde"), and a score (relevance, ripeness, spotlight, the mix, and recency so the same move isn't offered every time).

**Answer format:** `move` is chosen from the offered move ids. A beat's named actor must be in that move's cast or be present (a code check; a union per move would make the format too big again). "Why this fits" comes from the move, so it's always true. The model adds a short line in its own words.

**Thread lifecycle (just enough for scoring):** each thread gets a state (open → building → ripe → resolved) and a heat score from recency, stakes, deadline and how often it's been touched. It's computed in code from `thread_events`, and shown on the campaign page later.

**Speed:**
- The model writes less (no plot invention, fewer fields), which should win back the ~1.3 s that titles and hand-off parts cost.
- The system prompt and the generated rules block are a stable prefix, so prompt caching applies.
- With rejections at ~0.5 per call, try asking for 3 options instead of 4.

**Done when:**
- Every improv option is built on an engine move.
- Speed is at or below step 15's (first option ~3 s, all three ~5.5 s on Haiku), measured.
- A blind Duradan run (Jacob's ticks) is at least as good as run 4, and options don't feel formulaic. That's the main risk, and the wildcard move and Jacob's ticks are how we watch it.

## Phase D (later): the same engine for plans

Develop, fights and prep ideas use the same `Situation`, laws and slots for their pieces, which retires `planSlips`. This follows once improv proves the approach.

## How each step is measured

- **Test bench** (one command): the crafted checks, the adversarial set, every law's examples, every moment-reading rule's test moments, and invariants on generated scenes from the sample campaign (random moments, asserting no absent actor, no PC as subject, no rule without its trigger, no held lost item).
- **Rejection log:** per call, by law id rather than free-text reason, so a drift at the table points to the law.
- **Sample campaign:** the same 16 calls each time. Track rejected per call, options shown, first option and full time, and cost.
- **Duradan:** a blind run at the end of Phase B and of Phase C, ticked by Jacob. A Haiku-only run after each step to watch speed.

## Order of work

**Phase A**
1. Campaign index in memory.
2. `moment-reading.ts` with its rules table and tests.
3. `Situation` built from the index and the moment.
4. Move improv onto it, with buildLists as an adapter.
5. Move the other features onto it.
6. The chips on the table page.

**Phase B**
1. Laws registry: move in relationship, condition, possession and presence laws, then measure.
2. Generate the format lists, validators and prompt rules from it, then measure.
3. The roll table and rule triggers.
4. Names through slots and the one renderer.
5. Retire the patterns it replaces, then measure.
6. Blind run.

**Phase C**
1. Thread lifecycle and heat.
2. The move finder and scores, tested against Duradan moments where we know the right move (cure swap, figurine madness, Varek's bounty).
3. Improv on moves, then measure.
4. Prompt caching and fewer options, then measure.
5. Blind run.

Each numbered step is runnable and testable on its own, and is committed separately once it passes.

## Decisions (Jacob, 25 Oct)

1. **Chips:** shown as chips, little icons, or hidden, chosen on a new **Settings** page together with the other per-browser preferences.
2. **The engine's reason is shown**, passed over by the model for wording. It may rephrase it, never change what it says.
3. **Wildcard:** always one of the moves offered.

## Already done toward this (uncommitted)

- The lost-item law: losing an item ends its holder; holding it clears "lost"; old records are read the same way.
- The interim presence rule (`bringsIn`), to be replaced by `moment-reading.ts` in Phase A.
- One crafted check fails until Phase A: a lost item has no holder yet, so nothing stops anyone using it.
