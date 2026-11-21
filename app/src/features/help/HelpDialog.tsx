// The manual inside the app. Desktop: a dialog with the sections on the left. Phone: a
// full-screen sheet with the phone part, one collapsible section each.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { MANUAL } from "./manual";
import { Markdown } from "./Markdown";

export function HelpDialog({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const { t } = useTranslation();
  const all = MANUAL.flatMap((p) => p.sections);
  const [id, setId] = useState(initial ?? all[0]?.id);
  const section = all.find((s) => s.id === id) ?? all[0];
  return (
    <Dialog title={t("help.title")} onClose={onClose} closeLabel={t("exportDlg.close")}>
      <div className="help">
        <nav className="help-nav" aria-label={t("help.sections")}>
          {MANUAL.map((part) => (
            <div key={part.title}>
              <h3>{part.title}</h3>
              <ul>
                {part.sections.map((s) => (
                  <li key={s.id}>
                    <button className={s.id === section.id ? "on" : ""} aria-current={s.id === section.id} onClick={() => setId(s.id)}>
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <article className="help-body" key={section.id}>
          <h2>{section.title}</h2>
          <Markdown source={section.body} />
        </article>
      </div>
    </Dialog>
  );
}

export function MobileHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const phone = MANUAL[1];
  return (
    <div className="m-help" role="dialog" aria-modal="true" aria-label={t("help.title")}>
      <header>
        <h1>{t("help.mobileTitle")}</h1>
        <button className="m-help-close" onClick={onClose} aria-label={t("exportDlg.close")}>
          <Icon name="x" size={22} />
        </button>
      </header>
      <div className="m-help-body">
        {phone?.sections.map((s, i) => (
          <details key={s.id} open={i === 0}>
            <summary>{s.title}</summary>
            <Markdown source={s.body} />
          </details>
        ))}
      </div>
    </div>
  );
}
