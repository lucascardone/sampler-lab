// The recordings folder, listed inside the app: click one to open it and cut samples.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { ItemMenu, RenameInput } from "../../ui/ItemMenu";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type RecordingFile } from "../../lib/api";
import { formatShort } from "../../lib/format";

interface Props {
  files: RecordingFile[];
  dir: string;
  busy: boolean;
  /** Paths already open in the session (shown as such). */
  openPaths: Set<string>;
  onOpen: (path: string) => void;
  onChangeDir: (dir: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (file: RecordingFile) => void;
  onError: (e: unknown) => void;
  /** Show more items (empty screen) or a compact list (sidebar). */
  limit?: number;
}

export function RecordingsList({ files, dir, busy, openPaths, onOpen, onChangeDir, onRename, onDelete, onError, limit }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const shown = limit ? files.slice(0, limit) : files;

  const pickDir = async () => {
    const d = await open({ directory: true, multiple: false, defaultPath: dir || undefined, title: t("recording.pickDir") });
    if (typeof d === "string") onChangeDir(d);
  };

  return (
    <div className="recordings">
      {files.length === 0 ? (
        <p className="muted small hint">{t("recording.empty")}</p>
      ) : (
        <ul>
          {shown.map((f) => {
            const isOpen = openPaths.has(f.path);
            return (
              <li key={f.path} onClick={() => !busy && editing !== f.path && onOpen(f.path)} title={f.path}>
                <span className="item-icon rec-icon">
                  <Icon name="record" size={10} />
                </span>
                {editing === f.path ? (
                  <RenameInput
                    value={f.name}
                    onDone={(name) => {
                      setEditing(null);
                      if (name) onRename(f.path, name);
                    }}
                  />
                ) : (
                  <span
                    className="item-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditing(f.path);
                    }}
                  >
                    {prettyName(f.name)}
                  </span>
                )}
                <span className="item-meta">
                  {isOpen && <span className="badge">{t("recording.inSession")}</span>}
                  {formatShort(f.seconds)}
                </span>
                <ItemMenu name={prettyName(f.name)} disabled={busy} onRename={() => setEditing(f.path)} onDelete={() => onDelete(f)} />
              </li>
            );
          })}
        </ul>
      )}
      {limit && files.length > limit && <p className="muted small hint">{t("recording.more", { n: files.length - limit })}</p>}
      <div className="rec-folder">
        <button className="link" onClick={() => api.openRecordingsDir().catch(onError)} title={dir}>
          <Icon name="folder" /> {t("recording.openDir")}
        </button>
        <button className="link" onClick={pickDir}>
          {t("recording.changeDir")}
        </button>
      </div>
    </div>
  );
}

/** "Grabación 2026-11-08 14.32.05" → "8/11 14:32" (keeps custom names as they are). */
export function prettyName(name: string): string {
  const m = name.match(/^Grabación (\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return name;
  const [, , mo, d, h, mi] = m;
  return `${Number(d)}/${Number(mo)} ${h}:${mi}`;
}
