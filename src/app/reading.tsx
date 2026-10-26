"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

// Loom's "working on it": what it's reading, a step at a time, then the line it's writing. Steps
// can arrive while it runs (improv sends what it picked out before the model writes); each one
// appears in turn, so a quick answer still shows the picking-out before the writing.
export type ReadStep = { label: string; items?: string[]; chips?: boolean };

export function Reading({ steps = [], final, every = 650, className = "" }: { steps?: ReadStep[]; final: string; every?: number; className?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= steps.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 120 : every);
    return () => clearTimeout(t);
  }, [shown, steps.length, every]);
  const visible = steps.slice(0, shown).filter((s) => !s.items || s.items.length);
  const writing = shown >= steps.length;
  return (
    <div className={`reading ${className}`} role="status" aria-live="polite">
      <ol className="space-y-2 border-l border-line pl-3.5">
        {visible.map((s, i) => (
          <li key={`${s.label}-${i}`} className="read-step flex items-baseline gap-2">
            <span className="w-16 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{s.label}</span>
            {s.chips ? (
              <span className="flex min-w-0 flex-wrap gap-1.5">
                {(s.items ?? []).map((it, j) => (
                  <span key={j} className="read-item rounded-full bg-thread-soft px-2 py-0.5 text-[12px] text-thread" style={{ animationDelay: `${j * 140}ms` }}>
                    {it}
                  </span>
                ))}
              </span>
            ) : (
              <span className="story min-w-0 text-[14px] leading-snug">
                {(s.items ?? []).map((it, j) => (
                  <span key={j} className="read-item" style={{ animationDelay: `${j * 110}ms` }}>
                    {j > 0 && <span className="text-muted"> · </span>}
                    {it}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
        <li className={`flex items-center gap-2 text-[13px] ${writing ? "text-foreground" : "text-muted"}`}>
          <Icon name="pen" size={12} className="text-thread" />
          <span>{final}</span>
          <span className="read-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </li>
      </ol>
    </div>
  );
}
