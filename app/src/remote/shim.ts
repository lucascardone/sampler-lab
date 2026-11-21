// Phone mode: the same web app, opened in a browser on the phone (no Tauri there).
// This bridge stands in for Tauri's internals so everything that calls `invoke`,
// `convertFileSrc` or the dialog/event plugins keeps working — over HTTP to the PC
// (see src-tauri/src/remote.rs).
//
// The access code comes in the QR link (?t=…), is kept on the phone and removed from
// the address bar.

const TOKEN_KEY = "sampler-lab.remote-token";

type Internals = {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (cb: (v: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (path: string, protocol?: string) => string;
  metadata: unknown;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Internals;
    __SAMPLER_REMOTE__?: boolean;
  }
}

export const isRemote = typeof window !== "undefined" && !window.__TAURI_INTERNALS__;

function readToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("t");
  try {
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete("t");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    return fromUrl ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return fromUrl;
  }
}

export const remoteToken = isRemote ? readToken() : null;

/** Last base name of a path-ish string ("remote:/01 Bombo.wav" → "01 Bombo.wav"). */
const baseName = (p: string) => p.split(/[/\\:]/).filter(Boolean).pop() ?? "";

/** Buttons as plugin-dialog sends them to Rust ("OkCancel", {OkCancelCustom: [ok, cancel]}…). */
type DialogButtons =
  | string
  | { OkCancelCustom?: [string, string]; YesNoCancelCustom?: [string, string, string]; OkCustom?: string };

/** plugin-dialog's `message` in a browser: answers with a button label, like the PC does. */
export function browserMessage(message: string, buttons?: DialogButtons): string {
  if (buttons === "YesNo" || buttons === "YesNoCancel") return window.confirm(message) ? "Yes" : "No";
  if (buttons === "OkCancel") return window.confirm(message) ? "Ok" : "Cancel";
  if (buttons && typeof buttons === "object") {
    const pair = buttons.OkCancelCustom ?? (buttons.YesNoCancelCustom && [buttons.YesNoCancelCustom[0], buttons.YesNoCancelCustom[2]]);
    if (pair) return window.confirm(message) ? pair[0] : pair[1];
    window.alert(message);
    return buttons.OkCustom ?? "Ok";
  }
  window.alert(message);
  return "Ok";
}

async function call(cmd: string, args: unknown): Promise<unknown> {
  const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
  const res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers: { "x-token": remoteToken ?? "", ...(raw ? { "x-raw": "1" } : { "content-type": "application/json" }) },
    body: raw ? (args as BodyInit) : JSON.stringify(args ?? {}),
  });
  let data: { ok?: unknown; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw data.error ?? `Error ${res.status} de la PC`;
  return data.ok ?? null;
}

if (isRemote) {
  window.__SAMPLER_REMOTE__ = true;
  let cb = 0;
  const callbacks = new Map<number, (v: unknown) => void>();
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: (f) => {
      callbacks.set(++cb, f);
      return cb;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => `/api/file?t=${encodeURIComponent(remoteToken ?? "")}&path=${encodeURIComponent(path)}`,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:dialog|")) {
        const a = (args ?? {}) as {
          message?: string;
          buttons?: DialogButtons;
          options?: { defaultPath?: string };
        };
        if (cmd.endsWith("|ask") || cmd.endsWith("|confirm")) return window.confirm(a.message ?? "");
        // ask()/confirm() of plugin-dialog 2.8 come through here and compare the answer
        // with the label of the button that means "yes".
        if (cmd.endsWith("|message")) return browserMessage(a.message ?? "", a.buttons);
        // Files made on the phone are saved on the PC, in a fixed folder.
        if (cmd.endsWith("|save")) return `remote:${baseName(a.options?.defaultPath ?? "export")}`;
        if (cmd.endsWith("|open")) return "remote:";
        return null;
      }
      if (cmd.startsWith("plugin:")) return cmd.endsWith("|listen") ? ++cb : null;
      return call(cmd, args);
    },
  };
}
