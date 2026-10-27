"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

// How many of the words Loom read each row shows while it waits.
const ROW_WORDS = [6, 7, 6];

// A steady random number from a few integers, so a letter's timing doesn't change between redraws.
function rand(a: number, b: number, c: number) {
  let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const TEAR = 300; // ms for one letter to tear away
const SPREAD = 140; // ms over which a word's letters start tearing

/** When each letter of a word lands: clumps of one to three, at uneven gaps (shorter when `fast`). */
function typeTimes(text: string, seed: number, fast = false) {
  let t = 0;
  let clump = 0;
  const at = [...text].map((_, i) => {
    if (clump-- <= 0) {
      t += fast ? 14 + rand(seed, i, 1) * 34 : 25 + rand(seed, i, 1) * 70;
      clump = Math.floor(rand(seed, i, 2) * 3);
    }
    return t;
  });
  return { at, total: t + 220 };
}

/**
 * A word as letters, always laid out where it will stay. "wait": not there yet (invisible, but
 * holding its place). "type": its letters land in clumps at uneven gaps. "tear": each letter frays
 * off on its own, stretched thin, drifting.
 */
function Letters({ text, seed, mode, at = 0, fast = false }: { text: string; seed: number; mode: "wait" | "type" | "tear" | "smoke" | "still"; at?: number; fast?: boolean }) {
  const typed = typeTimes(text, seed, fast).at;
  return (
    <span className="word">
      {[...text].map((c, i) => {
        const style =
          mode === "type"
            ? { animationDelay: `${at + typed[i]}ms` }
            : mode === "tear"
              ? { animationDelay: `${at + rand(seed, i, 3) * SPREAD}ms`, "--tx": `${(rand(seed, i, 4) - 0.5) * 20}px`, "--ty": `${(rand(seed, i, 5) - 0.5) * 14}px`, "--rot": `${(rand(seed, i, 6) - 0.5) * 40}deg` }
              : mode === "smoke"
                ? smokeStyle(seed, i, at)
                : undefined;
        return (
          <span key={i} className={mode === "still" ? "ltr" : `ltr ltr-${mode}`} style={style as React.CSSProperties | undefined}>
            {/* A space inside a name ("Mother Ysolde") would collapse in its own box. */}
            {c === " " ? "\u00a0" : c}
          </span>
        );
      })}
    </span>
  );
}

// Whether two word boxes share any space (a pixel of give, so words that only touch don't count).
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/**
 * One row of the answer while Loom writes it. The words Loom read come in letter by letter, each
 * already where it will sit, in no particular order, a few at a time. When the option arrives, they
 * tear away like frayed threads, a few at a time, and the headline comes in the same way, faster:
 * a headline word that shares no space with a read word starts at once; one that does waits until
 * every read word in its space has gone. Then `onLanded`, and the page shows the ordinary headline
 * row in its place.
 */
export function SlotRow({ n, words, startedAt, knownAt, expectMs, headline, tag, dropped = false, entering = false, onLanded }: { n: number; words: string[]; startedAt: number; knownAt: number | null; expectMs: number; headline?: string; tag?: string; dropped?: boolean; entering?: boolean; onLanded: () => void }) {
  const count = ROW_WORDS[n % ROW_WORDS.length];
  const [now, setNow] = useState(() => Date.now());
  const [plan, setPlan] = useState<{ gone: number[]; start: number[] } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const landed = useRef(onLanded);
  useEffect(() => {
    landed.current = onLanded;
  });
  // Row n's option usually comes a little over a second after the one before.
  const due = expectMs + n * 1100;
  // Words come in no particular order, a few close together, over the time left before the option
  // is usually due (at least about a second), counted from when Loom knew them, not from the ask:
  // they arrive a moment after the ask, and timing from the ask would bring them all in at once.
  const order = Array.from({ length: count }, (_, j) => j).sort((a, b) => rand(n, a, 8) - rand(n, b, 8));
  const span = knownAt == null ? 0 : Math.max(1000, startedAt + due * 0.6 - knownAt);
  const at = (j: number) => (knownAt == null ? Infinity : knownAt + 120 + (span * order.indexOf(j)) / (count - 1) + rand(n, j, 9) * 200);
  const mine = Array.from({ length: words.length ? count : 0 }, (_, j) => words[(n * 3 + j) % words.length]);
  const arrived = !!headline;
  // Which read words had come in when the option arrived (the rest never show).
  const [shownAtTurn, setShownAtTurn] = useState<boolean[] | null>(null);
  useEffect(() => {
    if (arrived) return;
    const t = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(t);
  }, [arrived]);
  const outWords = headline ? headline.split(/\s+/) : [];
  // When the option arrives: measure where every word sits, then plan. Read words tear away a few
  // at a time; a headline word waits for the read words in its space to go.
  useLayoutEffect(() => {
    if (!arrived || !box.current) return;
    const shown = mine.map((_, j) => Date.now() >= at(j));
    setShownAtTurn(shown);
    const rectsOf = (attr: string) => [...box.current!.querySelectorAll<HTMLElement>(`[${attr}]`)].map((el) => el.getBoundingClientRect());
    const mRects = rectsOf("data-m");
    const oRects = rectsOf("data-o");
    const gone = mine.map((w, j) => (shown[j] ? rand(n, j, 11) * 320 + SPREAD + TEAR : 0));
    const start = outWords.map((_, k) => {
      const under = mRects.map((r, j) => (shown[j] && oRects[k] && overlaps(r, oRects[k]) ? gone[j] : -1)).filter((g) => g >= 0);
      return under.length ? Math.max(...under) - 60 + rand(n, k, 12) * 70 : rand(n, k, 12) * 240;
    });
    setPlan({ gone, start });
    const end = Math.max(0, ...gone, ...start.map((s, k) => s + typeTimes(outWords[k], n * 97 + k, true).total));
    const done = setTimeout(() => landed.current(), end + 120);
    return () => clearTimeout(done);
    // The row turns once, when its headline first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  return (
    // Its option never came (the checks dropped it): the row goes up in smoke, the card and each
    // word Loom read on their own timing, then closes.
    <li aria-hidden={!plan || undefined} className={dropped ? "smoke rounded-xl" : entering ? "row-in" : undefined}>
      <div className={`flex w-full items-start gap-3 rounded-xl px-4 py-3 ${dropped ? "smoke-pane" : "border border-line bg-surface shadow-sm"}`}>
        {/* The read words and the headline share one place (a one-cell grid), each word laid out
            where it stays, so nothing moves as letters come and go. */}
        <span ref={box} className="story grid min-w-0 flex-1 leading-snug max-sm:min-h-[2.75em]">
          <span className="col-start-1 row-start-1 text-muted">
            {mine.map((w, j) => {
              const turned = shownAtTurn ?? null;
              const mode = turned ? (turned[j] ? "tear" : "wait") : now >= at(j) ? (dropped ? "smoke" : "type") : "wait";
              return (
                <span key={j} data-m={j}>
                  <Letters text={w} seed={n * 31 + j} mode={mode} at={turned && plan ? plan.gone[j] - SPREAD - TEAR : 0} />{" "}
                </span>
              );
            })}
          </span>
          {arrived && (
            <span className="col-start-1 row-start-1">
              {outWords.map((w, k) => (
                <span key={k} data-o={k}>
                  <Letters text={w} seed={n * 97 + k} mode={plan ? "type" : "wait"} at={plan?.start[k] ?? 0} fast />{" "}
                </span>
              ))}
            </span>
          )}
        </span>
        {/* The tag's place is kept from the start, so it fades in without moving any words. */}
        <span className="mt-0.5 flex min-w-[5rem] shrink-0 justify-end">{tag && plan && <span className="drop-in rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread">{tag}</span>}</span>
      </div>
    </li>
  );
}

// One letter going up in smoke: its own moment, how long, and which way it drifts.
function smokeStyle(seed: number, i: number, at: number) {
  return {
    animationDelay: `${at + rand(seed, i, 21) * 420}ms`,
    animationDuration: `${700 + rand(seed, i, 22) * 500}ms`,
    "--sx": `${(rand(seed, i, 23) - 0.5) * 18}px`,
    "--sy": `${-10 - rand(seed, i, 24) * 22}px`,
    "--sr": `${(rand(seed, i, 25) - 0.5) * 30}deg`,
  };
}

/**
 * Text going up in smoke: each letter (and each word-sized piece) rises, spreads, blurs and fades
 * on its own, at its own moment. `at` delays the whole of it.
 */
export function Smoke({ text, seed, at = 0 }: { text: string; seed: number; at?: number }) {
  return (
    <>
      {text.split(/(\s+)/).map((w, j) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={j} className="word">
            {[...w].map((c, i) => (
              <span
                key={i}
                className="ltr ltr-smoke"
                style={smokeStyle(seed + j, i, at) as React.CSSProperties}
              >
                {c}
              </span>
            ))}
          </span>
        ),
      )}
    </>
  );
}

/** The words of a text worth drawing in while Loom writes from it: no filler, no repeats. */
export function keyWords(text: string, limit = 7): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/)) {
    const t = w.replace(/[?!.,:;"“”()]+$/g, "").replace(/^["“”(]+/, "");
    if (t.length > 2 && !FILLER.has(t.toLowerCase()) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, limit);
}

/**
 * Text being written in, the way answer rows are, for anything longer (a Develop step).
 * - `from`: words that hold the space first. While `text` hasn't come, they type in letter by
 *   letter, a few at a time, over `fill` ms (or show at once with `fromShown`: the old wording of a
 *   step being reworked).
 * - `text`: when it comes, `from` tears away a few words at a time, and `text` types in: a word that
 *   shares no space with one of `from` at once, one that does once those have gone. Then `onDone`.
 * Letters sit in their own boxes; `.steady` text (kerning off) sits the same, so the parent can
 * swap in its ordinary rendering afterwards without anything moving.
 */
export function WriteIn({ from = [], fromShown = false, text, seed, fill = 2200, onDone, className = "" }: { from?: string[]; fromShown?: boolean; text?: string; seed: number; fill?: number; onDone?: () => void; className?: string }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const [plan, setPlan] = useState<{ gone: number[]; start: number[]; shown: boolean[] } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const order = from.map((_, j) => j).sort((a, b) => rand(seed, a, 8) - rand(seed, b, 8));
  const at = (j: number) => (fromShown ? -Infinity : mountedAt + 150 + (fill * order.indexOf(j)) / Math.max(1, from.length - 1) + rand(seed, j, 9) * 200);
  const arrived = text != null;
  useEffect(() => {
    if (arrived || fromShown || !from.length) return;
    const t = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(t);
  }, [arrived, fromShown, from.length]);
  const outWords = text ? text.split(/\s+/).filter(Boolean) : [];
  useLayoutEffect(() => {
    if (!arrived || !box.current) return;
    const shown = from.map((_, j) => Date.now() >= at(j));
    const rectsOf = (attr: string) => [...box.current!.querySelectorAll<HTMLElement>(`[${attr}]`)].map((el) => el.getBoundingClientRect());
    const mRects = rectsOf("data-m");
    const oRects = rectsOf("data-o");
    const gone = from.map((_, j) => (shown[j] ? rand(seed, j, 11) * 280 + SPREAD + TEAR : 0));
    const start = outWords.map((_, k) => {
      const under = mRects.map((r, j) => (shown[j] && oRects[k] && overlaps(r, oRects[k]) ? gone[j] : -1)).filter((g) => g >= 0);
      return under.length ? Math.max(...under) - 60 + rand(seed, k, 12) * 70 : rand(seed, k, 12) * 260;
    });
    setPlan({ gone, start, shown });
    const end = Math.max(0, ...gone, ...start.map((st, k) => st + typeTimes(outWords[k], seed * 7 + k, true).total));
    const t = setTimeout(() => done.current?.(), end + 80);
    return () => clearTimeout(t);
    // Written in once, when its text first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  return (
    <span ref={box} className={`steady grid ${className}`}>
      {from.length > 0 && (
        <span className="col-start-1 row-start-1 text-muted">
          {from.map((w, j) => {
            const mode = plan ? (plan.shown[j] ? "tear" : "wait") : fromShown || now >= at(j) ? (fromShown ? "still" : "type") : "wait";
            return (
              <span key={j} data-m={j}>
                <Letters text={w} seed={seed * 31 + j} mode={mode} at={plan ? plan.gone[j] - SPREAD - TEAR : 0} />{" "}
              </span>
            );
          })}
        </span>
      )}
      {arrived && (
        <span className="col-start-1 row-start-1">
          {outWords.map((w, k) => (
            <span key={k} data-o={k}>
              <Letters text={w} seed={seed * 7 + k} mode={plan ? "type" : "wait"} at={plan?.start[k] ?? 0} fast />{" "}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Text set as the answer rows set it while they're written: each word its own box, each letter its
 * own box. A finished headline uses this too, so swapping it in for the row being written doesn't
 * move a single letter (letters in their own boxes lose the font's kerning, so plain text would
 * sit a little to the left).
 */
export function Still({ text }: { text: string }) {
  return (
    <>
      {text.split(/\s+/).map((w, k) => (
        <span key={k}>
          <span className="word">
            {[...w].map((c, i) => (
              <span key={i} className="ltr">
                {c === " " ? "\u00a0" : c}
              </span>
            ))}
          </span>{" "}
        </span>
      ))}
    </>
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
