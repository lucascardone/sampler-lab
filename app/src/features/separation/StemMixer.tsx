// Audition separated stems together, in sync, with solo/mute per stem (Web Audio).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { StemFile } from "../../lib/api";

interface Props {
  stems: StemFile[];
  stemName: (stem: string) => string;
  kept: Set<string>;
  busy: boolean;
  onKeep: (stem: StemFile) => void;
}

interface Track {
  stem: StemFile;
  buffer: AudioBuffer;
  peak: number;
}

export function StemMixer({ stems, stemName, kept, busy, onKeep }: Props) {
  const { t } = useTranslation();
  const ctxRef = useRef<AudioContext | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const nodes = useRef<{ src: AudioBufferSourceNode; gain: GainNode; stem: string }[]>([]);

  // Load and decode every stem.
  useEffect(() => {
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    let alive = true;
    Promise.all(
      stems.map(async (stem) => {
        const data = await fetch(convertFileSrc(stem.path)).then((r) => r.arrayBuffer());
        const buffer = await ctx.decodeAudioData(data);
        let peak = 0;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const ch = buffer.getChannelData(c);
          for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
        }
        return { stem, buffer, peak };
      }),
    ).then((t) => alive && setTracks(t));
    return () => {
      alive = false;
      stopAll();
      ctx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems]);

  // Bring the stem list into view once it's loaded.
  useEffect(() => {
    if (tracks.length) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [tracks.length]);

  const audible = (stem: string) => (solo ? solo === stem : !muted.has(stem));

  // Apply solo/mute live while playing.
  useEffect(() => {
    for (const n of nodes.current) n.gain.gain.setTargetAtTime(audible(n.stem) ? 1 : 0, n.gain.context.currentTime, 0.01);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, solo]);

  function stopAll() {
    for (const n of nodes.current) {
      n.src.onended = null;
      try {
        n.src.stop();
      } catch {
        /* already stopped */
      }
    }
    nodes.current = [];
    setPlaying(false);
  }

  function play() {
    const ctx = ctxRef.current;
    if (!ctx || !tracks.length) return;
    stopAll();
    ctx.resume();
    const when = ctx.currentTime + 0.05; // start all in the same instant
    nodes.current = tracks.map((tr) => {
      const src = ctx.createBufferSource();
      src.buffer = tr.buffer;
      src.loop = loop;
      const gain = ctx.createGain();
      gain.gain.value = audible(tr.stem.stem) ? 1 : 0;
      src.connect(gain).connect(ctx.destination);
      src.start(when);
      return { src, gain, stem: tr.stem.stem };
    });
    nodes.current[0].src.onended = () => setPlaying(false);
    setPlaying(true);
  }

  const toggleMute = (stem: string) =>
    setMuted((m) => {
      const n = new Set(m);
      if (n.has(stem)) n.delete(stem);
      else n.add(stem);
      return n;
    });

  if (!tracks.length) return <p className="muted">{t("separation.loadingStems")}</p>;

  return (
    <div className="mixer" ref={rootRef}>
      <div className="mixer-transport">
        <button className="play" onClick={() => (playing ? stopAll() : play())}>
          <Icon name={playing ? "stop" : "play"} /> {playing ? t("separation.stop") : t("separation.playStems")}
        </button>
        <label className="check">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} disabled={playing} />
          {t("transport.loopShort")}
        </label>
      </div>
      <ul>
        {tracks.map(({ stem, peak }) => {
          const on = audible(stem.stem);
          return (
            <li key={stem.stem} className={on ? "" : "off"}>
              <span className="stem-name">{stemName(stem.stem)}</span>
              <span className="meter" title={t("separation.levelHint")}>
                <span style={{ width: `${Math.min(100, peak * 100)}%` }} />
              </span>
              <button
                className={`icon toggle ${solo === stem.stem ? "active" : ""}`}
                onClick={() => setSolo((s) => (s === stem.stem ? null : stem.stem))}
                title={t("separation.soloHint")}
              >
                S
              </button>
              <button
                className={`icon toggle ${muted.has(stem.stem) ? "active" : ""}`}
                onClick={() => toggleMute(stem.stem)}
                title={t("separation.muteHint")}
              >
                M
              </button>
              <button className={kept.has(stem.stem) ? "" : "primary"} disabled={busy || kept.has(stem.stem)} onClick={() => onKeep(stem)}>
                {kept.has(stem.stem) ? t("separation.kept") : <><Icon name="plus" /> {t("separation.keep")}</>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
