"use client";

import { NotesView } from "../notes-view";
import { usePrefs } from "../prefs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linked, LoomProvider, RefLink, useLoom } from "../loom-ui";
import { Switch } from "../controls";
import { Icon } from "../icons";
import { batchLabel, Header, Note, post, store, useCampaigns } from "../shell";

// The campaign at a glance, and the way in to all of it. The top is an overview built from links
// (the party, what's in play, what's gone quiet, who matters, recent sessions); underneath, one
// search and an index of everything. Anything you click opens in the inspector, where you can keep
// following connections.

interface Overview {
  tensions?: { name: string; kind: string; handle: string; strength: number; subject: { id: number; name: string } | null; other: { id: number; name: string } | null; by: string }[];
  campaign: { id: number; name: string; direction: string; tone: string; party: string | null; partyId: number | null; date: string; safety: string[]; autoApprove: boolean };
  latestSession: number;
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
const TYPE_LABEL: Record<string, string> = { pc: "Player character", npc: "Character", location: "Place", item: "Item", faction: "Faction", other: "Other" };
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
      {c.campaignId && (
        <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
          <Loom campaignId={c.campaignId} />
        </LoomProvider>
      )}
    </main>
  );
}

// "session 3", or "the start" for the world Loom began from (session 0).
const sessionShort = (n: number | null | undefined) => (n == null ? "" : n === 0 ? "the start" : `session ${n}`);

function Loom({ campaignId }: { campaignId: number }) {
  const showCosts = usePrefs().costs;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(() => {
    const saved = store.get("loom.tab") as Tab | null;
    return saved && TABS.includes(saved) ? saved : "Threads";
  });
  const [q, setQ] = useState("");
  const loom = useLoom();

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

  const open = data.threads.filter((t) => t.status !== "resolved");
  const suggested = data.moments.filter((m) => m.status === "suggested").length;
  const latest = data.latestSession;
  const hot = open.filter((t) => t.lastTouched != null && t.lastTouched >= latest - 1).sort((a, b) => (b.lastTouched ?? 0) - (a.lastTouched ?? 0));
  const quiet = open.filter((t) => t.lastTouched != null && t.lastTouched <= latest - 2).sort((a, b) => (a.lastTouched ?? 0) - (b.lastTouched ?? 0));
  const party = data.cast.filter((e) => e.type === "pc");
  const figures = data.cast.filter((e) => e.type !== "pc" && e.type !== "location" && e.importance === "major" && e.status !== "dead");
  const detail = (e: Overview["cast"][number], key: string) => e.details.find((d) => d.key === key)?.value;

  return (
    <>
      <section className="mb-2">
        <h2 className="text-xl font-semibold tracking-tight">{data.campaign.name}</h2>
        <p className="mt-1 text-sm text-muted">
          {data.campaign.party && data.campaign.partyId ? (
            <>
              Party at <RefLink r={{ kind: "entity", id: data.campaign.partyId, name: data.campaign.party }} /> ·{" "}
            </>
          ) : null}
          {[`${open.length} open thread${open.length === 1 ? "" : "s"}`, `${data.cast.length} in the cast`, `${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}`, showCosts && data.activity.totalUsd > 0 && `$${data.activity.totalUsd.toFixed(2)} spent`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <Direction campaignId={campaignId} initial={data.campaign.direction} />
        <Settings campaignId={campaignId} initial={data.campaign} />
      </section>

      {!data.threads.length && !data.cast.length && (
        <section className="rise mt-6 rounded-2xl border border-line bg-surface p-6">
          <p className="story text-[17px] leading-relaxed">The loom is empty for now.</p>
          <p className="mt-1 text-sm text-muted">Threads, characters and places appear here as Loom reads your notes or as you play. Every one of them will link to everything it touches.</p>
          <Link href="/prep" className="btn-primary mt-3 text-sm">
            Add your first notes <Icon name="arrow" size={12} />
          </Link>
        </section>
      )}

      {/* The overview: the way in. Every name opens in the inspector. */}
      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel title="The party" wide>
          {!party.length && <p className="text-sm text-muted">No player characters yet.</p>}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {party.map((p) => {
              const conditions = data.threads.filter((t) => t.kind === "condition" && t.status !== "resolved" && t.involves.includes(p.name));
              const health = detail(p, "health");
              return (
                <li key={p.id} className="rounded-lg border border-line bg-background p-2.5">
                  <p className="flex items-baseline justify-between gap-2">
                    <RefLink r={{ kind: "entity", id: p.id, name: p.name, sub: "Player character", status: p.status }} />
                    <span className={`text-xs ${health && health !== "healthy" ? "text-danger" : "text-muted"}`}>{p.status === "dead" ? "dead" : (health ?? "")}</span>
                  </p>
                  {detail(p, "conditions") && <p className="mt-0.5 text-xs text-muted">{detail(p, "conditions")}</p>}
                  {conditions.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[13px]">
                      {conditions.map((t) => (
                        <li key={t.id}>
                          <Icon name="diamond" size={10} className="text-thread" /> <RefLink r={{ kind: "thread", id: t.id, name: t.title, sub: "condition thread" }} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title="In play now" hint={latest ? "moved in the last two sessions" : undefined}>
          <RefList items={hot.slice(0, 7).map((t) => ({ r: { kind: "thread" as const, id: t.id, name: t.title, sub: `${t.kind} thread` }, meta: sessionShort(t.lastTouched) }))} empty="Nothing recent." />
        </Panel>
        <Panel title="Gone quiet" hint="untouched for 2+ sessions">
          <RefList items={quiet.slice(0, 7).map((t) => ({ r: { kind: "thread" as const, id: t.id, name: t.title, sub: `${t.kind} thread` }, meta: `since s${t.lastTouched}` }))} empty="Nothing has gone quiet." />
        </Panel>
        <Panel title="Tensions in play" hint="worked out from how they stand">
          {data.tensions?.length ? (
            <ul className="space-y-1.5 text-[13.5px]">
              {data.tensions.slice(0, 6).map((t, i) => (
                <li key={i}>
                  <RefLink r={{ kind: "entity", id: t.subject!.id, name: t.subject!.name, sub: t.name }} /> <span className="text-xs text-muted">{t.name}{t.by === "dm" ? " ✎" : ""}</span>
                  <span className="block text-xs text-muted">{t.handle}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None yet. They appear when characters want things that pull against each other, or care about someone they shouldn&apos;t. Tell Loom what a character wants and feels in their page (tap any name).</p>
          )}
        </Panel>
        <Panel title="Who matters">
          <RefList items={figures.slice(0, 8).map((e) => ({ r: { kind: "entity" as const, id: e.id, name: e.name, sub: TYPE_LABEL[e.type], status: e.status }, meta: e.attitude ?? "" }))} empty="No major figures marked yet." />
        </Panel>
        <Panel title="Recent sessions">
          <RefList
            items={data.sessions.slice(0, 5).map((s) => ({ r: { kind: "session" as const, id: s.number, name: `Session ${s.number}`, sub: "Session" }, meta: firstLine(s.notes, 34) }))}
            empty="No sessions yet."
          />
          {suggested > 0 && (
            <button type="button" onClick={() => setTab("Moments")} className="mt-2 text-xs text-thread hover:underline">
              {suggested} moment{suggested === 1 ? "" : "s"} to star ↓
            </button>
          )}
        </Panel>
      </section>

      {/* The index: search and lists of everything. */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 mt-8 bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
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
      {tab === "Moments" && (
        <Moments
          campaignId={campaignId}
          moments={data.moments.filter((m) => match(m.title, m.description))}
          reload={async () => {
            await load();
            loom?.reload();
          }}
        />
      )}
      {tab === "Sessions" && <Sessions sessions={data.sessions.filter((s) => match(s.notes))} q={q} />}
      {tab === "Activity" && <Activity activity={data.activity} items={data.activity.items.filter((i) => match(i.text))} />}
    </>
  );
}

function Panel({ title, hint, wide = false, children }: { title: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-3.5 ${wide ? "sm:col-span-2" : ""}`}>
      <h3 className="mb-2 flex items-baseline justify-between gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
        {title}
        {hint && <span className="text-[11px] font-normal normal-case tracking-normal">{hint}</span>}
      </h3>
      {children}
    </div>
  );
}

function RefList({ items, empty }: { items: { r: Parameters<typeof RefLink>[0]["r"]; meta?: string }[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-1 text-[14px]">
      {items.map(({ r, meta }) => (
        <li key={`${r.kind}:${r.id}`} className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate">
            <RefLink r={r} />
          </span>
          {meta && <span className="shrink-0 truncate text-xs text-muted">{meta}</span>}
        </li>
      ))}
    </ul>
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
        placeholder="A few lines in your own words, e.g. “Build toward the heist: the party should learn who hired the thieves before the festival ends.”"
        className="mt-1 block w-full resize-y bg-transparent text-[14.5px] leading-relaxed outline-none placeholder:text-muted/70"
      />
    </div>
  );
}

// The few table settings, inline: tone of the campaign and whether risky changes need a yes.
function Settings({ campaignId, initial }: { campaignId: number; initial: Overview["campaign"] }) {
  const [tone, setTone] = useState(initial.tone);
  const [auto, setAuto] = useState(initial.autoApprove);
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-[13px] text-muted">
      <label className="flex items-center gap-2">
        Tone
        <input
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          onBlur={() => tone !== initial.tone && post("/api/campaign/save", { campaignId, tone }).catch(() => {})}
          placeholder="e.g. grim, comedic, heroic"
          className="w-44 border-b border-dashed border-line bg-transparent px-0.5 py-0.5 text-foreground outline-none placeholder:text-muted/60 focus:border-solid focus:border-thread/60"
        />
      </label>
      <Switch
        checked={!auto}
        hint="Deaths, secrets, items changing hands, closing a thread. Off: recorded without asking, still marked and undoable."
        onChange={async (ask) => {
          setAuto(!ask);
          await post("/api/campaign/save", { campaignId, autoApprove: !ask }).catch(() => {});
        }}
      >
        Check with me before big changes (deaths, captures, closing threads)
      </Switch>
      {initial.safety.length > 0 && <span>Safety lines: {initial.safety.join(", ")}</span>}
    </div>
  );
}

const Chip = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "thread" | "danger" }) => (
  <span className={`ml-1.5 rounded-full px-2 py-0.5 text-[11px] ${tone === "thread" ? "bg-thread-soft text-thread" : tone === "danger" ? "bg-danger/10 text-danger" : "bg-background text-muted"}`}>
    {children}
  </span>
);

// One line per thing in the index; clicking it opens the inspector.
function IndexRow({ r, children, meta }: { r: Parameters<typeof RefLink>[0]["r"]; children?: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-line px-1 py-2 last:border-0">
      <span className="min-w-0">
        <RefLink r={r} />
        {children}
      </span>
      <span className="shrink-0 text-xs text-muted">{meta}</span>
    </li>
  );
}

function Threads({ threads }: { threads: Overview["threads"] }) {
  const [show, setShow] = useState<"active" | "resolved" | "all">("active");
  const list = threads.filter((t) => show === "all" || (show === "resolved" ? t.status === "resolved" : t.status !== "resolved"));
  return (
    <>
      <Filters value={show} onChange={(v) => setShow(v as typeof show)} options={[{ id: "active", label: "Open" }, { id: "resolved", label: "Resolved" }, { id: "all", label: "All" }]} />
      {!list.length && <Empty />}
      <ul>
        {list.map((t) => (
          <IndexRow key={t.id} r={{ kind: "thread", id: t.id, name: t.title, sub: `${t.kind} thread`, status: t.status }} meta={t.firstSeen != null ? `${sessionShort(t.firstSeen)}${t.lastTouched && t.lastTouched !== t.firstSeen ? ` to ${t.lastTouched}` : ""}` : ""}>
            <Chip>{t.kind}</Chip>
            {t.status === "progressing" && <Chip tone="thread">in progress</Chip>}
            {t.secret && <Chip>🔒</Chip>}
          </IndexRow>
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
          <IndexRow key={e.id} r={{ kind: "entity", id: e.id, name: e.name, sub: TYPE_LABEL[e.type], status: e.status }} meta={[e.location, e.threads ? `${e.threads} thread${e.threads === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}>
            {e.status && e.status !== "alive" && e.status !== "intact" && <Chip tone={e.status === "dead" ? "danger" : "muted"}>{e.status}</Chip>}
            {e.attitude && <Chip>{e.attitude}</Chip>}
          </IndexRow>
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
                      <RefLink r={{ kind: "moment", id: m.id, name: m.title, sub: "Suggested moment" }} /> <span className="text-xs font-normal text-muted">{m.session != null ? sessionShort(m.session) : ""}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      <Linked text={m.description} />
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5 text-sm">
                    <button type="button" onClick={() => set(m.id, "key")} className="btn-secondary border-thread/50 px-2 text-thread" aria-label={`Star ${m.title}`}>
                      <Icon name="star" filled />
                    </button>
                    <button type="button" onClick={() => set(m.id, "dismissed")} className="btn-secondary px-2 text-muted" aria-label={`Dismiss ${m.title}`}>
                      <Icon name="close" />
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
          <IndexRow key={m.id} r={{ kind: "moment", id: m.id, name: m.title, sub: "Key moment" }} meta={m.session != null ? sessionShort(m.session) : ""}>
            <button type="button" onClick={() => set(m.id, "suggested")} className="ml-2 text-xs text-muted hover:text-foreground" aria-label={`Unstar ${m.title}`}>
              <Icon name="star" filled size={11} className="text-thread" /> unstar
            </button>
          </IndexRow>
        ))}
      </ul>
    </>
  );
}

function Sessions({ sessions, q }: { sessions: Overview["sessions"]; q: string }) {
  if (!sessions.length) return <Empty />;
  return (
    <ul className="space-y-1">
      {sessions.map((s) => (
        <li key={s.number} className="border-b border-line last:border-0">
          {/* Long notes fold away here; the inspector shows them with every name linked. */}
          <details>
            <summary className="flex cursor-pointer items-baseline justify-between gap-3 px-1 py-2">
              <span className="min-w-0 truncate">
                <RefLink r={{ kind: "session", id: s.number, name: `Session ${s.number}`, sub: "Session" }} />
                <span className="ml-2 text-sm text-muted">{firstLine(s.notes, 70)}</span>
              </span>
              <span className="shrink-0 text-xs text-muted">{s.at.slice(0, 10)}</span>
            </summary>
            {q ? <pre className="story whitespace-pre-wrap px-1 pb-3 text-[13.5px] leading-relaxed">{highlight(s.notes, q)}</pre> : <NotesView text={s.notes} className="px-1 pb-4" />}
          </details>
        </li>
      ))}
    </ul>
  );
}

const ACTIVITY_ICON = { asked: "dot", used: "check", saved: "save", undone: "undo" } as const;

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
            <span className="w-4 shrink-0 text-center text-thread">
              <Icon name={ACTIVITY_ICON[i.kind]} size={13} />
            </span>
            <span className={`min-w-0 flex-1 ${i.kind === "asked" || i.kind === "undone" ? "text-muted" : ""}`}>
              {i.kind === "saved" || i.kind === "undone" ? `${batchLabel(i.text.split("|")[0])} · ${i.text.split("|")[1]} changes${i.kind === "undone" ? " (undone)" : ""}` : <Linked text={i.text} />}
            </span>
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

const firstLine = (s: string, n: number) => {
  const line =
    s
      .split("\n")
      .map((l) => l.replace(/^[\s•\-*]+/, "").trim())
      .find((l) => l.length > 12 && !/^(at the table|session \d|campaign documentation)/i.test(l)) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

function highlight(text: string, q: string) {
  const term = q.trim();
  if (!term) return text;
  const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-thread-soft px-0.5 text-foreground">{p}</mark> : p));
}
