"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Choice, Field, Steps, Switch, Tune } from "./controls";
import { Icon } from "./icons";
import { Linked, LoomProvider, RefChips } from "./loom-ui";
import { Header, Note, post, store, useCampaigns, useElapsed } from "./shell";

// The table page: type what the players just did, get options tied back to threads (each shown
// the moment it's written), use one or write your own, and Loom adds it to the loom straight
// away so the next suggestion knows. Develop any choice and keep going from what it suggests:
// the session grows as a tree, shown in the timeline. Every name links into the loom.

interface Card {
  label: string;
  text: string;
  why: string;
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
}
interface Done {
  entryId: number;
  count: number;
  notes: string[];
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
  llm: { model: string; seconds: number; costUsd: number };
}
interface Entry {
  id: number;
  parentId: number | null;
  moment: string;
  choiceKind: "option" | "own" | "branch" | null;
  choiceLabel: string;
  choice: string;
  status: "asked" | "extracting" | "done" | "failed";
  summary: string[];
  questions: Question[];
  developments: Plan[];
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
  const [showOthers, setShowOthers] = useState(false);
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

  async function ask() {
    const text = moment.trim();
    if (!text || status === "running") return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAsked(text);
    setMoment("");
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
        body: JSON.stringify({ campaignId, moment: text, model, tone }),
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
  async function use(choice: { kind: "option" | "own"; label: string; text: string }) {
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
            <Tune label="Tune suggestions" summary={`${MODELS.find((m) => m.id === model)?.label} · ${TONES[tone]}`}>
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

      {!asked && empty && <Welcome name={name} trySample={trySample} />}
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
              return (
                <OptionCard
                  key={`${card.label}-${i}`}
                  card={card}
                  n={i + 1}
                  state={state}
                  canUse={!!current}
                  onUse={() => use({ kind: "option", label: card.label, text: card.text })}
                  live={live}
                  moment={asked}
                  // Developing a card you haven't used yet uses it first, so what grows from it has a parent.
                  parent={async () => (state === "used" ? current!.id : await use({ kind: "option", label: card.label, text: card.text }))}
                  saved={state === "used" ? current?.developments : undefined}
                />
              );
            })}
            {Array.from({ length: pending }, (_, i) => (
              <li key={`pending-${i}`} aria-hidden className="h-32 animate-pulse rounded-xl border border-line bg-surface/60" />
            ))}
          </ol>
          {current?.choiceKind && cards.some((c) => !(current.choiceKind === "option" && current.choice === c.text)) && (
            <button type="button" onClick={() => setShowOthers(!showOthers)} className="btn-tertiary mt-2 flex text-sm">
              {showOthers ? "Fold the other options" : `${cards.filter((c) => !(current.choiceKind === "option" && current.choice === c.text)).length} other options`}
              <Icon name="arrow" size={12} className={`transition-transform ${showOthers ? "-rotate-90" : "rotate-90"}`} />
            </button>
          )}

          {status === "done" && current && <OwnChoice entry={current} onSave={(text) => use({ kind: "own", label: "", text })} />}
          {current?.choiceKind && <LoomStatus entry={current} />}
          {current && <Branches parent={current} live={live} />}

          {/* Arrives with the last option, so it goes below the cards rather than shifting them. */}
          {!!done?.notes.length && (
            <div className="mt-3">
              {done.notes.map((n) => (
                <Note key={n}>{n}</Note>
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
function Welcome({ name, trySample }: { name: string; trySample: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="rise mt-8 rounded-2xl border border-line bg-surface p-6">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">New campaign</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight">{name ? `Welcome to ${name}` : "Welcome"}</h2>
      <p className="story mt-2 max-w-prose leading-relaxed text-foreground/85">
        When your players go off-script, Loom finds the threads already in play and shows you how to tie the moment back to them. To do that it needs something to remember.
      </p>
      <ol className="mt-5 space-y-4">
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">1</span>
          <div>
            <p className="font-medium">Paste your last session&apos;s notes</p>
            <p className="text-sm text-muted">However rough. Loom picks out the threads, characters and places, and you confirm them.</p>
            <Link href="/prep" className="btn-primary mt-2 text-sm">
              Add notes <Icon name="arrow" size={12} />
            </Link>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">2</span>
          <div>
            <p className="font-medium">Or start at the table</p>
            <p className="text-sm text-muted">Type the first thing that happens in the box above. Everything you use is remembered as you go.</p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">3</span>
          <div>
            <p className="font-medium">Just looking?</p>
            <p className="text-sm text-muted">Try a small sample campaign with a few threads already woven.</p>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await trySample();
                } finally {
                  setBusy(false);
                }
              }}
              className="btn-secondary mt-2 text-sm"
            >
              <Icon name="sparkle" /> Open the sample
            </button>
          </div>
        </li>
      </ol>
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
                {e.status === "extracting" ? <span className="h-2 w-2 animate-ping rounded-full bg-thread" /> : e.status === "failed" ? "!" : <Icon name={e.choiceKind === "branch" ? "branch" : e.choiceKind === "own" ? "pen" : e.choiceKind ? "check" : "dot"} size={12} />}
                {e.questions.length > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger" />}
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
        placeholder="Something that happened, e.g. “Iresia bought the lockpicks off Hoder”"
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
            {entry.choiceLabel && <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-wide">{entry.choiceLabel}</span>}
            <Linked text={entry.choice} />
          </p>
          <LoomStatus entry={entry} />
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
            {k.choiceLabel && <span className="mr-1 font-medium">{k.choiceLabel}.</span>}
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

function OptionCard({
  card,
  n,
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
  state: "open" | "used" | "other";
  canUse: boolean;
  onUse: () => void;
  live: Live;
  moment: string;
  parent: () => Promise<number | null>;
  saved?: Plan[];
}) {
  const [copied, setCopied] = useState(false);
  return (
    <li
      id={state === "used" ? "chosen" : undefined}
      className={`rise group scroll-mt-40 rounded-xl border bg-surface p-4 shadow-sm transition-opacity ${state === "used" ? "border-thread/60" : "border-line"} ${state === "other" ? "opacity-55 hover:opacity-100" : ""}`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide">
          <span className="mr-2 text-muted">{state === "used" ? <Icon name="check" className="text-thread" /> : n}</span>
          {card.label}
        </h2>
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
  const [fresh, setFresh] = useState<Plan | null>(null);
  const plan = fresh ?? saved?.at(-1) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const elapsed = useElapsed(busy);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-tertiary text-sm" title={saved?.length ? "Developed before: open to see it" : "Plan ahead from this"}>
        <Icon name="branch" /> Develop{saved?.length ? <span className="h-1.5 w-1.5 rounded-full bg-thread" /> : null}
      </button>
    );
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
          }}
        />
        <div className="flex items-center gap-3 text-sm">
          <button type="button" onClick={() => setOpen(false)} className="btn-tertiary">
            Close
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const entryId = await parent();
                setFresh(await post<Plan>("/api/develop", { campaignId: live.campaignId, ...base, reach, tone: live.tone, entryId: entryId ?? undefined }));
                await live.reload();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Something went wrong.");
              } finally {
                setBusy(false);
              }
            }}
            className="btn-primary"
          >
            {busy ? `Planning… ${elapsed} s` : plan ? "Develop again" : "Develop"}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {plan && (
        <div className="mt-3 space-y-3 text-[14.5px]">
          <PlanItem live={live} parent={parent} depth={depth} from={base} item={{ title: "Opening", text: plan.intro, threads: [] }} quote />
          <PlanList title="Set up" items={plan.setups} live={live} parent={parent} depth={depth} from={base} />
          <PlanList title="Where it could lead" items={plan.directions} live={live} parent={parent} depth={depth} from={base} />
          <p className="text-xs text-muted">
            {plan.reach} · {plan.llm.model.replace(/^claude-/, "")} · {plan.llm.seconds.toFixed(0)} s · ${plan.llm.costUsd.toFixed(3)}
          </p>
        </div>
      )}
    </div>
  );
}

function PlanList({ title, items, ...rest }: { title: string; items: Plan["setups"]; live: Live; parent: () => Promise<number | null>; depth: number; from: { moment: string; text: string } }) {
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="space-y-3">
        {items.map((s) => (
          <PlanItem key={s.title} item={s} {...rest} />
        ))}
      </div>
    </div>
  );
}

// One piece of a development: use it (it joins the session as a branch) or keep developing from it.
function PlanItem({
  item,
  live,
  parent,
  depth,
  from,
  quote = false,
}: {
  item: Plan["setups"][number];
  live: Live;
  parent: () => Promise<number | null>;
  depth: number;
  from: { moment: string; text: string };
  quote?: boolean;
}) {
  const [branchId, setBranchId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const branch = live.entries.find((e) => e.id === branchId);
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
  const Body = (
    <>
      {!quote && <span className="font-medium">{item.title}. </span>}
      <Linked text={item.text} />
    </>
  );
  return (
    <div>
      {quote ? <blockquote className="story border-l-2 border-thread pl-3 leading-relaxed">{Body}</blockquote> : <p className="story leading-relaxed">{Body}</p>}
      <RefChips refs={threadRefs(item.threads)} />
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
