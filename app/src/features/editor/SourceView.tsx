// The original file: select a part and save it as a sample. You stay here afterwards,
// so cutting several samples from one song is: select → Enter → select → Enter...
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { SampleInfo, SourceInfo, TimeRange } from "../../lib/api";
import { formatShort } from "../../lib/format";
import { WavePanel } from "./WavePanel";
import type { WaveformHandle } from "./Waveform";

export interface ViewHandle extends WaveformHandle {
  primaryAction: () => void;
}

interface Props {
  source: SourceInfo;
  samples: SampleInfo[];
  selection: TimeRange | null;
  setSelection: (s: TimeRange | null) => void;
  busy: boolean;
  onCreateSample: (range: TimeRange) => void;
}

export const SourceView = forwardRef<ViewHandle, Props>(function SourceView(
  { source, samples, selection, setSelection, busy, onCreateSample },
  ref,
) {
  const { t } = useTranslation();
  const wave = useRef<WaveformHandle>(null);
  const create = () => selection && !busy && onCreateSample(selection);
  useImperativeHandle(ref, () => ({
    togglePlay: () => wave.current?.togglePlay(),
    stop: () => wave.current?.stop(),
    primaryAction: create,
  }));

  // Show samples already cut from this file as labelled markers.
  const markers = useMemo(
    () =>
      samples
        .filter((s) => s.sourceId === source.id)
        .map((s) => ({ id: s.id, start: s.start, end: s.end, label: s.name })),
    [samples, source.id],
  );

  return (
    <main className="editor">
      <div className="view-title">
        <h2>{source.name}</h2>
        <span className="muted">
          {formatShort(source.duration)} · {(source.sampleRate / 1000).toFixed(1)} kHz ·{" "}
          {t(source.channels === 1 ? "audio.mono" : "audio.stereo")}
        </span>
      </div>

      <WavePanel
        ref={wave}
        url={convertFileSrc(source.previewPath)}
        snapTarget={{ sourceId: source.id }}
        selection={selection}
        setSelection={setSelection}
        markers={markers}
        height={220}
      />

      <section className="tools">
        <button className="primary big" disabled={!selection || busy} onClick={create} title="Enter">
          <Icon name="plus" /> {t("source.saveSample")}
        </button>
        {selection && <span className="muted small">{t("source.saveHint")}</span>}
      </section>
    </main>
  );
});
