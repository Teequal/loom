"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Choice, Field, Steps, Switch, Tune } from "./controls";
import { Icon } from "./icons";
import { type Encounter, FightPanel } from "./fight";
import { ResultPrompt } from "./results";
import { Linked, LoomProvider, RefChips, useLoom } from "./loom-ui";
import { Header, Note, post, store, useCampaigns, useElapsed } from "./shell";

// The table page: type what the players just did, get options tied back to threads (each shown
// the moment it's written), use one or write your own, and Loom adds it to the loom straight
// away so the next suggestion knows. Develop any choice and keep going from what it suggests:
// the session grows as a tree, shown in the timeline. Every name links into the loom.

interface Card {
  headline: string;
  flavour: string | null;
  label: string;
  text: string;
  why: string;
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
  needs: "roll" | "fight" | null;
  pillar: string | null;
}
interface RecordFix {
  say: string;
  apply: string;
  fix: { kind: "condition"; entityId: number; condition: string } | { kind: "holds"; holderId: number; itemId: number };
}
interface Done {
  entryId: number;
  count: number;
  fixes: RecordFix[];
  steers: string[];
  safetyNote: string | null;
  llm: { model: string; seconds: number; costUsd: number; attempts: number };
}
interface Question {
  n: number;
  group: string;
  summary: string;
  reasons: string[];
  evidence: string;
}
interface Plan {
  reach: string;
  intro: string;
  setups: { title: string; text: string; threads: { id: number; title: string }[] }[];
  directions: { title: string; text: string; threads: { id: number; title: string }[] }[];
  newThread?: { title: string; summary: string } | null;
  llm: { model: string; seconds: number; costUsd: number };
}
interface Entry {
  id: number;
  parentId: number | null;
  moment: string;
  choiceKind: "option" | "own" | "branch" | "result" | null;
  choiceLabel: string;
  choice: string;
  status: "asked" | "extracting" | "done" | "failed";
  summary: string[];
  questions: Question[];
  developments: Plan[];
  awaiting: "roll" | "fight" | null;
  resultState: "pending" | "given" | "skipped" | null;
  encounter: unknown;
  at: string;
}
type Status = "idle" | "running" | "done" | "error";

const MODELS = [
  { id: "haiku", label: "Quick", hint: "Haiku · ~3 s to the first option" },
  { id: "sonnet", label: "Balanced", hint: "Sonnet · a middle ground" },
  { id: "opus", label: "Best", hint: "Opus · slower, pulls in more that fits" },
] as const;
type Model = (typeof MODELS)[number]["id"];
const TONES = ["Grounded", "Restrained", "Balanced", "Dramatic", "Theatrical"];
// Which kinds of option to offer. Most DMs never change the default mix.
const MIXES = [
  { id: "mix", label: "Mix", hint: "One payoff, one twist, one callback or character beat" },
  { id: "fights", label: "Action", hint: "More fights and danger" },
  { id: "mystery", label: "Mystery", hint: "Reveal and deepen mysteries" },
  { id: "light", label: "Light", hint: "Funny and warm" },
  { id: "character", label: "Character", hint: "Moments for the player characters" },
] as const;
type MixId = (typeof MIXES)[number]["id"];
const FLAVOUR_LABEL: Record<string, string> = { payoff: "Payoff", twist: "Twist", callback: "Callback", character: "Character", tense: "Tense", funny: "Funny", mystery: "Mystery", fight: "Fight" };
const REACH = ["Next few minutes", "This scene", "Next session", "The arc"];
const threadRefs = (ts: { id: number; title: string }[]) => ts.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }));

export function ImprovBox() {
  const c = useCampaigns();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-24 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}
      {c.campaignId && (
        <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
          <Table campaignId={c.campaignId} name={c.campaigns.find((x) => x.id === c.campaignId)?.name ?? ""} trySample={c.sample} />
        </LoomProvider>
      )}
    </main>
  );
}

// Everything the table needs to log a choice or a branch, shared by cards, the timeline and Develop.
interface Live {
  campaignId: number;
  entries: Entry[];
  reload: () => Promise<Entry[]>;
  model: Model;
  tone: number;
  focusBox: (placeholder?: string) => void;
}

// "Can she…?", "Does that provoke…?", "How does … work": likely a rules question, not a moment.
const RULES_QUESTION =
  /^(?:can|could|does|do|is|are|how (?:does|do|much|many|far|long)|what (?:happens|does|is the rule)|when (?:does|do)|if (?:a|an|she|he|they)\b)[^]*\?$|\b(?:provoke|opportunity attack|concentration|advantage|disadvantage|saving throw|bonus action|reaction|cover|grapple|RAW|rules? (?:for|on|say))\b[^]*\?$/i;

// Moments to try in the sample campaign, so a first look shows Loom working straight away.
const SAMPLE_MOMENTS = [
  "Bram jumps off the bridge to prove he can't die",
  "Kira writes Ysolde a note demanding the cure",
  "The party decides to rob the Red Hand's toll-house",
];

function Table({ campaignId, name, trySample }: { campaignId: number; name: string; trySample: () => Promise<void> }) {
  const [model, setModel] = useState<Model>("haiku");
  const [tone, setTone] = useState(1);
  const [moment, setMoment] = useState("");
  const [placeholder, setPlaceholder] = useState("What did the players just do?");
  const [asked, setAsked] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [opening, setOpening] = useState<{ title: string; opening: string } | null>(null); // a hook just started
  const [begun, setBegun] = useState<{ title: string; opening: string } | null>(null); // its opening, kept in view until the first moment
  const [showOthers, setShowOthers] = useState(false);
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [steered, setSteered] = useState(""); // the option read in full; the rest are headlines
  const [mix, setMix] = useState<MixId>(() => {
    const m = store.get("loom.mix");
    return MIXES.some((x) => x.id === m) ? (m as MixId) : "mix";
  });
  const [sample, setSample] = useState(false);
  const [open, setOpen] = useState<number | null>(null); // timeline entry shown in detail
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const m = store.get("loom.model");
    const t = Number(store.get("loom.tone"));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- per-browser preferences read once on load
    if (m === "opus" || m === "haiku" || m === "sonnet") setModel(m);
    if (store.get("loom.tone") !== null && t >= 0 && t <= 4) setTone(t);
    box.current?.focus();
  }, []);

  // "/" jumps to the box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reload = useCallback(async () => {
    const r = await post<{ session: number; autoApprove: boolean; empty: boolean; sample: boolean; entries: Entry[] }>("/api/live", { campaignId });
    setSession(r.session);
    setEntries(r.entries);
    setAutoApprove(r.autoApprove);
    setEmpty(r.empty);
    setSample(r.sample);
    return r.entries;
  }, [campaignId]);

  useEffect(() => {
    post<{ session: number; autoApprove: boolean; empty: boolean; sample: boolean; entries: Entry[] }>("/api/live", { campaignId })
      .then((r) => {
        setSession(r.session);
        setEntries(r.entries);
        setAutoApprove(r.autoApprove);
        setEmpty(r.empty);
        setSample(r.sample);
      })
      .catch(() => {});
  }, [campaignId]);

  // When a choice finishes landing in the loom, say so briefly, and make its dot glow.
  const [toasts, setToasts] = useState<{ id: number; entryId: number; title: string; detail: string }[]>([]);
  const [glowing, setGlowing] = useState<Set<number>>(new Set());
  const previous = useRef(new Map<number, Entry["status"]>());
  useEffect(() => {
    const landed = entries.filter((e) => previous.current.get(e.id) === "extracting" && e.status !== "extracting");
    previous.current = new Map(entries.map((e) => [e.id, e.status]));
    if (!landed.length) return;
    const fresh = landed.map((e) => ({
      id: Date.now() + e.id,
      entryId: e.id,
      title:
        e.status === "failed"
          ? "Couldn't add that to the loom"
          : e.summary.length
            ? `Added ${e.summary.length} to the loom${e.questions.length ? ` · ${e.questions.length} to answer` : ""}`
            : "Logged. Nothing new for the loom",
      detail: e.summary[0]?.replace(/^~ progressed: /, "") ?? "",
    }));
    queueMicrotask(() => {
      setToasts((t) => [...t, ...fresh].slice(-3));
      setGlowing(new Set(landed.map((e) => e.id)));
    });
    // Not cleared on the next refresh: the glow always fades, whatever else changes.
    setTimeout(() => setGlowing(new Set()), 2000);
  }, [entries]);

  const closeToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // While a choice is being added to the loom, check back every couple of seconds.
  const extracting = entries.some((e) => e.status === "extracting");
  useEffect(() => {
    if (!extracting) return;
    const t = setInterval(() => reload().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [extracting, reload]);

  // On a phone, the box shrinks to one line while you read further down, and opens again when
  // you tap it or scroll back up.
  const [compact, setCompact] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 639px)");
    const onScroll = () => setCompact(narrow.matches && window.scrollY > 160);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Focus alone doesn't keep it open (it stays focused after asking); typing does.
  const shrunk = compact && !moment && !(focused && window.scrollY < 160);

  const focusBox = useCallback((p?: string) => {
    if (p) setPlaceholder(p);
    box.current?.focus({ preventScroll: true });
  }, []);
  const live: Live = { campaignId, entries, reload, model, tone, focusBox };

  async function ask(again?: { steer: string }) {
    // A steer re-weaves the same moment; otherwise it's whatever is in the box.
    const text = again ? asked : moment.trim();
    if (!text || status === "running") return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAsked(text);
    if (!again) setMoment("");
    setOpenCard(null);
    setSteered(again?.steer ?? "");
    setPlaceholder("What did the players just do?");
    setCards([]);
    setDone(null);
    setError("");
    setOpen(null);
    setShowOthers(false);
    setStatus("running");
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      const res = await fetch("/api/improv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, moment: text, model, tone, mix, steer: again?.steer }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Something went wrong.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "option") setCards((cs) => [...cs, event.option]);
          else if (event.type === "done") setDone(event);
          else if (event.type === "error") throw new Error(event.message);
        }
      }
      setStatus("done");
      await reload();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  const current = done ? entries.find((e) => e.id === done.entryId) : undefined;

  // Uses an option (or your own) for the moment just asked. Changing your mind undoes the old pick.
  async function use(choice: { kind: "option" | "own"; label: string; text: string; awaiting?: "roll" | "fight" | null }) {
    if (!current) return null;
    setError("");
    try {
      if (current.choiceKind) await post("/api/live/clear", { entryId: current.id });
      await post("/api/live/choice", { entryId: current.id, ...choice });
      setShowOthers(false);
      await reload();
      focusBox("What happened next?");
      // Keep the chosen card in view once the others fold away.
      requestAnimationFrame(() => document.getElementById("chosen")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return current.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't log that.");
      return null;
    }
  }

  const pending = status === "running" ? Math.max(0, 3 - cards.length) : 0;
  const questions = entries.flatMap((e) => e.questions.map((q) => ({ ...q, entry: e })));
  const waiting = entries.filter((e) => e.awaiting).reverse();

  return (
    <>
      {session != null && <Timeline session={session} live={live} open={open} setOpen={setOpen} glowing={glowing} />}
      <Toasts
        toasts={toasts}
        onOpen={(entryId) => {
          setOpen(entryId);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        onClose={closeToast}
      />

      {/* The box stays in reach: it sticks to the top while you read options further down. Open
          questions sit right above it until they're answered. */}
      <div className="sticky top-0 z-20 -mx-4 bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
        {questions.length > 0 && <QuestionTray questions={questions} reload={reload} campaignId={campaignId} autoApprove={autoApprove} setAutoApprove={setAutoApprove} />}
        {/* Then any roll or fight still waiting for how it turned out (newest first). */}
        {!questions.length && waiting.length > 0 && (
          <div className="mb-2">
            <ResultPrompt
              key={waiting[0].id}
              entryId={waiting[0].id}
              kind={waiting[0].awaiting!}
              label={waiting[0].choiceLabel ? `${waiting[0].choiceLabel}: ${waiting[0].choice}` : waiting[0].choice}
              count={waiting.length > 1 ? `1 of ${waiting.length}` : undefined}
              onDone={reload}
              folded={waiting[0].id === current?.id || waiting[0].parentId === current?.id}
            />
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
          className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-thread/60"
        >
          <label htmlFor="moment" className="sr-only">
            What did the players just do?
          </label>
          <textarea
            id="moment"
            ref={box}
            rows={shrunk ? 1 : Math.min(6, Math.max(2, Math.ceil(moment.length / 70) + (moment.match(/\n/g)?.length ?? 0)))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            value={moment}
            onChange={(e) => setMoment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask();
              }
            }}
            placeholder={placeholder}
            className={`block w-full resize-none bg-transparent px-4 text-[17px] leading-relaxed outline-none placeholder:text-muted/70 ${shrunk ? "py-2.5" : "pt-3"}`}
          />
          <div className={`items-center justify-between gap-3 px-2 pb-2 pt-0.5 ${shrunk ? "hidden" : "flex"}`}>
            {/* Everything you might tune lives behind one quiet control, out of the way of the box. */}
            <Tune label="Tune suggestions" summary={`${MODELS.find((m) => m.id === model)?.label} · ${TONES[tone]}${mix !== "mix" ? ` · ${MIXES.find((m) => m.id === mix)?.label}` : ""}`}>
              <Field label="Model">
                <Choice
                  label="Model"
                  options={MODELS}
                  value={model}
                  onChange={(v) => {
                    setModel(v);
                    store.set("loom.model", v);
                  }}
                />
                <p className="mt-1 text-xs text-muted">{MODELS.find((m) => m.id === model)?.hint}</p>
              </Field>
              <Field label="Kinds of option">
                <Choice
                  label="Kinds of option"
                  options={MIXES}
                  value={mix}
                  onChange={(v) => {
                    setMix(v);
                    store.set("loom.mix", v);
                  }}
                />
              </Field>
              <Field label="Tone">
                <Steps
                  label="Tone"
                  steps={TONES}
                  value={tone}
                  onChange={(v) => {
                    setTone(v);
                    store.set("loom.tone", String(v));
                  }}
                />
              </Field>
              <Field label="Risky changes">
                <Switch
                  checked={!autoApprove}
                  onChange={async (ask) => {
                    setAutoApprove(!ask);
                    await post("/api/campaign/save", { campaignId, autoApprove: !ask });
                  }}
                  hint="Deaths, secrets, items changing hands, closing a thread"
                >
                  Ask me before recording them
                </Switch>
              </Field>
              <p className="text-[11px] text-muted">Enter asks · Shift+Enter for a new line · / brings you back to the box</p>
            </Tune>
            <button
              type="submit"
              disabled={!moment.trim() || status === "running"}
              title="Enter"
              className="btn-primary shrink-0 text-sm"
            >
              {status === "running" ? "Weaving…" : "Find threads"}
            </button>
          </div>
        </form>
      </div>

      {/* Reads like a rules question? Offer the rules panel; never reroute on its own. */}
      {RULES_QUESTION.test(moment.trim()) && (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("loom:rules", { detail: moment.trim() }));
            setMoment("");
          }}
          className="btn-secondary rise mt-1 text-[13px]"
        >
          Ask as a rules question
        </button>
      )}
      {!asked && (empty || opening) && (
        <Welcome
          name={name}
          trySample={trySample}
          campaignId={campaignId}
          opening={opening}
          onStarted={async (o) => {
            setOpening(o);
            await reload();
          }}
          onBegin={() => {
            setBegun(opening);
            setOpening(null);
            focusBox("What do the players do?");
          }}
        />
      )}
      {!asked && begun && !opening && (
        <div className="rise mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{begun.title} · the opening</p>
          <blockquote className="story mt-1.5 border-l-2 border-line pl-3 text-[15px] leading-relaxed text-muted">
            <Linked text={begun.opening} />
          </blockquote>
        </div>
      )}
      {!asked && sample && !entries.length && (
        <div className="rise mt-5">
          <p className="mb-2 text-[13px] text-muted">This is the sample campaign: two players drank mystery potions. Try one of these, or type your own.</p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_MOMENTS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMoment(m);
                  focusBox();
                }}
                className="story btn-secondary text-[14px] italic"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {asked && (
        <section aria-live="polite" className="mt-6">
          <p className="story mb-4 border-l-2 border-thread pl-3 italic text-muted">
            <Linked text={asked} />
          </p>

          {done?.safetyNote && <Note>{done.safetyNote}</Note>}

          <ol className="space-y-3">
            {cards.map((card, i) => {
              const state = !current?.choiceKind ? "open" : current.choiceKind === "option" && current.choice === card.text ? "used" : "other";
              // Once you've chosen, the rest fold away so the page follows the story, not the menu.
              if (state === "other" && !showOthers) return null;
              // Headlines first: only the one you open (or the one you used) is shown in full.
              if (state === "open" && openCard !== i)
                return <Headline key={`${card.label}-${i}`} card={card} n={i + 1} onOpen={() => setOpenCard(i)} />;
              return (
                <OptionCard
                  key={`${card.label}-${i}`}
                  card={card}
                  n={i + 1}
                  of={cards.length}
                  onMove={state === "open" ? (d) => setOpenCard((i + d + cards.length) % cards.length) : undefined}
                  onFold={state === "open" ? () => setOpenCard(null) : undefined}
                  state={state}
                  canUse={!!current}
                  onUse={() => use({ kind: "option", label: card.label, text: card.text, awaiting: card.needs })}
                  live={live}
                  moment={asked}
                  // Developing a card you haven't used yet uses it first, so what grows from it has a parent.
                  parent={async () => (state === "used" ? current!.id : await use({ kind: "option", label: card.label, text: card.text, awaiting: card.needs }))}
                  saved={state === "used" ? current?.developments : undefined}
                />
              );
            })}
            {Array.from({ length: pending }, (_, i) => (
              <li key={`pending-${i}`} aria-hidden className="h-12 animate-pulse rounded-xl border border-line bg-surface/60" />
            ))}
          </ol>
          {current?.choiceKind && cards.some((c) => !(current.choiceKind === "option" && current.choice === c.text)) && (
            <button type="button" onClick={() => setShowOthers(!showOthers)} className="btn-tertiary mt-2 flex text-sm">
              {showOthers ? "Fold the other options" : `${cards.filter((c) => !(current.choiceKind === "option" && current.choice === c.text)).length} other options`}
              <Icon name="arrow" size={12} className={`transition-transform ${showOthers ? "-rotate-90" : "rotate-90"}`} />
            </button>
          )}

          {/* One tap re-weaves the options: no typing. */}
          {status === "done" && !current?.choiceKind && !!done?.steers.length && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px]">
              <span className="mr-1 text-xs text-muted">{steered ? `Re-woven: ${steered}. Again:` : "Not quite?"}</span>
              {done.steers.map((st) => (
                <button key={st} type="button" onClick={() => ask({ steer: st })} className="rounded-full border border-line bg-surface px-3 py-0.5 text-foreground/80 hover:border-thread/60">
                  {st}
                </button>
              ))}
            </div>
          )}

          {status === "done" && current && <OwnChoice entry={current} onSave={(text) => use({ kind: "own", label: "", text })} />}
          {current?.choiceKind && <LoomStatus entry={current} />}
          {/* A fight gets its setup up front; anything else can still become one, quietly. */}
          {current?.choiceKind && (
            <div className="mt-3">
              <FightPanel
                key={current.id}
                entryId={current.id}
                campaignId={campaignId}
                initial={(current.encounter as Encounter) ?? null}
                onChange={reload}
                quiet={current.awaiting !== "fight" && !current.encounter}
              />
            </div>
          )}
          {current && <Branches parent={current} live={live} />}

          {/* Arrives with the last option, so it goes below the cards rather than shifting them. */}
          {!!done?.fixes.length && (
            <div className="mt-3 space-y-2">
              {done.fixes.map((f) => (
                <RecordNote key={f.say} campaignId={campaignId} note={f} />
              ))}
            </div>
          )}

          {status === "done" && cards.length === 0 && (
            <p className="mt-4 text-sm text-muted">No options got past the checks this time. Try rephrasing the moment, ask again, or write what happened yourself.</p>
          )}
          {error && <p className="mt-4 text-sm text-danger">{error}</p>}
          {done && (
            <p className="mt-5 text-xs text-muted">
              {done.llm.model.replace(/^claude-/, "")} · {done.llm.seconds.toFixed(1)} s · ${done.llm.costUsd.toFixed(4)}
              {done.llm.attempts > 1 ? ` · ${done.llm.attempts} attempts` : ""}
            </p>
          )}
        </section>
      )}
      {!asked && error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </>
  );
}

// The moment and the records disagreed. Loom went with the moment for these options; say so, and
// let the GM settle it in one tap: record it, or keep it to this moment. Either way, play on.
function RecordNote({ campaignId, note }: { campaignId: number; note: RecordFix }) {
  const [state, setState] = useState<"" | "busy" | "saved" | "kept">("");
  const loom = useLoom();
  if (state === "kept") return null;
  return (
    <div className="rise flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
      <Icon name="sparkle" className="text-thread" />
      <span className="min-w-0 flex-1 text-muted">{state === "saved" ? "Recorded. Your records match this moment now." : <Linked text={note.say} />}</span>
      {state !== "saved" && (
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                await post("/api/records", { campaignId, fix: note.fix });
                setState("saved");
                loom?.reload();
              } catch {
                setState("");
              }
            }}
            className="btn-secondary text-xs"
          >
            {note.apply}
          </button>
          <button type="button" onClick={() => setState("kept")} className="btn-tertiary text-xs" title="Keep the records as they are">
            Just this moment
          </button>
        </span>
      )}
    </div>
  );
}

// ---------- notices ----------

// Quiet notices at the bottom: what just landed in the loom. Tap one to open that moment.
function Toasts({ toasts, onOpen, onClose }: { toasts: { id: number; entryId: number; title: string; detail: string }[]; onOpen: (entryId: number) => void; onClose: (id: number) => void }) {
  // Each notice stays about six seconds from when it appeared.
  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => onClose(t.id), Math.max(0, 6000 - (Date.now() - t.id))));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onClose]);
  if (!toasts.length) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} className="rise pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
          <Icon name="sparkle" className="mt-0.5 text-thread" />
          <button type="button" onClick={() => onOpen(t.entryId)} className="min-w-0 flex-1 text-left">
            <p className="text-sm font-medium">{t.title}</p>
            {t.detail && <p className="story truncate text-[13px] text-muted">{t.detail}</p>}
          </button>
          <button type="button" onClick={() => onClose(t.id)} aria-label="Dismiss" className="btn-tertiary">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- first run ----------

// An empty campaign: three ways in, each one tap.
function Welcome({
  name,
  trySample,
  campaignId,
  opening,
  onStarted,
  onBegin,
}: {
  name: string;
  trySample: () => Promise<void>;
  campaignId: number;
  opening: { title: string; opening: string } | null;
  onStarted: (o: { title: string; opening: string }) => Promise<void>;
  onBegin: () => void;
}) {
  const [busy, setBusy] = useState<"" | "hook" | "sample">("");
  const [party, setParty] = useState("");
  const [theme, setTheme] = useState("");
  const [error, setError] = useState("");
  const elapsed = useElapsed(busy === "hook");

  // Just started from a hook: the opening, to read aloud, then straight to the table.
  if (opening)
    return (
      <section className="rise mt-8 rounded-2xl border border-line bg-surface p-6">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">{opening.title}</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">Read this to your players</h2>
        <blockquote className="story mt-3 border-l-2 border-thread pl-4 text-[18px] leading-relaxed">
          <Linked text={opening.opening} />
        </blockquote>
        <p className="mt-3 text-sm text-muted">The world is in the loom: its characters, places and threads. When the players do something, type it in the box above.</p>
        <button type="button" onClick={onBegin} className="btn-primary mt-4 text-sm">
          Begin <Icon name="arrow" size={12} />
        </button>
      </section>
    );

  return (
    <section className="rise mt-8 rounded-2xl border border-line bg-surface p-6">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">New campaign</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight">{name ? `Welcome to ${name}` : "Welcome"}</h2>
      <p className="story mt-2 max-w-prose leading-relaxed text-foreground/85">
        When your players go off-script, Loom finds the threads already in play and shows you how to tie the moment back to them. To do that it needs something to remember.
      </p>

      <div className="mt-5 rounded-xl border border-thread/40 bg-thread-soft/30 p-4">
        <p className="font-medium">Start from a hook</p>
        <p className="text-sm text-muted">Never run a game before? Loom invents a small world to begin in: a place, a few characters, and threads that tangle together.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            value={party}
            onChange={(e) => setParty(e.target.value)}
            placeholder="Who's playing? (optional) e.g. Mira the rogue, Tobb the cleric"
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
          />
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="Any flavour? (optional) e.g. haunted harbour"
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
          />
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            setBusy("hook");
            setError("");
            try {
              const r = await post<{ title: string; opening: string }>("/api/campaigns/hook", { campaignId, party, theme });
              await onStarted({ title: r.title, opening: r.opening });
            } catch (e) {
              setError(e instanceof Error ? e.message : "Something went wrong.");
            } finally {
              setBusy("");
            }
          }}
          className="btn-primary mt-3 text-sm"
        >
          <Icon name="sparkle" /> {busy === "hook" ? `Inventing a world… ${elapsed} s` : party.trim() || theme.trim() ? "Invent the hook" : "Start from a random hook"}
        </button>
        {busy === "hook" && <p className="mt-1.5 text-xs text-muted">Usually under a minute. It writes the world, then reads it into the loom.</p>}
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      </div>

      <ol className="mt-5 space-y-4">
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">
            <Icon name="save" size={12} />
          </span>
          <div>
            <p className="font-medium">Already playing? Paste your last session&apos;s notes</p>
            <p className="text-sm text-muted">However rough. Loom picks out the threads, characters and places, and you confirm them.</p>
            <Link href="/prep" className="btn-secondary mt-2 text-sm">
              Add notes <Icon name="arrow" size={12} />
            </Link>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">
            <Icon name="pen" size={12} />
          </span>
          <div>
            <p className="font-medium">Or start at the table</p>
            <p className="text-sm text-muted">Type the first thing that happens in the box above. Everything you use is remembered as you go.</p>
          </div>
        </li>
      </ol>
      <button
        type="button"
        disabled={!!busy}
        onClick={async () => {
          setBusy("sample");
          try {
            await trySample();
          } finally {
            setBusy("");
          }
        }}
        className="btn-tertiary mt-5 text-xs"
      >
        Just looking? Open the sample campaign <Icon name="arrow" size={11} />
      </button>
    </section>
  );
}

// ---------- questions: pinned in view until answered ----------

function QuestionTray({
  questions,
  reload,
  campaignId,
  autoApprove,
  setAutoApprove,
}: {
  questions: (Question & { entry: Entry })[];
  reload: () => Promise<unknown>;
  campaignId: number;
  autoApprove: boolean;
  setAutoApprove: (v: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const q = questions[0];
  const answer = async (yes: boolean) => {
    setBusy(true);
    try {
      await post("/api/live/answer", { entryId: q.entry.id, n: q.n, yes });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alert" className="rise mb-2 rounded-xl border-2 border-thread/70 bg-thread-soft/60 p-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          Needs your answer{questions.length > 1 ? ` · 1 of ${questions.length}` : ""}
        </p>
        <span className="truncate text-xs text-muted">from “{q.entry.choiceLabel || q.entry.moment}”</span>
      </div>
      <p className="mt-1 text-[14.5px]">
        <span className="text-muted">{q.group}: </span>
        <Linked text={q.summary} />
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {q.reasons.join(" · ")}
        {q.evidence && <span className="italic"> · “{q.evidence}”</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => answer(true)} className="btn-primary text-sm">
          Yes, record it
        </button>
        <button type="button" disabled={busy} onClick={() => answer(false)} className="btn-secondary text-sm">
          No
        </button>
        <span className="ml-auto">
          <Switch
            checked={autoApprove}
            onChange={async (v) => {
              setAutoApprove(v);
              await post("/api/campaign/save", { campaignId, autoApprove: v });
            }}
          >
            Auto-approve from now on
          </Switch>
        </span>
      </div>
    </div>
  );
}

// ---------- the session timeline (a tree, drawn flat) ----------

function Timeline({ session, live, open, setOpen, glowing }: { session: number; live: Live; open: number | null; setOpen: (id: number | null) => void; glowing: Set<number> }) {
  const [noting, setNoting] = useState(false);
  const { entries } = live;
  const used = entries.filter((e) => e.choiceKind).length;
  const shown = entries.find((e) => e.id === open);
  const strip = useRef<HTMLOListElement>(null);
  useEffect(() => {
    strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: "smooth" });
  }, [entries.length]);
  // Children sit right after their parent, so a branch reads left to right.
  const ordered: { e: Entry; depth: number }[] = [];
  const kids = new Map<number, Entry[]>();
  for (const e of entries) if (e.parentId != null) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
  const ids = new Set(entries.map((e) => e.id));
  const walk = (e: Entry, depth: number) => {
    ordered.push({ e, depth });
    for (const k of kids.get(e.id) ?? []) walk(k, depth + 1);
  };
  for (const e of entries) if (e.parentId == null || !ids.has(e.parentId)) walk(e, 0);

  return (
    <section aria-label={`Session ${session} so far`} className="mb-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">
          Session {session}
          {entries.length > 0 && <span className="font-normal"> · {used} used</span>}
        </span>
        <ol ref={strip} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]">
          {entries.length === 0 && <li className="text-xs text-muted/70">Nothing yet. What you use at the table lands here.</li>}
          {ordered.map(({ e, depth }) => (
            <li key={e.id} className="flex items-center">
              {depth > 0 && <span aria-hidden className="mr-1 h-px w-2 bg-thread/50" />}
              <button
                type="button"
                onClick={() => setOpen(open === e.id ? null : e.id)}
                aria-label={`${e.choiceKind === "branch" ? "Branch: " : ""}${e.choiceLabel || e.moment}${e.choiceKind ? " (used)" : " (asked)"}`}
                title={e.choiceKind === "branch" ? `Continued: ${e.choiceLabel || e.choice}` : e.moment}
                className={`relative grid place-items-center rounded-full text-[11px] transition-colors ${depth > 0 ? "h-5 w-5" : "h-6 w-6"} ${glowing.has(e.id) ? "glow" : ""} ${open === e.id ? "ring-2 ring-thread/60" : ""} ${
                  e.choiceKind ? "bg-thread-soft text-thread" : "border border-line text-muted/70"
                }`}
              >
                {e.status === "extracting" ? <span className="h-2 w-2 animate-ping rounded-full bg-thread" /> : e.status === "failed" ? "!" : <Icon name={e.choiceKind === "result" ? "diamond" : e.choiceKind === "branch" ? "branch" : e.choiceKind === "own" ? "pen" : e.choiceKind ? "check" : "dot"} size={12} />}
                {(e.questions.length > 0 || e.awaiting) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger" />}
              </button>
            </li>
          ))}
        </ol>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <button type="button" onClick={() => setNoting(!noting)} className="btn-tertiary" title="Log something that happened without asking Loom">
            <Icon name="plus" size={12} /> Note
          </button>
          {used > 0 && (
            <Link href="/prep" className="btn-tertiary" title="Add what Loom didn't see, and close the session">
              Wrap up <Icon name="arrow" size={12} />
            </Link>
          )}
        </div>
      </div>

      {noting && (
        <QuickNote
          campaignId={live.campaignId}
          onDone={async () => {
            setNoting(false);
            await live.reload();
          }}
        />
      )}
      {shown && <EntryDetail entry={shown} live={live} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </section>
  );
}

function QuickNote({ campaignId, onDone }: { campaignId: number; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="rise mt-2 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await post("/api/live/note", { campaignId, text });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't log that.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Something that happened, e.g. “they bought the lockpicks off the fence”"
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
      />
      <button disabled={busy || text.trim().length < 2} className="btn-primary text-sm">
        Log
      </button>
      {error && <span className="self-center text-xs text-danger">{error}</span>}
    </form>
  );
}

function EntryDetail({ entry, live, onClose, onOpen }: { entry: Entry; live: Live; onClose: () => void; onOpen: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const parent = live.entries.find((e) => e.id === entry.parentId);
  const takeBack = async () => {
    setBusy(true);
    try {
      await post("/api/live/clear", { entryId: entry.id });
      await live.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise mt-2 rounded-xl border border-line bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="italic text-muted">
          {parent ? (
            <>
              <Icon name="branch" size={12} /> from{" "}
              <button type="button" onClick={() => onOpen(parent.id)} className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                {parent.choiceLabel || parent.moment}
              </button>
            </>
          ) : (
            <Linked text={entry.moment} />
          )}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" className="btn-tertiary">
          <Icon name="close" />
        </button>
      </div>
      {entry.choiceKind ? (
        <>
          <p className="mt-1.5">
            {entry.choiceLabel && entry.choiceKind !== "result" && <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-wide">{entry.choiceLabel}</span>}
            <Linked text={entry.choice} />
          </p>
          <LoomStatus entry={entry} />
          {(entry.awaiting === "fight" || !!entry.encounter) && (
            <div className="mt-2">
              <FightPanel key={entry.id} entryId={entry.id} campaignId={live.campaignId} initial={(entry.encounter as Encounter) ?? null} onChange={live.reload} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <DevelopToggle live={live} base={{ moment: entry.moment, label: entry.choiceLabel, text: entry.choice, threadIds: [] }} parent={async () => entry.id} saved={entry.developments} />
            <button type="button" onClick={takeBack} disabled={busy} className="btn-tertiary">
              <Icon name="undo" size={12} /> Take back
            </button>
          </div>
          <Branches parent={entry} live={live} onOpen={onOpen} />
        </>
      ) : (
        <p className="mt-1.5 text-xs text-muted">Asked, nothing used.</p>
      )}
    </div>
  );
}

// What grew from a choice: the branches you continued with.
function Branches({ parent, live, onOpen }: { parent: Entry; live: Live; onOpen?: (id: number) => void }) {
  const kids = live.entries.filter((e) => e.parentId === parent.id);
  if (!kids.length) return null;
  return (
    <div className="mt-3 border-l-2 border-thread/40 pl-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Continued with</p>
      <ul className="mt-1 space-y-2">
        {kids.map((k) => (
          <li key={k.id} className="text-[14px]">
            <Icon name="branch" size={12} className="mr-1 text-thread" />
            {/* A result's text already opens with its outcome ("Partly. Only Khayiulad…"). */}
            {k.choiceLabel && k.choiceKind !== "result" && <span className="mr-1 font-medium">{k.choiceLabel}.</span>}
            <Linked text={k.choice} />
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
              <LoomStatus entry={k} compact />
              {onOpen ? (
                <button type="button" onClick={() => onOpen(k.id)} className="text-muted hover:text-foreground">
                  Open
                </button>
              ) : (
                <DevelopToggle live={live} base={{ moment: parent.choice || parent.moment, label: k.choiceLabel, text: k.choice, threadIds: [] }} parent={async () => k.id} saved={k.developments} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// What using a choice did to the loom. Questions live in the tray above the box.
function LoomStatus({ entry, compact = false }: { entry: Entry; compact?: boolean }) {
  if (entry.status === "extracting") return <p className={`${compact ? "" : "mt-3"} animate-pulse text-xs text-muted`}>Adding to the loom…</p>;
  if (entry.status === "failed") return <p className={`${compact ? "" : "mt-3"} text-xs text-danger`}>Couldn&apos;t add this to the loom. It&apos;s still in the session log for wrap-up.</p>;
  if (entry.status !== "done") return null;
  if (compact) return <span className="text-xs text-muted">{entry.summary.length ? `${entry.summary.length} added to the loom` : "Logged"}{entry.questions.length ? ` · ${entry.questions.length} to answer above` : ""}</span>;
  return (
    <div className="mt-3 text-xs text-muted">
      {entry.summary.length ? (
        <details>
          <summary className="cursor-pointer">
            <span className="text-thread">Added to the loom:</span> {entry.summary.length} change{entry.summary.length === 1 ? "" : "s"}
            {entry.questions.length ? ` · ${entry.questions.length} waiting for your answer above` : ""}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {entry.summary.map((s, i) => (
              <li key={i}>
                <Linked text={s} />
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <>Logged. Nothing new for the loom.{entry.questions.length ? ` ${entry.questions.length} waiting for your answer above.` : ""}</>
      )}
    </div>
  );
}

// ---------- the options ----------

// An option as one line: its flavour and its hook. Tap to read it in full.
function Headline({ card, n, onOpen }: { card: Card; n: number; onOpen: () => void }) {
  return (
    <li className="rise">
      <button type="button" onClick={onOpen} className="group flex w-full items-baseline gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:border-thread/60">
        <span className="w-4 shrink-0 text-[13px] text-muted">{n}</span>
        <span className="story min-w-0 flex-1 leading-snug">{card.headline}</span>
        {card.flavour && <span className="shrink-0 rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread">{FLAVOUR_LABEL[card.flavour] ?? card.flavour}</span>}
      </button>
    </li>
  );
}

function OptionCard({
  card,
  n,
  of,
  onMove,
  onFold,
  state,
  canUse,
  onUse,
  live,
  moment,
  parent,
  saved,
}: {
  card: Card;
  n: number;
  of: number;
  onMove?: (d: 1 | -1) => void; // to the next or previous option, while choosing
  onFold?: () => void;
  state: "open" | "used" | "other";
  canUse: boolean;
  onUse: () => void;
  live: Live;
  moment: string;
  parent: () => Promise<number | null>;
  saved?: Plan[];
}) {
  const [copied, setCopied] = useState(false);
  // Swipe sideways between options on a phone.
  const touch = useRef<number | null>(null);
  return (
    <li
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current == null || !onMove) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 60) onMove(dx < 0 ? 1 : -1);
        touch.current = null;
      }}
      id={state === "used" ? "chosen" : undefined}
      className={`rise group scroll-mt-40 rounded-xl border bg-surface p-4 shadow-sm transition-opacity ${state === "used" ? "border-thread/60" : "border-line"} ${state === "other" ? "opacity-55 hover:opacity-100" : ""}`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 text-[13px] font-semibold uppercase tracking-wide">
          <span className="mr-2 text-muted">{state === "used" ? <Icon name="check" className="text-thread" /> : n}</span>
          {card.label}
          {card.flavour && <span className="ml-2 rounded-full bg-thread-soft px-2 py-0.5 text-[11px] font-normal normal-case tracking-normal text-thread">{FLAVOUR_LABEL[card.flavour] ?? card.flavour}</span>}
        </h2>
        {onMove && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
            <button type="button" onClick={() => onMove(-1)} aria-label="Previous option" className="btn-tertiary px-1">
              <Icon name="arrow" size={12} className="rotate-180" />
            </button>
            {n}/{of}
            <button type="button" onClick={() => onMove(1)} aria-label="Next option" className="btn-tertiary px-1">
              <Icon name="arrow" size={12} />
            </button>
            <button type="button" onClick={onFold} aria-label="Back to the headlines" className="btn-tertiary ml-1 px-1">
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(card.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="text-xs text-muted transition-opacity hover:text-foreground focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="story leading-relaxed">
        <Linked text={card.text} />
      </p>
      <RefChips refs={[...threadRefs(card.threads), ...(card.callback ? [{ kind: "moment" as const, id: card.callback.id, name: `Callback: ${card.callback.title}` }] : [])]} />
      {card.why && <p className="mt-2 text-[13px] italic text-muted">{card.why}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {state !== "used" ? (
          <button type="button" onClick={onUse} disabled={!canUse} className="btn-secondary font-medium">
            <Icon name="check" /> Use this
          </button>
        ) : (
          <span className="text-xs text-thread">Used. What happens next goes in the box above.</span>
        )}
        <DevelopToggle live={live} base={{ moment, label: card.label, text: card.text, threadIds: card.threads.map((t) => t.id) }} parent={parent} saved={saved} />
      </div>
    </li>
  );
}

function OwnChoice({ entry, onSave }: { entry: Entry; onSave: (text: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(entry.choiceKind === "own" ? entry.choice : "");
  const [busy, setBusy] = useState(false);
  if (entry.choiceKind === "own" && !open)
    return (
      <div className="mt-3 rounded-xl border border-thread/60 bg-surface p-4">
        <p className="text-[13px] font-semibold uppercase tracking-wide">
          <Icon name="pen" className="mr-2 text-thread" />Your own
        </p>
        <p className="story mt-1 leading-relaxed">
          <Linked text={entry.choice} />
        </p>
        <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs text-muted hover:text-foreground">
          Edit
        </button>
      </div>
    );
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-tertiary mt-3 text-sm">
        <Icon name="pen" /> None of these. Write what happened
      </button>
    );
  return (
    <form
      className="rise mt-3 rounded-xl border border-line bg-surface p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(text.trim());
          setOpen(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What you decided happened, in a line or two"
        className="block w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-muted/70"
      />
      <div className="mt-2 flex justify-end gap-3 text-sm">
        <button type="button" onClick={() => setOpen(false)} className="text-muted">
          Cancel
        </button>
        <button disabled={busy || text.trim().length < 2} className="btn-primary">
          Use this
        </button>
      </div>
    </form>
  );
}

// ---------- develop: a branch you can keep following ----------

type Part = "open" | "setup" | "lead";
interface Idea {
  part: Part;
  headline: string;
  flavour: string;
}
const PARTS: { id: Part; label: string; hint: string }[] = [
  { id: "open", label: "Open", hint: "how the next scene begins" },
  { id: "setup", label: "Set up", hint: "what's in play" },
  { id: "lead", label: "Lead to", hint: "where it could go" },
];

// Develop in two steps. First, quick headlines in three sections: pick one from each (or skip a
// section). Then Loom writes just those out in full, in a form that's easy to read at a glance.
function DevelopToggle({
  live,
  base,
  parent,
  saved,
  depth = 0,
}: {
  live: Live;
  base: { moment: string; label: string; text: string; threadIds: number[] };
  parent: () => Promise<number | null>; // the logged entry this grows from (logging it first if needed)
  saved?: Plan[];
  depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [reach, setReach] = useState(() => {
    const s = Number(store.get("loom.reach"));
    return s >= 0 && s <= 3 ? s : 1;
  });
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [picked, setPicked] = useState<Partial<Record<Part, string>>>({});
  const [fresh, setFresh] = useState<Plan | null>(null);
  const [entryId, setEntryId] = useState<number | null>(null); // where this plan is kept
  const [choosing, setChoosing] = useState(!saved?.length);
  const plan = choosing ? null : (fresh ?? saved?.at(-1) ?? null);
  const [busy, setBusy] = useState<"" | "ideas" | "plan">("");
  const [error, setError] = useState("");
  const elapsed = useElapsed(!!busy);
  const body = { campaignId: live.campaignId, ...base, reach, tone: live.tone };

  const getIdeas = async (r = reach) => {
    setBusy("ideas");
    setError("");
    setPicked({});
    try {
      const res = await post<{ ideas: Idea[] }>("/api/develop/ideas", { ...body, reach: r });
      setIdeas(res.ideas);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  };
  const weave = async () => {
    setBusy("plan");
    setError("");
    try {
      const id = await parent();
      setEntryId(id);
      const picks = PARTS.filter((p) => picked[p.id]).map((p) => ({ part: p.id, headline: picked[p.id]! }));
      setFresh(await post<Plan>("/api/develop", { ...body, picks, entryId: id ?? undefined }));
      setChoosing(false);
      await live.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  };

  // A reworked piece updates the plan, and the plan kept on the entry.
  const reworked = async (part: "intro" | "setups" | "directions", i: number, text: string) => {
    if (!plan) return;
    const next: Plan = part === "intro" ? { ...plan, intro: text } : { ...plan, [part]: plan[part].map((x, j) => (j === i ? { ...x, text } : x)) };
    setFresh(next);
    const id = entryId ?? (await parent());
    if (id) await post("/api/develop/keep", { entryId: id, plan: next }).catch(() => {});
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (choosing && !ideas) void getIdeas();
        }}
        className="btn-tertiary text-sm"
        title={saved?.length ? "Developed before: open to see it" : "Plan ahead from this"}
      >
        <Icon name="branch" /> Develop{saved?.length ? <span className="h-1.5 w-1.5 rounded-full bg-thread" /> : null}
      </button>
    );

  const count = Object.values(picked).filter(Boolean).length;
  return (
    <div className={`rise mt-1 w-full basis-full ${depth > 0 ? "border-l-2 border-thread/30 py-1 pl-3" : "rounded-xl border border-line bg-background p-3"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Steps
          label="How far ahead"
          steps={REACH}
          value={reach}
          onChange={(v) => {
            setReach(v);
            store.set("loom.reach", String(v));
            if (choosing) void getIdeas(v);
          }}
        />
        <div className="flex items-center gap-3 text-sm">
          {!choosing && (
            <button
              type="button"
              onClick={() => {
                setChoosing(true);
                if (!ideas) void getIdeas();
              }}
              className="btn-tertiary text-xs"
            >
              Pick again
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} className="btn-tertiary">
            Close
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {choosing && (
        <div className="mt-3">
          {busy === "ideas" && <p className="animate-pulse text-xs text-muted">Finding ideas… {elapsed} s</p>}
          {ideas && busy !== "ideas" && (
            <>
              <p className="mb-2 text-xs text-muted">Pick one from each, or skip a section. Loom writes your picks out in full.</p>
              <div className="space-y-3">
                {PARTS.map((part) => {
                  const row = ideas.filter((i) => i.part === part.id);
                  if (!row.length) return null;
                  return (
                    <div key={part.id} role="radiogroup" aria-label={part.label}>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        {part.label} <span className="font-normal normal-case tracking-normal">· {part.hint}</span>
                      </p>
                      <div className="grid gap-1.5">
                        {row.map((idea) => {
                          const on = picked[part.id] === idea.headline;
                          return (
                            <button
                              key={idea.headline}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              onClick={() => setPicked({ ...picked, [part.id]: on ? undefined : idea.headline })}
                              className={`flex items-baseline gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${on ? "border-thread bg-thread-soft/60" : "border-line bg-surface hover:border-thread/50"}`}
                            >
                              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full border ${on ? "border-thread bg-thread" : "border-muted/50"}`} />
                              <span className="story min-w-0 flex-1 leading-snug">{idea.headline}</span>
                              <span className="shrink-0 text-[11px] text-muted">{idea.flavour}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <button type="button" onClick={() => getIdeas()} className="btn-tertiary text-xs">
                  Other ideas
                </button>
                <button type="button" disabled={!count || !!busy} onClick={weave} className="btn-primary text-sm">
                  {busy === "plan" ? `Writing it out… ${elapsed} s` : `Write ${count === 1 ? "it" : `these ${count}`} out`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {plan && (
        <article className="mt-3 space-y-4">
          {plan.intro && (
            <section>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Open · read aloud</h3>
              <PlanItem live={live} parent={parent} depth={depth} from={base} item={{ title: "Opening", text: plan.intro, threads: [] }} quote onRework={(t) => reworked("intro", 0, t)} />
            </section>
          )}
          <PlanList title="Set up" items={plan.setups} live={live} parent={parent} depth={depth} from={base} onRework={(i, t) => reworked("setups", i, t)} />
          <PlanList title="Lead to" items={plan.directions} live={live} parent={parent} depth={depth} from={base} onRework={(i, t) => reworked("directions", i, t)} />
          {plan.newThread && <NewThread campaignId={live.campaignId} idea={plan.newThread} linkTo={base.threadIds} />}
          <p className="text-xs text-muted">
            {plan.reach} · {plan.llm.model.replace(/^claude-/, "")} · {plan.llm.seconds.toFixed(0)} s · ${plan.llm.costUsd.toFixed(3)}
          </p>
        </article>
      )}
    </div>
  );
}

// Rework one piece: a few one-tap changes, or say how in a few words.
const REWORKS = ["More grounded", "More dramatic", "Darker", "Funnier", "Shorter"];
function Rework({ campaignId, text, context, onDone }: { campaignId: number; text: string; context: string; onDone: (t: string | null) => void }) {
  const [how, setHow] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (h: string) => {
    if (!h.trim()) return;
    setBusy(true);
    try {
      const r = await post<{ text: string }>("/api/develop/rework", { campaignId, text, how: h, context });
      onDone(r.text);
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="rise mt-2 rounded-lg bg-surface p-2.5">
      <div className="flex flex-wrap gap-1.5">
        {REWORKS.map((r) => (
          <button key={r} type="button" disabled={busy} onClick={() => go(r)} className="rounded-full border border-line px-2.5 py-0.5 text-[12px] hover:border-thread/60 disabled:opacity-40">
            {r}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go(how);
        }}
      >
        <input
          value={how}
          onChange={(e) => setHow(e.target.value)}
          placeholder="Or say how: “give the quiet player the spotlight”"
          className="min-w-0 flex-1 rounded-md border border-line bg-background px-2.5 py-1 text-[13px] outline-none focus:border-thread/60"
        />
        <button disabled={busy || !how.trim()} className="btn-secondary text-xs">
          {busy ? "Reworking…" : "Rework"}
        </button>
        <button type="button" onClick={() => onDone(null)} className="btn-tertiary text-xs">
          Cancel
        </button>
      </form>
    </div>
  );
}

// At the arc, Develop may open one genuinely new thread, marked as new and one tap from the loom.
function NewThread({ campaignId, idea, linkTo }: { campaignId: number; idea: { title: string; summary: string }; linkTo: number[] }) {
  const [added, setAdded] = useState(false);
  return (
    <div className="rounded-lg border border-dashed border-thread/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-thread">A new thread</p>
      <p className="story mt-0.5">
        <span className="font-medium">{idea.title}.</span> {idea.summary}
      </p>
      {added ? (
        <span className="mt-1.5 inline-block text-xs text-thread">
          <Icon name="check" size={12} /> In the loom
        </span>
      ) : (
        <button
          type="button"
          onClick={async () => {
            await post("/api/fresh/add", { campaignId, title: idea.title, kind: "hook", summary: idea.summary, entities: [], linkTo });
            setAdded(true);
          }}
          className="btn-secondary mt-1.5 text-xs"
        >
          <Icon name="plus" size={12} /> Add to the loom
        </button>
      )}
    </div>
  );
}

function PlanList({
  title,
  items,
  onRework,
  ...rest
}: {
  title: string;
  items: Plan["setups"];
  live: Live;
  parent: () => Promise<number | null>;
  depth: number;
  from: { moment: string; text: string };
  onRework: (i: number, text: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="space-y-3">
        {items.map((s, i) => (
          <PlanItem key={s.title} item={s} {...rest} onRework={(t) => onRework(i, t)} />
        ))}
      </div>
    </div>
  );
}

// One piece of a development: use it (it joins the session as a branch) or keep developing from it.
function PlanItem({
  item: given,
  live,
  parent,
  depth,
  from,
  quote = false,
  onRework,
}: {
  item: Plan["setups"][number];
  onRework?: (text: string) => void;
  live: Live;
  parent: () => Promise<number | null>;
  depth: number;
  from: { moment: string; text: string };
  quote?: boolean;
}) {
  const [branchId, setBranchId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(given.text); // reworked in place
  const [reworking, setReworking] = useState(false);
  const branch = live.entries.find((e) => e.id === branchId);
  const item = { ...given, text };
  const continueWith = async () => {
    setBusy(true);
    try {
      const p = await parent();
      if (!p) return null;
      const r = await post<{ entry: Entry }>("/api/live/branch", { parentId: p, label: item.title, text: item.text });
      setBranchId(r.entry.id);
      await live.reload();
      live.focusBox("What happened next?");
      return r.entry.id;
    } finally {
      setBusy(false);
    }
  };
  const Body = <Linked text={item.text} />;
  return (
    <div>
      {!quote && <p className="text-[14px] font-semibold">{item.title}</p>}
      {quote ? (
        <blockquote className="story border-l-2 border-thread pl-3 text-[17px] leading-relaxed">{Body}</blockquote>
      ) : (
        <p className="story mt-0.5 text-[16px] leading-relaxed">{Body}</p>
      )}
      <RefChips refs={threadRefs(item.threads)} />
      {reworking && <Rework campaignId={live.campaignId} text={item.text} context={from.text} onDone={(t) => {
            if (t) {
              setText(t);
              onRework?.(t);
            }
            setReworking(false);
          }} />}
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
        {branch ? (
          <span className="text-thread">
            <Icon name="branch" size={12} /> Continued with this{branch.status === "extracting" ? " · adding to the loom…" : ""}
          </span>
        ) : (
          <button type="button" disabled={busy} onClick={continueWith} className="btn-secondary text-xs font-medium">
            {busy ? "Logging…" : "Continue with this"}
          </button>
        )}
        {!branch && !reworking && (
          <button type="button" onClick={() => setReworking(true)} className="btn-tertiary text-xs" title="Change the tone, length or focus">
            Rework
          </button>
        )}
        {depth < 4 && (
          <DevelopToggle
            live={live}
            base={{ moment: from.text, label: item.title, text: item.text, threadIds: item.threads.map((t) => t.id) }}
            parent={async () => branchId ?? (await continueWith())}
            saved={branch?.developments}
            depth={depth + 1}
          />
        )}
      </div>
    </div>
  );
}
