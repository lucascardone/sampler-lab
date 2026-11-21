// Waveform + transport (play, loop, zoom) + selection bar with zero-crossing snap.
// Used by both the "original file" view and the sample editor.
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { api, type SnapTarget, type TimeRange } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { Waveform, type Marker, type WaveformHandle } from "./Waveform";

/** Selections shorter than this are treated as accidental clicks. */
const MIN_SELECTION_SECS = 0.005;

interface Props {
  url: string;
  snapTarget: SnapTarget;
  selection: TimeRange | null;
  setSelection: (sel: TimeRange | null) => void;
  markers?: Marker[];
  height?: number;
}

export const WavePanel = forwardRef<WaveformHandle, Props>(function WavePanel(
  { url, snapTarget, selection, setSelection, markers, height },
  ref,
) {
  const { t } = useTranslation();
  const [loop, setLoop] = useState(true);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const waveRef = useRef<WaveformHandle>(null);
  useImperativeHandle(ref, () => ({
    togglePlay: () => waveRef.current?.togglePlay(),
    stop: () => waveRef.current?.stop(),
  }));

  const targetKey = JSON.stringify(snapTarget);
  const handleSelection = useCallback(
    async (sel: TimeRange | null) => {
      if (!sel || sel.end - sel.start < MIN_SELECTION_SECS) return setSelection(null);
      if (!snap) return setSelection(sel);
      try {
        const [start, end] = await api.snapToZero(JSON.parse(targetKey), [sel.start, sel.end]);
        setSelection(end - start >= MIN_SELECTION_SECS ? { start, end } : sel);
      } catch {
        setSelection(sel);
      }
    },
    [snap, setSelection, targetKey],
  );

  return (
    <>
      <Waveform
        ref={waveRef}
        url={url}
        selection={selection}
        onSelectionChange={handleSelection}
        markers={markers}
        loop={loop}
        zoom={zoom}
        onTimeUpdate={setTime}
        onPlayingChange={setPlaying}
        height={height}
      />

      <section className="transport">
        <button className="play" onClick={() => waveRef.current?.togglePlay()} title={t("transport.spaceHint")}>
          <Icon name={playing ? "pause" : "play"} /> {playing ? t("transport.pause") : t("transport.play")}
        </button>
        <span className="time">{formatTime(time)}</span>
        <label className="check">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          {t("transport.loop")}
        </label>
        <label className="check" title={t("selection.snapHint")}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          {t("selection.snap")}
        </label>
        <div className="spacer" />
        <label className="zoom">
          {t("transport.zoom")}
          <input type="range" min={0} max={1000} step={10} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
      </section>

      <section className="selection-bar">
        {selection ? (
          <>
            <span>
              {t("selection.info", {
                start: formatTime(selection.start),
                end: formatTime(selection.end),
                length: formatTime(selection.end - selection.start),
              })}
            </span>
            <button className="link" onClick={() => setSelection(null)} title="Esc">
              {t("selection.clear")}
            </button>
          </>
        ) : (
          <span className="muted">{t("selection.none")}</span>
        )}
      </section>
    </>
  );
});
