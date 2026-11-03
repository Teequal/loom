"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Choice } from "./controls";
import { Icon } from "./icons";
import { post } from "./shell";

// The GM's side of the screen: rolls the players don't see, and the GM's own random tables.
// The dice run here in the page; nothing is sent anywhere or written down unless the GM says so.

interface Pc {
  name: string;
  perception: number | null;
  insight: number | null;
}
interface Rule {
  id: number;
  name: string;
  check: string;
  onFail: string;
  onSuccess: string;
  rule: string;
  secret: boolean;
}
interface Table {
  id: number;
  name: string;
  lines: string[];
}
const roll = (sides: number) => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % sides);
const CHECKS = ["Perception", "Insight", "Other"] as const;
type Check = (typeof CHECKS)[number];

export function GmTools({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const [tab, setTab] = useState<"rolls" | "rules" | "tables">("rolls");
  const [pcs, setPcs] = useState<Pc[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const send = useCallback(
    (body: object = {}) =>
      post<{ pcs: Pc[]; tables: Table[]; rules: Rule[] }>("/api/tools", { campaignId, ...body }).then((r) => {
        setPcs(r.pcs);
        setTables(r.tables);
        setRules(r.rules);
      }),
    [campaignId],
  );
  useEffect(() => void send().catch(() => {}), [send]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <aside aria-label="GM tools" className="glass-panel rise fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-3xl sm:inset-y-3 sm:left-auto sm:right-3 sm:max-h-none sm:w-[420px] sm:rounded-3xl">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <Choice value={tab} onChange={setTab} label="Tool" options={[{ id: "rolls", label: "Secret rolls" }, { id: "rules", label: "House rules" }, { id: "tables", label: "Tables" }]} />
        <button type="button" onClick={onClose} className="btn-tertiary" aria-label="Close tools">
          <Icon name="close" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 text-sm">{tab === "rolls" ? <SecretRolls pcs={pcs} /> : tab === "rules" ? <RuleRolls pcs={pcs} rules={rules} campaignId={campaignId} /> : <Tables campaignId={campaignId} tables={tables} send={send} />}</div>
    </aside>,
    document.body,
  );
}

function SecretRolls({ pcs }: { pcs: Pc[] }) {
  const [check, setCheck] = useState<Check>("Perception");
  const [dc, setDc] = useState("");
  const [rolls, setRolls] = useState<{ name: string; die: number; total: number | null }[]>([]);
  const mod = (p: Pc) => {
    const passive = check === "Perception" ? p.perception : check === "Insight" ? p.insight : null;
    return passive == null ? null : passive - 10;
  };
  const go = () => setRolls(pcs.map((p) => ((die, m) => ({ name: p.name, die, total: m == null ? null : die + m }))(roll(20), mod(p))));
  const target = Number(dc) || null;
  return (
    <div className="space-y-3">
      <p className="text-muted">Rolled here, seen only by you. For what a character might notice without knowing there was anything to notice.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Choice value={check} onChange={(c) => { setCheck(c); setRolls([]); }} label="Check" options={CHECKS.map((c) => ({ id: c, label: c }))} />
        <label className="flex items-center gap-1.5 text-muted">
          DC
          <input value={dc} inputMode="numeric" onChange={(e) => setDc(e.target.value.replace(/\D/g, "").slice(0, 2))} className="w-8 border-b border-line bg-transparent text-center text-foreground outline-none focus:border-thread/60" />
        </label>
      </div>
      {!pcs.length && <p className="text-muted">No player characters on record yet.</p>}
      {!!pcs.length && <button type="button" onClick={go} className="btn-primary text-sm">Roll for everyone</button>}
      {!!rolls.length && (
        <ul className="space-y-1">
          {rolls.map((r) => {
            const score = r.total ?? r.die;
            return (
              <li key={r.name} className="flex items-baseline justify-between gap-3">
                <span>{r.name}</span>
                <span className="tabular-nums">
                  <span className="font-medium">{score}</span>
                  <span className="text-muted">{r.total == null ? " on the die" : ` (rolled ${r.die})`}</span>
                  {target != null && <span className={score >= target ? "ml-2 text-thread" : "ml-2 text-muted"}>{score >= target ? "succeeds" : "misses"}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rolls.some((r) => r.total == null) && check !== "Other" && <p className="text-[13px] text-muted">Plain d20s where a passive score isn&apos;t on record, so add their bonus yourself.</p>}
    </div>
  );
}

// A house rule's roll, by hand: pick the rule and who it's for, roll a d20 each, and see what a
// failure costs. Rolled here, seen only by you.
export function RuleRolls({ pcs, rules, campaignId }: { pcs: Pc[]; rules: Rule[]; campaignId?: number }) {
  const [picked, setPicked] = useState<number | null>(rules[0]?.id ?? null);
  const [who, setWho] = useState<string[]>([]);
  const [dc, setDc] = useState("");
  const [rolls, setRolls] = useState<{ name: string; die: number }[]>([]);
  const [logged, setLogged] = useState(false);
  const [error, setError] = useState("");
  const rule = rules.find((r) => r.id === picked) ?? rules[0];
  const target = Number(dc) || null;
  if (!rules.length) return <p className="text-muted">No house rules on record yet. Add one on the campaign page, or with <code>rule draft</code>.</p>;
  const toggle = (n: string) => setWho((w) => (w.includes(n) ? w.filter((x) => x !== n) : [...w, n]));
  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {rules.length > 1 && rules.map((r) => (
          <li key={r.id}>
            <button type="button" aria-pressed={rule?.id === r.id} onClick={() => { setPicked(r.id); setRolls([]); }} className={`w-full rounded-lg border px-3 py-1.5 text-left ${rule?.id === r.id ? "border-thread/70 bg-thread-soft/40" : "border-line hover:border-thread/50"}`}>
              <span className="font-medium">{r.name}</span>
              {r.secret && <span className="ml-2 text-[12px] text-muted">GM only</span>}
              {r.check && <span className="block text-[12px] text-muted">{r.check}</span>}
            </button>
          </li>
        ))}
      </ul>
      {rule && (
        <>
          {rule.rule && <p className="story text-[14px] text-foreground/80">{rule.rule}</p>}
          <div className="flex flex-wrap gap-1.5">
            {pcs.map((p) => (
              <button key={p.name} type="button" aria-pressed={who.includes(p.name)} onClick={() => toggle(p.name)} className={`rounded-full px-2.5 py-0.5 text-[13px] ${who.includes(p.name) ? "bg-foreground text-background" : "border border-line text-foreground/80 hover:border-thread/60"}`}>
                {p.name}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1.5 text-muted">
              DC
              <input value={dc} inputMode="numeric" onChange={(e) => setDc(e.target.value.replace(/\D/g, "").slice(0, 2))} className="w-8 border-b border-line bg-transparent text-center text-foreground outline-none focus:border-thread/60" />
            </label>
          </div>
          <button type="button" disabled={!pcs.length} onClick={() => { setRolls((who.length ? who : pcs.map((p) => p.name)).map((name) => ({ name, die: roll(20) }))); setLogged(false); }} className="btn-primary text-sm">
            {who.length ? `Roll for ${who.length === 1 ? who[0] : `${who.length} of them`}` : "Roll for everyone"}
          </button>
          {!!rolls.length && (
            <ul className="space-y-1">
              {rolls.map((r) => (
                <li key={r.name} className="flex items-baseline justify-between gap-3">
                  <span>{r.name}</span>
                  <span className="tabular-nums">
                    <span className="font-medium">{r.die}</span>
                    <span className="text-muted"> on the die</span>
                    {target != null && <span className={r.die >= target ? "ml-2 text-thread" : "ml-2 text-danger"}>{r.die >= target ? "resists" : "fails"}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rule.onFail && <p className="text-[13px] text-muted"><span className="text-foreground/80">On a failure:</span> {rule.onFail}</p>}
          {rule.onSuccess && <p className="text-[13px] text-muted"><span className="text-foreground/80">On a success:</span> {rule.onSuccess}</p>}
          {/* Into the log, so the loom hears how it went (read like any note). */}
          {campaignId && rolls.length > 0 && (
            <button
              type="button"
              disabled={logged}
              onClick={() =>
                post("/api/live/note", { campaignId, text: `${rule.name} roll: ${rolls.map((r) => `${r.name} ${r.die}${target != null ? (r.die >= target ? " (resists)" : " (fails)") : ""}`).join(", ")}${target != null ? ` against DC ${target}` : ""}.` })
                  .then(() => {
                    setLogged(true);
                    window.dispatchEvent(new Event("loom:reload"));
                  })
                  .catch((e) => setError(e.message))
              }
              className="btn-tertiary text-[13px]"
            >
              {logged ? "It's in the log" : "It happened: add it to the log"}
            </button>
          )}
          {error && <p className="text-danger">{error}</p>}
        </>
      )}
    </div>
  );
}

function Tables({ campaignId, tables, send }: { campaignId: number; tables: Table[]; send: (body?: object) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<{ id: number; n: number; line: string } | null>(null);
  const [logged, setLogged] = useState(false);
  const [error, setError] = useState("");
  const lines = text.split("\n").map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  return (
    <div className="space-y-4">
      <p className="text-muted">Your own lists to roll on: encounters, rumours, what&apos;s in the chest. Only you see them.</p>
      <ul className="space-y-2">
        {tables.map((t) => (
          <li key={t.id} className="rounded-lg border border-line p-2.5">
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={() => { const n = roll(t.lines.length); setPicked({ id: t.id, n, line: t.lines[n - 1] }); setLogged(false); }} className="btn-secondary text-sm">
                Roll
              </button>
              <span className="min-w-0 flex-1 truncate">{t.name} <span className="text-muted">· d{t.lines.length}</span></span>
              <button type="button" aria-label={`Remove ${t.name}`} onClick={() => void send({ removeTable: t.id })} className="text-muted hover:text-foreground"><Icon name="close" size={14} /></button>
            </div>
            {picked?.id === t.id && (
              <div className="mt-2">
                <p className="story text-[15px]"><span className="text-muted">{picked.n}.</span> {picked.line}</p>
                <button type="button" disabled={logged} onClick={() => post("/api/live/note", { campaignId, text: picked.line }).then(() => { setLogged(true); window.dispatchEvent(new Event("loom:reload")); }).catch((e) => setError(e.message))} className="btn-tertiary mt-1 text-[13px]">
                  {logged ? "It's in the log" : "It happened: add it to the log"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-danger">{error}</p>}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          send({ addTable: { name, lines } }).then(() => { setName(""); setText(""); }).catch((err) => setError(err.message));
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="New table's name" className="w-full border-b border-line bg-transparent py-1 outline-none focus:border-thread/60" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={"One line for each result\nNumbers are fine, or leave them off"} className="w-full resize-y rounded-lg border border-line bg-transparent p-2 outline-none focus:border-thread/60" />
        <button disabled={!name.trim() || lines.length < 2} className="btn-secondary text-sm">Add table{lines.length >= 2 ? ` (d${lines.length})` : ""}</button>
      </form>
    </div>
  );
}
