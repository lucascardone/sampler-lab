// React side of "Tocar juntos": the room state, and the glue between the room's shared
// transport/sounds and the studio's audio engine.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import type { StudioEngine } from "../studio/engine";
import type { PlayMode, Song } from "../studio/song";
import { contextToHost, hostToContext, stepAt } from "./clock";
import { jamRoom, type JamState } from "./room";

export function useJam(): JamState {
  const room = jamRoom();
  return useSyncExternalStore(room.subscribe, room.get);
}

/** What the engine should play: in a room, the shared mode and pattern. */
export function roomPlayback(song: Song, mode: PlayMode, jam: JamState): { song: Song; mode: PlayMode } {
  if (jam.role === "off") return { song, mode };
  const t = jam.transport;
  const pid = t.patternId && song.patterns.some((p) => p.id === t.patternId) ? t.patternId : song.currentPatternId;
  return { song: pid === song.currentPatternId ? song : { ...song, currentPatternId: pid }, mode: t.mode };
}

/**
 * Keep the engine on the room: sounds from the host when this PC is a guest, and
 * play/stop at the right moment, following the room clock.
 */
export function useRoomEngine(engine: StudioEngine, jam: JamState) {
  const room = jamRoom();

  // Guests load sounds from the host.
  const wasGuest = useRef(false);
  const guest = jam.role === "guest" && !jam.joining;
  useEffect(() => {
    if (guest) {
      wasGuest.current = true;
      engine.setRemoteSounds({
        file: (path) => api.jamGuestFetch(path),
        sample: (sessionId, sampleId, stretch) => api.jamGuestCall<{ path: string }>("library_sample_audio", { sessionId, sampleId, stretch: stretch ?? null }),
      });
    } else if (wasGuest.current) {
      wasGuest.current = false;
      engine.setRemoteSounds(null);
    }
  }, [engine, guest]);

  // Shared play / stop.
  const t = jam.transport;
  const inRoom = jam.role !== "off" && !jam.joining;
  // Edits (anyone's) are heard from the next bar while the room plays: same moment everywhere.
  useEffect(() => {
    engine.setBarSync(inRoom);
  }, [engine, inRoom]);
  useEffect(() => {
    if (!inRoom) return;
    if (!t.playing) {
      if (engine.isPlaying()) engine.stop();
      return;
    }
    // Everything is read live: a better clock estimate or a new delay applies at once.
    const follow = (ctxTime: number) => {
      const s = room.get();
      return stepAt(s.transport, contextToHost(ctxTime, room.clockOffset, engine.outputStamp(), performance.timeOrigin, s.delayMs));
    };
    if (engine.isPlaying()) {
      engine.setFollow(follow);
      return;
    }
    const s = room.get();
    const at = hostToContext(t.at, room.clockOffset, engine.outputStamp(), performance.timeOrigin, s.delayMs);
    engine.playAt(at, t.step, follow).catch(() => {});
  }, [engine, room, inRoom, t]);

  // Leaving the room stops the music (each PC goes back to its own song).
  useEffect(() => {
    if (!inRoom) return;
    return () => {
      if (engine.isPlaying()) engine.stop();
    };
  }, [engine, inRoom]);
}

/** Colors of the other people who touched each channel / pattern in the last few seconds. */
export function useFocusMarks(jam: JamState, windowMs = 4000) {
  // Re-render a bit after the last mark so dots fade out.
  const [, force] = useState(0);
  const newest = Math.max(0, ...Object.values(jam.focus).map((f) => f.at));
  useEffect(() => {
    if (!newest) return;
    const left = newest + windowMs - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => force((n) => n + 1), left + 50);
    return () => clearTimeout(id);
  }, [newest, windowMs]);
  const now = Date.now();
  const channels: Record<string, { color: string; name: string }[]> = {};
  const patterns: Record<string, { color: string; name: string }[]> = {};
  for (const [id, f] of Object.entries(jam.focus)) {
    if (Number(id) === jam.me || now - f.at > windowMs) continue;
    const p = jam.peers.find((x) => x.id === Number(id));
    if (!p) continue;
    const mark = { color: p.color, name: p.name };
    for (const c of f.channels) (channels[c] ??= []).push(mark);
    for (const pt of f.patterns) (patterns[pt] ??= []).push(mark);
  }
  return { channels, patterns };
}

