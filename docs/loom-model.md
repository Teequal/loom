# The Loom model: layers, hierarchy and laws

*Draft v2, 24 Oct 2026, for discussion before building. It extends [entity-model.md](entity-model.md) (the attribute catalogue), which still applies inside layers L1 and L2.*

Loom is a network: entities, the links between them, the rules those links obey, and the threads that run through them. Suggestions are only as good as what that network encodes.

- The scaffold already enforces what the data knows (people and places).
- Where the data is thin, the model guesses: the Figurine madness roll handed to Iresia is the example.
- This document makes the network complete enough that the right suggestion is the easy one, and the wrong one can't be written.

## 1. The layers

| Layer | Holds | Changes | Checked by |
|---|---|---|---|
| **L0 Rules** | 5e rules (conditions, rests, death…), the DM's toggles, house rules | Rarely | Code: capabilities and laws |
| **L1 Identity** | Who and what exists, and what they're like | Slowly | Validation of types and values |
| **L2 State** | Where things are, who holds what, health, conditions, attitude | Every session | Laws from L0 and L3 |
| **L3 Relationships and laws** | Typed links between entities, each with rules (cardinality, exclusivity, applies-to) | Often | Code, on write and at generation |
| **L4 Narrative** | Threads, key moments, arcs | Every session | Recap approval |
| **L5 Moment** | The scene now: what just happened | Every call | The scaffold |
| **P Players** | The real people: preferences, boundaries, spotlight | Occasionally | DM only, never in output |

Each layer has its own update path (recap extraction, manual entry, rules), its own provenance (manual wins), and its own place in prompts.

## 2. Hierarchy and inheritance

Children inherit from parents unless they override. **The most specific value wins.**

- **Places:** Eldoria › Duradan › Merchant district › Tannery. Being "in Duradan" includes everything inside it. *(Exists.)*
- **Items:** a set and its instances. Figurine set › Knight figurine (visions of futures, held by Khayiulad) and Monk figurine (senses souls, held by Salaena). *Figurine madness* lives on the set, so both inherit it.
- **Factions:** organisation › cell › members. A cell inherits its parent's enemies unless it says otherwise.
- **Creatures:** a kind and its individuals. Marked guards (mind-controlled, strange markings) › the exceptional fighter. Walk-ons can be "a marked guard" and inherit the kind's traits.
- **Rules:** 5e default › DM toggle › house rule › an exception for one entity.
- **Time:** campaign › arc › session › scene › moment. Threads and key moments attach at the right level (an arc-level mystery, a session-level grudge).

## 3. L0 Rules

### 3a. 5e conditions as capabilities
Every condition (SRD 5.1, Creative Commons) becomes a set of **capabilities** the code can check. The same check works for status (dead, captured) and health (unconscious).

| Condition | Can act | Can move | Can speak | Perceives | Other laws Loom enforces |
|---|---|---|---|---|---|
| Blinded | yes | yes | yes | no sight | can't be asked what it sees |
| Charmed | yes | yes | yes | yes | can't attack or harm the charmer; the charmer has the upper hand socially |
| Deafened | yes | yes | yes | no hearing | can't hear a warning shout |
| Frightened | yes | not closer to the source | yes | yes | |
| Grappled | yes | no | yes | yes | |
| Incapacitated | **no** | yes | yes | yes | no actions or reactions |
| Invisible | yes | yes | yes | yes | can't be seen without magic |
| Paralyzed | **no** | no | **no** | yes | |
| Petrified | **no** | no | no | **no** | turned to stone, unaware |
| Poisoned | yes | yes | yes | yes | |
| Prone | yes | crawl | yes | yes | |
| Restrained | yes | no | yes | yes | |
| Stunned | **no** | no | falteringly | yes | |
| Unconscious | **no** | no | **no** | **no** | drops what it's holding, falls prone |
| Exhaustion 1–6 | mostly | 5+: no | yes | yes | level 6 is death (depends on edition) |

Status adds the rest: dead (no anything; can be remembered, found or raised), captured (acts only within captivity, or escapes as an arrival), missing (reappears as an arrival).

### 3b. DM toggles
These are only the variants that change *story*, not dice maths:

| Toggle | Options |
|---|---|
| Rules edition | 2014 / 2024 (exhaustion and some conditions differ) |
| Resting | standard / gritty realism (week-long long rests) / heroic |
| Death | standard / lingering injuries / harsh (no easy revival) / no permanent death |
| Death saves | public / secret |
| Madness | off / short-, long- and indefinite-term tables (DMG) / sanity score |
| Healing potions | action / bonus action |
| Inspiration | standard / hero points / off |
| Encumbrance | off / standard / variant (gear matters) |
| Alignment | ignored / descriptive / enforced (paladin oaths, magic items) |
| Lethality | forgiving / standard / deadly |
| Magic availability | rare / standard / common (can the party just buy a cure?) |

### 3c. House rules, structured
Free text doesn't work, so every house rule (including each effect an item or place carries) uses one shape:

| Part | Meaning | Figurine madness | Microfractures |
|---|---|---|---|
| source | What carries it | Figurine set (inherited by both) | Microfracture zones (locations) / the thread |
| trigger | When it fires | on use | on exposure |
| applies to | Who it affects | user | everyone present |
| check | The roll | madness roll | resist roll |
| on fail | What happens | madness effect (GM rolls) | effect, rolled secretly by the GM |
| escalation | Grows over time? | harder to part with, per use | — |
| duration | How long | until cured | per effect |
| secret | GM-only? | no | yes |

"Applies to" options: holder · user · everyone except the holder · everyone present · the whole party · a named list · whoever the source targets.

**Entry is easy:** the DM describes the rule in plain words, Loom drafts the structured version, and the DM confirms or edits it. The same flow lets recap extraction propose rules it spots in notes.

## 4. L3 Laws on relationships

| Relation | Law |
|---|---|
| holds | one holder per item (unless the item is marked shared); a new holder replaces the old one (extraction proposes the change) |
| located_at / lives_at | one place at a time |
| leads | one leader per faction (unless shared leadership) |
| member_of, knows_about, wants, fears… | many allowed |
| family, romance, ally, enemy, rivals | symmetric (one implies the other) |

The laws apply **on write** (data can't contradict itself) and **at generation**. Scaffold slots built from links:

- `[possession(Monk figurine)] + Iresia`: fine. Possession can change hands; it becomes a hand-over the DM sees.
- `[use(Monk figurine)] + Iresia`: only if Iresia holds it, or the beat hands it over first.
- `[effect(Figurine madness)] + Iresia`: only if the effect's "applies to" reaches her. The roll slot only offers effects that have a valid target in the scene, and code checks the target.

## 5. L4 Narrative and history

- **Change log, automatic and invisible:** every state change is recorded with its session (who held what when, who was where). Cheap, and it makes "as of session 3" answerable and contradictions detectable.
- **Key moments, curated:** the DM flags a moment as key (in the web UI: a star on an improv option they used, or on a recap line). Recap extraction can *suggest* key moments to flag. Each records: session, what happened, the entities and threads involved, a tone (comedic / heroic / tragic / eerie) and its callback potential.
- **Callbacks** draw only on key moments, so suggestions reference what mattered, not trivia.
- **Arcs** group threads and moments ("Darkness in Duradan" › "The Whispering Woods").

## 6. P Players

| Field | Use |
|---|---|
| Player handle | Who plays which character (no surnames needed) |
| Enjoys | Weights across combat · social · exploration · mystery · comedy · drama |
| Personal lines | Their own boundaries, on top of the table's safety lines |
| Spotlight log | When they last had a moment (derived from key moments and improv options used) |
| What lands | Key moments they loved |
| Table notes | Real-world sensitivities the DM wants respected (e.g. a couple at the table) |

Players are never named in options and never leave the DM's view. They steer *which* suggestions rank first: the quiet player who loves mysteries gets the mystery hook.

## 7. Context assembly: levels of detail and depth

What goes into a prompt depends on how far an entity is from the moment in the graph:

| Distance | Detail |
|---|---|
| In the moment (named, or the party's location) | Full card: identity, state, active effects with who they apply to, relationships |
| 1 link away (linked thread, holder, relationship) | Brief: 2–3 lines |
| 2 links away | Name and role only |
| Further | Left out |

**Per-feature budgets:**
- improv: depth 2, around 2–3k tokens.
- suggest: depth 3, larger.
- flavour: full cards for tagged entities only.

Embeddings (later) find entry points by meaning; links decide how far to spread.

## 8. Build order (proposal)

1. **L0 core:** conditions as capabilities, toggles, the structured house-rule shape (plus the plain-words drafting flow), effects attached to sources with "applies to". Split the figurines. Scaffold checks use capabilities and "applies to".
2. **L3 laws:** cardinality and symmetry on write and at generation; possession and use checks.
3. **L4:** an automatic change log and key moments (CLI flag now, a star in the UI later); callbacks in suggest.
4. **P:** the player layer, and spotlight-aware ranking in suggest and improv.
5. **Context assembly:** detail by link distance, with per-feature budgets.
6. **Embeddings** as entry points.
7. **Stress tests** at each step, plus a blind rerun at the end.
