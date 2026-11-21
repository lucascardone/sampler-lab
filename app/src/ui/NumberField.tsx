// A number input you can actually type in: the value is only committed (and clamped)
// on Enter/blur, so typing "9" on the way to "95" isn't rejected. Arrow keys step it.
import { useState, type InputHTMLAttributes } from "react";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "step"> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
}

export function NumberField({ value, min, max, step = 1, onCommit, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string | null) => {
    setDraft(null);
    if (text === null || text.trim() === "") return;
    const v = Number(text.replace(",", "."));
    if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, Math.round(v / step) * step)));
  };
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={draft ?? (Number.isFinite(value) && value !== 0 ? String(Math.round(value * 100) / 100) : (rest.placeholder ? "" : "0"))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation(); // typing digits/space here never triggers studio shortcuts
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = draft !== null && Number.isFinite(Number(draft)) ? Number(draft) : value;
          const next = Math.max(min, Math.min(max, base + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1)));
          setDraft(null);
          onCommit(Math.round(next / step) * step);
        }
      }}
    />
  );
}
