// "Tocar juntos": open a room on this PC, or join a friend's (same Wi-Fi, or another home
// with an invite). Inside a room it shows the code and the invite (host), who is in, and
// the way out.
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type JamRoomFound } from "../../lib/api";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { jamRoom, savedName } from "./room";
import { useJam } from "./useJam";

interface Props {
  onClose: () => void;
  onError: (e: unknown) => void;
}

export function JamDialog({ onClose, onError }: Props) {
  const { t } = useTranslation();
  const jam = useJam();
  const room = jamRoom();
  const patternName = (id: string) => room.patternName(id);
  const [name, setName] = useState(savedName());
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [rooms, setRooms] = useState<JamRoomFound[] | null>(null);
  const [target, setTarget] = useState<JamRoomFound | null>(null);
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [fromHome, setFromHome] = useState(false);
  const [invite, setInvite] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!name) api.jamDefaultName().then((n) => setName((cur) => cur || n)).catch(() => {});
    // Only to suggest a name the first time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While choosing a room: listen for the rooms on the Wi-Fi, again and again.
  useEffect(() => {
    if (!joining || jam.role !== "off") return;
    let stop = false;
    const loop = async () => {
      while (!stop) {
        try {
          const found = await room.scan();
          if (!stop) setRooms(found);
        } catch (e) {
          if (!stop) setRooms([]);
          onError(e);
          return;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    };
    void loop();
    return () => {
      stop = true;
    };
  }, [joining, jam.role, room, onError]);

  const cleanName = name.trim() || t("jam.guest");

  const open = async () => {
    setBusy(true);
    try {
      await room.open(cleanName);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const where = target?.address ?? address.trim();
    if (!where || code.trim().length !== 4) return;
    setBusy(true);
    try {
      await room.join(where, code.trim(), cleanName);
      onClose();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const joinInvite = async () => {
    if (!invite.trim()) return;
    setBusy(true);
    try {
      // The code travels inside the invite.
      await room.join(invite.trim(), "", cleanName);
      onClose();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const openToHome = async () => {
    setInviting(true);
    try {
      await room.inviteFromHome();
    } catch (e) {
      onError(e);
    } finally {
      setInviting(false);
    }
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(jam.invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      onError(e);
    }
  };

  const leave = async () => {
    if (jam.role === "host" && jam.peers.length > 1) {
      const ok = await ask(t("jam.closeConfirm"), { kind: "warning", title: t("jam.title"), okLabel: t("jam.close"), cancelLabel: t("items.cancel") });
      if (!ok) return;
    }
    await room.leave();
  };

  const people = (
    <section className="jam-people" aria-label={t("jam.people")}>
      <h3>{t("jam.people")}</h3>
      <ul>
        {jam.peers.map((p) => (
          <li key={p.id}>
            <span className="jam-dot" style={{ background: p.color }} aria-hidden />
            <strong>{p.name}</strong>
            {p.id === jam.me && <span className="muted"> ({t("jam.you")})</span>}
            {p.id === 0 && <span className="muted"> · {t("jam.isHost")}</span>}
            {p.patternId && patternName(p.patternId) && <span className="muted"> · {t("jam.lookingAt", { pattern: patternName(p.patternId) })}</span>}
          </li>
        ))}
      </ul>
    </section>
  );

  let body;
  if (jam.role === "host") {
    body = (
      <div className="jam-host">
        <p className="jam-code-label">{t("jam.codeLabel")}</p>
        <p className="jam-code" aria-label={t("jam.codeLabel")}>
          {jam.code}
        </p>
        <ol className="jam-steps">
          <li>{t("jam.hostStep1")}</li>
          <li>{t("jam.hostStep2", { name: jam.roomName })}</li>
          <li>{t("jam.hostStep3")}</li>
        </ol>
        {jam.address ? <p className="muted small">{t("jam.hostAddress", { address: jam.address })}</p> : <p className="phone-warn">{t("phone.noNetwork")}</p>}
        <section className="jam-home" aria-label={t("jam.homeTitle")}>
          <h3>{t("jam.homeTitle")}</h3>
          {jam.invite ? (
            <>
              <p className="small">{t("jam.homeSend")}</p>
              <input className="jam-invite" readOnly value={jam.invite} aria-label={t("jam.homeInvite")} onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={copyInvite}>
                <Icon name="copy" size={14} /> {copied ? t("jam.homeCopied") : t("jam.homeCopy")}
              </button>
              <p className="muted small">{t("jam.homeNote")}</p>
            </>
          ) : (
            <>
              <p className="muted small">{t("jam.homeHint")}</p>
              <button onClick={openToHome} disabled={inviting}>
                <Icon name="people" size={14} /> {inviting ? t("jam.homeOpening") : t("jam.homeOpen")}
              </button>
            </>
          )}
        </section>
        {jam.vpnAddress && <p className="jam-vpn small">{t("jam.hostVpn", { address: jam.vpnAddress })}</p>}
        <p className="muted small">{t("phone.firewall")}</p>
        {people}
        <button className="danger" onClick={leave}>
          {t("jam.close")}
        </button>
      </div>
    );
  } else if (jam.role === "guest") {
    body = (
      <div className="jam-host">
        <p className="dialog-lead">{jam.joining ? t("jam.receiving") : t("jam.inRoom", { name: jam.roomName })}</p>
        {people}
        <button className="danger" onClick={leave}>
          {t("jam.leave")}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <p className="dialog-lead">{t("jam.lead")}</p>
        <label className="jam-name">
          {t("jam.yourName")}
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder={t("jam.namePlaceholder")} />
        </label>
        {!joining ? (
          <div className="jam-choices">
            <button className="jam-choice primary" data-autofocus onClick={open} disabled={busy}>
              <Icon name="people" size={22} />
              <strong>{t("jam.open")}</strong>
              <span>{t("jam.openHint")}</span>
            </button>
            <button className="jam-choice" onClick={() => setJoining(true)} disabled={busy}>
              <Icon name="download" size={22} />
              <strong>{t("jam.join")}</strong>
              <span>{t("jam.joinHint")}</span>
            </button>
          </div>
        ) : (
          <div className="jam-join">
            <h3>{t("jam.roomsTitle")}</h3>
            {rooms === null ? (
              <p className="muted small">{t("jam.searching")}</p>
            ) : rooms.length === 0 ? (
              <p className="muted small">{t("jam.noRooms")}</p>
            ) : (
              <ul className="jam-rooms">
                {rooms.map((r) => (
                  <li key={r.address}>
                    <button className={target?.address === r.address ? "active" : ""} aria-pressed={target?.address === r.address} onClick={() => setTarget(r)}>
                      <Icon name="people" size={14} /> {t("jam.roomOf", { name: r.name })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button className="link-btn" onClick={() => setFromHome((m) => !m)} aria-expanded={fromHome}>
              {t("jam.haveInvite")}
            </button>
            {fromHome && (
              <form
                className="jam-code-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void joinInvite();
                }}
              >
                <label className="jam-name">
                  {t("jam.pasteInvite")}
                  <input className="jam-invite" value={invite} autoFocus onChange={(e) => setInvite(e.target.value)} placeholder="SL-…" />
                </label>
                <button className="primary" type="submit" disabled={busy || !invite.trim()}>
                  {busy ? t("jam.connectingHome") : t("jam.enter")}
                </button>
              </form>
            )}
            <button className="link-btn" onClick={() => setManual((m) => !m)} aria-expanded={manual}>
              {t("jam.manual")}
            </button>
            {manual && (
              <label className="jam-name">
                {t("jam.address")}
                <input
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    setTarget(null);
                  }}
                  placeholder="192.168.0.10"
                />
              </label>
            )}
            {(target || (manual && address.trim())) && (
              <form
                className="jam-code-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void join();
                }}
              >
                <label>
                  {t("jam.code")}
                  <input
                    className="jam-code-input"
                    value={code}
                    inputMode="numeric"
                    maxLength={4}
                    autoFocus
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    aria-describedby="jam-code-hint"
                  />
                </label>
                <span id="jam-code-hint" className="muted small">
                  {t("jam.codeHint")}
                </span>
                <button className="primary" type="submit" disabled={busy || code.length !== 4}>
                  {busy ? t("jam.entering") : t("jam.enter")}
                </button>
              </form>
            )}
            <button onClick={() => setJoining(false)} disabled={busy}>
              {t("jam.back")}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <Dialog title={t("jam.title")} onClose={onClose} closeLabel={t("exportDlg.close")}>
      {body}
    </Dialog>
  );
}
