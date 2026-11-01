"use client";

import { useState } from "react";
import { post } from "./shell";

// A quiet thumbs on anything Loom wrote. Loom leans on these (taste.ts); a thumbs down can say why
// in one tap, which moves how long and how dramatic it writes.
const REASONS = [
  ["long", "Too long"],
  ["dramatic", "Too dramatic"],
  ["flat", "Too flat"],
  ["wrong", "Doesn't fit"],
] as const;
export interface VoteValue {
  vote: 1 | -1;
  why?: string;
}

export function VoteRow({ entryId, voteKey, initial, move, flavour }: { entryId: number; voteKey: string; initial?: VoteValue; move?: string; flavour?: string }) {
  const [v, setV] = useState<VoteValue | null>(initial ?? null);
  const send = (next: VoteValue | null) => {
    setV(next);
    post("/api/live/vote", { entryId, key: voteKey, vote: next ? { ...next, move, flavour } : null }).catch(() => {});
  };
  const side = (vote: 1 | -1, label: string) => (
    <button type="button" aria-pressed={v?.vote === vote} onClick={() => send(v?.vote === vote ? null : { vote })} className={`rounded px-1 py-0.5 ${v?.vote === vote ? "text-thread" : "text-muted/70 hover:text-muted"}`}>
      {label}
    </button>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px] text-muted">
      {side(1, "More like this")}
      {side(-1, "Less like this")}
      {v?.vote === -1 &&
        REASONS.map(([why, label]) => (
          <button key={why} type="button" aria-pressed={v.why === why} onClick={() => send({ vote: -1, why: v.why === why ? undefined : why })} className={`rounded-full px-2 py-0.5 ${v.why === why ? "bg-thread-soft text-thread" : "hover:text-foreground"}`}>
            {label}
          </button>
        ))}
    </div>
  );
}
