# Threads you can act on (plan, 3 Nov 2026)

Jacob: threads aren't interactive yet. They should ask things of the GM (who to target, for example) and tie back into the engine and the campaign's data. The roll panel was the first piece of this; this plan covers the rest, for Jacob to choose from.

## What's there now

A thread shows up as a chip on an option, a row on the campaign page, and a view in the inspector (summary, stakes, parts, history, and editing of its stakes and parts). The engine knows much more about each one than the page lets you use: its heat (ripe, urgent, gone quiet), who plays which part, the moves it allows (payoff, complication, arrival, hint, collision), who could arrive for it, and the house rules tied to it.

## Proposals

1. **"What could happen next" on every thread** (no model call). The thread's view and its chip's hover card list the engine's moves for it: "Pay it off: it's ripe", "Complicate it: the deadline is dawn", "Bring in Varek: the seeker isn't here", "Drop a clue". Each shows its cast and its reason in a line. Tapping one asks Loom for options built on that move only (one Haiku call, ~3 s). This is the quickest way to "push this thread now".

2. **Choices on an option, filled by the engine.** Where a move allows more than one cast member or target, the card asks: "Who does the guard go for? [Bram ▾]", "Who arrives? [Varek ▾ / a Ka'Anshar runner]". The engine supplies the choices (only those allowed: here, able to act, not dead). Changing one rewrites just that option on the same move (one short call), keeping its thread and roll. With no choice to make, nothing extra shows.

3. **Results move the thread.** A roll recorded in the panel already reaches momentum and nudges. Next: a success on a payoff move marks the thread progressed (or asks "Resolve it?"), and a failure on a complication raises its urgency. All of this goes through the usual review and undo, so nothing big happens without a yes.

4. **Thread actions at the table.** From a chip: Park it (it won't come up for a while), Bring it back, Resolve, Set a deadline ("by dawn", which complication moves then use). Each is one tap and undoable.

5. **The thread's own rolls.** A rule tied to a thread (Reality Microfractures) is offered on the thread's view with the roll panel, so you can roll it without asking Loom first.

## Questions for Jacob

- Which first? My order would be 1, then 2, since together they make threads something you steer from rather than read.
- For 2: rewrite the option when you change the target (a short model call, about 2 s), or only change the names (no call, but the prose may read oddly)?
- For 3: should a success on a payoff move resolve the thread outright, or always ask?
