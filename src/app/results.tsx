"use client";

import { useState } from "react";
import { post } from "./shell";

// "How did it go?" for a roll or a fight: a few outcomes to tap, an optional line of detail, and a
// quiet way to skip. Used in the table's tray and again at wrap-up.

const OUTCOMES = {
  roll: ["Succeeded", "Failed", "Partly"],
  fight: ["Won", "Fled", "Lost", "Talked it out"],
} as const;

export function ResultPrompt({
  entryId,
  kind,
  label,
  onDone,
  count,
  folded = false,
}: {
  entryId: number;
  kind: "roll" | "fight";
  label: string;
  onDone: () => Promise<unknown> | void;
  count?: string;
  folded?: boolean; // still playing out: one quiet line until you're ready to record it
}) {
  const [open, setOpen] = useState(!folded);
  const [outcome, setOutcome] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await post("/api/live/result", { entryId, ...body });
      setOutcome("");
      setDetail("");
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="rise flex items-center justify-between gap-3 rounded-xl border border-thread/50 bg-thread-soft/40 px-3 py-1.5 text-[13px]">
        <span className="min-w-0 truncate text-muted">
          <span className="text-thread">{kind === "fight" ? "Fight in progress" : "Roll in play"}</span> · record how it went when it&apos;s over
        </span>
        <button type="button" onClick={() => setOpen(true)} className="btn-secondary shrink-0 text-xs">
          Record result
        </button>
      </div>
    );
  return (
    <div className="rise rounded-xl border-2 border-thread/70 bg-thread-soft/60 p-3 text-sm" role="alert">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          {kind === "fight" ? "How did the fight go?" : "How did the roll go?"}
          {count ? ` · ${count}` : ""}
        </p>
        <button type="button" disabled={busy} onClick={() => send({ skip: true })} className="btn-tertiary text-xs" title="Don't record a result for this">
          skip
        </button>
      </div>
      <p className="story mt-0.5 truncate text-[14px] text-foreground/85">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {OUTCOMES[kind].map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={outcome === o}
            onClick={() => setOutcome(outcome === o ? "" : o)}
            className={`rounded-full px-3 py-0.5 text-[13px] transition-colors ${outcome === o ? "bg-foreground text-background" : "border border-line bg-surface text-foreground/80 hover:border-thread/60"}`}
          >
            {o}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send({ outcome, detail });
        }}
      >
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={kind === "fight" ? "What happened? Who fell, what was taken…" : "What happened? (optional)"}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1 text-[13px] outline-none focus:border-thread/60"
        />
        <button disabled={busy || (!outcome && !detail.trim())} className="btn-primary text-sm">
          Record
        </button>
      </form>
    </div>
  );
}
