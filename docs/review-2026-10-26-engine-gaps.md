# Engine gap analysis: improv, Develop and the world model

26 Oct 2026. A review with no model calls, made while the API credit is out. Sources: the code, the world-model fill report (`npm run test:world -- 3 12 --report`) and Develop blind run 1 (`data/runs/2026-10-26-develop-blind-1.md`).

Jacob's premise: the biggest gains came from moving work from the model to the engine, and making the model fill in the engine's data before the second pass. The richer the engine's data, the better the scaffolding works and the less the model has to carry.

## 1. The evidence for that premise

Every big step so far took a decision out of the model's prose and made it a value the engine chooses or checks.

| Change | What moved to the engine | Result |
|---|---|---|
| Enforced lists (Scaffold v2) | who may act, threads, hand-off targets, as real constraints | rejections 1.0 → 0.63 per call |
| Per-kind actors | which kind of beat each character can be in | 0.63 → 0.44 |
| Slots and "happens" beats (Stage 3) | names through references; a PC's sensation built from parts | 0.38–0.55 → 0.19–0.31 |
| Moves and casts (Stage 3 part 2) | what could happen, on which thread, with whom | 0.13 per call on the sample campaign |
| NPC activity | who's been on stage lately | Tomas in 11 of 33 options → 0–3 |
| Develop `opens_on` | which outcome of the last turn a chain develops | step 1 retelling the choice: most chains → none |

Each time, the model lost a way to be wrong. It didn't get a longer rulebook.

## 2. Who decides what, today

**Decided by the engine** (enforced in the answer format or by code):
- which threads, which move, and who is in its cast;
- who may act, arrive or be named; who holds what; which rules are live;
- the kind of each beat and of each hand-off; the outcome the first step follows (`opens_on`);
- the joining words between steps; the hand-off sentence; a PC's sensation sentence;
- dropping any sentence where a PC opens a clause.

**Still written freely by the model**, in every improv option and every chain step:

| Free text | What it carries | Blind-run faults it caused |
|---|---|---|
| A beat's `does` | the action **and the payload**: what's revealed, offered, threatened, found | continuity (B32 a ledger from nowhere, B42 Tomas "pulling Khayiulad back" that never happened); thin steps (Haiku: 7 of 16 chains) |
| A "happens" beat's `cause` | meant to be a noun phrase ("the river's cold grip") | **a PC's feelings narrated**: B20 "Bram feels the certainty that no blade here can touch him" and B05 "the fear he has never admitted to" were both written through `cause` |
| The phrases in a hand-off (`what`, `or`) | what they face; the two sides of a choice | B42 asks about something no beat set up; B29 a choice with no typed approach, so a check could be any skill |
| `if_they` / `opens_if` | what the players would do | B21: two steps with the same condition |
| References by name, with no pronouns | who owns what | B11 "Ysolde avoids Mother Ysolde's eyes" (meant Kira) |
| Headline, label, why | the summary | one title fell back to "Next" |

The pattern is consistent: **the engine chooses who and which thread, but the model still invents what happens.** Where that invention isn't anchored to data, faults and thinness follow. Haiku isn't bad at sentences. It's bad at inventing payloads, which is why it ties Opus on improv (one beat) and falls apart on chains (2–3 beats of payload).

## 3. How Develop meets the engine: gaps in the joins

1. **The choice's structure is thrown away, then guessed back.** When a choice is logged, only its rendered text is kept (`LiveOption` stores label, text, headline…). Develop then reads the players' turn back with a regex (`choiceHand`), and `prepareMoment` re-reads the choice text to work out who arrived or what changed hands. Everything the engine knew when it built the option (the hand's kind and sides, the arrivals, the hand-overs, the move and its cast) is in the scaffold, which is dropped.
2. **The world only partly moves between steps.** `StepRunner` carries arrivals and hand-overs (the hand-overs found by a regex), and who answered the last turn. It doesn't carry what a step introduced (an object, a clue, a person), a condition it caused, or which thread it progressed. So a later step can ask about something never set up (B42), and nothing knows what has already been revealed.
3. **A used step is extracted again from its text.** Using an option or a step sends its rendered text to the live extractor (Sonnet, ~10–15 s, ~$0.03–0.05). That's 30–50 times the cost of the Quick ask that produced it. Most of what the extractor finds (an arrival, a hand-over, thread progress, a condition) was already structured in the scaffold. Applying those changes directly would make logging instant, nearly free, and exact; extraction would be needed only for the GM's own text and for anything new the prose introduced.
4. **The steer only leans the moves.** It's a weight on move kinds plus a sentence in the prompt. Nothing requires a fight chain to end in a fight (B02, B37), or a grounded chain to stay grounded (B29, a hostage at the edge).
5. **Nothing requires a step to change anything.** A step can be just a sensation and "what do you do?" (the Haiku failures). The engine could require that each step move something it can name: a reveal, an arrival, a change of hands, a cost, rising stakes.
6. **There's no stall timeout.** A dropped stream hangs Develop (and improv) indefinitely; two Opus chains in the blind run ended "terminated".

## 4. The data the engine has, and what it uses

**How full the world model is** (real Duradan → enriched copy):

| Field | Filled | Engine logic uses it? | What it could power |
|---|---|---|---|
| Character gender / pronouns | 0/18 → 0/18 | no | rendering "her" and "his"; resolving "she" and "he" to the right character (today the nearest name, which misreads "she" after a male PC's name) |
| Goals, beliefs, mood | 0/18 → 18/18, 3/18, 18/18 | prompt text only | character and heartfelt moves aimed at a specific goal or belief |
| Wants, fears, bonds, flaws | 0–2/18 | prompt text only (fears) | heartfelt chains about a named fear or bond, not just a "condition" thread |
| Knowledge (secrets held) | 1/18 | no | hint moves that reveal a *specific* fact (the engine picks it; the model only phrases how it's glimpsed) |
| Item true properties, cost | 0/13 | no | complication and rule moves with the real price of use |
| Faction goal, plan, clock | 0/2 | no | an offscreen move: the faction advances its clock (a "the Red Hand doubles the watch" beat from data) |
| Place hazards, atmosphere | 0/19 | no | grounded and quiet beats with a concrete, recorded detail |
| Thread payoffs, deadlines | 0/32 | deadline only (heat) | payoff moves that pay off a recorded payoff idea |
| Thread stakes | 0/32 → 32/32 (enriched) | yes (heat, complications) | already used |
| Thread roles | "involved" → 93 roles (enriched) | yes (casts, arrivals, hints) | already used; the biggest single gain on the copy |
| Voice, appearance | 0/18 | no | the flavour pass |

Two conclusions:
- **Most fields that exist aren't filled**, even in the enriched copy. Extraction doesn't write them (that's Stage 4) and nothing asks the GM for them.
- **Most fields that are filled reach the model only as description.** Goals, beliefs and mood shape the prompt, but no move is built from them. The engine's logic reads presence, holdings, capabilities, live rules, thread heat and roles, and activity, and nothing else.

## 5. The next shift: beat plans

Today the engine picks the move and its cast, and the model writes the beats. Next, the engine would plan each beat and the model would only phrase it.

**A beat plan**, chosen by the engine per step, with each part an engine value:
- **actor:** from the move's cast (as now);
- **act:** a short enum: reveal, offer, threaten, ask, arrive, send word, take, give, hazard, sensation;
- **object:** a reference (as now);
- **payload:** an engine fact with an id: a secret someone holds, a goal, a fear, an item's cost, a faction's next step, a place hazard, a thread's payoff idea;
- **the turn:** the hand-off kind, with choice sides typed by approach (talk / force / sneak / study, each mapped to its skills), so the check that follows a choice has to match the side chosen.

The model writes one sentence per planned beat. It can't add an actor, an object or a fact, because there's nowhere to put one. The checks that remain are on phrasing, and the step's effect on the world is known exactly, because the engine chose it.

**What it would fix from the blind run:** thin steps (every beat has a payload), continuity (a question can only be about a planned object or payload), the undeclared roll (typed sides), the steer misses (a steer becomes required acts: a fight's last step is a threaten→attack beat with enemies from the data; grounded and quiet allow no arrival and only recorded hazards and atmosphere), and the feelings slip (sensation beats take their cause from the payload, not free text).

**Hypothesis to test:** with the payload supplied, Haiku's chains get close to Sonnet's, since its failures were missing payloads, not bad sentences. If so, Develop could stay on Quick.

**The risk:** sameness. Fewer open choices can make chains read alike. Keep the wildcard move on today's freer scaffold, and measure variety as well as usability.

## 6. Roadmap

**Status (26 Oct):** items 1–8 are built and covered by crafted checks (203/203); see CLAUDE.md, "Engine gaps 1–8". Nothing is measured live yet (no API credit).

Ordered by gain for effort. Items marked *code only* can be built and covered by crafted checks without API credit; measuring them needs credit.

1. **Keep the scaffold on logged options and steps** (*code only*). Store the hand (kind, sides, target), the move, the cast and each beat's kind, actor and references on `LiveOption` and on branch entries. Develop reads the turn from data, which retires `choiceHand`'s regex, and the View starts from the choice's real effects.
2. **Apply a used choice's effects directly** (*code only*). Arrivals, hand-overs, thread progress (the move's thread, with the step as its note) and conditions from "happens" beats are applied as live changes the moment it's used, so the questions tray and undo work as now. The extractor runs only on the GM's own text, or in the background to catch anything new the prose introduced. This takes logging from ~10–15 s and ~$0.03–0.05 to near zero for options and steps.
3. **Typed causes for "happens" beats** (*code only*). The cause becomes a reference (an entity, an item, a rule, a hazard) or a short recorded noun, never a clause. The whole-body form renders as "A shiver runs through Bram: the crossbow's aim". This fixes B05 and B20 by construction.
4. **Pronouns** (*code only, plus data*). Turn the gender field into a pronoun set (asked once per PC on the campaign page, and inferred where the notes are clear). Use it to render possessives and to resolve "he", "she" and "they" to the right character. This fixes B11-type sentences and the known nearest-name misreads.
5. **A ledger of what each step introduced** (*code only*). Each step records the references, objects and payloads it introduced. A hand-off may only ask about those, or about the scene. No two steps may open with the same condition. This fixes B21, B32 and B42.
6. **Typed choice sides** (*code only*). Each side gets an approach (talk / force / sneak / study / use an item), and a check after a choice must use a skill of the side chosen (B29).
7. **A stall timeout** (*code only*). If no new text arrives for ~20 s, abort and retry once, for every streamed call.
8. **Steers as requirements** (*code only, then measure*). A fight chain must end on a fight beat with enemies from the data; grounded and quiet chains allow no arrival; heartfelt targets a goal, fear, bond or condition of one PC.
9. **Beat plans** (section 5). Build behind a flag and compare blind against today's chains: Haiku and Sonnet, with and without plans. Needs credit.
10. **Stage 4: extraction into typed fields** (needs credit). Recaps and the live extractor would write gender, wants, fears and bonds, knowledge, item cost and true properties, faction goals and clocks, place hazards, thread payoffs and deadlines, and thread roles (not just "involved"). Ask about a gap only when a move would use it ("Loom could use: what does the Red Hand want next?").
11. **Develop's model default.** Sonnet now, on the blind-run evidence. Revisit after 9: if beat plans close the gap, Quick could be enough.

**What to measure when the credit is back:**
- Jacob's blind ticks on today's chains;
- the same 8 moments × 6 steers with steps 1–8 in place, then with beat plans, on Haiku and Sonnet;
- for each, how many chains were usable, steps dropped, chains cut short, and steer hits (the steer's required act present);
- how varied the chains are (distinct payloads per moment);
- time and cost, including logging (direct effects against extraction).
