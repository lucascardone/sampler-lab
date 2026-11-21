// MIDI devices and assigned knobs for the studio.
//
// - Every plugged-in device is used, unless switched off in the MIDI dialog. The list is
//   re-synced every couple of seconds so plugging/unplugging needs no clicks.
// - Knob links (midiMap.ts) and switched-off devices are remembered on this PC
//   (localStorage): they describe the hardware, not the song.
// - Transport buttons (MMC / Start-Stop) always work; a knob or button linked to
//   Play or Grabar works too.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MidiDevice, type MidiEvent } from "../../lib/api";
import { applyKnob, bind, findBinding, isButton, normalizeBindings, unbind, type MidiBinding, type MidiTarget } from "./midiMap";
import type { SongStore } from "./useSong";

const OFF_KEY = "sampler-lab.midi.off";
const MAP_KEY = "sampler-lab.midi.map";
const POLL_MS = 2000;

export type TransportCmd = "play" | "stop" | "toggle" | "record";

function load<T>(key: string, read: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? read(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered, that's all */
  }
}

interface Options {
  update: SongStore["update"];
  onTransport: (cmd: TransportCmd) => void;
  /** A knob was just linked (for a confirmation message). */
  onLearned: (b: MidiBinding) => void;
}

export function useMidi({ update, onTransport, onLearned }: Options) {
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  const [off, setOff] = useState<string[]>(() =>
    load(OFF_KEY, (r) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []), []),
  );
  const [bindings, setBindings] = useState<MidiBinding[]>(() => load(MAP_KEY, normalizeBindings, []));
  const [learning, setLearning] = useState<MidiTarget | null>(null);
  const cur = useRef({ off, bindings, learning, update, onTransport, onLearned });
  cur.current = { off, bindings, learning, update, onTransport, onLearned };

  const sync = useCallback((retry = false) => {
    api
      .midiSync(cur.current.off, retry)
      .then((list) => setDevices((old) => (JSON.stringify(old) === JSON.stringify(list) ? old : list)))
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    sync();
    const id = window.setInterval(() => sync(), POLL_MS);
    return () => window.clearInterval(id);
  }, [sync, off]);

  const setUsed = useCallback((name: string, used: boolean) => {
    setOff((o) => {
      const next = used ? o.filter((n) => n !== name) : [...new Set([...o, name])];
      save(OFF_KEY, next);
      return next;
    });
  }, []);

  const changeBindings = useCallback((fn: (l: MidiBinding[]) => MidiBinding[]) => {
    setBindings((l) => {
      const next = fn(l);
      save(MAP_KEY, next);
      return next;
    });
  }, []);

  const forget = useCallback((t: MidiTarget) => changeBindings((l) => unbind(l, t)), [changeBindings]);

  /** Knobs and transport buttons from useLiveInput. True = used here. */
  const handleControl = useCallback(
    (ev: Extract<MidiEvent, { kind: "cc" | "transport" }>): boolean => {
      const c = cur.current;
      if (ev.kind === "transport") {
        c.onTransport(ev.action);
        return true;
      }
      if (c.learning) {
        // Buttons send 0 when let go: link on the press.
        if (isButton(c.learning) && ev.value === 0) return true;
        const b: MidiBinding = { device: ev.device, cc: ev.controller, target: c.learning };
        changeBindings((l) => bind(l, b.device, b.cc, b.target));
        setLearning(null);
        c.onLearned(b);
        return true;
      }
      const b = findBinding(c.bindings, ev.device, ev.controller);
      if (!b) return false;
      if (isButton(b.target)) {
        if (ev.value >= 64) c.onTransport(b.target.kind === "play" ? "toggle" : "record");
        return true;
      }
      // One undo step per knob turn.
      c.update((s) => applyKnob(s, b.target, ev.value) ?? s, `midi-${b.device}-${b.cc}`);
      return true;
    },
    [changeBindings],
  );

  return { devices, off, setUsed, bindings, forget, learning, setLearning, handleControl, retry: () => sync(true) };
}

export type MidiStore = ReturnType<typeof useMidi>;
