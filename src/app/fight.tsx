"use client";

import { useState } from "react";
import { Steps } from "./controls";
import { DIFFICULTIES, fit, rate, type Edition } from "@/core/encounter-math";
import { Icon } from "./icons";
import { Linked } from "./loom-ui";
import { post, useElapsed } from "./shell";

// Setting up a fight from a choice: a difficulty dial with Loom's suggestion marked, enemies drawn
// from who's in play with compact stats, and counts you can change. The XP maths is exact (code,
// not the model) and updates as you go. The fight then waits for its result like any roll.

interface Foe {
  name: string;
  count: number;
  cr: string;
  ac: number;
  hp: number;
  attacks: string;
  save_dc: number | null;
  trick: string;
  srd: boolean;
}
export interface Encounter {
  edition: Edition;
  levels: number[];
  recommended: number;
  why: string;
  band: number;
  foes: Foe[];
  terrain: string;
  twist: string;
}

export function FightPanel({ entryId, campaignId, initial, onChange, quiet = false }: { entryId: number; campaignId: number; initial: Encounter | null; onChange: () => Promise<unknown>; quiet?: boolean }) {
  const [enc, setEnc] = useState<Encounter | null>(initial);
  const [open, setOpen] = useState(!!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needLevels, setNeedLevels] = useState<{ id: number; name: string }[] | null>(null);
  const [levels, setLevels] = useState<Record<number, string>>({});
  const elapsed = useElapsed(busy);

  const setUp = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await post<{ needLevels?: { id: number; name: string }[]; encounter?: Encounter }>("/api/encounter", { entryId });
      if (r.needLevels) setNeedLevels(r.needLevels);
      else if (r.encounter) {
        setEnc(r.encounter);
        setNeedLevels(null);
        await onChange();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  const save = async (next: Encounter) => {
    setEnc(next);
    await post("/api/encounter/save", { entryId, encounter: next }).catch(() => {});
  };

  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!enc) void setUp();
        }}
        className={quiet ? "btn-tertiary text-xs" : "btn-secondary text-sm"}
      >
        <Icon name="diamond" size={quiet ? 11 : 14} /> {quiet ? "Set up a fight" : "Set up the fight"}
      </button>
    );

  return (
    <div className="rise mt-1 w-full basis-full rounded-xl border border-line bg-background p-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">The fight</p>
        <button type="button" onClick={() => setOpen(false)} className="btn-tertiary text-xs">
          Close
        </button>
      </div>

      {needLevels && (
        <form
          className="mt-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await post("/api/campaign/levels", { campaignId, levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, Number(v)])) });
            await setUp();
          }}
        >
          <p className="text-[13px] text-muted">To size the fight, Loom needs each character&apos;s level. You&apos;ll only be asked once.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {needLevels.map((p) => (
              <label key={p.id} className="flex items-center gap-1.5">
                {p.name}
                <input
                  inputMode="numeric"
                  value={levels[p.id] ?? ""}
                  onChange={(e) => setLevels({ ...levels, [p.id]: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                  className="w-9 border-b border-dashed border-line bg-transparent text-center outline-none focus:border-solid focus:border-thread/60"
                  aria-label={`${p.name}'s level`}
                />
              </label>
            ))}
          </div>
          <button disabled={busy || needLevels.some((p) => !(Number(levels[p.id]) >= 1 && Number(levels[p.id]) <= 20))} className="btn-primary mt-3 text-sm">
            Save and set up
          </button>
        </form>
      )}

      {busy && <p className="mt-2 animate-pulse text-xs text-muted">Setting up the fight… {elapsed} s</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {enc && !needLevels && <FightView enc={enc} onChange={save} onAgain={setUp} busy={busy} />}
    </div>
  );
}

function FightView({ enc, onChange, onAgain, busy }: { enc: Encounter; onChange: (e: Encounter) => void; onAgain: () => void; busy: boolean }) {
  const steps = DIFFICULTIES[enc.edition];
  const r = rate(enc.foes, enc.levels, enc.edition);
  const setCount = (i: number, d: number) => onChange({ ...enc, foes: enc.foes.map((f, j) => (j === i ? { ...f, count: Math.max(0, f.count + d) } : f)).filter((f) => f.count > 0) });
  return (
    <div className="mt-2 space-y-3">
      <div>
        <Steps
          label="Difficulty"
          steps={steps}
          value={Math.max(0, Math.min(steps.length - 1, enc.band))}
          marked={enc.recommended}
          onChange={(band) => {
            const fitted = fit(enc.foes, enc.levels, enc.edition, band);
            onChange({ ...enc, band, foes: fitted.map((f) => ({ ...enc.foes.find((x) => x.name === f.name)!, count: f.count })) });
          }}
        />
        <p className="mt-0.5 text-xs text-muted">Suggested {steps[enc.recommended]}: {enc.why}</p>
      </div>

      <ul className="space-y-2.5">
        {enc.foes.map((f, i) => (
          <li key={f.name} className="flex gap-3">
            <div className="flex shrink-0 items-center gap-1 self-start rounded-lg border border-line bg-surface px-1 text-[13px]">
              <button type="button" onClick={() => setCount(i, -1)} aria-label={`One fewer ${f.name}`} className="btn-tertiary px-1">
                −
              </button>
              <span className="w-4 text-center font-medium tabular-nums">{f.count}</span>
              <button type="button" onClick={() => setCount(i, 1)} aria-label={`One more ${f.name}`} className="btn-tertiary px-1">
                +
              </button>
            </div>
            <div className="min-w-0">
              <p className="story font-medium">
                <Linked text={f.name} />
                {f.srd && <span className="ml-1.5 font-sans text-[11px] font-normal text-muted">SRD</span>}
              </p>
              <p className="text-xs tabular-nums text-muted">
                CR {f.cr} · AC {f.ac} · HP {f.hp} · {f.attacks}
                {f.save_dc ? ` · DC ${f.save_dc}` : ""}
              </p>
              {f.trick && <p className="story text-[13px] italic text-foreground/75">{f.trick}</p>}
            </div>
          </li>
        ))}
      </ul>

      {(enc.terrain || enc.twist) && (
        <div className="space-y-1 text-[13px]">
          {enc.terrain && (
            <p>
              <span className="text-muted">Where: </span>
              <Linked text={enc.terrain} />
            </p>
          )}
          {enc.twist && (
            <p>
              <span className="text-muted">Twist: </span>
              <Linked text={enc.twist} />
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-2 text-xs text-muted">
        <span className="tabular-nums">
          <span className={r.band === enc.band ? "text-foreground" : "text-danger"}>{r.label}</span> · {r.adjusted.toLocaleString()} XP{enc.edition === "2014" && r.adjusted !== r.xp ? ` adjusted (${r.xp.toLocaleString()} base)` : ""} · party of {enc.levels.length}, level{" "}
          {[...new Set(enc.levels)].join("/")}
        </span>
        <button type="button" onClick={onAgain} disabled={busy} className="btn-tertiary text-xs">
          Different enemies
        </button>
      </div>
      <p className="text-xs text-muted">When it&apos;s over, record how it went at the top of the page.</p>
    </div>
  );
}
