"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoomProvider, RefLink } from "../loom-ui";
import { Header, Note, post, useCampaigns } from "../shell";

// The campaign map: a blank canvas in miles where the GM drops and drags a pin for each place. With
// pins, Loom works out distances, so "nearby" means close on the map, and anyone further off is
// that many miles (and hours on foot) away. Places without a pin keep the old rule.

interface Place {
  id: number;
  name: string;
  parentId: number | null;
  x: number | null;
  y: number | null;
  kind: string;
  status: string | null;
}
interface MapData {
  party: number | null;
  places: Place[];
  people: { id: number; name: string; placeId: number }[];
}
type View = { cx: number; cy: number; span: number }; // the centre, and how many miles the canvas is across

export function MapView() {
  const c = useCampaigns();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-20 pt-8 sm:pt-14">
      <Header c={c} />
      {c.error && <Note tone="danger">{c.error}</Note>}
      {c.campaignId && (
        <LoomProvider key={c.campaignId} campaignId={c.campaignId}>
          <CampaignMap campaignId={c.campaignId} />
        </LoomProvider>
      )}
    </main>
  );
}

// The same words the engine uses (world/engine.ts farWords): about 3 miles an hour on foot.
function farWords(miles: number) {
  if (miles <= 0.5) return "close by";
  const hours = miles / 3;
  const days = Math.round((miles / 24) * 2) / 2;
  const time = hours < 1 ? `${Math.max(5, Math.round((hours * 60) / 5) * 5)} minutes` : hours < 8 ? `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}` : `${days} day${days > 1 ? "s" : ""}`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} miles, about ${time} on foot`;
}
const niceStep = (span: number) => {
  const raw = span / 8;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
};

function CampaignMap({ campaignId }: { campaignId: number }) {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [placing, setPlacing] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [moving, setMoving] = useState<{ id: number; x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 640, h: 420 });
  const ready = view != null;
  const drag = useRef<{ kind: "pan" | "pin"; id?: number; sx: number; sy: number; view: View; moved: boolean } | null>(null);

  const send = useCallback(
    (body: object = {}) =>
      post<MapData>("/api/map", { campaignId, ...body })
        .then((d) => {
          setData(d);
          setError("");
          return d;
        })
        .catch((e) => {
          setError(e.message);
          return null;
        }),
    [campaignId],
  );
  // Opens on the pins there are, or on an empty 50 miles.
  useEffect(() => {
    void send().then((d) => {
      if (!d) return;
      const pins = d.places.filter((p) => p.x != null && p.y != null);
      if (!pins.length) return setView({ cx: 0, cy: 0, span: 50 });
      const xs = pins.map((p) => p.x!);
      const ys = pins.map((p) => p.y!);
      const span = Math.max(4, (Math.max(...xs) - Math.min(...xs)) * 1.4, (Math.max(...ys) - Math.min(...ys)) * 1.4 * (640 / 420));
      setView({ cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, span });
    });
  }, [send]);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  const byId = useMemo(() => new Map((data?.places ?? []).map((p) => [p.id, p])), [data]);
  // A place's pin: its own, or the nearest pinned place it's inside (or where it's being dragged).
  const posOf = useCallback(
    (id: number | null): { x: number; y: number } | null => {
      for (let cur = id, hops = 0; cur != null && hops < 20; hops++) {
        if (moving?.id === cur) return moving;
        const p = byId.get(cur);
        if (!p) return null;
        if (p.x != null && p.y != null) return { x: p.x, y: p.y };
        cur = p.parentId;
      }
      return null;
    },
    [byId, moving],
  );

  // Zoom with the wheel, around the pointer.
  useEffect(() => {
    const el = svg.current;
    if (!el || !ready) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        if (!v) return v;
        const f = Math.exp(e.deltaY * 0.0015);
        const mx = v.cx + ((e.clientX - r.left - r.width / 2) / r.width) * v.span;
        const my = v.cy + ((e.clientY - r.top - r.height / 2) / r.width) * v.span;
        const span = Math.min(5000, Math.max(0.2, v.span * f));
        return { span, cx: mx - (mx - v.cx) * (span / v.span), cy: my - (my - v.cy) * (span / v.span) };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [ready]);

  if (!data || !view) return <p className="text-muted">{error || "Opening the map…"}</p>;
  const { w, h } = size;
  const toPx = (p: { x: number; y: number }) => ({ px: ((p.x - view.cx) / view.span) * w + w / 2, py: ((p.y - view.cy) / view.span) * w + h / 2 });
  const toMiles = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: view.cx + ((clientX - r.left - w / 2) / w) * view.span, y: view.cy + ((clientY - r.top - h / 2) / w) * view.span };
  };
  const step = niceStep(view.span);
  const lines: { x?: number; y?: number }[] = [];
  const left = view.cx - view.span / 2;
  const top = view.cy - ((h / w) * view.span) / 2;
  for (let x = Math.ceil(left / step) * step; x < left + view.span; x += step) lines.push({ x });
  for (let y = Math.ceil(top / step) * step; y < top + (h / w) * view.span; y += step) lines.push({ y });

  const pinned = data.places.filter((p) => p.x != null && p.y != null);
  const loose = data.places.filter((p) => p.x == null || p.y == null);
  const party = data.party;
  const sel = selected != null ? byId.get(selected) : null;
  const zoom = (f: number) => setView({ ...view, span: Math.min(5000, Math.max(0.2, view.span * f)) });

  const down = (e: React.PointerEvent, id?: number) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: id != null ? "pin" : "pan", id, sx: e.clientX, sy: e.clientY, view, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    if (!d.moved) return;
    if (d.kind === "pan") setView({ ...d.view, cx: d.view.cx - ((e.clientX - d.sx) / w) * d.view.span, cy: d.view.cy - ((e.clientY - d.sy) / w) * d.view.span });
    else setMoving({ id: d.id!, ...toMiles(e.clientX, e.clientY) });
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "pin") {
      if (d.moved && moving) void send({ pin: { placeId: d.id, x: moving.x, y: moving.y } }).then(() => setMoving(null));
      else setSelected(d.id!);
      return;
    }
    // A tap on the canvas drops the place you're placing.
    if (!d.moved && placing != null) {
      const at = toMiles(e.clientX, e.clientY);
      void send({ pin: { placeId: placing, ...at } });
      setSelected(placing);
      setPlacing(null);
    } else if (!d.moved) setSelected(null);
  };

  const distanceTo = (id: number) => {
    const a = posOf(id);
    const b = posOf(party);
    return a && b && id !== party ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  };
  const here = (id: number) => data.people.filter((p) => p.placeId === id || byId.get(p.placeId)?.parentId === id);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">Map</h2>
        <p className="text-[13px] text-muted">In miles. Drag to move around, scroll or use − + to zoom. Drag a pin to move it.</p>
      </div>
      {error && <Note tone="danger">{error}</Note>}
      {placing != null && (
        <p className="mb-2 rounded-lg border border-thread/60 bg-thread-soft/40 px-3 py-1.5 text-[13px]">
          Tap the map where <span className="font-medium">{byId.get(placing)?.name}</span> is. <button type="button" className="btn-tertiary ml-1 text-xs" onClick={() => setPlacing(null)}>Cancel</button>
        </p>
      )}
      <div className="relative overflow-hidden rounded-xl border border-line bg-surface">
        <svg
          ref={svg}
          role="application"
          aria-label="Campaign map"
          className={`block h-[60vh] min-h-[340px] w-full select-none ${placing != null ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
          style={{ touchAction: "none" }}
          onPointerDown={(e) => down(e)}
          onPointerMove={move}
          onPointerUp={up}
        >
          {lines.map((l, i) =>
            l.x != null ? (
              <line key={`x${i}`} x1={toPx({ x: l.x, y: 0 }).px} x2={toPx({ x: l.x, y: 0 }).px} y1={0} y2={h} className="stroke-line" strokeWidth={1} />
            ) : (
              <line key={`y${i}`} y1={toPx({ x: 0, y: l.y! }).py} y2={toPx({ x: 0, y: l.y! }).py} x1={0} x2={w} className="stroke-line" strokeWidth={1} />
            ),
          )}
          {/* What's close enough to walk in on the party: half a mile around it. */}
          {posOf(party) && <circle cx={toPx(posOf(party)!).px} cy={toPx(posOf(party)!).py} r={Math.max(4, (0.5 / view.span) * w)} className="fill-thread/10 stroke-thread/40" strokeDasharray="3 3" />}
          {pinned.map((p) => {
            const at = toPx(posOf(p.id)!);
            const isParty = p.id === party;
            const isSel = p.id === selected;
            return (
              <g key={p.id} transform={`translate(${at.px} ${at.py})`} onPointerDown={(e) => down(e, p.id)} className="cursor-pointer">
                <circle r={14} fill="transparent" />
                {isParty && <circle r={10} className="fill-none stroke-thread" strokeWidth={2} />}
                <circle r={isSel ? 6 : 5} className={isSel ? "fill-thread" : "fill-foreground/70"} />
                <text x={10} y={4} className={`fill-foreground text-[12px] ${isSel ? "font-semibold" : ""}`} style={{ paintOrder: "stroke" }} stroke="var(--surface)" strokeWidth={3}>
                  {p.name}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="absolute bottom-2 right-2 flex gap-1">
          <button type="button" onClick={() => zoom(1 / 1.5)} className="btn-secondary h-7 w-7 text-sm" aria-label="Zoom in">+</button>
          <button type="button" onClick={() => zoom(1.5)} className="btn-secondary h-7 w-7 text-sm" aria-label="Zoom out">−</button>
        </div>
        <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted">grid: {step} mile{step === 1 ? "" : "s"}</p>
      </div>

      {sel && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium">
              <RefLink r={{ kind: "entity", id: sel.id, name: sel.name, sub: "Place" }} />
              {sel.kind && <span className="ml-2 text-xs text-muted">{sel.kind}</span>}
            </p>
            {sel.x != null && (
              <button type="button" className="btn-tertiary text-xs" onClick={() => void send({ pin: { placeId: sel.id, x: null, y: null } })}>
                Take it off the map
              </button>
            )}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {sel.id === party ? "The party is here." : distanceTo(sel.id) != null ? `From the party: ${farWords(distanceTo(sel.id)!)}.` : posOf(party) ? "" : "Pin the party's place to see how far it is."}
            {sel.x == null && sel.parentId != null && posOf(sel.id) ? ` Shares the pin of ${byId.get(sel.parentId)?.name}.` : ""}
          </p>
          {here(sel.id).length > 0 && <p className="mt-1 text-[13px]"><span className="text-muted">Recorded here:</span> {here(sel.id).map((p) => p.name).join(", ")}</p>}
        </div>
      )}

      {loose.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Not on the map yet</h3>
          <p className="mb-2 text-[13px] text-muted">Pick one, then tap the map where it is. A place inside a pinned one shares its pin until you give it its own.</p>
          <ul className="flex flex-wrap gap-1.5">
            {loose.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={placing === p.id}
                  onClick={() => setPlacing(placing === p.id ? null : p.id)}
                  className={`rounded-full px-2.5 py-0.5 text-[13px] ${placing === p.id ? "bg-foreground text-background" : "border border-line text-foreground/80 hover:border-thread/60"}`}
                  title={p.parentId != null && posOf(p.id) ? `Inside ${byId.get(p.parentId)?.name}` : undefined}
                >
                  {p.name}
                  {p.id === party ? " (the party)" : ""}
                  {p.parentId != null && posOf(p.id) ? <span className="text-muted"> · in {byId.get(p.parentId)?.name}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!data.places.length && <p className="mt-4 text-muted">No places in this campaign yet. They come in from your notes, or add one in the inspector.</p>}
    </section>
  );
}
