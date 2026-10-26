"use client";

import Link from "next/link";
import { Choice, Field, Steps, Switch } from "../controls";
import { Icon } from "../icons";
import { MIXES, MODELS, TONES } from "../improv-box";
import { type ChipsMode, resetPrefs, setPref, usePrefs } from "../prefs";
import { Header, Note, useCampaigns } from "../shell";
import { LoomProvider } from "../loom-ui";

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
  // The Rules panel and Jump anywhere work here too: they need the campaign around them.
  return c.campaignId ? (
    <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
      <Board c={c} />
    </LoomProvider>
  ) : (
    <Board c={c} />
  );
}

function Board({ c }: { c: ReturnType<typeof useCampaigns> }) {
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
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="person" size={12} />The innkeeper here</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-muted line-through decoration-muted/50"><Icon name="person" size={12} />The captain not here</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="item" size={12} />Kira: silver key</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-thread/40 bg-thread/10 px-2 py-0.5"><Icon name="die" size={12} />Curse of the key</span>
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
          <Field label="Drama">
            <Steps label="Drama" steps={TONES} value={p.tone} onChange={(v) => setPref("tone", v)} />
            <p className="mt-1 text-xs text-muted">How dramatic the wording is. The campaign&apos;s own tone (grim, comedic…) is on the campaign page.</p>
          </Field>
          <Field label="On each option">
            <Switch checked={p.why} onChange={(v) => setPref("why", v)} hint="The short line under an option saying why it fits now">
              Show why it fits
            </Switch>
          </Field>
        </Section>

        <Section title="Behind the scenes">
          <Field label="Costs and timings">
            <Switch checked={p.costs} onChange={(v) => setPref("costs", v)} hint="Which model answered, how long it took and what it cost, under each answer">
              Show costs and timings
            </Switch>
          </Field>
        </Section>

        <Section title="Surprises">
          <Field label="How often">
            <Choice
              label="Surprises"
              options={[
                { id: "off", label: "Off" },
                { id: "rare", label: "Rare" },
                { id: "sometimes", label: "Sometimes" },
                { id: "often", label: "Often" },
              ]}
              value={p.surprises}
              onChange={(v) => setPref("surprises", v as typeof p.surprises)}
            />
            <p className="mt-1 text-xs text-muted">Now and then, one option takes an unexpected turn the records can still explain, like a minor bond outweighing a goal. It&apos;s marked, with why.</p>
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
