// Session sidebar: the original file(s) and every sample cut from them.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { ItemMenu, RenameInput } from "../../ui/ItemMenu";
import type { Session } from "../../lib/api";
import { formatShort } from "../../lib/format";
import { prettyName } from "../recording/RecordingsList";

export type View = { kind: "source"; id: string } | { kind: "sample"; id: string };

interface Props {
  session: Session;
  view: View;
  busy: boolean;
  onSelect: (v: View) => void;
  onRename: (sampleId: string, name: string) => void;
  onDelete: (sampleId: string) => void;
  onExportAll: () => void;
  /** Current export format, e.g. "WAV PCM 24 bit · Estéreo". */
  exportLabel: string;
  /** The recordings list, rendered as its own section. */
  recordings?: ReactNode;
}

export function Sidebar({ session, view, busy, onSelect, onRename, onDelete, onExportAll, exportLabel, recordings }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const files = session.sources.filter((s) => s.kind.kind === "file");
  const sourceOf = (id: string) => session.sources.find((s) => s.id === id);

  return (
    <nav className="sidebar">
      <h3>{t("sidebar.original")}</h3>
      <ul>
        {files.map((f) => (
          <li
            key={f.id}
            className={view.kind === "source" && view.id === f.id ? "active" : ""}
            onClick={() => onSelect({ kind: "source", id: f.id })}
          >
            <span className="item-icon">
              <Icon name="note" size={14} />
            </span>
            <span className="item-name" title={f.name}>
              {prettyName(f.name)}
            </span>
            <span className="item-meta">{formatShort(f.duration)}</span>
          </li>
        ))}
      </ul>

      <h3>
        {t("sidebar.samples")} <span className="muted">({session.samples.length})</span>
      </h3>
      {session.samples.length === 0 ? (
        <p className="muted small hint">{t("sidebar.emptyHint")}</p>
      ) : (
        <ul>
          {session.samples.map((s) => {
            const src = sourceOf(s.sourceId);
            const isStem = src?.kind.kind === "stem";
            const active = view.kind === "sample" && view.id === s.id;
            const fxOn = s.effects.filter((e) => e.enabled).length;
            return (
              <li key={s.id} className={active ? "active" : ""} onClick={() => onSelect({ kind: "sample", id: s.id })}>
                <span className="item-icon">
                  <Icon name={isStem ? "layers" : "scissors"} size={14} />
                </span>
                {editing === s.id ? (
                  <RenameInput
                    value={s.name}
                    onDone={(name) => {
                      setEditing(null);
                      if (name) onRename(s.id, name);
                    }}
                  />
                ) : (
                  <span
                    className="item-name"
                    title={t("sidebar.renameHint")}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditing(s.id);
                    }}
                  >
                    {s.name}
                  </span>
                )}
                <span className="item-meta">
                  {fxOn > 0 && <span className="badge" title={t("sidebar.effectsCount", { n: fxOn })}>fx {fxOn}</span>}
                  {formatShort(s.end - s.start)}
                </span>
                <ItemMenu name={s.name} disabled={busy} onRename={() => setEditing(s.id)} onDelete={() => onDelete(s.id)} />
              </li>
            );
          })}
        </ul>
      )}

      {recordings && (
        <>
          <h3>{t("recording.title")}</h3>
          {recordings}
        </>
      )}

      <div className="spacer" />
      <button onClick={onExportAll} disabled={busy || session.samples.length === 0}>
        <Icon name="download" /> {t("sidebar.exportAll")}
      </button>
      <p className="muted small export-label">{exportLabel}</p>
    </nav>
  );
}
