"use client";

import { useEffect, useRef, useState } from "react";
import { post } from "./shell";

// The in-game clock, quietly beside the session: what time it is in the story, and "time passes"
// in a tap. Moving it on lets anyone on the move arrive (Loom records where they've got to).

type Clock = { clock: number | null; words: string | null; arrived: { name: string; place: string }[]; moving: { id: number; name: string; standing: string }[] };
const STEPS = [
  { label: "10 minutes", minutes: 10 },
  { label: "An hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "A day", minutes: 1440 },
];

export function ClockControl({ campaignId }: { campaignId: number }) {
  const [c, setC] = useState<Clock | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const send = (body: object = {}) =>
    post<Clock>("/api/clock", { campaignId, ...body }).then((r) => {
      setC(r);
      if (r.arrived.length) {
        setNote(r.arrived.map((a) => `${a.name} has reached ${a.place}`).join(". "));
        window.dispatchEvent(new Event("loom:reload"));
      }
      return r;
    });
  useEffect(() => void send().catch(() => {}), [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!c) return null;
  // Until the next eight in the morning.
  const untilMorning = c.clock == null ? 0 : ((8 * 60 - (c.clock % 1440) + 1440) % 1440) || 1440;
  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:text-foreground" title="The in-game clock">
        {c.words ?? "Start the clock"}
      </button>
      {open && (
        <div className="glass-panel rise absolute left-0 top-7 z-30 w-64 rounded-xl p-3 text-[13px]">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Time passes</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {STEPS.map((s) => (
              <button key={s.minutes} type="button" onClick={() => void send({ advance: s.minutes })} className="btn-secondary text-xs">
                {s.label}
              </button>
            ))}
            {c.clock != null && (
              <button type="button" onClick={() => void send({ advance: untilMorning })} className="btn-secondary text-xs">
                Until morning
              </button>
            )}
          </div>
          {c.clock == null && <p className="mt-2 text-muted">The clock starts on day 1 at eight in the morning.</p>}
          {note && <p className="mt-2 text-thread">{note}.</p>}
          {c.moving.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">On the move</p>
              <ul className="mt-1 space-y-0.5">
                {c.moving.map((m) => (
                  <li key={m.id}>
                    <span className="font-medium">{m.name}</span> <span className="text-muted">{m.standing}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
