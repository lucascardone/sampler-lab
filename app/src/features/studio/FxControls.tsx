// Inspector → Efectos: a preset picker, the basics (always visible) and "Más efectos"
// (distortion, filter + movement, modulation, width, ducking), collapsed by default.
// Each advanced block shows only its type select until it's turned on.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { padColor } from "./colors";
import { applyPreset, BUILTIN_PRESETS, makeUserPreset, parseUserPresets, type FxPreset } from "./fxPresets";
import {
  DRIVE_TYPES,
  FILTER_TYPES,
  MOD_TYPES,
  MOVE_RATES,
  moreFxActive,
  type Channel,
  type ChannelFx,
  type Song,
} from "./song";
import { Slider } from "../../ui/Slider";
import { Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";

const pct = (v: number) => `${Math.round(v * 100)}%`;

// User presets, shared by every inspector instance and loaded once.
let userCache: FxPreset[] | null = null;
const listeners = new Set<(p: FxPreset[]) => void>();
function useUserPresets(onError: (e: unknown) => void) {
  const [list, setList] = useState<FxPreset[]>(userCache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!userCache)
      api
        .fxPresetsLoad()
        .then((raw) => {
          userCache = parseUserPresets(raw);
          listeners.forEach((l) => l(userCache!));
        })
        .catch(() => {});
    return () => void listeners.delete(setList);
  }, []);
  const save = (next: FxPreset[]) => {
    userCache = next;
    listeners.forEach((l) => l(next));
    api.fxPresetsSave(next).catch(onError);
  };
  return [list, save] as const;
}

/** "Más efectos" open or closed, remembered while the app is open. */
let moreOpen = false;


function Pick<T extends string | number>({
  label,
  value,
  options,
  name,
  hint,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  name: (v: T) => string;
  hint?: string;
  onChange: (v: T) => void;
}) {
  const opts = options.map((o) => ({ value: o, label: name(o), hint }));
  return (
    <div className="field-stack" title={hint}>
      <span className="field-label">{label}</span>
      {/* Buttons only when they fit the inspector's width; otherwise a picker. */}
      {options.length <= 4 && opts.reduce((n, o) => n + o.label.length, 0) <= 22 ? (
        <Segmented block label={label} value={value} options={opts} onChange={onChange} />
      ) : (
        <Picker className="block" label={hint ?? label} title={label} value={value} columns={1} groups={[{ options: opts }]} onPick={onChange} />
      )}
    </div>
  );
}

function Block({ children, on }: { children: ReactNode; on: boolean }) {
  return <div className={`fx-block ${on ? "on" : ""}`}>{children}</div>;
}

interface Props {
  song: Song;
  ch: Channel;
  /** Change some effects (`key` merges quick slider moves into one undo step). */
  fx: (patch: Partial<ChannelFx>, key: string) => void;
  onError: (e: unknown) => void;
}

/** Preset picker + "Guardar como preset". */
export function FxPresetPicker({ song, ch, fx, onError }: Props) {
  const { t } = useTranslation();
  const [users, saveUsers] = useUserPresets(onError);
  const [naming, setNaming] = useState<string | null>(null);
  const [last, setLast] = useState<FxPreset | null>(null);
  useEffect(() => setLast(null), [ch.id]);
  const all = [...BUILTIN_PRESETS, ...users];
  const label = (p: FxPreset) => (p.builtIn ? t(`fx.presets.${p.name}`) : p.name);

  const pick = (id: string) => {
    const p = all.find((x) => x.id === id);
    if (!p) return;
    fx(applyPreset(p, ch, song), `preset-${Date.now()}`);
    setLast(p);
  };

  const save = () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    const preset = makeUserPreset(name, ch.fx);
    saveUsers([...users.filter((u) => u.name.toLowerCase() !== name.toLowerCase()), preset]);
    setLast(preset);
    setNaming(null);
  };

  return (
    <div className="fx-presets">
      <div className="field-stack" title={t("fx.presetHint")}>
        <span className="field-label">{t("fx.preset")}</span>
        <Picker
          className="block"
          icon="sparkle"
          label={t("fx.presetHint")}
          title={t("fx.presetTitle")}
          value={last?.id ?? null}
          display={last ? label(last) : t("fx.presetPick")}
          columns={2}
          groups={[
            { title: t("fx.presetsBuiltIn"), options: BUILTIN_PRESETS.map((p) => ({ value: p.id, label: label(p), desc: t(`fx.presetDesc.${p.name}`, { defaultValue: "" }) || undefined })) },
            ...(users.length ? [{ title: t("fx.presetsMine"), options: users.map((p) => ({ value: p.id, label: p.name })) }] : []),
          ]}
          onPick={pick}
        />
      </div>
      {naming !== null ? (
        <div className="insp-row fx-save">
          <input
            autoFocus
            value={naming}
            placeholder={t("fx.presetName")}
            aria-label={t("fx.presetName")}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setNaming(null);
              e.stopPropagation();
            }}
          />
          <button className="primary" onClick={save}>
            {t("fx.presetSave")}
          </button>
          <button onClick={() => setNaming(null)}>{t("items.cancel")}</button>
        </div>
      ) : (
        <div className="insp-row fx-save">
          <button className="link" onClick={() => setNaming("")}>
            {t("fx.presetSaveAs")}
          </button>
          {last && !last.builtIn && (
            <button
              className="link danger"
              onClick={() => {
                saveUsers(users.filter((u) => u.id !== last.id));
                setLast(null);
              }}
            >
              {t("fx.presetDelete", { name: last.name })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The collapsible advanced effects. */
export function MoreFx({ song, ch, fx }: Omit<Props, "onError">) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(moreOpen);
  const f = ch.fx;
  const others = song.channels.filter((c) => c.id !== ch.id);
  const active = moreFxActive(f);

  return (
    <details
      className="insp-more"
      open={open}
      onToggle={(e) => {
        const el = e.target as HTMLDetailsElement;
        moreOpen = el.open;
        setOpen(moreOpen);
        // It opens at the bottom of the inspector: bring it into view.
        if (el.open) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      }}
    >
      <summary>
        {t("fx.more")}
        {active && <i className="fx-dot" title={t("fx.moreActive")} />}
      </summary>

      <Block on={f.drive !== "off"}>
        <Pick label={t("fx.drive")} value={f.drive} options={DRIVE_TYPES} name={(v) => t(`fx.driveTypes.${v}`)} hint={t("fx.driveHint")} onChange={(v) => fx({ drive: v }, "drive")} />
        {f.drive !== "off" && (
          <Slider label={t("fx.amount")} value={f.driveAmount} min={0} max={1} step={0.01} reset={0.5} format={pct} onChange={(v) => fx({ driveAmount: v }, "driveAmt")} />
        )}
      </Block>

      <Block on={f.filter !== "off"}>
        <Pick label={t("fx.filter")} value={f.filter} options={FILTER_TYPES} name={(v) => t(`fx.filterTypes.${v}`)} hint={t("fx.filterHint")} onChange={(v) => fx({ filter: v }, "filter")} />
        {f.filter !== "off" && (
          <>
            <Slider label={t("fx.cutoff")} value={f.cutoff} min={0} max={1} step={0.005} reset={0.6} format={pct} hint={t("fx.cutoffHint")} onChange={(v) => fx({ cutoff: v }, "cutoff")} />
            <Slider label={t("fx.resonance")} value={f.resonance} min={0} max={1} step={0.01} reset={0.2} format={pct} hint={t("fx.resonanceHint")} onChange={(v) => fx({ resonance: v }, "res")} />
            <Slider label={t("fx.move")} value={f.move} min={0} max={1} step={0.01} reset={0} format={pct} hint={t("fx.moveHint")} onChange={(v) => fx({ move: v }, "move")} />
            {f.move > 0 && (
              <Pick label={t("fx.moveRate")} value={f.moveRate} options={MOVE_RATES} name={(v) => t(`fx.rates.${v}`)} onChange={(v) => fx({ moveRate: v }, "moveRate")} />
            )}
          </>
        )}
      </Block>

      <Block on={f.mod !== "off"}>
        <Pick label={t("fx.mod")} value={f.mod} options={MOD_TYPES} name={(v) => t(`fx.modTypes.${v}`)} hint={t("fx.modHint")} onChange={(v) => fx({ mod: v }, "mod")} />
        {f.mod !== "off" && (
          <Slider label={t("fx.amount")} value={f.modAmount} min={0} max={1} step={0.01} reset={0.5} format={pct} onChange={(v) => fx({ modAmount: v }, "modAmt")} />
        )}
      </Block>

      <Block on={f.width !== 1}>
        <Slider
          label={t("fx.width")}
          value={f.width}
          min={0}
          max={2}
          step={0.05}
          reset={1}
          hint={t("fx.widthHint")}
          format={(v) => (v === 0 ? t("fx.mono") : v === 1 ? t("fx.normal") : pct(v))}
          onChange={(v) => fx({ width: Math.abs(v - 1) < 0.03 ? 1 : v }, "width")}
        />
      </Block>

      <Block on={f.duckBy !== null}>
        <div className="field-stack" title={t("fx.duckHint")}>
          <span className="field-label">{t("fx.duck")}</span>
          <Picker
            className="block"
            label={t("fx.duckHint")}
            title={t("fx.duck")}
            value={f.duckBy ?? ""}
            columns={2}
            groups={[
              {
                options: [
                  { value: "", label: t("fx.duckOff") },
                  ...others.map((c) => ({ value: c.id, label: t("fx.duckWith", { name: c.name }), color: padColor(c.id) })),
                ],
              },
            ]}
            onPick={(v) => fx({ duckBy: v || null }, "duckBy")}
          />
        </div>
        {f.duckBy !== null && (
          <>
            <Slider label={t("fx.amount")} value={f.duckAmount} min={0} max={1} step={0.01} reset={0.6} format={pct} onChange={(v) => fx({ duckAmount: v }, "duckAmt")} />
            <p className="insp-note muted" style={{ "--ch": padColor(f.duckBy) } as React.CSSProperties}>
              {t("fx.duckNote")}
            </p>
          </>
        )}
      </Block>
    </details>
  );
}
