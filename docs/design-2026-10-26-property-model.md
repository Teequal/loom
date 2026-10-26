# Design: the property model (sub-properties, properties and interplays)

26 Oct 2026. Status: **design, for Jacob's review.** Nothing here is built yet.

## 1. What this is for

Jacob's direction, in his words:

> the scaffold should be able to pull in a property of the typed object that is a thing or person etc and that property will be a product of many sub properties. Each sub property can be affected with the story, extractions from notes, table choices etc and those sub properties can also be pulled individually. And the relationship between two properties should also be able to be pulled in a scaffold.

> if their goals had a weighting of negative intent and positive intent and they weighted heavily negative and they have a state "charmed" perhaps they are a little more resistant. Or perhaps if they have negative intended goals but are friendly with the party ie a relation type property weighting then they are morally conflicted and may even do things that go against their goals in cases.

This continues the line that has worked best so far: the engine decides, and the model phrases. Today the engine knows *who* is where and *which* thread is in play. This gives it a model of *what someone is like and how they stand*, built from small, sourced parts. From that it can work out things no single field says, such as being torn, straining against a charm, or loyal in name only. Every one of those is something a scaffold can use, a move can be built from, a check can respect, and a beat plan can deliver.

**What it should make possible**, as one example per layer:
- the scaffold can use one sub-property on its own: "Vex'ahlia's top goal is harmful (−2)";
- a property built from many: "Vex'ahlia's resolve is iron";
- a relationship between properties: "Vex'ahlia is straining against the charm, because her resolve is iron and the charm works against her top goal";
- a relationship across two characters: "Kira trusts Ysolde more than Ysolde trusts Kira".

## 2. Three layers

| Layer | What it is | Stored? | Example |
|---|---|---|---|
| **Sub-property** | one small, typed value on a thing, person, place, faction, thread or relationship; it has a source, a history, and can be changed on its own | yes (or derived from the log) | a goal's *intent* (−2); Ysolde's *warmth* toward Kira (+1); *charmed by Iresia* |
| **Property** | a value **made from sub-properties** by a fixed formula; never stored, always worked out | no | *intent* (all goals, weighted by priority); *resolve*; *standing with the party* |
| **Interplay** | a named **relationship between properties or sub-properties**: a *tension* (they pull against each other) or an *alignment* (they reinforce each other) | no | *conflicted* (harmful intent, warm to the party); *resists the charm*; *devoted* |

All three can be **addressed** and **explained**:
- **Addressed:** each has a stable path, so a scaffold, a move or a check can name exactly what it uses (section 7).
- **Explained:** each carries a short *because*, built from the parts behind it ("resolve iron: committed to her goal (3), confident (+1), unhurt").

This replaces "derived state v1" as the general idea. What was built this morning fits as sub-properties derived from the log: momentum, rule use, pace, and NPC activity.

## 3. Principles

1. **The DM stays in charge.** A DM value always wins. Extraction and table events propose or nudge, and only within limits. Every value says where it came from, and every change can be undone.
2. **Blanks beat guesses.** A sub-property no one has set is *unknown*, not zero. A property made from unknowns is unknown, or says how much of it is known. An interplay never fires on unknowns.
3. **Small and typed.** Every sub-property has a fixed name, range and meaning, set in a registry in code (section 4). Free text stays description; it never drives the engine.
4. **Formulas are data, and tested.** Properties and interplays are rows in a table, each with worked examples that run as tests, like the moment-reading rules (`READING_RULES`). Adding one is a row, not new engine code.
5. **Interplays suggest; they don't decide.** They make some moves likelier, loosen or tighten what an NPC may be written doing, and offer hand-offs. The DM picks.
6. **Players control their characters.** PCs have sub-properties too (mood, goals, bonds, beliefs, momentum), but an interplay on a PC never writes what the PC does. It only shapes what the world offers: a temptation, a spotlight, a sensation, a question.
7. **GM secrets stay secret.** A sub-property can be GM-only (a hidden goal, a secret loyalty). It shapes suggestions, but it's never stated, the same rule as today.
8. **Cheap and fast.** Everything is computed in code from the loaded graph, once per moment, and cached. No model call is needed to work anything out.

## 4. The registry: which sub-properties exist

Each entry has a **path**, a **type and range**, a **meaning**, and **who can set it**:
- **DM:** typed by hand.
- **Extraction:** proposed from notes, with a quote as evidence.
- **Table:** nudged by what happens at the table (section 8).
- **Inferred:** a one-off suggestion, for filling in old data.
- **Log-derived:** computed, never stored.

Ranges use the existing scale where one exists (−3 … +3, as for mood, stance and tie strength).

### 4.1 Characters (PCs and NPCs)

**Mind**

| Path | Range | Meaning | Set by |
|---|---|---|---|
| `mind.goals[g].text` | text | the goal, in the DM's words | DM, extraction |
| `mind.goals[g].priority` | 1–3 | how high it ranks (1 is top), as now | DM, extraction |
| `mind.goals[g].intent` | −3 … +3 | **who it's good for**: −3 harms others, 0 self-serving or neutral, +3 helps others | DM, extraction, inferred |
| `mind.goals[g].commitment` | 0–3 | how hard they'll push for it | DM, extraction, inferred; table (thwarted or advanced) |
| `mind.goals[g].target` | link to a node, optional | whom or what it's about ("ruin the Resistance") | DM, extraction |
| `mind.goals[g].status` | active · achieved · abandoned · blocked | where it stands | DM, extraction, table (a thread resolving) |
| `mind.goals[g].secret` | yes/no | GM-only | DM |
| `mind.beliefs[b].text`, `.true` | text, yes/no/unknown | as now ("he can't die", untrue) | DM, extraction |
| `mind.beliefs[b].conviction` | 1–3 | how firmly held | DM, extraction, inferred |
| `mind.mood` | −3 … +3 | the recorded mood, as now | DM, extraction; table (a slow drift, section 8.4) |
| `mind.values.compassion` | −3 … +3 | cruel ↔ kind | DM, extraction, inferred |
| `mind.values.honesty` | −3 … +3 | deceitful ↔ honest | DM, extraction, inferred |
| `mind.values.courage` | −3 … +3 | timid ↔ bold (Bram's recklessness is +3) | DM, extraction, inferred |
| `mind.values.ambition` | 0–3 | how much they want more | DM, extraction, inferred |
| `mind.values.loyalty` | 0–3 | how much loyalty means to them, in general | DM, extraction, inferred |
| `mind.fears[f]` | text, strength 1–3, optional target | what they fear | DM, extraction |
| `mind.bonds[b]` | text, strength 1–3, optional target | who or what they hold dear | DM, extraction |
| `mind.wants`, `flaws`, `ideals` | text lists | as now: description, read by the model, not the engine | DM, extraction |

Five values is deliberate: few enough to fill, enough to make the interplays below work. More can be added as rows later (open question 2).

**Body and state:** as now. Status, health band, conditions and form already drive capabilities. **Conditions gain a source and a target:** "charmed *by Iresia*", "frightened *of Varek*". The charm law ("can't harm the one who charmed them") and the interplays below need to know who.

**Knowledge:** `knowledge[k]` as now (text, secret). It gains `about` (a link to the thread or node it concerns) and `shared` (who else knows: a list of nodes), so "holds a secret" can be tested against whom they trust.

**Log-derived** (computed from the table log, never stored; built this morning):
- `derived.momentum` (PCs): on a roll / rattled, with the reason;
- `derived.activity` (NPCs): quiet / active / very active;
- `derived.ruleUse[rule]`: uses this session and in all;
- later, `derived.familiarity` (places): visits.

### 4.2 Relationships: sub-properties on a pair

Today a pair can have several relationship **types** (likes, trusts, serves, owes, enemy…), each with a note and a strength. Types stay: they're the categories, with the laws already built (one holder, two-way ties, opposite ties replace each other). Each **direction of a pair** gains a small set of **weights**, the sub-properties of how A stands toward B:

| Path | Range | Meaning | Default if unset (from the types) |
|---|---|---|---|
| `A→B.warmth` | −3 … +3 | hostile ↔ affectionate | loves +3, cherishes +2, likes +1, dislikes −1, hates −3, enemy −2, ally +1, family/romance +2 |
| `A→B.trust` | −3 … +3 | suspicious ↔ trusting | trusts +2, distrusts −2, enemy −2, ally +1 |
| `A→B.fear` | 0–3 | how afraid A is of B | fears 2, frightened of B (condition) 3 |
| `A→B.respect` | −3 … +3 | contempt ↔ admiration | none |
| `A→B.debt` | 0–3 | how much A owes B | owes 2, promised 1 |
| `A→B.loyalty` | 0–3 | how bound A is to B, for serves / member_of / leads | serves 2, member_of 1 |

**Defaults from types are shown as defaults** ("warmth +1, from *likes*"), never as recorded values. Setting a weight by hand replaces the default for that pair and direction.

The party is a node already. **`A→party`** is the stance toward the party as a whole: today's `attitude`, kept as its own entry and also used as the fallback when there are no per-PC links.

### 4.3 Items

| Path | Range | Meaning |
|---|---|---|
| `properties.power` | 0–3 | how much it can do |
| `properties.pull` | 0–3 | how much it draws its holder to use it (the figurines are 3) |
| `properties.cost.severity` | 0–3 | how bad the price of use is |
| `properties.cost.grows` | yes/no | whether the price rises with use (pairs with `derived.ruleUse`) |
| `properties.true`, `known`, `cost` text | as now | description |

### 4.4 Factions

| Path | Range | Meaning |
|---|---|---|
| `aims[g]` | like goals: text, priority, intent, commitment | what the faction wants |
| `aggression` | 0–3 | how readily it uses force |
| `clock` | filled / of | as now: how close its plan is |
| `alert` | 0–3 | how wary it is of the party; nudged by the table (thefts, fights), fades |

### 4.5 Places

| Path | Range | Meaning |
|---|---|---|
| `danger` | 0–3 | how dangerous it is |
| `hazards[h]` | text, severity 1–3 | as now, plus a severity |
| `control` | a link to the faction or person who holds it | who runs it |
| `derived.familiarity` | visits | log-derived |

### 4.6 Threads

What's there now (stakes level, `ifIgnored`, deadline, roles, heat) plus:
- `urgency` 0–3: how soon it bites, for the GM to set when there's no hard deadline;
- `derived.neglect`: sessions since it was last touched, log-derived (heat already uses this).

## 5. Properties: made from sub-properties

A property is a row in the **property table**, which gives:
- **inputs:** paths, which may include links;
- **a formula**, from a short list of combinators in code: weighted mean, sum, clamp, the larger or smaller of two, and "adjust by";
- **bands**, with names;
- **how much must be known** for it to count;
- **how it explains itself.**

The formulas are deliberately simple and visible. A DM can read why "resolve: iron" and agree or not.

### 5.1 The first set

| Property | Made from | Formula (plain words) | Bands |
|---|---|---|---|
| **intent** (a character's, or a faction's) | each active goal's intent and priority | average of goal intents, weighted 3 / 2 / 1 by priority | malign ≤ −1.5 · self-serving −1.5…−0.5 · mixed −0.5…+0.5 · benign ≥ +0.5 |
| **resolve** | top goal's commitment; strongest belief's conviction; courage; mood; health; momentum (PCs) | commitment + conviction/2 + courage/2, adjusted −1 if critical or unconscious, +1 or −1 for mood ≥ +2 or ≤ −2, ±1 for momentum | wavering ≤ 1 · steady 2–3 · iron ≥ 4 |
| **standing with the party** (NPCs) | warmth from them to each PC, weighted by trust; their stance to the party as fallback | trust-weighted average warmth to PCs | hostile ≤ −2 · cold −2…−0.5 · neutral · warm ≥ +0.5 · devoted ≥ +2.5 |
| **pressure on** a character | fear of anyone near; debt to anyone near; health; a goal blocked | fear (max) + debt (max) + blocked goals | at ease · pressed ≥ 2 · cornered ≥ 4 |
| **confidence** (PCs) | mood; momentum; health | mood + momentum ± health | shaken · steady · bold |
| **cohesion** (factions) | members' loyalty to the faction, and warmth to its leader | average loyalty, less one for each member with loyalty ≤ 1 and leader warmth ≤ 0 | fractured · holding · united |
| **pressure** (threads) | stakes, urgency or deadline, neglect, heat | as heat today, plus urgency | quiet · building · urgent |
| **temptation** (holder and item) | item's pull; holder's resolve; uses this session | pull + uses/2 − resolve/2 | none · tugging · gripping |
| **reputation** (the party, with a faction) | warmth to the PCs from the faction's members, weighted by their importance; the faction's stance and alert | weighted average warmth, less alert/2 | wanted · distrusted · unknown · welcome · honoured |

**Unknowns:** each property says how many of its inputs are known ("resolve steady (2 of 4 known)"). Below a set minimum it's unknown; "intent" needs at least one goal with an intent. The engine only acts on a band when the property is known enough; the prompt says "partly known" when it isn't.

**Explanations:** each property's *because* lists its strongest inputs, worded from the registry ("committed to finishing the ritual (3); confident (mood +2); unhurt"). These are the lines the inspector shows and the prompt uses.

## 6. Interplays: relationships between properties

An interplay is a row in the **interplay table**:
- **name and kind:** tension or alignment;
- **when:** conditions over properties and sub-properties, on one node, on a pair, or across a link to a thread;
- **strength:** how far past the thresholds it is, 1–3, so a stronger one weighs more;
- **what it gives:**
  - a *handle*, the short line for the prompt and the inspector;
  - *engine effects*: move sources, cast lean, behaviour bounds, hand-off offers;
  - *payloads* for beat plans;
- **examples:** small cases that must fire, and cases that must not, run as tests.

### 6.1 The first set

**On one character**

| Interplay | Kind | When | Handle (example) | Engine effects |
|---|---|---|---|---|
| **conflicted** | tension | intent ≤ −1 *and* standing with the party ≥ +1 (or warmth ≥ +2 to any PC) | "torn: means to finish the ritual, but has come to like Kira" | move source **waver** (they hesitate, warn, or quietly work against their own goal); bounds loosened: may be written helping the party *against* a goal; payloads: the goal and the warm link |
| **resists the charm** | tension | charmed by X *and* (resolve iron, *or* top goal intent ≤ −2 and the charm cuts against it) | "charmed, but straining: the charm runs against everything she wants" | the charm law still holds (no harming the charmer), but a **strain** move is offered: refusing or stalling an order that cuts against the goal. Hand-off offered to the charmer PC: a Charisma check to hold the charm, which breaks on a failure. Rolls stay with PCs: the NPC's resistance is the GM's call, the PC's hold is a roll. |
| **cornered** | tension | malign or self-serving intent *and* pressure cornered (captured, critical, in great debt or fear) | "cornered: desperate enough to bargain, or to lash out" | move sources **bargain** and **lash out**; more weight on arrival-by-escape for captured NPCs |
| **secret strain** | tension | holds a secret about T *and* trust ≥ +2 toward a PC who isn't in on it | "aching to tell Bram what she knows about the potions" | move source **confide** (a payoff or hint move with the secret as its payload; still hinted, never stated, unless the DM chooses) |
| **fear over greed** | tension | a self-serving goal with high commitment *and* fear ≥ 2 of someone involved | "would sell you out, if they weren't so scared of Varek" | move source **comply under pressure**; that someone becomes a lever in hand-offs ("who scares them more?") |
| **steadfast** | alignment | benign intent *and* resolve iron | "won't be moved from what's right" | bounds tightened: can't be written betraying their goal without cause; persuasion against the goal is hard (it's offered as a contest, not a question) |

**On a pair**

| Interplay | Kind | When | Handle | Engine effects |
|---|---|---|---|---|
| **devoted** | alignment | A→PC warmth ≥ +2 *and* trust ≥ +2 | "would take a blade for Kira" | cast lean: preferred as support when that PC is in trouble; bounds tightened: won't turn on them without cause |
| **hollow loyalty** | tension | A serves or is a member of L, loyalty ≤ 1, *and* A→L warmth ≤ 0 | "serves the Red Hand, but has no love for its captain" | move source **defect** (a better offer, a quiet warning); the faction's cohesion drops |
| **torn loyalties** | tension | A is loyal to L (≥ 2) *and* warm to B (≥ +2), *and* L and B are enemies, or L's aim targets B | "owes everything to Azarath, but won't see Pip harmed" | move source **choose a side**; strongest when both are in the scene |
| **unrequited** | tension | A→B warmth exceeds B→A by 3 or more | "adores Bram; Bram barely knows her name" | spotlight and character moves; payloads for heartfelt Develop |
| **mutual distrust** | tension | A→B trust ≤ −2 *and* B→A trust ≤ −2, while they share a thread | "need each other, trust each other not at all" | collision moves gain weight when both are in the cast |

**Across a thread, a faction or an item**

| Interplay | Kind | When | Handle | Engine effects |
|---|---|---|---|---|
| **rivals in purpose** | tension | A's goal targets T, and B's goal opposes it (intents of opposite sign on the same target), both active | "both want the Lodestone, for opposite ends" | collision moves on T gain weight |
| **faction fracture** | tension | cohesion fractured *and* clock advancing | "the Red Hand is splitting as the toll war heats up" | an offscreen move: infighting, a defector arrives |
| **the pull** | tension (PC or NPC holder) | temptation gripping | "the Knight figurine wants to be used again" | PCs: sensation beats and temptations, never the use itself; NPC holders: an **use it** move; the rule move notes the growing cost (with rule use) |

These fourteen are the starting set. Each row is small, has its own tests, and can be tuned or retired on evidence.

### 6.2 How strong, and how many

**Strength** is how far past the thresholds the conditions are (1–3). It scales the interplay's weight in moves, and decides which interplays make the prompt when there are many. **Budgets:**
- **improv:** the interplays of the move's cast and of who the moment names, up to 3;
- **Develop:** up to 5;
- **prep:** all of them, sorted by strength.

### 6.3 When interplays overlap

One character can carry several at once (devoted to Kira *and* conflicted about the ritual). The rules:
- **All of them are shown**, strongest first, within the budget. A character with two pulls is the interesting case, not a contradiction.
- **Bounds:** a tension on the same character can loosen an alignment's bound only where the table says it may. Conflicted can loosen steadfast's "won't act against their goal"; nothing loosens the charm law or devoted's "won't attack the one they're devoted to". The table lists, for each tension, which bounds it may loosen.
- **Moves:** each interplay is its own move source. When two point the same way (devoted and torn loyalties, both toward Pip), they add up; when they point opposite ways, both moves are offered and the steers and variety pick.
- **Contradictory records** (an intent of +3 and a goal "murder the council") are a data problem, not an interplay. The inspector flags them for the DM ("these disagree: check one"), and the engine treats the property as partly known until they're fixed.

## 7. How the scaffold pulls them

### 7.1 Addressing

Every sub-property, property and interplay has a path the engine and the tests use. The model never writes a path; it gets ids from an enum (7.4).

| What | Path (internal) | How it reads in a prompt |
|---|---|---|
| a goal's intent | `character:41/mind.goals/g2.intent` | "Vex'ahlia's goal 'finish the ritual': harmful (−2)" |
| a pair weight | `character:41→character:7/warmth` | "Vex'ahlia → Kira: warm (+2)" |
| a property | `character:41/resolve` | "Vex'ahlia: resolve iron (committed 3, confident, unhurt)" |
| an interplay | `character:41/#resists-the-charm` | "Vex'ahlia: charmed, but straining…" |

**Goals, beliefs, fears, bonds and knowledge get stable ids** (`g2`, `b1`…), so a change to one can be found and undone, and an item can be renamed without losing its history.

### 7.2 In the prompt

The scene's cards and profile lines keep their shape, with a short *how they stand* part for each character in reach:
- the properties in a band worth saying;
- the interplays, with handles;
- in improv, at most two lines per character.

GM-only parts are marked as GM secrets, as now. A block like today's LATELY lists the strongest interplays in play.

### 7.3 In moves and casts

Interplays add move kinds (`waver`, `strain`, `bargain`, `lash out`, `confide`, `comply`, `defect`, `choose a side`, `use it`) alongside today's (`payoff`, `complication`, `arrival`, `hint`, `collision`, `rule`, `callback`).
- Each comes from an interplay, with its *because* and its cast.
- Its score is the interplay's strength, plus how hot its thread is.
- The steers lean them as with the other kinds: heartfelt toward confide and waver, fight toward lash out and defect, story toward choose a side.
- Casts carry each member's interplays, so a support pick prefers someone devoted to the PC in trouble.

### 7.4 In beat plans and the answer format

With beat plans, a beat's payload can be any sub-property, property or interplay, by id (P1, P2… listed in the prompt). The beat's **act** follows from the payload:
- waver → hesitate, warn;
- strain → refuse, stall;
- confide → hint;
- bargain → offer.

The answer format gains a single enum of payload ids per step, small enough to stay inside the grammar limit we hit before.

### 7.5 In checks: behaviour bounds

Today's capability laws (the charmed can't harm the charmer, the frightened won't approach) stay. Interplays can **loosen** or **tighten** them for *typed acts*, meaning the act a beat plan assigns. There's no reading of free prose:
- **devoted** and **steadfast:** a planned act of betrayal or attack against the bonded PC, or against the goal, is dropped unless a tension on the same character allows it;
- **conflicted:** a planned helping act against their own goal is allowed (it would otherwise be off-character);
- **resists the charm:** a planned refuse or stall of the charmer's order is allowed; a planned harm to the charmer is still dropped.

Before beat plans exist, bounds act only through moves and casts. That's another reason beat plans follow this work.

### 7.6 In hand-offs

Some interplays **offer** a turn, which the DM can take or leave:
- *resists the charm:* the charmer makes a Charisma check to hold the charm, which breaks on a failure;
- *conflicted:* the party makes an Insight notice roll to read the hesitation;
- *fear over greed:* a question, "who do you remind them to fear?";
- *steadfast:* persuading them against their goal is a contest, not a question.

### 7.7 Worked examples

**A. Vex'ahlia and the charm** (enriched Duradan copy, with illustrative values)
- Recorded: top goal "complete the ritual for Azarath" (priority 1, intent −2, commitment 3); mood +1; healthy; *charmed by Iresia*.
- Properties: intent malign (−2); resolve iron (3 + 1 + …).
- Interplay: **resists the charm**, strength 2: "charmed, but straining: the charm runs against everything she wants".
- The moment: "Iresia orders Vex'ahlia to lead them to the ritual site."
  - The engine offers a **strain** move. Vex'ahlia stalls, or leads them the long way round. She can't harm Iresia (the charm law still holds).
  - Hand-off: "Iresia makes a Charisma check to hold the charm." On a failure, the charm breaks. That's a typed consequence, applied directly if used.
  - Payloads: the ritual goal and the charm.
- Without the interplay, today's engine would let her obey cheerfully or rebel at random, depending on the model.

**B. Mother Ysolde** (sample campaign)
- Recorded: goal "keep the stall profitable" (intent −1, commitment 2); Ysolde→Kira warmth +1 (from *likes*); honesty −1.
- Properties: intent self-serving; standing with the party warm.
- Interplay: **conflicted**, strength 1 (mild): "torn: wants her coin, but likes Kira".
- Effect: the waver move is favoured. She helps, but hedges and overcharges, and honesty −1 colours how. That's how she already reads in the notes; now the engine knows it, and it can change. If the party pays her well and keeps her secret, her warmth goes up. If they expose her bad batch, her intent toward them hardens.

**C. A Red Hand guard** (sample campaign, an illustrative walk-on given a record)
- Recorded: member of the Red Hand (loyalty 1); warmth to its captain −1; fear of the captain 2.
- Interplays: **hollow loyalty** and **fear over greed**.
- The toll-house raid's options now include "a guard quietly tells them where the key is, if they can promise the captain won't know", rather than another generic lookout.

## 8. How sub-properties change

### 8.1 Where changes come from, and who wins

| Source | What it can do | Precedence |
|---|---|---|
| **The DM** (inspector, CLI, the questions tray) | set any value | always wins; its value stands until the DM changes it |
| **Extraction** (session notes, the GM's own text at the table) | fill a blank with a quoted value; propose a change over the DM's value (a question) | as now: fills blanks, proposes over DM values, never erases |
| **Table events** (direct changes from used options and steps; roll and fight results) | nudge a value by a small step, within caps | below DM values: a nudge to a DM-set value becomes a question, unless auto-approve is on |
| **Inference** (a one-off pass to fill old data) | suggest values with "implied" confidence, for review | never applied without review |
| **The log** | compute log-derived sub-properties | never stored |

This is the existing write path (`updateEntity`, `setRelation`, `field_meta`, `state_changes`, batches and undo), extended to the new paths. **One new source value:** `table`, so the inspector can say "warmth +1 (from the table: they paid her fairly, session 4)".

### 8.2 What table events change

Events are typed from what's already known when a choice is used: its move kind, its cast, its hand-off (kind, skill, target), the result's outcome, and the steer. A small **event table** maps each to nudges:

| Event | Typed from | Nudges |
|---|---|---|
| party helps X | a used option or step whose hand-off or move has the party aiding X (a choice side with approach talk, item or force on X's behalf), or a result "Succeeded" on it | X→helping PCs warmth +1, trust +1 |
| party harms or fights X | a fight with X or X's faction; an attack hand-off on X | X→PCs warmth −1; X fear +1 if the party won; X's faction alert +1 |
| party deceives X and is caught | a Deception check against X that failed | X→that PC trust −1 |
| party persuades X | a Persuasion check against X that succeeded | X→that PC warmth +1 (capped), or a goal's commitment −1 if the persuasion was against it |
| party spares a beaten foe | a won fight, then a choice side with approach talk or wait | X→PCs warmth +1, respect +1 |
| X's goal advanced or thwarted | a thread progressed or resolved where X's goal targets it (goal.target = thread) | that goal's status; X's mood ±1 |
| X's loyalty tested | a defect or choose-a-side move used | X→leader loyalty −1 |
| a charm breaks | a failed hold-the-charm check | the condition removed (risky tier: a question) |

**Caps and size:**
- each nudge is ±1;
- a value moves at most ±2 per session from table events;
- a value never crosses from positive to negative from table events alone: that becomes a question ("Ysolde's warmth to Kira would go from +1 to −1. Record it?").

### 8.3 Fading and settling

- **Lasting** (until changed): goals, values, intent, the pair weights, loyalty, debt.
- **Settling back toward a baseline:** mood (toward the recorded value, one step per session), fear (one step every two sessions, unless the cause is still present), faction alert (one step per session).
- **Log-derived:** as built (this session counts fully, the last half).

### 8.4 Mood that moves

Mood stays the DM's recorded number. On top of it sit:
- a **settled drift** from table events: a goal achieved +1, a loss or defeat −1, settling back as above;
- for PCs, the momentum lean.

The prompt and the inspector show both: "mood steady (recorded) · uneasy lately (lost the Lodestone, session 6)". The drift is a sub-property with source `table`, so it's visible and undoable. The DM can fold it into the recorded mood with one tap.

### 8.5 Two ends of a link

A change to A→B never changes B→A by itself. Some events nudge both, through their own rows: a fight nudges both sides' warmth. Opposite types still replace each other (ally and enemy), as now. When a type changes, the defaults that came from it change with it, but hand-set weights stay.

### 8.6 History and undo

Every write, from any source, goes through `state_changes` with before and after, the source, the session and a batch. So Take back on a used choice reverses its nudges, and the inspector's history shows "warmth +1 → +2, table, session 4, *paid her fairly*".

## 9. Storage

- **Character, item, faction, place and thread sub-properties** live in `traits` (validated by `TraitsSchema`) and the typed node fields, extended:
  - goals, beliefs, fears and bonds become **items with ids and weights**. Old plain strings and `{text, priority}` items are read as items with blanks; nothing is lost.
  - `mind.values` is a new object of five optional numbers.
  - Conditions gain `by` and `target` (node references).
  - Items gain `power`, `pull`, `cost.severity` and `cost.grows`; factions gain `aims`, `aggression` and `alert`; places gain `danger` and hazard severity; threads gain `urgency`.
- **Pair weights** get a new table, `pair_weights` (campaign, from, to, warmth, trust, fear, respect, debt, loyalty, field_meta), one row per direction of a pair. Relationship types stay in `entity_relations`. Defaults from types are computed, not stored.
- **Provenance** uses `field_meta`, keyed by path (`traits.mind.goals.g2.intent`; for pair rows, by weight name), with `source` gaining `table` and `inferred`.
- **Properties and interplays** are never stored; they're computed per moment and cached, as activity and momentum are.
- **Migration 0012**: the new table, `field_meta` source values, and a one-off pass giving existing goals, beliefs, fears and bonds their ids.

## 10. Filling the data

The model is only as good as its data, and today's data is thin. Real Duradan has 0 of 18 characters with goals; the copy has them but no intents. Four routes, in order:

1. **Defaults from what exists:** warmth, trust, fear, debt and loyalty from relationship types; stance to the party from attitude. This is free and immediate, and shown as defaults.
2. **The enriched copy**, filled by hand for testing: intents, commitments, values and pair weights for about eight characters, enough for every first-set interplay to fire at least once and for some to be near misses.
3. **An inference pass** for an existing campaign: one call per campaign (Haiku or Sonnet), proposing intent and commitment for each goal, values for each named character, and pair weights for each relationship, each with a quote from the notes and an "implied" confidence. It's reviewed in the existing tiered review: implied values go to "confirm", and anything contradicting a DM value becomes a question. Blanks stay blank where the notes say nothing.
4. **Extraction going forward:** the recap and live extractors propose the new sub-properties alongside what they propose now, under the same evidence rules, and the "don't assert causes the notes don't state" rule.
5. **Asking only when it matters:** when a move would turn on an unknown ("would Vex'ahlia resist? her commitment isn't known"), the engine can raise a one-tap question in the tray. It never asks for everything.

## 11. What the DM sees and edits

- **Inspector** (entity view): a *how they stand* section:
  - the properties with their bands and *because*;
  - the interplays with handles;
  - the sub-properties folded underneath, each with its source badge (✎ DM, ⚙ extracted, ⇄ table, ≈ inferred, ∂ default) and its history.
  - Editing uses the existing quiet controls (`Steps` for −3 … +3, `Choice` for statuses). This is the first piece of Stage 4's typed editing.
- **Pair view:** opening a tie shows both directions' weights side by side ("Ysolde → Kira: warm +1, trust 0 · Kira → Ysolde: wary −1, trust −2"), with any pair interplays.
- **Campaign page:** a "tensions in play" list, the strongest interplays across the cast, each opening the inspector. It's a prep view in itself.
- **CLI:** `entity set "Vex'ahlia" goals.g1.intent=-2`; `relate "Mother Ysolde" Kira warmth=1 trust=0`; `entity why "Vex'ahlia"` (properties and interplays with their reasons).

## 12. Cost and speed

Everything is computed in code from the graph already loaded for each moment: tens of characters, each with a few sub-properties. It's cached per moment (`WeakMap` on the View) and adds milliseconds. The only model costs are the one-off inference pass and the extra fields in extraction (a few hundred tokens). Prompt growth is bounded by the per-feature budgets (6.2).

## 13. Tests and measurement

- **Interplay and property rows carry their own examples** (fires, doesn't fire, near miss), run by `npm run test:engine` alongside the moment-reading rules.
- **Crafted checks** (`scenarios/private/checks.ts`):
  - unknowns propagate, and DM values win;
  - defaults come from types;
  - nudges respect the caps and the sign-crossing question;
  - undo reverses nudges;
  - fades settle;
  - bounds drop the right planned acts.
- **The enriched copy** gets a scenario file of moments built to provoke each interplay: the charm order, Ysolde's price, the guard and the key, Tomas torn between Pip and the Resistance.
- **Blind runs** (Haiku first, Sonnet as a check), with and without interplays, on the same moments:
  - usable options;
  - "uses a tension" (does the option build on the interplay the engine offered?);
  - "in character" (does the NPC behave as the interplays say?);
  - thin options;
  - time and cost.

## 14. Build order

Each step is testable on its own.

1. **Registry and storage:**
   - the sub-property registry (paths, ranges, meanings, sources);
   - the `TraitsSchema` extensions with ids;
   - the `pair_weights` table and migration;
   - defaults from types and attitude;
   - engine accessors that return value, source, known or unknown, and *because*.

   Checks.
2. **Properties:** the table, the combinators, the first set (5.1), unknown handling and explanations. The inspector shows them read-only. Checks.
3. **Interplays:** the table, the first set (6.1) with examples, strength and budgets; prompt lines; the campaign page's tensions list. `test:engine` runs the rows.
4. **Data:**
   - the enriched copy filled by hand;
   - the inference pass (reviewed) for the sample campaign and Duradan;
   - extraction proposing the new fields.
5. **Moves, casts and hand-offs** from interplays (7.3, 7.6). Blind run on Haiku and Sonnet.
6. **Table events:** the event table (8.2), caps, fades, the sign-crossing question, and undo through direct changes and results. Checks.
7. **DM editing:** inspector controls, the pair view, the CLI.
8. **Beat plans:** payloads from sub-properties, properties and interplays (7.4), and behaviour bounds on typed acts (7.5). Blind run, measured against step 5.

## 15. How it fits what's built

- **Derived state v1** (momentum, rule use, pace) and NPC activity become the registry's log-derived sub-properties, with the same code and fades.
- **Moves** gain interplay sources, and keep the busy-lead penalty, the steers and pace.
- **Direct changes** (applying a used choice's own effects) are where table events come from, so this extends them rather than adding a second path.
- **Beat plans** (planned) get their richest payloads from here, so this comes first, as agreed.
- **Stage 4** (storage, extraction and typed editing) is largely this: the typed fields, extraction into them, and the inspector editing them.

## 16. Open questions for Jacob

1. **What intent measures.** I've proposed *who a goal is good for*, from −3 (harms others) to +3 (helps others), with how a character stands toward the party handled separately by warmth and trust. The alternative is intent toward the party specifically. I'd keep it general: that's what lets "harmful goals but friendly with the party" be a tension at all.
2. **The five values** (compassion, honesty, courage, ambition, loyalty). Too many, too few, or the wrong ones for your table?
3. **How fast the table moves people.** Proposed: ±1 per meaningful event, at most ±2 per session, with a question before anyone flips from friend to foe. Faster feels more alive; slower feels more stable.
4. **Interplays on PCs.** Proposed: only as offers (temptations, spotlight, sensations, questions), never shaping what a PC does. Is that the line you want?
5. **Chance.** Proposed: no dice inside the engine. A conflicted NPC's waver is a likelier move, not a 1-in-3 roll. Do you want an occasional "they surprise you" element?
6. **Which interplays first.** The fourteen in 6.1 are a starting set. Are there ones from your table you'd add (a curse that feeds on a vice, a rivalry that softens)?
7. **Inference on the real campaign.** Should the one-off pass run on Duradan, reviewed in the usual tiers, or should Duradan be filled only by hand and from future notes?
