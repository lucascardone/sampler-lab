// Output format for exports: WAV bit depth + stereo/mono. Remembered between sessions.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChannelMode, WavFormat } from "../../lib/api";
import { Picker } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";

export interface ExportSettings {
  format: WavFormat;
  channels: ChannelMode;
}

const KEY = "sampler-lab.export";
const DEFAULTS: ExportSettings = { format: "pcm24", channels: "stereo" };

/** Export settings persisted in localStorage (a per-machine convenience). */
export function useExportSettings(): [ExportSettings, (s: ExportSettings) => void] {
  const [settings, setSettings] = useState<ExportSettings>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return DEFAULTS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable: settings just won't be remembered */
    }
  }, [settings]);
  return [settings, setSettings];
}

/** "WAV PCM 24 bit · Estéreo" */
export function useExportLabel(s: ExportSettings): string {
  const { t } = useTranslation();
  return `${t(`export.short.${s.format}`)} · ${t(`export.${s.channels}`)}`;
}

interface Props {
  value: ExportSettings;
  onChange: (s: ExportSettings) => void;
}

export function ExportOptions({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <span className="export-options">
      <span className="tb-field" title={t("export.formatHint")}>
        {t("export.format")}
        <Picker
          label={t("export.formatHint")}
          title={t("export.format")}
          value={value.format}
          columns={1}
          groups={[
            {
              options: (["pcm24", "pcm16", "float32"] as WavFormat[]).map((f) => ({ value: f, label: t(`export.${f}`), desc: t(`export.formatDesc.${f}`) })),
            },
          ]}
          onPick={(f) => onChange({ ...value, format: f })}
        />
      </span>
      <span className="tb-field" title={t("export.channelsHint")}>
        {t("export.channels")}
        <Segmented
          label={t("export.channels")}
          value={value.channels}
          options={[
            { value: "stereo" as ChannelMode, label: t("export.stereo") },
            { value: "mono" as ChannelMode, label: t("export.mono") },
          ]}
          onChange={(c) => onChange({ ...value, channels: c })}
        />
      </span>
    </span>
  );
}
