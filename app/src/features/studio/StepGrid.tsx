// The step sequencer (channel rack): one compact row per channel — name, mute, solo,
// volume (in this pattern) — and one cell per 16th note. Everything else about a channel lives in the
// inspector (select the channel by clicking its name).
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import type { SoundStatus } from "./engine";
import { padColor } from "./colors";
import {
  DEFAULT_MIX,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  channelNotes,
  fxActive,
  setMix,
  setStep,
  stepVelocity,
  updateChannel,
  type Channel,
  type Pattern,
  type Song,
} from "./song";
import type { SongStore } from "./useSong";

/** Right-click cycles through these intensities. */
const VELOCITIES = [1, 0.7, 0.4];
const CELL = 22;
const GAP = 3;
const BAR_GAP = 6;

interface Props {
  song: Song;
  pattern: Pattern;
  /** Step of this pattern that's sounding, or null. */
  playStep: number | null;
  update: SongStore["update"];
  status: (ch: Channel) => SoundStatus;
  selectedId: string | null;
  /** Click on a channel name: select it (inspector) and hear it. */
  onSelect: (ch: Channel) => void;
  onOpenRoll: (ch: Channel) => void;
  /** "Tocar juntos": people touching each channel right now (colored dots). */
  marks?: Record<string, { color: string; name: string }[]>;
  /** "Tocar juntos": channels this PC doesn't hear (a friend's part, silenced here). */
  hushed?: Set<string>;
}

/** Width of the steps area, so a channel's mini piano roll lines up with the steps. */
const stepsWidth = (steps: number) => steps * (CELL + GAP) - GAP + Math.max(0, steps / STEPS_PER_BAR - 1) * BAR_GAP;

export function StepGrid({ song, pattern, playStep, update, status, selectedId, onSelect, onOpenRoll, marks, hushed }: Props) {
  const { t } = useTranslation();
  // Paint stroke: the value being painted, applied to every cell the pointer enters.
  const stroke = useRef<{ value: number; key: string } | null>(null);
  const strokes = useRef(0);
  useEffect(() => {
    const end = () => (stroke.current = null);
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  const paint = (ch: string, step: number, value: number, key: string) =>
    update((s) => setStep(s, pattern.id, ch, step, value), key);

  const onDown = (e: React.PointerEvent, ch: string, step: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const value = stepVelocity(pattern, ch, step) > 0 ? 0 : 1;
    stroke.current = { value, key: `paint-${++strokes.current}` };
    paint(ch, step, value, stroke.current.key);
  };
  const onEnter = (ch: string, step: number) => {
    const s = stroke.current;
    if (s && stepVelocity(pattern, ch, step) !== s.value) paint(ch, step, s.value, s.key);
  };
  const onContext = (e: React.MouseEvent, ch: string, step: number) => {
    e.preventDefault();
    const v = stepVelocity(pattern, ch, step);
    const i = VELOCITIES.findIndex((x) => Math.abs(x - v) < 0.01);
    paint(ch, step, v === 0 ? VELOCITIES[0] : VELOCITIES[(i + 1) % VELOCITIES.length], `vel-${ch}-${step}-${Date.now()}`);
  };

  const steps = Array.from({ length: pattern.steps }, (_, i) => i);
  const cellClass = (i: number) =>
    [
      "step",
      Math.floor(i / STEPS_PER_BEAT) % 2 ? "odd-beat" : "",
      i % STEPS_PER_BAR === 0 && i > 0 ? "bar-start" : "",
      playStep === i ? "now" : "",
    ].join(" ");

  return (
    <div className="step-grid" role="grid" aria-label={t("studio.channels")}>
      <div className="grid-row ruler" aria-hidden="true">
        <div className="ch-info" />
        <div className="steps">
          {steps.map((i) => (
            <span key={i} className={cellClass(i) + " ruler-cell"}>
              {i % STEPS_PER_BAR === 0 ? <b>{i / STEPS_PER_BAR + 1}</b> : i % STEPS_PER_BEAT === 0 ? (i % STEPS_PER_BAR) / STEPS_PER_BEAT + 1 : ""}
            </span>
          ))}
        </div>
      </div>
      {song.channels.length === 0 && <p className="empty-hint">{t("studio.noChannels")}</p>}
      {song.channels.map((ch) => {
        const st = status(ch);
        const notes = channelNotes(pattern, ch.id).length > 0;
        const set = (patch: Partial<Channel>, key?: string) => update((s) => updateChannel(s, ch.id, patch), key);
        // Volume and effects belong to this pattern.
        const mix = pattern.mix[ch.id] ?? DEFAULT_MIX;
        const setVolume = (volume: number, key?: string) => update((s) => setMix(s, pattern.id, ch.id, { volume }), key);
        return (
          <div
            key={ch.id}
            role="row"
            className={`grid-row ${ch.mute ? "muted-ch" : ""} ${hushed?.has(ch.id) ? "hushed-ch" : ""} ${selectedId === ch.id ? "selected" : ""}`}
            style={{ "--ch": padColor(ch.id) } as React.CSSProperties}
          >
            <div className="ch-info">
              <span
                className={`ch-status ${st.state}`}
                title={st.state === "error" ? t("studio.missing", { error: st.message }) : st.state === "loading" ? t("studio.loading") : undefined}
              >
                {st.state === "error" ? (
                  <Icon name="warning" size={14} />
                ) : (
                  <Icon name={ch.sound.kind === "builtin" ? "drum" : ch.sound.kind === "synth" ? "wave" : "note"} size={14} />
                )}
              </span>
              <button className="ch-name" title={t("studio.selectHint")} onClick={() => onSelect(ch)}>
                <span>{ch.name}</span>
                {marks?.[ch.id]?.map((m) => (
                  <span key={m.name} className="jam-dot" style={{ background: m.color }} title={t("jam.touching", { name: m.name })} aria-label={t("jam.touching", { name: m.name })} />
                ))}
                {fxActive(mix.fx) && <i className="fx-dot" title={t("studio.hasFx")} />}
                {hushed?.has(ch.id) && <small className="hush-tag">{t("jam.hushedTag")}</small>}
              </button>
              <button
                className={`ms ${ch.mute ? "active" : ""}`}
                aria-pressed={ch.mute}
                aria-label={`${t("studio.mute")} ${ch.name}`}
                title={t("studio.mute")}
                onClick={() => set({ mute: !ch.mute })}
              >
                M
              </button>
              <button
                className={`ms solo ${ch.solo ? "active" : ""}`}
                aria-pressed={ch.solo}
                aria-label={`${t("studio.solo")} ${ch.name}`}
                title={t("studio.solo")}
                onClick={() => set({ solo: !ch.solo })}
              >
                S
              </button>
              <input
                className="ch-vol"
                type="range"
                min={0}
                max={1.25}
                step={0.01}
                value={mix.volume}
                aria-label={`${t("studio.volume")} ${ch.name}`}
                title={`${t("studio.volume")}: ${Math.round(mix.volume * 100)}%`}
                onChange={(e) => setVolume(Number(e.target.value), `vol-${ch.id}-${pattern.id}`)}
                onDoubleClick={() => setVolume(DEFAULT_MIX.volume)}
              />
            </div>
            {notes ? (
              <MiniRoll pattern={pattern} channelId={ch.id} playStep={playStep} onClick={() => onOpenRoll(ch)} />
            ) : (
              <div className="steps">
                {steps.map((i) => {
                  const v = stepVelocity(pattern, ch.id, i);
                  return (
                    <span
                      key={i}
                      role="gridcell"
                      aria-selected={v > 0}
                      className={cellClass(i) + (v > 0 ? " on" : "")}
                      style={v > 0 ? ({ "--v": v } as React.CSSProperties) : undefined}
                      onPointerDown={(e) => onDown(e, ch.id, i)}
                      onPointerEnter={() => onEnter(ch.id, i)}
                      onContextMenu={(e) => onContext(e, ch.id, i)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A channel that uses the piano roll in this pattern: its notes in miniature. */
function MiniRoll({ pattern, channelId, playStep, onClick }: { pattern: Pattern; channelId: string; playStep: number | null; onClick: () => void }) {
  const { t } = useTranslation();
  const notes = channelNotes(pattern, channelId);
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  const w = stepsWidth(pattern.steps);
  const x = (step: number) => (step / pattern.steps) * w;
  return (
    <button className="mini-roll" style={{ width: w }} onClick={onClick} title={t("studio.openRoll")} aria-label={t("studio.openRoll")}>
      {notes.map((n, i) => (
        <span
          key={i}
          style={{
            left: x(n.start),
            width: Math.max(2, x(n.length) - 1),
            top: hi === lo ? 12 : 3 + ((hi - n.pitch) / (hi - lo)) * 20,
          }}
        />
      ))}
      {playStep !== null && <i style={{ left: x(playStep) }} />}
    </button>
  );
}
