// Effect presets: one click to a different sound. A preset is just a set of effect values
// (volume and pan are never touched). The built-in values are a first guess meant to be
// tuned by ear: each one says what it's going for.
import { NO_FX, normalizeFx, type Channel, type ChannelFx, type Song } from "./song";

export interface FxPreset {
  id: string;
  /** Built-in: i18n key under fx.presets. User preset: its name. */
  name: string;
  builtIn: boolean;
  fx: Partial<ChannelFx>;
  /** "Bombeo" presets: duck to the song's kick (a channel can't be stored in a preset). */
  duckToKick?: boolean;
}

export const BUILTIN_PRESETS: FxPreset[] = [
  // Everything back to zero.
  { id: "none", name: "none", builtIn: true, fx: {} },
  // Old sampler / cassette: fewer bits, dull top, a bit narrower, a little room.
  { id: "lofi", name: "lofi", builtIn: true, fx: { drive: "crush", driveAmount: 0.45, filter: "low", cutoff: 0.62, resonance: 0.15, high: -4, width: 0.6, reverb: 0.15 } },
  // AM radio / phone: only the mids, mono, a bit of grit.
  { id: "radio", name: "radio", builtIn: true, fx: { filter: "high", cutoff: 0.42, resonance: 0.35, drive: "hard", driveAmount: 0.3, low: -8, high: -6, width: 0 } },
  // Bass that fills: warm saturation, more lows, steady level.
  { id: "fatBass", name: "fatBass", builtIn: true, fx: { drive: "soft", driveAmount: 0.45, low: 4, comp: 0.5, filter: "low", cutoff: 0.72, resonance: 0.1 } },
  // Vocals up front with air: brighter, even, a short space.
  { id: "airyVox", name: "airyVox", builtIn: true, fx: { high: 4, mid: 1, comp: 0.45, reverb: 0.3, delay: 0.12, mod: "chorus", modAmount: 0.2 } },
  // Big and far away: wide, lots of reverb and echo, a slow sweep.
  { id: "space", name: "space", builtIn: true, fx: { reverb: 0.55, delay: 0.35, mod: "chorus", modAmount: 0.5, width: 1.6, filter: "low", cutoff: 0.78, move: 0.25, moveRate: 32 } },
  // Raw and aggressive.
  { id: "dirty", name: "dirty", builtIn: true, fx: { drive: "hard", driveAmount: 0.7, mid: 3, comp: 0.4 } },
  // The filter opens and closes with the beat (dubstep "wobble").
  { id: "wobble", name: "wobble", builtIn: true, fx: { filter: "low", cutoff: 0.45, resonance: 0.55, move: 0.8, moveRate: 4, drive: "soft", driveAmount: 0.3 } },
  // Swirly guitar / keys.
  { id: "phase", name: "phase", builtIn: true, fx: { mod: "phaser", modAmount: 0.65, reverb: 0.15 } },
  // Brighter and wider, for hats and pads.
  { id: "bright", name: "bright", builtIn: true, fx: { high: 5, mid: 1, comp: 0.25, width: 1.3 } },
  // Breathes with the kick (sidechain pumping).
  { id: "pump", name: "pump", builtIn: true, fx: { duckAmount: 0.7 }, duckToKick: true },
];

/** The kick of the song to duck to: the built-in kick, else anything called "bombo"/"kick". */
export function findKick(song: Song, except: string): string | null {
  const others = song.channels.filter((c) => c.id !== except);
  const kick =
    others.find((c) => c.sound.kind === "builtin" && c.sound.id === "kick") ??
    others.find((c) => /bombo|kick/i.test(c.name));
  return kick?.id ?? null;
}

/** The channel's effects after applying a preset. Ducking is kept unless the preset sets it. */
export function applyPreset(preset: FxPreset, ch: Channel, song: Song): ChannelFx {
  if (preset.id === "none") return { ...NO_FX };
  const duckBy = preset.duckToKick ? findKick(song, ch.id) : ch.fx.duckBy;
  return { ...NO_FX, ...preset.fx, duckBy, duckAmount: preset.fx.duckAmount ?? ch.fx.duckAmount };
}

/** A user preset from the channel's current effects (without the channel-specific ducking source). */
export function makeUserPreset(name: string, fx: ChannelFx): FxPreset {
  const { duckBy, ...rest } = fx;
  return { id: `user-${Date.now().toString(36)}`, name, builtIn: false, fx: rest, duckToKick: duckBy !== null };
}

/** Saved user presets, validated (bad entries are dropped). */
export function parseUserPresets(raw: unknown): FxPreset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === "object" && typeof p.name === "string" && p.name.trim() && typeof p.id === "string")
    .map((p) => {
      const { duckBy: _drop, ...fx } = normalizeFx(p.fx);
      void _drop;
      return { id: p.id, name: p.name.trim(), builtIn: false, fx, duckToKick: !!p.duckToKick };
    });
}
