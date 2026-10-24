"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chips, Header, Note, post, store, useCampaigns, useElapsed } from "./shell";

// The table page: type what the players just did, get options tied back to threads (each shown
// the moment it's written), use one or write your own, and Loom adds it to the loom straight
// away so the next suggestion knows. The session so far sits in a small timeline at the top.

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
interface Entry {
  id: number;
  moment: string;
  choiceKind: "option" | "own" | null;
  choiceLabel: string;
  choice: string;
  status: "asked" | "extracting" | "done" | "failed";
  summary: string[];
  questions: Question[];
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

export function ImprovBox() {
  const c = useCampaigns();
  const campaignId = c.campaignId;
  const [model, setModel] = useState<Model>("haiku");
  const [tone, setTone] = useState(1);
  const [moment, setMoment] = useState("");
  const [asked, setAsked] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
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

  const loadLive = useCallback(async (id: number) => {
    const r = await post<{ session: number; entries: Entry[] }>("/api/live", { campaignId: id });
    setSession(r.session);
    setEntries(r.entries);
    return r.entries;
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    post<{ session: number; entries: Entry[] }>("/api/live", { campaignId })
      .then((r) => {
        setSession(r.session);
        setEntries(r.entries);
      })
      .catch(() => {});
  }, [campaignId]);

  // While a choice is being added to the loom, check back every couple of seconds.
  const extracting = entries.some((e) => e.status === "extracting");
  useEffect(() => {
    if (!extracting || !campaignId) return;
    const t = setInterval(() => loadLive(campaignId).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [extracting, campaignId, loadLive]);

  async function ask() {
    const text = moment.trim();
    if (!text || !campaignId || status === "running") return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAsked(text);
    setMoment("");
    setCards([]);
    setDone(null);
    setError("");
    setOpen(null);
    setStatus("running");
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
      await loadLive(campaignId);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    } finally {
      box.current?.focus();
    }
  }

  const current = done ? entries.find((e) => e.id === done.entryId) : undefined;

  async function use(choice: { kind: "option" | "own"; label: string; text: string }) {
    if (!current || !campaignId) return;
    setError("");
    try {
      if (current.choiceKind) await post("/api/live/clear", { entryId: current.id }); // changed their mind
      await post("/api/live/choice", { entryId: current.id, ...choice });
      await loadLive(campaignId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't log that.");
    }
  }

  const pending = status === "running" ? Math.max(0, 3 - cards.length) : 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-16 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}

      {campaignId && session != null && (
        <Timeline
          session={session}
          entries={entries}
          open={open}
          setOpen={setOpen}
          campaignId={campaignId}
          reload={() => loadLive(campaignId)}
          model={model}
          tone={tone}
        />
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
          rows={2}
          value={moment}
          onChange={(e) => setMoment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="What did the players just do?"
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[17px] leading-relaxed outline-none placeholder:text-muted/70"
        />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pb-3 pt-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented
              label="Model"
              options={MODELS.map((m) => ({ id: m.id, label: m.label, hint: m.hint }))}
              value={model}
              onChange={(v) => {
                setModel(v as Model);
                store.set("loom.model", v);
              }}
            />
            <Slider
              label="Tone"
              steps={TONES}
              value={tone}
              onChange={(v) => {
                setTone(v);
                store.set("loom.tone", String(v));
              }}
            />
          </div>
          <button
            type="submit"
            disabled={!moment.trim() || !campaignId || status === "running"}
            className="ml-auto shrink-0 whitespace-nowrap rounded-lg bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity disabled:opacity-30"
          >
            {status === "running" ? "Weaving…" : "Find threads"}
          </button>
        </div>
      </form>
      <p className="mt-2 px-1 text-xs text-muted">Enter to ask · Shift+Enter for a new line</p>

      {asked && (
        <section aria-live="polite" className="mt-8">
          <p className="mb-4 border-l-2 border-thread pl-3 text-[15px] italic text-muted">{asked}</p>

          {done?.safetyNote && <Note>{done.safetyNote}</Note>}

          <ol className="space-y-3">
            {cards.map((card, i) => (
              <OptionCard
                key={`${card.label}-${i}`}
                card={card}
                n={i + 1}
                state={!current?.choiceKind ? "open" : current.choiceKind === "option" && current.choice === card.text ? "used" : "other"}
                canUse={!!current}
                onUse={() => use({ kind: "option", label: card.label, text: card.text })}
                develop={campaignId ? { campaignId, moment: asked, model, tone } : null}
              />
            ))}
            {Array.from({ length: pending }, (_, i) => (
              <li key={`pending-${i}`} aria-hidden className="h-32 animate-pulse rounded-xl border border-line bg-surface/60" />
            ))}
          </ol>

          {status === "done" && current && <OwnChoice entry={current} onSave={(text) => use({ kind: "own", label: "", text })} />}
          {current?.choiceKind && <LoomStatus entry={current} onAnswer={() => (campaignId ? loadLive(campaignId) : undefined)} />}

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
    </main>
  );
}

// ---------- controls ----------

function Segmented({ label, options, value, onChange }: { label: string; options: { id: string; label: string; hint?: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-background p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-1 transition-colors ${value === o.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, steps, value, onChange }: { label: string; steps: readonly string[]; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">{label}</span>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={steps[value]}
        className="w-24 accent-[var(--thread)]"
      />
      <span className="w-[5.5rem] text-foreground/80">{steps[value]}</span>
    </label>
  );
}

// ---------- the session timeline ----------

function Timeline({
  session,
  entries,
  open,
  setOpen,
  campaignId,
  reload,
  model,
  tone,
}: {
  session: number;
  entries: Entry[];
  open: number | null;
  setOpen: (id: number | null) => void;
  campaignId: number;
  reload: () => Promise<unknown>;
  model: Model;
  tone: number;
}) {
  const [noting, setNoting] = useState(false);
  const used = entries.filter((e) => e.choiceKind).length;
  const questions = entries.reduce((n, e) => n + e.questions.length, 0);
  const shown = entries.find((e) => e.id === open);
  const strip = useRef<HTMLOListElement>(null);
  useEffect(() => {
    strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: "smooth" });
  }, [entries.length]);

  return (
    <section aria-label={`Session ${session} so far`} className="mb-4">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">
          Session {session}
          {entries.length > 0 && <span className="font-normal"> · {used} used</span>}
        </span>
        <ol ref={strip} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]">
          {entries.length === 0 && <li className="text-xs text-muted/70">Nothing yet. What you use at the table lands here.</li>}
          {entries.map((e, i) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => setOpen(open === e.id ? null : e.id)}
                aria-label={`${i + 1}. ${e.moment}${e.choiceKind ? " (used)" : " (asked)"}`}
                title={e.moment}
                className={`relative grid h-6 w-6 place-items-center rounded-full text-[11px] transition-colors ${open === e.id ? "ring-2 ring-thread/60" : ""} ${
                  e.choiceKind ? "bg-thread-soft text-thread" : "border border-line text-muted/70"
                }`}
              >
                {e.status === "extracting" ? <span className="h-2 w-2 animate-ping rounded-full bg-thread" /> : e.status === "failed" ? "!" : e.choiceKind === "own" ? "✎" : e.choiceKind ? "✓" : "·"}
                {e.questions.length > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger" />}
              </button>
            </li>
          ))}
        </ol>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {questions > 0 && (
            <button type="button" onClick={() => setOpen(entries.find((e) => e.questions.length)!.id)} className="rounded-full bg-danger/10 px-2 py-0.5 text-danger">
              {questions} to check
            </button>
          )}
          <button type="button" onClick={() => setNoting(!noting)} className="text-muted hover:text-foreground" title="Log something that happened without asking Loom">
            + Note
          </button>
          {used > 0 && (
            <Link href="/prep" className="text-muted hover:text-foreground" title="Add what Loom didn't see, and close the session">
              Wrap up →
            </Link>
          )}
        </div>
      </div>

      {noting && (
        <QuickNote
          campaignId={campaignId}
          onDone={async () => {
            setNoting(false);
            await reload();
          }}
        />
      )}
      {shown && <EntryDetail entry={shown} onChange={reload} onClose={() => setOpen(null)} campaignId={campaignId} model={model} tone={tone} />}
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
      <button disabled={busy || text.trim().length < 2} className="rounded-lg bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-30">
        Log
      </button>
      {error && <span className="self-center text-xs text-danger">{error}</span>}
    </form>
  );
}

function EntryDetail({ entry, onChange, onClose, campaignId, model, tone }: { entry: Entry; onChange: () => Promise<unknown>; onClose: () => void; campaignId: number; model: Model; tone: number }) {
  const [busy, setBusy] = useState(false);
  const takeBack = async () => {
    setBusy(true);
    try {
      await post("/api/live/clear", { entryId: entry.id });
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise mt-2 rounded-xl border border-line bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="italic text-muted">{entry.moment}</p>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
          ×
        </button>
      </div>
      {entry.choiceKind ? (
        <>
          <p className="mt-1.5">
            {entry.choiceLabel && <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-wide">{entry.choiceLabel}</span>}
            {entry.choice}
          </p>
          <LoomStatus entry={entry} onAnswer={onChange} />
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <DevelopToggle base={{ campaignId, moment: entry.moment, label: entry.choiceLabel, text: entry.choice, threadIds: [], model, tone }} />
            <button type="button" onClick={takeBack} disabled={busy} className="text-muted hover:text-foreground disabled:opacity-40">
              Take back (undo what it added)
            </button>
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-xs text-muted">Asked, nothing used.</p>
      )}
    </div>
  );
}

// What using a choice did to the loom, and anything Loom needs to check.
function LoomStatus({ entry, onAnswer }: { entry: Entry; onAnswer: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState<number | null>(null);
  if (entry.status === "extracting") return <p className="mt-3 animate-pulse text-xs text-muted">Adding to the loom…</p>;
  if (entry.status === "failed") return <p className="mt-3 text-xs text-danger">Couldn&apos;t add this to the loom. It&apos;s still in the session log for wrap-up.</p>;
  if (entry.status !== "done") return null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted">
        {entry.summary.length ? (
          <>
            <span className="text-thread">Added to the loom:</span> {entry.summary.join(" · ")}
          </>
        ) : (
          "Logged. Nothing new for the loom."
        )}
      </p>
      {entry.questions.map((q) => (
        <div key={q.n} className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
          <p className="text-[13px]">
            <span className="text-muted">{q.group}: </span>
            {q.summary}
          </p>
          <p className="mt-0.5 text-xs text-muted">{q.reasons.join(" · ")}</p>
          <div className="mt-1.5 flex gap-2 text-xs">
            {[true, false].map((yes) => (
              <button
                key={String(yes)}
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(q.n);
                  try {
                    await post("/api/live/answer", { entryId: entry.id, n: q.n, yes });
                    await onAnswer();
                  } finally {
                    setBusy(null);
                  }
                }}
                className={`rounded-md px-2.5 py-0.5 ${yes ? "bg-foreground text-background" : "border border-line"} disabled:opacity-40`}
              >
                {yes ? "Yes, record it" : "No"}
              </button>
            ))}
          </div>
        </div>
      ))}
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
  develop,
}: {
  card: Card;
  n: number;
  state: "open" | "used" | "other";
  canUse: boolean;
  onUse: () => void;
  develop: { campaignId: number; moment: string; model: Model; tone: number } | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <li
      className={`rise group rounded-xl border bg-surface p-4 shadow-sm transition-opacity ${state === "used" ? "border-thread/60" : "border-line"} ${state === "other" ? "opacity-55 hover:opacity-100" : ""}`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide">
          <span className="mr-2 text-muted">{state === "used" ? <span className="text-thread">✓</span> : n}</span>
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
      <p className="text-[15.5px] leading-relaxed">{card.text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {card.threads.map((t) => (
          <span key={t.id} className="rounded-full bg-thread-soft px-2.5 py-0.5 text-xs text-thread">
            {t.title}
          </span>
        ))}
        {card.callback && <span className="rounded-full border border-thread/40 px-2.5 py-0.5 text-xs text-thread">⟲ {card.callback.title}</span>}
      </div>
      {card.why && <p className="mt-2 text-[13px] italic text-muted">{card.why}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {state !== "used" ? (
          <button type="button" onClick={onUse} disabled={!canUse} className="rounded-lg border border-line px-3 py-1 font-medium hover:border-thread/60 disabled:opacity-30">
            Use this
          </button>
        ) : (
          <span className="text-xs text-thread">Used</span>
        )}
        {develop && <DevelopToggle base={{ ...develop, label: card.label, text: card.text, threadIds: card.threads.map((t) => t.id) }} />}
      </div>
    </li>
  );
}

function OwnChoice({ entry, onSave }: { entry: Entry; onSave: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(entry.choiceKind === "own" ? entry.choice : "");
  const [busy, setBusy] = useState(false);
  if (entry.choiceKind === "own" && !open)
    return (
      <div className="mt-3 rounded-xl border border-thread/60 bg-surface p-4">
        <p className="text-[13px] font-semibold uppercase tracking-wide">
          <span className="mr-2 text-thread">✎</span>Your own
        </p>
        <p className="mt-1 text-[15.5px] leading-relaxed">{entry.choice}</p>
        <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs text-muted hover:text-foreground">
          Edit
        </button>
      </div>
    );
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 text-sm text-muted hover:text-foreground">
        ✎ None of these. Write what happened
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
        <button disabled={busy || text.trim().length < 2} className="rounded-lg bg-foreground px-3 py-1 text-background disabled:opacity-30">
          Use this
        </button>
      </div>
    </form>
  );
}

// ---------- develop ----------

interface Plan {
  reach: string;
  intro: string;
  setups: { title: string; text: string; threads: { id: number; title: string }[] }[];
  directions: { title: string; text: string; threads: { id: number; title: string }[] }[];
  llm: { model: string; seconds: number; costUsd: number };
}

function DevelopToggle({ base }: { base: { campaignId: number; moment: string; label: string; text: string; threadIds: number[]; model: Model; tone: number } }) {
  const [open, setOpen] = useState(false);
  const [reach, setReach] = useState(() => {
    const saved = Number(store.get("loom.reach"));
    return saved >= 0 && saved <= 3 ? saved : 1;
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const elapsed = useElapsed(busy);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-muted hover:text-foreground sm:text-sm">
        Develop ↳
      </button>
    );
  return (
    <div className="rise mt-1 w-full basis-full rounded-xl border border-line bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Slider
          label="How far ahead"
          steps={REACH}
          value={reach}
          onChange={(v) => {
            setReach(v);
            store.set("loom.reach", String(v));
          }}
        />
        <div className="flex items-center gap-3 text-sm">
          <button type="button" onClick={() => setOpen(false)} className="text-muted">
            Close
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setPlan(await post<Plan>("/api/develop", { ...base, model: undefined, reach }));
              } catch (e) {
                setError(e instanceof Error ? e.message : "Something went wrong.");
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg bg-foreground px-3 py-1 text-background disabled:opacity-40"
          >
            {busy ? `Planning… ${elapsed} s` : plan ? "Again" : "Develop"}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {plan && (
        <div className="mt-3 space-y-3 text-[14.5px]">
          <blockquote className="border-l-2 border-thread pl-3 leading-relaxed">{plan.intro}</blockquote>
          <PlanList title="Set up" items={plan.setups} />
          <PlanList title="Where it could lead" items={plan.directions} />
          <p className="text-xs text-muted">
            {plan.reach} · {plan.llm.model.replace(/^claude-/, "")} · {plan.llm.seconds.toFixed(0)} s · ${plan.llm.costUsd.toFixed(3)}
          </p>
        </div>
      )}
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: Plan["setups"] }) {
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="space-y-2">
        {items.map((s) => (
          <li key={s.title}>
            <span className="font-medium">{s.title}.</span> {s.text}
            <Chips threads={s.threads} />
          </li>
        ))}
      </ul>
    </div>
  );
}
