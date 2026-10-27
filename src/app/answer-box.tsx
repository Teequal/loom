"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { Linked } from "./loom-ui";

// What Loom picked out of the moment before writing (names only), and how long the first option
// usually takes on this model.
export type Read = { who: string[]; near: string[]; place: string | null; threads: string[]; expectMs?: number };

// Where each item is drawn in from: around the box's edges, in turn.
const FROM = [
  ["-48px", "0px"],
  ["0px", "-34px"],
  ["48px", "0px"],
  ["-30px", "26px"],
  ["30px", "-26px"],
  ["0px", "30px"],
];

/**
 * The answer box while Loom writes. It draws in what Loom picked out, one thing at a time from
 * outside its edges, paced to land just before the first option usually arrives; a thread fills
 * along its bottom edge over the same time. `turning` plays it turning over, as the options come.
 */
export function Gathering({ read, startedAt, turning }: { read: Read | null; startedAt: number; turning: boolean }) {
  const expect = read?.expectMs ?? 4000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(t);
  }, []);
  const items: { kind: "who" | "where" | "thread"; text: string }[] = read
    ? [
        ...[...read.who, ...read.near.filter((n) => !read.who.includes(n))].slice(0, 4).map((text) => ({ kind: "who" as const, text })),
        ...(read.place ? [{ kind: "where" as const, text: read.place }] : []),
        ...read.threads.map((text) => ({ kind: "thread" as const, text })),
      ]
    : [];
  // Spread over most of the expected wait, so the last lands just before the answer usually does.
  const at = (i: number) => startedAt + expect * (0.12 + (0.6 * i) / Math.max(1, items.length - 1));
  const shown = items.map((x, i) => ({ ...x, i })).filter((x) => now >= at(x.i) || turning);
  const late = now > startedAt + expect * 1.05;
  const row = (kind: "who" | "where" | "thread", label: string) => {
    const xs = shown.filter((x) => x.kind === kind);
    if (!xs.length) return null;
    return (
      <div className="flex items-baseline gap-2">
        <span className="w-14 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</span>
        <span className="flex min-w-0 flex-wrap gap-1.5">
          {xs.map((x) => (
            <span
              key={x.i}
              className={`pull-in ${x.kind === "thread" ? "rounded-full bg-thread-soft px-2 py-0.5 text-[12px] text-thread" : "story text-[15px]"}`}
              style={{ "--dx": FROM[x.i % FROM.length][0], "--dy": FROM[x.i % FROM.length][1] } as React.CSSProperties}
            >
              {x.text}
            </span>
          ))}
        </span>
      </div>
    );
  };
  return (
    <div className="gather" role="status" aria-live="polite">
      <div className={`gather-face relative rounded-xl border border-line bg-surface px-4 pb-4 pt-3.5 shadow-sm ${turning ? "turning" : ""}`}>
        <div className="min-h-[6.5rem] space-y-2.5">
          {row("who", "Who")}
          {row("where", "Where")}
          {row("thread", "Threads")}
          {!shown.length && <p className="text-[13px] text-muted">Reading the moment</p>}
        </div>
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
          <Icon name="pen" size={12} className="text-thread" />
          {late ? "Still writing" : "Writing three ways forward"}
          <span className="read-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </p>
        <div className="absolute inset-x-4 bottom-0 translate-y-px">
          <div className={`gather-line ${late ? "late" : ""}`} style={{ "--expect": `${expect}ms` } as React.CSSProperties} />
        </div>
      </div>
    </div>
  );
}

/** Words that come in one after another (a headline as it arrives). */
export function Words({ text, animate, delay = 0 }: { text: string; animate: boolean; delay?: number }) {
  if (!animate) return <>{text}</>;
  return (
    <>
      {text.split(/(\s+)/).map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={i} className="word-in" style={{ animationDelay: `${delay + i * 22}ms` }}>
            {w}
          </span>
        ),
      )}
    </>
  );
}

export type NowLine = { kind: "moment" | "used" | "then" | "result"; text: string; id?: number };

/**
 * "What just happened": the last few beats of play, kept above the box so the context is always in
 * view as you choose, develop and record. The newest is last; older ones fade.
 */
export function NowStrip({ lines, compact }: { lines: NowLine[]; compact?: boolean }) {
  if (!lines.length) return null;
  const shown = compact ? lines.slice(-1) : lines.slice(-4);
  return (
    <div className="mb-2 px-1" aria-label="What just happened">
      {!compact && <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">What just happened</p>}
      <ol className="space-y-0.5 border-l-2 border-thread/50 pl-3">
        {shown.map((l, i) => {
          const age = shown.length - 1 - i; // 0 is the newest
          return (
            <li
              key={`${l.kind}-${l.id ?? i}-${l.text.slice(0, 20)}`}
              className={`rise story gap-1.5 text-[14px] leading-snug ${age > 1 ? "hidden sm:flex" : "flex"} ${age === 0 ? "text-foreground" : age === 1 ? "text-foreground/75" : "text-muted"}`}
            >
              {l.kind !== "moment" && (
                <span className="mt-[0.35em] shrink-0 text-thread">
                  <Icon name={l.kind === "result" ? "diamond" : l.kind === "then" ? "branch" : "check"} size={11} />
                </span>
              )}
              <span className={`block min-w-0 truncate sm:line-clamp-2 sm:whitespace-normal ${l.kind === "moment" ? "italic" : ""}`}>
                <Linked text={l.text} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
