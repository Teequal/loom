"use client";

import { Icon } from "./icons";
import { Linked } from "./loom-ui";

// Session notes as something to read, not a wall of text. Notes come three ways, and all read here:
// - what the GM pasted: paragraphs, bullet points, headings ("Session 5:", "## The ambush");
// - the table's log at wrap-up: "- moment" with "What happened: …", "Then: …" and "Result: …"
//   beneath it, indented as they grew from each other;
// - a hook's premise: "Before the first session (the hook)", then "Opening: …" to read aloud.
// Every name links into the loom.

type Block =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "item"; text: string; depth: number; tag: "moment" | "then" | "result" | "plain" | "topic"; key?: string; happened?: string };

// A line that names a part rather than saying something: short, capitalised, no closing punctuation
// ("Key Events", "The Journey to the Whispering Woods Begins", "Session 5:").
const TITLE = (line: string) => line.length <= 60 && /^[A-Z0-9"']/.test(line) && !/[.!?,;]$/.test(line) && line.split(/\s+/).length <= 9;

export function parseNotes(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  // A bullet ending in ":" heads the bullets after it ("Departure from Duradan:" then what happened there).
  let topic: number | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\t/g, "  ").trimEnd());
  // Indents count from the outermost bullet, so notes pasted with every bullet tabbed in start flush.
  const base = Math.min(...lines.filter((l) => /^\s*(?:[-*•◦▪]|\d+[.)])\s/.test(l)).map((l) => l.length - l.trimStart().length), 99);
  lines.forEach((raw, i) => {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      return;
    }
    const indent = line.length - line.trimStart().length;
    const bullet = trimmed.match(/^(?:[-*•◦▪]|\d+[.)])\s+(.*)$/);
    const happened = trimmed.match(/^What happened:\s*(.*)$/i);
    if (happened && blocks.at(-1)?.kind === "item") {
      flush();
      (blocks.at(-1) as Extract<Block, { kind: "item" }>).happened = happened[1];
      return;
    }
    if (bullet) {
      flush();
      const body = bullet[1].trim();
      const depth = Math.floor(Math.max(0, indent - base) / 2);
      const then = body.match(/^Then:\s*(.*)$/i);
      const result = body.match(/^Result:\s*(.*)$/i);
      if (!then && !result && /:$/.test(body) && body.length <= 60) {
        blocks.push({ kind: "item", depth, text: body.replace(/:$/, ""), tag: "topic" });
        topic = depth;
        return;
      }
      const keyed = !then && !result ? body.match(/^([A-Z][\w' -]{1,24}):\s+(.+)$/) : null;
      blocks.push({
        kind: "item",
        depth: depth + (topic != null && depth <= topic ? 1 : 0),
        text: then?.[1] ?? result?.[1] ?? keyed?.[2] ?? body,
        key: keyed?.[1],
        tag: then ? "then" : result ? "result" : "plain",
      });
      return;
    }
    const opening = trimmed.match(/^Opening:\s*(.*)$/i);
    if (opening) {
      flush();
      blocks.push({ kind: "quote", text: opening[1] });
      return;
    }
    const marked = trimmed.match(/^#{1,4}\s+(.*)$/)?.[1];
    const next = lines.slice(i + 1).find((l) => l.trim())?.trim();
    // A title-like line is a heading when something follows it, so a short closing line stays prose.
    if (marked || /^Before the first session/i.test(trimmed) || (/:$/.test(trimmed) && trimmed.length <= 70) || (TITLE(trimmed) && next !== undefined && !para.length)) {
      flush();
      blocks.push({ kind: "heading", text: (marked ?? trimmed).replace(/:$/, "") });
      topic = null;
      return;
    }
    para.push(trimmed);
    topic = null;
  });
  flush();
  // A logged moment is a bullet with "What happened" beneath it.
  for (const b of blocks) if (b.kind === "item" && b.happened && b.tag === "plain") b.tag = "moment";
  return blocks;
}

export function NotesView({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseNotes(text);
  if (!blocks.length) return <p className="text-sm text-muted">No notes stored.</p>;
  return (
    <div className={`story space-y-2 text-[14.5px] leading-relaxed ${className}`}>
      {blocks.map((b, i) => {
        if (b.kind === "heading")
          return (
            <h4 key={i} className="pt-3 font-sans text-[11px] first:pt-0 font-semibold uppercase tracking-wide text-thread">
              {b.text}
            </h4>
          );
        if (b.kind === "quote")
          return (
            <blockquote key={i} className="border-l-2 border-thread pl-3 italic text-foreground/85">
              <Linked text={b.text} />
            </blockquote>
          );
        if (b.kind === "para")
          return (
            <p key={i}>
              <Linked text={b.text} />
            </p>
          );
        // A logged moment and what came of it, as a small thread: the moment, then what happened.
        return (
          <div key={i} className="relative flex gap-2.5" style={{ marginLeft: `${b.depth * 1.1}rem` }}>
            <span className="mt-[0.45em] shrink-0 text-thread">
              {b.tag === "topic" ? <Icon name="thread" size={12} /> : b.tag === "then" ? <Icon name="branch" size={12} /> : b.tag === "result" ? <Icon name="diamond" size={11} /> : <span className="block h-1.5 w-1.5 translate-y-0.5 rounded-full bg-thread/70" />}
            </span>
            <div className="min-w-0">
              {b.tag === "result" && <span className="mr-1.5 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">Result</span>}
              {b.tag === "then" && <span className="mr-1.5 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">Then</span>}
              {b.key && <span className="mr-1.5 font-sans text-[12px] font-semibold text-muted">{b.key}</span>}
              <span className={b.tag === "moment" ? "text-foreground/80 italic" : b.tag === "topic" ? "font-semibold" : ""}>
                <Linked text={b.text} />
              </span>
              {b.happened && (
                <p className="mt-0.5">
                  <Linked text={b.happened} />
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
