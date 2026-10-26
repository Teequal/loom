"use client";

// Loom's "working on it": a few warp threads, with weft drawn across them row by row and a shuttle
// running back and forth. Used wherever Loom is writing something, instead of a spinner.
export function Weaving({ label, className = "" }: { label?: React.ReactNode; className?: string }) {
  const warps = Array.from({ length: 9 }, (_, i) => 4 + i * 7);
  // Each weft row passes over and under the warps, so it reads as woven, not ruled.
  const row = (y: number, flip: boolean) => warps.map((x, i) => `${i ? "L" : "M"}${x} ${y + ((i % 2 === 0) !== flip ? -1.2 : 1.2)}`).join(" ");
  return (
    <span className={`weave inline-flex items-center gap-2 ${className}`} role="status">
      <svg width="64" height="20" viewBox="0 0 64 20" aria-hidden="true" fill="none">
        {warps.map((x) => (
          <line key={x} className="warp" x1={x} y1="1.5" x2={x} y2="18.5" strokeWidth="1" />
        ))}
        <path className="weft" d={row(6, false)} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path className="weft" d={row(10, true)} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path className="weft" d={row(14, false)} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect className="shuttle" x="1" y="18.5" width="9" height="1.5" rx="0.75" />
      </svg>
      {label && <span className="text-[13px] text-muted">{label}</span>}
    </span>
  );
}
