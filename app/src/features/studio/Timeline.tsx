// The song timeline: tracks where pattern clips and audio clips (your samples, as-is)
// are placed, moved, stretched and deleted. Each track has M (silenciar) and S (solo);
// its checkbox picks it, and a bar acts on every picked track at once.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  addClip,
  addTrack,
  audibleTracks,
  clipLevel,
  removeClip,
  removeTrack,
  renameTrack,
  setTracksMix,
  songLength,
  stepSeconds,
  trackName,
  updateClip,
  type Clip,
  type Song,
  type Track,
} from "./song";
import type { SongStore } from "./useSong";
import { ItemMenu, RenameInput } from "../../ui/ItemMenu";
import { Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { ask } from "@tauri-apps/plugin-dialog";
import { padColor, patternColor } from "./colors";

const LANE_H = 36;
const HEAD_W = 176;
const ZOOMS = [2, 4, 8, 12]; // px per step
const SNAPS = [STEPS_PER_BAR, STEPS_PER_BEAT, 1];

/** What a click on an empty spot places: a pattern or a channel's sound as audio. */
export type Brush = { kind: "pattern"; patternId: string } | { kind: "audio"; channelId: string };

interface Props {
  song: Song;
  /** Song step sounding now (null when stopped or not in song mode). */
  playStep: number | null;
  startStep: number;
  setStartStep: (s: number) => void;
  update: SongStore["update"];
  brush: Brush;
  setBrush: (b: Brush) => void;
  /** Length of a channel's sound, to size new audio clips. */
  soundSeconds: (channelId: string) => number | null;
  onEditPattern: (patternId: string) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
}

type Drag = { kind: "move" | "resize" | "fadeIn" | "fadeOut"; id: string; x0: number; start: number; length: number; trackIdx: number; key: string };

export function Timeline({
  song,
  playStep,
  startStep,
  setStartStep,
  update,
  brush,
  setBrush,
  soundSeconds,
  onEditPattern,
  selectedClipId,
  onSelectClip,
}: Props) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(4);
  const [snap, setSnap] = useState(STEPS_PER_BAR);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Tracks picked with their checkbox (ids; ones that no longer exist are ignored). */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const lanesRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const strokes = useRef(0);

  useEffect(() => {
    const end = () => (drag.current = null);
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  // Esc drops the picked tracks (like it drops the inspector selection).
  const anyPicked = picked.size > 0;
  useEffect(() => {
    if (!anyPicked) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicked(new Set());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyPicked]);

  const px = zoom;
  const bars = Math.max(32, songLength(song) / STEPS_PER_BAR + 8);
  const width = bars * STEPS_PER_BAR * px;
  const snapDown = (step: number) => Math.max(0, Math.floor(step / snap) * snap);
  const snapRound = (step: number) => Math.max(0, Math.round(step / snap) * snap);

  const stepAt = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return (clientX - r.left - HEAD_W) / px;
  };
  const laneAt = (clientY: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(song.tracks.length - 1, Math.floor((clientY - r.top) / LANE_H)));
  };

  const brushLength = (): number => {
    if (brush.kind === "pattern") return song.patterns.find((p) => p.id === brush.patternId)?.steps ?? STEPS_PER_BAR;
    const secs = soundSeconds(brush.channelId);
    return secs ? Math.max(1, Math.ceil(secs / stepSeconds(song.bpm))) : STEPS_PER_BAR;
  };

  const onTrackDown = (e: React.PointerEvent, trackIdx: number) => {
    if (e.button !== 0) return;
    const key = `tl-${++strokes.current}`;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
    if (el) {
      e.preventDefault();
      lanesRef.current?.setPointerCapture(e.pointerId);
      const c = song.clips.find((x) => x.id === el.dataset.clip)!;
      onSelectClip(c.id);
      const fade = (e.target as HTMLElement).closest<HTMLElement>("[data-fade]")?.dataset.fade as "fadeIn" | "fadeOut" | undefined;
      const resize = !fade && e.clientX > el.getBoundingClientRect().right - 8;
      drag.current = { kind: fade ?? (resize ? "resize" : "move"), id: c.id, x0: stepAt(e.clientX), start: c.start, length: c.length, trackIdx, key };
      return;
    }
    // A click on empty space just deselects; pasting is a double-click (so clicking
    // around never drops clips by accident).
    onSelectClip(null);
  };

  const pasteAt = (e: React.MouseEvent, trackIdx: number) => {
    if ((e.target as HTMLElement).closest("[data-clip]")) return;
    const start = snapDown(stepAt(e.clientX));
    const length = brushLength();
    const id = `clip${song.nextId}`; // the id addClip is about to assign
    const trackId = song.tracks[trackIdx].id;
    update((s) =>
      addClip(
        s,
        brush.kind === "pattern"
          ? { kind: "pattern", patternId: brush.patternId, trackId, start, length }
          : { kind: "audio", channelId: brush.channelId, trackId, start, length },
      ),
    );
    onSelectClip(id);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = stepAt(e.clientX) - d.x0;
    if (d.kind === "fadeIn" || d.kind === "fadeOut") {
      // Fades snap like clips do (bar / beat / 16th), measured from the clip's edges.
      const at = Math.round(stepAt(e.clientX)) - d.start;
      const snapped = d.kind === "fadeIn" ? Math.round(at / snap) * snap : d.length - Math.round((d.length - at) / snap) * snap;
      const v = d.kind === "fadeIn" ? snapped : d.length - snapped;
      update((s) => updateClip(s, d.id, { [d.kind]: Math.max(0, Math.min(d.length, v)) }), d.key);
      return;
    }
    if (d.kind === "move") {
      const start = snapRound(d.start + dx);
      const trackId = song.tracks[laneAt(e.clientY)].id;
      update((s) => updateClip(s, d.id, { start, trackId }), d.key);
    } else {
      const end = Math.max(d.start + 1, snapRound(d.start + d.length + dx));
      update((s) => updateClip(s, d.id, { length: end - d.start }), d.key);
    }
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
    if (el) update((s) => removeClip(s, el.dataset.clip!));
  };

  const clipLabel = (c: Clip) =>
    c.kind === "pattern"
      ? (song.patterns.find((p) => p.id === c.patternId)?.name ?? "?")
      : (song.channels.find((ch) => ch.id === c.channelId)?.name ?? "?");
  const clipColor = (c: Clip) => (c.kind === "pattern" ? patternColor(c.patternId) : padColor(c.channelId));
  const repeat = (c: Clip) => (c.kind === "pattern" ? (song.patterns.find((p) => p.id === c.patternId)?.steps ?? 0) * px : 0);

  const sel = song.tracks.filter((tr) => picked.has(tr.id));
  const audible = audibleTracks(song);
  const togglePick = (id: string) =>
    setPicked((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked = sel.length === song.tracks.length;
  const setMix = (tracks: Track[], patch: Partial<Pick<Track, "mute" | "solo">>) => update((s) => setTracksMix(s, tracks.map((tr) => tr.id), patch));
  const deleteTrack = async (tr: Track) => {
    const n = song.clips.filter((c) => c.trackId === tr.id).length;
    if (n === 0 || (await ask(t("timeline.removeTrackConfirm", { name: tr.name, count: n }), { kind: "warning", title: t("app.title") })))
      update((s) => removeTrack(s, tr.id));
  };

  const audioChannels = song.channels.filter((c) => c.sound.kind === "sample");
  const brushValue = brush.kind === "pattern" ? `p:${brush.patternId}` : `a:${brush.channelId}`;

  return (
    <section className="timeline">
      <header className="tl-toolbar">
        <strong>{t("timeline.title")}</strong>
        <Picker
          prefix={t("timeline.brush")}
          label={t("timeline.brushHint")}
          title={t("timeline.brushTitle")}
          value={brushValue}
          columns={2}
          groups={[
            { title: t("timeline.patterns"), options: song.patterns.map((p) => ({ value: `p:${p.id}`, label: p.name, color: patternColor(p.id) })) },
            ...(audioChannels.length
              ? [{ title: t("timeline.audio"), options: audioChannels.map((c) => ({ value: `a:${c.id}`, label: c.name, color: padColor(c.id) })) }]
              : []),
          ]}
          onPick={(v) => {
            const [k, id] = [v.slice(0, 1), v.slice(2)];
            setBrush(k === "p" ? { kind: "pattern", patternId: id } : { kind: "audio", channelId: id });
          }}
        />
        <span className="tb-field">
          {t("timeline.snap")}
          <Segmented label={t("timeline.snap")} value={snap} options={SNAPS.map((s) => ({ value: s, label: t(`timeline.snaps.${s}`) }))} onChange={setSnap} />
        </span>
        <span className="zoom-btns">
          <button className="zoom-btn" disabled={zoom === ZOOMS[0]} onClick={() => setZoom(ZOOMS[ZOOMS.indexOf(zoom) - 1])} aria-label={t("timeline.zoomOut")} title={t("timeline.zoomOut")}>
            −
          </button>
          <button className="zoom-btn" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[ZOOMS.indexOf(zoom) + 1])} aria-label={t("timeline.zoomIn")} title={t("timeline.zoomIn")}>
            +
          </button>
        </span>
        <button className="link" onClick={() => update((s) => addTrack(s, trackName(s.tracks.length + 1)))}>
          {t("timeline.addTrack")}
        </button>
        <div className="spacer" />
        {song.tracks.some((tr) => tr.mute || tr.solo) && (
          <button className="link" onClick={() => setMix(song.tracks, { mute: false, solo: false })} title={t("timeline.allOnHint")}>
            {t("timeline.allOn")}
          </button>
        )}
        <span className="help-dot" tabIndex={0} role="note" aria-label={t("timeline.help")} title={t("timeline.help")}>
          ?
        </span>
      </header>
        {sel.length > 0 && (
          <div className="tl-selbar" role="group" aria-label={t("timeline.picked", { count: sel.length })}>
            <strong>{t("timeline.picked", { count: sel.length })}</strong>
            {sel.every((tr) => tr.mute) ? (
              <button onClick={() => setMix(sel, { mute: false })}>{t("timeline.unmutePicked")}</button>
            ) : (
              <button onClick={() => setMix(sel, { mute: true })}>{t("timeline.mutePicked")}</button>
            )}
            {sel.every((tr) => tr.solo) ? (
              <button onClick={() => setMix(sel, { solo: false })}>{t("timeline.unsoloPicked")}</button>
            ) : (
              <button onClick={() => setMix(sel, { solo: true })}>{t("timeline.soloPicked")}</button>
            )}
            <button className="link" onClick={() => setPicked(new Set())}>
              {t("timeline.unpick")}
            </button>
          </div>
        )}

      <div className="tl-scroll">
        <div className="tl-body" style={{ width: HEAD_W + width }}>
          <div className="tl-ruler-row">
            <label className="tl-corner" title={allPicked ? t("timeline.unpick") : t("timeline.pickAll")}>
              <input
                type="checkbox"
                checked={allPicked}
                ref={(el) => {
                  if (el) el.indeterminate = sel.length > 0 && !allPicked;
                }}
                onChange={() => setPicked(allPicked ? new Set() : new Set(song.tracks.map((tr) => tr.id)))}
                aria-label={allPicked ? t("timeline.unpick") : t("timeline.pickAll")}
              />
              <span>{t("timeline.tracks")}</span>
            </label>
            <div
              className="tl-ruler"
              style={{ width, "--bar": `${STEPS_PER_BAR * px}px` } as React.CSSProperties}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setStartStep(snapDown((e.clientX - r.left) / px));
              }}
              title={t("timeline.rulerHint")}
            >
              {Array.from({ length: bars }, (_, b) => (
                <span key={b} style={{ left: b * STEPS_PER_BAR * px }}>
                  {b + 1}
                </span>
              ))}
              <i className="tl-start" style={{ left: startStep * px }} />
            </div>
          </div>
          <div
            ref={lanesRef}
            className="tl-lanes"
            onPointerMove={onMove}
            onContextMenu={onContext}
            style={{ "--bar": `${STEPS_PER_BAR * px}px`, "--beat": `${STEPS_PER_BEAT * px}px` } as React.CSSProperties}
          >
            {song.tracks.map((tr, i) => (
              <div
                key={tr.id}
                className={`tl-lane ${audible.has(tr.id) ? "" : "silent"} ${picked.has(tr.id) ? "picked" : ""}`}
                style={{ height: LANE_H }}
              >
                <div className="tl-head">
                  <input
                    type="checkbox"
                    checked={picked.has(tr.id)}
                    onChange={() => togglePick(tr.id)}
                    aria-label={t("timeline.pickTrack", { name: tr.name })}
                    title={t("timeline.pickHint")}
                  />
                  {renaming === tr.id ? (
                    <RenameInput
                      value={tr.name}
                      onDone={(name) => {
                        setRenaming(null);
                        if (name) update((s) => renameTrack(s, tr.id, name));
                      }}
                    />
                  ) : (
                    <>
                      <span className="tl-name" onDoubleClick={() => setRenaming(tr.id)} title={tr.name}>
                        {tr.name}
                      </span>
                      <button
                        className={`ms ${tr.mute ? "active" : ""}`}
                        aria-pressed={tr.mute}
                        aria-label={`${t("studio.mute")} ${tr.name}`}
                        title={t("timeline.muteHint")}
                        onClick={() => setMix([tr], { mute: !tr.mute })}
                      >
                        M
                      </button>
                      <button
                        className={`ms solo ${tr.solo ? "active" : ""}`}
                        aria-pressed={tr.solo}
                        aria-label={`${t("studio.solo")} ${tr.name}`}
                        title={t("timeline.soloHint")}
                        onClick={() => setMix([tr], { solo: !tr.solo })}
                      >
                        S
                      </button>
                      <ItemMenu
                        name={tr.name}
                        onRename={() => setRenaming(tr.id)}
                        onDelete={() => deleteTrack(tr)}
                        deleteDisabled={song.tracks.length <= 1}
                      />
                    </>
                  )}
                </div>
                <div className="tl-track" style={{ width }} onPointerDown={(e) => onTrackDown(e, i)} onDoubleClick={(e) => pasteAt(e, i)}>
                  {song.clips
                    .filter((c) => c.trackId === tr.id)
                    .map((c) => (
                      <div
                        key={c.id}
                        data-clip={c.id}
                        className={`tl-clip ${c.kind} ${c.muted ? "muted" : ""} ${selectedClipId === c.id ? "selected" : ""}`}
                        style={
                          {
                            left: c.start * px,
                            width: Math.max(4, c.length * px - 1),
                            background: clipColor(c),
                            "--rep": `${repeat(c)}px`,
                          } as React.CSSProperties
                        }
                        title={clipLabel(c)}
                        onDoubleClick={() => c.kind === "pattern" && onEditPattern(c.patternId)}
                      >
                        <ClipEnvelope clip={c} px={px} />
                        <span>
                          {clipLabel(c)}
                          {c.gain !== 1 && <em className="gain-badge">{Math.round(c.gain * 100)}%</em>}
                        </span>
                        <i className="fade-h in" data-fade="fadeIn" style={{ left: c.fadeIn * px }} title={t("timeline.fadeInHandle")} />
                        <i className="fade-h out" data-fade="fadeOut" style={{ left: (c.length - c.fadeOut) * px }} title={t("timeline.fadeOutHandle")} />
                      </div>
                    ))}
                </div>
              </div>
            ))}
            {playStep !== null && <div className="tl-playhead" style={{ left: HEAD_W + playStep * px }} />}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The clip's volume shape: the part above the line is what the fades/volume take away. */
function ClipEnvelope({ clip, px }: { clip: Clip; px: number }) {
  if (clip.gain === 1 && !clip.fadeIn && !clip.fadeOut) return null;
  const w = clip.length * px;
  const H = 100; // viewBox units, stretched to the clip height
  const y = (pos: number) => H * (1 - clipLevel(clip, pos) / 1.5);
  const xs = [0, clip.fadeIn, clip.length - clip.fadeOut, clip.length];
  const pts = xs.map((p) => `${p * px},${y(p)}`).join(" ");
  return (
    <svg className="clip-env" viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,0 ${w},0 ${[...xs].reverse().map((p) => `${p * px},${y(p)}`).join(" ")}`} />
      <polyline points={pts} />
    </svg>
  );
}
