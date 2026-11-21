// Long choices without a <select>: a button that shows the current value and opens a
// floating panel (Popover) with every option as a big labelled button, optionally with a
// one-line description and a colour swatch, grouped under headings. Picking closes it.
// `Dropdown` is the bare button + panel, for panels with custom content (piano-roll
// menus, the note/key picker).
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Popover } from "./Popover";

interface DropdownProps {
  /** What the button says (current value, or the menu's name). */
  display: ReactNode;
  /** Small text before the value, inside the button ("Largo", "Tonalidad"). */
  prefix?: ReactNode;
  icon?: IconName;
  /** Accessible name + tooltip of the button. */
  label: string;
  /** Panel heading (optional). */
  title?: ReactNode;
  className?: string;
  panelClass?: string;
  align?: "start" | "end";
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}

export function Dropdown({ display, prefix, icon, label, title, className, panelClass, align, disabled, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className={`menu ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className={`menu-btn picker-btn ${open ? "open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon} />}
        {prefix && <span className="picker-prefix">{prefix}</span>}
        <span className="picker-value">{display}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <Popover anchor={ref} onClose={close} align={align} className={`menu-panel ${panelClass ?? ""}`} role="dialog">
          {title && <div className="picker-title">{title}</div>}
          {children(close)}
        </Popover>
      )}
    </div>
  );
}

export interface PickerOption<T> {
  value: T;
  label: string;
  desc?: string;
  /** CSS colour for a small swatch (patterns, channels). */
  color?: string;
}

export interface PickerGroup<T> {
  title?: string;
  options: PickerOption<T>[];
}

interface PickerProps<T> extends Omit<DropdownProps, "children" | "display"> {
  value: T | null;
  groups: PickerGroup<T>[];
  onPick: (v: T) => void;
  /** Button text when nothing is picked (or to override the picked label). */
  display?: ReactNode;
  /** Options per row in the panel. */
  columns?: 1 | 2 | 3 | 4;
  /** Extra content under the options (e.g. "Guardar como preset"). */
  footer?: (close: () => void) => ReactNode;
}

export function Picker<T extends string | number>({ value, groups, onPick, display, columns = 2, footer, ...rest }: PickerProps<T>) {
  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);
  return (
    <Dropdown
      {...rest}
      panelClass={`picker-panel cols-${columns} ${rest.panelClass ?? ""}`}
      display={
        display ?? (
          <>
            {current?.color && <i className="picker-swatch" style={{ background: current.color }} />}
            {current?.label ?? ""}
          </>
        )
      }
    >
      {(close) => (
        <>
          {groups.map((g, gi) => (
            <div key={gi} className="picker-group">
              {g.title && <span className="picker-group-title">{g.title}</span>}
              <div className="picker-grid">
                {g.options.map((o) => (
                  <button
                    key={String(o.value)}
                    type="button"
                    className={`picker-opt ${o.value === value ? "active" : ""}`}
                    aria-pressed={o.value === value}
                    onClick={() => {
                      onPick(o.value);
                      close();
                    }}
                  >
                    <strong>
                      {o.color && <i className="picker-swatch" style={{ background: o.color }} />}
                      {o.label}
                    </strong>
                    {o.desc && <span className="picker-desc">{o.desc}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {footer?.(close)}
        </>
      )}
    </Dropdown>
  );
}
