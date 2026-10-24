"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { post } from "./shell";

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
  return (
    <Ctx.Provider value={value}>
      {children}
      {trail.length > 0 && <Inspector trail={trail} setTrail={setTrail} />}
    </Ctx.Provider>
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

  return (
    <aside
      aria-label="Loom inspector"
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[78vh] flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[400px] sm:rounded-2xl"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
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
        <button type="button" onClick={() => setTrail([])} className="text-lg leading-none text-muted hover:text-foreground" aria-label="Close inspector">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
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

const Lock = () => (
  <span title="GM only" className="ml-1 text-[11px]">
    🔒
  </span>
);

function EntityView({ n }: { n: Node }) {
  return (
    <>
      <Head n={n} chips={[n.status !== "alive" && n.status !== "intact" && n.status, n.attitude, n.importance]} />
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
