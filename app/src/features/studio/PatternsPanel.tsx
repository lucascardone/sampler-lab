// Studio sidebar view "Patrones": every pattern of the song as a vertical list, so many
// patterns stay readable (the old horizontal tabs overflowed). The one being edited is
// highlighted; a green dot marks the ones sounding; ⋯ has Duplicar / Poner en la
// canción / Renombrar / Borrar. Double-click to rename is only a shortcut.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { ItemMenu, RenameInput } from "../../ui/ItemMenu";
import { patternColor } from "./colors";
import { STEPS_PER_BAR, type Song } from "./song";

interface Mark {
  name: string;
  color: string;
}

interface Props {
  song: Song;
  /** Pattern ids sounding right now. */
  playing: Set<string>;
  /** "Tocar juntos": who is looking at each pattern. */
  marks: Record<string, Mark[] | undefined>;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onPutInSong: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PatternsPanel({ song, playing, marks, onPick, onNew, onRename, onDuplicate, onPutInSong, onDelete }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  const current = song.currentPatternId;

  // Keep the pattern being edited in view (a new one lands at the end of a long list).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const uses = (id: string) => song.clips.filter((c) => c.kind === "pattern" && c.patternId === id).length;

  return (
    <nav className="sidebar patterns-panel" aria-label={t("studio.patterns")}>
      <h3 className="lib-head">
        {t("studio.patterns")}
        <span className="lib-count">{song.patterns.length}</span>
      </h3>
      <button className="pat-new" onClick={onNew}>
        <Icon name="plus" size={14} /> {t("studio.newPatternLabel")}
      </button>
      <ul>
        {song.patterns.map((p) => {
          const on = p.id === current;
          const n = uses(p.id);
          if (editing === p.id)
            return (
              <li key={p.id} className="lib-renaming active">
                <i className="pat-swatch" style={{ background: patternColor(p.id) }} />
                <RenameInput
                  value={p.name}
                  onDone={(name) => {
                    setEditing(null);
                    if (name) onRename(p.id, name);
                  }}
                />
              </li>
            );
          return (
            <li key={p.id} ref={on ? activeRef : undefined} className={on ? "active" : undefined}>
              <button
                className="pat-pick"
                aria-current={on ? "true" : undefined}
                onClick={() => onPick(p.id)}
                onDoubleClick={() => setEditing(p.id)}
                title={t("studio.patternPickHint")}
              >
                <i className="pat-swatch" style={{ background: patternColor(p.id) }} />
                <span className="item-name" title={p.name}>{p.name}</span>
                {playing.has(p.id) && <i className="pat-playing" title={t("studio.patternPlaying")} aria-label={t("studio.patternPlaying")} />}
                {marks[p.id]?.map((m) => (
                  <span key={m.name} className="jam-dot" style={{ background: m.color }} title={t("jam.touching", { name: m.name })} />
                ))}
                <span className="item-meta" title={n ? t("studio.patternUses", { count: n }) : t("studio.patternUnused")}>
                  {t("studio.barsShort", { count: p.steps / STEPS_PER_BAR })}
                  {n > 0 && <Icon name="toSong" size={12} />}
                </span>
              </button>
              <ItemMenu
                name={p.name}
                actions={[
                  { icon: "copy", label: t("studio.duplicate"), onClick: () => onDuplicate(p.id) },
                  { icon: "toSong", label: t("studio.putInSong"), onClick: () => onPutInSong(p.id) },
                ]}
                onRename={() => setEditing(p.id)}
                onDelete={() => onDelete(p.id)}
                deleteDisabled={song.patterns.length <= 1}
              />
            </li>
          );
        })}
      </ul>
      <p className="muted small hint">{t("studio.patternsHint")}</p>
    </nav>
  );
}
