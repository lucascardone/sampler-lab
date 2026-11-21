// Dev-only fake core: open the desktop UI in a plain browser with
// `npm run dev` + `?mock=1`, or the phone UI with `?mock=phone&t=x`. Answers the Tauri
// commands with sample data and keeps the song in memory, so screens can be reviewed and
// screenshotted without the real app. Vite drops all of this from production builds
// (import.meta.env.DEV is false there). Must be imported before remote/shim.
import { addChannel, newSong, setNotes, setStep, type Song } from "../features/studio/song";

const mode = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("mock") : null;

function demoSong(): Song {
  let s = newSong({ kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" });
  const p = s.currentPatternId;
  for (const i of [0, 4, 8, 12]) s = setStep(s, p, s.channels[0].id, i, 1);
  for (const i of [4, 12]) s = setStep(s, p, s.channels[1].id, i, 0.9);
  for (let i = 0; i < 16; i += 2) s = setStep(s, p, s.channels[3].id, i, i % 4 ? 0.5 : 0.8);
  s = addChannel(s, { kind: "synth", preset: "pad" }, "Pad");
  const pad = s.channels[s.channels.length - 1].id;
  // Am7 → Fmaj7 → Cmaj7 with every voice sliding into the next chord.
  const chords = [
    [57, 60, 64, 67],
    [57, 60, 64, 65],
    [55, 60, 64, 67],
  ];
  const notes = chords.flatMap((c, k) =>
    c.map((pitch) => ({ start: [0, 6, 11][k], length: [6, 5, 5][k], pitch, velocity: 0.8, ...(k ? { glide: 2 } : {}) })),
  );
  s = setNotes(s, p, pad, notes);
  s = addChannel(s, { kind: "synth", preset: "lead" }, "Lead");
  return s;
}

const session = {
  id: "demo",
  sources: [
    { id: "src1", name: "Grabación del sábado.wav", kind: "file", path: "C:/demo.wav", previewPath: "C:/demo.wav", duration: 42, sampleRate: 44100, channels: 2 },
  ],
  samples: [
    { id: "s1", name: "Riff de guitarra", sourceId: "src1", start: 2, end: 6.5, sampleRate: 44100, effects: [], canUndo: false, canRedo: false },
    { id: "s2", name: "Voz", sourceId: "src1", start: 10, end: 14, sampleRate: 44100, effects: [], canUndo: false, canRedo: false },
  ],
};

let song: unknown = null;

function answer(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case "song_load":
      return song ?? (song = demoSong());
    case "song_save":
      song = args.song;
      return null;
    case "song_stamp":
      return 1;
    case "last_session":
      return { name: "Grabación del sábado", samples: 2 };
    case "restore_session":
    case "open_audio":
      return session;
    case "library_list":
      return [{ id: "demo", name: "Grabación del sábado", modified: Date.now() / 1000, samples: [{ id: "s1", name: "Riff de guitarra", isStem: false }, { id: "s2", name: "Voz", isStem: true }] }];
    case "packs_list":
      return [];
    case "list_recordings":
      return [{ path: "C:/Música/rec1.wav", name: "Radio 21-11", seconds: 95, modified: Date.now() / 1000 }];
    case "recording_status":
      return { recording: false, seconds: 0, dir: "C:/Música/Sampler Lab" };
    case "engine_status":
      return { state: "notInstalled", info: null, variant: null };
    case "engine_hardware":
      return { gpu: null, driver: null, recommended: "cpu" };
    case "midi_sync":
      return [];
    case "fx_presets_load":
      return [];
    case "remote_status":
    case "jam_host_status":
    case "song_recovery_note":
      return null;
    case "remote_start":
      return { url: "http://192.168.0.10:7777/?t=demo", qrSvg: "", port: 7777, onNetwork: true, needsBuild: false };
    case "jam_default_name":
      return "Lucas";
    case "jam_scan":
      return [];
    case "recording_usage":
      return 0;
    default:
      return null;
  }
}

if (mode === "phone") {
  // The phone talks HTTP to the PC: answer those requests here.
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/\/api\/invoke\/([a-z_]+)/);
    if (!m) return real(input, init);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      /* raw body */
    }
    return new Response(JSON.stringify({ ok: answer(m[1], args) }), { headers: { "content-type": "application/json" } });
  };
} else if (mode) {
  let cb = 0;
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: () => ++cb,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:")) return cmd.endsWith("|listen") ? ++cb : null;
      return answer(cmd, (args ?? {}) as Record<string, unknown>);
    },
  };
}

export {};
