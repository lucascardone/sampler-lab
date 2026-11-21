// Edit one sample: add effects (on the selection or the whole sample), manage the effect
// list, export, and separate into stems.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Analysis } from "../../lib/api";
import { LATIN_NAMES, NOTE_NAMES, noteName } from "../studio/theory";
import { useTranslation } from "react-i18next";
import { Icon, IconButton } from "../../ui/Icon";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type EffectRequest, type Rendered, type SampleInfo, type Session, type TimeRange } from "../../lib/api";
import { ExportOptions, type ExportSettings } from "../export/ExportOptions";
import { formatShort } from "../../lib/format";
import { SeparatePanel } from "../separation/SeparatePanel";
import { EffectsList } from "./EffectsList";
import { WavePanel } from "./WavePanel";
import type { WaveformHandle } from "./Waveform";
import type { ViewHandle } from "./SourceView";

/** Length of the automatic anti-click fade when there's no selection. */
const SHORT_FADE_SECS = 0.03;
const NORMALIZE_PEAK_DB = -1;

interface Props {
  sample: SampleInfo;
  /** Where the sample comes from, already translated. */
  origin: string;
  busy: boolean;
  /** Run a session-changing backend call with busy/error handling. */
  run: (fn: () => Promise<Session>) => Promise<void>;
  onSession: (s: Session, openSampleId?: string) => void;
  onError: (e: unknown) => void;
  onInfo: (text: string) => void;
  exportSettings: ExportSettings;
  setExportSettings: (s: ExportSettings) => void;
  /** Add this sample as a channel in the studio. */
  onUseInStudio: () => void;
  /** Session the sample belongs to (for analysis). */
  sessionId: string;
}

export const SampleEditor = forwardRef<ViewHandle, Props>(function SampleEditor(
  { sample, origin, busy, run, onSession, onError, onInfo, exportSettings, setExportSettings, onUseInStudio, sessionId },
  ref,
) {
  const { t } = useTranslation();
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [selection, setSelection] = useState<TimeRange | null>(null);
  const [gainDb, setGainDb] = useState(-3);
  const [separating, setSeparating] = useState(false);
  const wave = useRef<WaveformHandle>(null);

  useImperativeHandle(ref, () => ({
    togglePlay: () => wave.current?.togglePlay(),
    stop: () => wave.current?.stop(),
    primaryAction: () => {},
  }));

  // Re-render whenever the sample or its effect chain changes.
  const fxKey = JSON.stringify(sample.effects);
  useEffect(() => {
    let alive = true;
    api
      .renderSample(sample.id)
      .then((r) => {
        if (!alive) return;
        setRendered(r);
        setSelection((sel) => (sel && sel.end <= r.duration + 1e-6 ? sel : null));
      })
      .catch(onError);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample.id, fxKey]);

  // A different sample starts with no selection and the separation panel closed.
  useEffect(() => {
    setSelection(null);
    setSeparating(false);
  }, [sample.id]);

  const add = (op: EffectRequest) => run(() => api.addEffect(sample.id, op));

  const fade = (kind: "fadeIn" | "fadeOut") => {
    if (!rendered) return;
    const d = rendered.duration;
    const range =
      selection ??
      (kind === "fadeIn" ? { start: 0, end: Math.min(SHORT_FADE_SECS, d) } : { start: Math.max(0, d - SHORT_FADE_SECS), end: d });
    add({ type: kind, range });
  };

  const exportWav = async () => {
    const path = await save({
      defaultPath: `${sample.name}${selection ? "-sel" : ""}.wav`,
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    if (!path) return;
    try {
      await api.exportSample(sample.id, path, exportSettings.format, exportSettings.channels, selection);
      onInfo(t("export.done", { path }));
    } catch (e) {
      onError(e);
    }
  };

  const disabled = busy || !rendered;

  return (
    <main className="editor with-effects">
      <div className="editor-main">
        <div className="view-title">
          <div className="title-block">
            <h2>{sample.name}</h2>
            <span className="muted">
              {origin} · {rendered ? formatShort(rendered.duration) : "…"}
            </span>
          </div>
          <div className="spacer" />
          <IconButton icon="undo" label={`${t("toolbar.undo")} (Ctrl+Z)`} onClick={() => run(() => api.undo(sample.id))} disabled={busy || !sample.canUndo} />
          <IconButton icon="redo" label={`${t("toolbar.redo")} (Ctrl+Shift+Z)`} onClick={() => run(() => api.redo(sample.id))} disabled={busy || !sample.canRedo} />
          <button className="accent" onClick={onUseInStudio} disabled={busy}>
            <Icon name="toSong" /> {t("studio.useInStudio")}
          </button>
        </div>
        <AnalysisChips sessionId={sessionId} sample={sample} />

        {rendered && (
          <WavePanel
            ref={wave}
            url={convertFileSrc(rendered.previewPath)}
            snapTarget={{ sampleId: sample.id }}
            selection={selection}
            setSelection={setSelection}
          />
        )}

        <section className="tools">
          <button
            className="primary"
            onClick={() => selection && add({ type: "trim", range: selection })}
            disabled={disabled || !selection}
            title={t("edit.trimHint")}
          >
            <Icon name="scissors" /> {t("edit.trim")}
          </button>
          <button onClick={() => fade("fadeIn")} disabled={disabled} title={t("edit.fadeInHint")}>
            <Icon name="fadeIn" /> {t("edit.fadeIn")}
          </button>
          <button onClick={() => fade("fadeOut")} disabled={disabled} title={t("edit.fadeOutHint")}>
            <Icon name="fadeOut" /> {t("edit.fadeOut")}
          </button>
          <button
            onClick={() => add({ type: "normalize", peakDb: NORMALIZE_PEAK_DB, range: selection })}
            disabled={disabled}
            title={t("edit.normalizeHint")}
          >
            <Icon name="normalize" /> {t("edit.normalize")}
          </button>
          <button onClick={() => add({ type: "reverse", range: selection })} disabled={disabled} title={t("edit.reverseHint")}>
            <Icon name="reverse" /> {t("edit.reverse")}
          </button>
          <span className="gain" title={t("edit.gainHint")}>
            {t("edit.gain")}
            <input type="number" step={0.5} min={-48} max={24} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} />
            dB
            <button onClick={() => add({ type: "gain", db: gainDb, range: selection })} disabled={disabled || gainDb === 0}>
              {t("edit.gainApply")}
            </button>
          </span>
          <p className="muted small scope-hint">{selection ? t("edit.scopeSelection") : t("edit.scopeAll")}</p>
        </section>

        <div className="sample-actions">
          <button className={`separate-btn ${separating ? "active" : ""}`} onClick={() => setSeparating((v) => !v)} disabled={busy} aria-pressed={separating}>
            <Icon name="split" /> {t("separation.open")}
          </button>
          <section className="export export-row">
            <ExportOptions value={exportSettings} onChange={setExportSettings} />
            <button className="primary" onClick={exportWav} disabled={disabled}>
              <Icon name="download" /> {selection ? t("toolbar.exportSelection") : t("toolbar.export")}
            </button>
          </section>
        </div>

        {separating && (
          <SeparatePanel sample={sample} onSession={onSession} onError={onError} onClose={() => setSeparating(false)} />
        )}
      </div>

      <EffectsList
        sample={sample}
        disabled={busy}
        onToggle={(id, on) => run(() => api.setEffectEnabled(sample.id, id, on))}
        onRemove={(id) => run(() => api.removeEffect(sample.id, id))}
        onMove={(id, d) => run(() => api.moveEffect(sample.id, id, d))}
      />
    </main>
  );
});

/** Detected tempo, key and note of the sample (as it sounds, effects included). */
function AnalysisChips({ sessionId, sample }: { sessionId: string; sample: SampleInfo }) {
  const { t } = useTranslation();
  const [a, setA] = useState<Analysis | null>(null);
  // Re-analyze when what the sample sounds like changes.
  const sig = JSON.stringify([sample.id, sample.start, sample.end, sample.effects]);
  useEffect(() => {
    let alive = true;
    setA(null);
    api
      .libraryAnalyze(sessionId, sample.id)
      .then((r) => alive && setA(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sig]);
  if (!a) return <div className="analysis muted small">{t("analysis.working")}</div>;
  const sure = (c: number, min: number) => (c >= min ? "" : "unsure");
  return (
    <div className="analysis small">
      {a.tempo && (
        <span className={`chip-info ${sure(a.tempo.confidence, 0.35)}`} title={t("analysis.tempoHint")}>
          ♩ {a.tempo.bpm} BPM <span className="muted">({t("fx.or")} {a.tempo.alternative})</span>
        </span>
      )}
      {a.key && (
        <span className={`chip-info ${sure(a.key.confidence, 0.35)}`} title={t("analysis.keyHint")}>
          {t("analysis.key", { note: LATIN_NAMES[a.key.tonic], letter: NOTE_NAMES[a.key.tonic], mode: t(a.key.minor ? "analysis.minor" : "analysis.major") })}
        </span>
      )}
      {a.pitch && a.pitch.confidence >= 0.5 && (
        <span className="chip-info" title={t("analysis.noteHint")}>
          {t("analysis.note", { note: noteName(a.pitch.midi) })}{" "}
          <span className="muted">
            {a.pitch.cents >= 0 ? "+" : ""}
            {Math.round(a.pitch.cents)}¢
          </span>
        </span>
      )}
    </div>
  );
}
