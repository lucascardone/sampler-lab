// The sample's effect chain: each effect can be switched on/off, moved, or removed.
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { IconButton } from "../../ui/Icon";
import type { Effect, FrameRange, SampleInfo } from "../../lib/api";
import { formatTime } from "../../lib/format";

interface Props {
  sample: SampleInfo;
  disabled: boolean;
  onToggle: (effectId: string, enabled: boolean) => void;
  onRemove: (effectId: string) => void;
  onMove: (effectId: string, delta: number) => void;
}

function describe(e: Effect, sr: number, t: TFunction): { name: string; detail: string } {
  const range = (r: FrameRange | null) =>
    r ? `${formatTime(r.start / sr)} → ${formatTime(r.end / sr)}` : t("effects.wholeSample");
  const op = e.op;
  switch (op.type) {
    case "gain":
      return { name: t("history.gain"), detail: `${op.db > 0 ? "+" : ""}${op.db} dB · ${range(op.range)}` };
    case "normalize":
      return { name: t("history.normalize"), detail: `${op.peak_db} dB · ${range(op.range)}` };
    case "trim":
      return { name: t("history.trim"), detail: range(op.range) };
    case "fadeIn":
      return { name: t("history.fadeIn"), detail: range(op.range) };
    case "fadeOut":
      return { name: t("history.fadeOut"), detail: range(op.range) };
    case "reverse":
      return { name: t("history.reverse"), detail: range(op.range) };
  }
}

export function EffectsList({ sample, disabled, onToggle, onRemove, onMove }: Props) {
  const { t } = useTranslation();
  const fx = sample.effects;

  return (
    <aside className="effects">
      <h3>{t("effects.title")}</h3>
      {fx.length === 0 ? (
        <p className="muted small">{t("effects.empty")}</p>
      ) : (
        <ol>
          {fx.map((e, i) => {
            const d = describe(e, sample.sampleRate, t);
            return (
              <li key={e.id} className={e.enabled ? "" : "off"}>
                <label className="fx-toggle" title={t("effects.toggleHint")}>
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    disabled={disabled}
                    onChange={(ev) => onToggle(e.id, ev.target.checked)}
                  />
                  <span className="fx-text">
                    <span className="fx-name">{d.name}</span>
                    <span className="fx-detail">{d.detail}</span>
                  </span>
                </label>
                <span className="fx-actions">
                  <IconButton icon="arrowUp" tone="ghost" label={t("effects.up")} disabled={disabled || i === 0} onClick={() => onMove(e.id, -1)} />
                  <IconButton icon="arrowDown" tone="ghost" label={t("effects.down")} disabled={disabled || i === fx.length - 1} onClick={() => onMove(e.id, 1)} />
                  <IconButton icon="x" tone="ghost" className="danger" label={t("effects.remove")} disabled={disabled} onClick={() => onRemove(e.id)} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {fx.length > 1 && <p className="muted small">{t("effects.orderHint")}</p>}
    </aside>
  );
}
