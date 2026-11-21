// Visual pickers for notes: the song's key + scale ("Tonalidad") and a sample's root note
// ("Nota del sample"). Both show a small two-row piano keyboard instead of a long list, so
// you pick a note the way it looks on a piano.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { LATIN_NAMES, NOTE_NAMES, SCALE_IDS, isBlackKey, noteName, type ScaleId } from "./theory";

/** Grid column (1-based, in half-keys) of each pitch class on a 7-white-key keyboard. */
const COLUMN = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13];

function Keyboard({ isOn, onPick, label }: { isOn: (pc: number) => boolean; onPick: (pc: number) => void; label: (pc: number) => string }) {
  return (
    <div className="kb-pick" role="group">
      {NOTE_NAMES.map((_, pc) => (
        <button
          key={pc}
          type="button"
          className={`kb-key ${isBlackKey(pc) ? "black" : "white"} ${isOn(pc) ? "active" : ""}`}
          style={{ gridColumn: `${COLUMN[pc]} / span 2` }}
          aria-pressed={isOn(pc)}
          onClick={() => onPick(pc)}
        >
          <strong>{LATIN_NAMES[pc]}</strong>
          <span>{label(pc)}</span>
        </button>
      ))}
    </div>
  );
}

/** "La menor": key on a keyboard + the scale as described choices. */
export function KeyPicker({ keyPc, scale, onChange }: { keyPc: number; scale: ScaleId; onChange: (key: number, scale: ScaleId) => void }) {
  const { t } = useTranslation();
  return (
    <Dropdown
      prefix={t("roll.key")}
      display={`${LATIN_NAMES[keyPc]} ${t(`roll.scales.${scale}`).toLowerCase()}`}
      label={t("roll.keyHint")}
      title={t("roll.keyTitle")}
      panelClass="key-panel"
    >
      {() => (
        <>
          <p className="muted small picker-note">{t("roll.keyHint")}</p>
          <Keyboard isOn={(pc) => pc === keyPc} onPick={(pc) => onChange(pc, scale)} label={(pc) => NOTE_NAMES[pc]} />
          <span className="picker-group-title">{t("roll.scale")}</span>
          <div className="picker-grid scale-grid">
            {SCALE_IDS.map((id) => (
              <button key={id} type="button" className={`picker-opt ${id === scale ? "active" : ""}`} aria-pressed={id === scale} onClick={() => onChange(keyPc, id)}>
                <strong>{t(`roll.scales.${id}`)}</strong>
                <span className="picker-desc">{t(`roll.scaleDesc.${id}`)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Dropdown>
  );
}

const OCTAVES = [1, 2, 3, 4, 5, 6, 7];

/** A sample's root note (C1–C7): octave buttons + keyboard. */
export function RootNotePicker({ value, onChange }: { value: number; onChange: (midi: number) => void }) {
  const { t } = useTranslation();
  const [octave, setOctave] = useState(Math.floor(value / 12) - 1);
  return (
    <Dropdown display={`${noteName(value)} (${LATIN_NAMES[value % 12]})`} label={t("roll.rootHint")} title={t("roll.root")} panelClass="key-panel" className="block">
      {(close) => (
        <>
          <p className="muted small picker-note">{t("roll.rootHint")}</p>
          <Segmented
            label={t("roll.octave")}
            block
            value={octave}
            options={OCTAVES.map((o) => ({ value: o, label: String(o) }))}
            onChange={setOctave}
          />
          <Keyboard
            isOn={(pc) => (octave + 1) * 12 + pc === value}
            label={(pc) => `${NOTE_NAMES[pc]}${octave}`}
            onPick={(pc) => {
              onChange(Math.min(96, (octave + 1) * 12 + pc));
              close();
            }}
          />
        </>
      )}
    </Dropdown>
  );
}
