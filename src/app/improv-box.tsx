"use client";

import { Reading } from "./reading";
import { NowStrip, readWords, SlotRow, Smoke, Still, type NowLine, type Read } from "./answer-box";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Choice, Field, Steps, Switch, Tune } from "./controls";
import { Develop } from "./develop";
import { Icon } from "./icons";
import { type Encounter, FightPanel } from "./fight";
import { ResultPrompt, SidePrompt } from "./results";
import { Linked, LoomProvider, RefChips, RefLink, useLoom } from "./loom-ui";
import { setPref, usePrefs } from "./prefs";
import { type Overrides, SceneChips } from "./scene-chips";
import { Header, Note, post, stream, useCampaigns, useElapsed } from "./shell";

// The table page: type what the players just did, get options tied back to threads (each shown
// the moment it's written), use one or write your own, and Loom adds it to the loom straight
// away so the next suggestion knows. Develop any choice and keep going from what it suggests:
// the session grows as a tree, shown in the timeline. Every name links into the loom.

interface Card {
  headline: string;
  flavour: string | null;
  label: string;
  text: string;
  why: string;
  threads: { id: number; title: string }[];
  callback: { id: number; title: string } | null;
  needs: "roll" | "fight" | null;
  pillar: string | null;
  surprise?: string | null; // built on the session's surprise: why it's explicable
}
interface RecordFix {
  say: string;
  apply: string;
  fix: { kind: "condition"; entityId: number; condition: string } | { kind: "holds"; holderId: number; itemId: number };
}
interface Done {
  entryId: number;
  count: number;
  fixes: RecordFix[];
  steers: string[];
  safetyNote: string | null;
  llm: { model: string; seconds: number; costUsd: number; attempts: number } | null; // null when reopened from the log
}
interface Question {
  n: number;
  group: string;
  summary: string;
  reasons: string[];
  evidence: string;
}
export interface Entry {
  id: number;
  parentId: number | null;
  moment: string;
  options: Card[]; // what Loom offered (empty for notes, branches and results)
  choiceKind: "option" | "own" | "branch" | "result" | null;
  choiceLabel: string;
  choice: string;
  status: "asked" | "extracting" | "done" | "failed";
  summary: string[];
  questions: Question[];
  developments: unknown[]; // Develop results kept on this choice (chains; older plans read-only)
  awaiting: "roll" | "fight" | "choice" | null;
  sides: string[];
  resultState: "pending" | "given" | "skipped" | null;
  encounter: unknown;
  at: string;
}
type Status = "idle" | "running" | "done" | "error";
// A world Loom just invented: its opening to read aloud, and what it put in the loom.
type Opening = { title: string; opening: string; made?: { entities: { id: number; name: string; type: string }[]; threads: { id: number; title: string }[] } };

export const MODELS = [
  { id: "haiku", label: "Quick", hint: "The first option in about 5 s, all three in about 7" },
  { id: "sonnet", label: "Balanced", hint: "A middle ground: about 10 s" },
  { id: "opus", label: "Best", hint: "Slower (about 13 s), pulls in more that fits" },
] as const;
type Model = (typeof MODELS)[number]["id"];
export const TONES = ["Grounded", "Restrained", "Balanced", "Dramatic", "Theatrical"];
// Which kinds of option to offer. Most DMs never change the default mix.
export const MIXES = [
  { id: "mix", label: "Mix", hint: "One payoff, one twist, one callback or character beat" },
  { id: "fights", label: "Action", hint: "More fights and danger" },
  { id: "mystery", label: "Mystery", hint: "Reveal and deepen mysteries" },
  { id: "light", label: "Light", hint: "Funny and warm" },
  { id: "character", label: "Character", hint: "Moments for the player characters" },
] as const;
type MixId = (typeof MIXES)[number]["id"];
const FLAVOUR_LABEL: Record<string, string> = { payoff: "Payoff", twist: "Twist", callback: "Callback", character: "Character", tense: "Tense", funny: "Funny", mystery: "Mystery", fight: "Fight" };
const threadRefs = (ts: { id: number; title: string }[]) => ts.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }));

export function ImprovBox() {
  const c = useCampaigns();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-24 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}
      {c.campaignId && (
        <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
          <Table campaignId={c.campaignId} name={c.campaigns.find((x) => x.id === c.campaignId)?.name ?? ""} trySample={c.sample} />
        </LoomProvider>
      )}
    </main>
  );
}

// Everything the table needs to log a choice or a branch, shared by cards, the timeline and Develop.
export interface Live {
  campaignId: number;
  entries: Entry[];
  reload: () => Promise<Entry[]>;
  model: Model;
  tone: number;
  focusBox: (placeholder?: string) => void;
  reopen: (entryId: number) => void;
}

// "Can she…?", "Does that provoke…?", "How does … work": likely a rules question, not a moment.
const RULES_QUESTION =
  /^(?:can|could|does|do|is|are|how (?:does|do|much|many|far|long)|what (?:happens|does|is the rule)|when (?:does|do)|if (?:a|an|she|he|they)\b)[^]*\?$|\b(?:provoke|opportunity attack|concentration|advantage|disadvantage|saving throw|bonus action|reaction|cover|grapple|RAW|rules? (?:for|on|say))\b[^]*\?$/i;

// Moments to try in the sample campaign, so a first look shows Loom working straight away.
const SAMPLE_MOMENTS = [
  "Bram jumps off the bridge to prove he can't die",
  "Kira writes Ysolde a note demanding the cure",
  "The party decides to rob the Red Hand's toll-house",
];

// The moment a choice grew from: follow the parents up to the one Loom was asked about.
// The last few beats of play for "What just happened": the latest moments (six, for when it's
// opened; folded it shows the last four lines), each with what was used, the steps that followed
// and how rolls went, then a moment just asked. Newest last.
function nowLines(entries: Entry[], asked: string): NowLine[] {
  const said = (e: Entry) => {
    if (e.choiceKind !== "result") return e.choiceLabel || e.choice;
    const detail = e.choice.replace(/^\s*(?:succeeded|failed|partly|won|lost|fled|talked it out)\.?\s*/i, "").trim();
    return detail ? `${e.choiceLabel}: ${detail}` : e.choiceLabel || e.choice;
  };
  const lines: NowLine[] = [];
  const roots = entries.filter((e) => e.parentId == null);
  const follow = (id: number) => {
    for (const c of entries.filter((e) => e.parentId === id)) {
      if (c.choiceKind) lines.push({ kind: c.choiceKind === "result" ? "result" : "then", text: said(c), id: c.id });
      follow(c.id);
    }
  };
  for (const r of roots.slice(-6)) {
    if (r.moment) lines.push({ kind: "moment", text: r.moment, id: r.id });
    if (r.choiceKind === "option" || r.choiceKind === "own") lines.push({ kind: r.moment ? "used" : "moment", text: said(r), id: r.id });
    follow(r.id);
  }
  if (asked && !roots.slice(-6).some((r) => r.moment === asked)) lines.push({ kind: "moment", text: asked });
  return lines.slice(-14);
}

function rootOf(list: Entry[], id: number) {
  let e = list.find((x) => x.id === id);
  while (e?.parentId != null) {
    const up = list.find((x) => x.id === e!.parentId);
    if (!up) break;
    e = up;
  }
  return e;
}

function Table({ campaignId, name, trySample }: { campaignId: number; name: string; trySample: () => Promise<void> }) {
  // Model, tone and kinds of option are per-browser preferences (the Settings page and the tune
  // panel change the same ones).
  const prefs = usePrefs();
  const model: Model = prefs.model;
  const tone = prefs.tone;
  const mix: MixId = prefs.mix;
  const [moment, setMoment] = useState("");
  const [overrides, setOverrides] = useState<Overrides>({}); // the GM's corrections from the scene chips
  const [askedOverrides, setAskedOverrides] = useState<Overrides>({});
  const [placeholder, setPlaceholder] = useState("What did the players just do?");
  const [asked, setAsked] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [empty, setEmpty] = useState(false);
  // A new campaign shows its ways in first; the box comes when the GM chooses to start at the table.
  const [atTable, setAtTable] = useState(false);
  const [read, setRead] = useState<Read | null>(null); // what Loom picked out, shown while it writes
  const askedAt = useRef(0); // when this ask began, to pace the answer box
  const [readAt, setReadAt] = useState<number | null>(null); // when Loom's reading of the moment arrived
  const [landed, setLanded] = useState<Set<number>>(new Set()); // rows that have turned over into their option
  const [vanishing, setVanishing] = useState<number[]>([]); // rows whose option never came, going up in smoke
  const [fresh, setFresh] = useState(0); // which ask was written on this page (its options animate in); 0: restored
  const [unravelling, setUnravelling] = useState(false); // the moment the unchosen options come apart
  const [lastTime, setLastTime] = useState<LastTime | null>(null); // where things stood, for a session not yet begun
  const [opening, setOpening] = useState<Opening | null>(null); // a hook just started
  const [begun, setBegun] = useState<Opening | null>(null); // its opening, kept in view until the first moment
  const [showOthers, setShowOthers] = useState(false);
  const [openCard, setOpenCard] = useState<number | null>(null);
  const [steered, setSteered] = useState(""); // the option read in full; the rest are headlines
  const [sample, setSample] = useState(false);
  const [open, setOpen] = useState<number | null>(null); // timeline entry shown in detail
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  // "/" jumps to the box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reload = useCallback(async () => {
    const r = await post<{ session: number; autoApprove: boolean; empty: boolean; sample: boolean; entries: Entry[]; lastTime: LastTime | null }>("/api/live", { campaignId });
    setSession(r.session);
    setEntries(r.entries);
    setAutoApprove(r.autoApprove);
    setEmpty(r.empty);
    setLastTime(r.lastTime ?? null);
    setSample(r.sample);
    return r.entries;
  }, [campaignId]);

  // Back to a moment from the log: its options as they were given, with what was used and what
  // grew from it, so play carries on from there (after a reload, or from the timeline).
  const show = useCallback((list: Entry[], id: number) => {
    const root = rootOf(list, id);
    if (!root?.options.length) return false;
    abort.current?.abort();
    setAsked(root.moment);
    setAskedOverrides({});
    setCards(root.options);
    setFresh(0);
    setDone({ entryId: root.id, count: root.options.length, fixes: [], steers: [], safetyNote: null, llm: null });
    setStatus("done");
    setError("");
    setOpenCard(null);
    setSteered("");
    setShowOthers(false);
    return true;
  }, []);
  const reopen = useCallback(
    (id: number) => {
      if (!show(entries, id)) return;
      setOpen(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [entries, show],
  );

  useEffect(() => {
    post<{ session: number; autoApprove: boolean; empty: boolean; sample: boolean; entries: Entry[]; lastTime: LastTime | null }>("/api/live", { campaignId })
      .then((r) => {
        setSession(r.session);
        setEntries(r.entries);
        setAutoApprove(r.autoApprove);
        setEmpty(r.empty);
        setLastTime(r.lastTime ?? null);
        setSample(r.sample);
        // After a reload, pick up where the table left off: the latest moment, with its options.
        const latest = r.entries[r.entries.length - 1];
        if (latest) show(r.entries, latest.id);
      })
      .catch(() => {});
  }, [campaignId, show]);

  // When a choice finishes landing in the loom, say so briefly, and make its dot glow.
  const [toasts, setToasts] = useState<{ id: number; entryId: number; title: string; detail: string }[]>([]);
  const [glowing, setGlowing] = useState<Set<number>>(new Set());
  const previous = useRef(new Map<number, Entry["status"]>());
  useEffect(() => {
    const landed = entries.filter((e) => previous.current.get(e.id) === "extracting" && e.status !== "extracting");
    previous.current = new Map(entries.map((e) => [e.id, e.status]));
    if (!landed.length) return;
    const fresh = landed.map((e) => ({
      id: Date.now() + e.id,
      entryId: e.id,
      title:
        e.status === "failed"
          ? "Couldn't add that to the loom"
          : e.summary.length
            ? `Added ${e.summary.length} to the loom${e.questions.length ? ` · ${e.questions.length} to answer` : ""}`
            : "Logged. Nothing new for the loom",
      detail: e.summary[0]?.replace(/^(?:~ progressed|Moved on): /, "") ?? "",
    }));
    queueMicrotask(() => {
      setToasts((t) => [...t, ...fresh].slice(-3));
      setGlowing(new Set(landed.map((e) => e.id)));
    });
    // Not cleared on the next refresh: the glow always fades, whatever else changes.
    setTimeout(() => setGlowing(new Set()), 2000);
  }, [entries]);

  const closeToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // While a choice is being added to the loom, check back every couple of seconds.
  const extracting = entries.some((e) => e.status === "extracting");
  useEffect(() => {
    if (!extracting) return;
    const t = setInterval(() => reload().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [extracting, reload]);

  // On a phone, the box shrinks to one line while you read further down, and opens again when
  // you tap it or scroll back up.
  const [compact, setCompact] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 639px)");
    // Two thresholds, so the box shrinking (which moves the page) can't flip it straight back.
    const onScroll = () => setCompact((was) => narrow.matches && (was ? window.scrollY > 80 : window.scrollY > 220));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Focus alone doesn't keep it open (it stays focused after asking); typing does.
  const shrunk = compact && !moment && !(focused && window.scrollY < 160);

  const focusBox = useCallback((p?: string) => {
    if (p) setPlaceholder(p);
    box.current?.focus({ preventScroll: true });
  }, []);
  const live: Live = { campaignId, entries, reload, model, tone, focusBox, reopen };

  async function ask(again?: { steer: string }) {
    // A steer re-weaves the same moment (with the same corrections); otherwise it's whatever is in the box.
    const text = again ? asked : moment.trim();
    if (!text || status === "running") return;
    const corrections = again ? askedOverrides : overrides;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAsked(text);
    setAskedOverrides(corrections);
    if (!again) {
      setMoment("");
      setOverrides({});
    }
    setOpenCard(null);
    setSteered(again?.steer ?? "");
    setPlaceholder("What did the players just do?");
    setCards([]);
    setRead(null);
    setReadAt(null);
    askedAt.current = Date.now();
    setLanded(new Set());
    setFresh((n) => n + 1);
    setDone(null);
    setError("");
    setOpen(null);
    setShowOthers(false);
    setStatus("running");
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      const res = await fetch("/api/improv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, moment: text, model, tone, mix, steer: again?.steer, overrides: corrections, surprises: prefs.surprises }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Something went wrong.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let got = 0;
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "reading") {
            setRead(event.reading);
            setReadAt(Date.now());
          }
          else if (event.type === "option") {
            got++;
            setCards((cs) => [...cs, event.option]);
          }
          else if (event.type === "done") setDone(event);
          else if (event.type === "error") throw new Error(event.message);
        }
      }
      // A row whose option never came (the checks dropped it) goes up in smoke rather than vanishing.
      if (got < 3) {
        setVanishing(Array.from({ length: 3 - got }, (_, k) => got + k));
        setTimeout(() => setVanishing([]), 2000);
      }
      setStatus("done");
      await reload();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  const current = done ? entries.find((e) => e.id === done.entryId) : undefined;

  // Uses an option (or your own) for the moment just asked. Changing your mind undoes the old pick.
  async function use(choice: { kind: "option" | "own"; label: string; text: string; awaiting?: "roll" | "fight" | null }) {
    if (!current) return null;
    setError("");
    try {
      if (current.choiceKind) await post("/api/live/clear", { entryId: current.id });
      await post("/api/live/choice", { entryId: current.id, ...choice });
      setShowOthers(false);
      // The options not chosen unravel for a moment before they fold away (globals.css .unravel).
      setUnravelling(true);
      setTimeout(() => setUnravelling(false), 2600);
      await reload();
      focusBox("What happened next?");
      // Keep the chosen card in view once the others fold away.
      requestAnimationFrame(() => document.getElementById("chosen")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return current.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't log that.");
      return null;
    }
  }

  const questions = entries.flatMap((e) => e.questions.map((q) => ({ ...q, entry: e })));
  const waiting = entries.filter((e) => e.awaiting && e.awaiting !== "choice").reverse();
  // Which side of a choice was taken: asked only while it's the latest thing used, and never pressed.
  const lastUsed = [...entries].reverse().find((e) => e.choiceKind && e.choiceKind !== "result");
  const sidePending = lastUsed?.awaiting === "choice" && lastUsed.sides.length === 2 ? lastUsed : null;

  return (
    <>
      {session != null && <Timeline session={session} live={live} open={open} setOpen={setOpen} glowing={glowing} />}
      <Toasts
        toasts={toasts}
        onOpen={(entryId) => {
          setOpen(entryId);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        onClose={closeToast}
      />

      {/* The box stays in reach: it sticks to the top while you read options further down. Open
          questions sit right above it until they're answered. */}
      {/* What just happened: the context for whatever comes next, updating as you choose and record.
          It sits above the box in the page (not pinned), so scrolling stays steady. */}
      <NowStrip lines={nowLines(entries, asked)} />
      <div className="sticky top-0 z-20 -mx-4 bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
        {questions.length > 0 && <QuestionTray questions={questions} reload={reload} campaignId={campaignId} autoApprove={autoApprove} setAutoApprove={setAutoApprove} />}
        {/* Then any roll or fight still waiting for how it turned out (newest first). */}
        {!questions.length && waiting.length > 0 && (
          <div className="mb-2">
            <ResultPrompt
              key={waiting[0].id}
              entryId={waiting[0].id}
              kind={waiting[0].awaiting as "roll" | "fight"}
              label={waiting[0].choiceLabel ? `${waiting[0].choiceLabel}: ${waiting[0].choice}` : waiting[0].choice}
              count={waiting.length > 1 ? `1 of ${waiting.length}` : undefined}
              onDone={reload}
              folded={waiting[0].id === current?.id || waiting[0].parentId === current?.id}
            />
          </div>
        )}
        {!questions.length && !waiting.length && sidePending && (
          <div className="mb-2">
            <SidePrompt key={sidePending.id} entryId={sidePending.id} sides={sidePending.sides} onDone={reload} />
          </div>
        )}
        <form
          hidden={empty && !atTable && !begun && !asked}
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
          className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-thread/60"
        >
          <label htmlFor="moment" className="sr-only">
            What did the players just do?
          </label>
          <textarea
            id="moment"
            ref={box}
            rows={shrunk ? 1 : Math.min(6, Math.max(2, Math.ceil(moment.length / 70) + (moment.match(/\n/g)?.length ?? 0)))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            value={moment}
            onChange={(e) => setMoment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask();
              }
            }}
            placeholder={placeholder}
            className={`block w-full resize-none bg-transparent px-4 text-[17px] leading-relaxed outline-none placeholder:text-muted/70 ${shrunk ? "py-2.5" : "pt-3"}`}
          />
          <div className={`items-center justify-between gap-3 px-2 pb-2 pt-0.5 ${shrunk ? "hidden" : "flex"}`}>
            {/* Everything you might tune lives behind one quiet control, out of the way of the box. */}
            <Tune label="Tune suggestions" summary={`${MODELS.find((m) => m.id === model)?.label} · ${TONES[tone]}${mix !== "mix" ? ` · ${MIXES.find((m) => m.id === mix)?.label}` : ""}`}>
              <Field label="Model">
                <Choice
                  label="Model"
                  options={MODELS}
                  value={model}
                  onChange={(v) => setPref("model", v)}
                />
                <p className="mt-1 text-xs text-muted">{MODELS.find((m) => m.id === model)?.hint}</p>
              </Field>
              <Field label="Kinds of option">
                <Choice
                  label="Kinds of option"
                  options={MIXES}
                  value={mix}
                  onChange={(v) => setPref("mix", v)}
                />
              </Field>
              <Field label="Drama">
                <Steps
                  label="Drama"
                  steps={TONES}
                  value={tone}
                  onChange={(v) => setPref("tone", v)}
                />
              </Field>
              <Field label="Risky changes">
                <Switch
                  checked={!autoApprove}
                  onChange={async (ask) => {
                    setAutoApprove(!ask);
                    await post("/api/campaign/save", { campaignId, autoApprove: !ask });
                  }}
                  hint="Deaths, secrets, items changing hands, closing a thread"
                >
                  Ask me before recording them
                </Switch>
              </Field>
              <p className="text-[11px] text-muted">Enter asks · Shift+Enter for a new line · / brings you back to the box</p>
              <Link href="/settings" className="btn-tertiary inline-flex items-center gap-1 text-xs">
                <Icon name="settings" size={12} /> All settings
              </Link>
            </Tune>
            <button
              type="submit"
              disabled={!moment.trim() || status === "running"}
              title="Enter"
              className="btn-primary shrink-0 text-sm"
            >
              {status === "running" ? "Reading…" : "Find threads"}
            </button>
          </div>
        </form>
        {/* What Loom read from the moment (code, as you type): tap to correct before asking. */}
        {!shrunk && <SceneChips campaignId={campaignId} moment={moment} overrides={overrides} onChange={setOverrides} mode={prefs.chips} />}
      </div>

      {/* Reads like a rules question? Offer the rules panel; never reroute on its own. */}
      {RULES_QUESTION.test(moment.trim()) && (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("loom:rules", { detail: moment.trim() }));
            setMoment("");
          }}
          className="btn-secondary rise mt-1 text-[13px]"
        >
          Ask as a rules question
        </button>
      )}
      {!asked && (empty || opening) && (
        <Welcome
          name={name}
          trySample={trySample}
          campaignId={campaignId}
          opening={opening}
          onStarted={async (o) => {
            setOpening(o);
            await reload();
          }}
          onBegin={() => {
            setBegun(opening);
            setOpening(null);
            setAtTable(true);
            focusBox("What do the players do?");
          }}
          onAtTable={() => {
            setAtTable(true);
            setTimeout(() => focusBox("What happens first?"), 0);
          }}
        />
      )}
      {!asked && !empty && !opening && !begun && lastTime && <LastTimeCard last={lastTime} />}
      {!asked && begun && !opening && (
        <div className="rise mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{begun.title} · the opening</p>
          <blockquote className="story mt-1.5 border-l-2 border-line pl-3 text-[15px] leading-relaxed text-muted">
            <Linked text={begun.opening} />
          </blockquote>
        </div>
      )}
      {!asked && sample && !entries.length && (
        <div className="rise mt-5">
          <p className="mb-2 text-[13px] text-muted">This is the sample campaign: two players drank mystery potions. Try one of these, or type your own.</p>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_MOMENTS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMoment(m);
                  focusBox();
                }}
                className="story btn-secondary text-[14px] italic"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {asked && (
        <section aria-live="polite" className="mt-6">
          {done?.safetyNote && <Note>{done.safetyNote}</Note>}

          <ol className="space-y-3">
            {/* While Loom writes, each row is an empty answer the words it read drop into; when its
                option arrives the row turns over into it. Restored moments show their options as they are. */}
            {Array.from({ length: status === "running" || vanishing.length ? Math.max(3, cards.length) : cards.length }, (_, i) => cards[i]).map((card, i) => {
              if (!card && vanishing.includes(i))
                return <SlotRow key={`slot-${fresh}-${i}`} n={i} words={readWords(read)} startedAt={askedAt.current} knownAt={readAt} expectMs={read?.expectMs ?? 4000} dropped onLanded={() => {}} />;
              if (fresh && !landed.has(i))
                return (
                  <SlotRow
                    key={`slot-${fresh}-${i}`}
                    n={i}
                    words={readWords(read)}
                    startedAt={askedAt.current}
                    knownAt={readAt}
                    expectMs={read?.expectMs ?? 4000}
                    headline={card?.headline}
                    tag={card?.flavour ? (FLAVOUR_LABEL[card.flavour] ?? card.flavour) : undefined}
                    onLanded={() => setLanded((l) => new Set(l).add(i))}
                  />
                );
              if (!card) return null;
              const state = !current?.choiceKind ? "open" : current.choiceKind === "option" && current.choice === card.text ? "used" : "other";
              // Once you've chosen, the rest fold away so the page follows the story, not the menu:
              // first they unravel into a thread, then they're gone.
              if (state === "other" && !showOthers) return unravelling ? <Headline key={`${card.label}-${i}`} card={card} n={i + 1} onOpen={() => {}} leaving={i} /> : null;
              // Headlines first: only the one you open (or the one you used) is shown in full.
              if (state === "open" && openCard !== i)
                return <Headline key={`${card.label}-${i}`} card={card} n={i + 1} onOpen={() => setOpenCard(i)} settled={!!fresh} />;
              return (
                <OptionCard
                  key={`${card.label}-${i}`}
                  card={card}
                  n={i + 1}
                  onFold={state === "open" ? () => setOpenCard(null) : undefined}
                  state={state}
                  canUse={!!current}
                  onUse={() => use({ kind: "option", label: card.label, text: card.text, awaiting: card.needs })}
                  live={live}
                  // Developing a card you haven't used yet uses it first, so what grows from it has a parent.
                  parent={async () => (state === "used" ? current!.id : await use({ kind: "option", label: card.label, text: card.text, awaiting: card.needs }))}
                  known={state === "used" ? current?.id : null}
                  saved={state === "used" ? current?.developments : undefined}
                  result={state === "used" ? entries.find((e) => e.parentId === current?.id && e.choiceKind === "result") : undefined}
                />
              );
            })}
          </ol>
          {current?.choiceKind && cards.some((c) => !(current.choiceKind === "option" && current.choice === c.text)) && (
            <button type="button" onClick={() => setShowOthers(!showOthers)} className="btn-tertiary mt-2 flex text-sm">
              {showOthers ? "Fold the other options" : `${cards.filter((c) => !(current.choiceKind === "option" && current.choice === c.text)).length} other options`}
              <Icon name="arrow" size={12} className={`transition-transform ${showOthers ? "-rotate-90" : "rotate-90"}`} />
            </button>
          )}

          {/* One tap re-weaves the options: no typing. */}
          {status === "done" && !current?.choiceKind && !!done?.steers.length && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px]">
              <span className="mr-1 text-xs text-muted">{steered ? `Re-woven: ${steered}. Again:` : "Not quite?"}</span>
              {done.steers.map((st) => (
                <button key={st} type="button" onClick={() => ask({ steer: st })} className="rounded-full border border-line bg-surface px-3 py-0.5 text-foreground/80 hover:border-thread/60">
                  {st}
                </button>
              ))}
            </div>
          )}

          {status === "done" && current && <OwnChoice entry={current} onSave={(text) => use({ kind: "own", label: "", text })} />}
          {current?.choiceKind && <LoomStatus entry={current} />}
          {/* A fight gets its setup up front; anything else can still become one, quietly. */}
          {current?.choiceKind && (
            <div className="mt-3">
              <FightPanel
                key={current.id}
                entryId={current.id}
                campaignId={campaignId}
                initial={(current.encounter as Encounter) ?? null}
                onChange={reload}
                quiet={current.awaiting !== "fight" && !current.encounter}
              />
            </div>
          )}
          {current && <Branches parent={current} live={live} />}

          {/* Arrives with the last option, so it goes below the cards rather than shifting them. */}
          {!!done?.fixes.length && (
            <div className="mt-3 space-y-2">
              {done.fixes.map((f) => (
                <RecordNote key={f.say} campaignId={campaignId} note={f} />
              ))}
            </div>
          )}

          {status === "done" && cards.length === 0 && (
            <p className="mt-4 text-sm text-muted">No options got past the checks this time. Try rephrasing the moment, ask again, or write what happened yourself.</p>
          )}
          {error && <p className="mt-4 text-sm text-danger">{error}</p>}
          {done?.llm && (
            <p className="mt-5 text-xs text-muted">
              {prefs.costs && `${done.llm.model.replace(/^claude-/, "")} · ${done.llm.seconds.toFixed(1)} s · $${done.llm.costUsd.toFixed(4)}`}
              {done.llm.attempts > 1 ? ` · ${done.llm.attempts} attempts` : ""}
            </p>
          )}
        </section>
      )}
      {!asked && error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </>
  );
}

// The moment and the records disagreed. Loom went with the moment for these options; say so, and
// let the GM settle it in one tap: record it, or keep it to this moment. Either way, play on.
function RecordNote({ campaignId, note }: { campaignId: number; note: RecordFix }) {
  const [state, setState] = useState<"" | "busy" | "saved" | "kept">("");
  const loom = useLoom();
  if (state === "kept") return null;
  return (
    <div className="rise flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
      <Icon name="sparkle" className="text-thread" />
      <span className="min-w-0 flex-1 text-muted">{state === "saved" ? "Recorded. Your records match this moment now." : <Linked text={note.say} />}</span>
      {state !== "saved" && (
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                await post("/api/records", { campaignId, fix: note.fix });
                setState("saved");
                loom?.reload();
              } catch {
                setState("");
              }
            }}
            className="btn-secondary text-xs"
          >
            {note.apply}
          </button>
          <button type="button" onClick={() => setState("kept")} className="btn-tertiary text-xs" title="Keep the records as they are">
            Just this moment
          </button>
        </span>
      )}
    </div>
  );
}

// ---------- notices ----------

// Quiet notices at the bottom: what just landed in the loom. Tap one to open that moment.
function Toasts({ toasts, onOpen, onClose }: { toasts: { id: number; entryId: number; title: string; detail: string }[]; onOpen: (entryId: number) => void; onClose: (id: number) => void }) {
  // Each notice stays about six seconds from when it appeared.
  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => onClose(t.id), Math.max(0, 6000 - (Date.now() - t.id))));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onClose]);
  if (!toasts.length) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} className="rise pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
          <Icon name="sparkle" className="mt-0.5 text-thread" />
          <button type="button" onClick={() => onOpen(t.entryId)} className="min-w-0 flex-1 text-left">
            <p className="text-sm font-medium">{t.title}</p>
            {t.detail && <p className="story truncate text-[13px] text-muted">{t.detail}</p>}
          </button>
          <button type="button" onClick={() => onClose(t.id)} aria-label="Dismiss" className="btn-tertiary">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- first run ----------

type LastTime = { session: number | null; notes: string; threads: { id: number; title: string }[]; prep: string[] };

// Before the first moment of a session: where things stood, to pick up from.
function LastTimeCard({ last }: { last: LastTime }) {
  return (
    <section className="rise mt-8 rounded-2xl border border-line bg-surface p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-thread">{last.session ? `Last time · session ${last.session}` : "Where things stand"}</p>
      {last.notes && (
        <p className="story mt-2 leading-relaxed text-foreground/85">
          <Linked text={last.notes} />
        </p>
      )}
      {last.threads.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Threads in play</p>
          <RefChips refs={last.threads.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }))} />
        </div>
      )}
      {last.prep.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          Your prep ideas: <span className="text-foreground/85">{last.prep.join(" · ")}</span>{" "}
          <Link href="/prep" className="underline decoration-line underline-offset-2 hover:text-foreground">
            open them
          </Link>
        </p>
      )}
      <p className="mt-3 text-[13px] text-muted">When the players do something, type it in the box.</p>
    </section>
  );
}

// The hook's three stages, as they happen: what's done, what's going on, what's next.
const HOOK_STAGES = [
  { id: "writing", label: "Writing the world" },
  { id: "reading", label: "Reading it into the loom" },
  { id: "weaving", label: "Weaving the threads together" },
];
function HookStages({ stage, title }: { stage: string; title?: string }) {
  const at = Math.max(0, HOOK_STAGES.findIndex((x) => x.id === stage));
  return (
    <ol className="space-y-1.5 text-[13px]" aria-live="polite">
      {HOOK_STAGES.map((x, i) => (
        <li key={x.id} className={`flex items-center gap-2 ${i > at ? "text-muted/60" : i < at ? "text-muted" : "text-foreground"}`}>
          <span className={`grid h-4 w-4 place-items-center rounded-full border ${i < at ? "border-thread bg-thread text-background" : i === at ? "border-thread" : "border-line"}`}>
            {i < at ? <Icon name="check" size={9} /> : i === at ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-thread" /> : null}
          </span>
          {x.label}
          {i === at && i > 0 && title ? <span className="text-muted">· {title}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// What a hook put in the loom, grouped as a GM thinks of it, each one tappable.
function Made({ made }: { made: NonNullable<Opening["made"]> }) {
  const of = (types: string[]) => made.entities.filter((e) => types.includes(e.type));
  const groups = [
    { title: "Your players", items: of(["pc"]), sub: "Player character" },
    { title: "Characters", items: of(["npc"]), sub: "Character" },
    { title: "Places", items: of(["location"]), sub: "Place" },
    { title: "Things and factions", items: of(["item", "faction", "other"]), sub: "" },
  ].filter((g) => g.items.length);
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{g.title}</p>
          <p className="mt-0.5 text-[14px] leading-relaxed">
            {g.items.map((e, i) => (
              <span key={e.id}>
                {i > 0 && <span className="text-muted"> · </span>}
                <RefLink r={{ kind: "entity", id: e.id, name: e.name, sub: g.sub || e.type }} />
              </span>
            ))}
          </p>
        </div>
      ))}
      {made.threads.length > 0 && (
        <div className="sm:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Threads already tangling</p>
          <RefChips refs={made.threads.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }))} />
        </div>
      )}
      <p className="text-sm text-muted sm:col-span-2">Tap any of them to see more. When the players do something, type it in the box.</p>
    </div>
  );
}

// An empty campaign: three ways in, each one tap.
function Welcome({
  name,
  trySample,
  campaignId,
  opening,
  onStarted,
  onBegin,
  onAtTable,
}: {
  name: string;
  trySample: () => Promise<void>;
  campaignId: number;
  opening: Opening | null;
  onStarted: (o: Opening) => Promise<void>;
  onBegin: () => void;
  onAtTable: () => void;
}) {
  const [busy, setBusy] = useState<"" | "hook" | "sample">("");
  const [stage, setStage] = useState<{ stage: string; title?: string }>({ stage: "writing" });
  const [party, setParty] = useState("");
  const [theme, setTheme] = useState("");
  const [error, setError] = useState("");
  const elapsed = useElapsed(busy === "hook");

  // Just started from a hook: the opening, to read aloud, then straight to the table.
  if (opening)
    return (
      <section className="rise mt-8 rounded-2xl border border-line bg-surface p-6">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">{opening.title}</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">Read this to your players</h2>
        <blockquote className="story mt-3 border-l-2 border-thread pl-4 text-[18px] leading-relaxed">
          <Linked text={opening.opening} />
        </blockquote>
        {opening.made && <Made made={opening.made} />}
        <button type="button" onClick={onBegin} className="btn-primary mt-4 text-sm">
          Begin <Icon name="arrow" size={12} />
        </button>
      </section>
    );

  return (
    <section className="rise mt-8 rounded-2xl border border-line bg-surface p-6">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">New campaign</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight">{name ? `Welcome to ${name}` : "Welcome"}</h2>
      <p className="story mt-2 max-w-prose leading-relaxed text-foreground/85">
        When your players go off-script, Loom finds the threads already in play and shows you how to tie the moment back to them. To do that it needs something to remember.
      </p>

      <div className="mt-5 rounded-xl border border-thread/40 bg-thread-soft/30 p-4">
        <p className="font-medium">Start from a hook</p>
        <p className="text-sm text-muted">Never run a game before? Loom invents a small world to begin in: a place, a few characters, and threads that tangle together.</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            value={party}
            onChange={(e) => setParty(e.target.value)}
            placeholder="Who's playing? e.g. Mira the rogue"
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
          />
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="Any flavour? e.g. haunted harbour"
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
          />
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            setBusy("hook");
            setError("");
            try {
              setStage({ stage: "writing" });
              const r = await stream<Opening>("/api/campaigns/hook", { campaignId, party, theme }, (e) => e.type === "stage" && setStage({ stage: String(e.stage), title: e.title as string | undefined }));
              await onStarted({ title: r.title, opening: r.opening, made: r.made });
            } catch (e) {
              setError(e instanceof Error ? e.message : "Something went wrong.");
            } finally {
              setBusy("");
            }
          }}
          className="btn-primary mt-3 text-sm"
        >
          <Icon name="sparkle" /> {busy === "hook" ? `Inventing a world… ${elapsed} s` : party.trim() || theme.trim() ? "Invent the hook" : "Start from a random hook"}
        </button>
        {busy === "hook" && (
          <div className="mt-4">
            <HookStages stage={stage.stage} title={stage.title} />
          </div>
        )}
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      </div>

      <ol className="mt-5 space-y-4">
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">
            <Icon name="save" size={12} />
          </span>
          <div>
            <p className="font-medium">Already playing? Paste your last session&apos;s notes</p>
            <p className="text-sm text-muted">However rough. Loom picks out the threads, characters and places, and you confirm them.</p>
            <Link href="/prep" className="btn-secondary mt-2 text-sm">
              Add notes <Icon name="arrow" size={12} />
            </Link>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-thread-soft text-xs font-semibold text-thread">
            <Icon name="pen" size={12} />
          </span>
          <div>
            <p className="font-medium">Or start at the table</p>
            <p className="text-sm text-muted">Type the first thing that happens. Everything you use is remembered as you go.</p>
            <button type="button" onClick={onAtTable} className="btn-secondary mt-2 text-sm">
              Start typing <Icon name="arrow" size={12} />
            </button>
          </div>
        </li>
      </ol>
      <button
        type="button"
        disabled={!!busy}
        onClick={async () => {
          setBusy("sample");
          try {
            await trySample();
          } finally {
            setBusy("");
          }
        }}
        className="btn-tertiary mt-5 text-xs"
      >
        Just looking? Open the sample campaign <Icon name="arrow" size={11} />
      </button>
    </section>
  );
}

// ---------- questions: pinned in view until answered ----------

function QuestionTray({
  questions,
  reload,
  campaignId,
  autoApprove,
  setAutoApprove,
}: {
  questions: (Question & { entry: Entry })[];
  reload: () => Promise<unknown>;
  campaignId: number;
  autoApprove: boolean;
  setAutoApprove: (v: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const q = questions[0];
  const answer = async (yes: boolean) => {
    setBusy(true);
    try {
      await post("/api/live/answer", { entryId: q.entry.id, n: q.n, yes });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alert" className="rise mb-2 rounded-xl border-2 border-thread/70 bg-thread-soft/60 p-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          Needs your answer{questions.length > 1 ? ` · 1 of ${questions.length}` : ""}
        </p>
        <span className="truncate text-xs text-muted">from “{q.entry.choiceLabel || q.entry.moment}”</span>
      </div>
      <p className="mt-1 text-[14.5px]">
        <span className="text-muted">{q.group}: </span>
        <Linked text={q.summary} />
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {q.reasons.join(" · ")}
        {q.evidence && <span className="italic"> · “{q.evidence}”</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => answer(true)} className="btn-primary text-sm">
          Yes, record it
        </button>
        <button type="button" disabled={busy} onClick={() => answer(false)} className="btn-secondary text-sm">
          No
        </button>
        <span className="ml-auto">
          <Switch
            checked={autoApprove}
            onChange={async (v) => {
              setAutoApprove(v);
              await post("/api/campaign/save", { campaignId, autoApprove: v });
            }}
          >
            Auto-approve from now on
          </Switch>
        </span>
      </div>
    </div>
  );
}

// ---------- the session timeline (a tree, drawn flat) ----------

function Timeline({ session, live, open, setOpen, glowing }: { session: number; live: Live; open: number | null; setOpen: (id: number | null) => void; glowing: Set<number> }) {
  const [noting, setNoting] = useState(false);
  const { entries } = live;
  const used = entries.filter((e) => e.choiceKind).length;
  const shown = entries.find((e) => e.id === open);
  const strip = useRef<HTMLOListElement>(null);
  useEffect(() => {
    strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: "smooth" });
  }, [entries.length]);
  // Children sit right after their parent, so a branch reads left to right.
  const ordered: { e: Entry; depth: number }[] = [];
  const kids = new Map<number, Entry[]>();
  for (const e of entries) if (e.parentId != null) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
  const ids = new Set(entries.map((e) => e.id));
  const walk = (e: Entry, depth: number) => {
    ordered.push({ e, depth });
    for (const k of kids.get(e.id) ?? []) walk(k, depth + 1);
  };
  for (const e of entries) if (e.parentId == null || !ids.has(e.parentId)) walk(e, 0);

  return (
    <section aria-label={`Session ${session} so far`} className="mb-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">
          Session {session}
          {entries.length > 0 && <span className="font-normal"> · {used} used</span>}
        </span>
        <ol ref={strip} className="flex min-w-0 flex-1 items-center overflow-x-auto py-1 [scrollbar-width:none]">
          {entries.length === 0 && <li className="text-xs text-muted/70">Nothing yet. What you use at the table lands here.</li>}
          {ordered.map(({ e, depth }, i) => (
            <li key={e.id} className="flex items-center">
              {/* Every dot sits the same distance from the last; a line fills the gap only when
                  this one grew from the one before it (a result, or a branch). */}
              {i > 0 && <span aria-hidden className={`mx-0.5 h-px w-2 ${depth > 0 ? "bg-thread/50" : ""}`} />}
              <button
                type="button"
                onClick={() => setOpen(open === e.id ? null : e.id)}
                aria-label={`${e.choiceKind === "branch" ? "Branch: " : ""}${e.choiceLabel || e.moment}${e.choiceKind ? " (used)" : " (asked)"}`}
                title={e.choiceKind === "branch" ? `Continued: ${e.choiceLabel || e.choice}` : e.moment}
                className={`relative grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] transition-colors ${glowing.has(e.id) ? "glow" : ""} ${open === e.id ? "ring-2 ring-thread/60" : ""} ${
                  e.choiceKind ? "bg-thread-soft text-thread" : "border border-line text-muted/70"
                }`}
              >
                {e.status === "extracting" ? <span className="h-2 w-2 animate-ping rounded-full bg-thread" /> : e.status === "failed" ? "!" : <Icon name={e.choiceKind === "result" ? "diamond" : e.choiceKind === "branch" ? "branch" : e.choiceKind === "own" ? "pen" : e.choiceKind ? "check" : "dot"} size={12} />}
                {(e.questions.length > 0 || (e.awaiting && e.awaiting !== "choice")) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger" />}
              </button>
            </li>
          ))}
        </ol>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <button type="button" onClick={() => setNoting(!noting)} className="btn-tertiary" title="Log something that happened without asking Loom">
            <Icon name="plus" size={12} /> Note
          </button>
          {used > 0 && (
            <Link href="/prep" className="btn-tertiary" title="Add what Loom didn't see, and close the session">
              Wrap up <Icon name="arrow" size={12} />
            </Link>
          )}
        </div>
      </div>

      {noting && (
        <QuickNote
          campaignId={live.campaignId}
          onDone={async () => {
            setNoting(false);
            await live.reload();
          }}
        />
      )}
      {shown && <EntryDetail entry={shown} live={live} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </section>
  );
}

function QuickNote({ campaignId, onDone }: { campaignId: number; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="rise mt-2 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await post("/api/live/note", { campaignId, text });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't log that.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Something that happened, e.g. “they bought the lockpicks off the fence”"
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-thread/60"
      />
      <button disabled={busy || text.trim().length < 2} className="btn-primary text-sm">
        Log
      </button>
      {error && <span className="self-center text-xs text-danger">{error}</span>}
    </form>
  );
}

function EntryDetail({ entry, live, onClose, onOpen }: { entry: Entry; live: Live; onClose: () => void; onOpen: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const parent = live.entries.find((e) => e.id === entry.parentId);
  // The options of the moment this entry belongs to (its own, or its first ancestor's).
  const rootOptions = rootOf(live.entries, entry.id)?.options.length ?? 0;
  const takeBack = async () => {
    setBusy(true);
    try {
      await post("/api/live/clear", { entryId: entry.id });
      await live.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise mt-2 rounded-xl border border-line bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="italic text-muted">
          {parent ? (
            <>
              <Icon name="branch" size={12} /> from{" "}
              <button type="button" onClick={() => onOpen(parent.id)} className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                {parent.choiceLabel || parent.moment}
              </button>
            </>
          ) : (
            <Linked text={entry.moment} />
          )}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" className="btn-tertiary">
          <Icon name="close" />
        </button>
      </div>
      {entry.choiceKind ? (
        <>
          <p className="mt-1.5">
            {entry.choiceLabel && entry.choiceKind !== "result" && <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-wide">{entry.choiceLabel}</span>}
            <Linked text={entry.choice} />
          </p>
          <LoomStatus entry={entry} />
          {(entry.awaiting === "fight" || !!entry.encounter) && (
            <div className="mt-2">
              <FightPanel key={entry.id} entryId={entry.id} campaignId={live.campaignId} initial={(entry.encounter as Encounter) ?? null} onChange={live.reload} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <Develop live={live} parent={async () => entry.id} known={entry.id} saved={entry.developments} />
            <button type="button" onClick={takeBack} disabled={busy} className="btn-tertiary">
              <Icon name="undo" size={12} /> Take back
            </button>
          </div>
          <Branches parent={entry} live={live} onOpen={onOpen} />
        </>
      ) : (
        <p className="mt-1.5 text-xs text-muted">Asked, nothing used.</p>
      )}
      {!!rootOptions && (
        <button type="button" onClick={() => live.reopen(entry.id)} className="btn-secondary mt-3 text-[13px]">
          {entry.choiceKind ? "Back to this moment" : `Show the ${rootOptions} options`}
        </button>
      )}
    </div>
  );
}

// What grew from a choice: the branches you continued with.
function Branches({ parent, live, onOpen }: { parent: Entry; live: Live; onOpen?: (id: number) => void }) {
  const kids = live.entries.filter((e) => e.parentId === parent.id);
  if (!kids.length) return null;
  return (
    <div className="mt-3 border-l-2 border-thread/40 pl-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Continued with</p>
      <ul className="mt-1 space-y-2">
        {kids.map((k) => (
          <li key={k.id} className="text-[14px]">
            <Icon name="branch" size={12} className="mr-1 text-thread" />
            {/* A result's text already opens with its outcome ("Partly. Only Khayiulad…"). */}
            {k.choiceLabel && k.choiceKind !== "result" && <span className="mr-1 font-medium">{k.choiceLabel}.</span>}
            <Linked text={k.choice} />
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
              <LoomStatus entry={k} compact />
              {onOpen ? (
                <button type="button" onClick={() => onOpen(k.id)} className="text-muted hover:text-foreground">
                  Open
                </button>
              ) : (
                <Develop live={live} parent={async () => k.id} known={k.id} saved={k.developments} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// What using a choice did to the loom. Questions live in the tray above the box.
function LoomStatus({ entry, compact = false }: { entry: Entry; compact?: boolean }) {
  if (entry.status === "extracting") return <Reading final="Adding it to the loom" className={compact ? "" : "mt-3"} />;
  if (entry.status === "failed") return <p className={`${compact ? "" : "mt-3"} text-xs text-danger`}>Couldn&apos;t add this to the loom. It&apos;s still in the session log for wrap-up.</p>;
  if (entry.status !== "done") return null;
  if (compact) return <span className="text-xs text-muted">{entry.summary.length ? `${entry.summary.length} added to the loom` : "Logged"}{entry.questions.length ? ` · ${entry.questions.length} to answer above` : ""}</span>;
  return (
    <div className="mt-3 text-xs text-muted">
      {entry.summary.length ? (
        <details>
          <summary className="cursor-pointer">
            <span className="text-thread">Added to the loom:</span> {entry.summary.length} change{entry.summary.length === 1 ? "" : "s"}
            {entry.questions.length ? ` · ${entry.questions.length} waiting for your answer above` : ""}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {entry.summary.map((s, i) => (
              <li key={i}>
                <Linked text={s} />
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <>Logged. Nothing new for the loom.{entry.questions.length ? ` ${entry.questions.length} waiting for your answer above.` : ""}</>
      )}
    </div>
  );
}

// ---------- the options ----------

// An option as one line: its flavour and its hook. Tap to read it in full.
// `settled`: the row has just turned over into it, so it takes its place without moving.
function Headline({ card, n, onOpen, leaving, settled = false }: { card: Card; n: number; onOpen: () => void; leaving?: number; settled?: boolean }) {
  // Not chosen: it goes up in smoke. The card itself and every letter on it drift up, spread and
  // fade, each on its own timing, and then the row closes.
  if (leaving != null) {
    const at = leaving * 160;
    return (
      <li className="smoke rounded-xl" style={{ "--delay": `${at}ms` } as React.CSSProperties} aria-hidden>
        <div className="smoke-pane flex w-full items-start gap-3 rounded-xl px-4 py-3">
          <span className="story min-w-0 flex-1 leading-snug max-sm:min-h-[2.75em]">
            <Smoke text={card.headline} seed={n * 53} at={at} />
          </span>
          <span className="mt-0.5 flex min-w-[5rem] shrink-0 justify-end">
            {card.flavour && (
              <span className="ltr-smoke rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread" style={{ animationDelay: `${at + 120}ms`, "--sy": "-18px", "--sx": "6px" } as React.CSSProperties}>
                {FLAVOUR_LABEL[card.flavour] ?? card.flavour}
              </span>
            )}
          </span>
        </div>
      </li>
    );
  }
  return (
    <li className={settled ? "" : "rise"}>
      <button type="button" onClick={onOpen} className="group flex w-full items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:border-thread/60">
        <span className="story min-w-0 flex-1 leading-snug max-sm:min-h-[2.75em]">
          <Still text={card.headline} />
        </span>
        {/* Tags sit in a place of their own, the same width as while the row was being written. */}
        <span className="mt-0.5 flex min-w-[5rem] shrink-0 justify-end gap-1.5">
          {card.surprise && <span className="rounded-full border border-thread/50 px-2 py-0.5 text-[11px] text-thread" title={card.surprise}>Surprise</span>}
          {card.flavour && <span className="rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread">{FLAVOUR_LABEL[card.flavour] ?? card.flavour}</span>}
        </span>
      </button>
    </li>
  );
}

function OptionCard({
  card,
  n,
  onFold,
  state,
  canUse,
  onUse,
  live,
  parent,
  known,
  saved,
  result,
}: {
  card: Card;
  n: number;
  onFold?: () => void; // back to its headline, while choosing
  state: "open" | "used" | "other";
  canUse: boolean;
  onUse: () => void;
  live: Live;
  parent: () => Promise<number | null>;
  known?: number | null; // the logged choice, once this card is used
  saved?: unknown[];
  result?: Entry; // how its roll, fight or choice turned out, once recorded
}) {
  const [copied, setCopied] = useState(false);
  const showWhy = usePrefs().why;
  return (
    <li
      id={state === "used" ? "chosen" : undefined}
      className={`rise group scroll-mt-40 rounded-xl border bg-surface p-4 shadow-sm transition-opacity ${state === "used" ? "border-thread/60" : "border-line"} ${state === "other" ? "opacity-55 hover:opacity-100" : ""}`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        {/* The headline stays the option's name; tapping it folds the card back while choosing. */}
        <h2 className="min-w-0 flex-1">
          <button type="button" onClick={onFold} disabled={!onFold} aria-expanded={!!onFold} className="flex w-full items-baseline gap-3 text-left disabled:cursor-default">
            {state === "used" && <Icon name="check" className="shrink-0 text-thread" />}
            <span className="story min-w-0 flex-1 font-medium leading-snug">{card.headline}</span>
            {card.flavour && <span className="shrink-0 rounded-full bg-thread-soft px-2 py-0.5 text-[11px] text-thread">{FLAVOUR_LABEL[card.flavour] ?? card.flavour}</span>}
          </button>
        </h2>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(card.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="text-xs text-muted transition-opacity hover:text-foreground focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="story leading-relaxed">
        <Linked text={card.text} />
      </p>
      <RefChips refs={[...threadRefs(card.threads), ...(card.callback ? [{ kind: "moment" as const, id: card.callback.id, name: `Callback: ${card.callback.title}` }] : [])]} />
      {card.surprise && (
        <p className="mt-2 text-[13px] text-thread">
          <span className="font-medium">A surprise.</span> <span className="italic text-muted">{card.surprise.replace(/^a lesser goal surfaces: /, "")}</span>
        </p>
      )}
      {card.why && showWhy && !card.surprise && <p className="mt-2 text-[13px] italic text-muted">{card.why}</p>}
      {result && (
        <p className="mt-3 flex flex-wrap items-baseline gap-2 text-[13px]">
          <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${/fail|lost|fled/i.test(result.choiceLabel) ? "bg-danger/10 text-danger" : "bg-thread-soft text-thread"}`}>{result.choiceLabel}</span>
          {result.choice.replace(/^[^.]*\.\s*/, "").trim() && <span className="story text-muted">{result.choice.replace(/^[^.]*\.\s*/, "")}</span>}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {/* One action while choosing; what grows from it (Develop) comes once it's used. */}
        {state !== "used" ? (
          <button type="button" onClick={onUse} disabled={!canUse} className="btn-primary font-medium">
            <Icon name="check" /> Use this
          </button>
        ) : (
          <>
            <span className="text-xs text-thread">Used. What happens next goes in the box above.</span>
            <Develop live={live} parent={parent} known={known} saved={saved} />
          </>
        )}
      </div>
    </li>
  );
}

function OwnChoice({ entry, onSave }: { entry: Entry; onSave: (text: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(entry.choiceKind === "own" ? entry.choice : "");
  const [busy, setBusy] = useState(false);
  if (entry.choiceKind === "own" && !open)
    return (
      <div className="mt-3 rounded-xl border border-thread/60 bg-surface p-4">
        <p className="text-[13px] font-semibold uppercase tracking-wide">
          <Icon name="pen" className="mr-2 text-thread" />Your own
        </p>
        <p className="story mt-1 leading-relaxed">
          <Linked text={entry.choice} />
        </p>
        <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs text-muted hover:text-foreground">
          Edit
        </button>
      </div>
    );
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-tertiary mt-3 text-sm">
        <Icon name="pen" /> None of these. Write what happened
      </button>
    );
  return (
    <form
      className="rise mt-3 rounded-xl border border-line bg-surface p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(text.trim());
          setOpen(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What you decided happened, in a line or two"
        className="block w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-muted/70"
      />
      <div className="mt-2 flex justify-end gap-3 text-sm">
        <button type="button" onClick={() => setOpen(false)} className="text-muted">
          Cancel
        </button>
        <button disabled={busy || text.trim().length < 2} className="btn-primary">
          Use this
        </button>
      </div>
    </form>
  );
}
