// Floating panel anchored to a button (the "⋯" item menu, the piano roll's Herramientas).
// It is portalled to <body> with fixed positioning so no scrolling pane (overflow: hidden/
// auto) can clip it and no sticky row or ruler (each its own stacking context) can paint
// over it. It opens below the anchor, flips above when there is more room there, stays
// inside the window, and follows the anchor when something scrolls. Clicking away or Esc
// closes it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** The element the panel hangs from (usually the wrapper of the toggle button). */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** "start": left edges line up; "end": right edges line up. */
  align?: "start" | "end";
  className?: string;
  role?: string;
  children: ReactNode;
}

const GAP = 4;
const MARGIN = 8;

export function Popover({ anchor, onClose, align = "start", className, role, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Measure after render (and on every scroll/resize) so the panel's real size is known.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.scrollHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const up = h > below && above > below;
      const maxHeight = Math.max(80, up ? above : below);
      const top = up ? Math.max(MARGIN, a.top - GAP - Math.min(h, maxHeight)) : a.bottom + GAP;
      const wanted = align === "end" ? a.right - w : a.left;
      const left = Math.min(Math.max(MARGIN, wanted), Math.max(MARGIN, vw - w - MARGIN));
      setPos((p) => (p && p.top === top && p.left === left && p.maxHeight === maxHeight ? p : { top, left, maxHeight }));
    };
    place();
    // Capture: a scroll inside any pane (timeline, library…) moves the anchor too.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      ro.disconnect();
    };
  }, [anchor, align]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't let an open dialog underneath also close.
      e.stopPropagation();
      onClose();
      anchor.current?.querySelector<HTMLElement>("button, summary")?.focus();
    };
    document.addEventListener("pointerdown", away);
    // Capture on window so it runs before Dialog's own Esc handler.
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role={role}
      className={`popover ${className ?? ""}`}
      // Transparent (not hidden, so autoFocus still works) until measured and placed.
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, opacity: 0 }}
    >
      {children}
    </div>,
    document.body,
  );
}
