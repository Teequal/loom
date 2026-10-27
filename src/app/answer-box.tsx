"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Linked } from "./loom-ui";

// What Loom picked out of the moment before writing (names only), and how long the first option
// usually takes on this model.
export type Read = { who: string[]; near: string[]; place: string | null; threads: string[]; expectMs?: number };

// Words that carry nothing on their own, left out of what drops into the holes.
const FILLER = new Set("a an the of to in on at by for and or but is are was be has have had his her their its it he she they them this that what who with from into does do did can cannot will would really just still very not no now".split(" "));

/** The words Loom read, in the order they drop into the empty answer: names first, then the threads' words. */
export function readWords(r: Read | null): string[] {
  if (!r) return [];
  const out: string[] = [];
  const add = (w: string) => {
    const t = w.replace(/[?!.,:;"“”]+$/g, "").replace(/^["“”]+/, "");
    if (t && !FILLER.has(t.toLowerCase()) && !out.includes(t)) out.push(t);
  };
  [...r.who, ...r.near].forEach(add);
  if (r.place) add(r.place);
  for (const t of r.threads) t.split(/\s+/).forEach(add);
  return out;
}

// The holes in each empty row, as widths in characters: a headline's shape, before its words exist.
const HOLES = [
  [5, 8, 3, 7, 4, 6],
  [4, 6, 8, 3, 5, 7, 4],
  [7, 3, 6, 5, 8, 4],
];
const STEP = 34; // ms between words as a row turns over
const FLIP = 240; // ms for one word to turn

/**
 * One row of the answer while Loom writes it. The row starts as holes; the words Loom read drop
 * into them, paced to fill the row by the time its option usually arrives. When the option comes,
 * the words turn over one by one and the headline's words turn in from the other side. Then
 * `onLanded`, and the page shows the ordinary headline row in its place.
 */
export function SlotRow({ n, words, startedAt, expectMs, headline, onLanded }: { n: number; words: string[]; startedAt: number; expectMs: number; headline?: string; onLanded: () => void }) {
  const holes = HOLES[n % HOLES.length];
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<"fill" | "out" | "in">("fill");
  const landed = useRef(onLanded);
  useEffect(() => {
    landed.current = onLanded;
  });
  // Row n's option usually comes a little over a second after the one before.
  const due = expectMs + n * 1100;
  const at = (j: number) => startedAt + due * (0.1 + (0.78 * j) / (holes.length - 1));
  const mine = (j: number) => (words.length ? words[(n * 3 + j) % words.length] : null);
  const filled = holes.map((_, j) => (now >= at(j) ? mine(j) : null));
  useEffect(() => {
    if (phase !== "fill" || headline) return;
    const t = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(t);
  }, [phase, headline]);
  const arrived = !!headline;
  useEffect(() => {
    if (!arrived) return;
    const words = headline!.split(/\s+/).length;
    const outAt = setTimeout(() => setPhase("out"), 0);
    // The new words start turning in while the last of the old ones are still turning away.
    const turnIn = Math.round(holes.length * STEP * 0.6 + FLIP * 0.5);
    const inAt = setTimeout(() => setPhase("in"), turnIn);
    const done = setTimeout(() => landed.current(), turnIn + words * STEP + FLIP + 120);
    return () => {
      clearTimeout(outAt);
      clearTimeout(inAt);
      clearTimeout(done);
    };
    // The row turns once, when its headline first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  return (
    <li aria-hidden={phase !== "in" || undefined}>
      <div className="flex w-full items-baseline gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
        <span className="w-4 shrink-0 text-[13px] text-muted">{n + 1}</span>
        <span className="flaps story min-w-0 flex-1 leading-snug max-sm:min-h-[2.75em]">
          {phase === "in"
            ? headline!.split(/\s+/).map((w, j) => (
                <span key={`h${j}`} className="flap flap-in" style={{ animationDelay: `${j * STEP}ms` }}>
                  {w}{" "}
                </span>
              ))
            : holes.map((w, j) =>
                filled[j] ? (
                  <span key={j} className={`flap ${phase === "out" ? "flap-out" : "drop-in"} text-muted`} style={phase === "out" ? { animationDelay: `${j * STEP}ms` } : undefined}>
                    {filled[j]}{" "}
                  </span>
                ) : (
                  // Once Loom has read the moment, each hole takes the size of the word that will fill it,
                  // so nothing moves when the word drops in.
                  <span key={j} className={`hole ${phase === "out" ? "flap-out" : ""}`} style={{ width: mine(j) ? `${mine(j)!.length * 0.9}ch` : `${w}ch`, ...(phase === "out" ? { animationDelay: `${j * STEP}ms` } : {}) }} />
                ),
              )}
        </span>
      </div>
    </li>
  );
}

export type NowLine = { kind: "moment" | "used" | "then" | "result"; text: string; id?: number };

/**
 * "What just happened": the last few beats of play, above the box, so the context is in view as
 * you choose, develop and record. The newest is last; older ones fade. Tap to read it all.
 */
export function NowStrip({ lines }: { lines: NowLine[] }) {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  const shown = open ? lines : lines.slice(-4);
  return (
    <div className="mb-2 px-1" aria-label="What just happened">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mb-1 flex w-full items-center gap-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted hover:text-foreground">
        What just happened
        <Icon name="arrow" size={11} className={`transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
        <span className="sr-only">{open ? "Show less" : "Show it all"}</span>
      </button>
      <ol className="space-y-0.5 border-l-2 border-thread/50 pl-3">
        {shown.map((l, i) => {
          const age = shown.length - 1 - i; // 0 is the newest
          return (
            <li
              key={`${l.kind}-${l.id ?? "asked"}-${i}`}
              className={`story gap-1.5 text-[14px] leading-snug ${!open && age > 1 ? "hidden sm:flex" : "flex"} ${age === 0 ? "text-foreground" : age === 1 ? "text-foreground/75" : "text-muted"}`}
            >
              {l.kind !== "moment" && (
                <span className="mt-[0.35em] shrink-0 text-thread">
                  <Icon name={l.kind === "result" ? "diamond" : l.kind === "then" ? "branch" : "check"} size={11} />
                </span>
              )}
              {/* Folded, each line is one line (two on a wider screen); open, it's all there. */}
              <span onClick={() => !open && setOpen(true)} className={`min-w-0 ${open ? "" : "block truncate sm:line-clamp-2 sm:whitespace-normal"} ${l.kind === "moment" ? "italic" : ""}`}>
                <Linked text={l.text} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
