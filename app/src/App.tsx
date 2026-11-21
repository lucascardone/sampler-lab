import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, AUDIO_EXTENSIONS, type RecordingFile, type Session, type TimeRange } from "./lib/api";
import { useExportLabel, useExportSettings } from "./features/export/ExportOptions";
import { SampleEditor } from "./features/editor/SampleEditor";
import { SourceView, type ViewHandle } from "./features/editor/SourceView";
import { Sidebar, type View } from "./features/session/Sidebar";
import { RecordButton } from "./features/recording/RecordButton";
import { prettyName, RecordingsList } from "./features/recording/RecordingsList";
import { useRecorder } from "./features/recording/useRecorder";
import { StudioView, type StudioHandle } from "./features/studio/StudioView";
import { PhoneDialog } from "./features/remote/PhoneDialog";
import { JamDialog } from "./features/jam/JamDialog";
import { jamRoom } from "./features/jam/room";
import { useJam } from "./features/jam/useJam";
import { HelpDialog } from "./features/help/HelpDialog";
import type { RemoteInfo } from "./lib/api";
import { formatShort } from "./lib/format";
import { Icon } from "./ui/Icon";
import { isTextEntry } from "./ui/keys";
import "./App.css";

type Toast = { kind: "error" | "info"; text: string };

export default function App() {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [lastSession, setLastSession] = useState<{ name: string; samples: number } | null>(null);
  const [sourceSelection, setSourceSelection] = useState<TimeRange | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [exportSettings, setExportSettings] = useExportSettings();
  const exportLabel = useExportLabel(exportSettings);
  const [dragOver, setDragOver] = useState(false);
  const viewRef = useRef<ViewHandle>(null);
  const studioRef = useRef<StudioHandle>(null);
  const [tab, setTab] = useState<"samples" | "studio">("samples");
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [jamOpen, setJamOpen] = useState(false);
  const jam = useJam();
  const [helpOpen, setHelpOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);

  const showError = useCallback((e: unknown) => setToast({ kind: "error", text: String(e) }), []);
  const showInfo = useCallback((text: string) => setToast({ kind: "info", text }), []);

  // Room notices (someone joined, left, the room closed) as toasts.
  useEffect(() => {
    jamRoom().onNotice((text, error) => setToast({ kind: error ? "error" : "info", text }));
  }, []);
  // Joining a room puts you in the studio, where the music is.
  useEffect(() => {
    if (jam.role === "guest") setTab("studio");
  }, [jam.role]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.kind === "error" ? 7000 : 3500);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    api.lastSession().then(setLastSession).catch(() => {});
  }, []);

  const recorder = useRecorder(
    (r) =>
      r.silent
        ? setToast({ kind: "error", text: t("recording.silent") })
        : setToast({ kind: "info", text: t("recording.saved", { length: formatShort(r.seconds) }) }),
    showError,
  );

  /** Accept a new session from the backend; keep the current view if it still exists. */
  const applySession = useCallback((s: Session, openSampleId?: string) => {
    setSession(s);
    setView((v) => {
      if (openSampleId) return { kind: "sample", id: openSampleId };
      const exists =
        v && (v.kind === "source" ? s.sources.some((x) => x.id === v.id) : s.samples.some((x) => x.id === v.id));
      if (exists) return v;
      const file = s.sources.find((x) => x.kind.kind === "file");
      return file ? { kind: "source", id: file.id } : null;
    });
  }, []);

  // The studio can rename/delete samples of the open session too (or a recording rename
  // can relink it): keep the Samples tab in step.
  useEffect(() => {
    const un = listen<Session>("session-changed", (e) => applySession(e.payload));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, [applySession]);

  const run = useCallback(
    async (fn: () => Promise<Session>) => {
      setBusy(true);
      try {
        applySession(await fn());
      } catch (e) {
        showError(e);
      } finally {
        setBusy(false);
      }
    },
    [applySession, showError],
  );

  const openPath = useCallback(
    async (path: string) => {
      setSourceSelection(null);
      setView(null);
      await run(() => api.openAudio(path));
    },
    [run],
  );

  const pickFile = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (typeof path === "string") await openPath(path);
  };

  // Drag & drop a file from the OS onto the window.
  useEffect(() => {
    // Outside Tauri (e.g. a dev reload while the backend restarts) there's no webview;
    // drag & drop is a convenience, so never let it take the app down.
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    const unlisten = webview.onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragOver(true);
      else if (p.type === "leave") setDragOver(false);
      else if (p.type === "drop") {
        setDragOver(false);
        const file = p.paths.find((f) => AUDIO_EXTENSIONS.includes(f.split(".").pop()?.toLowerCase() ?? ""));
        if (file) openPath(file);
        else if (p.paths.length) showError(t("errors.unsupportedFile"));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [openPath, showError, t]);

  /** Open a recording (or any file) next to what's already in the session. */
  const openRecording = async (path: string) => {
    setBusy(true);
    try {
      const r = await api.addAudio(path);
      setSession(r.session);
      setSourceSelection(null);
      setView({ kind: "source", id: r.sourceId });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const createSample = async (range: TimeRange) => {
    if (!view || view.kind !== "source") return;
    setBusy(true);
    try {
      const r = await api.createSample(view.id, range);
      setSession(r.session);
      setSourceSelection(null);
      const s = r.session.samples.find((x) => x.id === r.sampleId);
      // Stay on the original so the next cut is one drag away.
      showInfo(t("source.saved", { name: s?.name ?? "" }));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const deleteSample = async (id: string) => {
    const s = session?.samples.find((x) => x.id === id);
    const ok = await ask(t("sidebar.deleteConfirm", { name: s?.name ?? "" }), {
      kind: "warning",
      title: t("app.title"),
      okLabel: t("items.delete"),
      cancelLabel: t("items.cancel"),
    });
    if (ok) await run(() => api.deleteSample(id));
  };

  /** Recordings go to the Recycle Bin; warn if samples were cut from it. */
  const deleteRecording = async (f: RecordingFile) => {
    const used = await api.recordingUsage(f.path).catch(() => 0);
    const msg = [t("recording.deleteConfirm", { name: prettyName(f.name) }), used ? t("recording.deleteUsed", { count: used }) : ""]
      .filter(Boolean)
      .join("\n\n");
    if (await ask(msg, { kind: "warning", title: t("app.title"), okLabel: t("items.delete"), cancelLabel: t("items.cancel") }))
      await recorder.remove(f.path);
  };

  const exportAll = async () => {
    const dir = await open({ directory: true, multiple: false, title: t("sidebar.exportAllTitle") });
    if (typeof dir !== "string") return;
    setBusy(true);
    try {
      const files = await api.exportAll(dir, exportSettings.format, exportSettings.channels);
      showInfo(t("sidebar.exportAllDone", { n: files.length, dir }));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcuts.
  const keys = useRef({ view, session, run, tab });
  keys.current = { view, session, run, tab };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const { view, run, tab } = keys.current;
      if (tab !== "samples") return; // the studio has its own shortcuts
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        e.preventDefault();
        viewRef.current?.togglePlay();
      } else if (e.key === "Enter") {
        viewRef.current?.primaryAction();
      } else if (mod && view?.kind === "sample" && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        const redo = e.key.toLowerCase() === "y" || e.shiftKey;
        run(() => (redo ? api.redo(view.id) : api.undo(view.id)));
      } else if (e.key === "Escape") {
        setSourceSelection(null);
      }
    };
    // Space is play/stop everywhere: it must not also "press" the focused button or toggle
    // the focused checkbox when released.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTextEntry(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  const currentSource = view?.kind === "source" ? session?.sources.find((s) => s.id === view.id) : undefined;
  const currentSample = view?.kind === "sample" ? session?.samples.find((s) => s.id === view.id) : undefined;
  /** "de Shiver", or for stems "Voz separada de Sample 3". */
  const originLabel = (sourceId: string) => {
    const src = session?.sources.find((s) => s.id === sourceId);
    if (!src) return "";
    if (src.kind.kind === "stem") {
      const { parentSampleId, stem } = src.kind;
      const parent = session?.samples.find((s) => s.id === parentSampleId)?.name ?? t("sample.deleted");
      return t("sample.stemOf", { stem: t(`stems.${stem}`), parent });
    }
    return t("sample.from", { source: src.name });
  };

  const openPaths = new Set(session?.sources.map((s) => s.path) ?? []);
  const recordingsList = (limit: number) => (
    <RecordingsList
      files={recorder.files}
      dir={recorder.status.dir}
      busy={busy}
      openPaths={openPaths}
      onOpen={openRecording}
      onChangeDir={recorder.changeDir}
      onRename={recorder.rename}
      onDelete={deleteRecording}
      onError={showError}
      limit={limit}
    />
  );

  return (
    <div className={`app ${dragOver ? "drag-over" : ""}`}>
      <header className="topbar">
        <h1>{t("app.title")}</h1>
        <nav className="tabs">
          <button className={tab === "samples" ? "on" : ""} onClick={() => setTab("samples")}>
            {t("tabs.samples")}
          </button>
          <button className={tab === "studio" ? "on" : ""} onClick={() => setTab("studio")}>
            {t("tabs.studio")}
          </button>
        </nav>
        <div className="spacer" />
        {busy && <span className="muted small">{t("status.working")}</span>}
        <RecordButton
          recording={recorder.status.recording}
          seconds={recorder.status.seconds}
          level={recorder.level}
          onToggle={recorder.toggle}
        />
        <button className="help-btn" onClick={() => setHelpOpen(true)} title={t("help.open")}>
          <Icon name="help" /> {t("help.button")}
        </button>
        <button className={`phone-btn ${jam.role !== "off" ? "on" : ""}`} onClick={() => setJamOpen(true)} title={t("jam.buttonHint")}>
          <Icon name="people" /> {jam.role !== "off" ? t("jam.buttonOn") : t("jam.button")}
        </button>
        <button className={`phone-btn ${remote ? "on" : ""}`} onClick={() => setPhoneOpen(true)} title={t("phone.buttonHint")}>
          <Icon name="phone" /> {remote ? t("phone.buttonOn") : t("phone.button")}
        </button>
        {tab === "studio" && (
          <button className="export-btn" onClick={() => studioRef.current?.openExport()}>
            <Icon name="download" /> {t("studio.exportButton")}
          </button>
        )}
        {tab === "samples" && (
          <button onClick={pickFile} disabled={busy}>
            {session ? t("toolbar.open") : t("toolbar.openFirst")}
          </button>
        )}
      </header>

      {/* Always mounted (hidden on the other tab) so the beat keeps playing while you cut samples. */}
      <div className="studio-host" hidden={tab !== "studio"}>
        <StudioView
          ref={studioRef}
          active={tab === "studio"}
          exportSettings={exportSettings}
          setExportSettings={setExportSettings}
          onError={showError}
          onInfo={showInfo}
        />
      </div>

      {tab !== "samples" ? null : !session ? (
        <main className="empty">
          <div className="drop-target" onClick={pickFile}>
            <div className="drop-icon">
              <Icon name="note" size={44} />
            </div>
            <h2>{t("empty.title")}</h2>
            <p className="muted">{t("empty.or")}</p>
            <button className="primary" disabled={busy}>
              {busy ? t("status.loading") : t("empty.open")}
            </button>
            <p className="muted small">{t("empty.formats")}</p>
          </div>
          <section className="empty-recordings">
            <h3>{t("recording.title")}</h3>
            <p className="muted small">{t("recording.trayHint")}</p>
            {recordingsList(8)}
          </section>
          <p className="legal muted small">{t("app.legal")}</p>
          {lastSession && (
            <button className="resume" disabled={busy} onClick={() => run(() => api.restoreSession())}>
              <Icon name="refresh" /> {t("empty.resume", { name: lastSession.name, count: lastSession.samples })}
            </button>
          )}
        </main>
      ) : (
        <div className="workspace">
          <Sidebar
            session={session}
            view={view ?? { kind: "source", id: "" }}
            busy={busy}
            onSelect={setView}
            onRename={(id, name) => run(() => api.renameSample(id, name))}
            onDelete={deleteSample}
            onExportAll={exportAll}
            exportLabel={exportLabel}
            recordings={recordingsList(6)}
          />
          {currentSource && (
            <SourceView
              ref={viewRef}
              source={currentSource}
              samples={session.samples}
              selection={sourceSelection}
              setSelection={setSourceSelection}
              busy={busy}
              onCreateSample={createSample}
            />
          )}
          {currentSample && (
            <SampleEditor
              ref={viewRef}
              sample={currentSample}
              origin={originLabel(currentSample.sourceId)}
              busy={busy}
              run={run}
              onSession={applySession}
              onError={showError}
              onInfo={showInfo}
              exportSettings={exportSettings}
              setExportSettings={setExportSettings}
              sessionId={session.id}
              onUseInStudio={() => {
                studioRef.current?.addSound(
                  { kind: "sample", sessionId: session.id, sampleId: currentSample.id },
                  currentSample.name,
                );
                showInfo(t("studio.addedToStudio", { name: currentSample.name }));
                setTab("studio");
              }}
            />
          )}
        </div>
      )}


      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {jamOpen && <JamDialog onClose={() => setJamOpen(false)} onError={showError} />}
      {phoneOpen && <PhoneDialog info={remote} setInfo={setRemote} onClose={() => setPhoneOpen(false)} onError={showError} />}

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
