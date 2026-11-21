// Stages what the installed app needs to run the stem separator on any PC:
//   src-tauri/resources/engine/  the Python engine project (sources + lock, no venv/tests/caches)
//   src-tauri/resources/bin/uv.exe  uv, pinned, from its official GitHub release (MIT/Apache-2.0)
// tauri.conf.json bundles both folders. Runs before `tauri dev` and `tauri build`.
//
//   node scripts/prepare-resources.mjs            dev: a failed uv download is only a warning
//   node scripts/prepare-resources.mjs --release  build: it's an error
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.13.0";
const UV_ASSET = "uv-x86_64-pc-windows-msvc.zip";

const release = process.argv.includes("--release");
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineSrc = join(app, "..", "engine");
const res = join(app, "src-tauri", "resources");
const engineDst = join(res, "engine");
const binDst = join(res, "bin");

// ---- engine sources ----
const keep = (rel) =>
  rel === "pyproject.toml" ||
  rel === "uv.lock" ||
  rel === ".python-version" ||
  (rel.startsWith("sampler_engine") && rel.endsWith(".py") && !rel.includes("__pycache__"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".venv" || name === "__pycache__" || name === ".pytest_cache") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

rmSync(engineDst, { recursive: true, force: true });
let n = 0;
for (const file of walk(engineSrc)) {
  const rel = relative(engineSrc, file).replaceAll("\\", "/");
  if (!keep(rel)) continue;
  const to = join(engineDst, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(file, to);
  n++;
}
console.log(`engine: ${n} files -> ${relative(app, engineDst)}`);

// ---- uv.exe ----
mkdirSync(binDst, { recursive: true });
const uvExe = join(binDst, "uv.exe");
const stamp = join(binDst, "uv.version");
const have = existsSync(uvExe) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === UV_VERSION;

if (have) {
  console.log(`uv ${UV_VERSION}: already there`);
} else if (process.platform !== "win32") {
  console.log("uv: skipped (Windows-only bundle)");
} else {
  try {
    const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}`;
    const [zip, sum] = await Promise.all([fetch(base), fetch(`${base}.sha256`)]);
    if (!zip.ok || !sum.ok) throw new Error(`HTTP ${zip.status}/${sum.status}`);
    const bytes = Buffer.from(await zip.arrayBuffer());
    const expected = (await sum.text()).trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch (${actual} != ${expected})`);
    const tmp = join(tmpdir(), `sampler-uv-${UV_VERSION}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, UV_ASSET), bytes);
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${join(tmp, UV_ASSET)}' -DestinationPath '${tmp}' -Force`,
    ]);
    cpSync(join(tmp, "uv.exe"), uvExe);
    writeFileSync(stamp, UV_VERSION);
    rmSync(tmp, { recursive: true, force: true });
    console.log(`uv ${UV_VERSION}: downloaded (sha256 ok)`);
  } catch (e) {
    const msg = `uv ${UV_VERSION}: could not download (${e.message})`;
    if (release) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`${msg}. Dev builds use uv from PATH.`);
  }
}
