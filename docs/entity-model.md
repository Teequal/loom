# Entity model: the skeleton

*Draft, 23 Oct 2026. Design for review, not built yet.*

Structured data is the skeleton that keeps continuity. Embeddings are the intuition that finds relevance by meaning (see the end of this doc). Each makes the other better: richer entities produce richer text to embed.

## Principles

1. **Manual and extracted are equal citizens.** A DM can type any field by hand, or let Loom fill it from recaps. Both land in the same place.
2. **Manual wins.** Every field remembers its source (`dm` or `extracted`, plus the session). Extraction never overwrites a DM-entered value; it proposes a change for the DM to accept.
3. **Blanks are fine. Guesses are not.** Extraction leaves a field empty unless the notes say it. When it's unsure, it asks a clarifying question (backlog 1).
4. **Secrets are a property, not a separate place.** Any field or relationship can be marked GM-only. Prompts use secrets to shape outcomes but never let characters "learn" them for free.
5. **Tiered display.** Every field can be stored, but the UI shows tier 1 first and folds the rest away. The DM gets to the magic fast; the depth is there for those who want it.

Tiers, used throughout:
- **T1, continuity:** the code checks it, so it prevents slips (e.g. dead NPCs acting, NPCs in the wrong place).
- **T2, story fuel:** feeds suggestions and collisions.
- **T3, flavour:** voice and colour.

## Characters (PCs and NPCs)

| Field | Tier | Notes |
|---|---|---|
| Name, aliases | T1 | Already exists. Aliases include nicknames ("the potion guy"), titles, spelling variants. |
| Status | T1 | alive / dead / missing / captured / transformed / unknown. Stops Gary turning up for a drink. |
| Last known location | T1 | Where the party last saw them. |
| Actual location | T1, often secret | Where they really are. |
| Attitude to the party | T1 | hostile / unfriendly / indifferent / friendly / helpful (the 5e DMG scale). |
| Current goal / activity | T2 | What they're doing right now, off-screen. |
| Wants, fears | T2 | Motivations drive believable reactions. |
| Ideals, bonds, flaws | T2 | The 5e personality structure; useful for PCs and major NPCs. |
| Secrets they hold | T2, secret | "Knows where Vex went." This answers "who would know X?" at the table. |
| Knowledge / rumours | T2 | What they'd tell the party if asked. |
| Faction, rank / title | T2 | Also stored as relationships (below). |
| Alignment | T2 | The 9-grid (lawful good … chaotic evil), plus "unaligned". |
| Race / species, class / occupation | T3 | Tiefling Warlock, Dragonborn Wizard, merchant, guard. |
| Age or age band | T3 | Child / young / adult / old / ancient. Bhen's age matters; most don't. |
| Gender / pronouns | T3 | |
| Appearance descriptors | T3 | 2–3 words: "scarred, tall, nervous". |
| Voice / mannerisms | T3 | DMs love this: "speaks in riddles", "taps his cane". |
| Importance | T2 | major / minor / walk-on. Weights retrieval. |
| Power | T3 | Rough level or CR, notable abilities. |
| First / last appeared | T1 | Session numbers (derived automatically). |

**PC-only:**

| Field | Tier | Notes |
|---|---|---|
| Player name | T1 | Lets options say "ask Sam…". |
| Class and level | T2 | |
| Backstory hooks | T2 | Khayiulad's heresy is a backstory hook that became a thread. |
| Personal goal | T2 | |
| Notable items carried | T2 | Stored as relationships ("holds Knight figurine"). |
| Party role | T3 | Face, tank, healer… ("the usual talker" mattered for Kira). |

## Locations

| Field | Tier | Notes |
|---|---|---|
| Type | T2 | city / district / building / dungeon / wilderness / plane… |
| Parent location | T1 | Builds a hierarchy (Duradan › Merchant district › Tannery outpost), so "in Duradan" includes everything inside it. |
| State | T1 | intact / destroyed / occupied / abandoned. The outpost was destroyed. |
| Controlled by | T2 | A faction. Stored as a relationship. |
| Hazards and effects | T2 | The ghostly butterflies were a location effect; this is where that lives. |
| Atmosphere descriptors | T3 | 2–3 words. |
| Secrets | T2, secret | |
| Travel links | T3 | "Duradan ↔ Whispering Woods: a day's walk". |

## Items

| Field | Tier | Notes |
|---|---|---|
| Holder | T1 | Who has it now. Stored as a relationship. |
| Known properties | T2 | What the party believes it does. |
| True properties | T2, secret | What it really does. |
| Cost / side effects | T2 | The figurine madness roll lives here, the price of power. |
| Origin / maker | T2 | Arlen Hoder made the figurines. |
| Rarity, attunement, charges | T3 | |
| State | T1 | intact / used / broken / lost. |

## Factions

| Field | Tier | Notes |
|---|---|---|
| Goal | T2 | |
| Leader, members | T2 | Stored as relationships. |
| Territory | T2 | Locations they control. |
| Attitude to the party | T1 | Same 5-point scale as characters. |
| Current plan and progress | T2 | A "clock": what they're doing between sessions and how close they are. It powers "the world moves while the party dawdles" suggestions. |
| Allies, rivals | T2 | Stored as relationships. |
| Secrets | T2, secret | |

## Relationships (entity ↔ entity)

Each relationship has a type from a fixed list, a free-text note for context, a strength from -3 to +3, a secret flag, and the session it started. The fixed type is something code can use; the note carries the nuance.

| Group | Types |
|---|---|
| Feelings | loves / cherishes, likes, trusts, distrusts, dislikes, hates, fears, rivals |
| Ties | family, romance, ally, enemy, serves / employed by, leads, member of |
| Obligations | owes, is owed by, promised, hunts / seeks |
| Possession | holds / owns, made, wants |
| Knowledge | knows about, knows the secret of |
| Place | lives at, controls, located at |

Examples:
- *Varek — hunts → Khayiulad* (note: "heresy bounty, 1000 gp alive")
- *Arlen Hoder — made → Figurines*
- *Salaena — distrusts → Darius*, strength -2, since session 4

## Threads (additions)

| Field | Tier | Notes |
|---|---|---|
| Deadline / clock | T1 | "As the Moons align, the veil thins." Time pressure is the strongest story fuel there is. |
| Stakes | T2 | What happens if the thread is ignored. |
| Secret flag | T1 | Currently written as "DM secret:" inside the text; becomes a proper field. |

## Campaign

| Field | Tier | Notes |
|---|---|---|
| Party location | T1 | The root of the Zara slip: without it, NPC locations can't be checked. |
| In-game date / time | T2 | Feeds deadlines. |
| Tone | T2 | comedic / heroic / grim / horror, to help "match the energy". |
| House rules and mechanics | T2 | Jacob's hidden rolls: a madness roll per figurine use; resist-then-effect for microfractures. Suggestions that use them land best. |
| Safety lines | T1 | Topics the table avoids (common practice with session-zero "lines and veils"). Loom must respect them. |

## Embeddings: the intuition layer

Structured fields answer exact questions: *is Zara alive, and where is she?* Embeddings answer fuzzy ones: *what does this moment feel like it's about?* Examples:
- "the bird lady" finds an NPC nobody named,
- "they want to skip town" finds travel and deadline threads,
- "betrayal" finds grudges and distrust.

**What to embed:** each thread together with its history, each entity as a "card" built from its fields and relationships, and session recaps split into scenes, so Loom can make callbacks ("remember the old man you knocked down?"). Richer entities give richer cards, and richer cards give better matches. This is how the two layers reinforce each other.

**How retrieval would work (hybrid):** today's structured score (names, links, recency), plus semantic similarity, plus a boost for entities in the current location. Every change gets measured with the scenario runner's retrieval-recall numbers. It already shows two misses in 10 moments, both on moments with no names in them, which is exactly where embeddings help.

**Where vectors live:** libSQL (our database) has built-in vector columns and similarity search, so no new service is needed.

**Which embedding model:** Anthropic doesn't make one. Options:
- a small local model that runs inside the app: free, private, works offline,
- a hosted one (Voyage AI, OpenAI): stronger, a fraction of a cent per campaign.

It sits behind the same kind of swappable interface as the LLM, so we can test both on the scenarios and pick.

## Build order (proposal)

1. **Schema + provenance:**
   - the new character/location/item/faction fields as typed columns (T1) plus a flexible traits field (T2/T3),
   - the relationships table,
   - campaign fields,
   - a `source` on every value.
2. **Manual entry:** `entity show` / `entity set` commands now; a proper edit card when the web page arrives.
3. **Extraction:** recaps propose entity and relationship changes in the normal approve flow (never overwriting DM entries), plus a one-off backfill of Duradan.
4. **Entity cards in prompts** for entities in play, the party's location, and slip checks in code (dead or elsewhere NPCs can't act).
5. **Embeddings:** hybrid retrieval, measured against today's numbers.
6. **Test** on the known slips and rerun the blind scenarios.
