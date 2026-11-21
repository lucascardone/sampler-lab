// The separator install streams uv's output; this turns it into a few stages anyone can follow.

export type Stage = "resolve" | "python" | "torch" | "download" | "install";

/** uv's output, as a few stages anyone can follow. */
export function setupStage(line: string, prev: Stage): Stage {
  const l = line.toLowerCase();
  if (l.includes("cpython") || l.includes("python 3")) return "python";
  if (/\btorch\b/.test(l) || l.includes("nvidia-")) return "torch";
  if (l.startsWith("downloading") || l.startsWith(" downloading")) return prev === "torch" ? "torch" : "download";
  if (l.startsWith("prepared") || l.startsWith("installed") || l.startsWith("uninstalled") || l.includes("installing")) return "install";
  return prev;
}
