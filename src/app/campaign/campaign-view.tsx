"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Header, Note, post, store, useCampaigns } from "../shell";

// What's in the loom, without the bog: one search across everything, a tab per kind of thing,
// rows that open in place. The only thing to type here is where the story is heading.

interface Overview {
  campaign: { id: number; name: string; direction: string; tone: string; party: string | null; date: string; safety: string[] };
  threads: {
    id: number;
    title: string;
    kind: string;
    status: string;
    summary: string;
    secret: boolean;
    involves: string[];
    firstSeen: number | null;
    lastTouched: number | null;
    history: { session: number | null; change: string; note: string }[];
  }[];
  cast: {
    id: number;
    name: string;
    type: string;
    status: string | null;
    attitude: string | null;
    importance: string | null;
    description: string;
    location: string | null;
    within: string | null;
    details: { key: string; value: string; secret: boolean }[];
    relations: { type: string; other: string; note: string; secret: boolean }[];
    threads: number;
  }[];
  moments: { id: number; title: string; description: string; callback: string; session: number | null; status: string; entities: string[] }[];
  sessions: { number: number; notes: string; at: string }[];
  activity: {
    items: { at: string; kind: "asked" | "used" | "saved" | "undone"; text: string; session: number | null }[];
    cost: { feature: string; calls: number; costUsd: number }[];
    totalUsd: number;
  };
}

const TABS = ["Threads", "Cast", "Moments", "Sessions", "Activity"] as const;
type Tab = (typeof TABS)[number];
const CAST_TYPES: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pc", label: "Party" },
  { id: "npc", label: "People" },
  { id: "location", label: "Places" },
  { id: "item", label: "Items" },
  { id: "faction", label: "Factions" },
];

export function CampaignView() {
  const c = useCampaigns();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-20 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}
      {c.campaignId && <Loom key={c.campaignId} campaignId={c.campaignId} />}
    </main>
  );
}

function Loom({ campaignId }: { campaignId: number }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(() => {
    const saved = store.get("loom.tab") as Tab | null;
    return saved && TABS.includes(saved) ? saved : "Threads";
  });
  const [q, setQ] = useState("");

  const load = useCallback(() => post<Overview>("/api/campaign", { campaignId }).then(setData), [campaignId]);
  useEffect(() => {
    post<Overview>("/api/campaign", { campaignId })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [campaignId]);

  const match = useCallback((...parts: (string | null | undefined)[]) => !q.trim() || parts.join(" ").toLowerCase().includes(q.trim().toLowerCase()), [q]);
  const counts = useMemo(() => {
    if (!data) return null;
    return {
      Threads: data.threads.filter((t) => match(t.title, t.summary, t.involves.join(" "))).length,
      Cast: data.cast.filter((e) => match(e.name, e.description, e.location)).length,
      Moments: data.moments.filter((m) => match(m.title, m.description)).length,
      Sessions: data.sessions.filter((s) => match(s.notes)).length,
      Activity: data.activity.items.filter((i) => match(i.text)).length,
    } satisfies Record<Tab, number>;
  }, [data, match]);

  if (error) return <Note tone="danger">{error}</Note>;
  if (!data || !counts) return <div aria-hidden className="h-40 animate-pulse rounded-xl border border-line bg-surface/60" />;

  const open = data.threads.filter((t) => t.status !== "resolved").length;
  const suggested = data.moments.filter((m) => m.status === "suggested").length;

  return (
    <>
      <section className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight">{data.campaign.name}</h2>
        <p className="mt-1 text-sm text-muted">
          {[
            data.campaign.party && `Party at ${data.campaign.party}`,
            `${open} open thread${open === 1 ? "" : "s"}`,
            `${data.cast.length} in the cast`,
            `${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}`,
            data.activity.totalUsd > 0 && `$${data.activity.totalUsd.toFixed(2)} spent`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <Direction campaignId={campaignId} initial={data.campaign.direction} />
      </section>

      <div className="sticky top-0 z-10 -mx-4 mb-4 bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everything: a name, a place, a word from the notes"
          aria-label="Search the campaign"
          className="mb-2 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
        />
        <nav role="tablist" className="flex gap-1 overflow-x-auto text-sm [scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                store.set("loom.tab", t);
              }}
              className={`shrink-0 rounded-md px-2.5 py-1 ${tab === t ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              {t} <span className="text-xs text-muted">{counts[t]}</span>
              {t === "Moments" && suggested > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-thread align-middle" />}
            </button>
          ))}
        </nav>
      </div>

      {tab === "Threads" && <Threads threads={data.threads.filter((t) => match(t.title, t.summary, t.involves.join(" ")))} />}
      {tab === "Cast" && <Cast cast={data.cast.filter((e) => match(e.name, e.description, e.location))} />}
      {tab === "Moments" && <Moments campaignId={campaignId} moments={data.moments.filter((m) => match(m.title, m.description))} reload={load} />}
      {tab === "Sessions" && <Sessions sessions={data.sessions.filter((s) => match(s.notes))} q={q} />}
      {tab === "Activity" && <Activity activity={data.activity} items={data.activity.items.filter((i) => match(i.text))} />}
    </>
  );
}

// Where the story is heading: saved as you go, read by every suggestion.
function Direction({ campaignId, initial }: { campaignId: number; initial: string }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  useEffect(() => {
    if (text === initial) return;
    const t = setTimeout(async () => {
      setState("saving");
      await post("/api/campaign/save", { campaignId, direction: text }).catch(() => {});
      setState("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [text, initial, campaignId]);
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-3 focus-within:border-thread/60">
      <label htmlFor="direction" className="flex items-baseline justify-between text-[13px] font-semibold">
        Where the story is heading
        <span className="text-xs font-normal text-muted">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Every suggestion steers by this"}</span>
      </label>
      <textarea
        id="direction"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="A few lines in your own words, e.g. “Build toward the palace: the party should learn the leaders' illness is Azarath's mind control before confronting him.”"
        className="mt-1 block w-full resize-y bg-transparent text-[14.5px] leading-relaxed outline-none placeholder:text-muted/70"
      />
    </div>
  );
}

function Row({ title, meta, children }: { title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-baseline justify-between gap-3 px-1 py-2.5 text-left">
        <span className="min-w-0">{title}</span>
        <span className="shrink-0 text-xs text-muted">{meta}</span>
      </button>
      {open && children && <div className="rise px-1 pb-3 text-sm">{children}</div>}
    </li>
  );
}

const Chip = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "thread" | "danger" }) => (
  <span className={`ml-1.5 rounded-full px-2 py-0.5 text-[11px] ${tone === "thread" ? "bg-thread-soft text-thread" : tone === "danger" ? "bg-danger/10 text-danger" : "bg-background text-muted"}`}>
    {children}
  </span>
);

function Threads({ threads }: { threads: Overview["threads"] }) {
  const [show, setShow] = useState<"active" | "resolved" | "all">("active");
  const list = threads.filter((t) => show === "all" || (show === "resolved" ? t.status === "resolved" : t.status !== "resolved"));
  return (
    <>
      <Filters value={show} onChange={(v) => setShow(v as typeof show)} options={[{ id: "active", label: "Open" }, { id: "resolved", label: "Resolved" }, { id: "all", label: "All" }]} />
      {!list.length && <Empty />}
      <ul>
        {list.map((t) => (
          <Row
            key={t.id}
            title={
              <>
                <span className={t.status === "resolved" ? "text-muted line-through" : ""}>{t.title}</span>
                <Chip>{t.kind}</Chip>
                {t.status === "progressing" && <Chip tone="thread">in progress</Chip>}
                {t.secret && <Chip>🔒</Chip>}
              </>
            }
            meta={t.firstSeen ? `s${t.firstSeen}${t.lastTouched && t.lastTouched !== t.firstSeen ? `–s${t.lastTouched}` : ""}` : ""}
          >
            <p>{t.summary}</p>
            {t.involves.length > 0 && <p className="mt-1 text-xs text-muted">Involves {t.involves.join(", ")}</p>}
            {t.history.length > 0 && (
              <ol className="mt-2 space-y-1 border-l border-line pl-3 text-[13px]">
                {t.history.map((h, i) => (
                  <li key={i}>
                    <span className="text-xs text-muted">{h.session ? `s${h.session} ` : ""}{h.change}</span> {h.note}
                  </li>
                ))}
              </ol>
            )}
          </Row>
        ))}
      </ul>
    </>
  );
}

function Cast({ cast }: { cast: Overview["cast"] }) {
  const [type, setType] = useState("all");
  const list = cast.filter((e) => type === "all" || e.type === type);
  return (
    <>
      <Filters value={type} onChange={setType} options={CAST_TYPES.filter((t) => t.id === "all" || cast.some((e) => e.type === t.id))} />
      {!list.length && <Empty />}
      <ul>
        {list.map((e) => (
          <Row
            key={e.id}
            title={
              <>
                <span className={e.status === "dead" || e.status === "destroyed" ? "text-muted line-through" : ""}>{e.name}</span>
                {e.status && e.status !== "alive" && e.status !== "intact" && <Chip tone={e.status === "dead" ? "danger" : "muted"}>{e.status}</Chip>}
                {e.attitude && <Chip>{e.attitude}</Chip>}
              </>
            }
            meta={[e.location, e.threads ? `${e.threads} thread${e.threads === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
          >
            {e.description && <p>{e.description}</p>}
            {e.within && <p className="mt-1 text-xs text-muted">Part of {e.within}</p>}
            {e.details.length > 0 && (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                {e.details.map((d) => (
                  <div key={d.key} className="contents">
                    <dt className="text-muted">{d.key}</dt>
                    <dd>
                      {d.value}
                      {d.secret && <span title="GM only"> 🔒</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {e.relations.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[13px]">
                {e.relations.map((r, i) => (
                  <li key={i}>
                    <span className="text-muted">{r.type}</span> {r.other}
                    {r.note && <span className="text-muted">: {r.note}</span>}
                    {r.secret && " 🔒"}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        ))}
      </ul>
    </>
  );
}

function Moments({ campaignId, moments, reload }: { campaignId: number; moments: Overview["moments"]; reload: () => Promise<unknown> }) {
  const set = async (id: number, status: string) => {
    await post("/api/campaign/moment", { campaignId, id, status });
    await reload();
  };
  const suggested = moments.filter((m) => m.status === "suggested");
  const key = moments.filter((m) => m.status === "key");
  return (
    <>
      {suggested.length > 0 && (
        <div className="mb-6">
          <p className="mb-2 text-[13px] text-muted">Loom thinks these could be worth calling back later. Star the ones that mattered; starred moments feed callbacks.</p>
          <ul className="space-y-2">
            {suggested.map((m) => (
              <li key={m.id} className="rounded-xl border border-line bg-surface p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {m.title} <span className="text-xs font-normal text-muted">{m.session ? `s${m.session}` : ""}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">{m.description}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5 text-sm">
                    <button type="button" onClick={() => set(m.id, "key")} className="rounded-md border border-thread/50 px-2 py-0.5 text-thread" aria-label={`Star ${m.title}`}>
                      ★
                    </button>
                    <button type="button" onClick={() => set(m.id, "dismissed")} className="rounded-md border border-line px-2 py-0.5 text-muted" aria-label={`Dismiss ${m.title}`}>
                      ×
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!key.length && !suggested.length && <Empty />}
      <ul>
        {key.map((m) => (
          <Row key={m.id} title={<><span className="text-thread">★</span> {m.title}</>} meta={m.session ? `s${m.session}` : ""}>
            <p>{m.description}</p>
            {m.callback && <p className="mt-1 text-[13px] italic text-muted">Callback idea: {m.callback}</p>}
            <button type="button" onClick={() => set(m.id, "suggested")} className="mt-2 text-xs text-muted hover:text-foreground">
              Unstar
            </button>
          </Row>
        ))}
      </ul>
    </>
  );
}

function Sessions({ sessions, q }: { sessions: Overview["sessions"]; q: string }) {
  if (!sessions.length) return <Empty />;
  return (
    <ul>
      {sessions.map((s) => (
        <Row key={s.number} title={<>Session {s.number}<span className="ml-2 text-sm text-muted">{firstLine(s.notes)}</span></>} meta={s.at.slice(0, 10)}>
          <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">{highlight(s.notes, q)}</pre>
        </Row>
      ))}
    </ul>
  );
}

const ACTIVITY_ICON = { asked: "·", used: "✓", saved: "⤓", undone: "↺" };

function Activity({ activity, items }: { activity: Overview["activity"]; items: Overview["activity"]["items"] }) {
  return (
    <>
      {activity.cost.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {activity.cost.map((c) => (
            <span key={c.feature}>
              {c.feature}: {c.calls} · ${c.costUsd.toFixed(3)}
            </span>
          ))}
        </div>
      )}
      {!items.length && <Empty text="Nothing yet. Moments asked and used at the table, saves and undos show up here." />}
      <ol className="space-y-1.5 text-sm">
        {items.map((i, n) => (
          <li key={n} className="flex gap-3">
            <span className="w-4 shrink-0 text-center text-thread">{ACTIVITY_ICON[i.kind]}</span>
            <span className={`min-w-0 flex-1 ${i.kind === "asked" || i.kind === "undone" ? "text-muted" : ""}`}>{i.text}</span>
            <span className="shrink-0 text-xs text-muted">{i.at.slice(5, 16).replace("T", " ")}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Filters({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[] }) {
  return (
    <div role="radiogroup" className="mb-2 flex flex-wrap gap-1 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-2.5 py-0.5 ${value === o.id ? "bg-foreground text-background" : "border border-line text-muted hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Empty = ({ text = "Nothing here yet." }: { text?: string }) => <p className="py-6 text-center text-sm text-muted">{text}</p>;

const firstLine = (s: string) => {
  const line = s.split("\n").map((l) => l.replace(/^[\s•\-*]+/, "").trim()).find((l) => l.length > 12) ?? "";
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
};

function highlight(text: string, q: string) {
  const term = q.trim();
  if (!term) return text;
  const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-thread-soft px-0.5 text-foreground">{p}</mark> : p));
}
