// UI check driver (dev only, no deps): headless Edge over CDP with Node 24 WebSocket. node shoot.mjs <steps.json> <outDir>
// steps: [{url, w, h}] then [{eval: "js"}, {wait: ms}, {shot: "name"}]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [stepsFile, outDir] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const port = 9333 + Math.floor(Math.random() * 500);
const edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, "--disable-gpu", "--no-first-run",
  `--user-data-dir=${join(tmpdir(), "sl-edge-" + port)}`, "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) logs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + m.params.exceptionDetails.exception?.description);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
await send("Page.enable");
for (const s of steps) {
  if (s.url) {
    await send("Emulation.setDeviceMetricsOverride", { width: s.w ?? 1280, height: s.h ?? 800, deviceScaleFactor: s.dpr ?? 1, mobile: !!s.mobile });
    if (s.dark !== undefined) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s.dark ? "dark" : "light" }] });
    await send("Page.navigate", { url: s.url });
    await sleep(s.wait ?? 2500);
  } else if (s.eval) {
    const r = await send("Runtime.evaluate", { expression: s.eval, awaitPromise: true, returnByValue: true });
    const v = r.result?.result?.value; if (v !== undefined) console.log("eval:", typeof v === "string" ? v : JSON.stringify(v));
    if (r.result?.exceptionDetails) console.log("eval error:", r.result.exceptionDetails.exception?.description);
    await sleep(s.wait ?? 400);
  } else if (s.wait) await sleep(s.wait);
  else if (s.shot) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, s.shot + ".png"), Buffer.from(r.result.data, "base64"));
    console.log("shot", s.shot);
  }
}
if (logs.length) console.log("console:\n" + [...new Set(logs)].slice(0, 20).join("\n"));
ws.close(); edge.kill();
process.exit(0);
