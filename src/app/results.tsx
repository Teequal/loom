"use client";

import { useState } from "react";
import { Switch } from "./controls";
import { Icon } from "./icons";
import { post } from "./shell";

/** A roll waiting at the table, as the server works it out from the option (server/rolls.ts). */
export interface RollPlan {
  what: string;
  secret: boolean;
  rollers: { name: string; bonus: number | null; bonusFrom: string | null }[];
  rule: { name: string; check: string; onFail: string; onSuccess: string } | null;
  onFail: string;
}
type Outcome = "success" | "failure" | "partial";
const d20 = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 20);
const DCS = [10, 12, 15, 18, 20];

/**
 * The roll panel: who's rolling and what, opened as soon as an option that asks for a roll is used.
 * A secret roll the GM rolls here (with a bonus where Loom knows one); an open one, the GM types in
 * what each player got. With a DC, each roll is marked made or missed by itself; without, a tap
 * says how it went. Recorded per character, so momentum and nudges know who it was.
 */
export function RollPanel({ entryId, label, plan, onDone, count }: { entryId: number; label: string; plan: RollPlan; onDone: () => Promise<unknown> | void; count?: string }) {
  const [secret, setSecret] = useState(plan.secret);
  const [dc, setDc] = useState<number | null>(null);
  const [rows, setRows] = useState(plan.rollers.map((r) => ({ name: r.name, bonus: r.bonus == null ? "" : String(r.bonus), bonusFrom: r.bonusFrom, die: null as number | null, total: "", tapped: null as Outcome | null })));
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const rollFor = (i: number) => {
    const die = d20();
    set(i, { die, total: String(die + (Number(rows[i].bonus) || 0)), tapped: null });
  };
  const outcomeOf = (r: (typeof rows)[number]): Outcome | null => r.tapped ?? (dc != null && /^-?\d+$/.test(r.total) ? (r.die === 1 ? "failure" : r.die === 20 || Number(r.total) >= dc ? "success" : "failure") : null);
  const ready = rows.every((r) => outcomeOf(r));
  const send = async (body: object) => {
    setBusy(true);
    setError("");
    try {
      await post("/api/live/result", { entryId, ...body });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record that.");
    } finally {
      setBusy(false);
    }
  };
  const record = () => send({ dc, detail, rolls: rows.map((r) => ({ name: r.name, total: /^-?\d+$/.test(r.total) ? Number(r.total) : null, outcome: outcomeOf(r)! })) });
  const MARK: Record<Outcome, string> = { success: "Made it", failure: "Missed", partial: "Partly" };
  return (
    <div className="rise rounded-xl border-2 border-thread/70 bg-thread-soft/60 p-3 text-sm" role="alert">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          {plan.what}
          {count ? ` · ${count}` : ""}
        </p>
        <button type="button" disabled={busy} onClick={() => send({ skip: true })} className="btn-tertiary text-xs" title="Don't record a result for this">
          skip
        </button>
      </div>
      <p className="story mt-0.5 truncate text-[14px] text-foreground/85">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Switch checked={secret} onChange={setSecret} hint="A secret roll is yours to roll, out of the players' sight">
          {secret ? "Secret: you roll it" : "The players roll"}
        </Switch>
        <span className="flex items-center gap-1 text-[13px] text-muted">
          DC
          {DCS.map((n) => (
            <button key={n} type="button" aria-pressed={dc === n} onClick={() => setDc(dc === n ? null : n)} className={`rounded-full px-2 py-0.5 tabular-nums ${dc === n ? "bg-foreground text-background" : "border border-line bg-surface text-foreground/80 hover:border-thread/60"}`}>
              {n}
            </button>
          ))}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r, i) => {
          const o = outcomeOf(r);
          return (
            <li key={r.name} className="flex flex-wrap items-center gap-2">
              <span className="min-w-[6rem] flex-1 truncate font-medium">{r.name}</span>
              {secret && (
                <button type="button" onClick={() => rollFor(i)} className="btn-secondary flex items-center gap-1 text-xs" title={r.bonusFrom ? `d20 + ${r.bonus} (${r.bonusFrom})` : "d20 plus the bonus beside it"}>
                  <Icon name="diamond" size={11} /> Roll
                </button>
              )}
              <label className="flex items-center gap-0.5 text-[12px] text-muted" title={r.bonusFrom ? `From their ${r.bonusFrom}` : "Their bonus, if you know it"}>
                +
                <input value={r.bonus} inputMode="numeric" aria-label={`${r.name}'s bonus`} onChange={(e) => set(i, { bonus: e.target.value.replace(/[^\d-]/g, "").slice(0, 3) })} className="w-7 border-b border-line bg-transparent text-center text-foreground outline-none focus:border-thread/60" />
              </label>
              <input
                value={r.total}
                inputMode="numeric"
                aria-label={`${r.name}'s total`}
                placeholder={secret ? "total" : "they got"}
                onChange={(e) => set(i, { total: e.target.value.replace(/[^\d-]/g, "").slice(0, 3), die: null, tapped: null })}
                className="w-16 rounded-md border border-line bg-surface px-2 py-0.5 text-center tabular-nums outline-none focus:border-thread/60"
              />
              {r.die != null && <span className="text-[12px] text-muted tabular-nums">rolled {r.die}</span>}
              <span className="flex gap-1">
                {(["success", "partial", "failure"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={o === k} onClick={() => set(i, { tapped: r.tapped === k ? null : k })} className={`rounded-full px-2 py-0.5 text-[12px] ${o === k ? (k === "failure" ? "bg-danger/15 text-danger" : "bg-thread text-background") : "border border-line bg-surface text-foreground/70 hover:border-thread/60"}`}>
                    {MARK[k]}
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {(plan.onFail || plan.rule?.onFail) && <p className="mt-2 text-[13px] text-muted"><span className="text-foreground/80">On a failure:</span> {plan.onFail || plan.rule?.onFail}</p>}
      {plan.rule?.onSuccess && <p className="text-[13px] text-muted"><span className="text-foreground/80">On a success:</span> {plan.rule.onSuccess}</p>}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) record();
        }}
      >
        <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Anything to add? (optional)" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1 text-[13px] outline-none focus:border-thread/60" />
        <button disabled={busy || !ready} className="btn-primary text-sm" title={ready ? "" : "Mark how each roll went, or set a DC and enter the totals"}>
          Record
        </button>
      </form>
      {error && <p className="mt-1 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

// "How did it go?" for a roll or a fight: a few outcomes to tap, an optional line of detail, and a
// quiet way to skip. Used in the table's tray and again at wrap-up.

const OUTCOMES = {
  roll: ["Succeeded", "Failed", "Partly"],
  fight: ["Won", "Fled", "Lost", "Talked it out"],
} as const;

export function ResultPrompt({
  entryId,
  kind,
  label,
  onDone,
  count,
  folded = false,
}: {
  entryId: number;
  kind: "roll" | "fight";
  label: string;
  onDone: () => Promise<unknown> | void;
  count?: string;
  folded?: boolean; // still playing out: one quiet line until you're ready to record it
}) {
  const [open, setOpen] = useState(!folded);
  const [outcome, setOutcome] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await post("/api/live/result", { entryId, ...body });
      setOutcome("");
      setDetail("");
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="rise flex items-center justify-between gap-3 rounded-xl border border-thread/50 bg-thread-soft/40 px-3 py-1.5 text-[13px]">
        <span className="min-w-0 truncate text-muted">
          <span className="text-thread">{kind === "fight" ? "Fight in progress" : "Roll in play"}</span> · record how it went when it&apos;s over
        </span>
        <button type="button" onClick={() => setOpen(true)} className="btn-secondary shrink-0 text-xs">
          Record result
        </button>
      </div>
    );
  return (
    <div className="rise rounded-xl border-2 border-thread/70 bg-thread-soft/60 p-3 text-sm" role="alert">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-thread">
          {kind === "fight" ? "How did the fight go?" : "How did the roll go?"}
          {count ? ` · ${count}` : ""}
        </p>
        <button type="button" disabled={busy} onClick={() => send({ skip: true })} className="btn-tertiary text-xs" title="Don't record a result for this">
          skip
        </button>
      </div>
      <p className="story mt-0.5 truncate text-[14px] text-foreground/85">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {OUTCOMES[kind].map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={outcome === o}
            // One tap records it, with whatever detail is already typed.
            onClick={() => {
              setOutcome(o);
              send({ outcome: o, detail });
            }}
            disabled={busy}
            className={`rounded-full px-3 py-0.5 text-[13px] transition-colors ${outcome === o ? "bg-foreground text-background" : "border border-line bg-surface text-foreground/80 hover:border-thread/60"}`}
          >
            {o}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send({ outcome, detail });
        }}
      >
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={kind === "fight" ? "Anything to add? Who fell, what was taken… (optional, before you tap)" : "Anything to add? (optional, before you tap)"}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1 text-[13px] outline-none focus:border-thread/60"
        />
        {detail.trim() && (
          <button disabled={busy} className="btn-secondary text-sm">
            Just this
          </button>
        )}
      </form>
    </div>
  );
}

// Which side of a choice the players took: one quiet line, one tap, never required. Knowing it lets
// Loom record what they did (helped her, threatened him) without reading anyone's words.
export function SidePrompt({ entryId, sides, onDone }: { entryId: number; sides: string[]; onDone: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false);
  const send = async (body: object) => {
    setBusy(true);
    try {
      await post("/api/live/result", { entryId, ...body });
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-1.5 text-[13px]">
      <span className="text-muted">Which did they choose?</span>
      {sides.map((s) => (
        <button key={s} type="button" disabled={busy} onClick={() => send({ outcome: s })} className="rounded-full border border-line px-2.5 py-0.5 text-[13px] text-foreground/85 hover:border-thread/60">
          {s}
        </button>
      ))}
      <button type="button" disabled={busy} onClick={() => send({ skip: true })} className="btn-tertiary ml-auto text-xs" title="Don't record which">
        skip
      </button>
    </div>
  );
}
