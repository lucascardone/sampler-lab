// Waveform view: wavesurfer + one selection region + read-only markers + loop playback.
//
// The selection lives in React state (owned by the parent). This component mirrors it
// into a wavesurfer region and reports user drags back via `onSelectionChange`.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import type { TimeRange } from "../../lib/api";

export interface WaveformHandle {
  togglePlay: () => void;
  stop: () => void;
}

export interface Marker extends TimeRange {
  id: string;
  label: string;
}

interface Props {
  url: string;
  selection: TimeRange | null;
  onSelectionChange: (sel: TimeRange | null) => void;
  /** Read-only labelled ranges (e.g. samples already cut from this file). */
  markers?: Marker[];
  loop: boolean;
  /** Pixels per second; 0 = fit to width. */
  zoom: number;
  onTimeUpdate: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  height?: number;
}

const SELECTION_COLOR = "rgba(255, 183, 77, 0.22)";
const MARKER_COLOR = "rgba(120, 180, 255, 0.12)";
const MARKER_PREFIX = "marker-";
const EPS = 1e-4;

export const Waveform = forwardRef<WaveformHandle, Props>(function Waveform(
  { url, selection, onSelectionChange, markers = [], loop, zoom, onTimeUpdate, onPlayingChange, height = 200 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const selRegionRef = useRef<Region | null>(null);
  const readyRef = useRef(false);

  // Latest props for event handlers registered once.
  const latest = useRef({ selection, markers, loop, zoom, onSelectionChange, onTimeUpdate, onPlayingChange });
  latest.current = { selection, markers, loop, zoom, onSelectionChange, onTimeUpdate, onPlayingChange };

  // Set while we change regions ourselves, so we don't echo that back as a user change.
  const syncing = useRef(false);

  const isMarker = (r: Region) => r.id.startsWith(MARKER_PREFIX);

  const syncSelection = (sel: TimeRange | null) => {
    const regions = regionsRef.current;
    if (!regions || !readyRef.current) return;
    const r = selRegionRef.current;
    syncing.current = true;
    try {
      if (!sel) {
        r?.remove();
        selRegionRef.current = null;
      } else if (r && Math.abs(r.start - sel.start) < EPS && Math.abs(r.end - sel.end) < EPS) {
        // already in sync
      } else if (r) {
        r.setOptions({ start: sel.start, end: sel.end });
      } else {
        selRegionRef.current = regions.addRegion({ start: sel.start, end: sel.end, color: SELECTION_COLOR });
      }
    } finally {
      syncing.current = false;
    }
  };

  const syncMarkers = (list: Marker[]) => {
    const regions = regionsRef.current;
    if (!regions || !readyRef.current) return;
    syncing.current = true;
    try {
      for (const r of regions.getRegions()) if (isMarker(r)) r.remove();
      for (const m of list) {
        const r = regions.addRegion({
          id: MARKER_PREFIX + m.id,
          start: m.start,
          end: m.end,
          color: MARKER_COLOR,
          content: m.label,
          drag: false,
          resize: false,
        });
        // Let drags pass through markers so you can still select over them.
        if (r.element) r.element.style.pointerEvents = "none";
      }
    } finally {
      syncing.current = false;
    }
  };

  // Create wavesurfer once.
  useEffect(() => {
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current!,
      height,
      waveColor: "#5b6b8c",
      progressColor: "#9fb3e0",
      cursorColor: "#ffb74d",
      cursorWidth: 2,
      normalize: false,
      autoScroll: true,
      plugins: [
        regions,
        TimelinePlugin.create({
          container: timelineRef.current!,
          style: { color: "#8a93a6", fontSize: "11px" },
        }),
      ],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    regions.enableDragSelection({ color: SELECTION_COLOR });

    const report = (r: Region) => {
      if (syncing.current || isMarker(r)) return;
      latest.current.onSelectionChange({ start: r.start, end: r.end });
    };

    regions.on("region-created", (r) => {
      if (syncing.current || isMarker(r)) return;
      // Single selection: a new drag replaces the previous one.
      if (selRegionRef.current && selRegionRef.current !== r) selRegionRef.current.remove();
      selRegionRef.current = r;
      report(r);
    });
    regions.on("region-updated", report);

    ws.on("decode", () => {
      readyRef.current = true;
      if (latest.current.zoom > 0) ws.zoom(latest.current.zoom);
      selRegionRef.current = null;
      syncMarkers(latest.current.markers);
      syncSelection(latest.current.selection);
    });

    ws.on("timeupdate", (t) => {
      latest.current.onTimeUpdate(t);
      const sel = latest.current.selection;
      if (!sel || !ws.isPlaying()) return;
      // Loop / stop at the end of the selection.
      if (t >= sel.end) {
        if (latest.current.loop) ws.setTime(sel.start);
        else {
          ws.pause();
          ws.setTime(sel.start);
        }
      }
    });
    ws.on("finish", () => {
      // Loop the whole clip when there's no selection.
      if (latest.current.loop && !latest.current.selection) {
        ws.setTime(0);
        ws.play();
      } else latest.current.onPlayingChange(false);
    });
    ws.on("play", () => latest.current.onPlayingChange(true));
    ws.on("pause", () => latest.current.onPlayingChange(false));

    return () => ws.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)load audio when the file changes.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !url) return;
    readyRef.current = false;
    regionsRef.current?.clearRegions();
    selRegionRef.current = null;
    ws.load(url).catch(() => {
      /* decode errors are reported by the backend, which decodes the same file */
    });
  }, [url]);

  useEffect(() => syncSelection(selection), [selection]);
  useEffect(() => syncMarkers(markers), [markers]);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws && readyRef.current) ws.zoom(zoom);
  }, [zoom]);

  useImperativeHandle(ref, () => ({
    togglePlay: () => {
      const ws = wsRef.current;
      if (!ws || !readyRef.current) return;
      if (ws.isPlaying()) {
        ws.pause();
        return;
      }
      const sel = latest.current.selection;
      // With a selection, playback always happens inside it.
      if (sel) {
        const t = ws.getCurrentTime();
        if (t < sel.start || t >= sel.end - 0.01) ws.setTime(sel.start);
      }
      ws.play();
    },
    stop: () => {
      const ws = wsRef.current;
      if (!ws) return;
      ws.pause();
      ws.setTime(latest.current.selection?.start ?? 0);
    },
  }));

  return (
    <div className="waveform">
      <div ref={containerRef} />
      <div ref={timelineRef} />
    </div>
  );
});
