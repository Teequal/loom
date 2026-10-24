# Plan: game tools for newer DMs (25 Oct)

Jacob's requests: fight setup with a recommended difficulty; results that follow through (required, with a quiet bypass); rules questions at the table; new themes, threads and connections; relationships that show how they changed.

## 1. Results that follow through

- **What's required:** a choice that ends in a **roll or a fight** waits for its result.
  - A choice that hands off a question doesn't: the next moment you type usually is the answer, so it's treated as one.
- **Where it shows:** in the tray above the box, the same place as questions. For example, "How did it go? Fight at the toll bridge", with a few quick outcomes (won / fled / lost / talked their way out) plus a line for details.
- **Skipping it:** a small "skip" text link, not a button.
- **Once given:** the result is extracted like any other choice, so it moves the threads it touched (a death, a capture, an item taken). It joins the session tree under the choice it resolves, and wrap-up lists anything skipped so the notes can fill it in.

## 2. Fights: difficulty and enemies

- **The trigger:** when a used option, a branch or your own text sets up combat, a "Set up the fight" panel opens under it.
- **The difficulty:** a four-step dial (Easy · Medium · Hard · Deadly, or Low · Moderate · High under the 2024 rules toggle). Loom suggests a step from context:
  - the party's health (Darius is critical, so it suggests a step lower);
  - the stakes of the thread;
  - the tone.
  The suggestion is marked with one line of why. You can move the dial.
- **The enemies:** drawn from who's actually in play (the Red Hand's bandits, not random goblins), with compact stats (AC, HP, attacks, save DC, a trick). It uses SRD creatures where they fit, and adjusted SRD stats where the campaign has its own.
- **The budget is checked in code, not by the model:** party size and levels against the official XP thresholds, with the encounter multiplier. You can change counts or swap a creature and see the difficulty update.
- **Levels:** this needs each PC's level, which is already a field. Loom asks once, inline, the first time a fight comes up.
- **Afterwards:** the fight waits for its result (section 1).

## 3. Rules questions

- **Where:** a Rules panel that slides in from anywhere (a "Rules" button by the search, or `?`). It already knows:
  - the scene: who's where, conditions, health;
  - the campaign's rule toggles and house rules;
  - the last few moments.
- **Answers:** short, citing the rule ("Unconscious: …"), applying your toggles and house rules, and saying when something isn't in the SRD and needs a book check.
- **Detecting questions without bloat:** if what you type in the table box reads like a rules question ("can Darius cast while…", "does that provoke…"), Loom offers a small "Ask as a rules question" chip instead of weaving options. It never routes on its own.

## 4. New material on request

- **The core stays the same:** at the table, Loom still ties back to what's already there.
- **"Fresh ideas" in prep:** new themes, threads, NPCs or connections that fit the campaign's direction, each with "Add to the loom" (it becomes a thread you can edit).
- **Develop's longest reach ("The arc")** may propose one new thread when it earns its place, clearly marked as new.

## 5. Relationships with a history

- **Today:** relationships are stored as they are now, and the change log records every change. A shift like enemy to ally is logged as one tie removed and another added.
- **The change:** the inspector shows each tie with its story, condensed: "ally now · enemies 3 sessions ago". Recent changes are listed in detail; older ones collapse into "was …".
- **Testing it:** a fixture session where an enemy becomes an ally, to confirm extraction proposes the change rather than leaving both.

## Suggested order

1. Relationship history: small, and it confirms the engine already captures change.
2. Results that follow through: the base the fight results depend on.
3. Fights.
4. Rules panel.
5. Fresh ideas.
