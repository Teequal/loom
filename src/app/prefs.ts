"use client";

import { useEffect, useState } from "react";
import { store } from "./shell";

// Per-browser preferences, set on the Settings page (and some from the table's tune panel). They
// live in this browser only; campaign settings (tone of the campaign, auto-approve) are on the
// campaign page.

export type ChipsMode = "chips" | "icons" | "hidden";
export type Tier = "haiku" | "sonnet" | "opus";
export type MixId = "mix" | "fights" | "mystery" | "light" | "character";

export interface Prefs {
  chips: ChipsMode; // how Loom shows what it read from the moment (who's here, what's in hand)
  model: Tier; // the default tier at the table
  tone: number; // 0 grounded … 4 theatrical
  mix: MixId; // the kinds of option
  why: boolean; // show the "why this fits" line on options
  developOptions: number; // how many chains Develop writes (1-3)
  surprises: "off" | "rare" | "sometimes" | "often"; // how often Loom slips in a surprise
}

export const DEFAULT_PREFS: Prefs = { chips: "chips", model: "haiku", tone: 1, mix: "mix", why: true, developOptions: 1, surprises: "rare" };

export function resetPrefs() {
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) setPref(k, DEFAULT_PREFS[k]);
}

const KEYS: { [K in keyof Prefs]: string } = { chips: "loom.chips", model: "loom.model", tone: "loom.tone", mix: "loom.mix", why: "loom.why", developOptions: "loom.developOptions", surprises: "loom.surprises" };

export function readPrefs(): Prefs {
  const get = (k: keyof Prefs) => store.get(KEYS[k]);
  const num = (k: "tone" | "developOptions", max: number, min = 0) => {
    const v = Number(get(k));
    return get(k) !== null && Number.isInteger(v) && v >= min && v <= max ? v : DEFAULT_PREFS[k];
  };
  const oneOf = <T extends string>(k: keyof Prefs, allowed: readonly T[], d: T) => (allowed.includes(get(k) as T) ? (get(k) as T) : d);
  return {
    chips: oneOf("chips", ["chips", "icons", "hidden"] as const, DEFAULT_PREFS.chips),
    model: oneOf("model", ["haiku", "sonnet", "opus"] as const, DEFAULT_PREFS.model),
    tone: num("tone", 4),
    mix: oneOf("mix", ["mix", "fights", "mystery", "light", "character"] as const, DEFAULT_PREFS.mix),
    why: get("why") === null ? DEFAULT_PREFS.why : get("why") === "1",
    developOptions: num("developOptions", 3, 1),
    surprises: oneOf("surprises", ["off", "rare", "sometimes", "often"] as const, DEFAULT_PREFS.surprises),
  };
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  store.set(KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  window.dispatchEvent(new Event("loom:prefs"));
}

// The current preferences, kept in step when they change anywhere on the page.
export function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    const load = () => setPrefs(readPrefs());
    load();
    window.addEventListener("loom:prefs", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("loom:prefs", load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return prefs;
}
