// "Separar": choose stems + quality, run the engine with progress/cancel, audition the
// results and keep the ones you want as new samples.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/Icon";
import { listen } from "@tauri-apps/api/event";
import { api, type EngineHardware, type EngineVariant, type SampleInfo, type Session, type StemFile } from "../../lib/api";
import { engineClient, type EngineClient, type Health, type Job, type Quality, type Stem } from "../../lib/engine";
import { formatEta } from "../../lib/format";
import { StemMixer } from "./StemMixer";
import { setupStage, type Stage } from "./setupStage";

const STEMS: Stem[] = ["vocals", "drums", "bass", "guitar", "piano", "other"];


type Phase =
  | { kind: "checking" }
  | { kind: "missingUv" }
  /** Not installed (or changing build): show the options for this PC. */
  | { kind: "choose" }
  | { kind: "installing"; variant: EngineVariant; stage: Stage; line: string }
  /** Something failed: say what, and offer to retry (not a blind reinstall). */
  | { kind: "error"; message: string; retry: () => void }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "running"; job: Job }
  | { kind: "results"; stems: StemFile[]; model: string };

interface Props {
  sample: SampleInfo;
  onSession: (s: Session, openSampleId?: string) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
}

export function SeparatePanel({ sample, onSession, onError, onClose }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [stems, setStems] = useState<Set<Stem>>(new Set(["vocals"]));
  const [quality, setQuality] = useState<Quality>("fast");
  const [health, setHealth] = useState<Health | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<EngineClient | null>(null);
  const [hw, setHw] = useState<EngineHardware | null>(null);
  const [showLog, setShowLog] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const stemName = (s: string) => t(`stems.${s}`);

  // Keep the panel visible: it opens below the editor and grows with results.
  useEffect(() => {
    // Results are tall: align the panel's bottom so the stem list is what you see.
    const block = phase.kind === "results" ? "end" : "nearest";
    // Wait a frame so the mixer has rendered its rows before measuring.
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block }));
  }, [phase.kind]);
  const sixStem = stems.has("guitar") || stems.has("piano");

  const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);

  // Find out whether the engine is installed/running, and start it if needed.
  const connect = async () => {
    try {
      setPhase({ kind: "checking" });
      const st = await api.engineStatus();
      if (st.state === "missingUv") return setPhase({ kind: "missingUv" });
      if (st.state === "notInstalled") return choose();
      setPhase({ kind: "starting" });
      const info = st.info ?? (await api.engineStart());
      const c = engineClient(info);
      setHealth(await c.health());
      setClient(c);
      setPhase({ kind: "ready" });
    } catch (e) {
      // Installed but didn't start or answer: retrying is the fix, not a 3 GB reinstall.
      setPhase({ kind: "error", message: errorText(e), retry: connect });
    }
  };

  /** Show the install options, knowing what this PC has. */
  const choose = async () => {
    setPhase({ kind: "choose" });
    if (!hw) setHw(await api.engineHardware().catch(() => ({ gpu: null, driver: null, recommended: "cpu" as const })));
  };

  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Job progress via WebSocket.
  useEffect(() => {
    if (!client) return;
    return client.onJob(async (job) => {
      if (job.id !== jobIdRef.current) return;
      if (job.status === "queued" || job.status === "running") return setPhase({ kind: "running", job });
      jobIdRef.current = null;
      if (job.status === "cancelled") return setPhase({ kind: "ready" });
      if (job.status === "error") {
        onError(job.error);
        return setPhase({ kind: "ready" });
      }
      // Done: cut the padded results back to the sample length.
      try {
        const files = Object.entries(job.result!.stems).map(([stem, path]) => ({ stem, path }));
        const trimmed = await api.importStems(sample.id, files);
        setKept(new Set());
        setPhase({ kind: "results", stems: trimmed, model: job.result!.model });
      } catch (e) {
        onError(e);
        setPhase({ kind: "ready" });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sample.id]);

  const install = async (variant: EngineVariant) => {
    setClient(null);
    setHealth(null);
    setPhase({ kind: "installing", variant, stage: "resolve", line: "" });
    const unlisten = await listen<string>("engine-setup-log", (e) =>
      setPhase((p) => (p.kind === "installing" ? { ...p, stage: setupStage(e.payload, p.stage), line: e.payload } : p)),
    );
    try {
      await api.engineSetup(variant);
      unlisten();
      await connect();
    } catch (e) {
      unlisten();
      setPhase({ kind: "error", message: errorText(e), retry: () => install(variant) });
    }
  };

  const start = async () => {
    if (!client || stems.size === 0) return;
    try {
      const input = await api.prepareSeparation(sample.id);
      const job = await client.separate({ ...input, stems: [...stems], quality });
      jobIdRef.current = job.id;
      setPhase({ kind: "running", job });
    } catch (e) {
      onError(e);
    }
  };

  const cancel = async () => {
    if (jobIdRef.current) await client?.cancel(jobIdRef.current).catch(onError);
  };

  const keep = async (stem: StemFile) => {
    setBusy(true);
    try {
      const r = await api.keepStem(sample.id, stem, `${sample.name} · ${stemName(stem.stem)}`);
      setKept((k) => new Set(k).add(stem.stem));
      onSession(r.session);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleStem = (s: Stem) =>
    setStems((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  return (
    <section className="separate" ref={rootRef}>
      <header>
        <h3>{t("separation.title")}</h3>
        {health && (
          <span className="muted small">
            {t(`separation.device.${health.device.type}`, { name: health.device.name })}
          </span>
        )}
        <div className="spacer" />
        {phase.kind === "ready" && (
          <button className="link small" onClick={choose} title={t("separation.changeVersionHint")}>
            {t("separation.changeVersion")}
          </button>
        )}
        <button className="link" onClick={onClose} disabled={phase.kind === "running" || phase.kind === "installing"}>
          {t("separation.close")}
        </button>
      </header>

      {phase.kind === "checking" && <p className="muted">{t("separation.checking")}</p>}
      {phase.kind === "starting" && <p className="muted">{t("separation.starting")}</p>}

      {phase.kind === "missingUv" && <p>{t("separation.missingUv")}</p>}

      {phase.kind === "choose" && (
        <div className="setup">
          {!hw ? (
            <p className="muted">{t("separation.checkingPc")}</p>
          ) : hw.gpu ? (
            <>
              <p>{t("separation.gpuIntro", { gpu: hw.gpu })}</p>
              <div className="setup-actions">
                <button className="primary" onClick={() => install(hw.recommended)}>
                  {t("separation.setupGpu")}
                </button>
                <button onClick={() => install("cpu")}>{t("separation.setupCpuInstead")}</button>
              </div>
              <p className="muted small">{t("separation.cpuInsteadHint")}</p>
            </>
          ) : (
            <>
              <p>{t("separation.noGpuIntro")}</p>
              <div className="setup-actions">
                <button className="primary" onClick={() => install("cpu")}>
                  {t("separation.setupCpu")}
                </button>
                <button onClick={onClose}>{t("separation.notNow")}</button>
              </div>
            </>
          )}
          {hw && <p className="muted small">{t("separation.setupNote")}</p>}
        </div>
      )}

      {phase.kind === "installing" && (
        <div className="setup">
          <p>
            <strong>{t(`separation.setupStage.${phase.stage}`)}</strong>{" "}
            <span className="muted">{t(phase.variant === "cpu" ? "separation.installingCpu" : "separation.installingGpu")}</span>
          </p>
          <div className="progress indeterminate">
            <span />
          </div>
          <button className="link small" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
            {showLog ? t("separation.hideDetail") : t("separation.showDetail")}
          </button>
          {showLog && <code className="log">{phase.line}</code>}
        </div>
      )}

      {phase.kind === "error" && (
        <div className="setup">
          <p role="alert">
            <Icon name="warning" /> {phase.message}
          </p>
          <div className="setup-actions">
            <button className="primary" onClick={phase.retry}>
              {t("separation.retry")}
            </button>
            <button onClick={choose}>{t("separation.reinstall")}</button>
          </div>
        </div>
      )}

      {(phase.kind === "ready" || phase.kind === "results") && (
        <div className="sep-options">
          <div className="stem-choices">
            <span className="label">{t("separation.what")}</span>
            {STEMS.map((s) => (
              <label key={s} className={`chip ${stems.has(s) ? "on" : ""}`}>
                <input type="checkbox" checked={stems.has(s)} onChange={() => toggleStem(s)} />
                {stemName(s)}
              </label>
            ))}
          </div>
          <div className="quality">
            <span className="label">{t("separation.quality")}</span>
            <label className="check" title={t("separation.fastHint")}>
              <input type="radio" checked={quality === "fast"} onChange={() => setQuality("fast")} />
              {t("separation.fast")}
            </label>
            <label className="check" title={t("separation.bestHint")}>
              <input type="radio" checked={quality === "best"} onChange={() => setQuality("best")} disabled={sixStem} />
              {t("separation.best")}
            </label>
            <button className="primary" disabled={stems.size === 0} onClick={start}>
              <Icon name="split" /> {t("separation.start")}
            </button>
          </div>
          <p className="muted small">
            {sixStem ? t("separation.sixStemNote") : quality === "fast" ? t("separation.fastHint") : t("separation.bestHint")}{" "}
            {t("separation.restNote")}
          </p>
        </div>
      )}

      {phase.kind === "running" && (
        <div className="running">
          <div className="progress">
            <span style={{ width: `${Math.round(phase.job.progress * 100)}%` }} />
          </div>
          <div className="running-info">
            <span>
              {t(`separation.stage.${phase.job.stage || "queued"}`)} · {Math.round(phase.job.progress * 100)}%
              {phase.job.etaSeconds != null && ` · ${t("separation.eta", { eta: formatEta(phase.job.etaSeconds) })}`}
            </span>
            <button onClick={cancel}>{t("separation.cancel")}</button>
          </div>
          {phase.job.stage === "loading" && <p className="muted small">{t("separation.firstTimeNote")}</p>}
        </div>
      )}

      {phase.kind === "results" && (
        <>
          <h4>{t("separation.results")}</h4>
          <StemMixer stems={phase.stems} stemName={stemName} kept={kept} busy={busy} onKeep={keep} />
        </>
      )}
    </section>
  );
}
