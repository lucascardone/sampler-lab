// "Conseguir más sonidos": free instruments from catalogs kept by other people (plus our
// curated picks), free single sounds searched online, and the packs already installed
// (import a folder, see licenses, delete). Everything shows who made it and what its
// license lets you do, in plain words.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { api, type CatalogEntry, type CatalogList, type PackInfo, type PackProgress } from "../../lib/api";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { licenseKind } from "../studio/LibraryPanel";
import type { SoundRef } from "../studio/song";
import { filterCatalog, formatMB } from "./catalogFilter";
import { OnlineSounds } from "./OnlineSounds";
import { visibleItems } from "../studio/libraryTree";

const CATEGORIES = ["all", "keys", "drums", "bass", "strings", "winds", "synth", "vocals", "fx", "other"] as const;
/** Downloads above this get a "pesado" hint next to the size. */
const HEAVY_BYTES = 500e6;

interface Props {
  packs: PackInfo[];
  onPacks: (packs: PackInfo[]) => void;
  onImportFolder: () => void;
  onDelete: (pack: PackInfo) => void;
  onPreview: (sound: SoundRef) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
}

export function LicenseBadge({ license }: { license: string }) {
  const { t } = useTranslation();
  const kind = licenseKind(license);
  return (
    <span className={`lic-badge ${kind}`} title={`${license} — ${t(`packs.license.${kind}Hint`)}`}>
      {t(`packs.license.${kind}`)}
    </span>
  );
}

export function PacksDialog({ packs, onPacks, onImportFolder, onDelete, onPreview, onError, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"catalog" | "sounds" | "mine">("catalog");
  const [list, setList] = useState<CatalogList | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<Record<string, PackProgress | "starting">>({});
  const catalog = list?.entries ?? null;

  const loadCatalog = (refresh = false) => {
    setCatalogError(null);
    setRefreshing(refresh);
    api
      .catalogFetch(refresh)
      .then(setList)
      .catch((e) => setCatalogError(String(e)))
      .finally(() => setRefreshing(false));
  };
  useEffect(() => loadCatalog(), []);

  useEffect(() => {
    const un = listen<PackProgress>("pack-progress", (e) => setProgress((p) => (e.payload.id in p ? { ...p, [e.payload.id]: e.payload } : p)));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  const installed = new Map(packs.map((p) => [p.id, p]));

  const install = async (entry: CatalogEntry) => {
    setProgress((p) => ({ ...p, [entry.id]: "starting" }));
    try {
      onPacks(await api.packInstall(entry.id));
    } catch (e) {
      if (!String(e).includes("cancelada")) onError(e);
    } finally {
      setProgress((p) => {
        const n = { ...p };
        delete n[entry.id];
        return n;
      });
    }
  };

  const shown = filterCatalog(catalog ?? [], category, query, (c) => t(`packs.category.${c}`));
  const usedCategories = new Set((catalog ?? []).map((e) => e.category));

  const progressText = (pr: PackProgress | "starting", entry: CatalogEntry) => {
    if (pr === "starting") return t("packs.connecting");
    if (pr.stage === "download")
      return t(entry.sha256 ? "packs.downloading" : "packs.downloadingApprox", { done: formatMB(pr.received), total: formatMB(entry.sizeBytes) });
    return t(`packs.stage.${pr.stage}`);
  };

  return (
    <Dialog title={t("packs.dialogTitle")} onClose={onClose} closeLabel={t("exportDlg.close")}>
      <div className="packs-dialog">
        <div className="seg packs-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "catalog"} className={`toggle ${tab === "catalog" ? "active" : ""}`} onClick={() => setTab("catalog")}>
            {t("packs.tabCatalog")}
          </button>
          <button role="tab" aria-selected={tab === "sounds"} className={`toggle ${tab === "sounds" ? "active" : ""}`} onClick={() => setTab("sounds")}>
            {t("packs.tabSounds")}
          </button>
          <button role="tab" aria-selected={tab === "mine"} className={`toggle ${tab === "mine" ? "active" : ""}`} onClick={() => setTab("mine")}>
            {t("packs.tabMine", { count: packs.length })}
          </button>
        </div>

        {tab === "catalog" && (
          <>
            <p className="muted small">{t("packs.catalogIntro")}</p>
            {catalogError ? (
              <div className="packs-empty">
                <p>{t("packs.catalogError")}</p>
                <button onClick={() => loadCatalog()}>{t("separation.retry")}</button>
              </div>
            ) : catalog === null ? (
              <p className="muted">{t("status.loading")}</p>
            ) : catalog.length === 0 ? (
              <div className="packs-empty">
                <p>{t("packs.catalogEmpty")}</p>
              </div>
            ) : (
              <>
                {list && !list.onlineOk && <p className="small warn-text">{t("packs.offlineList")}</p>}
                <div className="row packs-find">
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("packs.findPlaceholder")} aria-label={t("packs.findLabel")} />
                  <button onClick={() => loadCatalog(true)} disabled={refreshing}>
                    <Icon name="refresh" size={14} /> {t(refreshing ? "packs.refreshing" : "packs.refresh")}
                  </button>
                </div>
                <div className="chips packs-cats">
                  {CATEGORIES.filter((c) => c === "all" || usedCategories.has(c)).map((c) => (
                    <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>
                      {t(`packs.category.${c}`)}
                    </button>
                  ))}
                </div>
                <p className="muted small">{t("packs.shownCount", { count: shown.length })}</p>
                {shown.length === 0 && <p className="muted">{t("packs.noMatch")}</p>}
                <ul className="pack-cards">
                  {shown.map((e) => {
                    const pr = progress[e.id];
                    const have = installed.get(e.id);
                    return (
                      <li key={e.id} className="pack-card">
                        <div className="pack-card-main">
                          <strong>{e.name}</strong>
                          <span className="muted small">{e.description}</span>
                          <span className="pack-meta small">
                            {t(`packs.category.${e.category}`)} · {e.sha256 ? "" : "≈ "}
                            {formatMB(e.sizeBytes)}
                            {e.sizeBytes > HEAVY_BYTES && ` (${t("packs.heavy")})`} · {e.author || t(`packs.source.${e.source}`)} <LicenseBadge license={e.license} />
                            {e.source === "curated" && <span className="lic-badge">{t("packs.recommended")}</span>}
                          </span>
                          {e.attribution && <span className="muted small">{t("packs.attribution", { text: e.attribution })}</span>}
                        </div>
                        <div className="pack-card-action">
                          {pr ? (
                            <>
                              <span className="small">{progressText(pr, e)}</span>
                              <div className="progress">
                                <span style={{ width: `${pr !== "starting" && pr.stage === "download" ? Math.min(100, (pr.received / e.sizeBytes) * 100) : pr === "starting" ? 2 : 100}%` }} />
                              </div>
                              <button className="link" onClick={() => api.packCancel(e.id).catch(onError)}>
                                {t("items.cancel")}
                              </button>
                            </>
                          ) : have ? (
                            <span className="pack-installed">
                              <Icon name="sparkle" size={14} /> {t("packs.installed")}
                            </span>
                          ) : (
                            <button className="primary" onClick={() => install(e)}>
                              <Icon name="download" size={14} /> {t("packs.download")}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <p className="muted small packs-legal">{t("packs.sourcesNote")}</p>
            <p className="muted small packs-legal">{t("packs.streamingNote")}</p>
          </>
        )}

        {tab === "sounds" && <OnlineSounds packs={packs} onPacks={onPacks} onError={onError} />}

        {tab === "mine" && (
          <>
            {packs.length === 0 && <p className="muted">{t("packs.empty")}</p>}
            <ul className="pack-cards">
              {packs.map((p) => {
                const shown = visibleItems(p.items);
                const first = shown[0];
                return (
                  <li key={p.id} className="pack-card">
                    <div className="pack-card-main">
                      <strong>{p.name}</strong>
                      <span className="pack-meta small">
                        {t("packs.itemCount", { count: shown.length })}
                        {p.author && ` · ${p.author}`} {p.license !== "own" && <LicenseBadge license={p.license} />}
                        {p.origin === "online" && ` · ${t("packs.fromInternet")}`}
                        {p.origin === "folder" && ` · ${t("packs.fromFolder")}`}
                      </span>
                    </div>
                    <div className="pack-card-action row">
                      {first && (
                        <button
                          onClick={() =>
                            onPreview(first.kind === "instrument" ? { kind: "instrument", packId: p.id, itemId: first.id } : { kind: "pack", packId: p.id, itemId: first.id })
                          }
                        >
                          <Icon name="play" size={14} /> {t("insp.listen")}
                        </button>
                      )}
                      <button className="danger" onClick={() => onDelete(p)}>
                        <Icon name="trash" size={14} /> {t("items.delete")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button onClick={onImportFolder}>
              <Icon name="folder" size={14} /> {t("packs.importFolder")}
            </button>
            <p className="muted small">{t("packs.importHint")}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
