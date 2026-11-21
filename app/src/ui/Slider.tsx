// Labelled range slider with its value and a visible "back to normal" button.
//
// The reset button only shows when the value differs from `reset` (its space is kept so
// the row doesn't jump). Double-click on the slider still resets too, as an extra.
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Icon";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** The normal value: shows a reset button when the slider is elsewhere. */
  reset?: number;
  format: (v: number) => string;
  hint?: string;
}

export function Slider({ label, value, min, max, step, onChange, reset, format, hint }: SliderProps) {
  const { t } = useTranslation();
  const id = useId();
  const changed = reset !== undefined && Math.abs(value - reset) > step / 2;
  return (
    <div className="field slider" title={hint}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => reset !== undefined && onChange(reset)}
      />
      <output htmlFor={id}>{format(value)}</output>
      {changed ? (
        <IconButton
          icon="undo"
          tone="ghost"
          className="slider-reset"
          label={t("ui.resetTo", { name: label, value: format(reset) })}
          onClick={() => onChange(reset)}
        />
      ) : (
        <span className="slider-reset" aria-hidden />
      )}
    </div>
  );
}
