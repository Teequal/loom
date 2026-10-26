"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./icons";

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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
  return json as T;
}

/**
 * POSTs and reads a newline-JSON stream, calling onEvent for each line as it arrives. Resolves with
 * the closing {type:"done"} event; an {type:"error"} line throws its message.
 */
export async function stream<T = Record<string, unknown>>(url: string, body: unknown, onEvent: (e: { type: string } & Record<string, unknown>) => void, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: T | null = null;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") done = event as T;
      else onEvent(event);
    }
  }
  if (!done) throw new Error("Something went wrong.");
  return done;
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
        setId(
          campaigns.some((c) => c.id === saved)
            ? saved
            : (campaigns[0]?.id ?? null),
        );
      })
      .catch(() =>
        setError("Couldn't load your campaigns. Is the database there?"),
      );
  }, []);
  const select = (id: number) => {
    setId(id);
    store.set("loom.campaign", String(id));
  };
  const create = async (name: string) => {
    const { campaign } = await post<{ campaign: Campaign }>("/api/campaigns", {
      name,
    });
    setCampaigns((cs) => [campaign, ...cs]);
    select(campaign.id);
  };
  const sample = async () => {
    const { campaign } = await post<{ campaign: Campaign }>(
      "/api/campaigns/sample",
      {},
    );
    setCampaigns((cs) =>
      cs.some((c) => c.id === campaign.id) ? cs : [campaign, ...cs],
    );
    select(campaign.id);
  };
  return { campaigns, campaignId, select, create, sample, error };
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
              title={n.label}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 transition-colors ${path === n.href ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              {n.short}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("loom:rules", { detail: "" }))}
          className="btn-tertiary rounded-md border border-line px-2 py-1 text-[13px]"
          title="Rules questions (?)"
        >
          Rules
        </button>
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          aria-current={path === "/settings" ? "page" : undefined}
          className={`btn-tertiary rounded-md border border-line px-2 py-1 ${path === "/settings" ? "bg-surface text-foreground" : ""}`}
        >
          <Icon name="settings" />
        </Link>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("loom:search"))}
          className="btn-tertiary rounded-md border border-line px-2 py-1"
          aria-label="Jump to anything"
          title="Jump to anything (⌘K)"
        >
          <Icon name="search" />
          <kbd className="hidden font-sans text-[10px] md:inline">⌘K</kbd>
        </button>
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
            <button
              disabled={busy || !name.trim()}
              className="rounded-md bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-30"
            >
              Create
            </button>
          </form>
        ) : (
          <select
            aria-label="Campaign"
            className="quiet max-w-[11rem] truncate sm:max-w-[13rem] rounded-md border border-line bg-surface py-1 pl-2.5 text-sm text-muted outline-none hover:text-foreground focus:border-thread/60"
            value={c.campaignId ?? ""}
            onChange={(e) =>
              e.target.value === "new"
                ? setNaming(true)
                : c.select(Number(e.target.value))
            }
          >
            {c.campaigns.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="new">+ New campaign…</option>
          </select>
        )}
      </div>
    </header>
  );
}

// A change batch's label ("recap s3 2026-10-24 12:51 #e4") as a person would say it.
export function batchLabel(batch: string) {
  const m = batch.match(
    /^(recap|live|enrich|infer|settle)(?: s(\d+))? (?:(\d{4})-(\d\d)-(\d\d) )?(\d\d:\d\d)/,
  );
  if (!m) return batch;
  const [, kind, session, , month, day, time] = m;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const when = day
    ? `${Number(day)} ${months[Number(month) - 1]}, ${time}`
    : time;
  if (kind === "live") return `At the table, session ${session} · ${when}`;
  if (kind === "enrich") return `Details read from all notes · ${when}`;
  if (kind === "infer") return `Characters read from all notes · ${when}`;
  if (kind === "settle") return `Moods settled after session ${session} · ${when}`;
  return `Session ${session} notes · ${when}`;
}

export function Note({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <p
      className={`mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] ${tone === "danger" ? "text-danger" : "text-muted"}`}
    >
      {children}
    </p>
  );
}

// Seconds since `running` became true: long model calls say how long they've been going.
export function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const t = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => {
      clearInterval(t);
      setSeconds(0);
    };
  }, [running]);
  return seconds;
}
