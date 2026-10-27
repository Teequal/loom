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
// A steady random number from a few integers, so a letter's timing doesn't change between redraws.
function rand(a: number, b: number, c: number) {
  let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const TEAR = 300; // ms for one letter to tear away
const WEAVE = 300; // ms for one word to be drawn in
const PER_WORD = 45; // ms between words of the headline as it's woven in

/**
 * A word as letters. "type": they come in a clump of one to three at a time, at uneven gaps, over
 * the blank bar they're filling. "tear": each one frays off on its own, stretched thin, drifting.
 * "weave": the word is drawn in left to right, like a thread pulled through.
 */
function Letters({ text, seed, mode, at = 0 }: { text: string; seed: number; mode: "type" | "tear" | "weave"; at?: number }) {
  const chars = [...text];
  let t = 0;
  let clump = 0;
  const typedAt = chars.map((_, i) => {
    if (clump-- <= 0) {
      t += 25 + rand(seed, i, 1) * 70;
      clump = Math.floor(rand(seed, i, 2) * 3);
    }
    return t;
  });
  if (mode === "weave") return <span className="word word-weave" style={{ animationDelay: `${at}ms` }}>{text}</span>;
  return (
    <span className={`word ${mode === "type" ? "typing" : ""}`} style={mode === "type" ? ({ "--typed": `${t + 160}ms` } as React.CSSProperties) : undefined}>
      {chars.map((c, i) => {
        const style =
          mode === "type"
            ? { animationDelay: `${typedAt[i]}ms` }
            : { animationDelay: `${at + rand(seed, i, 3) * 140}ms`, "--tx": `${(rand(seed, i, 4) - 0.5) * 20}px`, "--ty": `${(rand(seed, i, 5) - 0.5) * 14}px`, "--rot": `${(rand(seed, i, 6) - 0.5) * 40}deg` };
        return (
          <span key={i} className={`ltr ltr-${mode}`} style={style as React.CSSProperties}>
            {c}
          </span>
        );
      })}
    </span>
  );
}

/**
 * One row of the answer while Loom writes it. The row starts as blank bars; the words Loom read come
 * into them letter by letter, paced to fill the row by the time its option usually arrives. When the
 * option comes, those letters tear away like frayed threads and the headline is woven in over them,
 * letter by letter, with a thread drawn across beneath. Then `onLanded`, and the page shows the
 * ordinary headline row in its place.
 */
export function SlotRow({ n, words, startedAt, expectMs, headline, onLanded }: { n: number; words: string[]; startedAt: number; expectMs: number; headline?: string; onLanded: () => void }) {
  const holes = HOLES[n % HOLES.length];
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<"fill" | "tear" | "weave" | "done">("fill");
  const landed = useRef(onLanded);
  useEffect(() => {
    landed.current = onLanded;
  });
  // Row n's option usually comes a little over a second after the one before.
  const due = expectMs + n * 1100;
  // Words come into the holes in no particular order, a few close together: each hole's turn is
  // shuffled, and the row is full well before its option is due.
  const order = holes.map((_, j) => j).sort((a, b) => rand(n, a, 8) - rand(n, b, 8));
  const at = (j: number) => startedAt + due * (0.06 + (0.34 * order.indexOf(j)) / (holes.length - 1)) + rand(n, j, 9) * 220;
  const mine = (j: number) => (words.length ? words[(n * 3 + j) % words.length] : null);
  const filled = holes.map((_, j) => (now >= at(j) ? mine(j) : null));
  useEffect(() => {
    if (phase !== "fill" || headline) return;
    const t = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(t);
  }, [phase, headline]);
  const arrived = !!headline;
  const tearFor = holes.length * 25 + 140 + TEAR; // the last letter gone
  useEffect(() => {
    if (!arrived) return;
    const words = headline!.split(/\s+/).length;
    const tearAt = setTimeout(() => setPhase("tear"), 0);
    // The weaving starts while the last of the old letters are still tearing away.
    const weaveFrom = Math.round(tearFor * 0.4);
    const weaveAt = setTimeout(() => setPhase("weave"), weaveFrom);
    const gone = setTimeout(() => setPhase((p) => (p === "weave" ? "done" : p)), tearFor + 40);
    const done = setTimeout(() => landed.current(), Math.max(tearFor, weaveFrom + words * PER_WORD + WEAVE) + 80);
    return () => [tearAt, weaveAt, gone, done].forEach(clearTimeout);
    // The row turns once, when its headline first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  const oldShown = phase === "fill" || phase === "tear" || phase === "weave";
  const newShown = phase === "weave" || phase === "done";
  return (
    <li aria-hidden={!newShown || undefined}>
      <div className="flex w-full items-baseline gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
        <span className="w-4 shrink-0 text-[13px] text-muted">{n + 1}</span>
        {/* The read words and the headline share one place (a one-cell grid), so the headline can be
            woven in while the old letters are still tearing away, without either moving. */}
        <span className="story grid min-w-0 flex-1 leading-snug max-sm:min-h-[2.75em]">
          {oldShown && (
            <span className="col-start-1 row-start-1 text-muted">
              {holes.map((w, j) =>
                filled[j] ? (
                  <span key={j}>
                    <Letters text={filled[j]!} seed={n * 31 + j} mode={phase === "fill" ? "type" : "tear"} at={j * 25} />{" "}
                  </span>
                ) : (
                  // Once Loom has read the moment, each hole takes the size of the word that will fill it,
                  // so nothing moves when the word comes in.
                  <span key={j} className={`hole ${phase !== "fill" ? "hole-gone" : ""}`} style={{ width: mine(j) ? `${mine(j)!.length * 0.9}ch` : `${w}ch` }} />
                ),
              )}
            </span>
          )}
          {newShown && (
            <span className="weave-in col-start-1 row-start-1" style={{ "--woven": `${headline!.split(/\s+/).length * PER_WORD + WEAVE}ms` } as React.CSSProperties}>
              {headline!.split(/(\s+)/).map((w, j) =>
                /^\s+$/.test(w) ? w : <Letters key={j} text={w} seed={n * 97 + j} mode="weave" at={(j / 2) * PER_WORD} />,
              )}
            </span>
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
