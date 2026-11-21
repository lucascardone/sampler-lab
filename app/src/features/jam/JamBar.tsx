// "Tocar juntos": the thin bar on top of the studio while in a room — whose room, who
// is in (with their colors), whose part you hear on this PC, bring a sound (guests),
// speaker delay (under "Más"), leave.
// Also the notice after losing the connection, with "Reconectar".
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AUDIO_EXTENSIONS } from "../../lib/api";
import { Icon } from "../../ui/Icon";
import { jamRoom } from "./room";
import { useJam } from "./useJam";

interface Props {
  onOpenDialog: () => void;
  onError: (e: unknown) => void;
  onInfo: (msg: string) => void;
  /** A sound the guest brought is in the room pack: add it as a channel. */
  onBrought: (packId: string, itemId: string, name: string) => void;
}

export function JamBar({ onOpenDialog, onError, onInfo, onBrought }: Props) {
  const { t } = useTranslation();
  const jam = useJam();
  const room = jamRoom();
  const [more, setMore] = useState(false);
  const [sending, setSending] = useState(false);

  if (jam.role === "off") {
    if (!jam.lost) return null;
    return (
      <div className="jam-bar lost" role="status">
        <Icon name="warning" size={16} />
        <span className="jam-bar-title">{t("jam.lost", { name: jam.lost })}</span>
        <div className="spacer" />
        <button className="primary" onClick={() => room.reconnect().catch(onError)}>
          <Icon name="refresh" size={14} /> {t("jam.reconnect")}
        </button>
        <button onClick={() => room.dismissLost()}>{t("jam.dismiss")}</button>
      </div>
    );
  }

  const bring = async () => {
    const path = await open({ multiple: false, title: t("jam.bringTitle"), filters: [{ name: t("jam.soundFiles"), extensions: AUDIO_EXTENSIONS }] });
    if (typeof path !== "string") return;
    setSending(true);
    onInfo(t("jam.bringing"));
    try {
      const { packId, itemId } = await room.upload(path);
      const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
      onBrought(packId, itemId, name);
      onInfo(t("jam.brought", { name }));
    } catch (e) {
      onError(e);
    } finally {
      setSending(false);
    }
  };

  const leave = async () => {
    if (jam.role === "host" && jam.peers.length > 1) {
      const ok = await ask(t("jam.closeConfirm"), { kind: "warning", title: t("jam.title"), okLabel: t("jam.close"), cancelLabel: t("items.cancel") });
      if (!ok) return;
    }
    await room.leave();
  };

  return (
    <div className="jam-bar" role="region" aria-label={t("jam.title")}>
      <Icon name="people" size={16} />
      <button className="jam-bar-title link-btn" onClick={onOpenDialog} title={t("jam.barHint")}>
        {jam.joining ? t("jam.receiving") : t("jam.roomOf", { name: jam.roomName })}
        {jam.role === "host" && <span className="jam-bar-code"> · {t("jam.barCode", { code: jam.code })}</span>}
      </button>
      <ul className="jam-bar-people" aria-label={t("jam.people")}>
        {jam.peers.map((p) => {
          if (p.id === jam.me)
            return (
              <li key={p.id}>
                <span className="jam-dot" style={{ background: p.color }} aria-hidden />
                {t("jam.you")}
              </li>
            );
          // Tap a friend to stop hearing their part on this PC (they keep hearing everything).
          const quiet = jam.hush.onlyMine || jam.hush.people.includes(p.suffix);
          return (
            <li key={p.id}>
              <button
                className={`jam-person ${quiet ? "quiet" : ""}`}
                aria-pressed={quiet}
                title={t(quiet ? "jam.hearHint" : "jam.hushHint", { name: p.name })}
                onClick={() => room.hushPerson(p.suffix, !quiet)}
              >
                <span className="jam-dot" style={{ background: p.color }} aria-hidden />
                {p.name}
                <Icon name="volume" size={13} />
                {quiet && <span className="small">{t("jam.hushed")}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {jam.peers.length > 1 && (
        <button
          className={`toggle ${jam.hush.onlyMine ? "active" : ""}`}
          aria-pressed={jam.hush.onlyMine}
          title={t("jam.onlyMineHint")}
          onClick={() => room.setOnlyMine(!jam.hush.onlyMine)}
        >
          {t("jam.onlyMine")}
        </button>
      )}
      <div className="spacer" />
      {jam.role === "guest" && !jam.joining && (
        <button onClick={bring} disabled={sending}>
          <Icon name="plus" size={14} /> {t("jam.bring")}
        </button>
      )}
      <button className={`toggle ${more ? "active" : ""}`} aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {t("jam.more")}
      </button>
      {more && (
        <label className="tb-field jam-delay" title={t("jam.delayHint")}>
          {t("jam.delay")}
          <input
            type="range"
            min={0}
            max={400}
            step={5}
            value={jam.delayMs}
            aria-valuetext={t("jam.ms", { n: jam.delayMs })}
            onChange={(e) => room.setDelay(Number(e.target.value))}
          />
          <output className="num">{t("jam.ms", { n: jam.delayMs })}</output>
        </label>
      )}
      <button className="danger" onClick={leave}>
        {jam.role === "host" ? t("jam.close") : t("jam.leave")}
      </button>
      {more && <p className="jam-delay-hint muted small">{t("jam.delayHint")}</p>}
    </div>
  );
}
