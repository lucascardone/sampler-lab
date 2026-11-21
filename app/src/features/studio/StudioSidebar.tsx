// Studio left side, like VS Code: a thin activity bar (Sonidos / Patrones / Ocultar
// panel) and next to it the chosen view. Clicking the open view again hides the panel,
// so the editor gets the room; "Ocultar panel" does the same with a visible label.
// What's open is remembered on this PC.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../../ui/Icon";

export type SidebarView = "sounds" | "patterns";

interface Saved {
  view: SidebarView;
  open: boolean;
}

const KEY = "studio.sidebar";

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return { view: raw?.view === "patterns" ? "patterns" : "sounds", open: raw?.open !== false };
  } catch {
    return { view: "sounds", open: true };
  }
}

function store(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: just don't remember */
  }
}

interface Props {
  sounds: ReactNode;
  patterns: ReactNode;
  patternCount: number;
}

export function StudioSidebar({ sounds, patterns, patternCount }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<Saved>(load);
  const set = (s: Saved) => {
    setState(s);
    store(s);
  };
  /** Click on a view: open it, or hide the panel if it's the one already showing. */
  const pick = (view: SidebarView) => set(state.open && state.view === view ? { view, open: false } : { view, open: true });

  const item = (view: SidebarView, icon: IconName, label: string, badge?: number) => {
    const on = state.open && state.view === view;
    return (
      <button
        aria-pressed={on}
        className={`activity-btn ${on ? "on" : ""}`}
        onClick={() => pick(view)}
        title={on ? t("studio.side.hideHint") : undefined}
      >
        <Icon name={icon} size={20} />
        <span>{label}</span>
        {badge !== undefined && <em className="activity-badge">{badge}</em>}
      </button>
    );
  };

  return (
    <>
      <nav className="activity-bar" aria-label={t("studio.side.label")}>
        {item("sounds", "note", t("studio.side.sounds"))}
        {item("patterns", "steps", t("studio.side.patterns"), patternCount)}
        <div className="spacer" />
        <button
          className="activity-btn"
          onClick={() => set({ ...state, open: !state.open })}
        >
          <Icon name="panel" size={20} />
          <span>{state.open ? t("studio.side.hide") : t("studio.side.show")}</span>
        </button>
      </nav>
      {state.open && (
        <div className="side-panel">
          {state.view === "sounds" ? sounds : patterns}
        </div>
      )}
    </>
  );
}
