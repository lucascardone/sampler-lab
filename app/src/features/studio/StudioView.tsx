// The studio tab. Layout (fits the window, no page scroll):
//   activity | side panel  | transport                                    |
//   bar      | (Sonidos or | editor pane (steps or piano roll of the       | inspector
//            |  Patrones,  |   current pattern)                           | (selection)
//            |  can hide)  | splitter                                     |
//            |             | song pane (timeline)                         |
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type Analysis, type LibrarySession, type PackInfo } from "../../lib/api";
import { PacksDialog } from "../packs/PacksDialog";
import { creditsText, songCredits } from "../packs/credits";
import { type ExportSettings } from "../export/ExportOptions";
import { Icon, IconButton } from "../../ui/Icon";
import { NumberField } from "../../ui/NumberField";
import { isTextEntry } from "../../ui/keys";
import { studioEngine, type Playhead } from "./engine";
import { ExportDialog } from "./ExportDialog";
import { Inspector, type Selection } from "./Inspector";
import { LibraryPanel } from "./LibraryPanel";
import { PatternsPanel } from "./PatternsPanel";
import { StudioSidebar } from "./StudioSidebar";
import { patternColor } from "./colors";
import { songToMidi } from "./smf";
import { useLiveInput } from "./useLiveInput";
import { useMidi } from "./useMidi";
import { MidiButton, MidiDialog, targetLabel } from "./MidiDialog";
import { PianoRoll } from "./PianoRoll";
import { StepGrid } from "./StepGrid";
import { Timeline, type Brush } from "./Timeline";
import {
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  addChannel,
  addClip,
  addPattern,
  channelNotes,
  clearRow,
  duplicatePattern,
  effectiveMode,
  removeChannel,
  removeClip,
  removePattern,
  setNotes,
  setPatternLength,
  stepsFor,
  stepsToNotes,
  updateChannel,
  updateClip,
  updatePattern,
  type Channel,
  type PlayMode,
  type Song,
  type SoundRef,
} from "./song";
import { useSong } from "./useSong";
import { JamBar } from "../jam/JamBar";
import { JamDialog } from "../jam/JamDialog";
import { jamRoom } from "../jam/room";
import { roomPlayback, useFocusMarks, useJam, useRoomEngine } from "../jam/useJam";
import { hushedChannels } from "../jam/hush";

export interface StudioHandle {
  addSound: (sound: SoundRef, name: string) => void;
  openExport: () => void;
}

interface Props {
  active: boolean;
  exportSettings: ExportSettings;
  setExportSettings: (s: ExportSettings) => void;
  onError: (e: unknown) => void;
  onInfo: (text: string) => void;
}

const BAR_OPTIONS = [1, 2, 4, 8];
const NO_CHANNELS = new Set<string>();

/** A channel name usable as a file name on every OS. */
const safeName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "") || "stem";

export const StudioView = forwardRef<StudioHandle, Props>(function StudioView(
  { active, exportSettings, setExportSettings, onError, onInfo },
  ref,
) {
  const { t } = useTranslation();
  const engine = studioEngine();
  const { song, update, undo, redo, replace, canUndo, canRedo } = useSong(onError);

  // The phone saved the song (studio in phone mode): load its version.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    try {
      listen("song-saved-remotely", () => api.songLoad().then(replace).catch(onError))
        .then((f) => (cancelled ? f() : (off = f)))
        .catch(() => {});
    } catch {
      /* outside Tauri */
    }
    return () => {
      cancelled = true;
      off?.();
    };
  }, [replace, onError]);
  const [mode, setModeState] = useState<PlayMode>("pattern");
  // "Tocar juntos": the room decides what sounds, and when.
  const jam = useJam();
  const room = jamRoom();
  const inRoom = jam.role !== "off" && !jam.joining;
  useRoomEngine(engine, jam);
  const marks = useFocusMarks(jam);
  // Whose part this PC doesn't hear (personal; the others still hear everything).
  const mine = inRoom ? room.mine : "";
  const hushed = useMemo(() => (inRoom && song ? hushedChannels(song, mine, jam.hush) : NO_CHANNELS), [inRoom, song, mine, jam.hush]);
  const [jamDialog, setJamDialog] = useState(false);
  const [midiDialog, setMidiDialog] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [tail, setTail] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [songHeight, setSongHeight] = useState(240);
  const mainRef = useRef<HTMLDivElement>(null);
  const [library, setLibrary] = useState<LibrarySession[]>([]);
  const [packs, setPacksState] = useState<PackInfo[]>([]);
  const [packsOpen, setPacksOpen] = useState(false);
  const [head, setHead] = useState<Playhead | null>(null);
  const [rollId, setRollId] = useState<string | null>(null);
  const [startStep, setStartStep] = useState(0);
  const [brushSel, setBrush] = useState<Brush | null>(null);
  const [recording, setRecording] = useState(false);
  /** Analyses of library samples, by "session/sample". */
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => engine.subscribe(rerender), [engine]);
  useEffect(() => {
    if (!song) return;
    const pb = roomPlayback(song, mode, jam);
    engine.setSong(pb.song, pb.mode);
    engine.setHushed(hushed);
  }, [engine, song, mode, jam, hushed]);
  // The room's mode (pattern / song) shows here too.
  useEffect(() => {
    if (inRoom) setModeState(jam.transport.mode);
  }, [inRoom, jam.transport.mode]);
  // Tell the others which pattern you're looking at.
  const viewing = song?.currentPatternId;
  useEffect(() => {
    if (inRoom && viewing) room.view(viewing);
  }, [inRoom, viewing, room]);
  useEffect(() => {
    engine.metronome = metronome;
  }, [engine, metronome]);

  /** New list of installed packs: the engine learns where their files are. */
  const setPacks = useCallback(
    (list: PackInfo[]) => {
      setPacksState(list);
      engine.setPacks(list);
    },
    [engine],
  );

  // A guest sees the host's sounds (the song uses them); everybody else their own.
  const guestLibrary = jam.role === "guest" && !jam.joining;
  const refreshLibrary = useCallback(() => {
    if (guestLibrary) {
      api.jamGuestCall<LibrarySession[]>("library_list").then(setLibrary).catch(onError);
      api.jamGuestCall<PackInfo[]>("packs_list").then(setPacks).catch(onError);
      return;
    }
    api.libraryList().then(setLibrary).catch(onError);
    api.packsList().then(setPacks).catch(onError);
  }, [onError, setPacks, guestLibrary]);
  // Entering or leaving a room, or a friend brought a sound: list again.
  const packsVersion = jam.packsVersion;
  const firstList = useRef(true);
  useEffect(() => {
    if (firstList.current) {
      firstList.current = false;
      return;
    }
    refreshLibrary();
  }, [refreshLibrary, packsVersion]);

  const usesPack = (c: Channel, packId: string) => (c.sound.kind === "pack" || c.sound.kind === "instrument") && c.sound.packId === packId;

  /** "Importar carpeta": the user's own sounds, copied as a pack. */
  const importFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: t("packs.importTitle") });
    if (typeof dir !== "string") return;
    onInfo(t("packs.importing"));
    try {
      const before = new Set(packs.map((p) => p.id));
      const list = await api.packImportFolder(dir, "");
      setPacks(list);
      const added = list.find((p) => !before.has(p.id));
      if (added) onInfo(t("packs.imported", { name: added.name, count: added.items.length }));
    } catch (e) {
      onError(e);
    }
  };

  const renamePack = async (id: string, name: string) => {
    try {
      setPacks(await api.packRename(id, name));
    } catch (e) {
      onError(e);
    }
  };

  /** To the Recycle Bin, after saying which sounds of the song go silent. */
  const deletePack = async (pack: PackInfo) => {
    const users = song?.channels.filter((c) => usesPack(c, pack.id)).map((c) => c.name) ?? [];
    const msg = [t("packs.deleteConfirm", { name: pack.name }), users.length ? t("packs.deleteUsed", { count: users.length, names: users.join(", ") }) : ""]
      .filter(Boolean)
      .join("\n\n");
    if (!(await ask(msg, { kind: "warning", title: t("app.title"), okLabel: t("items.delete"), cancelLabel: t("items.cancel") }))) return;
    try {
      setPacks(await api.packDelete(pack.id));
      onInfo(t("packs.deleted", { name: pack.name }));
    } catch (e) {
      onError(e);
    }
  };

  const usesSample = (c: Channel, sessionId: string, sampleId: string) =>
    c.sound.kind === "sample" && c.sound.sessionId === sessionId && c.sound.sampleId === sampleId;

  /** Rename a library sample; song channels still called by its old name follow along. */
  const renameLibrarySample = async (sessionId: string, sampleId: string, oldName: string, name: string) => {
    try {
      setLibrary(await api.libraryRenameSample(sessionId, sampleId, name));
    } catch (e) {
      return onError(e);
    }
    if (song?.channels.some((c) => usesSample(c, sessionId, sampleId) && c.name === oldName))
      update((s) => ({ ...s, channels: s.channels.map((c) => (usesSample(c, sessionId, sampleId) && c.name === oldName ? { ...c, name } : c)) }));
  };

  /** Delete a library sample for good (warns if the song uses it). */
  const deleteLibrarySample = async (sessionId: string, sampleId: string, name: string) => {
    const users = song?.channels.filter((c) => usesSample(c, sessionId, sampleId)).map((c) => c.name) ?? [];
    const msg = [
      t("studio.deleteSampleConfirm", { name }),
      users.length ? t("studio.deleteSampleUsed", { count: users.length, names: users.join(", ") }) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!(await ask(msg, { kind: "warning", title: t("app.title"), okLabel: t("items.delete"), cancelLabel: t("items.cancel") }))) return;
    try {
      setLibrary(await api.libraryDeleteSample(sessionId, sampleId));
      onInfo(t("studio.sampleDeleted", { name }));
    } catch (e) {
      onError(e);
    }
  };

  // Coming back to the studio: samples may have been edited or added meanwhile.
  useEffect(() => {
    if (!active) return;
    refreshLibrary();
    if (song) engine.loadSounds(song, true);
    // Only on activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Playhead: follow the audio clock while playing.
  const playing = engine.isPlaying();
  useEffect(() => {
    if (!playing) {
      setHead(null);
      return;
    }
    let raf = 0;
    const loop = () => {
      const h = engine.playhead();
      setHead((old) => (old?.songStep === h?.songStep ? old : h));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, playing]);

  const togglePlay = useCallback(() => {
    if (inRoom) {
      const st = room.get().transport;
      room.requestTransport({ playing: !st.playing, mode, patternId: song?.currentPatternId ?? "", fromStep: mode === "song" ? startStep : 0 });
      return;
    }
    if (engine.isPlaying()) engine.stop();
    else engine.play(mode === "song" ? startStep : 0).catch(onError);
  }, [engine, onError, mode, startStep, inRoom, room, song?.currentPatternId]);

  /** Pattern or song mode: for everybody when in a room. */
  const setMode = (m: PlayMode) => {
    setModeState(m);
    if (inRoom) {
      const st = room.get().transport;
      room.requestTransport({ playing: st.playing, mode: m, patternId: st.patternId || (song?.currentPatternId ?? ""), fromStep: m === "song" ? startStep : 0 });
    }
  };

  /** In a room, another pattern may be sounding: make this one sound, for everybody. */
  const playThisPattern = () => {
    const st = room.get().transport;
    if (song) room.requestTransport({ playing: st.playing, mode: "pattern", patternId: song.currentPatternId, fromStep: 0 });
  };

  /** Note, key and tempo of a library sample (cached). */
  const analyze = useCallback(
    async (sound: SoundRef): Promise<Analysis | null> => {
      if (sound.kind !== "sample") return null;
      const key = `${sound.sessionId}/${sound.sampleId}`;
      try {
        // A room guest's samples are the host's: the host analyzes them.
        const a = guestLibrary
          ? await api.jamGuestCall<Analysis>("library_analyze", { sessionId: sound.sessionId, sampleId: sound.sampleId })
          : await api.libraryAnalyze(sound.sessionId, sound.sampleId);
        setAnalyses((m) => ({ ...m, [key]: a }));
        return a;
      } catch {
        return null;
      }
    },
    [guestLibrary],
  );

  /** A new sample channel gets its detected note as root and its tempo ready for warp. */
  const applyAnalysis = useCallback(
    (channelId: string, a: Analysis | null) => {
      if (!a) return;
      const patch: Partial<Channel> = {};
      if (a.pitch && a.pitch.confidence >= 0.6) patch.rootNote = a.pitch.midi;
      if (a.tempo && a.tempo.confidence >= 0.25) patch.warp = { on: false, bpm: a.tempo.bpm };
      if (Object.keys(patch).length) update((s) => updateChannel(s, channelId, patch), `analysis-${channelId}`);
    },
    [update],
  );

  const addSound = useCallback(
    (sound: SoundRef, name: string) => {
      let id = "";
      update((s) => {
        const next = addChannel(s, sound, name);
        id = next.channels[next.channels.length - 1].id;
        return next;
      });
      // Synths are melodic: open their piano roll right away.
      if (sound.kind === "synth" && id) setRollId(id);
      if (id) setSelection({ kind: "channel", id });
      if (sound.kind === "sample" && id) analyze(sound).then((a) => applyAnalysis(id, a));
    },
    [update, analyze, applyAnalysis],
  );

  useImperativeHandle(ref, () => ({ addSound, openExport: () => setExportOpen(true) }), [addSound]);

  /**
   * Put a sample on the timeline as an audio clip (at the start marker, on the first
   * track that's free there). Reuses the sample's channel if it already has one.
   */
  const addToSong = async (sound: SoundRef, name: string) => {
    if (!song || sound.kind !== "sample") return;
    try {
      await engine.ensureSound(sound);
    } catch {
      /* status shows the error; place a 1-bar clip anyway */
    }
    const secs = engine.soundSeconds(sound);
    let channelId = "";
    let isNew = false;
    update((s) => {
      let next: Song = s;
      let ch = s.channels.find(
        (c) => c.sound.kind === "sample" && c.sound.sessionId === sound.sessionId && c.sound.sampleId === sound.sampleId,
      );
      if (!ch) {
        next = addChannel(s, sound, name);
        ch = next.channels[next.channels.length - 1];
        isNew = true;
      }
      channelId = ch.id;
      const length = secs ? stepsFor(ch, secs, s.bpm) : STEPS_PER_BAR;
      const free = next.tracks.find(
        (tr) => !next.clips.some((c) => c.trackId === tr.id && c.start < startStep + length && startStep < c.start + c.length),
      );
      const track = free ?? next.tracks[next.tracks.length - 1];
      setBrush({ kind: "audio", channelId: ch.id });
      return addClip(next, { kind: "audio", channelId: ch.id, trackId: track.id, start: startStep, length });
    });
    setMode("song");
    onInfo(t("timeline.added", { name }));
    if (isNew && channelId) analyze(sound).then((a) => applyAnalysis(channelId, a));
  };

  /**
   * Turn "follow the song tempo" on/off for a sample channel, or change its tempo. Its
   * audio clips are resized to the sound's new length, so a 2-bar loop stays 2 bars.
   */
  const setWarp = (ch: Channel, on: boolean, bpm: number) => {
    const sound = ch.sound;
    const a = sound.kind === "sample" ? analyses[`${sound.sessionId}/${sound.sampleId}`] : undefined;
    const secs = a?.duration ?? engine.soundSeconds(sound);
    update((s) => {
      let next = updateChannel(s, ch.id, { warp: { on: on && bpm > 0, bpm } });
      const updated = next.channels.find((c) => c.id === ch.id)!;
      if (secs) {
        for (const c of next.clips) {
          if (c.kind === "audio" && c.channelId === ch.id) next = updateClip(next, c.id, { length: stepsFor(updated, secs, s.bpm) });
        }
      }
      return next;
    }, `warp-${ch.id}`);
  };

  // Keyboard (only while the studio is visible).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        if (e.key.toLowerCase() === "y" || e.shiftKey) redo();
        else undo();
      } else if (e.key === "Escape") {
        setSelection(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "clip") {
        e.preventDefault();
        const id = selection.id;
        update((s) => removeClip(s, id));
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, togglePlay, undo, redo, selection, update]);

  // MIDI devices, assigned knobs and transport buttons.
  const midi = useMidi({
    update,
    onTransport: (cmd) => {
      if (cmd === "record") {
        if (!rollId) onInfo(t("midi.recordNeedsRoll"));
        else setRecording((r) => !r);
        return;
      }
      if (cmd === "toggle" || (cmd === "play") !== engine.isPlaying()) togglePlay();
    },
    onLearned: (b) => song && onInfo(t("midi.learned", { name: targetLabel(t, song, b.target), cc: b.cc })),
  });

  const livePattern = song?.patterns.find((p) => p.id === song.currentPatternId) ?? song?.patterns[0];
  const live = useLiveInput({
    active,
    engine,
    channels: song?.channels ?? [],
    pattern: livePattern,
    rollChannel: song?.channels.find((c) => c.id === rollId),
    recording,
    onControl: midi.handleControl,
    onRecord: (channelId, note) =>
      update((s) => {
        const withSteps = stepsToNotes(s, s.currentPatternId, channelId);
        const p = withSteps.patterns.find((x) => x.id === s.currentPatternId)!;
        return setNotes(withSteps, p.id, channelId, [...channelNotes(p, channelId), note]);
      }, `rec-${Date.now()}`),
  });

  if (!song) return <main className="studio" />;

  const pattern = song.patterns.find((p) => p.id === song.currentPatternId) ?? song.patterns[0];
  const playStep = head?.patterns[pattern.id] ?? null;
  const rollChannel = song.channels.find((c) => c.id === rollId);
  const songMode = effectiveMode(song, mode) === "song";
  const brush: Brush =
    brushSel &&
    (brushSel.kind === "pattern"
      ? song.patterns.some((p) => p.id === brushSel.patternId)
      : song.channels.some((c) => c.id === brushSel.channelId))
      ? brushSel
      : { kind: "pattern", patternId: pattern.id };
  const bar = head ? Math.floor(head.songStep / STEPS_PER_BAR) + 1 : 1;
  const beat = head ? Math.floor((head.songStep % STEPS_PER_BAR) / STEPS_PER_BEAT) + 1 : 1;

  const removeCh = async (ch: Channel) => {
    if (await ask(t("studio.removeChannelConfirm", { name: ch.name }), { kind: "warning", title: t("app.title") })) {
      update((s) => removeChannel(s, ch.id));
      setSelection(null);
      if (rollId === ch.id) setRollId(null);
    }
  };
  /** The piano roll opens on the selected channel, or the first melodic one. */
  const openRoll = () => {
    const ch =
      selectedChannel ??
      song.channels.find((c) => channelNotes(pattern, c.id).length > 0) ??
      song.channels.find((c) => c.sound.kind !== "builtin") ??
      song.channels[0];
    if (!ch) return;
    setSelection({ kind: "channel", id: ch.id });
    setRollId(ch.id);
  };
  /** Append a pattern (the current one by default) at the end of the song (first track), and play the song. */
  const putInSong = (pid = pattern.id) => {
    const p = song.patterns.find((x) => x.id === pid);
    if (!p) return;
    let id = "";
    update((s) => {
      const track = s.tracks[0];
      const end = Math.max(0, ...s.clips.filter((c) => c.trackId === track.id).map((c) => c.start + c.length));
      id = `clip${s.nextId}`;
      return addClip(s, { kind: "pattern", patternId: p.id, trackId: track.id, start: end, length: p.steps });
    });
    setSelection({ kind: "clip", id });
    setMode("song");
    onInfo(t("studio.putInSongDone", { name: p.name }));
  };
  const editPattern = (pid: string) => {
    update((s) => ({ ...s, currentPatternId: pid }), undefined, { history: false });
    setRollId(null);
  };
  const selectedChannel = selection?.kind === "channel" ? song.channels.find((c) => c.id === selection.id) : undefined;
  const analysisFor = (ch: Channel) => (ch.sound.kind === "sample" ? analyses[`${ch.sound.sessionId}/${ch.sound.sampleId}`] : undefined);
  const detectRoot = (ch: Channel) =>
    analyze(ch.sound).then((a) => {
      if (a?.pitch) {
        update((s) => updateChannel(s, ch.id, { rootNote: a.pitch!.midi }));
        onInfo(t("roll.detected", { note: a.pitch.midi, confidence: Math.round(a.pitch.confidence * 100) }));
      } else onError(t("roll.noPitch"));
    });

  /** Drag the splitter between the editor and the song. */
  const onSplitter = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = mainRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSongHeight(Math.max(120, Math.min(box.height - 220, box.bottom - ev.clientY)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const deletePattern = async (pid = pattern.id) => {
    const p = song.patterns.find((x) => x.id === pid);
    if (!p || song.patterns.length <= 1) return;
    if (await ask(t("studio.deletePatternConfirm", { name: p.name }), { kind: "warning", title: t("app.title") }))
      update((s) => removePattern(s, p.id));
  };
  /** "Patrón N" with the first N not taken (after deleting some, numbers don't repeat). */
  const newPatternName = () => {
    const taken = new Set(song.patterns.map((p) => p.name));
    let n = song.patterns.length + 1;
    while (taken.has(t("studio.patternName", { n }))) n++;
    return t("studio.patternName", { n });
  };
  const newPattern = () => {
    update((s) => addPattern(s, newPatternName()));
    setRollId(null);
  };
  const duplicate = (pid: string) => {
    const p = song.patterns.find((x) => x.id === pid);
    if (p) update((s) => duplicatePattern(s, p.id, t("studio.copyName", { name: p.name })));
  };
  const sounding = new Set(head ? Object.keys(head.patterns) : []);

  const exportSong = async () => {
    const path = await save({
      title: t("studio.exportTitle"),
      defaultPath: `${t("studio.fileName")} ${song.bpm} BPM.wav`,
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    if (!path) return;
    setExportBusy(t("studio.exporting"));
    try {
      const out = await engine.render(song, mode, { tail });
      const channels = Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i));
      await api.exportSong(path, { sampleRate: out.sampleRate, channels }, exportSettings.format, exportSettings.channels);
      let peak = 0;
      for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
      // Integer WAV clips above 0 dBFS: tell the user instead of shipping a distorted file silently.
      if (peak > 1 && exportSettings.format !== "float32")
        onError(t("studio.exportClipped", { path, db: (20 * Math.log10(peak)).toFixed(1) }));
      else onInfo(t("studio.exportDone", { path }));
      setExportOpen(false);
    } catch (e) {
      onError(e);
    } finally {
      setExportBusy(null);
    }
  };

  const exportMidi = async () => {
    const path = await save({
      title: t("studio.exportMidiTitle"),
      defaultPath: `${t("studio.fileName")} ${song.bpm} BPM.mid`,
      filters: [{ name: "MIDI", extensions: ["mid"] }],
    });
    if (!path) return;
    try {
      await api.saveFile(path, songToMidi(song, mode, t("studio.fileName")));
      onInfo(t("studio.exportDone", { path }));
      setExportOpen(false);
    } catch (e) {
      onError(e);
    }
  };

  /** creditos.txt: who made the pack sounds this song uses. */
  const exportCredits = async () => {
    const path = await save({ title: t("credits.saveTitle"), defaultPath: t("credits.fileName"), filters: [{ name: "TXT", extensions: ["txt"] }] });
    if (!path) return;
    const text = creditsText(t("studio.fileName"), songCredits(song, packs), { heading: t("credits.heading"), by: t("credits.by"), license: t("credits.license") });
    try {
      await api.saveFile(path, new TextEncoder().encode(text));
      onInfo(t("studio.exportDone", { path }));
    } catch (e) {
      onError(e);
    }
  };

  /** One WAV per channel, all the same length, so they line up in any DAW. */
  const exportStems = async () => {
    const dir = await open({ directory: true, multiple: false, title: t("stems2.title") });
    if (typeof dir !== "string") return;
    const chans = engine.usedChannels(song, mode);
    if (!chans.length) return onError(t("stems2.nothing"));
    setExportBusy(t("stems2.progress", { n: 0, total: chans.length }));
    try {
      const seconds = engine.renderSeconds(song, mode, tail);
      const sep = dir.includes("\\") ? "\\" : "/";
      const used = new Set<string>();
      for (const [i, ch] of chans.entries()) {
        setExportBusy(t("stems2.progress", { n: i + 1, total: chans.length }));
        const out = await engine.render(song, mode, { tail, solo: ch.id, seconds });
        const channels = Array.from({ length: out.numberOfChannels }, (_, k) => out.getChannelData(k));
        const base = `${String(i + 1).padStart(2, "0")} ${safeName(ch.name)}`;
        let name = base;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
        used.add(name.toLowerCase());
        await api.exportSong(`${dir}${sep}${name}.wav`, { sampleRate: out.sampleRate, channels }, exportSettings.format, exportSettings.channels);
      }
      onInfo(t("stems2.done", { n: chans.length, dir }));
      setExportOpen(false);
    } catch (e) {
      onError(e);
    } finally {
      setExportBusy(null);
    }
  };

  return (
    <div className="studio-wrap">
      <StudioSidebar
        patternCount={song.patterns.length}
        patterns={
          <PatternsPanel
            song={song}
            playing={sounding}
            marks={marks.patterns}
            onPick={editPattern}
            onNew={newPattern}
            onRename={(id, name) => update((s) => updatePattern(s, id, { name }))}
            onDuplicate={duplicate}
            onPutInSong={putInSong}
            onDelete={deletePattern}
          />
        }
        sounds={
      <LibraryPanel
        sessions={library}
        onPreview={(s) => engine.preview(s).catch(onError)}
        onAdd={addSound}
        onAddToSong={addToSong}
        onRefresh={refreshLibrary}
        onRename={renameLibrarySample}
        onDelete={deleteLibrarySample}
        packs={packs}
        onImportFolder={importFolder}
        onGetMore={() => setPacksOpen(true)}
        onPackRename={renamePack}
        onPackDelete={deletePack}
        roomName={guestLibrary ? jam.roomName : undefined}
      />
        }
      />
      {packsOpen && (
        <PacksDialog
          packs={packs}
          onPacks={setPacks}
          onImportFolder={importFolder}
          onDelete={deletePack}
          onPreview={(sound) => engine.preview(sound).catch(onError)}
          onError={onError}
          onClose={() => setPacksOpen(false)}
        />
      )}
      <div className="studio-main" ref={mainRef}>
        <JamBar
          onOpenDialog={() => setJamDialog(true)}
          onError={onError}
          onInfo={onInfo}
          onBrought={(packId, itemId, name) => {
            // The room's sounds changed: list them, then add the new one as a channel.
            refreshLibrary();
            addSound({ kind: "pack", packId, itemId }, name);
          }}
        />
        {jamDialog && <JamDialog onClose={() => setJamDialog(false)} onError={onError} />}
        {midiDialog && <MidiDialog song={song} midi={midi} onClose={() => setMidiDialog(false)} />}
        {/* ---- transport ---- */}
        <div className="transport-bar" role="toolbar" aria-label={t("studio.transport")}>
          <button className="play-btn primary" onClick={togglePlay} title={t("studio.playHint")} aria-pressed={playing}>
            <Icon name={playing ? "stop" : "play"} /> {playing ? t("studio.stop") : t("studio.play")}
          </button>
          <div className="screen" aria-label={t("studio.screen")}>
            <output className="screen-pos" title={t("studio.position")} aria-label={t("studio.position")}>
              <span>{bar}</span>
              <i>.</i>
              <span>{beat}</span>
            </output>
            <label className="screen-bpm" title={t("studio.bpmHint")}>
              <NumberField
                aria-label={t("studio.bpm")}
                value={song.bpm}
                min={20}
                max={300}
                step={0.1}
                onCommit={(bpm) => update((s) => ({ ...s, bpm }), "bpm")}
              />
              <span>{t("studio.bpm")}</span>
            </label>
          </div>
          <span className="seg" role="group" aria-label={t("studio.modeHint")} title={t("studio.modeHint")}>
            <button className={`toggle ${mode === "pattern" ? "active" : ""}`} aria-pressed={mode === "pattern"} onClick={() => setMode("pattern")}>
              {t("studio.modePattern")}
            </button>
            <button className={`toggle ${mode === "song" ? "active" : ""}`} aria-pressed={mode === "song"} onClick={() => setMode("song")}>
              {t("studio.modeSong")}
            </button>
          </span>
          <label className="tb-field" title={t("studio.swingHint")}>
            {t("studio.swing")}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={song.swing}
              aria-valuetext={`${Math.round(song.swing * 100)}%`}
              onChange={(e) => update((s) => ({ ...s, swing: Number(e.target.value) }), "swing")}
            />
            <output className="num">{Math.round(song.swing * 100)}%</output>
          </label>
          <IconButton icon="metronome" label={t("studio.metronome")} active={metronome} onClick={() => setMetronome((m) => !m)} />
          <MidiButton midi={midi} onClick={() => setMidiDialog(true)} />
          <div className="spacer" />
          <IconButton icon="undo" label={`${t("studio.undo")} (Ctrl+Z)`} onClick={undo} disabled={!canUndo} />
          <IconButton icon="redo" label={`${t("studio.redo")} (Ctrl+Y)`} onClick={redo} disabled={!canRedo} />
        </div>

        {/* ---- editor: steps or piano roll of the current pattern ---- */}
        <section className="pane editor-pane" aria-label={t("studio.editor")}>
          <header className="pane-head">
            <div className="pattern-current">
              <Picker
                label={t("studio.patternSelectHint")}
                title={t("studio.patternEditing")}
                value={pattern.id}
                columns={1}
                groups={[{ options: song.patterns.map((p) => ({ value: p.id, label: p.name, color: patternColor(p.id) })) }]}
                onPick={editPattern}
              />
              {sounding.has(pattern.id) && <i className="pat-playing" title={t("studio.patternPlaying")} />}
            </div>
            <IconButton icon="plus" label={t("studio.newPatternLabel")} onClick={newPattern} />
            {inRoom && jam.transport.mode === "pattern" && jam.transport.patternId && jam.transport.patternId !== pattern.id && (
              <button className="primary" onClick={playThisPattern} title={t("jam.playThisHint")}>
                <Icon name="play" /> {t("jam.playThis")}
              </button>
            )}
            <span className="tb-field">
              {t("studio.length")}
              <Segmented
                label={t("studio.length")}
                value={pattern.steps / STEPS_PER_BAR}
                options={BAR_OPTIONS.map((n) => ({ value: n, label: String(n), hint: t("studio.bars", { count: n }) }))}
                onChange={(n) => update((s) => setPatternLength(s, pattern.id, n * STEPS_PER_BAR))}
              />
              <span className="muted small">{t("studio.barsWord", { count: pattern.steps / STEPS_PER_BAR })}</span>
            </span>
            <IconButton
              icon="copy"
              label={t("studio.duplicateLabel", { name: pattern.name })}
              onClick={() => duplicate(pattern.id)}
            />
            <IconButton icon="trash" tone="danger" label={t("studio.deletePattern")} onClick={() => deletePattern()} disabled={song.patterns.length <= 1} />
            <button className="put-in-song" onClick={() => putInSong()} title={t("studio.putInSongHint")}>
              <Icon name="toSong" /> {t("studio.putInSong")}
            </button>
            <div className="spacer" />
            <div className="seg view-switch" role="group" aria-label={t("studio.view")}>
              <button className={`toggle ${!rollChannel ? "active" : ""}`} aria-pressed={!rollChannel} onClick={() => setRollId(null)}>
                <Icon name="steps" /> {t("studio.viewSteps")}
              </button>
              <button
                className={`toggle ${rollChannel ? "active" : ""}`}
                aria-pressed={!!rollChannel}
                title={rollChannel ? undefined : t("studio.rollHint")}
                onClick={openRoll}
              >
                <Icon name="piano" /> {rollChannel ? rollChannel.name : t("studio.viewRoll")}
              </button>
            </div>
          </header>
          <div className="pane-body">
            {rollChannel ? (
              <PianoRoll
                key={rollChannel.id}
                song={song}
                pattern={pattern}
                channel={rollChannel}
                playStep={playStep}
                update={update}
                onPreviewNote={(midi) => engine.previewNote(rollChannel, midi).catch(onError)}
                recording={recording}
                onToggleRecord={() => setRecording((r) => !r)}
                kbOctave={live.octave}
                pressed={live.pressed}
              />
            ) : (
              <StepGrid
                song={song}
                pattern={pattern}
                playStep={playStep}
                update={update}
                status={(ch) => engine.channelStatus(ch)}
                marks={marks.channels}
                hushed={hushed}
                selectedId={selectedChannel?.id ?? null}
                onSelect={(ch) => {
                  setSelection({ kind: "channel", id: ch.id });
                  if (!engine.isPlaying()) engine.previewNote(ch, ch.rootNote).catch(onError);
                }}
                onOpenRoll={(ch) => {
                  setSelection({ kind: "channel", id: ch.id });
                  setRollId(ch.id);
                }}
              />
            )}
          </div>
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("studio.splitter")}
          title={t("studio.splitter")}
          onPointerDown={onSplitter}
        />

        {/* ---- song ---- */}
        <section className="pane song-pane" style={{ height: songHeight }} aria-label={t("timeline.title")}>
          <Timeline
            song={song}
            playStep={songMode && head ? head.songStep : null}
            startStep={startStep}
            setStartStep={(st) => {
              setStartStep(st);
              setMode("song");
            }}
            update={update}
            brush={brush}
            setBrush={setBrush}
            soundSeconds={(id) => {
              const ch = song.channels.find((c) => c.id === id);
              return ch ? engine.soundSeconds(ch.sound) : null;
            }}
            onEditPattern={editPattern}
            selectedClipId={selection?.kind === "clip" ? selection.id : null}
            onSelectClip={(id) => setSelection(id ? { kind: "clip", id } : null)}
          />
        </section>
      </div>

      <Inspector
        song={song}
        selection={selection}
        update={update}
        onError={onError}
        onDeselect={() => setSelection(null)}
        onOpenMidi={() => setMidiDialog(true)}
        channel={{
          status: (ch) => engine.channelStatus(ch),
          analysisFor,
          onAnalyze: () => {
            if (selectedChannel) analyze(selectedChannel.sound);
          },
          onWarp: (on, bpm) => {
            if (selectedChannel) setWarp(selectedChannel, on, bpm);
          },
          onUseTempo: (bpm) => update((s) => ({ ...s, bpm: Math.round(bpm * 10) / 10 })),
          onPreview: () => {
            if (selectedChannel) engine.previewNote(selectedChannel, selectedChannel.rootNote).catch(onError);
          },
          onOpenRoll: () => {
            if (selectedChannel) setRollId(selectedChannel.id);
          },
          onDetectRoot: selectedChannel?.sound.kind === "sample" ? () => detectRoot(selectedChannel) : undefined,
          onClearPattern: () => {
            if (selectedChannel) update((s) => clearRow(s, pattern.id, selectedChannel.id));
          },
          onRemove: () => {
            if (selectedChannel) removeCh(selectedChannel);
          },
        }}
        clip={{
          onEditPattern: editPattern,
          onRemove: () => {
            if (selection?.kind !== "clip") return;
            const id = selection.id;
            update((s) => removeClip(s, id));
            setSelection(null);
          },
        }}
      />

      {exportOpen && (
        <ExportDialog
          songMode={songMode}
          settings={exportSettings}
          setSettings={setExportSettings}
          tail={tail}
          setTail={setTail}
          busy={exportBusy}
          onWav={exportSong}
          onStems={exportStems}
          onMidi={exportMidi}
          credits={songCredits(song, packs)}
          onCredits={exportCredits}
          onClose={() => !exportBusy && setExportOpen(false)}
        />
      )}
    </div>
  );
});
