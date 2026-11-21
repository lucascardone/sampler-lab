// Phone layout of the studio. Same song, engine and pad colors as the desktop; the
// sound comes out of the phone. Built for thumbs: big pads, big steps, one sound at a time.
//
//   ┌ screen: position · BPM · play ┐
//   ├ patterns ──────────────────────┤
//   │ Pads | Pasos | Sonidos         │
//   │ (content)                      │
//   └────────────────────────────────┘
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type LibrarySession, type PackInfo } from "../../lib/api";
import { Icon } from "../../ui/Icon";
import { NotesPreview } from "./NotesPreview";
import { NumberField } from "../../ui/NumberField";
import { remoteToken } from "../../remote/shim";
import { padColor } from "../studio/colors";
import { studioEngine, type Playhead } from "../studio/engine";
import {
  BUILTIN_DRUMS,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  SYNTH_PRESETS,
  addChannel,
  addPattern,
  channelNotes,
  clearRow,
  mixOf,
  setMix,
  setNotes,
  setStep,
  stepVelocity,
  updateChannel,
  type Channel,
  type Pattern,
  type SoundRef,
} from "../studio/song";
import { useSong } from "../studio/useSong";
import { MobileHelp } from "../help/HelpDialog";
import { visibleItems } from "../studio/libraryTree";
import "./mobile.css";

type Tab = "pads" | "steps" | "sounds";
const POLL_MS = 2500;
const GUIDE_KEY = "sampler-lab.mobile-guide-seen";

export function MobileApp() {
  const { t } = useTranslation();
  const [toast, setToast] = useState<string | null>(null);
  const showError = useCallback((e: unknown) => setToast(String(e)), []);
  // The PC's song file stamp we're in sync with (our own saves report theirs).
  const known = useRef(0);
  const { song, update, replace, undo, canUndo } = useSong(showError, (stamp) => {
    if (typeof stamp === "number") known.current = stamp;
  });
  const engine = studioEngine();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [tab, setTab] = useState<Tab>("pads");
  const [chId, setChId] = useState<string | null>(null);
  // Keep the chosen sound's chip in view (it may be off to the right).
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chipsRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [chId, tab]);
  const [bar, setBar] = useState(0);
  const [recording, setRecording] = useState(false);
  const [head, setHead] = useState<Playhead | null>(null);
  const [lit, setLit] = useState<Set<string>>(new Set());
  const [library, setLibrary] = useState<LibrarySession[]>([]);
  const [packs, setPacks] = useState<PackInfo[]>([]);
  // Packs from the PC: the song may use their sounds, so learn where they are right away.
  useEffect(() => {
    api
      .packsList()
      .then((list) => {
        setPacks(list);
        engine.setPacks(list);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [online, setOnline] = useState(true);
  const [help, setHelp] = useState(false);
  const [guide, setGuide] = useState(() => {
    try {
      return !localStorage.getItem(GUIDE_KEY);
    } catch {
      return true;
    }
  });
  const closeGuide = () => {
    setGuide(false);
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      /* shown again next time, no harm */
    }
  };

  useEffect(() => engine.subscribe(rerender), [engine]);
  useEffect(() => {
    if (song) engine.setSong(song, "pattern");
  }, [engine, song]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Keep in sync with the PC: when its song file changes (edited on the desktop), load it.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const stamp = await api.songStamp();
        if (!alive) return;
        setOnline(true);
        if (known.current === 0) known.current = stamp;
        else if (stamp > known.current) {
          known.current = stamp;
          replace(await api.songLoad());
        }
      } catch {
        if (alive) setOnline(false);
      }
    };
    const id = setInterval(tick, POLL_MS);
    tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [replace]);

  // Playhead while playing.
  const playing = engine.isPlaying();
  useEffect(() => {
    if (!playing) return setHead(null);
    let raf = 0;
    const loop = () => {
      const h = engine.playhead();
      setHead((o) => (o?.songStep === h?.songStep ? o : h));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, playing]);

  if (!remoteToken) {
    return (
      <div className="m-app m-center">
        <Icon name="warning" size={32} />
        <h1>{t("mobile.noCodeTitle")}</h1>
        <p>{t("mobile.noCode")}</p>
      </div>
    );
  }
  if (!song) return <div className="m-app m-center">{t("mobile.connecting")}</div>;

  const pattern: Pattern = song.patterns.find((p) => p.id === song.currentPatternId) ?? song.patterns[0];
  const bars = pattern.steps / STEPS_PER_BAR;
  const curBar = Math.min(bar, bars - 1);
  const channel: Channel | undefined = song.channels.find((c) => c.id === chId) ?? song.channels[0];
  const playStep = head?.patterns[pattern.id] ?? null;
  const pos = head ? `${Math.floor(head.songStep / STEPS_PER_BAR) + 1}.${Math.floor((head.songStep % STEPS_PER_BAR) / STEPS_PER_BEAT) + 1}` : "1.1";

  const togglePlay = () => {
    if (engine.isPlaying()) {
      engine.stop();
      setRecording(false);
    } else engine.play(0).catch(showError);
  };
  /** Record = play + write what you hit (like a hardware sampler's REC). */
  const toggleRecord = () => {
    if (recording) return setRecording(false);
    setRecording(true);
    if (!engine.isPlaying()) engine.play(0).catch(showError);
  };
  // Pads light up when the beat plays them, so you can see what's sounding.
  const seqLit = new Set<string>();
  if (playStep !== null) {
    for (const ch of song.channels) {
      if (stepVelocity(pattern, ch.id, playStep) > 0 || channelNotes(pattern, ch.id).some((n) => n.start === playStep)) seqLit.add(ch.id);
    }
  }

  /** A pad is hit: sound now; while recording, write it into the pattern on the grid. */
  const hit = (ch: Channel) => {
    const id = engine.noteOn(ch, ch.rootNote, 1);
    setLit((s) => new Set(s).add(ch.id));
    setTimeout(() => {
      engine.noteOff(id);
      setLit((s) => {
        const n = new Set(s);
        n.delete(ch.id);
        return n;
      });
    }, 140);
    if (!recording) return;
    const at = engine.positionIn(pattern.id);
    if (at === null) return;
    const step = Math.round(at) % pattern.steps;
    update((s) => {
      const p = s.patterns.find((x) => x.id === pattern.id)!;
      const notes = channelNotes(p, ch.id);
      // A channel written with the piano roll gets a note; otherwise a step.
      return notes.length
        ? setNotes(s, p.id, ch.id, [...notes, { start: step, length: 1, pitch: ch.rootNote, velocity: 1 }])
        : setStep(s, p.id, ch.id, step, 1);
    }, `m-rec-${Date.now()}`);
  };

  const addSound = (sound: SoundRef, name: string) => {
    update((s) => addChannel(s, sound, name));
    setToast(t("mobile.added", { name }));
  };

  const loadLibrary = () => api.libraryList().then(setLibrary).catch(showError);

  return (
    <div className="m-app">
      {/* ---- screen ---- */}
      <header className="m-top">
        <div className="m-screen">
          <output className="m-pos">{pos}</output>
          <div className="m-bpm">
            <button className="m-step-btn" aria-label={t("mobile.bpmDown")} onClick={() => update((s) => ({ ...s, bpm: Math.max(20, Math.round(s.bpm) - 1) }), "bpm")}>
              −
            </button>
            <span className="m-bpm-val">
              <NumberField
                aria-label={t("studio.bpm")}
                value={song.bpm}
                min={20}
                max={300}
                step={1}
                onCommit={(bpm) => update((s) => ({ ...s, bpm }), "bpm")}
              />
              <span>BPM</span>
            </span>
            <button className="m-step-btn" aria-label={t("mobile.bpmUp")} onClick={() => update((s) => ({ ...s, bpm: Math.min(300, Math.round(s.bpm) + 1) }), "bpm")}>
              +
            </button>
          </div>
          <span className={`m-link ${online ? "on" : ""}`} title={online ? t("mobile.online") : t("mobile.offline")} />
        </div>
        <button className={`m-play ${playing ? "on" : ""}`} onClick={togglePlay} aria-label={playing ? t("studio.stop") : t("studio.play")}>
          <Icon name={playing ? "stop" : "play"} size={26} />
        </button>
      </header>
      {!online && (
        <p className="m-offline" role="alert">
          {t("mobile.offlineBanner")}
        </p>
      )}

      {/* ---- patterns ---- */}
      <nav className="m-patterns" aria-label={t("studio.patterns")}>
        {song.patterns.map((p) => (
          <button
            key={p.id}
            className={p.id === pattern.id ? "on" : ""}
            onClick={() => {
              update((s) => ({ ...s, currentPatternId: p.id }), undefined, { history: false });
              setBar(0);
            }}
          >
            {p.name}
          </button>
        ))}
        <button className="m-add" aria-label={t("studio.newPatternLabel")} onClick={() => update((s) => addPattern(s, t("studio.patternName", { n: s.patterns.length + 1 })))}>
          <Icon name="plus" />
        </button>
        <span className="m-spacer" />
        <button className="m-icon" aria-label={t("studio.undo")} onClick={undo} disabled={!canUndo}>
          <Icon name="undo" size={18} />
        </button>
        <button className="m-icon" aria-label={t("help.open")} onClick={() => setHelp(true)}>
          <Icon name="help" size={18} />
        </button>
      </nav>

      <main className="m-body">
        {tab === "pads" && (
          <section className="m-pads-view">
            {guide && (
              <div className="m-guide">
                <p>
                  <strong>{t("mobile.guideTitle")}</strong>
                </p>
                <ol>
                  <li>{t("mobile.guide1")}</li>
                  <li>{t("mobile.guide2")}</li>
                  <li>{t("mobile.guide3")}</li>
                </ol>
                <div className="m-guide-actions">
                  <button onClick={() => setHelp(true)}>{t("mobile.guideMore")}</button>
                  <button className="primary" onClick={closeGuide}>
                    {t("mobile.guideOk")}
                  </button>
                </div>
              </div>
            )}
            <div className="m-pads">
              {song.channels.map((ch) => (
                <button
                  key={ch.id}
                  className={`m-pad ${lit.has(ch.id) ? "hit" : seqLit.has(ch.id) && !ch.mute ? "beat" : ""} ${ch.mute ? "muted" : ""}`}
                  style={{ "--ch": padColor(ch.id) } as React.CSSProperties}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    hit(ch);
                  }}
                >
                  <span>{ch.name}</span>
                </button>
              ))}
            </div>
            <div className="m-row">
              <button className={`m-rec ${recording ? "on" : ""}`} onClick={toggleRecord} aria-pressed={recording}>
                <Icon name="record" size={12} /> {recording ? t("mobile.recordingPads") : t("mobile.recordPads")}
              </button>
              <span className="m-hint">{recording ? t("mobile.recordHintOn") : t("mobile.recordHint")}</span>
            </div>
          </section>
        )}

        {tab === "steps" && channel && (
          <section className="m-steps-view">
            <div className="m-chips" ref={chipsRef}>
              {song.channels.map((ch) => (
                <button
                  key={ch.id}
                  className={ch.id === channel.id ? "on" : ""}
                  style={{ "--ch": padColor(ch.id) } as React.CSSProperties}
                  onClick={() => setChId(ch.id)}
                >
                  {ch.name}
                </button>
              ))}
            </div>
            {channelNotes(pattern, channel.id).length > 0 ? (
              <div className="m-notes-box">
                <NotesPreview notes={channelNotes(pattern, channel.id)} steps={pattern.steps} color={padColor(channel.id)} />
                <p className="m-hint">{t("mobile.usesNotes")}</p>
              </div>
            ) : (
              <div className="m-steps" style={{ "--ch": padColor(channel.id) } as React.CSSProperties}>
                {[1, 2, 3, 4].map((beat) => (
                  <span key={`b${beat}`} className="m-beat" style={{ gridRow: beat }} aria-hidden="true">
                    {beat}
                  </span>
                ))}
                {Array.from({ length: STEPS_PER_BAR }, (_, i) => {
                  const step = curBar * STEPS_PER_BAR + i;
                  const v = stepVelocity(pattern, channel.id, step);
                  return (
                    <button
                      key={i}
                      aria-label={t("mobile.step", { n: i + 1 })}
                      aria-pressed={v > 0}
                      className={`m-step ${v > 0 ? "on" : ""} ${playStep === step ? "now" : ""} ${Math.floor(i / 4) % 2 ? "alt" : ""}`}
                      style={{ gridRow: Math.floor(i / 4) + 1, gridColumn: (i % 4) + 2 }}
                      onClick={() => update((s) => setStep(s, pattern.id, channel.id, step, v > 0 ? 0 : 1))}
                    >
                    </button>
                  );
                })}
              </div>
            )}
            {bars > 1 && (
              <div className="m-bars">
                {Array.from({ length: bars }, (_, b) => (
                  <button key={b} className={b === curBar ? "on" : ""} onClick={() => setBar(b)}>
                    {t("mobile.bar", { n: b + 1 })}
                  </button>
                ))}
              </div>
            )}
            <div className="m-actions">
              <button onClick={() => engine.previewNote(channel, channel.rootNote).catch(showError)}>
                <Icon name="play" size={14} /> {t("mobile.listen")}
              </button>
              <button className="danger" onClick={() => update((s) => clearRow(s, pattern.id, channel.id))} disabled={!(pattern.rows[channel.id] ?? []).some((v) => v > 0)}>
                <Icon name="eraser" size={14} /> {t("mobile.clear")}
              </button>
            </div>
            <div className="m-mix">
              <button className={`m-toggle ${channel.mute ? "on" : ""}`} onClick={() => update((s) => updateChannel(s, channel.id, { mute: !channel.mute }))}>
                {t("insp.mute")}
              </button>
              <label>
                {t("studio.volume")}
                <input
                  type="range"
                  min={0}
                  max={1.25}
                  step={0.01}
                  value={mixOf(song, pattern.id, channel.id).volume}
                  onChange={(e) => update((s) => setMix(s, pattern.id, channel.id, { volume: Number(e.target.value) }), `m-vol-${channel.id}-${pattern.id}`)}
                />
              </label>
            </div>
          </section>
        )}

        {tab === "sounds" && (
          <SoundsView library={library} packs={packs} onLoad={loadLibrary} onPreview={(s) => engine.preview(s).catch(showError)} onAdd={addSound} />
        )}
      </main>

      <nav className="m-tabs" role="tablist">
        {(
          [
            ["pads", "drum", t("mobile.tabPads")],
            ["steps", "steps", t("mobile.tabSteps")],
            ["sounds", "note", t("mobile.tabSounds")],
          ] as const
        ).map(([id, icon, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <Icon name={icon} size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {help && <MobileHelp onClose={() => setHelp(false)} />}

      {toast && (
        <div className="m-toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

function SoundsView({
  library,
  packs,
  onLoad,
  onPreview,
  onAdd,
}: {
  library: LibrarySession[];
  packs: PackInfo[];
  onLoad: () => void;
  onPreview: (s: SoundRef) => void;
  onAdd: (s: SoundRef, name: string) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    onLoad();
    // Load once when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const row = (key: string, sound: SoundRef, name: string) => (
    <li key={key}>
      <button className="m-sound" onClick={() => onPreview(sound)}>
        <Icon name="play" size={14} /> {name}
      </button>
      <button className="m-addsound" aria-label={`${t("mobile.add")}: ${name}`} onClick={() => onAdd(sound, name)}>
        <Icon name="plus" size={16} /> {t("mobile.add")}
      </button>
    </li>
  );
  return (
    <section className="m-sounds">
      <h2>{t("studio.builtinKit")}</h2>
      <ul>{BUILTIN_DRUMS.map((d) => row(d, { kind: "builtin", id: d }, t(`studio.drums.${d}`)))}</ul>
      <h2>{t("studio.synth")}</h2>
      <ul>{SYNTH_PRESETS.map((p) => row(p, { kind: "synth", preset: p }, t(`studio.synths.${p}`)))}</ul>
      {library.map((s) => (
        <div key={s.id}>
          <h2>{s.name}</h2>
          <ul>{s.samples.map((smp) => row(smp.id, { kind: "sample", sessionId: s.id, sampleId: smp.id }, smp.name))}</ul>
        </div>
      ))}
      {library.length === 0 && <p className="m-hint">{t("studio.libraryEmpty")}</p>}
      {packs.map((pk) => (
        <div key={pk.id}>
          <h2>{pk.name}</h2>
          <ul>
            {visibleItems(pk.items).map((it) =>
              row(`${pk.id}/${it.id}`, it.kind === "instrument" ? { kind: "instrument", packId: pk.id, itemId: it.id } : { kind: "pack", packId: pk.id, itemId: it.id }, it.name),
            )}
          </ul>
        </div>
      ))}
    </section>
  );
}
