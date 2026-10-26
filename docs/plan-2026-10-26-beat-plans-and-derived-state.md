# Plan: derived state and beat plans

26 Oct 2026. Builds on [the engine gap analysis](review-2026-10-26-engine-gaps.md) and Develop blind run 2: Haiku 3/24 usable, Sonnet 8/8. Haiku's chains are thin: it writes good sentences, but it has nothing to say.

Jacob's direction: keep moving work into the engine. The richer the data and metadata, the better the scaffolds and the less the model carries. State should evolve, not sit still: mood could be *derived* from recent success or failure and other events.

Two pieces, in order:
1. **Derived state:** values the engine works out from what has happened, so the world it reasons about moves between sessions and within one.
2. **Beat plans:** the engine chooses what each beat delivers (its payload), using the recorded and derived state, and the model only phrases it.

Derived state comes first. It's what gives beat plans something worth delivering, and it improves improv, Develop and prep straight away.

## 1. Derived state

### The rule

A derived value is **computed, never stored as a fact**. The records stay the DM's and the extractor's. A derived value sits beside them, worked out each time from the log, and always says why ("rattled: failed two rolls this session"). It never overwrites a recorded value. Where both exist, the prompt shows both ("mood steady (recorded); rattled lately (two failed rolls)"), and the DM can always set the recorded one.

Each derived value has:
- **a value and a band**, which the engine uses;
- **because**, a short list of the events behind it, shown to the DM and the model;
- **a fade**: recent events count more, and a session back counts half (like NPC activity).

### What to derive

These use data the engine already has, mostly the live log and the scaffolds kept on it since this morning.

| Derived value | From | Used by |
|---|---|---|
| **PC momentum** (on a roll / rattled) | roll results this session and last (Succeeded / Failed / Partly; Won / Lost / Fled), who made the roll (from the choice's scaffold), health dropping | profile lines; a rattled PC draws heartfelt and character moves; a PC on a roll draws complications (raise the stakes) |
| **Rule use and escalation** | how often each house rule's roll was asked for and used, per person, this session and overall | profile and rule-move lines ("Figurine madness: third use this session, the cost should grow"). This is the "the cost of a power grows with use" Jacob wanted, now counted rather than hoped for |
| **Pace** (tense / steady / slack) | this session's log: rolls and fights in the last few moments, and how long since the last one | move weighting: after two fights, a breather (hints, callbacks, character); after a long quiet, a complication or an arrival |
| **NPC activity** | mentions, fading per session | already built |
| **NPC disposition drift** | the recorded stance, plus recent events involving them (helped, crossed, fought, a thread with them resolved for or against the party) | profile lines; who helps and who hinders in a move's cast |
| **Faction alert** | fights and thefts against a faction's members or places this session | a faction move ("the Red Hand doubles the watch") once alert is high |
| **Thread pressure** | heat (built), plus sessions untouched with a deadline, plus the party moving away from it | complications and arrivals ("if ignored…") |
| **Familiar places** | visits in the log and the notes | grounded and quiet chains reuse known places and people |

**v1, built now:** PC momentum, rule use and pace. They need nothing new from the DM: results, scaffolds and the log are already recorded. Disposition drift, faction alert and familiar places follow once their events are tagged. Direct changes make that tagging nearly free, because a used option knows its move, its cast and its rule.

### Mood

Recorded mood is a number the DM (or the enrichment) sets. Derived momentum is a lean on top of it, shown as its own line rather than folded into the number. A later step can make mood itself drift (a recorded "steady" PC who's had three bad sessions reads "grim lately"), with the DM's recorded value always winning when it's newer than the events.

## 2. Beat plans

### The idea

Today the engine picks the move, the thread and the cast; the model writes each beat's sentence, *and decides what it delivers*. With beat plans, the engine decides what each beat delivers, and the model writes one sentence for each planned beat.

**A beat plan** (per step, made by code, before the model call):

| Part | Values | From |
|---|---|---|
| actor | the move's cast, an extra, or the world | as now |
| act | reveal · offer · threaten · ask · arrive · send word · take · give · hazard · sensation · stall | the move kind and the steer (a hint reveals; a complication threatens or takes; heartfelt offers or asks) |
| object | a reference | the payload's subject |
| **payload** | an engine fact with an id (below) | the records and derived state |
| turn | the hand-off kind, with typed choice sides | as now |

**Payloads**, in the order the engine prefers them:
1. a thread's unspent pieces: payoff ideas, `ifIgnored` stakes, the deadline;
2. knowledge someone holds (a GM secret is hinted, never stated);
3. a goal, fear, bond or belief of someone in the cast, *or one of their derived states* ("rattled: a kindness lands");
4. an item's cost or true property, and a rule's escalation ("third use");
5. a faction's goal or next clock step;
6. a place's hazard or atmosphere;
7. as a last resort, the thread summary (what we have today).

The model receives, per beat, "actor · act · object · payload text" and writes the sentence. It can't add an actor, object or fact, because there's no slot for one. The prompt shrinks, and so do the checks.

### The format

To stay under the API's grammar limit (two step shapes were already too big):
- the plan is **in the prompt**, numbered (P1, P2…);
- each written beat names its plan id from an enum, plus its sentence;
- code drops any beat whose plan id isn't in the step's plan, and puts the actor in front, as now.

The format gets smaller, not larger: one enum of plan ids replaces the actor lists for planned steps.

### The wildcard

One move stays on today's freer scaffold, so chains don't all read alike.

## Build order

1. **Derived v1** (now): momentum, rule use, pace. Load the log into the graph with who rolled what and how it went; derive with fades; show the values in profiles and the moves block; weight moves by pace and momentum. Crafted checks. *No model calls needed.*
2. **Event tags on direct changes:** when a used option or step applies directly, also record what kind of event it was (fight, help, theft, threat, against whom), from its move and cast, so disposition drift and faction alert have something to read.
3. **Payload index:** each move lists its payload candidates (`payloadsFor(move)`), drawn from the table above, with ids and a "spent" flag. Spent means used this session, so the same reveal isn't made twice.
4. **Beat plans in Develop:** the engine plans each step from the move's payloads; the format takes plan ids; one sentence per plan. Behind a flag.
5. **Measure:** the blind 8 × 3 set on Haiku, with and without plans, plus Sonnet with plans. Track how many chains are usable, how many are thin, how varied the payloads are, and time and cost. If Haiku gets near Sonnet, Develop can go back to Quick.
6. **Improv:** the same planning for improv options (a single beat each), if 5 shows the gain.
7. **Derived v2:** disposition drift, faction alert, thread pressure, familiar places, and mood drift.
