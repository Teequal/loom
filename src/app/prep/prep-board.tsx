"use client";

import { useCallback, useEffect, useState } from "react";
import { Linked, LoomProvider, RefChips } from "../loom-ui";
import { batchLabel, Header, Note, post, useCampaigns, useElapsed } from "../shell";

// Between sessions: paste the notes, confirm what changed (by risk, with undo), then get prep ideas.

type Tier = "auto" | "quick" | "must";
type Check = "exact" | "close" | "missing" | "not-found";
interface Item {
  n: number;
  tier: Tier;
  group: string;
  summary: string;
  evidence: string;
  check: Check;
  reasons: string[];
}
interface Proposal {
  sessionNumber: number;
  items: Item[];
  llm: { model: string; seconds: number; costUsd: number };
}
interface Applied {
  batch: string;
  counts: { entities: number; threads: number; updates: number; links: number; details: number; relationships: number; moments: number; party: boolean };
  warnings: string[];
  kept: string[];
}
interface Live {
  session: number;
  moments: number;
  used: number;
  changes: number;
  openQuestions: number;
  draft: string;
  questions: { entryId: number; from: string; n: number; group: string; summary: string; reasons: string[]; evidence: string }[];
}
interface Batch {
  batch: string;
  changes: number;
  undone: boolean;
  at: string | null;
}
type T = { id: number; title: string };
interface Ideas {
  collisions: { title: string; idea: string; why: string; threads: T[] }[];
  perPlayer: { pc: string; idea: string; quiet: boolean; threads: T[] }[];
  callbacks: { moment: string; session: number | null; idea: string; threads: T[] }[];
  quietThreads: { title: string; idea: string }[];
  llm: { model: string; seconds: number; costUsd: number };
}

const CHECK: Record<Check, { label: string; cls: string }> = {
  exact: { label: "in your notes", cls: "text-thread" },
  close: { label: "close to your notes", cls: "text-muted" },
  missing: { label: "no quote given", cls: "text-danger" },
  "not-found": { label: "not found in your notes", cls: "text-danger" },
};

const cost = (llm: { model: string; seconds: number; costUsd: number }) => `${llm.model.replace(/^claude-/, "")} · ${llm.seconds.toFixed(0)} s · $${llm.costUsd.toFixed(3)}`;

export function PrepBoard() {
  const c = useCampaigns();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-20 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}
      {/* Keyed by campaign, so switching campaigns starts clean. */}
      {c.campaignId && (
        <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
          <Board campaignId={c.campaignId} />
        </LoomProvider>
      )}
    </main>
  );
}

function Board({ campaignId }: { campaignId: number }) {
  const [notes, setNotes] = useState("");
  const [session, setSession] = useState<number | "">("");
  const [history, setHistory] = useState<Batch[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [yes, setYes] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState<Applied | null>(null);
  const [ideas, setIdeas] = useState<Ideas | null>(null);
  const [busy, setBusy] = useState<"" | "reading" | "saving" | "ideas" | "undo">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const elapsed = useElapsed(busy === "reading" || busy === "ideas");

  const refresh = useCallback(async (id: number) => {
    const r = await post<{ nextSession: number; history: Batch[]; live: Live | null }>("/api/prep", { campaignId: id });
    setSession(r.nextSession);
    setLive(r.live);
    setHistory(r.history);
  }, []);

  useEffect(() => {
    post<{ nextSession: number; history: Batch[]; live: Live | null }>("/api/prep", { campaignId })
      .then((r) => {
        setSession(r.nextSession);
        setLive(r.live);
        setHistory(r.history);
      })
      .catch((e) => setError(e.message));
  }, [campaignId]);

  async function run<R>(kind: typeof busy, f: () => Promise<R>) {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      return await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }

  const read = () =>
    run("reading", async () => {
      const p = await post<Proposal>("/api/recap/propose", { campaignId, recap: notes, sessionNumber: session || undefined });
      setProposal(p);
      setApplied(null);
      setSkip(new Set());
      setYes(new Set());
    });

  const save = () =>
    run("saving", async () => {
      if (!proposal) return;
      // Anything risky the GM didn't say yes to is skipped.
      const must = proposal.items.filter((i) => i.tier === "must");
      const skipped = [...skip, ...must.filter((i) => !yes.has(i.n)).map((i) => i.n)];
      const r = await post<Applied>("/api/recap/apply", { campaignId, sessionNumber: proposal.sessionNumber, skip: skipped, confirmed: [...yes] }).catch(async (e) => {
        // A failed save may have written part of it; the review closes so it can't be saved twice.
        setProposal(null);
        await refresh(campaignId);
        throw e;
      });
      setApplied(r);
      setProposal(null);
      setNotes("");
      await refresh(campaignId);
    });

  const undo = (batch: string) =>
    run("undo", async () => {
      const r = await post<{ undone: number; blocked: string[]; notes: string[]; history: Batch[] }>("/api/undo", { campaignId, batch });
      setHistory(r.history);
      if (r.blocked.length) setError(`Not undone: ${r.blocked[0]}${r.blocked.length > 1 ? ` (and ${r.blocked.length - 1} more)` : ""}. Undo the later change first.`);
      else {
        setNotice(`Undone: ${r.undone} change${r.undone === 1 ? "" : "s"} reversed.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`);
        if (applied?.batch === batch) setApplied(null);
      }
      await refresh(campaignId);
    });

  const wrapAsIs = () =>
    run("saving", async () => {
      const r = await post<{ session: number }>("/api/live/wrap", { campaignId });
      setNotice(`Session ${r.session} wrapped up: the table log is saved as its notes.`);
      await refresh(campaignId);
    });

  const getIdeas = () => run("ideas", async () => setIdeas(await post<Ideas>("/api/suggest", { campaignId })));

  const toggle = (set: Set<number>, n: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(n);
    else next.delete(n);
    return next;
  };

  const items = proposal?.items ?? [];
  const byTier = (t: Tier) => items.filter((i) => i.tier === t);
  const groups = (rows: Item[]) => [...rows.reduce((m, r) => m.set(r.group, [...(m.get(r.group) ?? []), r]), new Map<string, Item[]>())];
  const saving = items.filter((i) => (i.tier === "must" ? yes.has(i.n) : !skip.has(i.n))).length;

  return (
    <>
      {!proposal && (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold">{live?.used ? `Wrap up session ${live.session}` : "After the session"}</h2>
            <label className="flex items-center gap-1.5 text-sm text-muted">
              Session
              <input
                type="number"
                min={1}
                value={session}
                onChange={(e) => setSession(e.target.value ? Number(e.target.value) : "")}
                className="w-10 border-b border-dashed border-line bg-transparent text-center text-foreground outline-none [appearance:textfield] focus:border-solid focus:border-thread/60 [&::-webkit-inner-spin-button]:appearance-none"
              />
            </label>
          </div>
          {!!live?.questions.length && <OpenQuestions questions={live.questions} onAnswered={() => refresh(campaignId)} />}
          {!!live?.used && (
            <details className="mb-3 rounded-xl border border-line bg-surface p-4 text-sm">
              <summary className="cursor-pointer">
                <span className="font-medium">Played at the table with Loom:</span>{" "}
                <span className="text-muted">
                  {live.used} moment{live.used === 1 ? "" : "s"} used, {live.changes} change{live.changes === 1 ? "" : "s"} already in the loom
                  {live.openQuestions ? ` · ${live.openQuestions} to answer above` : ""}
                </span>
              </summary>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-muted">{live.draft}</pre>
            </details>
          )}
          <div className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-thread/60">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={9}
              placeholder={
                live?.used
                  ? "What else happened? Anything you didn't use Loom for: fights, discoveries, conversations, where things ended. Loom adds only what the table log doesn't already have."
                  : "Paste your session notes, however rough. Loom proposes what changed: new threads, progress, who's where. You confirm before anything is saved."
              }
              className="block w-full resize-y bg-transparent px-4 py-3.5 text-[15px] leading-relaxed outline-none placeholder:text-muted/70"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <span className="text-xs text-muted">
                {busy === "reading" ? (
                  `Reading your notes… ${elapsed} s (usually under a minute)`
                ) : live?.used ? (
                  <button type="button" onClick={wrapAsIs} disabled={!!busy || !!live.openQuestions} className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40 disabled:no-underline">
                    Nothing to add: wrap up as it is
                  </button>
                ) : (
                  "Uses the smartest model: about $0.05–0.10 a session"
                )}
              </span>
              <button
                onClick={read}
                disabled={notes.trim().length < 20 || !!busy || !!live?.openQuestions}
                className="shrink-0 whitespace-nowrap rounded-lg bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity disabled:opacity-30"
              >
                {busy === "reading" ? "Reading…" : live?.used ? "Read and wrap up" : "Read notes"}
              </button>
            </div>
          </div>
        </section>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {notice && <p className="mt-3 text-sm text-muted">{notice}</p>}

      {applied && (
        <section className="rise mt-6 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold">Saved</h2>
          <p className="mt-1 text-sm text-muted">
            {[
              applied.counts.threads && `${applied.counts.threads} new thread${applied.counts.threads > 1 ? "s" : ""}`,
              applied.counts.updates && `${applied.counts.updates} thread update${applied.counts.updates > 1 ? "s" : ""}`,
              applied.counts.entities && `${applied.counts.entities} new character${applied.counts.entities > 1 ? "s" : ""}, place${applied.counts.entities > 1 ? "s" : ""} or item${applied.counts.entities > 1 ? "s" : ""}`,
              applied.counts.details && `details for ${applied.counts.details}`,
              applied.counts.relationships && `${applied.counts.relationships} relationship${applied.counts.relationships > 1 ? "s" : ""}`,
              applied.counts.links && `${applied.counts.links} link${applied.counts.links > 1 ? "s" : ""} between threads`,
              applied.counts.party && "the party's location",
              applied.counts.moments && `${applied.counts.moments} suggested key moment${applied.counts.moments > 1 ? "s" : ""}`,
            ]
              .filter(Boolean)
              .join(" · ") || "Nothing changed."}
          </p>
          {applied.kept.map((k) => (
            <p key={k} className="mt-2 text-[13px] text-muted">
              ✎ {k}
            </p>
          ))}
          {applied.warnings.map((w) => (
            <p key={w} className="mt-2 text-[13px] text-danger">
              {w}
            </p>
          ))}
          <button onClick={() => undo(applied.batch)} disabled={!!busy} className="mt-3 text-sm text-muted underline-offset-2 hover:text-foreground hover:underline">
            Undo all of this
          </button>
        </section>
      )}

      {proposal && (
        <section className="rise">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Session {proposal.sessionNumber}: what changed</h2>
            <span className="text-xs text-muted">{cost(proposal.llm)}</span>
          </div>
          {!items.length && <Note>Loom didn&apos;t find anything new in these notes.</Note>}

          {byTier("must").length > 0 && (
            <Block title="Needs your yes" hint="Risky changes: over your own entries, deaths and captures, secrets, items changing hands, or quotes Loom couldn't find.">
              {byTier("must").map((i) => (
                <li key={i.n} className="rounded-lg border border-line p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] text-muted">{i.group}</p>
                      <p className="text-[15px]"><Linked text={i.summary} /></p>
                    </div>
                    <div role="radiogroup" aria-label={`Apply: ${i.summary}`} className="flex shrink-0 rounded-lg bg-background p-0.5 text-sm">
                      {[true, false].map((v) => (
                        <button
                          key={String(v)}
                          role="radio"
                          aria-checked={yes.has(i.n) === v}
                          onClick={() => setYes(toggle(yes, i.n, v))}
                          className={`rounded-md px-2.5 py-0.5 ${yes.has(i.n) === v ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
                        >
                          {v ? "Yes" : "No"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-1.5 text-[13px] text-muted">{i.reasons.join(" · ")}</p>
                  <Evidence item={i} />
                </li>
              ))}
            </Block>
          )}

          {byTier("quick").length > 0 && (
            <Block title="Confirm" hint="Ordinary story changes. All on; untick anything that's wrong.">
              {groups(byTier("quick")).map(([group, rows]) => (
                <li key={group} className="rounded-lg border border-line p-3">
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    <input
                      type="checkbox"
                      checked={rows.every((r) => !skip.has(r.n))}
                      onChange={(e) => {
                        const next = new Set(skip);
                        for (const r of rows) if (e.target.checked) next.delete(r.n); else next.add(r.n);
                        setSkip(next);
                      }}
                    />
                    {group}
                  </label>
                  <ul className="mt-1.5 space-y-1.5 pl-6">
                    {rows.map((r) => (
                      <li key={r.n}>
                        <label className="flex gap-2 text-[14.5px]">
                          <input type="checkbox" className="mt-1" checked={!skip.has(r.n)} onChange={(e) => setSkip(toggle(skip, r.n, !e.target.checked))} />
                          <span>
                            <Linked text={r.summary} />
                            <Evidence item={r} />
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </Block>
          )}

          {byTier("auto").length > 0 && (
            <details className="mb-5 rounded-xl border border-line bg-surface p-4">
              <summary className="cursor-pointer text-[15px] font-semibold">
                Added automatically <span className="font-normal text-muted">· {byTier("auto").length} low-risk details straight from your notes</span>
              </summary>
              <ul className="mt-3 space-y-1.5">
                {byTier("auto").map((r) => (
                  <li key={r.n}>
                    <label className="flex gap-2 text-[14px]">
                      <input type="checkbox" className="mt-1" checked={!skip.has(r.n)} onChange={(e) => setSkip(toggle(skip, r.n, !e.target.checked))} />
                      <span>
                        <span className="text-muted">{r.group}: </span>
                        <Linked text={r.summary} />
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 p-3 shadow-sm backdrop-blur">
            <button onClick={() => setProposal(null)} className="text-sm text-muted hover:text-foreground">
              Discard
            </button>
            <button onClick={save} disabled={!!busy || saving === 0} className="rounded-lg bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-30">
              {busy === "saving" ? "Saving…" : `Save ${saving} change${saving === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>
      )}

      <section className="mt-12">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold">Prep for next session</h2>
          <button onClick={getIdeas} disabled={!!busy} className="rounded-lg border border-line bg-surface px-3 py-1 text-sm disabled:opacity-40">
            {busy === "ideas" ? `Thinking… ${elapsed} s` : ideas ? "New ideas" : "Get prep ideas"}
          </button>
        </div>
        {!ideas && busy !== "ideas" && <p className="text-sm text-muted">Payoffs between threads already in play, something for each player, and ways back into quiet threads. About half a minute.</p>}
        {ideas && (
          <div className="rise space-y-6">
            <IdeaList title="Collisions: threads that pay each other off">
              {ideas.collisions.map((x) => (
                <Card key={x.title} title={x.title} body={x.idea} why={x.why} threads={x.threads} />
              ))}
            </IdeaList>
            <IdeaList title="For each player">
              {ideas.perPlayer.map((x) => (
                <Card key={x.pc} title={x.pc} badge={x.quiet ? "quiet lately" : undefined} body={x.idea} threads={x.threads} />
              ))}
            </IdeaList>
            {ideas.callbacks.length > 0 && (
              <IdeaList title="Callbacks: bring a key moment back">
                {ideas.callbacks.map((x) => (
                  <Card key={x.moment} title={`⟲ ${x.moment}${x.session ? ` (session ${x.session})` : ""}`} body={x.idea} threads={x.threads} />
                ))}
              </IdeaList>
            )}
            {ideas.quietThreads.length > 0 && (
              <IdeaList title="Quiet threads">
                {ideas.quietThreads.map((x) => (
                  <Card key={x.title} title={x.title} body={x.idea} threads={[]} />
                ))}
              </IdeaList>
            )}
            <p className="text-xs text-muted">{cost(ideas.llm)}</p>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-2 text-[15px] font-semibold">Recent changes</h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {history.map((b) => (
              <li key={b.batch} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className={b.undone ? "text-muted line-through" : ""}>
                  {batchLabel(b.batch)} <span className="text-muted">· {b.changes} change{b.changes === 1 ? "" : "s"}</span>
                </span>
                {b.undone ? (
                  <span className="text-xs text-muted">undone</span>
                ) : (
                  <button onClick={() => undo(b.batch)} disabled={!!busy} className="text-xs text-muted hover:text-foreground disabled:opacity-40">
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// Risky changes from the table that were never answered. Wrap-up waits for them, so a session
// can't close with something undecided.
function OpenQuestions({ questions, onAnswered }: { questions: Live["questions"]; onAnswered: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const answer = async (qs: Live["questions"], yes: boolean) => {
    setBusy(true);
    try {
      for (const q of qs) await post("/api/live/answer", { entryId: q.entryId, n: q.n, yes });
      await onAnswered();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section role="alert" className="rise mb-3 rounded-xl border-2 border-thread/70 bg-thread-soft/50 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          Before you wrap up · {questions.length} to answer
        </h3>
        {questions.length > 1 && (
          <button type="button" disabled={busy} onClick={() => answer(questions, false)} className="text-xs text-muted hover:text-foreground disabled:opacity-40">
            No to all
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[13px] text-muted">These came up at the table and are still waiting. Nothing risky is recorded without a yes.</p>
      <ul className="mt-3 space-y-2.5">
        {questions.map((q) => (
          <li key={`${q.entryId}:${q.n}`} className="rounded-lg bg-surface p-3">
            <p className="text-[14.5px]">
              <span className="text-muted">{q.group}: </span>
              <Linked text={q.summary} />
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {q.reasons.join(" · ")} · from {q.from === "your note" ? q.from : `“${q.from}”`}{q.evidence && <span className="italic"> · “{q.evidence}”</span>}
            </p>
            <div className="mt-2 flex gap-2 text-sm">
              <button type="button" disabled={busy} onClick={() => answer([q], true)} className="rounded-md bg-foreground px-3 py-0.5 text-background disabled:opacity-40">
                Yes, record it
              </button>
              <button type="button" disabled={busy} onClick={() => answer([q], false)} className="rounded-md border border-line px-3 py-0.5 disabled:opacity-40">
                No
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Block({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mb-3 text-[13px] text-muted">{hint}</p>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function Evidence({ item }: { item: Item }) {
  const c = CHECK[item.check];
  // Links between threads carry no quote; a verdict with nothing to check would mislead.
  if (!item.evidence && item.check !== "not-found") return null;
  return (
    <span className="mt-0.5 block text-[12.5px]">
      {item.evidence && <span className="italic text-muted">“{item.evidence}” </span>}
      <span className={c.cls}>{c.label}</span>
    </span>
  );
}

function IdeaList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="space-y-3">{children}</ul>
    </div>
  );
}

function Card({ title, body, why, badge, threads }: { title: string; body: string; why?: string; badge?: string; threads: T[] }) {
  return (
    <li className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h4 className="mb-1 text-[14px] font-semibold">
        {title}
        {badge && <span className="ml-2 rounded-full border border-thread/40 px-2 py-0.5 text-[11px] font-normal text-thread">{badge}</span>}
      </h4>
      <p className="story leading-relaxed">
        <Linked text={body} />
      </p>
      {why && <p className="mt-2 text-[13px] italic text-muted">{why}</p>}
      <RefChips refs={threads.map((t) => ({ kind: "thread" as const, id: t.id, name: t.title }))} />
    </li>
  );
}
