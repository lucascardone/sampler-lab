// Actions on a list item (a sample, a recording): a "⋯" button that opens Renombrar /
// Borrar, plus the inline input used to rename. Shared by every list so they all work
// the same way.
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, IconButton, type IconName } from "./Icon";
import { Popover } from "./Popover";

/** An extra entry shown above Renombrar (Duplicar, Poner en la canción…). */
export interface MenuAction {
  icon: IconName;
  label: string;
  onClick: () => void;
}

interface MenuProps {
  /** Item name, for the button's accessible label. */
  name: string;
  onRename: () => void;
  onDelete: () => void;
  disabled?: boolean;
  actions?: MenuAction[];
  /** Borrar shown but greyed out (e.g. the last pattern can't go). */
  deleteDisabled?: boolean;
}

export function ItemMenu({ name, onRename, onDelete, disabled, actions = [], deleteDisabled }: MenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };

  return (
    // Clicks here never reach the row (which would open/select the item).
    <div className={`item-menu ${open ? "open" : ""}`} ref={ref} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <IconButton
        icon="more"
        tone="ghost"
        label={`${t("items.actions")}: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <Popover anchor={ref} onClose={close} align="end" role="menu" className="item-menu-pop">
          {actions.map((a, i) => (
            <button key={a.label} role="menuitem" autoFocus={i === 0} onClick={pick(a.onClick)}>
              <Icon name={a.icon} size={14} /> {a.label}
            </button>
          ))}
          <button role="menuitem" autoFocus={!actions.length} onClick={pick(onRename)}>
            <Icon name="pencil" size={14} /> {t("items.rename")}
          </button>
          <button role="menuitem" className="danger" disabled={deleteDisabled} onClick={pick(onDelete)}>
            <Icon name="trash" size={14} /> {t("items.delete")}
          </button>
        </Popover>
      )}
    </div>
  );
}

/**
 * Inline rename. Enter or clicking away saves, Escape cancels. `onDone` gets the new
 * name, or null when nothing changed / it was cancelled.
 */
export function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    const name = v?.trim();
    onDone(name && name !== value ? name : null);
  };
  return (
    <input
      autoFocus
      className="rename"
      value={draft}
      aria-label={t("items.newName")}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(draft);
        if (e.key === "Escape") finish(null);
        e.stopPropagation();
      }}
    />
  );
}
