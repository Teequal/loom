"use client";

import { Reading } from "./reading";
import { keyWords, Smoke, WriteIn } from "./answer-box";
import { useEffect, useRef, useState } from "react";
import { type Encounter, FightPanel } from "./fight";
import { Icon } from "./icons";
import type { Entry, Live } from "./improv-box";
import { Linked, RefChips } from "./loom-ui";
import { usePrefs } from "./prefs";
import { post, stream, useElapsed } from "./shell";

// Develop v2 (docs/plan-2026-10-25-develop-v2.md). Ask how, write one thing well, then work on it
// together: a row of steers (nothing is written until one is picked), then a chain of steps shown
// as they're written, each ending on the players' turn, joined by a line so it reads as one
// string of events. Refine it in place (one version on screen, Back to undo), swap a step, use a
// step to log it, and develop again from a step you used.

type Steer = "fight" | "heartfelt" | "epic" | "grounded" | "quiet" | "story";
const STEERS: { id: Steer; label: string }[] = [
  { id: "fight", label: "A fight" },
  { id: "heartfelt", label: "A heartfelt moment" },
  { id: "epic", label: "An epic scene" },
  { id: "grounded", label: "Grounded" },
  { id: "quiet", label: "A quiet moment" },
  { id: "story", label: "Tie to the story" },
];
const FLAVOUR: Record<string, string> = { payoff: "Payoff", twist: "Twist", callback: "Callback", character: "Character", tense: "Tense", funny: "Funny", mystery: "Mystery", fight: "Fight" };

interface Step {
  when: string | null;
  text: string;
  to: string;
  needs: "roll" | "fight" | null;
}
interface Chain {
  label: string;
  headline: string;
  why: string;
  flavour: string | null;
  move: string;
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
  steps: Step[];
  canGoBack: boolean;
  surprise?: string | null;
}
interface ChainDev {
  kind: "chain";
  id: number;
  steer: Steer | null;
  words: string;
  chains: Chain[];
}
// A chain while it streams in: its steps so far, and the chain once it's complete.
type Slot = { steps: Step[]; chain?: Chain; dropped?: boolean };
type Llm = { model: string; seconds: number; costUsd: number };

// Develop runs on Sonnet whatever the table's tier, and on Opus when the table is on Best: on chains,
// Haiku managed 3 of 24 usable in blind run 2 against Sonnet's 8 of 8.
const developModel = (tier: string) => (tier === "opus" ? "opus" : "sonnet");
const isChainDev = (d: unknown): d is ChainDev => !!d && typeof d === "object" && (d as { kind?: string }).kind === "chain";
const stepText = (s: Step) => `${s.when ? `${s.when} ` : ""}${s.text}`;
const threadRefs = (ts: { id: number; title: string }[]) => ts.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }));

export function Develop({
  live,
  parent,
  known,
  saved,
  depth = 0,
}: {
  live: Live;
  parent: () => Promise<number | null>; // the logged entry this grows from (logging it first if needed)
  known?: number | null; // that entry, when it's already logged
  saved?: unknown[]; // what's been developed from it before
  depth?: number;
}) {
  const prefs = usePrefs();
  const kept = [...(saved ?? [])].reverse().find(isChainDev);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(!kept);
  const [steer, setSteer] = useState<Steer | null>(kept?.steer ?? null);
  const [words, setWords] = useState(kept?.words ?? "");
  const [suggested, setSuggested] = useState<Steer | null>(null);
  const [slots, setSlots] = useState<Slot[]>(() => kept?.chains.map((chain) => ({ steps: chain.steps, chain })) ?? []);
  const [devId, setDevId] = useState<number | null>(kept?.id ?? null);
  const [entryId, setEntryId] = useState<number | null>(known ?? null);
  const [busy, setBusy] = useState<"" | "new" | "more">("");
  const [error, setError] = useState("");
  const [llm, setLlm] = useState<Llm | null>(null);
  const elapsed = useElapsed(!!busy);
  const old = !kept ? [...(saved ?? [])].reverse().find((d) => d && typeof d === "object" && "intro" in (d as object)) : undefined;

  // The steer Loom would pick for this moment, from code alone: a ring on its chip, never a pick.
  useEffect(() => {
    if (!open || !picking || !known || suggested) return;
    post<{ suggested: Steer }>("/api/develop/suggest", { entryId: known })
      .then((r) => setSuggested(r.suggested))
      .catch(() => {});
  }, [open, picking, known, suggested]);

  const write = async (how: { steer: Steer | null; words: string }, more = false) => {
    setBusy(more ? "more" : "new");
    setError("");
    setPicking(false);
    setSteer(how.steer);
    setWords(how.words);
    if (!more) setLlm(null);
    const offset = more ? slots.length : 0;
    // The take's place is there at once: a step-shaped space Loom's words type into while it writes.
    setSlots((cur) => [...(more ? cur : []), { steps: [] }]);
    try {
      const id = entryId ?? (await parent());
      if (!id) throw new Error("Couldn't log that choice first.");
      setEntryId(id);
      const done = await stream<{ devId: number | null; llm: Llm }>(
        "/api/develop/chain",
        {
          entryId: id,
          steer: how.steer,
          words: how.words || undefined,
          count: more ? 1 : prefs.developOptions,
          devId: more ? (devId ?? undefined) : undefined,
          exclude: more ? slots.flatMap((s) => (s.chain ? [s.chain.move] : [])) : undefined,
          model: developModel(live.model),
          tone: live.tone,
          surprises: prefs.surprises,
        },
        (e) => {
          // Chains are numbered as they stream; shown in order, after any already on screen.
          const at = offset + Number(e.index ?? 0) % 10;
          setSlots((cur) => {
            const next = [...cur];
            const slot: Slot = { ...(next[at] ?? { steps: [] }) };
            if (e.type === "step") slot.steps = Object.assign([...slot.steps], { [Number(e.n)]: e.step as Step });
            if (e.type === "chain") Object.assign(slot, { chain: e.chain as Chain, steps: (e.chain as Chain).steps });
            // A take shown and then withdrawn goes up in smoke, then its place closes.
            if (e.type === "drop") {
              const gone = { ...slot, dropped: true };
              next[at] = gone;
              setTimeout(() => setSlots((c) => c.filter((x) => x !== gone)), 2000);
              return next;
            }
            next[at] = slot;
            return next;
          });
        },
      );
      if (done.devId) setDevId(done.devId);
      setLlm(done.llm);
      await live.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      // Anything that never completed (a step shown, then the answer went wrong) goes up in smoke.
      setSlots((cur) => cur.map((s) => (s.chain || s.dropped ? s : { ...s, dropped: true })));
      setTimeout(() => setSlots((cur) => cur.filter((s) => s.chain)), 2000);
      setBusy("");
    }
  };

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-tertiary text-sm" title={kept || old ? "Developed before: open to see it" : "Take this further"}>
        <Icon name="branch" /> Develop{kept || old ? <span className="h-1.5 w-1.5 rounded-full bg-thread" /> : null}
      </button>
    );

  const chains = slots;
  // What Loom draws in while it writes a take: the way you chose to take it, and the choice's words.
  const developing = live.entries.find((e) => e.id === (entryId ?? known));
  const pending = [...keyWords(words.trim() || STEERS.find((x) => x.id === steer)?.label || "", 2), ...keyWords(developing?.choice ?? "", 6)];
  return (
    <div className={`rise mt-1 w-full basis-full ${depth > 0 ? "border-l-2 border-thread/30 py-1 pl-3" : "rounded-xl border border-line bg-background p-3"}`}>
      {picking ? (
        <SteerRow
          suggested={suggested}
          words={words}
          onPick={(s, w) => write({ steer: s, words: w })}
          onClose={() => (slots.length ? setPicking(false) : setOpen(false))}
        />
      ) : (
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>
            {[STEERS.find((s) => s.id === steer)?.label, words && `“${words}”`].filter(Boolean).join(" · ") || "Develop"}
            {busy === "new" && <span className="ml-2 animate-pulse">writing… {elapsed} s</span>}
          </span>
          <span className="flex items-center gap-3">
            {!busy && (
              <button type="button" onClick={() => setPicking(true)} className="btn-tertiary text-xs">
                Change
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="btn-tertiary text-xs">
              Close
            </button>
          </span>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {!picking && (
        <div className="mt-2 space-y-4">
          {chains.map((slot, i) => (
            <ChainCard
              key={`take-${i}`}
              pending={pending}
              slot={slot}
              index={i}
              devId={devId}
              entryId={entryId}
              live={live}
              depth={depth}
              writing={!!busy && !slot.chain}
              onChange={(chain) => setSlots((cur) => cur.map((s, j) => (j === i ? { steps: chain.steps, chain } : s)))}
            />
          ))}
          {!busy && chains.length > 0 && devId && (
            <button type="button" onClick={() => write({ steer, words }, true)} className="drop-in btn-tertiary text-xs" style={{ animationDelay: "1.4s" }}>
              <Icon name="plus" size={12} /> Another take
            </button>
          )}
          {llm && (
            <p className="text-[11px] text-muted">
              {prefs.costs && `${llm.model.replace(/^claude-/, "")} · ${llm.seconds.toFixed(1)} s · $${llm.costUsd.toFixed(4)}`}
            </p>
          )}
        </div>
      )}
      {!!old && picking && <OldPlan plan={old as OldPlanShape} />}
    </div>
  );
}

// How do you want to take this? One tap starts it; or say it in your own words.
function SteerRow({ suggested, words: initial, onPick, onClose }: { suggested: Steer | null; words: string; onPick: (s: Steer | null, words: string) => void; onClose: () => void }) {
  const [words, setWords] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium">How do you want to take this?</p>
        <button type="button" onClick={onClose} className="btn-tertiary text-xs">
          Close
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {STEERS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.id, words.trim())}
            title={s.id === suggested ? "Loom's suggestion for this moment" : undefined}
            className={`rounded-full border px-3 py-1 text-[13px] transition-colors hover:border-thread/60 ${s.id === suggested ? "border-thread/70 ring-2 ring-thread/25" : "border-line bg-surface"}`}
          >
            {s.label}
            {s.id === suggested && <span className="ml-1.5 text-[11px] text-thread">suggested</span>}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (words.trim()) onPick(null, words.trim());
        }}
      >
        <input
          ref={input}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          placeholder="Or say it: “while they rest at camp”, “bring the guard back”"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] outline-none focus:border-thread/60"
        />
        <button disabled={!words.trim()} className="btn-secondary text-xs">
          Go
        </button>
      </form>
    </div>
  );
}

const REFINES = [
  { how: "shorter", label: "Shorter" },
  { how: "darker", label: "Darker" },
  { how: "lighter", label: "Lighter" },
];

// One chain: numbered steps joined by a line, each ending on the players' turn. Refine it in place;
// use a step to log it (earlier steps are used first, so the tree stays in order).
function ChainCard({ slot, pending, index, devId, entryId, live, depth, writing, onChange }: { slot: Slot; pending: string[]; index: number; devId: number | null; entryId: number | null; live: Live; depth: number; writing: boolean; onChange: (c: Chain) => void }) {
  const showWhy = usePrefs().why;
  const chain = slot.chain;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saying, setSaying] = useState<"" | "how" | "bring">("");
  const [reworking, setReworking] = useState(false); // the rework controls, folded until asked for
  const [how, setHow] = useState("");
  const [preview, setPreview] = useState<Step[] | null>(null); // a swap streaming in
  const [using, setUsing] = useState<number | null>(null);
  const elapsed = useElapsed(!!busy);
  const steps = preview ?? slot.steps;
  // The wording each step last finished writing in. A step whose text differs (just streamed, or
  // reworked) is written in over what was there; one that matches is shown as it is.
  const [settled, setSettled] = useState<string[]>(() => (slot.chain ? slot.steps.map((x) => x.text) : []));
  const settle = (i: number, text: string) =>
    setSettled((cur) => {
      const next = [...cur];
      next[i] = text;
      return next;
    });
  // The take is finished once it's complete and every step has been written in (a step being
  // reworked still counts: its old wording is there until the new is written over it).
  const ready = !!chain && !writing && !slot.dropped && steps.length > 0 && steps.every((_, i) => !!settled[i]);
  // Each step's element, to bring one to the middle of the screen once it's used.
  const stepEls = useRef<(HTMLLIElement | null)[]>([]);
  // Withdrawn: it goes up in smoke, then its place closes.
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = card.current;
    if (!slot.dropped || !el) return;
    el.style.maxHeight = `${el.offsetHeight}px`;
    const t = setTimeout(() => el.classList.add("closing"), 1300);
    return () => clearTimeout(t);
  }, [slot.dropped]);

  // The logged entry for each step already used: step i's entry is a child of step i-1's.
  const usedEntries: (Entry | undefined)[] = [];
  let parentId = entryId;
  for (const s of steps) {
    const e = parentId == null ? undefined : live.entries.find((x) => x.parentId === parentId && x.choiceKind === "branch" && x.choice === stepText(s));
    usedEntries.push(e);
    parentId = e?.id ?? null;
  }

  const refine = async (h: string, fromStep?: number) => {
    if (!chain || !devId || !entryId) return;
    setBusy(fromStep != null ? `swap${fromStep}` : h);
    setError("");
    setSaying("");
    if (fromStep != null) {
      setPreview(steps.slice(0, fromStep));
      // The new steps from here are written in fresh, not over the old wording.
      setSettled((cur) => cur.slice(0, fromStep));
    }
    try {
      const done = await stream<{ chain: Chain }>(
        "/api/develop/refine",
        { entryId, devId, chain: index, how: h, fromStep, model: developModel(live.model), tone: live.tone },
        (e) => {
          if (e.type === "step" && fromStep != null) setPreview((p) => Object.assign([...(p ?? [])], { [Number(e.n)]: e.step as Step }));
        },
      );
      onChange(done.chain);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rework that.");
    } finally {
      setPreview(null);
      setBusy("");
    }
  };
  const back = async () => {
    if (!devId || !entryId) return;
    const r = await post<{ chain: Chain }>("/api/develop/back", { entryId, devId, chain: index });
    onChange(r.chain);
  };
  const logStep = async (k: number) => {
    if (!chain || entryId == null) return;
    setUsing(k);
    try {
      let pid = entryId;
      for (let i = 0; i <= k; i++) {
        const done = usedEntries[i];
        if (done) {
          pid = done.id;
          continue;
        }
        const r = await post<{ entry: Entry }>("/api/live/branch", { parentId: pid, label: i === 0 ? chain.label : `${chain.label} · ${i + 1}`, text: stepText(steps[i]) });
        pid = r.entry.id;
      }
      await live.reload();
      live.focusBox("What happened next?");
      // The step just used comes to the middle of the screen and stays there.
      requestAnimationFrame(() => live.center(stepEls.current[k]));
    } finally {
      setUsing(null);
    }
  };

  return (
    <article ref={card} className={slot.dropped ? "closable" : undefined} aria-hidden={slot.dropped || undefined}>
      {chain && (
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide">{chain.label}</h3>
          {chain.flavour && <span className="rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread">{FLAVOUR[chain.flavour] ?? chain.flavour}</span>}
          {chain.surprise && <span className="rounded-full border border-thread/50 px-2 py-0.5 text-[11px] text-thread" title={chain.surprise}>Surprise</span>}
        </div>
      )}
      <ol className={`relative ml-2.5 border-l border-thread/40 ${slot.dropped ? "smoke-fade" : ""}`}>
        {/* Before its first step, step 1 is already there with no text: the take's place, with
            Loom's words typing in. It's the same element the step's text then writes into. */}
        {(steps.length || slot.dropped ? steps : [{ text: "" } as Step]).map((s, i) => {
          const used = usedEntries[i];
          const written = settled[i] === s.text;
          const waiting = !s.text;
          return (
            <li
              key={`step-${i}`}
              ref={(el) => {
                stepEls.current[i] = el;
              }}
              className="relative rounded-lg pb-3 pl-5 last:pb-1"
            >
              <span className={`absolute -left-[9px] top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-semibold ${used ? "bg-thread text-background" : "border border-thread/50 bg-background text-thread"}`}>
                {used ? <Icon name="check" size={10} /> : i + 1}
              </span>
              <p className={`text-[11px] font-semibold uppercase tracking-wide text-muted ${s.when ? "drop-in" : "hidden"}`}>{s.when?.replace(/:$/, "")}</p>
              <p className="story steady text-[16px] leading-relaxed">
                {slot.dropped ? (
                  <Smoke text={s.text} seed={index * 97 + i * 11} at={i * 90} />
                ) : written && !waiting ? (
                  <Linked text={s.text} />
                ) : (
                  <WriteIn
                    // The first writing continues from the placeholder; a rework starts afresh over the old words.
                    key={settled[i] ? `re-${s.text}` : "first"}
                    from={settled[i] ? settled[i].split(/\s+/) : i === 0 ? (index === 0 ? pending : pending.slice(2)) : []}
                    fromShown={!!settled[i]}
                    text={waiting ? undefined : s.text}
                    seed={index * 97 + i * 11 + 1}
                    onDone={() => settle(i, s.text)}
                  />
                )}
              </p>
              {/* The step's buttons keep their place from the start, so they fade in when the take
                  is finished without moving anything. */}
              {!slot.dropped && (
                <div aria-hidden={!ready || !!busy || undefined} className={`mt-1 flex flex-wrap items-center gap-3 text-xs transition-opacity duration-300 ${ready && !busy ? "opacity-100" : "pointer-events-none opacity-0"}`}>
                  {used ? (
                    <span className="text-thread">
                      <Icon name="check" size={12} /> Used{used.status === "extracting" ? " · adding to the loom…" : ""}
                    </span>
                  ) : (
                    <button type="button" disabled={!ready || using != null || entryId == null} onClick={() => logStep(i)} className="btn-secondary text-xs font-medium">
                      {using === i ? "Logging…" : i > 0 && !usedEntries[i - 1] ? `Use steps 1–${i + 1}` : "Use this step"}
                    </button>
                  )}
                  {!used && (
                    <button type="button" onClick={() => refine("swap", i)} className="btn-tertiary text-xs" title="Rewrite from this step on, keeping the ones before">
                      Swap from here
                    </button>
                  )}
                  {used && s.needs === "fight" && (
                    <div className="w-full">
                      <FightPanel entryId={used.id} campaignId={live.campaignId} initial={(used.encounter as Encounter) ?? null} onChange={live.reload} />
                    </div>
                  )}
                  {used && depth < 4 && <Develop live={live} parent={async () => used.id} known={used.id} saved={used.developments} depth={depth + 1} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* What sits under a take (its threads, why, Rework) opens smoothly once every step is
          written, and stays open while a rework rewrites them. */}
      <div className={`reveal ${ready ? "shown" : ""}`}>
        <div>
      {chain && (
        <>
          <RefChips refs={[...threadRefs(chain.threads), ...(chain.callback ? [{ kind: "moment" as const, id: chain.callback.id, name: `Callback: ${chain.callback.title}` }] : [])]} />
          {chain.why && showWhy && <p className="mt-1.5 text-[13px] italic text-muted">{chain.why}</p>}
          {/* Refine in place, folded behind one button: one version on screen, Back to the one before. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            <button type="button" disabled={!!busy} onClick={() => setReworking(!reworking)} aria-expanded={reworking} className="btn-tertiary px-1.5 text-[12px]">
              <Icon name="pen" size={12} /> Rework
            </button>
            {chain.canGoBack && !busy && !reworking && (
              <button type="button" onClick={back} className="btn-tertiary px-1.5 text-[12px]" title="The version before the last change">
                <Icon name="undo" size={12} /> Back
              </button>
            )}
            {busy && <Reading final={`Reworking · ${elapsed} s`} />}
          </div>
          {reworking && (
          <div className="rise mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
            {REFINES.map((r) => (
              <button key={r.how} type="button" disabled={!!busy} onClick={() => refine(r.how)} className="rounded-full border border-line px-2.5 py-0.5 hover:border-thread/60 disabled:opacity-40">
                {busy === r.how ? `${r.label}… ${elapsed} s` : r.label}
              </button>
            ))}
            <button type="button" disabled={!!busy} onClick={() => setSaying(saying === "bring" ? "" : "bring")} className="rounded-full border border-line px-2.5 py-0.5 hover:border-thread/60 disabled:opacity-40">
              Bring in…
            </button>
            <button type="button" disabled={!!busy} onClick={() => setSaying(saying === "how" ? "" : "how")} className="btn-tertiary px-1.5 text-[12px]">
              Say how
            </button>
            {chain.canGoBack && !busy && (
              <button type="button" onClick={back} className="btn-tertiary px-1.5 text-[12px]" title="The version before the last change">
                <Icon name="undo" size={12} /> Back
              </button>
            )}
          </div>
          )}
          {reworking && saying && (
            <form
              className="rise mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (how.trim()) void refine(saying === "bring" ? `bring in ${how.trim()}` : how.trim());
                setHow("");
              }}
            >
              <input
                autoFocus
                value={how}
                onChange={(e) => setHow(e.target.value)}
                placeholder={saying === "bring" ? "Who? A name from the campaign" : "How should it change?"}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] outline-none focus:border-thread/60"
              />
              <button disabled={!how.trim()} className="btn-secondary text-xs">
                {saying === "bring" ? "Bring in" : "Rework"}
              </button>
            </form>
          )}
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </>
      )}
        </div>
      </div>
    </article>
  );
}

// A result from the old Develop (open / set up / lead to), kept read-only.
type OldPlanShape = { intro?: string; setups?: { title: string; text: string }[]; directions?: { title: string; text: string }[] };
function OldPlan({ plan }: { plan: OldPlanShape }) {
  return (
    <details className="mt-3 text-[13px] text-muted">
      <summary className="cursor-pointer">Developed before (older layout)</summary>
      <div className="story mt-1.5 space-y-1.5">
        {plan.intro && <p className="italic">{plan.intro}</p>}
        {[...(plan.setups ?? []), ...(plan.directions ?? [])].map((x) => (
          <p key={x.title}>
            <span className="font-medium">{x.title}.</span> {x.text}
          </p>
        ))}
      </div>
    </details>
  );
}
