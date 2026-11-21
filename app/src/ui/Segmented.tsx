// A row of joined buttons for a short choice (2–4 options): every option is visible and
// one click away, instead of hidden in a <select>. Longer lists use Picker.
import type { ReactNode } from "react";

export interface SegOption<T> {
  value: T;
  label: ReactNode;
  /** Extra explanation (tooltip); the label must already make sense alone. */
  hint?: string;
}

interface Props<T> {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
  /** Stretch to the container's width (inspector rows). */
  block?: boolean;
}

export function Segmented<T extends string | number | boolean>({ value, options, onChange, label, className, block }: Props<T>) {
  return (
    <span className={`seg ${block ? "seg-block" : ""} ${className ?? ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={`toggle ${o.value === value ? "active" : ""}`}
          aria-pressed={o.value === value}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
