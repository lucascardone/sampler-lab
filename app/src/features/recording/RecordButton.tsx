import { useTranslation } from "react-i18next";
import { formatShort } from "../../lib/format";

interface Props {
  recording: boolean;
  seconds: number;
  level: number;
  onToggle: () => void;
}

/** Record / stop, with elapsed time and a live input level (so you can see sound is
 *  actually coming in — e.g. protected video records as silence). */
export function RecordButton({ recording, seconds, level, onToggle }: Props) {
  const { t } = useTranslation();
  return (
    <button className={`record ${recording ? "on" : ""}`} onClick={onToggle} title={t("recording.hint")}>
      <span className="rec-dot" />
      {recording ? (
        <>
          {t("recording.stop")} · <span className="rec-time">{formatClock(seconds)}</span>
          <span className="rec-level" title={t("recording.levelHint")}>
            <span style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
          </span>
        </>
      ) : (
        t("recording.startAudio")
      )}
    </button>
  );
}

function formatClock(s: number) {
  return s < 60 ? `0:${Math.floor(s).toString().padStart(2, "0")}` : formatShort(s);
}
