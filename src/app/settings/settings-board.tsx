"use client";

import Link from "next/link";
import { Choice, Field, Steps, Switch } from "../controls";
import { Icon } from "../icons";
import { MIXES, MODELS, TONES } from "../improv-box";
import { type ChipsMode, resetPrefs, setPref, usePrefs } from "../prefs";
import { Header, Note, useCampaigns } from "../shell";

// Settings: how Loom looks and what it starts with, in this browser. What belongs to a campaign
// (its tone, where the story is heading, asking before risky changes) is on the campaign page.

const CHIPS: { id: ChipsMode; label: string; hint: string }[] = [
  { id: "chips", label: "Chips", hint: "Who's here, what's in hand, rules triggered: a row of small labels" },
  { id: "icons", label: "Icons", hint: "Just small icons with counts; tap them to see the chips" },
  { id: "hidden", label: "Hidden", hint: "Don't show what Loom read (it still uses it)" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function SettingsBoard() {
  const c = useCampaigns();
  const p = usePrefs();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-24 pt-8 sm:pt-14">
      <Header c={c} />
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-5 text-[13px] text-muted">Kept in this browser. Campaign settings (tone, where the story is heading, risky changes) are on the <Link href="/campaign" className="underline decoration-line underline-offset-2 hover:text-foreground">campaign page</Link>.</p>
      {c.error && <Note tone="danger">{c.error}</Note>}

      <div className="space-y-4">
        <Section title="At the table">
          <Field label="What Loom read from the moment">
            <Choice label="What Loom read from the moment" options={CHIPS} value={p.chips} onChange={(v) => setPref("chips", v)} />
            <p className="mt-1.5 text-xs text-muted">{CHIPS.find((x) => x.id === p.chips)?.hint}. Tap a chip to correct it before asking.</p>
            {p.chips !== "hidden" && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]" aria-hidden>
                {p.chips === "chips" ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="person" size={12} />Tomas here</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-muted line-through decoration-muted/50"><Icon name="person" size={12} />Bhen not here</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="item" size={12} />Khayiulad: Knight figurine</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="die" size={12} />Figurine madness</span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-2.5 text-muted">
                    <span className="inline-flex items-center gap-0.5"><Icon name="person" size={12} />2</span>
                    <span className="inline-flex items-center gap-0.5"><Icon name="item" size={12} />1</span>
                    <span className="inline-flex items-center gap-0.5"><Icon name="die" size={12} />1</span>
                  </span>
                )}
                <span className="text-muted">(example)</span>
              </div>
            )}
          </Field>
          <Field label="Model">
            <Choice label="Model" options={MODELS} value={p.model} onChange={(v) => setPref("model", v)} />
            <p className="mt-1 text-xs text-muted">{MODELS.find((m) => m.id === p.model)?.hint}</p>
          </Field>
          <Field label="Kinds of option">
            <Choice label="Kinds of option" options={MIXES} value={p.mix} onChange={(v) => setPref("mix", v)} />
            <p className="mt-1 text-xs text-muted">{MIXES.find((m) => m.id === p.mix)?.hint}</p>
          </Field>
          <Field label="Tone">
            <Steps label="Tone" steps={TONES} value={p.tone} onChange={(v) => setPref("tone", v)} />
          </Field>
          <Field label="On each option">
            <Switch checked={p.why} onChange={(v) => setPref("why", v)} hint="The short line under an option saying why it fits now">
              Show why it fits
            </Switch>
          </Field>
        </Section>

        <Section title="Planning ahead">
          <Field label="Develop writes">
            <Choice
              label="Develop writes"
              options={[
                { id: "1", label: "1 take" },
                { id: "2", label: "2 takes" },
                { id: "3", label: "3 takes" },
              ]}
              value={String(p.developOptions)}
              onChange={(v) => setPref("developOptions", Number(v))}
            />
            <p className="mt-1 text-xs text-muted">How many versions Develop offers at once. You can always ask for another take.</p>
          </Field>
        </Section>

        <button type="button" onClick={resetPrefs} className="btn-tertiary self-start text-xs">
          Back to the defaults
        </button>
      </div>
    </main>
  );
}
