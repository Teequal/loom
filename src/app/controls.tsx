"use client";

import { useEffect, useRef, useState } from "react";

// The few controls Loom has, drawn the same way everywhere: quiet until you reach for them, never
// a browser default that looks like it came from another app.

// A step choice (tone, how far ahead): labelled dots on a thread, the current step named.
export function Steps({ label, steps, value, onChange, marked }: { label: string; steps: readonly string[]; value: number; onChange: (v: number) => void; marked?: number }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-3">
      <div className="relative flex items-center">
        <span aria-hidden className="absolute inset-x-1.5 h-px bg-line" />
        {steps.map((s, i) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={s}
            title={s}
            onClick={() => onChange(i)}
            className="relative grid h-6 w-6 place-items-center"
          >
            <span className={`block rounded-full transition-all ${value === i ? "h-2.5 w-2.5 bg-thread" : i < value ? "h-1.5 w-1.5 bg-thread/60" : "h-1.5 w-1.5 bg-muted/40"}`} />
            {/* Loom's suggestion: a faint ring that stays put while you move the choice. */}
            {marked === i && <span aria-hidden className="absolute inset-1 rounded-full border border-thread/60" />}
          </button>
        ))}
      </div>
      <span className="text-[13px] text-foreground/80">
        {steps[value]}
        {marked != null && marked === value && <span className="ml-1.5 text-xs text-muted">suggested</span>}
      </span>
    </div>
  );
}

// A choice of a few words: text tabs, the chosen one quietly raised.
export function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { id: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg bg-background p-0.5 text-[13px]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-0.5 transition-colors ${value === o.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} title={hint} className="group flex items-center gap-2 text-left text-[13px] text-muted hover:text-foreground">
      <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? "bg-thread" : "bg-line"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-surface shadow transition-all ${checked ? "left-3.5" : "left-0.5"}`} />
      </span>
      <span>{children}</span>
    </button>
  );
}

// A quiet trigger that opens a small panel of settings, closed by clicking away or Escape.
export function Tune({ summary, label, children, align = "left" }: { summary: React.ReactNode; label: string; children: React.ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors ${open ? "bg-background text-foreground" : "text-muted hover:text-foreground"}`}
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 4h7M12 4h2M2 12h2M7 12h7" />
          <circle cx="10.5" cy="4" r="1.5" />
          <circle cx="5.5" cy="12" r="1.5" />
        </svg>
        {summary}
      </button>
      {open && (
        <div role="dialog" aria-label={label} className={`rise absolute z-30 mt-1.5 w-72 space-y-3 rounded-xl border border-line bg-surface p-3.5 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}
