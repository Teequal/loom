"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { post } from "./shell";
import { Icon } from "./icons";

// Walking the loom from anywhere. Anything with an identity is a Ref: hover (or long-press) for a
// preview, click to open it in the inspector, where every connection is another Ref. The trail
// at the top of the inspector is the path you took, so you can step back or jump to any point.

type Kind = "thread" | "entity" | "moment" | "session";
interface IndexNode {
  kind: Kind;
  id: number;
  name: string;
  aliases: string[];
  sub: string;
  status: string | null;
  line: string;
}
interface Ref {
  kind: Kind;
  id: number;
  name: string;
  sub?: string;
  status?: string | null;
}

interface LoomCtx {
  campaignId: number;
  index: IndexNode[];
  find: (kind: Kind, id: number) => IndexNode | undefined;
  open: (r: Ref) => void;
  trail: Ref[];
  reload: () => void;
  linker: Linker | null;
}
type Linker = { re: RegExp; of: Map<string, IndexNode> };

// One pattern for every name and alias in the campaign (longest first), built once per index.
function buildLinker(index: IndexNode[]): Linker | null {
  const names = index
    .filter((n) => n.kind === "entity")
    .flatMap((n) => [n.name, ...n.aliases].filter((a) => a.length >= 3 && /^[A-Z]/.test(a)).map((a) => [a, n] as const));
  if (!names.length) return null;
  names.sort((a, b) => b[0].length - a[0].length);
  return { re: new RegExp(`\\b(${names.map(([a]) => escape(a)).join("|")})(?![\\w'’])`, "g"), of: new Map(names) };
}
const Ctx = createContext<LoomCtx | null>(null);
export const useLoom = () => useContext(Ctx);

export function LoomProvider({ campaignId, children }: { campaignId: number; children: React.ReactNode }) {
  const [index, setIndex] = useState<IndexNode[]>([]);
  const [trail, setTrail] = useState<Ref[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    post<{ nodes: IndexNode[] }>("/api/loom", { campaignId })
      .then((r) => setIndex(r.nodes))
      .catch(() => {});
  }, [campaignId, version]);
  const byKey = useMemo(() => new Map(index.map((n) => [`${n.kind}:${n.id}`, n])), [index]);
  const linker = useMemo(() => buildLinker(index), [index]);
  const open = useCallback((r: Ref) => {
    setTrail((t) => {
      const at = t.findIndex((x) => x.kind === r.kind && x.id === r.id);
      return at >= 0 ? t.slice(0, at + 1) : [...t, r].slice(-12);
    });
  }, []);
  const value = useMemo<LoomCtx>(
    () => ({ campaignId, index, find: (k, id) => byKey.get(`${k}:${id}`), open, trail, reload: () => setVersion((v) => v + 1), linker }),
    [campaignId, index, byKey, open, trail, linker],
  );
  // Jump anywhere: ⌘K / Ctrl+K, or the search button in the header (which sends "loom:search").
  const [searching, setSearching] = useState(false);
  const [rules, setRules] = useState<{ question: string } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching((v) => !v);
      }
    };
    const onAsk = () => setSearching(true);
    // Rules: "?" outside a text box, the header button, or the table's chip (with the question).
    const onRules = (e: Event) => setRules({ question: (e as CustomEvent<string>).detail ?? "" });
    const onQ = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setRules({ question: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onQ);
    window.addEventListener("loom:search", onAsk);
    window.addEventListener("loom:rules", onRules);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onQ);
      window.removeEventListener("loom:search", onAsk);
      window.removeEventListener("loom:rules", onRules);
    };
  }, []);
  return (
    <Ctx.Provider value={value}>
      {children}
      {trail.length > 0 && <Inspector trail={trail} setTrail={setTrail} />}
      {rules && <RulesPanel key={rules.question} campaignId={campaignId} initial={rules.question} onClose={() => setRules(null)} />}
      {searching && (
        <Palette
          index={index}
          onPick={(n) => {
            setSearching(false);
            open({ kind: n.kind, id: n.id, name: n.name, sub: n.sub, status: n.status });
          }}
          onClose={() => setSearching(false)}
        />
      )}
    </Ctx.Provider>
  );
}

// ---------- rules questions ----------

interface RulesAnswer {
  answer: string;
  rule: string;
  here: string;
  srd: boolean;
  check: string;
  llm: { model: string; seconds: number; costUsd: number };
}

// Slides in over the page and knows the session: the scene, conditions, toggles, house rules and
// the last few moments. Keeps the last few answers so a follow-up reads in context.
function RulesPanel({ campaignId, initial, onClose }: { campaignId: number; initial: string; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [log, setLog] = useState<{ q: string; a: RulesAnswer | null; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = useCallback(
    async (question: string) => {
      if (!question.trim()) return;
      setBusy(true);
      setLog((l) => [...l, { q: question, a: null }]);
      setQ("");
      try {
        const a = await post<RulesAnswer>("/api/rules", { campaignId, question });
        setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, a } : x)));
      } catch (e) {
        setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, error: e instanceof Error ? e.message : "Couldn't answer that." } : x)));
      } finally {
        setBusy(false);
      }
    },
    [campaignId],
  );
  const asked = useRef(false);
  useEffect(() => {
    if (initial && !asked.current) {
      asked.current = true;
      void ask(initial);
    }
  }, [initial, ask]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <aside aria-label="Rules" className="rise fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[420px] sm:rounded-2xl">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="text-sm font-medium">Rules</p>
        <button type="button" onClick={onClose} className="btn-tertiary" aria-label="Close rules">
          <Icon name="close" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3 text-sm">
        {!log.length && <p className="text-muted">Ask anything about the rules. Loom answers for this table: who&apos;s in the scene, their state, your rule settings and house rules.</p>}
        {log.map((x, i) => (
          <div key={i}>
            <p className="font-medium">{x.q}</p>
            {!x.a && !x.error && <p className="mt-1 animate-pulse text-xs text-muted">Looking it up…</p>}
            {x.error && <p className="mt-1 text-xs text-danger">{x.error}</p>}
            {x.a && (
              <div className="mt-1.5 space-y-1.5">
                <p className="story leading-relaxed">
                  <Linked text={x.a.answer} />
                </p>
                {x.a.here && (
                  <p className="text-[13px]">
                    <span className="text-muted">At your table: </span>
                    <Linked text={x.a.here} />
                  </p>
                )}
                <p className="text-xs text-muted">
                  {x.a.rule}
                  {!x.a.srd && " · not in the free SRD"}
                </p>
                {x.a.check && <p className="rounded-lg bg-background px-2.5 py-1.5 text-xs text-muted">Worth checking: {x.a.check}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Can a restrained character cast a spell?"
          className="min-w-0 flex-1 rounded-lg border border-line bg-background px-3 py-1.5 text-sm outline-none focus:border-thread/60"
        />
        <button disabled={busy || !q.trim()} className="btn-primary text-sm">
          Ask
        </button>
      </form>
    </aside>,
    document.body,
  );
}

// ---------- jump anywhere ----------

const KIND_LABEL: Record<Kind, string> = { entity: "Cast and places", thread: "Threads", moment: "Key moments", session: "Sessions" };

function Palette({ index, onPick, onClose }: { index: IndexNode[]; onPick: (n: IndexNode) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const score = (n: IndexNode) => {
      const names = [n.name, ...n.aliases].map((x) => x.toLowerCase());
      if (names.some((x) => x === term)) return 5;
      if (names.some((x) => x.startsWith(term))) return 4;
      if (names.some((x) => x.split(/[\s,'’-]+/).some((w) => w.startsWith(term)))) return 3;
      if (names.some((x) => x.includes(term))) return 2;
      if (n.line?.toLowerCase().includes(term)) return 1;
      return 0;
    };
    const hits = index
      .map((n) => ({ n, s: score(n) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.n.name.length - b.n.name.length)
      .slice(0, 12);
    // Grouped by kind, groups in order of their best match, so each heading shows once.
    const best = new Map<Kind, number>();
    hits.forEach((h, i) => !best.has(h.n.kind) && best.set(h.n.kind, i));
    return hits.sort((a, b) => best.get(a.n.kind)! - best.get(b.n.kind)!).map((x) => x.n);
  }, [q, index]);
  const pick = results[Math.min(at, results.length - 1)];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div role="dialog" aria-label="Jump to anything" onMouseDown={(e) => e.stopPropagation()} className="rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon name="search" className="text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((a) => Math.min(a + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((a) => Math.max(a - 1, 0));
              }
              if (e.key === "Enter" && pick) onPick(pick);
            }}
            placeholder="Jump to a character, place, thread, moment or session"
            className="w-full bg-transparent py-3.5 text-[15px] outline-none placeholder:text-muted/70"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-muted">esc</kbd>
        </div>
        {q.trim() && (
          <ul className="max-h-[50vh] overflow-y-auto overscroll-contain py-1.5">
            {!results.length && <li className="px-4 py-3 text-sm text-muted">Nothing in the loom matches “{q}”.</li>}
            {results.map((n, i) => (
              <li key={`${n.kind}:${n.id}`}>
                {(i === 0 || results[i - 1].kind !== n.kind) && <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{KIND_LABEL[n.kind]}</p>}
                <button
                  type="button"
                  onMouseEnter={() => setAt(i)}
                  onClick={() => onPick(n)}
                  className={`flex w-full items-baseline justify-between gap-3 px-4 py-1.5 text-left ${i === at ? "bg-thread-soft" : ""}`}
                >
                  <span className="min-w-0 truncate">{n.name}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {n.sub}
                    {n.status && !["alive", "intact", "open", "key", "progressing", "resolved", "suggested"].includes(n.status) ? ` · ${n.status}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!q.trim() && <p className="px-4 py-3 text-xs text-muted">Type a name, a place or a word. ↑↓ to choose, Enter to open.</p>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- refs, previews and linked text ----------

export function RefLink({ r, chip = false, children }: { r: Ref; chip?: boolean; children?: React.ReactNode }) {
  const loom = useLoom();
  const [preview, setPreview] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const label = children ?? r.name;
  if (!loom) return chip ? <span className="rounded-full bg-thread-soft px-2.5 py-0.5 text-xs text-thread">{label}</span> : <>{label}</>;
  const show = () => {
    timer.current = setTimeout(() => el.current && setPreview(el.current.getBoundingClientRect()), 350);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setPreview(null);
  };
  return (
    <>
      <button
        ref={el}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          // Inside a fold-out (a session's summary row) the link opens the inspector, not the fold.
          e.preventDefault();
          e.stopPropagation();
          hide();
          loom.open(r);
        }}
        className={
          chip
            ? `rounded-full px-2.5 py-0.5 text-xs transition-colors ${r.status === "resolved" || r.status === "dead" ? "bg-background text-muted line-through" : "bg-thread-soft text-thread hover:brightness-110"}`
            : "rounded-sm text-left underline decoration-thread/40 decoration-dotted underline-offset-[3px] hover:text-thread hover:decoration-thread"
        }
      >
        {label}
      </button>
      {preview && <Preview r={r} at={preview} />}
    </>
  );
}

function Preview({ r, at }: { r: Ref; at: DOMRect }) {
  const loom = useLoom();
  const n = loom?.find(r.kind, r.id);
  const below = at.bottom + 140 < window.innerHeight;
  return createPortal(
    <div
      role="tooltip"
      style={{ left: Math.min(at.left, window.innerWidth - 300), top: below ? at.bottom + 6 : undefined, bottom: below ? undefined : window.innerHeight - at.top + 6 }}
      className="rise pointer-events-none fixed z-50 w-72 rounded-lg border border-line bg-surface p-3 text-left text-[13px] shadow-lg"
    >
      <p className="font-medium text-foreground">{n?.name ?? r.name}</p>
      <p className="text-xs text-muted">
        {n?.sub ?? r.sub}
        {(n?.status ?? r.status) && !["alive", "intact", "open", "key"].includes((n?.status ?? r.status)!) ? ` · ${n?.status ?? r.status}` : ""}
      </p>
      {n?.line && <p className="mt-1 line-clamp-3 text-foreground/80">{n.line}</p>}
      <p className="mt-1.5 text-[11px] text-muted">Click to open</p>
    </div>,
    document.body,
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Text with every known name in it linked: characters, places, items, factions (and aliases).
export function Linked({ text }: { text: string }) {
  const loom = useLoom();
  const re = loom?.linker;
  if (!re || !text) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re.re)) {
    const n = re.of.get(m[1]);
    if (!n || m.index == null) continue;
    out.push(text.slice(last, m.index));
    out.push(
      <RefLink key={m.index} r={{ kind: n.kind, id: n.id, name: n.name, sub: n.sub, status: n.status }}>
        {m[1]}
      </RefLink>,
    );
    last = m.index + m[1].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export function RefChips({ refs }: { refs: Ref[] }) {
  if (!refs.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {refs.map((r) => (
        <RefLink key={`${r.kind}:${r.id}`} r={r} chip />
      ))}
    </div>
  );
}

// ---------- the inspector ----------

/* eslint-disable @typescript-eslint/no-explicit-any -- node detail shapes vary by kind; each view reads its own fields */
type Node = any;

function Inspector({ trail, setTrail }: { trail: Ref[]; setTrail: (t: Ref[]) => void }) {
  const loom = useLoom()!;
  const current = trail[trail.length - 1];
  const [node, setNode] = useState<Node | null>(null);
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, Node>());
  const key = `${current.kind}:${current.id}`;

  useEffect(() => {
    const hit = cache.current.get(key);
    post<Node>("/api/loom/node", { campaignId: loom.campaignId, kind: current.kind, id: current.id })
      .then((n) => {
        cache.current.set(key, n);
        setNode(n);
        setError("");
      })
      .catch((e) => setError(e.message));
    if (hit) queueMicrotask(() => setNode(hit));
  }, [key, current.kind, current.id, loom.campaignId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTrail([]);
      if (e.key === "Backspace" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && trail.length > 1) setTrail(trail.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trail, setTrail]);

  const shown = node && node.kind === current.kind && node.id === current.id ? node : null;

  // On a phone it's a sheet: drag the top down to close it.
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const touch = {
    onTouchStart: (e: React.TouchEvent) => (start.current = e.touches[0].clientY),
    onTouchMove: (e: React.TouchEvent) => start.current != null && setDrag(Math.max(0, e.touches[0].clientY - start.current)),
    onTouchEnd: () => {
      if (drag > 90) setTrail([]);
      setDrag(0);
      start.current = null;
    },
  };

  return (
    <aside
      aria-label="Loom inspector"
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      className={`fixed inset-x-0 bottom-0 z-40 flex max-h-[78vh] flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[400px] sm:rounded-2xl ${drag ? "" : "transition-transform"}`}
    >
      <div {...touch} aria-hidden className="flex justify-center pt-2 sm:hidden">
        <span className="h-1 w-9 rounded-full bg-line" />
      </div>
      <div {...touch} className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs text-muted [scrollbar-width:none]">
          {trail.map((r, i) => (
            <span key={`${r.kind}:${r.id}`} className="flex shrink-0 items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              <button
                type="button"
                onClick={() => setTrail(trail.slice(0, i + 1))}
                className={`max-w-[9rem] truncate ${i === trail.length - 1 ? "font-medium text-foreground" : "hover:text-foreground"}`}
              >
                {r.name}
              </button>
            </span>
          ))}
        </nav>
        {trail.length > 1 && (
          <button type="button" onClick={() => setTrail(trail.slice(0, -1))} className="text-xs text-muted hover:text-foreground" aria-label="Back">
            ← Back
          </button>
        )}
        <button type="button" onClick={() => setTrail([])} className="btn-tertiary" aria-label="Close inspector">
          <Icon name="close" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 text-sm">
        {error && <p className="text-danger">{error}</p>}
        {!shown && !error && <div aria-hidden className="h-24 animate-pulse rounded-lg bg-background" />}
        {shown?.kind === "entity" && <EntityView n={shown} />}
        {shown?.kind === "thread" && <ThreadView n={shown} />}
        {shown?.kind === "moment" && <MomentView n={shown} />}
        {shown?.kind === "session" && <SessionView n={shown} />}
      </div>
    </aside>
  );
}

function Head({ n, chips }: { n: Node; chips?: (string | null | false | undefined)[] }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold leading-snug">{n.name}</h2>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
        <span>{n.sub}</span>
        {chips?.filter(Boolean).map((c) => (
          <span key={c as string} className={c === "dead" || c === "destroyed" ? "text-danger" : ""}>
            · {c}
          </span>
        ))}
      </p>
    </div>
  );
}

// A section that shows a few items and folds the rest away.
function Section({ title, items, render, initial = 4 }: { title: string; items: any[]; render: (x: any, i: number) => React.ReactNode; initial?: number }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const shown = all ? items : items.slice(0, initial);
  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title} <span className="font-normal">{items.length}</span>
      </h3>
      <ul className="space-y-1.5">{shown.map(render)}</ul>
      {items.length > initial && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1.5 text-xs text-muted hover:text-foreground">
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

// "this session", "last session", "3 sessions ago": time at the scale people remember it.
const ago = (session: number, latest: number) => {
  const d = latest - session;
  return d <= 0 ? "this session" : d === 1 ? "last session" : `${d} sessions ago`;
};

const Lock = () => (
  <span title="GM only" className="ml-1 text-[11px]">
    🔒
  </span>
);

function EntityView({ n }: { n: Node }) {
  return (
    <>
      <Head n={n} chips={[n.status !== "alive" && n.status !== "intact" && n.status, n.attitude, n.importance, n.activity && n.activity.band !== "active" && (n.activity.band === "very active" ? "on stage a lot lately" : "quiet lately")]} />
      {n.description && (
        <p className="story leading-relaxed">
          <Linked text={n.description} />
        </p>
      )}
      {n.where.length > 0 && (
        <p className="mt-2 text-[13px] text-muted">
          {n.type === "location" ? "Inside " : "Last at "}
          {n.where.map((r: Ref, i: number) => (
            <span key={r.id}>
              {i > 0 && " › "}
              <RefLink r={r} />
            </span>
          ))}
        </p>
      )}
      {n.partOf && (
        <p className="mt-1 text-[13px] text-muted">
          Part of <RefLink r={n.partOf} />
        </p>
      )}
      <Section
        title="Ties"
        items={n.ties}
        initial={6}
        render={(t: any, i) => (
          <li key={i} className="text-[13.5px]">
            {/* Ties read as sentences: "holds the Knight figurine", "Varek hunts". */}
            {t.out ? (
              <>
                <span className="text-muted">{t.type}</span> <RefLink r={t.other} />
              </>
            ) : (
              <>
                <RefLink r={t.other} /> <span className="text-muted">{t.type}</span>
              </>
            )}
            {t.note && <span className="text-muted">: {t.note}</span>}
            {t.secret && <Lock />}
            {/* The tie's story, condensed: what it was, and how long ago it changed. */}
            {(t.was.length > 0 || t.since) && (
              <span className="block text-xs text-muted">
                {t.was.map((w: any) => `was ${w.type}${w.until != null ? ` until ${ago(w.until, n.latestSession)}` : ""}`).join(" · ")}
                {!t.was.length && t.since != null ? `since session ${t.since}` : ""}
              </span>
            )}
          </li>
        )}
      />
      <Section
        title="Former ties"
        items={n.formerTies}
        initial={3}
        render={(t: any, i) => (
          <li key={i} className="text-[13px] text-muted">
            was {t.type} <RefLink r={t.other} />
            {t.until != null ? `, until ${ago(t.until, n.latestSession)}` : ""}
          </li>
        )}
      />
      <Section title="Threads" items={n.threads} initial={6} render={(r: Ref) => <li key={r.id}><RefLink r={r} /> <span className="text-xs text-muted">{r.sub}</span></li>} />
      <Section title={n.type === "location" ? "Here" : "Holds and contains"} items={n.contains} initial={6} render={(r: Ref) => <li key={r.id}><RefLink r={r} /> <span className="text-xs text-muted">{r.sub}</span></li>} />
      <Section
        title="Details"
        items={n.details}
        initial={5}
        render={(d: any) => (
          <li key={d.key} className="text-[13.5px]">
            <span className="text-muted">{d.key}:</span> <Linked text={d.value} />
            {d.secret && <Lock />}
          </li>
        )}
      />
      <Section title="Key moments" items={n.moments} render={(r: Ref) => <li key={r.id}><RefLink r={r} /></li>} />
      <Section
        title="History"
        items={[...n.history].reverse()}
        initial={3}
        render={(h: any, i) => (
          <li key={i} className="text-[13px]">
            <span className="text-xs text-muted">{h.session != null ? `s${h.session} ` : ""}</span>
            <Linked text={h.text} />
          </li>
        )}
      />
    </>
  );
}

function ThreadView({ n }: { n: Node }) {
  return (
    <>
      <Head n={n} chips={[n.firstSeen && `since s${n.firstSeen}`, n.lastTouched && n.lastTouched !== n.firstSeen && `last s${n.lastTouched}`, n.secret && "GM only"]} />
      <p className="story leading-relaxed">
        <Linked text={n.summary} />
      </p>
      {n.stakes && (
        <p className="mt-2 text-[13px]">
          <span className="text-muted">Stakes:</span> <Linked text={n.stakes.text} />
          {n.stakes.secret && <Lock />}
        </p>
      )}
      {n.deadline && (
        <p className="mt-1 text-[13px]">
          <span className="text-muted">Deadline:</span> {n.deadline.text}
          {n.deadline.secret && <Lock />}
        </p>
      )}
      <Section title="Involves" items={n.involves} initial={8} render={(r: Ref) => <li key={r.id}><RefLink r={r} /> <span className="text-xs text-muted">{r.sub}{r.status && !["alive", "intact"].includes(r.status) ? ` · ${r.status}` : ""}</span></li>} />
      <Section title="Connected threads" items={n.linked} render={(r: any) => <li key={r.id}><RefLink r={r} />{r.note && <span className="text-xs text-muted">: {r.note}</span>}</li>} />
      <Section
        title="History"
        items={[...n.history].reverse()}
        initial={4}
        render={(h: any, i) => (
          <li key={i} className="text-[13px]">
            {h.session != null ? (
              <RefLink r={{ kind: "session", id: h.session, name: `Session ${h.session}`, sub: "Session" }}>
                <span className="text-xs">s{h.session}</span>
              </RefLink>
            ) : null}{" "}
            <span className="text-xs text-muted">{h.change}</span> <Linked text={h.note} />
          </li>
        )}
      />
      <Section title="Key moments" items={n.moments} render={(r: Ref) => <li key={r.id}><RefLink r={r} /></li>} />
    </>
  );
}

function MomentView({ n }: { n: Node }) {
  return (
    <>
      <Head n={n} chips={[n.session && `session ${n.session}`]} />
      <p className="story leading-relaxed">
        <Linked text={n.description} />
      </p>
      {n.callback && (
        <p className="mt-2 text-[13px] italic text-muted">
          Callback idea: <Linked text={n.callback} />
        </p>
      )}
      <Section title="Involves" items={n.involves} render={(r: Ref) => <li key={r.id}><RefLink r={r} /></li>} />
      <Section title="Threads" items={n.threads} render={(r: Ref) => <li key={r.id}><RefLink r={r} /></li>} />
    </>
  );
}

function SessionView({ n }: { n: Node }) {
  return (
    <>
      <Head n={n} />
      <Section title="Threads it moved" items={n.threads} initial={8} render={(r: any) => <li key={r.id}><RefLink r={r} /> <span className="text-xs text-muted">{r.change}</span></li>} />
      <section className="mt-4">
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Notes</h3>
        <p className="story whitespace-pre-wrap text-[13.5px] leading-relaxed">
          <Linked text={n.notes || "(no notes stored)"} />
        </p>
      </section>
    </>
  );
}
