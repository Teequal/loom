# Develop v2: steer, one result, refine

25 Oct 2026. From Jacob's live testing: Develop is the weakest part of the table page and feels bloated. It gives a lot without asking anything, and the Open / Set up / Lead to picker leaves pieces on screen without saying whether they're a chain or separate ideas.

**What Develop is for:** the middle ground between "what do I do right now" (improv) and planning ahead (Prep). Typical use: the party is doing something minor (shopping, travelling, resting) and the GM wants the next few minutes to the next scene ready.

**The new shape:** ask how, write one thing well, then work on it together.

## 1. What changes for the GM

### Step 1: Steer (nothing written yet)

Tap **Develop ↳** on a card, a logged choice or a step. Develop asks one question with one row of chips:

> How do you want to take this?
> **A fight** · **A heartfelt moment** · **An epic scene** · **Grounded** · **A quiet moment** · **Tie to the story**
> [ or say it in your own words… ]

- One tap starts it. Typing your own words and pressing Enter does too.
- Loom shows a faint ring on the chip it would pick, based on the scene: a ripe thread suggests "Tie to the story", a quiet PC suggests "A heartfelt moment", a fight thread suggests "A fight". It's only a hint, never a pick.
- The chip sets the kind, not the length. Length comes from where you develop from (see Reach below).

### Step 2: One result, as a numbered chain

Loom writes one short sequence (or as many as the options setting says) and shows it as **numbered steps joined by a line**, so it reads clearly as one string of events:

```
1  The fishmonger's boy runs up, breathless: Ysolde wants to see Bram, now.
   → Ask Bram's player: go now, or make her wait?
2  If they go: Ysolde's shop is shuttered, a second vial on the counter.
   → Intelligence (Investigation) to read the label.
3  On a success, the label names the same brewer as Kira's potion.
   Ties: Bram believes he cannot die · What was really in Ysolde's potions?
```

- 2–4 steps. Each step is **what the world does**, then **the players' turn** (a question, a choice or a roll), and the next step opens with "If they…" or "On a success…". This is the "going through it with the GM" Jacob asked for: each step stops where the players decide.
- One "why this fits" line at the bottom, naming the threads it ties to.
- Steps stream in as they're written, so the first one is readable after a few seconds.

### Step 3: Refine in place

Under the result there's one row:

> Shorter · Darker · Lighter · Bring in <someone> · Another take · [say how…]

Each one rewrites the result in place: one version on screen, with **Back** to undo the last change. Each step also has a small menu: **Swap this step** (rewrites that step and what follows from it) and **Use this step ↳** (logs it, see below).

- "Bring in <someone>" lists people from the threads in play, as the steering chips on improv already do, and the engine decides whether they arrive or are already here.
- "Another take" is the **More options** button: a different result from a different move, added below the first.
- A fight step offers **Set up the fight** (the existing fight panel).

### The options setting

Settings gets **Develop options: 1 · 2 · 3** (default 1), per browser like the other preferences. It replaces the "Develop's starting reach" setting. The table's improv count stays at 3 for now. If the setting is liked, the same control could later set improv's count too (Jacob: "generally I only need 3 max but could run with one").

### Logging and the tree

- **Use this step ↳** logs that step as a branch entry (as today's "Use this" does), and it's read into the loom. Using step 2 uses step 1 first, so the tree stays in order.
- The result is saved on the entry (`developments`), so it survives a reload. Saved results from the old Develop still show, read-only, in their old layout.
- Developing from a step works as it does now (nested up to 5 levels).

### Reach

The reach slider goes. How far ahead to plan follows from where you develop from:

| Developing from | Plans |
|---|---|
| An option or a used choice | the next few minutes |
| A step of an earlier Develop | the rest of the scene |
| Your own words that say a time ("while they rest", "next session") | that time |

"The arc" moves to Prep (and later the sandbox), where long-range planning belongs. Develop never plans more than the next session.

## 2. What changes in the engine

**Develop moves onto the same engine as improv.** Today Develop is free prose, checked afterwards by `planSlips` (a PC doing something gets one rewrite, then the sentence is dropped). Improv already has moves, casts, slots, typed beats and hand-offs written by code. A Develop step has the same shape as an improv option (world beats, then the players' turn), so it should be built the same way:

- **The steer picks the moves** (`findMoves` with a steer):
  - A fight: moves with a fight hand-off; enemies from who's in play (as `encounter.ts` does).
  - Heartfelt: character moves for a PC's condition or goal, and callbacks. Prefers the quiet PC.
  - Epic: collisions and ripe payoffs, more than one thread.
  - Grounded and quiet: small stakes. Hints and NPC moments; nobody new arrives.
  - Tie to the story: the threads closest to the campaign's direction, and ripe payoffs.
  - Own words: read like a moment; the engine picks as for improv.
- **Each step is an improv option's scaffold:** beats through slots (`{Name}` references, "happens" beats for what a PC feels), the cast from the move, and a structured hand-off (`Hand`). Code writes the step's sentences. `pcOpensClause` is the only text check, and a faulty sentence is dropped rather than the step.
- **Chaining:** step N+1 starts with a condition on step N's hand-off ("If they go", "On a success"). The condition is chosen from the hand-off's outcomes, which come from the `Hand` kind: a choice's two sides, a roll's success or failure, a question's "if they…". Code writes it, so the chain always reads as one string.
- **The world moves between steps:** each step's beats are applied to the View provisionally (arrivals, items changing hands, conditions). The next step's cast and checks see them: someone who arrived in step 1 is "here" in step 2.
- **Refine:** "Darker", "Lighter" and "Shorter" re-run the same moves with a tone or length instruction. "Bring in X" adds X to the cast as a lead. "Swap this step" keeps the earlier steps and their effects on the View, and re-runs from there. "Another take" excludes the moves already used.
- `planSlips` and `withoutSlips` stay for fights' terrain lines and fresh ideas, which are still prose.

**Model and speed.** Develop is currently Opus (15–25 s), with Sonnet for the ideas step. Plan: run the steps on the table's model tier (Quick / Balanced / Best), streamed step by step like improv options. Targets: on Quick, the first step in about 4 s and the whole chain in 8–10 s. Refines on Quick: 3–5 s.

## 3. What's removed

- `developIdeas`, the picks, the Open / Set up / Lead to sections, `reworkPiece`'s per-piece rework (refine replaces it), and `/api/develop/ideas` and `/api/develop/rework`.
- The reach slider and the `reach` preference (replaced by `developOptions`).
- `REACH_TEXT` and the intro read-aloud block. A step's world beats are already read-aloud length; the flavour pass (`flavour.ts`) can make one step into prose on request ("Read aloud").

## 4. Build steps (each one testable)

1. **Engine: chained steps.** `develop.ts` builds a chain from moves: a steer → moves mapping, the improv scaffold per step, the condition between steps, and the provisional View updated between steps. CLI: `develop <entry> --steer heartfelt [--count 2]`. Crafted checks: the chain's conditions match the hand-offs; an arrival in step 1 is "here" in step 2; no PC opens a clause in any step.
2. **API and streaming:** `POST /api/develop` takes `{ entryId | base, steer, words?, count }` and streams steps as newline-delimited JSON. `/api/develop/refine` takes `{ result, how, step? }`. Results are saved on the entry in a new shape (`kind: "chain"`).
3. **The page:** the steer row with its suggested ring, the numbered chain with joining line, the refine row with Back, the per-step menu, Use this step, Set up the fight on a fight step, and the Develop options setting. The old Develop is removed; old saved plans show read-only.
4. **Measure** on the sample campaign and the enriched Duradan copy, 8 moments × the 6 steers:
   - time to the first step and to the full chain;
   - cost per chain;
   - steps dropped by the checks;
   - whether each chain ties to a thread in play;
   - Jacob's "would use" ticks on a blind set, as for improv.
5. **Docs:** CLAUDE.md and the UX notes.

## 5. Questions for Jacob (defaults chosen; say if you'd change them)

- **The chips:** A fight · A heartfelt moment · An epic scene · Grounded · A quiet moment · Tie to the story. Funny is in improv's mix but not here; add "Something funny"?
- **"A fight":** a short lead-up whose last step is "Set up the fight" (default), or straight to the fight panel?
- **Default options count:** 1.
- **Steps per chain:** 2–4, shorter when developing from a step.

## Next: the sandbox page

After Develop v2. A chat page about the game. The model wraps every suggestion it makes in a tag, and only tagged sentences can be saved: on hover, ✓ saves it, ✎ edits it first. Saving goes through the same reading and review as notes and logged choices (typed changes, risky ones asked first, undoable). It reuses Develop's steer chips and refine controls. It runs on Sonnet with a short memory, since it carries a conversation. A plan follows once Develop v2 is in.
