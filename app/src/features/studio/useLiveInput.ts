// Live playing: a MIDI keyboard (via the core) or the computer keyboard.
//
// Pitch wheel bends the notes being played, modulation wheel (CC 1) adds vibrato, CC 64
// is the sustain pedal. Other knobs and the transport buttons go to `onControl` first
// (assigned knobs, see useMidi.ts).
//
// Where notes go:
// - piano roll open → that channel, at the note you play (and recorded, if armed);
// - otherwise → drum pads: MIDI note 36 (C2) plays the first channel, 37 the second…
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MidiEvent } from "../../lib/api";
import type { StudioEngine } from "./engine";
import type { Channel, Note, Pattern } from "./song";

/** Computer keyboard → semitones above the octave's C (DAW standard layout). */
export const KEY_MAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};
export const PAD_BASE = 36;

interface Held {
  id: number;
  ch: Channel;
  note: number;
  velocity: number;
  /** Position in the pattern when pressed (recording), else null. */
  start: number | null;
}

/** Turn a recorded press/release into a note on the 16th grid of a looping pattern. */
export function recordedNote(start: number, end: number, steps: number, pitch: number, velocity: number): Note {
  const s = ((Math.round(start) % steps) + steps) % steps;
  let len = end - start;
  if (len < 0) len += steps; // released after the loop wrapped
  return { start: s, length: Math.max(1, Math.min(steps - s, Math.round(len))), pitch, velocity };
}

interface Options {
  active: boolean;
  engine: StudioEngine;
  channels: Channel[];
  pattern: Pattern | undefined;
  /** Channel whose piano roll is open (melodic target), if any. */
  rollChannel: Channel | undefined;
  recording: boolean;
  onRecord: (channelId: string, note: Note) => void;
  /** Knobs and transport buttons; return true if it was used (assigned / learning). */
  onControl?: (ev: Extract<MidiEvent, { kind: "cc" | "transport" }>) => boolean;
}

export function useLiveInput({ active, engine, channels, pattern, rollChannel, recording, onRecord, onControl }: Options) {
  const [octave, setOctave] = useState(4); // computer keyboard: A = C4
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const held = useRef(new Map<string, Held>());
  const sustain = useRef(false);
  const sustained = useRef<string[]>([]);
  // Latest values for the (long-lived) event handlers.
  const cur = useRef({ engine, channels, pattern, rollChannel, recording, onRecord, onControl, active });
  cur.current = { engine, channels, pattern, rollChannel, recording, onRecord, onControl, active };

  const refreshPressed = () => setPressed(new Set([...held.current.values()].map((h) => h.note)));

  const down = useCallback((key: string, note: number, velocity: number) => {
    const c = cur.current;
    if (held.current.has(key)) return;
    const ch = c.rollChannel ?? c.channels[note - PAD_BASE];
    if (!ch) return;
    const pitch = c.rollChannel ? note : ch.rootNote;
    const id = c.engine.noteOn(ch, pitch, velocity);
    const start = c.recording && c.rollChannel && c.pattern ? c.engine.positionIn(c.pattern.id) : null;
    held.current.set(key, { id, ch, note: pitch, velocity, start });
    refreshPressed();
  }, []);

  const release = useCallback((key: string) => {
    const c = cur.current;
    const h = held.current.get(key);
    if (!h) return;
    held.current.delete(key);
    c.engine.noteOff(h.id);
    if (h.start !== null && c.pattern) {
      const end = c.engine.positionIn(c.pattern.id) ?? h.start + 1;
      c.onRecord(h.ch.id, recordedNote(h.start, end, c.pattern.steps, h.note, h.velocity));
    }
    refreshPressed();
  }, []);

  const up = useCallback(
    (key: string) => {
      if (sustain.current && key.startsWith("m")) sustained.current.push(key);
      else release(key);
    },
    [release],
  );

  // MIDI from the core.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      listen<MidiEvent>("midi", (e) => {
        const ev = e.payload;
        if (!cur.current.active) return;
        // Keys are per device (two keyboards can hold the same note).
        if (ev.kind === "on") down(`m${ev.device}|${ev.note}`, ev.note, ev.velocity / 127);
        else if (ev.kind === "off") up(`m${ev.device}|${ev.note}`);
        else if (ev.kind === "bend") cur.current.engine.setBend(ev.value);
        else if (cur.current.onControl?.(ev)) return;
        else if (ev.kind === "cc" && ev.controller === 64) {
          sustain.current = ev.value >= 64;
          if (!sustain.current) sustained.current.splice(0).forEach(release);
        } else if (ev.kind === "cc" && ev.controller === 1) cur.current.engine.setModulation(ev.value / 127);
      })
        .then((f) => (cancelled ? f() : (unlisten = f)))
        .catch(() => {});
    } catch {
      /* outside Tauri: no MIDI */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [down, up, release]);

  // Computer keyboard (only with a piano roll open, so typing elsewhere is unaffected).
  useEffect(() => {
    if (!active || !rollChannel) return;
    const isTyping = (e: KeyboardEvent) => ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      if (e.code === "KeyZ") return setOctave((o) => Math.max(0, o - 1));
      if (e.code === "KeyX") return setOctave((o) => Math.min(8, o + 1));
      const semi = KEY_MAP[e.code];
      if (semi === undefined) return;
      e.preventDefault();
      down(`k${e.code}`, (octave + 1) * 12 + semi, 0.8);
    };
    const onUp = (e: KeyboardEvent) => {
      if (KEY_MAP[e.code] !== undefined) up(`k${e.code}`);
    };
    // Releasing everything when the window loses focus avoids stuck notes.
    const onBlur = () => [...held.current.keys()].forEach(release);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, rollChannel, octave, down, up, release]);

  return { octave, pressed };
}
