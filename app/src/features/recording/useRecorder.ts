// Recording state shared by the record button and the recordings list. The tray icon
// can start/stop recordings too, so everything is driven by backend events.
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type RecordingFile, type RecordingSaved, type RecordingStatus, type RecordingTick } from "../../lib/api";

export function useRecorder(onSaved: (r: RecordingSaved) => void, onError: (e: unknown) => void) {
  const [status, setStatus] = useState<RecordingStatus>({ recording: false, seconds: 0, dir: "" });
  const [level, setLevel] = useState(0);
  const [files, setFiles] = useState<RecordingFile[]>([]);

  const refresh = useCallback(() => {
    api.listRecordings().then(setFiles).catch(() => {});
  }, []);

  useEffect(() => {
    api.recordingStatus().then(setStatus).catch(() => {});
    refresh();
    const subs = [
      listen<RecordingStatus>("recording-state", (e) => {
        setStatus(e.payload);
        if (!e.payload.recording) setLevel(0);
      }),
      listen<RecordingTick>("recording-tick", (e) => {
        setStatus((s) => ({ ...s, recording: true, seconds: e.payload.seconds }));
        setLevel(e.payload.level);
      }),
      listen<RecordingSaved>("recording-saved", (e) => {
        refresh();
        onSaved(e.payload);
      }),
      listen<string>("recording-error", (e) => onError(e.payload)),
    ];
    // Recordings may also be added/removed in the folder from outside the app.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      subs.forEach((p) => p.then((un) => un()));
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    try {
      if (status.recording) await api.stopRecording();
      else setStatus(await api.startRecording());
    } catch (e) {
      onError(e);
    }
  };

  const changeDir = async (dir: string) => {
    try {
      setStatus(await api.setRecordingsDir(dir));
      refresh();
    } catch (e) {
      onError(e);
    }
  };

  const rename = async (path: string, name: string) => {
    try {
      setFiles(await api.renameRecording(path, name));
    } catch (e) {
      onError(e);
    }
  };

  /** To the Recycle Bin. */
  const remove = async (path: string) => {
    try {
      setFiles(await api.deleteRecording(path));
    } catch (e) {
      onError(e);
    }
  };

  return { status, level, files, toggle, refresh, changeDir, rename, remove };
}
