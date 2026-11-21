// "Teclado y controles MIDI": which devices are used, which knob does what, and how the
// keyboard plays. Opened from the MIDI button in the transport bar (and the master's
// inspector). Devices connect on their own; this is for switching one off, assigning
// knobs, and reading how it works.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Dialog } from "../../ui/Dialog";
import { Icon, IconButton } from "../../ui/Icon";
import { Picker } from "../../ui/Picker";
import { parseTargetKey, sameTarget, targetExists, targetKey, type MidiTarget } from "./midiMap";
import type { Song } from "./song";
import type { MidiStore } from "./useMidi";

/** Spanish name of a target, e.g. "Delay de Bombo". */
export function targetLabel(t: TFunction, song: Song, target: MidiTarget): string {
  if (!("channelId" in target)) return t(`midi.targets.${target.kind}`);
  const ch = song.channels.find((c) => c.id === target.channelId);
  return t(`midi.targets.${target.kind}`, { name: ch?.name ?? t("midi.deletedSound") });
}

export function MidiDialog({ song, midi, onClose }: { song: Song; midi: MidiStore; onClose: () => void }) {
  const { t } = useTranslation();
  const label = (target: MidiTarget) => targetLabel(t, song, target);
  const [pick, setPick] = useState("bpm");

  const general: MidiTarget[] = [{ kind: "bpm" }, { kind: "swing" }, { kind: "master" }, { kind: "play" }, { kind: "record" }];
  const perChannel = song.channels.flatMap((c) =>
    (["volume", "reverb", "delay"] as const).map((kind) => ({ kind, channelId: c.id }) as MidiTarget),
  );
  const close = () => {
    midi.setLearning(null);
    onClose();
  };
  const learnTarget = parseTargetKey(pick);

  return (
    <Dialog title={t("midi.title")} onClose={close} closeLabel={t("midi.close")}>
      <p className="dialog-lead">{t("midi.lead")}</p>

      <h3 className="midi-h">{t("midi.devices")}</h3>
      {midi.devices.length === 0 ? (
        <p className="muted">{t("midi.noDevices")}</p>
      ) : (
        <ul className="midi-devices">
          {midi.devices.map((d) => {
            const used = !midi.off.includes(d.name);
            return (
              <li key={d.name}>
                <label className="check">
                  <input type="checkbox" checked={used} onChange={(e) => midi.setUsed(d.name, e.target.checked)} />
                  <span className="midi-name">{d.name}</span>
                </label>
                <span className={`midi-state ${d.connected ? "on" : ""}`}>
                  {d.connected ? t("midi.connected") : !used ? t("midi.switchedOff") : d.error ? t("midi.failed") : t("midi.connecting")}
                </span>
                {used && d.error && <p className="midi-error">{d.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <button onClick={midi.retry}>
        <Icon name="refresh" /> {t("midi.retry")}
      </button>

      <h3 className="midi-h">{t("midi.knobs")}</h3>
      <p className="muted small">{t("midi.knobsLead")}</p>
      {midi.bindings.length > 0 && (
        <ul className="midi-bindings">
          {midi.bindings.map((b) => (
            <li key={targetKey(b.target)} className={targetExists(song, b.target) ? "" : "muted"}>
              <span className="midi-name">{label(b.target)}</span>
              <span className="muted small">{t("midi.control", { cc: b.cc, device: b.device })}</span>
              <IconButton icon="trash" tone="ghost" label={t("midi.forget", { name: label(b.target) })} onClick={() => midi.forget(b.target)} />
            </li>
          ))}
        </ul>
      )}
      {midi.learning ? (
        <div className="midi-learn waiting" role="status">
          <span>{t("midi.waiting", { name: label(midi.learning) })}</span>
          <button onClick={() => midi.setLearning(null)}>{t("midi.cancel")}</button>
        </div>
      ) : (
        <div className="midi-learn">
          <div className="field-stack midi-target">
            <span className="field-label">{t("midi.assignWhat")}</span>
            <Picker
              className="block"
              label={t("midi.assignWhat")}
              title={t("midi.assignWhat")}
              value={pick}
              columns={2}
              groups={[
                { title: t("midi.general"), options: general.map((g) => ({ value: targetKey(g), label: label(g) })) },
                ...(perChannel.length ? [{ title: t("midi.sounds"), options: perChannel.map((g) => ({ value: targetKey(g), label: label(g) })) }] : []),
              ]}
              onPick={setPick}
            />
          </div>
          <button
            className="primary"
            disabled={!learnTarget || midi.devices.every((d) => !d.connected)}
            onClick={() => learnTarget && midi.setLearning(learnTarget)}
          >
            {midi.bindings.some((b) => learnTarget && sameTarget(b.target, learnTarget)) ? t("midi.reassign") : t("midi.assign")}
          </button>
        </div>
      )}
      <p className="muted small">{t("midi.channelNote")}</p>

      <h3 className="midi-h">{t("midi.howTitle")}</h3>
      <ul className="midi-how">
        <li>{t("midi.howRoll")}</li>
        <li>{t("midi.howPads")}</li>
        <li>{t("midi.howWheels")}</li>
        <li>{t("midi.howTransport")}</li>
      </ul>
    </Dialog>
  );
}

/** The transport-bar button: always visible, says how many devices are listening. */
export function MidiButton({ midi, onClick }: { midi: MidiStore; onClick: () => void }) {
  const { t } = useTranslation();
  const n = midi.devices.filter((d) => d.connected).length;
  return (
    <button className={`midi-btn ${n ? "on" : ""}`} onClick={onClick} title={t("midi.buttonHint")}>
      <Icon name="midi" /> {n ? t("midi.buttonOn", { count: n }) : t("midi.button")}
      {midi.learning && <i className="midi-dot" aria-hidden />}
    </button>
  );
}
