// Song state for the studio: load, autosave, undo/redo.
// In a "Tocar juntos" room (features/jam/room.ts) edits also go to the room, undo only
// reverts your own edits (as ops, not whole-song snapshots), and a guest never saves the
// room's song over its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { BUILTIN_DRUMS, newSong, normalizeSong, type DrumNames, type Song } from "./song";
import { applyOps, diffSong, type Op } from "../jam/ops";
import { jamRoom } from "../jam/room";

const HISTORY_LIMIT = 200;
const SAVE_DELAY_MS = 400;

export interface SongStore {
  song: Song | null;
  /**
   * Apply an edit. Edits with the same `coalesce` key in a row (a slider drag, one
   * paint stroke) become a single undo step.
   */
  update: (fn: (s: Song) => Song, coalesce?: string, opts?: { history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Take a song saved elsewhere (the other device) as the current one: no undo step and
   * no save back (saving it again would bounce between PC and phone forever).
   */
  replace: (raw: unknown) => void;
}

export function useSong(onError: (e: unknown) => void, onSaved?: (result: unknown) => void): SongStore {
  const { t } = useTranslation();
  const [song, setSong] = useState<Song | null>(null);
  const past = useRef<Song[]>([]);
  const future = useRef<Song[]>([]);
  const lastKey = useRef<string | undefined>(undefined);
  /** In a room: your own edits as ops. */
  const roomPast = useRef<{ undo: Op[]; redo: Op[] }[]>([]);
  const roomFuture = useRef<{ undo: Op[]; redo: Op[] }[]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    const names = Object.fromEntries(BUILTIN_DRUMS.map((d) => [d, t(`studio.drums.${d}`)])) as DrumNames;
    api
      .songLoad()
      .then((raw) => {
        setSong(normalizeSong(raw) ?? newSong(names, t("studio.patternName", { n: 1 })));
        // A damaged song was recovered from its backup (or set aside): say so. On the
        // phone this command doesn't exist: nothing to show there.
        api
          .songRecoveryNote()
          .then((note) => note && onError(note))
          .catch(() => {});
      })
      .catch((e) => {
        onError(e);
        setSong(newSong(names, t("studio.patternName", { n: 1 })));
      });
    // Load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (debounced). The first value is what we just loaded: no need to write it.
  const loaded = useRef(false);
  const skipSave = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  useEffect(() => {
    if (!song) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    // A guest plays the host's song: its own stays on disk untouched.
    if (jamRoom().role === "guest") return;
    const id = setTimeout(
      () =>
        api
          .songSave(song)
          .then((r) => onSavedRef.current?.(r))
          .catch(onError),
      SAVE_DELAY_MS,
    );
    return () => clearTimeout(id);
  }, [song, onError]);

  const current = useRef(song);
  current.current = song;

  const update = useCallback((fn: (s: Song) => Song, coalesce?: string, opts?: { history?: boolean }) => {
    const prev = current.current;
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
    const room = jamRoom();
    if (room.role !== "off") {
      room.localEdit(prev, next);
      if (opts?.history !== false) {
        const redo = diffSong(prev, next);
        const undo = diffSong(next, prev);
        const top = roomPast.current[roomPast.current.length - 1];
        if (redo.length && top && coalesce && coalesce === lastKey.current) {
          top.redo.push(...redo);
          top.undo = [...undo, ...top.undo];
        } else if (redo.length) {
          roomPast.current = [...roomPast.current.slice(-HISTORY_LIMIT + 1), { undo, redo }];
        }
        roomFuture.current = [];
        lastKey.current = coalesce;
      }
      current.current = next;
      setSong(next);
      return;
    }
    // View changes (which pattern is open) are saved but aren't something to undo.
    if (opts?.history === false) {
      current.current = next;
      setSong(next);
      return;
    }
    if (!(coalesce && coalesce === lastKey.current)) {
      past.current = [...past.current.slice(-HISTORY_LIMIT + 1), prev];
    }
    future.current = [];
    lastKey.current = coalesce;
    current.current = next;
    setSong(next);
  }, []);

  /** Undo/redo change the music, not what you're looking at: keep the open pattern. */
  const keepView = (target: Song, now: Song): Song =>
    target.patterns.some((p) => p.id === now.currentPatternId) ? { ...target, currentPatternId: now.currentPatternId } : target;

  /** Undo / redo in a room: apply your own inverse ops on top of everybody's song. */
  const roomStep = (from: { undo: Op[]; redo: Op[] }[], to: { undo: Op[]; redo: Op[] }[], dir: "undo" | "redo") => {
    const entry = from.pop();
    const now = current.current;
    if (!entry || !now) return;
    to.push(entry);
    lastKey.current = undefined;
    const next = keepView(applyOps(now, entry[dir]), now);
    jamRoom().localEdit(now, next);
    current.current = next;
    setSong(next);
    bump((n) => n + 1);
  };

  const undo = useCallback(() => {
    if (jamRoom().role !== "off") return roomStep(roomPast.current, roomFuture.current, "undo");
    const prev = past.current.pop();
    if (!prev || !current.current) return;
    future.current.push(current.current);
    lastKey.current = undefined;
    const restored = keepView(prev, current.current);
    current.current = restored;
    setSong(restored);
    bump((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    if (jamRoom().role !== "off") return roomStep(roomFuture.current, roomPast.current, "redo");
    const next = future.current.pop();
    if (!next || !current.current) return;
    past.current.push(current.current);
    lastKey.current = undefined;
    const restored = keepView(next, current.current);
    current.current = restored;
    setSong(restored);
    bump((n) => n + 1);
  }, []);

  const replace = useCallback((raw: unknown) => {
    const next = normalizeSong(raw);
    if (!next) return;
    // Keep looking at the same pattern if it still exists.
    const now = current.current;
    const view = now && next.patterns.some((p) => p.id === now.currentPatternId) ? { ...next, currentPatternId: now.currentPatternId } : next;
    skipSave.current = true;
    // The phone saved on the host of a room: its edit goes to the guests too.
    if (now && jamRoom().role === "host") jamRoom().localEdit(now, view);
    current.current = view;
    setSong(view);
  }, []);

  // The room reaches the song through this link.
  useEffect(() => {
    const clear = () => {
      past.current = [];
      future.current = [];
      roomPast.current = [];
      roomFuture.current = [];
      lastKey.current = undefined;
      bump((n) => n + 1);
    };
    jamRoom().attach({
      current: () => current.current,
      fromRoom: (incoming, save) => {
        const now = current.current;
        const view = now ? { ...keepView(incoming, now), nextId: Math.max(incoming.nextId, now.nextId) } : incoming;
        if (!save) skipSave.current = true;
        current.current = view;
        setSong(view);
      },
      saveNow: async () => {
        if (current.current) await api.songSave(current.current).catch(onError);
      },
      reloadOwn: async () => {
        const own = normalizeSong(await api.songLoad().catch(() => null));
        if (!own) return;
        skipSave.current = true;
        current.current = own;
        setSong(own);
      },
      clearHistory: clear,
    });
    return () => jamRoom().attach(null);
  }, [onError]);

  const inRoom = jamRoom().role !== "off";
  return {
    song,
    update,
    undo,
    redo,
    replace,
    canUndo: inRoom ? roomPast.current.length > 0 : past.current.length > 0,
    canRedo: inRoom ? roomFuture.current.length > 0 : future.current.length > 0,
  };
}
