// Piano roll for one channel in the current pattern: draw notes and chords, insert
// progressions in the song's key, arpeggiate. Works for samples (repitched from the
// channel's root note), drums and the built-in synth. The "Deslizar" tool makes a note
// glide in from the one before; "Transformar" rewrites all the notes in one click.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { Dropdown, Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { KeyPicker } from "./NotePickers";
import { padColor } from "./colors";
import { MAX_GLIDE, STEPS_PER_BAR, STEPS_PER_BEAT, displayNotes, glideFrom, setNotes, type Channel, type Note, type Pattern, type Song } from "./song";
import { TRANSFORM_GROUPS, transformNotes, type TransformId } from "./transform";
import {
  PROGRESSIONS,
  arpeggiate,
  detectChord,
  diatonicChord,
  inScale,
  isBlackKey,
  noteName,
  progressionLabel,
  progressionNotes,
  type ArpMode,
} from "./theory";
import type { SongStore } from "./useSong";

const LOW = 24; // C1
const HIGH = 96; // C7
const ROW_H = 14;
/** Column width per 16th: stretches to fill the panel (easier to hit), within limits. */
const MIN_COL = 22;
const MAX_COL = 56;
const PITCHES = Array.from({ length: HIGH - LOW + 1 }, (_, i) => HIGH - i);

const LENGTHS = [1, 2, 4, 8, 16, 32]; // 1/16 … 2 bars
const EVERY = [8, 16, 32];
/** Glide speeds (steps); MAX_GLIDE = the whole note. */
const GLIDES = [1, 2, 4, MAX_GLIDE];
const ARPS: { mode: ArpMode; rate: number }[] = [
  { mode: "up", rate: 1 },
  { mode: "up", rate: 2 },
  { mode: "down", rate: 1 },
  { mode: "upDown", rate: 1 },
];

interface Props {
  song: Song;
  pattern: Pattern;
  channel: Channel;
  playStep: number | null;
  update: SongStore["update"];
  onPreviewNote: (midi: number) => void;
  /** Live recording into this channel (while playing). */
  recording: boolean;
  onToggleRecord: () => void;
  /** Computer-keyboard octave and the notes being held (highlighted on the keys). */
  kbOctave: number;
  pressed: Set<number>;
}

type Drag = {
  kind: "move" | "resize";
  idx: number[];
  base: Note[];
  origin: { step: number; pitch: number };
  key: string;
  last: string;
};

export function PianoRoll({
  song,
  pattern,
  channel,
  playStep,
  update,
  onPreviewNote,
  recording,
  onToggleRecord,
  kbOctave,
  pressed,
}: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<"note" | "chord" | "glide">(channel.sound.kind === "synth" && channel.sound.preset === "pad" ? "chord" : "note");
  const [noteLen, setNoteLen] = useState(4);
  const [chordSize, setChordSize] = useState<3 | 4>(3);
  const [inversion, setInversion] = useState(0);
  const [every, setEvery] = useState(16);
  const [glideLen, setGlideLen] = useState(2);
  const [rootsOnly, setRootsOnly] = useState(channel.sound.kind === "synth" && (channel.sound.preset === "sub" || channel.sound.preset === "bass"));
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const strokes = useRef(0);

  // Steps show up as notes; the first edit turns them into real notes.
  const notes = displayNotes(pattern, channel);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const steps = pattern.steps;
  const [COL_W, setColW] = useState(MIN_COL);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () => setColW(Math.max(MIN_COL, Math.min(MAX_COL, Math.floor((el.clientWidth - 56) / steps))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [steps]);
  const isSample = channel.sound.kind !== "synth";

  const setAll = (list: Note[], key?: string) => update((s) => setNotes(s, pattern.id, channel.id, list), key);

  // Scroll to where the music is (or the root note) when opening a channel, and bring
  // the roll into view.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ps = notesRef.current.map((n) => n.pitch);
    const center = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : channel.rootNote;
    el.scrollTop = (HIGH - center) * ROW_H - el.clientHeight / 2;
  }, [channel.id, channel.rootNote]);

  useEffect(() => {
    const end = () => {
      const d = drag.current;
      if (!d) return;
      // Remember the length of the note you just drew/resized/picked, like most DAWs.
      const n = notesRef.current[d.idx[0]];
      if (n) setNoteLen(n.length);
      drag.current = null;
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  const posOf = (e: React.PointerEvent) => {
    const r = gridRef.current!.getBoundingClientRect();
    const step = Math.max(0, Math.min(steps - 1, Math.floor((e.clientX - r.left) / COL_W)));
    const pitch = Math.max(LOW, Math.min(HIGH, HIGH - Math.floor((e.clientY - r.top) / ROW_H)));
    return { step, pitch };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gridRef.current?.setPointerCapture(e.pointerId);
    const pos = posOf(e);
    const key = `roll-${++strokes.current}`;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (el) {
      const i = Number(el.dataset.i);
      const n = notes[i];
      if (tool === "glide") {
        // Toggle: a plain note starts gliding in; a gliding note goes back to normal.
        setAll(notes.map((m, k) => (k !== i ? m : m.glide ? withoutGlide(m) : { ...m, glide: glideLen })), key);
        onPreviewNote(n.pitch);
        return;
      }
      const resize = e.clientX > el.getBoundingClientRect().right - 7;
      drag.current = { kind: resize ? "resize" : "move", idx: [i], base: [n], origin: pos, key, last: "" };
      if (!resize) onPreviewNote(n.pitch);
      return;
    }
    const length = Math.min(noteLen, steps - pos.step);
    const pitches = tool === "chord" ? diatonicChord(pos.pitch, song.key, song.scale, chordSize, inversion) : [pos.pitch];
    const added: Note[] = pitches
      .filter((p) => p <= 127)
      .map((pitch) => (tool === "glide" ? { start: pos.step, length, pitch, velocity: 0.8, glide: glideLen } : { start: pos.step, length, pitch, velocity: 0.8 }));
    setAll([...notes, ...added], key);
    pitches.forEach(onPreviewNote);
    drag.current = {
      kind: "move",
      idx: added.map((_, k) => notes.length + k),
      base: added,
      origin: pos,
      key,
      last: "0,0",
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = posOf(e);
    const cur = notesRef.current;
    if (d.kind === "resize") {
      const b = d.base[0];
      const length = Math.max(1, Math.min(steps - b.start, pos.step - b.start + 1));
      const sig = String(length);
      if (sig === d.last) return;
      d.last = sig;
      setAll(cur.map((n, i) => (i === d.idx[0] ? { ...n, length } : n)), d.key);
      return;
    }
    const minStart = Math.min(...d.base.map((n) => n.start));
    const maxEnd = Math.max(...d.base.map((n) => n.start + n.length));
    const ds = Math.max(-minStart, Math.min(steps - maxEnd, pos.step - d.origin.step));
    const lo = Math.min(...d.base.map((n) => n.pitch));
    const hi = Math.max(...d.base.map((n) => n.pitch));
    const dp = Math.max(LOW - lo, Math.min(HIGH - hi, pos.pitch - d.origin.pitch));
    const sig = `${ds},${dp}`;
    if (sig === d.last) return;
    const pitchMoved = !d.last.endsWith(`,${dp}`);
    d.last = sig;
    setAll(
      cur.map((n, i) => {
        const k = d.idx.indexOf(i);
        return k < 0 ? n : { ...d.base[k], start: d.base[k].start + ds, pitch: d.base[k].pitch + dp };
      }),
      d.key,
    );
    if (pitchMoved) onPreviewNote(d.base[0].pitch + dp);
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (el) setAll(notes.filter((_, i) => i !== Number(el.dataset.i)));
  };

  const insertProgression = (index: number) => {
    setAll(
      progressionNotes({ key: song.key, scale: song.scale, degrees: PROGRESSIONS[index], every, steps, size: chordSize, rootsOnly }),
    );
  };
  const arp = (index: number) => {
    const a = ARPS[index];
    setAll(arpeggiate(notes, a.rate, a.mode));
  };
  const transform = (id: TransformId) => {
    setAll(transformNotes(notes, id, { steps, key: song.key, scale: song.scale, glide: glideLen }));
  };
  const octave = (d: number) => {
    if (notes.some((n) => n.pitch + d < LOW || n.pitch + d > HIGH)) return;
    setAll(notes.map((n) => ({ ...n, pitch: n.pitch + d })));
  };

  // Chord names above the grid: notes that start together and form a chord.
  const byStart = new Map<number, number[]>();
  for (const n of notes) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n.pitch]);
  const chordLabels = [...byStart].flatMap(([start, ps]) => {
    const name = detectChord(ps);
    return name ? [{ start, name }] : [];
  });

  const rowClass = (p: number) =>
    [
      isBlackKey(p) ? "black" : "white",
      inScale(p, song.key, song.scale) ? "in-scale" : "",
      (p - song.key) % 12 === 0 ? "tonic" : "",
      p === channel.rootNote && isSample ? "root" : "",
    ].join(" ");

  // Glide curves: from the pitch of the note before (at this note's start) into this
  // note's pitch, drawn as the same glowing tube as the notes so a slide reads as one line.
  const rowY = (p: number) => (HIGH - Math.max(LOW, Math.min(HIGH, p))) * ROW_H + ROW_H / 2;
  const slideFrom = notes.map((n, i) => (n.glide ? glideFrom(notes, i) : n.pitch));
  const glides = notes.flatMap((n, i) =>
    n.glide && slideFrom[i] !== n.pitch
      ? [{ i, x0: n.start * COL_W, y0: rowY(slideFrom[i]), x1: (n.start + Math.min(n.glide, n.length)) * COL_W, y1: rowY(n.pitch), alpha: velAlpha(n.velocity) }]
      : [],
  );
  const width = steps * COL_W;
  return (
    <section className="piano-roll" style={{ "--ch": padColor(channel.id) } as React.CSSProperties}>
      <header className="pr-toolbar">
        <div className="pr-row">
          <Segmented
            label={t("roll.tool")}
            value={tool}
            onChange={setTool}
            className="pr-tools"
            options={[
              { value: "note", label: <><Icon name="note" /> {t("roll.toolNote")}</>, hint: t("roll.toolNoteHint") },
              { value: "chord", label: <><Icon name="piano" /> {t("roll.toolChord")}</>, hint: t("roll.toolChordHint") },
              { value: "glide", label: <><Icon name="glide" /> {t("roll.toolGlide")}</>, hint: t("roll.toolGlideHint") },
            ]}
          />
          {tool === "chord" && (
            <>
              <Segmented
                label={t("roll.chordType")}
                value={chordSize}
                onChange={setChordSize}
                options={[
                  { value: 3 as const, label: t("roll.triad"), hint: t("roll.triadHint") },
                  { value: 4 as const, label: t("roll.seventh"), hint: t("roll.seventhHint") },
                ]}
              />
              <Segmented
                label={t("roll.inversionHint")}
                value={inversion}
                onChange={setInversion}
                options={[0, 1, 2].map((i) => ({ value: i, label: t(`roll.inversion${i}`), hint: t("roll.inversionHint") }))}
              />
            </>
          )}
          {tool === "glide" && (
            <span className="pr-opt">
              <span className="muted">{t("roll.glideSpeed")}</span>
              <Segmented
                label={t("roll.glideSpeed")}
                value={glideLen}
                onChange={setGlideLen}
                options={GLIDES.map((g) => ({ value: g, label: t(`roll.glides.${g === MAX_GLIDE ? "whole" : g}`), hint: t("roll.glideHint") }))}
              />
            </span>
          )}
        </div>
        <div className="pr-row">
          <Picker
            prefix={t("roll.length")}
            label={t("roll.lengthHint")}
            title={t("roll.lengthTitle")}
            value={noteLen}
            columns={3}
            display={LENGTHS.includes(noteLen) ? t(`roll.lenShort.${noteLen}`) : t("roll.steps", { count: noteLen })}
            groups={[{ options: LENGTHS.map((l) => ({ value: l, label: t(`roll.lenShort.${l}`), desc: t(`roll.lenDesc.${l}`) })) }]}
            onPick={setNoteLen}
          />
          <KeyPicker keyPc={song.key} scale={song.scale} onChange={(key, scale) => update((s) => ({ ...s, key, scale }))} />
          <Dropdown icon="sparkle" display={t("roll.tools")} label={t("roll.toolsHint")} title={t("roll.tools")} panelClass="chords-panel">
            {(close) => (
              <>
                <div className="picker-group">
                  <span className="picker-group-title">{t("roll.progressionLabel")}</span>
                  <p className="muted small picker-note">{t("roll.progressionHint")}</p>
                  <div className="pr-opt">
                    <span className="muted">{t("roll.every")}</span>
                    <Segmented label={t("roll.every")} value={every} onChange={setEvery} options={EVERY.map((x) => ({ value: x, label: t(`roll.lenShort.${x}`) }))} />
                  </div>
                  <label className="check" title={t("roll.rootsOnlyHint")}>
                    <input type="checkbox" checked={rootsOnly} onChange={(e) => setRootsOnly(e.target.checked)} />
                    {t("roll.rootsOnly")}
                  </label>
                  <div className="picker-grid prog-grid">
                    {PROGRESSIONS.map((p, i) => {
                      const [roman, names] = progressionLabel(p, song.key, song.scale).split("·").map((x) => x.trim());
                      return (
                        <button
                          key={i}
                          type="button"
                          className="picker-opt"
                          onClick={() => {
                            insertProgression(i);
                            close();
                          }}
                        >
                          <strong>{names ?? roman}</strong>
                          {names && <span className="picker-desc">{roman}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="picker-group">
                  <span className="picker-group-title">{t("roll.arpLabel")}</span>
                  <div className="picker-grid arp-grid">
                    {ARPS.map((a, i) => (
                      <button key={i} type="button" className="picker-opt" disabled={!notes.length} onClick={() => arp(i)} title={t("roll.arpHint")}>
                        <strong>{t(`roll.arps.${a.mode}`)}</strong>
                        <span className="picker-desc">{t(`roll.len.${a.rate}`)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="picker-group">
                  <span className="picker-group-title">{t("roll.allNotes")}</span>
                  <div className="menu-row">
                    <button disabled={!notes.length} onClick={() => octave(-12)}>
                      {t("roll.octaveDown")}
                    </button>
                    <button disabled={!notes.length} onClick={() => octave(12)}>
                      {t("roll.octaveUp")}
                    </button>
                    <button className="danger" disabled={!notes.length} onClick={() => setAll([])}>
                      <Icon name="trash" /> {t("roll.clear")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </Dropdown>
          <Dropdown icon="wave" display={t("roll.tf.title")} label={t("roll.tf.hint")} title={t("roll.tf.title")} panelClass="tf-panel">
            {() => (
              <>
                <p className="muted small picker-note">{notes.length ? t("roll.tf.intro") : t("roll.tf.empty")}</p>
                {TRANSFORM_GROUPS.map((g) => (
                  <div key={g.id} className="picker-group">
                    <span className="picker-group-title">{t(`roll.tf.groups.${g.id}`)}</span>
                    <div className="picker-grid tf-items">
                      {g.items.map((id) => (
                        <button key={id} type="button" className="tf-item" disabled={!notes.length} onClick={() => transform(id)}>
                          <strong>{t(`roll.tf.items.${id}.name`)}</strong>
                          <span className="small">{t(`roll.tf.items.${id}.desc`)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </Dropdown>
          <div className="spacer" />
          <button className={`rec-btn ${recording ? "on" : ""}`} aria-pressed={recording} onClick={onToggleRecord} title={t("roll.recordHint")}>
            <Icon name="record" size={12} /> {recording ? t("roll.recording") : t("roll.record")}
          </button>
        </div>
      </header>

      <div className="pr-scroll" ref={scrollRef}>
        <div className="pr-body" style={{ width: width + 52 }}>
          <div className="pr-corner" />
          <div className="pr-ruler" style={{ width }}>
            {Array.from({ length: steps / STEPS_PER_BAR }, (_, b) => (
              <span key={b} className="pr-bar" style={{ left: b * STEPS_PER_BAR * COL_W }}>
                {b + 1}
              </span>
            ))}
            {chordLabels.map((c) => (
              <span key={c.start} className="pr-chord" style={{ left: c.start * COL_W }}>
                {c.name}
              </span>
            ))}
          </div>
          <div className="pr-keys">
            {PITCHES.map((p) => (
              <div key={p} className={`pr-key ${rowClass(p)} ${pressed.has(p) ? "pressed" : ""}`} onPointerDown={() => onPreviewNote(p)} title={noteName(p)}>
                {p % 12 === 0 || (p === channel.rootNote && isSample) ? noteName(p) : ""}
              </div>
            ))}
          </div>
          <div
            ref={gridRef}
            className={`pr-grid tool-${tool}`}
            style={
              {
                width,
                height: PITCHES.length * ROW_H,
                "--col": `${COL_W}px`,
                "--beat": `${COL_W * STEPS_PER_BEAT}px`,
                "--bar": `${COL_W * STEPS_PER_BAR}px`,
              } as React.CSSProperties
            }
            onPointerDown={onDown}
            onPointerMove={onMove}
            onContextMenu={onContext}
          >
            {PITCHES.map((p) => (
              <div key={p} className={`pr-row ${rowClass(p)}`} style={{ height: ROW_H }} />
            ))}
            <div className="pr-lines" />
            <svg className="pr-glides" width={width} height={PITCHES.length * ROW_H} aria-hidden="true">
              {glides.map((g) => (
                <g key={g.i} style={{ opacity: g.alpha }}>
                  <path d={`M${g.x0} ${g.y0} C${g.x0 + (g.x1 - g.x0) * 0.55} ${g.y0} ${g.x1 - (g.x1 - g.x0) * 0.55} ${g.y1} ${g.x1} ${g.y1}`} />
                  <circle className="pr-glide-start" cx={g.x0} cy={g.y0} r={3.5} />
                  <circle className="pr-glide-end" cx={g.x1} cy={g.y1} r={2.5} />
                </g>
              ))}
            </svg>
            {notes.map((n, i) => {
              const slides = !!n.glide && slideFrom[i] !== n.pitch;
              const gx = slides ? Math.min(n.glide!, n.length) * COL_W : 0;
              const body = n.length * COL_W - 2 - gx;
              return (
                <div
                  key={i}
                  data-i={i}
                  className={`pr-note ${n.glide ? "glide" : ""}`}
                  title={slides ? t("roll.glideNote", { from: noteName(slideFrom[i]), to: noteName(n.pitch) }) : noteName(n.pitch)}
                  style={{ left: n.start * COL_W, top: (HIGH - n.pitch) * ROW_H, width: n.length * COL_W - 1, height: ROW_H }}
                >
                  {body > 4 && (
                    <span className="pr-note-body" style={{ left: gx, opacity: velAlpha(n.velocity) }}>
                      {body >= COL_W * 2 ? noteName(n.pitch) : ""}
                    </span>
                  )}
                </div>
              );
            })}
            {playStep !== null && <div className="pr-playhead" style={{ left: playStep * COL_W }} />}
          </div>
        </div>
      </div>
      <p className="muted small pr-help">
        {t("roll.help")}
        <br />
        {t("roll.keysHint", { note: noteName((kbOctave + 1) * 12) })}
      </p>
    </section>
  );
}

function withoutGlide(n: Note): Note {
  const { glide: _, ...rest } = n;
  return rest;
}

/** Softer notes look fainter. */
const velAlpha = (v: number) => 0.5 + 0.5 * v;
