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
