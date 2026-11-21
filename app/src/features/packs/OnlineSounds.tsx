// "Sonidos sueltos": search free single sounds online (Openverse, which indexes Freesound,
// Wikimedia and more), listen without downloading, and add the ones you like to the
// "Sonidos de internet" pack. Each added sound keeps its author, license and page.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type OnlineSound, type PackInfo } from "../../lib/api";
import { Icon } from "../../ui/Icon";
import { LicenseBadge } from "./PacksDialog";
import { formatDuration } from "./catalogFilter";

/** One-click searches for people who don't know what to type (Openverse tags are English). */
const QUICK: { key: string; query: string }[] = [
  { key: "kick", query: "kick drum" },
  { key: "snare", query: "snare" },
  { key: "hihat", query: "hihat" },
  { key: "clap", query: "clap" },
  { key: "cymbal", query: "cymbal" },
  { key: "bass", query: "808 bass" },
  { key: "vocal", query: "vocal" },
  { key: "fx", query: "whoosh" },
];

interface Props {
  packs: PackInfo[];
  onPacks: (packs: PackInfo[]) => void;
  onError: (e: unknown) => void;
}

export function OnlineSounds({ packs, onPacks, onError }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [long, setLong] = useState(false);
  const [results, setResults] = useState<OnlineSound[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const lastSearch = useRef({ query: "", long: false });

  // Stop the preview when the dialog closes.
  useEffect(() => () => audio.current?.pause(), []);

  // What's already in "Sonidos de internet", by the sound's page (its credit link).
  const added = new Set(packs.filter((p) => p.origin === "online").flatMap((p) => p.items.map((i) => i.credit?.url ?? "")));

  const search = async (q: string, isLong: boolean, nextPage = 1) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.soundSearch(q, isLong, nextPage);
      lastSearch.current = { query: q, long: isLong };
      setResults((prev) => (nextPage === 1 ? res.results : [...(prev ?? []), ...res.results]));
      setPage(nextPage);
      setHasMore(res.hasMore);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const quick = (q: string) => {
    setQuery(q);
    search(q, long);
  };

  const togglePreview = (s: OnlineSound) => {
    audio.current?.pause();
    if (playing === s.id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(s.url);
    audio.current = a;
    a.onended = () => setPlaying((p) => (p === s.id ? null : p));
    a.onerror = () => {
      setPlaying(null);
      onError(t("online.previewError"));
    };
    setPlaying(s.id);
    a.play().catch(() => setPlaying(null));
  };

  const add = async (s: OnlineSound) => {
    setAdding((a) => new Set(a).add(s.id));
    try {
      onPacks(await api.soundAdd(s.id));
    } catch (e) {
      onError(e);
    } finally {
      setAdding((a) => {
        const n = new Set(a);
        n.delete(s.id);
        return n;
      });
    }
  };

  return (
    <>
      <p className="muted small">{t("online.intro")}</p>
      <form
        className="online-search row"
        onSubmit={(e) => {
          e.preventDefault();
          search(query, long);
        }}
      >
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("online.placeholder")} aria-label={t("online.searchLabel")} />
        <button type="submit" className="primary" disabled={busy || !query.trim()}>
          <Icon name="search" size={14} /> {t("online.search")}
        </button>
      </form>
      <div className="seg" role="group" aria-label={t("online.lengthLabel")}>
        {[false, true].map((v) => (
          <button
            key={String(v)}
            className={`toggle ${long === v ? "active" : ""}`}
            aria-pressed={long === v}
            onClick={() => {
              setLong(v);
              if (lastSearch.current.query) search(lastSearch.current.query, v);
            }}
          >
            {t(v ? "online.long" : "online.short")}
          </button>
        ))}
      </div>
      <div className="chips packs-cats">
        <span className="muted small">{t("online.quick")}</span>
        {QUICK.map((q) => (
          <button key={q.key} className="chip" onClick={() => quick(q.query)}>
            {t(`online.quickItem.${q.key}`)}
          </button>
        ))}
      </div>

      {error && (
        <div className="packs-empty">
          <p>{error}</p>
        </div>
      )}
      {busy && results === null && <p className="muted">{t("online.searching")}</p>}
      {results !== null && results.length === 0 && !busy && <p className="muted">{t("online.noResults")}</p>}
      {results && results.length > 0 && (
        <ul className="pack-cards">
          {results.map((s) => {
            const have = added.has(s.pageUrl);
            return (
              <li key={s.id} className="pack-card">
                <div className="pack-card-main">
                  <strong className="online-title">{s.title}</strong>
                  <span className="pack-meta small">
                    {[formatDuration(s.durationMs), s.author, s.source === "freesound" ? "Freesound" : s.source === "wikimedia_audio" ? "Wikimedia" : s.source].filter(Boolean).join(" · ")}{" "}
                    <LicenseBadge license={s.license} />
                  </span>
                </div>
                <div className="pack-card-action row">
                  <button onClick={() => togglePreview(s)} aria-pressed={playing === s.id}>
                    <Icon name={playing === s.id ? "stop" : "play"} size={14} /> {t(playing === s.id ? "online.stop" : "insp.listen")}
                  </button>
                  {have ? (
                    <span className="pack-installed">
                      <Icon name="sparkle" size={14} /> {t("online.added")}
                    </span>
                  ) : (
                    <button className="primary" onClick={() => add(s)} disabled={adding.has(s.id)}>
                      <Icon name="download" size={14} /> {t(adding.has(s.id) ? "online.adding" : "online.add")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button onClick={() => search(lastSearch.current.query, lastSearch.current.long, page + 1)} disabled={busy}>
          {t(busy ? "online.searching" : "online.more")}
        </button>
      )}
      <p className="muted small packs-legal">{t("online.footer")}</p>
    </>
  );
}
