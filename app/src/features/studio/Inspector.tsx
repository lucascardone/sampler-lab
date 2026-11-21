// Right-hand inspector: the properties of whatever is selected — a channel, a clip on the
// timeline, or (nothing selected) the master. One place for every setting, so the
// channel rows and clips stay compact. A channel's volume, pan and effects belong to a
// pattern (`Pattern.mix`): the panel edits them in the pattern being edited, or in the one
// picked in "Mezcla y efectos de".
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Analysis } from "../../lib/api";
import { Icon, IconButton } from "../../ui/Icon";
import { NumberField } from "../../ui/NumberField";
import { padColor, patternColor } from "./colors";
import type { SoundStatus } from "./engine";
import { FxPresetPicker, MoreFx } from "./FxControls";
import {
  channelIn,
  copyMixEverywhere,
  fxActive,
  setMix,
  NO_FX,
  REVERB_SIZES,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  updateChannel,
  updateClip,
  type Channel,
  type ChannelFx,
  type ChannelMix,
  type Clip,
  type MixScope,
  type Song,
} from "./song";
import type { SongStore } from "./useSong";
import { Slider } from "../../ui/Slider";
import { Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { RootNotePicker } from "./NotePickers";

export type Selection = { kind: "channel"; id: string } | { kind: "clip"; id: string } | null;

/** True if the channel has any effect turned on (pass it through `channelIn` for a pattern). */
export function hasFx(ch: Channel): boolean {
  return fxActive(ch.fx);
}

/** Value of the "Mezcla y efectos de" select for the audio-clips scope. */
const CLIPS = "__clips";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="insp-section">
      <h3>
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}


const pct = (v: number) => `${Math.round(v * 100)}%`;
const db = (v: number) => `${v > 0 ? "+" : ""}${v} dB`;

/** "1 compás", "2 tiempos", "3/16". */
export function useStepsLabel() {
  const { t } = useTranslation();
  return (n: number) => {
    if (n === 0) return t("insp.none");
    if (n % STEPS_PER_BAR === 0) return t("insp.bars", { count: n / STEPS_PER_BAR });
    if (n % STEPS_PER_BEAT === 0) return t("insp.beats", { count: n / STEPS_PER_BEAT });
    return `${n}/16`;
  };
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

interface ChannelProps {
  song: Song;
  channel: Channel;
  onError: (e: unknown) => void;
  status: SoundStatus;
  update: SongStore["update"];
  analysis?: Analysis;
  onAnalyze: () => void;
  onWarp: (on: boolean, bpm: number) => void;
  onUseTempo: (bpm: number) => void;
  onPreview: () => void;
  onOpenRoll: () => void;
  onDetectRoot?: () => void;
  onClearPattern: () => void;
  onRemove: () => void;
}

function ChannelPanel(p: ChannelProps) {
  const { t } = useTranslation();
  const { channel: base, song, update } = p;
  const [name, setName] = useState(base.name);
  useEffect(() => setName(base.name), [base.id, base.name]);
  // Which pattern's mix is shown: follows the pattern being edited unless you pick another.
  const [picked, setPicked] = useState<MixScope>(song.currentPatternId);
  useEffect(() => setPicked(song.currentPatternId), [song.currentPatternId]);
  const hasAudioClips = song.clips.some((c) => c.kind === "audio" && c.channelId === base.id);
  const scope: MixScope =
    picked === null ? (hasAudioClips ? null : song.currentPatternId) : song.patterns.some((x) => x.id === picked) ? picked : song.currentPatternId;
  const scopeName = scope === null ? t("insp.scopeClips") : (song.patterns.find((x) => x.id === scope)?.name ?? "");
  // `ch` = the channel as it sounds in that pattern (its volume, pan and fx swapped in).
  const ch = channelIn(song, base, scope);
  const set = (patch: Partial<Channel>, key: string) => update((s) => updateChannel(s, ch.id, patch), `insp-${ch.id}-${key}`);
  const mix = (patch: Partial<ChannelMix>, key: string) =>
    update((s) => setMix(s, scope, ch.id, patch), `insp-${ch.id}-${scope ?? CLIPS}-${key}`);
  const fx = (patch: Partial<ChannelFx>, key: string) => mix({ fx: { ...ch.fx, ...patch } }, key);
  const isSample = ch.sound.kind === "sample";
  const kindIcon = ch.sound.kind === "builtin" ? "drum" : ch.sound.kind === "synth" ? "wave" : "note";

  return (
    <>
      <header className="insp-head" style={{ "--ch": padColor(ch.id) } as React.CSSProperties}>
        <span className="pad-chip">
          <Icon name={kindIcon} size={16} />
        </span>
        <input
          className="insp-name"
          aria-label={t("insp.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => (name.trim() ? set({ name: name.trim() }, "name") : setName(ch.name))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
        />
        {p.status.state === "error" && (
          <span className="insp-warn" title={t("studio.missing", { error: p.status.message })}>
            <Icon name="warning" />
          </span>
        )}
      </header>
      <div className="insp-actions">
        <button onClick={p.onPreview}>
          <Icon name="play" /> {t("insp.listen")}
        </button>
        <button onClick={p.onOpenRoll}>
          <Icon name="piano" /> {t("insp.openRoll")}
        </button>
      </div>

      <Section title={t("insp.scope")}>
        <div className="field-stack">
          <span className="field-label">{t("insp.scopeLabel")}</span>
          <Picker
            className="block"
            label={t("insp.scopeLabel")}
            title={t("insp.scopeLabel")}
            value={scope ?? CLIPS}
            columns={1}
            groups={[
              {
                options: [
                  ...song.patterns.map((x) => ({
                    value: x.id,
                    label: x.id === song.currentPatternId ? t("insp.scopeCurrent", { name: x.name }) : x.name,
                    color: patternColor(x.id),
                  })),
                  ...(hasAudioClips ? [{ value: CLIPS, label: t("insp.scopeClips") }] : []),
                ],
              },
            ]}
            onPick={(v) => setPicked(v === CLIPS ? null : v)}
          />
        </div>
        <p className="insp-note">{scope === null ? t("insp.scopeClipsNote") : t("insp.scopeNote", { name: scopeName })}</p>
        <Slider label={t("studio.volume")} value={ch.volume} min={0} max={1.25} step={0.01} reset={0.8} format={pct} onChange={(v) => mix({ volume: v }, "vol")} />
        <Slider
          label={t("studio.pan")}
          value={ch.pan}
          min={-1}
          max={1}
          step={0.05}
          reset={0}
          format={(v) => (Math.abs(v) < 0.01 ? t("insp.center") : `${v < 0 ? t("insp.left") : t("insp.right")} ${Math.round(Math.abs(v) * 100)}`)}
          onChange={(v) => mix({ pan: v }, "pan")}
        />
        <button onClick={() => update((s) => copyMixEverywhere(s, scope, ch.id))} title={t("insp.copyMixHint")}>
          <Icon name="copy" /> {t("insp.copyMix")}
        </button>
      </Section>

      <Section title={t("insp.instrument")}>
        <p className="insp-note">{t("insp.instrumentNote")}</p>
        <div className="insp-row">
          <button className={`toggle ${ch.mute ? "active" : ""}`} aria-pressed={ch.mute} onClick={() => set({ mute: !ch.mute }, "mute")}>
            {t("insp.mute")}
          </button>
          <button className={`toggle ${ch.solo ? "active" : ""}`} aria-pressed={ch.solo} onClick={() => set({ solo: !ch.solo }, "solo")}>
            {t("insp.solo")}
          </button>
        </div>
        <Slider
          label={t("insp.pitch")}
          value={ch.pitch}
          min={-24}
          max={24}
          step={1}
          reset={0}
          format={(v) => `${v > 0 ? "+" : ""}${v} st`}
          hint={t("studio.pitch")}
          onChange={(v) => set({ pitch: v }, "pitch")}
        />
      </Section>

      {ch.sound.kind !== "synth" && (
        <Section title={t("insp.tuning")}>
          <label className="field" title={t("roll.rootHint")}>
            <span className="field-label">{t("roll.root")}</span>
            <RootNotePicker value={ch.rootNote} onChange={(v) => set({ rootNote: v }, "root")} />
            {p.onDetectRoot ? (
              <button className="link" onClick={p.onDetectRoot}>
                {t("roll.detect")}
              </button>
            ) : (
              <span />
            )}
          </label>
          <label className="check" title={t("roll.gateHint")}>
            <input type="checkbox" checked={ch.gate} onChange={(e) => set({ gate: e.target.checked }, "gate")} />
            {t("roll.gate")}
          </label>
        </Section>
      )}

      {isSample && (
        <Section title={t("fx.tempo")}>
          <label className="check" title={t("fx.warpHint")}>
            <input type="checkbox" checked={ch.warp.on} disabled={!ch.warp.bpm} onChange={(e) => p.onWarp(e.target.checked, ch.warp.bpm)} />
            {t("fx.warp", { bpm: song.bpm })}
          </label>
          <label className="field">
            <span className="field-label">{t("fx.sampleBpm")}</span>
            <NumberField
              aria-label={t("fx.sampleBpm")}
              value={ch.warp.bpm}
              min={40}
              max={300}
              step={0.1}
              placeholder="?"
              onCommit={(v) => p.onWarp(ch.warp.on, v)}
            />
            <span />
          </label>
          {p.analysis?.tempo ? (
            <p className="insp-note">
              {t("fx.detected")}{" "}
              <button className="link" onClick={() => p.onWarp(ch.warp.on, p.analysis!.tempo!.bpm)}>
                {p.analysis.tempo.bpm}
              </button>{" "}
              {t("fx.or")}{" "}
              <button className="link" onClick={() => p.onWarp(ch.warp.on, p.analysis!.tempo!.alternative)}>
                {p.analysis.tempo.alternative}
              </button>
            </p>
          ) : (
            <button className="link insp-note" onClick={p.onAnalyze}>
              {p.analysis ? t("fx.noTempo") : t("fx.detectTempo")}
            </button>
          )}
          {ch.warp.bpm > 0 && Math.abs(ch.warp.bpm - song.bpm) > 0.05 && (
            <button className="link insp-note" onClick={() => p.onUseTempo(ch.warp.bpm)} title={t("fx.useTempoHint")}>
              {t("fx.useTempo", { bpm: ch.warp.bpm })}
            </button>
          )}
        </Section>
      )}

      <Section
        title={t("insp.effectsIn", { name: scopeName })}
        aside={
          hasFx(ch) ? (
            <button className="link" onClick={() => mix({ fx: { ...NO_FX } }, "fx-reset")}>
              {t("fx.reset")}
            </button>
          ) : undefined
        }
      >
        <FxPresetPicker song={song} ch={ch} fx={fx} onError={p.onError} />
        <Slider label={t("fx.low")} value={ch.fx.low} min={-12} max={12} step={0.5} reset={0} format={db} hint={t("fx.dbHint")} onChange={(v) => fx({ low: v }, "low")} />
        <Slider label={t("fx.mid")} value={ch.fx.mid} min={-12} max={12} step={0.5} reset={0} format={db} onChange={(v) => fx({ mid: v }, "mid")} />
        <Slider label={t("fx.high")} value={ch.fx.high} min={-12} max={12} step={0.5} reset={0} format={db} onChange={(v) => fx({ high: v }, "high")} />
        <Slider label={t("fx.comp")} value={ch.fx.comp} min={0} max={1} step={0.01} reset={0} format={pct} hint={t("fx.compHint")} onChange={(v) => fx({ comp: v }, "comp")} />
        <Slider label={t("fx.reverb")} value={ch.fx.reverb} min={0} max={1} step={0.01} reset={0} format={pct} hint={t("fx.reverbHint")} onChange={(v) => fx({ reverb: v }, "rev")} />
        <Slider label={t("fx.delay")} value={ch.fx.delay} min={0} max={1} step={0.01} reset={0} format={pct} hint={t("fx.delayHint")} onChange={(v) => fx({ delay: v }, "dly")} />
        <MoreFx song={song} ch={ch} fx={fx} />
      </Section>

      <Section title={t("insp.channelActions")}>
        <div className="insp-row">
          <button onClick={p.onClearPattern}>
            <Icon name="eraser" /> {t("insp.clearPattern")}
          </button>
          <button className="danger" onClick={p.onRemove}>
            <Icon name="trash" /> {t("insp.remove")}
          </button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Clip
// ---------------------------------------------------------------------------

interface ClipProps {
  song: Song;
  clip: Clip;
  update: SongStore["update"];
  onEditPattern: (patternId: string) => void;
  onRemove: () => void;
}

function ClipPanel({ song, clip, update, onEditPattern, onRemove }: ClipProps) {
  const { t } = useTranslation();
  const steps = useStepsLabel();
  const set = (patch: Parameters<typeof updateClip>[2], key: string) => update((s) => updateClip(s, clip.id, patch), `clip-${clip.id}-${key}`);
  const name =
    clip.kind === "pattern"
      ? (song.patterns.find((p) => p.id === clip.patternId)?.name ?? "?")
      : (song.channels.find((c) => c.id === clip.channelId)?.name ?? "?");
  return (
    <>
      <header className="insp-head">
        <Icon name={clip.kind === "pattern" ? "steps" : "note"} size={18} />
        <div className="insp-title">
          <strong>{name}</strong>
          <span className="muted">{clip.kind === "pattern" ? t("insp.patternClip") : t("insp.audioClip")} · {steps(clip.length)}</span>
        </div>
      </header>
      {clip.kind === "pattern" && (
        <div className="insp-actions">
          <button onClick={() => onEditPattern(clip.patternId)}>
            <Icon name="steps" /> {t("insp.editPattern")}
          </button>
        </div>
      )}
      <Section title={t("insp.clipMix")}>
        <button className={`toggle ${clip.muted ? "active" : ""}`} aria-pressed={clip.muted} onClick={() => set({ muted: !clip.muted }, "mute")}>
          {clip.muted ? t("insp.clipMuted") : t("insp.clipMute")}
        </button>
        <Slider label={t("studio.volume")} value={clip.gain} min={0} max={1.5} step={0.01} reset={1} format={pct} onChange={(v) => set({ gain: v }, "gain")} />
        <Slider
          label={t("insp.fadeIn")}
          value={clip.fadeIn}
          min={0}
          max={clip.length}
          step={1}
          reset={0}
          format={steps}
          hint={t("insp.fadeHint")}
          onChange={(v) => set({ fadeIn: v }, "fin")}
        />
        <Slider
          label={t("insp.fadeOut")}
          value={clip.fadeOut}
          min={0}
          max={clip.length}
          step={1}
          reset={0}
          format={steps}
          hint={t("insp.fadeHint")}
          onChange={(v) => set({ fadeOut: v }, "fout")}
        />
        <p className="insp-note muted">{t("insp.fadeTip")}</p>
      </Section>
      <Section title={t("insp.clipActions")}>
        <button className="danger" onClick={onRemove}>
          <Icon name="trash" /> {t("insp.removeClip")}
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Master (nothing selected)
// ---------------------------------------------------------------------------

const DELAY_TIMES = [1, 2, 3, 4, 6, 8];

function MasterPanel({ song, update, onOpenMidi }: { song: Song; update: SongStore["update"]; onOpenMidi: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <header className="insp-head">
        <Icon name="sliders" size={18} />
        <div className="insp-title">
          <strong>{t("insp.master")}</strong>
          <span className="muted">{t("insp.masterHint")}</span>
        </div>
      </header>
      <Section title={t("insp.output")}>
        <Slider
          label={t("studio.volume")}
          value={song.masterVolume}
          min={0}
          max={1.25}
          step={0.01}
          reset={0.8}
          format={pct}
          onChange={(v) => update((s) => ({ ...s, masterVolume: v }), "master")}
        />
        <label className="check" title={t("fx.limiterHint")}>
          <input type="checkbox" checked={song.fx.limiter} onChange={(e) => update((s) => ({ ...s, fx: { ...s.fx, limiter: e.target.checked } }))} />
          {t("fx.limiter")}
        </label>
      </Section>
      <Section title={t("insp.sharedFx")}>
        <div className="field-stack" title={t("fx.delayTimeHint")}>
          <span className="field-label">{t("fx.delayTime")}</span>
          <Picker
            className="block"
            label={t("fx.delayTimeHint")}
            title={t("fx.delayTime")}
            value={song.fx.delaySteps}
            columns={3}
            groups={[{ options: DELAY_TIMES.map((d) => ({ value: d, label: t(`fx.times.${d}`) })) }]}
            onPick={(v) => update((s) => ({ ...s, fx: { ...s.fx, delaySteps: v } }))}
          />
        </div>
        <Slider
          label={t("fx.feedback")}
          value={song.fx.delayFeedback}
          min={0}
          max={0.85}
          step={0.01}
          reset={0.35}
          format={pct}
          onChange={(v) => update((s) => ({ ...s, fx: { ...s.fx, delayFeedback: v } }), "fx-feedback")}
        />
        <label className="check" title={t("fx.pingPongHint")}>
          <input
            type="checkbox"
            checked={song.fx.delayPingPong}
            onChange={(e) => update((s) => ({ ...s, fx: { ...s.fx, delayPingPong: e.target.checked } }))}
          />
          {t("fx.pingPong")}
        </label>
        <div className="field-stack" title={t("fx.reverbSizeHint")}>
          <span className="field-label">{t("fx.reverbSize")}</span>
          <Segmented
            block
            label={t("fx.reverbSize")}
            value={song.fx.reverbSize}
            options={REVERB_SIZES.map((r) => ({ value: r, label: t(`fx.reverbSizes.${r}`) }))}
            onChange={(v) => update((s) => ({ ...s, fx: { ...s.fx, reverbSize: v } }))}
          />
        </div>
      </Section>
      <Section title={t("insp.input")}>
        <button onClick={onOpenMidi}>
          <Icon name="midi" /> {t("midi.open")}
        </button>
        <p className="insp-note muted">{t("midi.hint")}</p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

type Props = {
  song: Song;
  selection: Selection;
  update: SongStore["update"];
  onError: (e: unknown) => void;
  onDeselect: () => void;
  onOpenMidi: () => void;
  channel: Omit<ChannelProps, "song" | "channel" | "update" | "status" | "onError"> & { status: (ch: Channel) => SoundStatus; analysisFor: (ch: Channel) => Analysis | undefined };
  clip: Omit<ClipProps, "song" | "clip" | "update">;
};

export function Inspector({ song, selection, update, onError, onDeselect, onOpenMidi, channel, clip }: Props) {
  const { t } = useTranslation();
  const ch = selection?.kind === "channel" ? song.channels.find((c) => c.id === selection.id) : undefined;
  const cl = selection?.kind === "clip" ? song.clips.find((c) => c.id === selection.id) : undefined;
  return (
    <aside className="inspector" aria-label={t("insp.label")}>
      {(ch || cl) && (
        <div className="insp-back">
          <IconButton icon="x" label={t("insp.close")} tone="ghost" onClick={onDeselect} />
        </div>
      )}
      {ch ? (
        <ChannelPanel
          key={ch.id}
          song={song}
          channel={ch}
          update={update}
          onError={onError}
          {...channel}
          status={channel.status(ch)}
          analysis={channel.analysisFor(ch)}
        />
      ) : cl ? (
        <ClipPanel key={cl.id} song={song} clip={cl} update={update} {...clip} />
      ) : (
        <MasterPanel song={song} update={update} onOpenMidi={onOpenMidi} />
      )}
    </aside>
  );
}
