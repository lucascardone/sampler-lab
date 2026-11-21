// "Tocar juntos", this PC only: whose part you hear, and when edits reach the speakers.
// Pure helpers (no audio) so they can be unit tested.
import type { Song } from "../studio/song";

/**
 * Who made a channel: the id letters added by that person's PC ("ch12b" → "b").
 * Channels without letters were made by the host (or before the room existed).
 */
export function channelOwner(id: string): string {
  return /\d([a-z]*)$/.exec(id)?.[1] ?? "";
}

/** What this PC chose not to hear. Never sent to the others. */
export interface Hush {
  /** Hear only the channels I made. */
  onlyMine: boolean;
  /** Id letters of the people muted on this PC. */
  people: string[];
}

export const NO_HUSH: Hush = { onlyMine: false, people: [] };

/** Channels this PC keeps quiet, given my own id letters. */
export function hushedChannels(song: Song, mine: string, hush: Hush): Set<string> {
  const out = new Set<string>();
  if (!hush.onlyMine && !hush.people.length) return out;
  for (const ch of song.channels) {
    const owner = channelOwner(ch.id);
    if (owner === mine) continue;
    if (hush.onlyMine || hush.people.includes(owner)) out.add(ch.id);
  }
  return out;
}

/**
 * While the room is playing, a new version of the song is heard from the next bar on, so
 * every PC switches at the same musical moment. Tempo or mode changes can't wait (the room
 * clock already moved), so those switch at once.
 */
export function waitsForBar(current: Song, next: Song): boolean {
  return current.bpm === next.bpm;
}
