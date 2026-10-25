# Design: Loom's world model (25 Oct 2026)

**Jacob's brief:**
- Every entity is an object in code, with typed properties: numbers with ranges (a mood), lists (children), and nested groups where depth is needed.
- Everything is tagged so the engine can calculate with it.
- Threads are objects too.
- A connection between a thread and a character is one thing, not copied onto both.
- The engine builds each suggestion's scaffold by coded rules, from information that passes its checks. The checks get deeper, so prompt rules that cause false positives can go.

**Principle:** code decides what is true and what can happen. The model's pass is second: words, flavour, context.

## 1. Why

Phases A and B made the engine work out more from the records. But the records are thin: entities are rows with a loose bag of strings, and a thread's link to a character has no role. So the engine has been reasoning over text: the model's prose, checked with word patterns. Each slip was the engine not knowing something it should have known structurally (the Knight figurine is lost in the Morrow; Bram is an object in "slams Bram hard"). Every new pattern risks new false positives.

The fix is a world model: typed objects connected by typed links, which the engine reads and calculates from.

## 2. The shape: a property graph

- **Nodes:** characters (PC/NPC), items, places, factions, threads, key moments, house rules, sessions. Each is a typed object with nested properties.
- **Links:** one object per connection, with a type, a role and its own properties. A link is read from either end. Bram's threads and a thread's characters are the same links, never two copies.
- **Tags:** every property carries metadata (who recorded it, whether players know it, since when) and engine tags (which questions it answers), so the engine knows how to use it.
- **Derived state:** computed, never stored. Who's here, who can act, who has what, which rules fire, how ripe a thread is. It's a function of the graph, the moment and the GM's corrections.

**In code:** plain typed objects, one Zod schema per node type (nesting, ranges and enums, validated), plus one link table. For each campaign the engine builds a graph index in memory: nodes by id, and links by either end. A campaign has hundreds of objects at most, so this is instant. Plain data plus engine functions fits better than class hierarchies, because one object is read from many directions.

## 3. Nodes

Every node shares a base:

```ts
Node {
  id, campaignId, kind: "character" | "item" | "place" | "faction" | "thread" | "moment" | "rule" | "session"
  name, aliases[], summary            // what a person reads
  status                              // a per-kind enum
  notes                               // free text the DM keeps (never read as a fact)
  meta: { [path]: FieldMeta }         // tags for every property (section 5)
}
```

### Character (PC and NPC)

```ts
Character extends Node {
  side: "pc" | "npc"
  playedBy?: PlayerRef                     // PCs; real names never reach a prompt
  identity: { race?, occupation?, level?: 1..20, age?: "child"|"young"|"adult"|"old"|"ancient", gender?, appearance: string[], voice? }
  body: {
    health: "healthy"|"wounded"|"bloodied"|"critical"|"unconscious"|"dead"
    conditions: { name: Condition5e | string, source?: Ref, until?: "end of scene"|"long rest"|"cured"|SessionRef }[]
    form?: { name: string, until?: string }  // Dahlia as an alley cat
  }
  mind: {
    mood: -3..+3                           // calm/bad day → elated; read for tone and how they react
    goals: { text, priority: 1..3, thread?: ThreadRef }[]
    wants: string[], fears: string[], flaws: string[]
    beliefs: { text, true?: boolean }[]    // "believes he can't die" (true: false)
  }
  abilities: { name, uses?: { per: "rest"|"day"|"session", max: number, left: number }, effect? }[]
  // Social ties, location and possession are LINKS, not properties here.
  capabilities: derived                    // from body: can act / move / speak / perceive (5e)
}
```

Example, Bram from the sample campaign:

```json
{ "kind": "character", "side": "pc", "name": "Bram",
  "body": { "health": "healthy", "conditions": [] },
  "mind": { "mood": 2, "beliefs": [{ "text": "he can't die", "true": false }],
            "goals": [{ "text": "prove he's invincible", "priority": 1, "thread": "T1" }] },
  "abilities": [] }
```

### Item

```ts
Item extends Node {
  status: "intact" | "used" | "broken" | "lost" | "destroyed"
  properties: { known?: string, true?: string /* GM */, cost?: string }
  uses?: { max?: number, left?: number }   // charges
  portable: boolean                        // a statue isn't carried
  sharedPossession: boolean                // several can hold it at once
  // Holder, place, set membership and rules come from LINKS.
}
```

### Place

```ts
Place extends Node {
  status: "intact" | "destroyed" | "occupied" | "abandoned"
  scale: "region" | "settlement" | "district" | "building" | "room" | "site"   // so "in Duradan" ≠ "in the tavern"
  hazards: { text, rule?: RuleRef }[]
  atmosphere: string[]
}
```

### Faction

```ts
Faction extends Node {
  status: "active" | "disbanded" | "destroyed"
  goal?, plan?, clock?: { filled: number, of: number }
  stance: -3..+3                           // towards the party
}
```

### Thread

```ts
Thread extends Node {
  threadKind: "hook" | "condition" | "promise" | "mystery" | "grudge" | "item" | "other"
  status: "open" | "building" | "ripe" | "resolved"     // building/ripe are derived from heat, or set by the DM
  stakes: { level: 1..5, if_ignored?: string }
  deadline?: { text, session?: number }
  steps: { session, change: "new"|"progressed"|"resolved", note }[]   // from thread_events
  payoffs: string[]
  secret: boolean
  heat: derived                             // recency, stakes, deadline, how often touched
  // Who and what it's about are LINKS with roles (section 4).
}
```

Example, the sample campaign's potion thread:

```json
{ "kind": "thread", "name": "Bram believes he can't die", "threadKind": "condition",
  "stakes": { "level": 3, "if_ignored": "he gets himself killed" },
  "links": [ { "to": "Bram", "role": "subject" }, { "to": "Mother Ysolde", "role": "cause" },
             { "to": "Kira's cure", "role": "key" } ] }
```

### Key moment, house rule, session

- **Key moment:** title, tone, callback idea, session, star state. Who and what it involved are links.
- **House rule:** what it does (trigger, check, on fail or success, escalation, duration, plain words). Its source and who it applies to are links.
- **Session:** number, date, notes. The change log points at sessions.

## 4. Links

One table and one object per connection:

```ts
Link {
  id, campaignId
  from: { kind, id }, to: { kind, id }      // any node to any node
  type: LinkType                            // from the catalogue below
  role?: string                             // for thread and moment participation
  strength?: -3..+3
  since?: SessionRef, until?: SessionRef    // history: "enemies until session 4"
  secret: boolean
  note?: string
  meta: FieldMeta                           // who recorded it
}
```

**Catalogue.** Every type declares its laws once: what it can connect, cardinality, whether it's two-way, opposites, and what it tells the engine.

| Group | Types | Laws and engine use |
|---|---|---|
| Ties | ally, enemy, rivals, family, romance, loves/hates, trusts/distrusts, serves, owes, promised, hunts | two-way where natural; opposites replace each other; read for attitude, arrivals ("hunts"), and who'd come |
| Where | located_at, lives_at, inside (place in place, item in set) | one place per character; "inside" is the hierarchy; read for presence |
| Possession | holds, made, controls | one holder unless shared; lost ⇒ no holder; read for who can use what |
| Membership | member_of, leads | one leader; a faction is present through its members |
| Thread participation | subject, cause, victim, holder, seeker, key, obstacle, witness, beneficiary, place | a thread's roles; read to find moves (the cure is the "key" held by another PC ⇒ a collision) |
| Thread to thread | causes, blocks, mirrors, pays off | read for collisions and payoffs |
| Rules | source_of, applies_to | where a rule comes from, and who it reaches |
| Moments | involved, at | read for callbacks |

This is the answer to "a thread belongs to a character, and the character to the thread". It's one link (Bram, *subject*, the thread). The engine asks either end of it: Bram's threads, the thread's subjects. Today's thread links (a bare thread–character pair), relationship rows, thread-to-thread links and rule sources all become rows of this one table.

## 5. Tags

Every property and link carries `FieldMeta`:

```ts
FieldMeta {
  source: "dm" | "extracted"; session?; confidence?: "stated" | "implied"   // "implied" for things the notes only suggest
  known: "players" | "gm"                    // GM-only shapes outcomes, never stated outright
  reads: EngineQuestion[]                    // which engine questions use it
}
EngineQuestion = "presence" | "agency" | "possession" | "rules" | "mood" | "spotlight" | "payoff" | "knowledge"
```

The `reads` tags come from the schema, not from each record. For example, `body.health` and `body.conditions` answer *agency*; `located_at` answers *presence*; `holds` answers *possession*; `mind.mood` answers *mood*; thread participation answers *payoff*. The engine's questions are generic functions over the tagged properties. Adding a property with a tag makes the engine use it, without writing a new check.

The existing rules carry over: what you enter always wins, extraction proposes rather than overwriting, a blank beats a guess, and everything is logged and undoable.

## 6. Derived state: the engine's questions

Pure functions of (graph, moment, corrections). This replaces today's scene model and profiles.

- **presence(x):** here / reachable / remembered / player, with the reason. From links (located_at against the party's place and its scale, holds, member_of), status, and the moment.
- **capabilities(character):** act, move, speak, perceive. From body (5e conditions, health, form).
- **holder(item) / holdings(character):** from holds, the set hierarchy and status, plus what the moment changes.
- **liveRules():** rules whose trigger fired, and who they reach.
- **heat(thread), ripe(thread):** from steps, stakes, deadline and recency.
- **stance(a, b):** from ties, strength and mood.
- **knows(character, fact):** from knowledge links (later).

**The moment** is read by code into **provisional changes** to the graph: "Tomas is here", "Khayiulad holds the Knight figurine", "Iresia is unconscious". They apply to this call only, and wrap-up confirms them. Your chip corrections are changes of the same kind. So the moment, your corrections and the records are one thing, the graph, not three.

## 7. How a suggestion is built

**Step 1: the engine plans.** It finds candidate moves from patterns in the graph, scores them, and fills in each move's plan:

```json
{ "move": "collision",
  "threads": ["Bram believes he can't die", "Kira cannot speak"],
  "because": "Both conditions came from Mother Ysolde's potions, and each cure is with the other PC",
  "place": "Thornbridge market",
  "handTo": ["Kira"],
  "cast": [ { "who": "Mother Ysolde", "can": ["arrive", "send word"] },
            { "who": "a market crowd", "can": ["act"] } ],
  "objects": [ { "what": "Kira's cure", "holder": "Bram", "can": ["be noticed", "be used by Bram"] } ],
  "roll": { "kind": "notice", "skill": "Perception", "to": "table" } }
```

**Step 2: the model writes only words, into slots.** The answer format is generated from the plan:
- Each sentence's **actor** is chosen from the plan's cast, with only the verbs-of-kind their permissions allow (act, arrive, send word).
- **References** (`{1}`, `{2}`) come only from the plan's objects and cast.
- A PC appears only as a reference, or in a **"what happens to them" sentence** built from parts: who, a body part, and a sensation from a list.
- The hand-off and roll come from the plan, worded by code (as now).
- The model writes the verb phrases, the title and the wording of "why". Code writes every name, with the right article and possessive.

**Step 3: checks against the plan and the world.** Deeper and simpler:
- Every reference is in the plan, and does only what its permissions allow.
- No known name appears in free text, outside a slot. This one check replaces most of the word patterns: PCs mid-sentence, lost items warming, absent NPCs acting.
- The title uses only the plan's references.
- The roll matches the plan and the 5e roll table.

**Rendered,** for example: "A flustered fruit seller holds up a vial and squints at the faded label. Ask the table: everyone makes a Wisdom (Perception) check to notice whose name is on it."

## 8. What goes away

- **Prompt lines that police words:** "never write a PC doing…", "PCs never act inside another beat's sentence", "no swaying, bracing…", "absent NPCs only arrive", "never 'a walk-on'". The format makes these impossible, so the prompt can say what to write, not what to avoid. That's where most false positives start.
- **Text patterns:** acting-name lists, the pronoun and posed-limb checks, the possession word patterns, the PC-body list, the interim reading rules for presence. These are replaced by plan references and the one free-text law.
- **What stays:** safety lines (a meaning check), the moment reader (code, with its rule table), and a few narrow text checks with tests (an unclear "he/she" opening a sentence).

## 9. Storage and migration

- **Nodes:** today's `entities` and `threads` (and moments, rules) map onto typed nodes. Fields that are columns today stay columns. The traits bag becomes typed nested groups, validated per kind.
- **Links:** one `links` table replaces `entity_relations`, `thread_entities`, `thread_links` and the rule-source columns. The endpoint kinds allow any node to any node. Thread participation gets a role (existing links start as "involved", and extraction proposes the real role).
- **History:** the change log already records every write; it records node and link changes the same way. Undo keeps working.
- **Extraction:** recaps propose node and link changes with roles and evidence, through the same tiered review. Manual entry gets typed fields on the inspector and campaign page: a mood dial, condition chips, a holder picker. Manual and extracted stay equal citizens.

## 10. Stages

Each stage runs on its own, is measured, and is committed once it passes.

**Stage 1: types and the graph, read from today's tables (no storage change).**
- Zod schemas per node kind, the link catalogue with its laws, FieldMeta with engine tags.
- `loadGraph(campaignId)` builds typed nodes and links from the current tables (a read adapter), with the graph index.
- Tests: Duradan and the sample campaign load with zero schema errors; every relationship, thread link and holder appears exactly once as a link; a report of the properties each campaign has filled versus empty.

**Stage 2: the engine's questions on the graph.**
- presence, capabilities, holdings, live rules, heat and stance as pure functions. They replace the scene model's internals and the profiles. The scene prompt is built from them.
- Tests: the current crafted checks, the reading rules, and invariants on generated scenes (no remembered thing in a hand, no absent actor). Rejections per call measured on the 16-call sample.

**Stage 3: plans and slots for improv.**
- The move finder and plans, the slot format, code rendering, and checks against the plan. The word-policing prompt lines and patterns are retired.
- **Measured:** rejections per call (target below 0.2), options shown, speed (first option ~3 s), a Duradan rerun of every fault from blind run 4, then a blind run for your ticks.

**Stage 4: storage, extraction and editing.**
- Migrate to node and link tables, with a database backup first. Extraction proposes typed changes and link roles. Typed editing in the inspector.
- Tests: an undo round trip, the review tiers, and a recap on the sample campaign.

**Stage 5: plans for Develop, fights and prep ideas,** which retires the remaining prose checks.

## 11. Decisions for Jacob

1. **Mood:** −3 to +3 per character (and stance per faction), shown as a dial. Should mood change only by the DM, or can extraction propose it from the notes ("furious after the betrayal")?
2. **Thread roles:** is the role list in section 4 (subject, cause, victim, holder, seeker, key, obstacle, witness, beneficiary, place) the right vocabulary, or are there roles you think in that are missing?
3. **Free notes:** keep a free-text notes field on every node for the DM (never read as facts), alongside the typed properties?
4. **Stage 4 timing:** migrate storage straight after Stage 3 proves out, or keep reading through the adapter until the web editing is designed?

**About the uncommitted Phase B work:** profiles, the role law and the body allowlist all pass every test, and they're a working bridge. Stage 2 replaces them. They can be committed as a checkpoint, or left out.
