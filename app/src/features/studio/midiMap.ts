// Knobs, faders and buttons of a MIDI controller → things in the song.
//
// The user picks a target ("Tempo", "Eco de Bombo"…), moves a knob and they're linked
// ("Aprender"). Links are per device + controller number and live on this PC (they
// describe the hardware, not the song). Pure: the hook in useMidi.ts does the I/O.
import { mixOf, setMix, type Song } from "./song";

export type MidiTarget =
  | { kind: "bpm" }
  | { kind: "swing" }
  | { kind: "master" }
  | { kind: "volume"; channelId: string }
  | { kind: "reverb"; channelId: string }
  | { kind: "delay"; channelId: string }
  | { kind: "play" }
  | { kind: "record" };

export interface MidiBinding {
  device: string;
  cc: number;
  target: MidiTarget;
}

export const BPM_RANGE = [60, 180] as const;

/** Buttons fire on press; knobs follow the value. */
export function isButton(t: MidiTarget): boolean {
  return t.kind === "play" || t.kind === "record";
}

export function sameTarget(a: MidiTarget, b: MidiTarget): boolean {
  return a.kind === b.kind && ("channelId" in a ? a.channelId : "") === ("channelId" in b ? b.channelId : "");
}

export function targetKey(t: MidiTarget): string {
  return "channelId" in t ? `${t.kind}:${t.channelId}` : t.kind;
}

export function parseTargetKey(key: string): MidiTarget | null {
  const [kind, channelId] = key.split(":");
  if (kind === "volume" || kind === "reverb" || kind === "delay") return channelId ? { kind, channelId } : null;
  if (kind === "bpm" || kind === "swing" || kind === "master" || kind === "play" || kind === "record") return { kind };
  return null;
}

export function findBinding(list: MidiBinding[], device: string, cc: number): MidiBinding | undefined {
  return list.find((b) => b.device === device && b.cc === cc);
}

/** Link a control to a target. A control drives one target, a target one control. */
export function bind(list: MidiBinding[], device: string, cc: number, target: MidiTarget): MidiBinding[] {
  const rest = list.filter((b) => !(b.device === device && b.cc === cc) && !sameTarget(b.target, target));
  return [...rest, { device, cc, target }];
}

export function unbind(list: MidiBinding[], target: MidiTarget): MidiBinding[] {
  return list.filter((b) => !sameTarget(b.target, target));
}

/** Read saved links, dropping anything malformed. */
export function normalizeBindings(raw: unknown): MidiBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: MidiBinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { device, cc, target } = r as Record<string, unknown>;
    if (typeof device !== "string" || typeof cc !== "number" || !Number.isInteger(cc) || cc < 0 || cc > 127) continue;
    const t = target && typeof target === "object" ? parseTargetKey(targetKey(target as MidiTarget)) : null;
    if (t) out.push({ device, cc, target: t });
  }
  return out;
}

/** True if the target still exists in this song (its channel wasn't deleted). */
export function targetExists(song: Song, t: MidiTarget): boolean {
  return !("channelId" in t) || song.channels.some((c) => c.id === t.channelId);
}

const round = (x: number, step: number) => Math.round(x / step) * step;

/**
 * The song with a knob at `value` (0..127) applied to `target`. Channel targets change
 * the mix of the pattern being edited. Null if nothing changes (button, missing channel,
 * same value).
 */
export function applyKnob(song: Song, target: MidiTarget, value: number): Song | null {
  const v = Math.max(0, Math.min(127, value)) / 127;
  switch (target.kind) {
    case "bpm": {
      const bpm = Math.round(BPM_RANGE[0] + v * (BPM_RANGE[1] - BPM_RANGE[0]));
      return bpm === song.bpm ? null : { ...song, bpm };
    }
    case "swing": {
      const swing = round(v, 0.01);
      return swing === song.swing ? null : { ...song, swing };
    }
    case "master": {
      const masterVolume = round(v, 0.01);
      return masterVolume === song.masterVolume ? null : { ...song, masterVolume };
    }
    case "volume":
    case "reverb":
    case "delay": {
      if (!targetExists(song, target)) return null;
      const scope = song.currentPatternId || null;
      const m = mixOf(song, scope, target.channelId);
      const x = round(v, 0.01);
      if (target.kind === "volume") return x === m.volume ? null : setMix(song, scope, target.channelId, { volume: x });
      if (m.fx[target.kind] === x) return null;
      return setMix(song, scope, target.channelId, { fx: { ...m.fx, [target.kind]: x } });
    }
    default:
      return null;
  }
}
