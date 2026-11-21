import { describe, expect, it } from "vitest";
import { setupStage, type Stage } from "./setupStage";

describe("setupStage", () => {
  it("follows a real uv install (clean PC, CPU build)", () => {
    const lines = [
      "Downloading cpython-3.12.15-windows-x86_64-none (download) (21.0MiB)",
      " Downloaded cpython-3.12.15-windows-x86_64-none (download)",
      "Using CPython 3.12.15",
      "Creating virtual environment at: C:/Users/José/AppData/Local/com.samplerlab.app/engine-venv",
      "   Building sampler-engine @ file:///C:/Users/José/AppData/Local/com.samplerlab.app/engine",
      "Downloading torch (118.3MiB)",
      "Downloading sympy (6.0MiB)",
      "Prepared 42 packages in 31.2s",
      "Installed 42 packages in 2.1s",
    ];
    const seen: Stage[] = [];
    let st: Stage = "resolve";
    for (const l of lines) seen.push((st = setupStage(l, st)));
    expect(seen).toEqual(["python", "python", "python", "python", "python", "torch", "torch", "install", "install"]);
  });

  it("other downloads without torch are just 'downloading'", () => {
    expect(setupStage("Downloading numpy (12.0MiB)", "resolve")).toBe("download");
    expect(setupStage("Resolved 60 packages in 1ms", "resolve")).toBe("resolve");
  });
});
