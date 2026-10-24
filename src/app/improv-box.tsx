"use client";

import { useEffect, useRef, useState } from "react";
import { Header, Note, store, useCampaigns } from "./shell";

// The one-box improv page: type what the players just did, get 2-3 options tied back to threads,
// each shown the moment it's written.

interface Card {
  label: string;
  text: string;
  why: string;
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
}
interface Done {
  count: number;
  notes: string[];
  safetyNote: string | null;
  llm: { model: string; seconds: number; costUsd: number; attempts: number };
}
type Status = "idle" | "running" | "done" | "error";

const MODELS = [
  { id: "haiku", label: "Quick", hint: "Haiku · ~3 s to the first option" },
  { id: "opus", label: "Best", hint: "Opus · slower, richer payoffs" },
] as const;

export function ImprovBox() {
  const c = useCampaigns();
  const campaignId = c.campaignId;
  const [model, setModel] = useState<"haiku" | "opus">("haiku");
  const [moment, setMoment] = useState("");
  const [asked, setAsked] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const savedModel = store.get("loom.model");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a per-browser preference read once on load
    if (savedModel === "opus" || savedModel === "haiku") setModel(savedModel);
    box.current?.focus();
  }, []);

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
    setStatus("running");
    try {
      const res = await fetch("/api/improv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, moment: text, model }),
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
          if (event.type === "option") setCards((c) => [...c, event.option]);
          else if (event.type === "done") setDone(event);
          else if (event.type === "error") throw new Error(event.message);
        }
      }
      setStatus("done");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    } finally {
      box.current?.focus();
    }
  }

  const pending = status === "running" ? Math.max(0, 3 - cards.length) : 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-16 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}

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
        <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1">
          <div role="radiogroup" aria-label="Model" className="flex rounded-lg bg-background p-0.5 text-sm">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={model === m.id}
                title={m.hint}
                onClick={() => {
                  setModel(m.id);
                  store.set("loom.model", m.id);
                }}
                className={`rounded-md px-3 py-1 transition-colors ${model === m.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={!moment.trim() || !campaignId || status === "running"}
            className="rounded-lg bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity disabled:opacity-30"
          >
            {status === "running" ? "Weaving…" : "Find threads"}
          </button>
        </div>
      </form>
      <p className="mt-2 px-1 text-xs text-muted">Enter to ask · Shift+Enter for a new line</p>

      {asked && (
        <section aria-live="polite" className="mt-10">
          <p className="mb-4 border-l-2 border-thread pl-3 text-[15px] italic text-muted">{asked}</p>

          {done?.safetyNote && <Note>{done.safetyNote}</Note>}

          <ol className="space-y-3">
            {cards.map((c, i) => (
              <OptionCard key={`${c.label}-${i}`} card={c} n={i + 1} />
            ))}
            {Array.from({ length: pending }, (_, i) => (
              <li key={`pending-${i}`} aria-hidden className="h-32 animate-pulse rounded-xl border border-line bg-surface/60" />
            ))}
          </ol>

          {/* Arrives with the last option, so it goes below the cards rather than shifting them. */}
          {!!done?.notes.length && (
            <div className="mt-3">
              {done.notes.map((n) => (
                <Note key={n}>{n}</Note>
              ))}
            </div>
          )}

          {status === "done" && cards.length === 0 && (
            <p className="mt-4 text-sm text-muted">No options got past the checks this time. Try rephrasing the moment, or ask again.</p>
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

function OptionCard({ card, n }: { card: Card; n: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="rise group rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide">
          <span className="mr-2 text-muted">{n}</span>
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
    </li>
  );
}
