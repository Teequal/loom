"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// What both pages share: the campaign picker (remembered per browser, with "New campaign") and
// the switch between the table and between-session views.

export interface Campaign {
  id: number;
  name: string;
}

export const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

export async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
  return json as T;
}

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setId] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then(({ campaigns }: { campaigns: Campaign[] }) => {
        setCampaigns(campaigns);
        const saved = Number(store.get("loom.campaign"));
        setId(campaigns.some((c) => c.id === saved) ? saved : (campaigns[0]?.id ?? null));
      })
      .catch(() => setError("Couldn't load your campaigns. Is the database there?"));
  }, []);
  const select = (id: number) => {
    setId(id);
    store.set("loom.campaign", String(id));
  };
  const create = async (name: string) => {
    const { campaign } = await post<{ campaign: Campaign }>("/api/campaigns", { name });
    setCampaigns((cs) => [campaign, ...cs]);
    select(campaign.id);
  };
  return { campaigns, campaignId, select, create, error };
}

const NAV = [
  { href: "/", label: "At the table", short: "Table" },
  { href: "/prep", label: "Between sessions", short: "Prep" },
  { href: "/campaign", label: "Campaign", short: "Campaign" },
];

export function Header({ c }: { c: ReturnType<typeof useCampaigns> }) {
  const path = usePathname();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex items-center gap-5">
        <h1 className="text-lg font-semibold tracking-tight">
          Loom<span className="text-thread">.</span>
        </h1>
        <nav className="flex gap-1 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={path === n.href ? "page" : undefined}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 transition-colors ${path === n.href ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              <span className="sm:hidden">{n.short}</span>
              <span className="hidden sm:inline">{n.label}</span>
            </Link>
          ))}
        </nav>
      </div>
      {naming ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            try {
              await c.create(name.trim());
              setNaming(false);
              setName("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
            placeholder="Campaign name"
            aria-label="New campaign name"
            className="w-44 rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-thread/60"
          />
          <button disabled={busy || !name.trim()} className="rounded-md bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-30">
            Create
          </button>
        </form>
      ) : (
        <select
          aria-label="Campaign"
          className="max-w-[60%] truncate rounded-md border border-line bg-surface px-2 py-1 text-sm text-muted"
          value={c.campaignId ?? ""}
          onChange={(e) => (e.target.value === "new" ? setNaming(true) : c.select(Number(e.target.value)))}
        >
          {c.campaigns.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          <option value="new">+ New campaign…</option>
        </select>
      )}
    </header>
  );
}

export function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "danger" }) {
  return <p className={`mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] ${tone === "danger" ? "text-danger" : "text-muted"}`}>{children}</p>;
}

export function Chips({ threads }: { threads: { id: number; title: string }[] }) {
  if (!threads.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {threads.map((t) => (
        <span key={t.id} className="rounded-full bg-thread-soft px-2.5 py-0.5 text-xs text-thread">
          {t.title}
        </span>
      ))}
    </div>
  );
}

// Seconds since `running` became true: long model calls say how long they've been going.
export function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => {
      clearInterval(t);
      setSeconds(0);
    };
  }, [running]);
  return seconds;
}
