// Typed wrappers around the Tauri commands in src-tauri/src/commands.rs and engine.rs.
import { invoke } from "@tauri-apps/api/core";

/** Time range in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

export type WavFormat = "pcm16" | "pcm24" | "float32";
export type ChannelMode = "stereo" | "mono";

/** Effect as sent to the backend (times in seconds, relative to the sample). */
export type EffectRequest =
  | { type: "trim"; range: TimeRange }
  | { type: "gain"; db: number; range: TimeRange | null }
  | { type: "normalize"; peakDb: number; range: TimeRange | null }
  | { type: "fadeIn"; range: TimeRange }
  | { type: "fadeOut"; range: TimeRange }
  | { type: "reverse"; range: TimeRange | null };

/** Effect as stored by the backend (ranges in frames). */
export interface FrameRange {
  start: number;
  end: number;
}
export type StoredOp =
  | { type: "trim"; range: FrameRange }
  | { type: "gain"; db: number; range: FrameRange | null }
  | { type: "normalize"; peak_db: number; range: FrameRange | null }
  | { type: "fadeIn"; range: FrameRange }
  | { type: "fadeOut"; range: FrameRange }
  | { type: "reverse"; range: FrameRange | null };

export interface Effect {
  id: string;
  enabled: boolean;
  op: StoredOp;
}

export type SourceKind = { kind: "file" } | { kind: "stem"; parentSampleId: string; stem: string };

export interface SourceInfo {
  id: string;
  name: string;
  kind: SourceKind;
  path: string;
  previewPath: string;
  duration: number;
  sampleRate: number;
  channels: number;
}

export interface SampleInfo {
  id: string;
  name: string;
  sourceId: string;
  start: number;
  end: number;
  sampleRate: number;
  effects: Effect[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface Session {
  id: string;
  sources: SourceInfo[];
  samples: SampleInfo[];
}

export interface Rendered {
  previewPath: string;
  duration: number;
  sampleRate: number;
  channels: number;
}

export interface SeparationInput {
  inputPath: string;
  outDir: string;
  duration: number;
}

export interface StemFile {
  stem: string;
  path: string;
}

export type SnapTarget = { sourceId: string } | { sampleId: string };

export interface RecordingStatus {
  recording: boolean;
  seconds: number;
  dir: string;
}
export interface RecordingTick {
  seconds: number;
  level: number;
}
export interface RecordingSaved {
  path: string;
  seconds: number;
  silent: boolean;
}
export interface RecordingFile {
  path: string;
  name: string;
  seconds: number;
  modified: number;
}

export interface LibrarySample {
  id: string;
  name: string;
  isStem: boolean;
}
export interface LibrarySession {
  id: string;
  name: string;
  modified: number;
  samples: LibrarySample[];
}

/** A sound in a pack (packs.rs, docs/PACK_SCHEMA.md). */
export interface PackItem {
  id: string;
  name: string;
  kind: "oneshot" | "instrument";
  /** Relative to the pack folder. */
  file?: string;
  sfz?: string;
  category: string;
  credit?: { author: string; license: string; url?: string };
  /** Not listed; kept only so songs that already use it still load. */
  hidden?: boolean;
}

/** A pack in the catalog of free instruments (curated list + catalogs kept by others, online.rs). */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  license: string;
  licenseUrl: string;
  attribution?: string | null;
  sourceUrl: string;
  downloadUrl: string;
  /** Exact when `sha256` is set; an estimate for GitHub archives. */
  sizeBytes: number;
  /** Empty = not pinned (GitHub archive). */
  sha256: string;
  source: "curated" | "oas" | "github";
}

export interface CatalogList {
  entries: CatalogEntry[];
  /** False when the online catalogs couldn't be refreshed (the last saved list is shown). */
  onlineOk: boolean;
}

/** A sound found online (Openverse), ready to preview and add. */
export interface OnlineSound {
  id: string;
  title: string;
  author: string;
  /** CC0-1.0 | CC-BY-x.y | PDM */
  license: string;
  licenseUrl: string;
  /** The audio file. */
  url: string;
  /** Its page at the source (the credit link). */
  pageUrl: string;
  durationMs?: number | null;
  filetype: string;
  sizeBytes?: number | null;
  source: string;
}

export interface SoundPage {
  results: OnlineSound[];
  hasMore: boolean;
}

/** Install progress of a catalog pack. */
export interface PackProgress {
  id: string;
  stage: "download" | "verify" | "extract";
  received: number;
  total: number;
}

/** An installed sound pack, with the folder its files live in. */
export interface PackInfo {
  version: number;
  id: string;
  name: string;
  author: string;
  /** CC0-1.0, CC-BY-4.0, CC-BY-NC-4.0, … "own", or "mixed" (each item has its own credit). */
  license: string;
  licenseUrl?: string;
  sourceUrl?: string;
  origin: "folder" | "catalog" | "zip" | "freesound" | "online";
  installedAt: string;
  items: PackItem[];
  dir: string;
}

/** Planar float audio sent to the core for writing (see studio.rs: parse_export). */
export interface ExportAudio {
  sampleRate: number;
  channels: Float32Array[];
}

function exportPayload(path: string, audio: ExportAudio, format: WavFormat, channelMode: ChannelMode): Uint8Array {
  const meta = new TextEncoder().encode(
    JSON.stringify({ path, sampleRate: audio.sampleRate, channels: audio.channels.length, format, channelMode }),
  );
  const frames = audio.channels[0]?.length ?? 0;
  const out = new Uint8Array(4 + meta.length + audio.channels.length * frames * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, meta.length, true);
  out.set(meta, 4);
  let at = 4 + meta.length;
  for (const ch of audio.channels) {
    for (let i = 0; i < frames; i++, at += 4) view.setFloat32(at, ch[i], true);
  }
  return out;
}

export interface Analysis {
  pitch: { midi: number; cents: number; hz: number; confidence: number } | null;
  key: { tonic: number; minor: boolean; confidence: number } | null;
  tempo: { bpm: number; alternative: number; confidence: number } | null;
  duration: number;
}

/** A message from a MIDI device (`device` = its name). */
export type MidiEvent = { device: string } & (
  | { kind: "on"; note: number; velocity: number }
  | { kind: "off"; note: number }
  | { kind: "cc"; controller: number; value: number }
  /** Pitch wheel, -1..1. */
  | { kind: "bend"; value: number }
  | { kind: "transport"; action: "play" | "stop" | "record" }
);

export interface MidiDevice {
  name: string;
  connected: boolean;
  error: string | null;
}

/** `u32 json_len | json | data`, the layout studio.rs reads. */
function filePayload(path: string, data: Uint8Array): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ path }));
  const out = new Uint8Array(4 + meta.length + data.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  out.set(data, 4 + meta.length);
  return out;
}

export interface RemoteInfo {
  url: string;
  qrSvg: string;
  port: number;
  onNetwork: boolean;
  needsBuild: boolean;
}

/** "Tocar juntos": a room this PC opened. */
export interface JamHostInfo {
  /** The 4 digits friends type. */
  code: string;
  name: string;
  port: number;
  /** This PC on the Wi-Fi ("" if none was found). */
  address: string;
  /** This PC on Tailscale, for friends at home ("" if Tailscale is off). */
  vpnAddress: string;
}

/** A room heard on the Wi-Fi. */
export interface JamRoomFound {
  name: string;
  address: string;
}

export interface EngineInfo {
  port: number;
  token: string;
}
/** PyTorch build of the separator: processor only, or NVIDIA (older / newer drivers). */
export type EngineVariant = "cpu" | "cu126" | "cu130";

export interface EngineStatus {
  state: "missingUv" | "notInstalled" | "stopped" | "running";
  info: EngineInfo | null;
  /** Build installed, if known. */
  variant: EngineVariant | null;
}

/** What the PC has (from nvidia-smi) and the build that fits it. */
export interface EngineHardware {
  gpu: string | null;
  driver: string | null;
  recommended: EngineVariant;
}

export const api = {
  openAudio: (path: string) => invoke<Session>("open_audio", { path }),
  addAudio: (path: string) => invoke<{ session: Session; sourceId: string }>("add_audio", { path }),
  lastSession: () => invoke<{ name: string; samples: number } | null>("last_session"),
  restoreSession: () => invoke<Session>("restore_session"),

  createSample: (sourceId: string, range: TimeRange, name?: string) =>
    invoke<{ session: Session; sampleId: string }>("create_sample", { sourceId, range, name }),
  renameSample: (sampleId: string, name: string) => invoke<Session>("rename_sample", { sampleId, name }),
  deleteSample: (sampleId: string) => invoke<Session>("delete_sample", { sampleId }),

  addEffect: (sampleId: string, op: EffectRequest) => invoke<Session>("add_effect", { sampleId, op }),
  setEffectEnabled: (sampleId: string, effectId: string, enabled: boolean) =>
    invoke<Session>("set_effect_enabled", { sampleId, effectId, enabled }),
  removeEffect: (sampleId: string, effectId: string) => invoke<Session>("remove_effect", { sampleId, effectId }),
  moveEffect: (sampleId: string, effectId: string, delta: number) =>
    invoke<Session>("move_effect", { sampleId, effectId, delta }),
  undo: (sampleId: string) => invoke<Session>("undo", { sampleId }),
  redo: (sampleId: string) => invoke<Session>("redo", { sampleId }),

  renderSample: (sampleId: string) => invoke<Rendered>("render_sample", { sampleId }),
  snapToZero: (target: SnapTarget, times: number[], windowMs?: number) =>
    invoke<number[]>("snap_to_zero", { target, times, windowMs }),
  exportSample: (sampleId: string, path: string, format: WavFormat, channels: ChannelMode, range: TimeRange | null) =>
    invoke<void>("export_sample", { sampleId, path, format, channels, range }),
  exportAll: (dir: string, format: WavFormat, channels: ChannelMode) =>
    invoke<string[]>("export_all", { dir, format, channels }),

  prepareSeparation: (sampleId: string) => invoke<SeparationInput>("prepare_separation", { sampleId }),
  importStems: (sampleId: string, stems: StemFile[]) => invoke<StemFile[]>("import_stems", { sampleId, stems }),
  keepStem: (sampleId: string, stem: StemFile, name: string) =>
    invoke<{ session: Session; sampleId: string }>("keep_stem", { sampleId, stem, name }),

  recordingStatus: () => invoke<RecordingStatus>("recording_status"),
  startRecording: () => invoke<RecordingStatus>("start_recording"),
  stopRecording: () => invoke<RecordingSaved | null>("stop_recording"),
  listRecordings: () => invoke<RecordingFile[]>("list_recordings"),
  setRecordingsDir: (dir: string) => invoke<RecordingStatus>("set_recordings_dir", { dir }),
  openRecordingsDir: () => invoke<void>("open_recordings_dir"),
  /** Renames the file; sessions that use it follow along. Returns the new list. */
  renameRecording: (path: string, name: string) => invoke<RecordingFile[]>("rename_recording", { path, name }),
  /** To the Recycle Bin. Returns the new list. */
  deleteRecording: (path: string) => invoke<RecordingFile[]>("delete_recording", { path }),
  /** Samples (in any session) cut from this recording. */
  recordingUsage: (path: string) => invoke<number>("recording_usage", { path }),

  libraryList: () => invoke<LibrarySession[]>("library_list"),
  librarySampleAudio: (sessionId: string, sampleId: string, stretch?: number) =>
    invoke<{ path: string; name: string }>("library_sample_audio", { sessionId, sampleId, stretch }),
  libraryAnalyze: (sessionId: string, sampleId: string) => invoke<Analysis>("library_analyze", { sessionId, sampleId }),
  libraryRenameSample: (sessionId: string, sampleId: string, name: string) =>
    invoke<LibrarySession[]>("library_rename_sample", { sessionId, sampleId, name }),
  libraryDeleteSample: (sessionId: string, sampleId: string) =>
    invoke<LibrarySession[]>("library_delete_sample", { sessionId, sampleId }),
  packsList: () => invoke<PackInfo[]>("packs_list"),
  /** Copy a folder of sounds as a new pack. Returns every pack. */
  packImportFolder: (path: string, name: string) => invoke<PackInfo[]>("pack_import_folder", { path, name }),
  /** To the Recycle Bin. Returns every pack. */
  packDelete: (id: string) => invoke<PackInfo[]>("pack_delete", { id }),
  packRename: (id: string, name: string) => invoke<PackInfo[]>("pack_rename", { id, name }),
  /** The catalog of free instruments (catalog.rs + online.rs). `refresh` skips the 1-day cache. */
  catalogFetch: (refresh = false) => invoke<CatalogList>("catalog_fetch", { refresh }),
  /** Search free sounds online (Openverse). `long` = loops instead of short hits. */
  soundSearch: (query: string, long: boolean, page: number) => invoke<SoundPage>("sound_search", { query, long, page }),
  /** Download a search result into the "Sonidos de internet" pack. Returns every pack. */
  soundAdd: (id: string) => invoke<PackInfo[]>("sound_add", { id }),
  /** Download + install a catalog pack (progress: "pack-progress" events). Returns every pack. */
  packInstall: (id: string) => invoke<PackInfo[]>("pack_install", { id }),
  packCancel: (id: string) => invoke<void>("pack_cancel", { id }),
  saveFile: (path: string, data: Uint8Array) => invoke<void>("save_file", filePayload(path, data)),
  /** Listen to every plugged-in MIDI device except `off`; returns them all. */
  midiSync: (off: string[], retry = false) => invoke<MidiDevice[]>("midi_sync", { off, retry }),
  songLoad: () => invoke<unknown | null>("song_load"),
  /** If the last load had to recover a damaged song, what happened (once). */
  songRecoveryNote: () => invoke<string | null>("song_recovery_note"),
  /** The user's effect presets (raw: validated by fxPresets.ts). */
  fxPresetsLoad: () => invoke<unknown>("fx_presets_load"),
  fxPresetsSave: (presets: unknown[]) => invoke<void>("fx_presets_save", { presets }),
  /** Desktop: resolves to nothing. Phone: resolves to the save's timestamp on the PC. */
  songSave: (song: unknown) => invoke<unknown>("song_save", { song }),
  /** Phone only: when the PC's song file last changed (ms). */
  songStamp: () => invoke<number>("song_stamp"),
  remoteStart: () => invoke<RemoteInfo>("remote_start"),
  remoteStop: () => invoke<void>("remote_stop"),
  remoteStatus: () => invoke<RemoteInfo | null>("remote_status"),

  // ---- Tocar juntos (src-tauri/src/jam.rs) ----
  jamDefaultName: () => invoke<string>("jam_default_name"),
  jamHostStart: (name: string) => invoke<JamHostInfo>("jam_host_start", { name }),
  jamHostStop: () => invoke<void>("jam_host_stop"),
  jamHostStatus: () => invoke<JamHostInfo | null>("jam_host_status"),
  /** Let friends at other homes in (internet, iroh): the invite to send them. */
  jamHostInternet: () => invoke<string>("jam_host_internet"),
  /** To one guest, or to all (`to` null). */
  jamHostSend: (to: number | null, msg: unknown) => invoke<void>("jam_host_send", { to, msg }),
  jamScan: () => invoke<JamRoomFound[]>("jam_scan"),
  /** Enter a room: our peer id. */
  jamJoin: (address: string, code: string, name: string) => invoke<number>("jam_join", { address, code, name }),
  jamGuestSend: (msg: unknown) => invoke<void>("jam_guest_send", { msg }),
  /** A read-only library call answered by the host. */
  jamGuestCall: <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>("jam_guest_call", { cmd, args }),
  /** A host sound file, copied to this PC: the local path. */
  jamGuestFetch: (path: string) => invoke<string>("jam_guest_fetch", { path }),
  /** Bring one of your sound files to the room. */
  jamGuestUpload: (path: string) => invoke<{ packId: string; itemId: string }>("jam_guest_upload", { path }),
  jamLeave: () => invoke<void>("jam_leave"),
  exportSong: (path: string, audio: ExportAudio, format: WavFormat, channelMode: ChannelMode) =>
    invoke<void>("export_song", exportPayload(path, audio, format, channelMode)),

  engineStatus: () => invoke<EngineStatus>("engine_status"),
  engineHardware: () => invoke<EngineHardware>("engine_hardware"),
  /** Install the separator with this build (the recommended one if omitted). */
  engineSetup: (variant?: EngineVariant) => invoke<void>("engine_setup", { variant: variant ?? null }),
  engineStart: () => invoke<EngineInfo>("engine_start"),
};

/** Formats the decoder accepts (keep in sync with symphonia features in Cargo.toml). */
export const AUDIO_EXTENSIONS = ["wav", "aif", "aiff", "flac", "mp3", "ogg", "m4a", "aac", "mp4"];
