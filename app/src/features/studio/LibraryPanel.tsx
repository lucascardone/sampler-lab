// Studio sidebar: the built-in kit + synths, every sample of every session, and the
// installed sound packs (with visible buttons to import a folder or get more).
// Big packs split themselves into small folders (libraryTree.ts), long lists are drawn a
// page at a time, a search box finds any sound, and open/closed folders are remembered.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LibrarySession, PackInfo, PackItem } from "../../lib/api";
import { prettyName } from "../recording/RecordingsList";
import { Icon, IconButton, type IconName } from "../../ui/Icon";
import { ItemMenu, RenameInput } from "../../ui/ItemMenu";
import { BUILTIN_DRUMS, SYNTH_PRESETS, type SoundRef } from "./song";
import { PAGE, groupItems, loadOpen, matches, saveOpen, visibleItems, type ItemGroup, type OpenState } from "./libraryTree";

interface Props {
  sessions: LibrarySession[];
  onPreview: (s: SoundRef) => void;
  onAdd: (s: SoundRef, name: string) => void;
  /** Place a sample on the timeline as an audio clip. */
  onAddToSong: (s: SoundRef, name: string) => void;
  onRefresh: () => void;
  onRename: (sessionId: string, sampleId: string, oldName: string, name: string) => void;
  onDelete: (sessionId: string, sampleId: string, name: string) => void;
  packs: PackInfo[];
  onImportFolder: () => void;
  onGetMore: () => void;
  onPackRename: (id: string, name: string) => void;
  onPackDelete: (pack: PackInfo) => void;
  /**
   * "Tocar juntos" guest: these are the sounds of the host's PC (whose room it is).
   * They can be used, not renamed, deleted or added to.
   */
  roomName?: string;
}

/** Short license label: what you can do with it, in plain words. */
export function licenseKind(license: string): "own" | "free" | "credit" | "personal" | "mixed" | "other" {
  const l = license.toUpperCase();
  if (l === "OWN") return "own";
  // "Sonidos de internet": each sound carries its own credit.
  if (l === "MIXED") return "mixed";
  if (l.startsWith("CC0") || l === "PDM" || l === "UNLICENSE") return "free";
  if (l.includes("NC")) return "personal";
  if (l.startsWith("CC-BY") || l === "MIT" || l.startsWith("BSD")) return "credit";
  return "other";
}

const CATEGORY_ICON: Record<string, IconName> = { drums: "drum", bass: "wave", keys: "piano", synth: "wave", fx: "sparkle", vocals: "note" };

/** One row to draw: what it plays, its name and icon. */
interface Row {
  key: string;
  sound: SoundRef;
  name: string;
  icon: IconName;
  title?: string;
}

/** Sessions open by default (the rest start closed, so many sessions stay tidy). */
const OPEN_SESSIONS = 3;

export function LibraryPanel(props: Props) {
  const { sessions, onPreview, onAdd, onAddToSong, onRefresh, onRename, onDelete, packs } = props;
  const { t } = useTranslation();
  /** "session/sample" (or "pack:<id>") being renamed. */
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenState>(loadOpen);
  const [query, setQuery] = useState("");
  /** Rows shown per list beyond the first page ("Mostrar más"). */
  const [shown, setShown] = useState<Record<string, number>>({});

  const isOpen = (id: string, byDefault: boolean) => open[id] ?? byDefault;
  const setFolder = (id: string, value: boolean) =>
    setOpen((o) => {
      const n = { ...o, [id]: value };
      saveOpen(n);
      return n;
    });

  // ---- rows ----

  const builtinRows: Row[] = BUILTIN_DRUMS.map((d) => ({ key: d, sound: { kind: "builtin", id: d }, name: t(`studio.drums.${d}`), icon: "drum" }));
  const synthRows: Row[] = SYNTH_PRESETS.map((p) => ({
    key: `synth-${p}`,
    sound: { kind: "synth", preset: p },
    name: t(`studio.synths.${p}`),
    icon: "wave",
    title: t(`studio.synthHints.${p}`),
  }));
  const sessionRows = (s: LibrarySession): Row[] =>
    s.samples.map((smp) => ({
      key: smp.id,
      sound: { kind: "sample", sessionId: s.id, sampleId: smp.id },
      name: smp.name,
      icon: smp.isStem ? "layers" : "note",
      title: smp.isStem ? t("studio.stem") : undefined,
    }));
  const packRow = (pk: PackInfo, it: PackItem): Row => ({
    key: `${pk.id}/${it.id}`,
    sound: it.kind === "instrument" ? { kind: "instrument", packId: pk.id, itemId: it.id } : { kind: "pack", packId: pk.id, itemId: it.id },
    name: it.name,
    icon: it.kind === "instrument" ? "piano" : (CATEGORY_ICON[it.category] ?? "note"),
    title: it.kind === "instrument" ? t("packs.instrumentHint") : undefined,
  });

  const item = ({ key, sound, name, icon, title }: Row) => {
    const sample = sound.kind === "sample" ? sound : null;
    const editKey = sample ? `${sample.sessionId}/${sample.sampleId}` : "";
    if (sample && editing === editKey)
      return (
        <li key={key} className="lib-renaming">
          <Icon name={icon} size={14} />
          <RenameInput
            value={name}
            onDone={(n) => {
              setEditing(null);
              if (n) onRename(sample.sessionId, sample.sampleId, name, n);
            }}
          />
        </li>
      );
    return (
      <li key={key} title={title}>
        <button
          className="lib-play"
          onClick={() => onPreview(sound)}
          onDoubleClick={sample && !props.roomName ? () => setEditing(editKey) : undefined}
          title={sample ? t("studio.previewOrRename") : t("studio.preview")}
          aria-label={`${t("studio.preview")}: ${name}`}
        >
          <Icon name={icon} size={14} />
          <span className="item-name">{name}</span>
        </button>
        {sample && <IconButton icon="toSong" tone="ghost" label={`${t("timeline.addToSong")}: ${name}`} onClick={() => onAddToSong(sound, name)} />}
        <IconButton icon="plus" tone="ghost" label={`${t("studio.add")}: ${name}`} onClick={() => onAdd(sound, name)} />
        {sample && !props.roomName && (
          <ItemMenu
            name={name}
            onRename={() => setEditing(editKey)}
            onDelete={() => onDelete(sample.sessionId, sample.sampleId, name)}
          />
        )}
      </li>
    );
  };

  /** A list drawn a page at a time: a pack can bring hundreds of sounds. */
  const rows = (listId: string, list: Row[]) => {
    const limit = PAGE + (shown[listId] ?? 0);
    const rest = list.length - limit;
    return (
      <>
        <ul>{list.slice(0, limit).map(item)}</ul>
        {rest > 0 && (
          <button className="lib-more" onClick={() => setShown((s) => ({ ...s, [listId]: (s[listId] ?? 0) + PAGE * 2 }))}>
            {rest <= PAGE * 2 ? t("studio.libMore", { n: rest }) : t("studio.libMoreOf", { n: PAGE * 2, total: rest })}
          </button>
        )}
      </>
    );
  };

  /** A folder that opens and closes, remembered across sessions. */
  const folder = (id: string, label: ReactNode, count: number | null, byDefault: boolean, body: () => ReactNode, opts: { sub?: boolean; title?: string } = {}) => {
    const o = isOpen(id, byDefault);
    return (
      <section key={id} className={opts.sub ? "lib-sub" : undefined}>
        <button className="lib-folder" aria-expanded={o} onClick={() => setFolder(id, !o)} title={opts.title}>
          <Icon name="chevron" size={12} className={o ? "" : "closed"} />
          <span className="item-name">{label}</span>
          {count !== null && <span className="lib-count">{count}</span>}
        </button>
        {o && body()}
      </section>
    );
  };

  const groupLabel = (g: ItemGroup) =>
    g.key === "instruments"
      ? t("packs.group.instruments")
      : g.key.startsWith("cat:")
        ? t(`packs.category.${g.label}`, { defaultValue: g.label })
        : g.label || t("packs.group.loose");

  /** A pack's sounds: one list, or small folders when there are many. */
  const packBody = (pk: PackInfo) => {
    const groups = groupItems(pk.items);
    if (!groups) return rows(`pack:${pk.id}`, visibleItems(pk.items).map((it) => packRow(pk, it)));
    return groups.map((g) =>
      folder(`pack:${pk.id}/${g.key}`, groupLabel(g), g.items.length, false, () => rows(`pack:${pk.id}/${g.key}`, g.items.map((it) => packRow(pk, it))), { sub: true }),
    );
  };

  const packHead = (pk: PackInfo, o: boolean, key: string) => {
    if (editing === key)
      return (
        <div className="lib-pack-head lib-renaming">
          <RenameInput
            value={pk.name}
            onDone={(n) => {
              setEditing(null);
              if (n) props.onPackRename(pk.id, n);
            }}
          />
        </div>
      );
    return (
      <div className="lib-pack-head">
        <button className="lib-folder" aria-expanded={o} onClick={() => setFolder(key, !o)} title={pk.author ? `${pk.name} · ${pk.author}` : pk.name}>
          <Icon name="chevron" size={12} className={o ? "" : "closed"} />
          <span className="item-name">{pk.name}</span>
          <span className="lib-count">{visibleItems(pk.items).length}</span>
        </button>
        {!props.roomName && <ItemMenu name={pk.name} onRename={() => setEditing(key)} onDelete={() => props.onPackDelete(pk)} />}
      </div>
    );
  };

  /** License and author, shown once the pack is open (headers stay short). */
  const packMeta = (pk: PackInfo) => {
    const lic = licenseKind(pk.license);
    if (lic === "own" && !pk.author) return null;
    return (
      <p className="lib-pack-meta">
        {lic !== "own" && (
          <span className={`lic-badge ${lic}`} title={t(`packs.license.${lic}Hint`)}>
            {t(`packs.license.${lic}`)}
          </span>
        )}
        {pk.author && <span className="item-name">{pk.author}</span>}
      </p>
    );
  };

  const collapseAll = () => {
    const n: OpenState = { ...open, builtin: false, synth: false, packs: true };
    for (const s of sessions) n[`s:${s.id}`] = false;
    for (const k of Object.keys(n)) if (k.startsWith("pack:")) n[k] = false;
    for (const pk of packs) n[`pack:${pk.id}`] = false;
    saveOpen(n);
    setOpen(n);
  };

  // ---- search: every matching sound, by where it lives ----

  const results = () => {
    const sections: { id: string; label: string; rows: Row[] }[] = [
      { id: "builtin", label: t("studio.builtinKit"), rows: builtinRows.filter((r) => matches(r.name, query)) },
      { id: "synth", label: t("studio.synth"), rows: synthRows.filter((r) => matches(`${r.name} ${r.title ?? ""}`, query)) },
      ...sessions.map((s) => ({ id: `s:${s.id}`, label: prettyName(s.name), rows: sessionRows(s).filter((r) => matches(`${r.name} ${s.name}`, query)) })),
      ...packs.map((pk) => ({
        id: `pack:${pk.id}`,
        label: pk.name,
        rows: visibleItems(pk.items)
          .filter((it) => matches(`${it.name} ${pk.name} ${t(`packs.category.${it.category}`, { defaultValue: "" })}`, query))
          .map((it) => packRow(pk, it)),
      })),
    ].filter((s) => s.rows.length);
    if (!sections.length) return <p className="muted small hint">{t("studio.libNoMatch", { q: query.trim() })}</p>;
    return sections.map((s) => (
      <section key={s.id}>
        <h4 className="lib-group lib-result-head">
          <span className="item-name">{s.label}</span>
          <span className="lib-count">{s.rows.length}</span>
        </h4>
        {rows(`q:${s.id}`, s.rows)}
      </section>
    ));
  };

  const searching = query.trim() !== "";

  return (
    <nav className="sidebar library">
      <h3 className="lib-head">
        {t("studio.library")}
        <span className="lib-head-actions">
          <IconButton icon="collapse" tone="ghost" label={t("studio.libCollapse")} onClick={collapseAll} />
          <IconButton icon="refresh" tone="ghost" label={t("studio.refresh")} onClick={onRefresh} />
        </span>
      </h3>
      {props.roomName && <p className="lib-room-note">{t("jam.roomSounds", { name: props.roomName })}</p>}
      <label className="lib-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown({});
          }}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder={t("studio.libSearch")}
          aria-label={t("studio.libSearch")}
        />
      </label>

      {searching ? (
        results()
      ) : (
        <>
          {folder("builtin", t("studio.builtinKit"), null, true, () => rows("builtin", builtinRows))}
          {folder("synth", t("studio.synth"), null, true, () => rows("synth", synthRows))}

          {sessions.length === 0 && <p className="muted small hint">{t("studio.libraryEmpty")}</p>}
          {sessions.map((s, i) => folder(`s:${s.id}`, prettyName(s.name), s.samples.length, i < OPEN_SESSIONS, () => rows(`s:${s.id}`, sessionRows(s)), { title: s.name }))}

          {folder("packs", t("packs.title"), packs.length, true, () => (
            <>
              {packs.length === 0 && <p className="muted small hint">{t("packs.empty")}</p>}
              {packs.map((pk) => {
                const key = `pack:${pk.id}`;
                const o = isOpen(key, false);
                return (
                  <div key={pk.id} className="lib-pack">
                    {packHead(pk, o, key)}
                    {o && (
                      <div className="lib-pack-body">
                        {packMeta(pk)}
                        {packBody(pk)}
                      </div>
                    )}
                  </div>
                );
              })}
              {!props.roomName && <div className="lib-pack-actions">
                <button onClick={props.onImportFolder}>
                  <Icon name="folder" size={14} /> {t("packs.importFolder")}
                </button>
                <button className="primary" onClick={props.onGetMore}>
                  <Icon name="download" size={14} /> {t("packs.getMore")}
                </button>
              </div>}
            </>
          ))}
        </>
      )}
    </nav>
  );
}
