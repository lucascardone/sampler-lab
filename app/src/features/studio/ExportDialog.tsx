// Export dialog: what to export (song or current pattern), the file options, and the
// three kinds of output (mix WAV, stems, MIDI). Lives in a dialog so the studio isn't
// permanently crowded by a bar you only use at the end.
import { useTranslation } from "react-i18next";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { ExportOptions, type ExportSettings } from "../export/ExportOptions";
import type { Credit } from "../packs/credits";

interface Props {
  songMode: boolean;
  settings: ExportSettings;
  setSettings: (s: ExportSettings) => void;
  tail: boolean;
  setTail: (v: boolean) => void;
  busy: string | null;
  onWav: () => void;
  onStems: () => void;
  onMidi: () => void;
  /** Sounds from packs used by the song (empty = no credits option). */
  credits: Credit[];
  onCredits: () => void;
  onClose: () => void;
}

export function ExportDialog({ songMode, settings, setSettings, tail, setTail, busy, onWav, onStems, onMidi, credits, onCredits, onClose }: Props) {
  const required = credits.filter((c) => c.required).length;
  const { t } = useTranslation();
  return (
    <Dialog title={t("exportDlg.title")} onClose={onClose} closeLabel={t("exportDlg.close")}>
      <p className="dialog-lead">{songMode ? t("exportDlg.whatSong") : t("exportDlg.whatPattern")}</p>
      <div className="dialog-fields">
        <ExportOptions value={settings} onChange={setSettings} />
        <span className="tb-field" title={t("studio.exportLengthHint")}>
          {t("exportDlg.length")}
          <Segmented
            label={t("exportDlg.length")}
            value={tail}
            options={[
              { value: true, label: t("studio.exportTail"), hint: t("studio.exportLengthHint") },
              { value: false, label: t("studio.exportExact"), hint: t("studio.exportLengthHint") },
            ]}
            onChange={setTail}
          />
        </span>
      </div>
      <div className="export-choices">
        <button className="choice primary-choice" data-autofocus onClick={onWav} disabled={!!busy}>
          <Icon name="download" size={20} />
          <strong>{t("exportDlg.wav")}</strong>
          <span>{t("exportDlg.wavHint")}</span>
        </button>
        <button className="choice" onClick={onStems} disabled={!!busy}>
          <Icon name="layers" size={20} />
          <strong>{t("exportDlg.stems")}</strong>
          <span>{t("stems2.hint")}</span>
        </button>
        <button className="choice" onClick={onMidi} disabled={!!busy}>
          <Icon name="piano" size={20} />
          <strong>{t("exportDlg.midi")}</strong>
          <span>{t("studio.exportMidiHint")}</span>
        </button>
        {credits.length > 0 && (
          <button className="choice" onClick={onCredits} disabled={!!busy}>
            <Icon name="note" size={20} />
            <strong>{t("credits.button")}</strong>
            <span>{required ? t("credits.requiredHint", { count: required }) : t("credits.hint", { count: credits.length })}</span>
          </button>
        )}
      </div>
      <p className="dialog-status" role="status" aria-live="polite">
        {busy ?? ""}
      </p>
    </Dialog>
  );
}
