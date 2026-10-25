// Loom's icons: one small set, drawn alike (16-unit grid, 1.5 stroke, round ends), so nothing on
// the page looks borrowed from a font.

const PATHS = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  pen: <path d="M10.5 3.5l2 2L6 12H4v-2l6.5-6.5zM9.5 4.5l2 2" />,
  branch: <path d="M4 3v5a3 3 0 003 3h5M10 8.5l2.5 2.5L10 13.5" />,
  star: <path d="M8 2.8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 11l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5L8 2.8z" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  callback: <path d="M5 5.5H10a3 3 0 010 6H6M7 3.5L5 5.5l2 2" />,
  diamond: <path d="M8 3l5 5-5 5-5-5 5-5z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  save: <path d="M8 3v7M5 7.5l3 3 3-3M3.5 12.5h9" />,
  undo: <path d="M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3 3 0 010 6H7" />,
  search: <path d="M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM10.5 10.5L13 13" />,
  arrow: <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" />,
  dot: <circle cx="8" cy="8" r="1.5" />,
  sparkle: <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.5 4.5l1.5 1.5M10 10l1.5 1.5M11.5 4.5L10 6M6 10l-1.5 1.5" />,
  // The scene chips: someone here, an item, someone reached from afar, a rule, a place.
  person: <path d="M8 7.5a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5zM3.5 13c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5" />,
  item: <path d="M3.5 6l4.5-2.5L12.5 6v4.5L8 13l-4.5-2.5V6zM3.5 6L8 8.5 12.5 6M8 8.5V13" />,
  signal: <path d="M8 12.5h.01M5.5 10a3.5 3.5 0 015 0M3.5 7.5a6.5 6.5 0 019 0" />,
  die: <path d="M4.5 3.5h7a1 1 0 011 1v7a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1zM6 6h.01M8 8h.01M10 10h.01" />,
  pin: <path d="M8 13.5s4-3.6 4-7a4 4 0 00-8 0c0 3.4 4 7 4 7zM8 7.5a1 1 0 100-2 1 1 0 000 2z" />,
  settings: <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, className = "", filled = false }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 align-[-0.15em] ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
