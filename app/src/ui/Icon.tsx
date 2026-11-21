// Small SVG icon set (24×24, drawn with the current text color), so icons render the
// same everywhere instead of depending on emoji fonts. Plus an accessible icon button.
import type { ButtonHTMLAttributes, ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  piano: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M12 5v14M16 5v14" />
      <path d="M6.5 5h3v8h-3zM14.5 5h3v8h-3z" fill="currentColor" />
    </>
  ),
  steps: <path d="M4 5h4v4H4zM10 5h4v4h-4zM16 5h4v4h-4zM4 15h4v4H4zM16 15h4v4h-4z" />,
  sliders: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  metronome: <path d="M9 3h6l3.5 18h-13zM12 15l5-8M7 17h10" />,
  volume: <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  note: (
    <>
      <path d="M9 18V5.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.6M12 16.9v.2" />
    </>
  ),
  glide: (
    <>
      <path d="M3 17h4c4 0 5-10 10-10h4" />
      <circle cx="7" cy="17" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  wave: <path d="M2 12c2.5-7 5-7 7.5 0s5 7 7.5 0 3.5-5 5-3" />,
  drum: (
    <>
      <ellipse cx="12" cy="8" rx="8" ry="3" />
      <path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
  eraser: <path d="m15 4 5 5-9.5 9.5H6L3.5 16zM11 8l5 5M10 20h10" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  collapse: <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />,
  search: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  layers: <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5" />,
  toSong: (
    <>
      <rect x="3" y="6" width="11" height="5" rx="1" />
      <rect x="3" y="14" width="7" height="5" rx="1" />
      <path d="M18 12v8M14 16h8" />
    </>
  ),
  warning: <path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5v.5" />,
  midi: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h.01M10 9h.01M14 9h.01M16 12h.01M12 15v2" />
    </>
  ),
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth={3} />,
  scissors: (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <path d="M8 8.5 20 18M8 15.5 20 6" />
    </>
  ),
  fadeIn: <path d="M3 19 15 6h6M3 19h18" />,
  fadeOut: <path d="M3 6h6l12 13M3 19h18" />,
  normalize: <path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4M4 12h3M17 12h3" />,
  reverse: <path d="M4 8h14l-3-3M20 16H6l3 3" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>
  ),
  split: <path d="M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4M7 12h2M15 12h2" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  people: <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  /** A window with its left panel: show / hide the side panel. */
  panel: <path d="M4 5h16v14H4zM9.5 5v14" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon-svg ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Accessible name and tooltip (required: an icon alone isn't a label). */
  label: string;
  active?: boolean;
  tone?: "default" | "danger" | "ghost";
}

export function IconButton({ icon, label, active, tone = "default", className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`icon-btn ${tone} ${active ? "active" : ""} ${className ?? ""}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}
