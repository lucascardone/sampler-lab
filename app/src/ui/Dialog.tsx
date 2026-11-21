// Minimal modal dialog: Esc or the backdrop closes it, focus moves inside on open and
// returns to where it was on close. Rendered into <body> so it always covers the app.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel: string;
}

export function Dialog({ title, onClose, children, closeLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Focus the main action if the dialog marks one, else the first control.
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("button, select, input"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      // An open menu inside the dialog takes the Esc first (see Popover).
      if (e.key === "Escape" && !document.querySelector("body > .popover")) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [onClose]);
  // Portalled to <body> so no sticky/scrolling ancestor can trap it under other panels.
  return createPortal(
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <IconButton icon="x" label={closeLabel} tone="ghost" onClick={onClose} />
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
