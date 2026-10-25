"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "./icons";
import type { ChipsMode } from "./prefs";
import { post } from "./shell";

// What Loom read from the moment, under the box: who's here, who's only mentioned, what's in hand,
// which house rules it triggers. Read by code as you type (no model call). Tap one to correct it;
// the options are then built on the corrected scene.

export type Pair = { pc: string; item: string };
export interface Overrides {
  here?: string[];
  away?: string[];
  inHand?: Pair[];
  notInHand?: Pair[];
  rulesOn?: string[];
  rulesOff?: string[];
}
type Chip =
  | { kind: "here" | "mentioned" | "afar"; name: string; on: boolean; why: string }
  | { kind: "in-hand"; pc: string; item: string; on: boolean; why: string }
  | { kind: "rule"; rule: string; on: boolean; why: string }
  | { kind: "place" | "lost"; name: string; on: true; why: string };

const ICON: Record<Chip["kind"], IconName> = { here: "person", mentioned: "person", afar: "signal", "in-hand": "item", rule: "die", place: "pin", lost: "item" };
const without = <T,>(xs: T[] | undefined, same: (x: T) => boolean) => (xs ?? []).filter((x) => !same(x));

// Tapping a chip: the opposite of what Loom read, as an override.
function flip(o: Overrides, c: Chip): Overrides {
  switch (c.kind) {
    case "here":
      return { ...o, here: without(o.here, (n) => n === c.name), away: [...without(o.away, (n) => n === c.name), c.name] };
    case "mentioned":
    case "afar":
      return { ...o, away: without(o.away, (n) => n === c.name), here: [...without(o.here, (n) => n === c.name), c.name] };
    case "in-hand": {
      const same = (p: Pair) => p.pc === c.pc && p.item === c.item;
      return c.on
        ? { ...o, inHand: without(o.inHand, same), notInHand: [...without(o.notInHand, same), { pc: c.pc, item: c.item }] }
        : { ...o, notInHand: without(o.notInHand, same) };
    }
    case "rule":
      return c.on
        ? { ...o, rulesOn: without(o.rulesOn, (r) => r === c.rule), rulesOff: [...without(o.rulesOff, (r) => r === c.rule), c.rule] }
        : { ...o, rulesOff: without(o.rulesOff, (r) => r === c.rule), rulesOn: [...without(o.rulesOn, (r) => r === c.rule), c.rule] };
    default:
      return o;
  }
}

function label(c: Chip) {
  switch (c.kind) {
    case "here":
      return `${c.name} here`;
    case "mentioned":
      return `${c.name} not here`;
    case "afar":
      return `${c.name} from afar`;
    case "in-hand":
      return `${c.pc}: ${c.item}`;
    case "rule":
      return c.rule;
    case "place":
      return `→ ${c.name}`;
    case "lost":
      return `${c.name}: lost`;
  }
}

const tip = (c: Chip) => `${c.why}${c.kind === "place" || c.kind === "lost" ? "" : " · tap to change"}`;

export function SceneChips({ campaignId, moment, overrides, onChange, mode }: { campaignId: number; moment: string; overrides: Overrides; onChange: (o: Overrides) => void; mode: ChipsMode }) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [open, setOpen] = useState(false);
  const text = moment.trim();

  useEffect(() => {
    if (mode === "hidden" || text.length < 3) return;
    let live = true;
    const t = setTimeout(() => {
      post<{ chips: Chip[] }>("/api/situation", { campaignId, moment: text, overrides })
        .then((r) => live && setChips(r.chips))
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [campaignId, text, overrides, mode]);

  if (mode === "hidden" || text.length < 3 || !chips.length) return null;

  const row = (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="What Loom read from the moment">
      {chips.map((c, i) => {
        const fixed = c.kind === "place" || c.kind === "lost";
        return (
          <button
            key={`${c.kind}-${i}-${label(c)}`}
            type="button"
            disabled={fixed}
            title={tip(c)}
            onClick={() => onChange(flip(overrides, c))}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] transition-colors ${
              c.on ? "border-thread/40 bg-thread/10 text-foreground" : "border-line text-muted line-through decoration-muted/50"
            } ${fixed ? "cursor-default" : "hover:border-thread/70"}`}
          >
            <Icon name={ICON[c.kind]} size={12} />
            {label(c)}
          </button>
        );
      })}
    </div>
  );

  if (mode === "icons" && !open) {
    const count = (kinds: Chip["kind"][]) => chips.filter((c) => kinds.includes(c.kind)).length;
    const groups: [IconName, number, string][] = [
      ["person", count(["here", "mentioned", "afar"]), "people"],
      ["item", count(["in-hand", "lost"]), "items"],
      ["die", count(["rule"]), "rules"],
      ["pin", count(["place"]), "place"],
    ];
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-2.5 text-[12px] text-muted hover:text-foreground" title="What Loom read from the moment · tap to see">
        {groups
          .filter(([, n]) => n)
          .map(([icon, n, name]) => (
            <span key={name} className="inline-flex items-center gap-0.5">
              <Icon name={icon} size={12} />
              {n}
            </span>
          ))}
      </button>
    );
  }
  return <div className="mt-2">{row}</div>;
}
