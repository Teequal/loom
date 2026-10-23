# Phase 1 spike verdict

*23 Oct 2026 · tested on Darkness in Duradan (5 sessions, 27 open threads) and the potion fixture*

## Verdict: pass, with one weak criterion

The magic is there. Loom reliably ties off-script moments back to existing threads, and in blind tests Jacob would use at least one option in most moments. Between-session prep found real hidden connections, plus a near-match for the potion cure swap. Cost is negligible.

Speed is the weak spot: "a few seconds" is met on average but not consistently.

## Against the pass criteria

| Criterion | Result | Evidence |
|---|---|---|
| I'd genuinely use at least one suggestion most of the time | **Pass** (on Opus or Haiku) | Blind test, 10 real moments. Moments with at least one usable option: Opus 9/10, Haiku 8/10, Sonnet 6/10. The unblinded run before it agreed (Opus 10/10). |
| The improv box answers in a few seconds | **Partial** | Average 5.0 s (Haiku), 5.5 s (Sonnet), 7.7 s (Opus). Worst case 9.5–18.5 s. The structured agency output added time. |
| Suggestions tie back to existing threads, not new material | **Pass** | 100% of runs used an expected thread, and no option cited a thread it wasn't given. Minor invention: NPCs dropped into scenes they couldn't be in (Zara at the ritual site). |
| Cost per call is small | **Pass** | Improv: $0.0006 (Haiku), $0.009 (Sonnet), $0.018 (Opus). Recap: $0.003 (Haiku). Suggestions: ~$0.06 (Opus). The whole spike, with ~100 test calls, cost **$0.86**. A session's worth on all-Opus is roughly under $1. |

**The canonical test (the potion swap):**
- The improv box never found it. All three models handled each condition separately.
- Between-session `suggest` found a near-match: matched-pair potions where "neither character can be cured without the other".
- Collisions happen when asked for explicitly, not on their own.

## What the evidence doesn't cover yet

- **One judge, one campaign.** Every "would use" verdict is Jacob's, on his own campaign. Other DMs and rougher notes are untested.
- **Opus recaps are untested.** All five recaps ran on Haiku, before recaps switched to Opus.
- **The agency harness hasn't been judged.** Improv output changed to structured world/npc/outcome beats after the last blind test.
- **Small sample.** 10 moments, one or two runs per model.

## Fix before showing it to other DMs

In priority order. The aim is the smallest thing that lets another DM feel the magic, not Phase 2.

1. **Run it for them first, then give them a page.**
   - Other DMs can't use a terminal. The cheapest test is a concierge one: take 2–3 DMs' recap notes, run Loom yourself, and send back their threads, three improv answers to moments they pick, and a `suggest` run. No deployment needed.
   - If that lands, build step 8: one local web page with a recap box, approve/skip checkboxes, the improv box and a suggest button.
2. **Make recaps work on rough notes without hand-editing JSON** (backlog 1–4):
   - clarifying questions after a recap instead of guesses,
   - a DM-notes box for secrets and hidden mechanics,
   - a second pass that catches set-up consequences (the potions miss).

   Other DMs' notes will be rougher than Jacob's, and the best suggestions came from hidden mechanics that only DM notes capture.
3. **Pick the improv default on the evidence.** Sonnet came last in both tests. Switch to Haiku (cheapest, fastest, 8/10) with Opus as the upgrade, or Opus outright if quality matters more than ~$0.02 a call.
4. **Bring improv back under ~4 s:**
   - show options as they're written (streaming),
   - send 6 threads instead of 8,
   - keep beats short.
5. **Re-verify the two untested changes:**
   - rerun sessions 1–5 on Opus into a fresh campaign and compare with the Haiku threads,
   - do one more blind tick-test of the structured improv output.
6. **Close the known agency and grounding gaps:**
   - possessive phrasings ("Khayiulad's fingers tighten…") before any roll,
   - labels that narrate PC feelings,
   - NPCs placed where they can't be (needs a "last seen" location on NPCs).

**Not needed yet:**
- **Embeddings:** retrieval only missed twice in 10 moments, both on name-less moments.
- **Tighter collisions:** they could stick to 2–3 threads, but that's polish.
- **Accounts, payments and hosting:** still Phase 2.
