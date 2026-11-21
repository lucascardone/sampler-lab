// Client for the local Python engine (HTTP + WebSocket on 127.0.0.1).
import type { EngineInfo } from "./api";

export type Stem = "vocals" | "drums" | "bass" | "guitar" | "piano" | "other";
export type Quality = "fast" | "best";

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  stage: "" | "loading" | "separating" | "writing";
  estimateSeconds: number | null;
  etaSeconds: number | null;
  result: { model: string; stems: Record<string, string> } | null;
  error: string | null;
}

export interface Health {
  device: { type: "cuda" | "mps" | "cpu"; name: string };
}

export class EngineClient {
  private base: string;
  private ws: WebSocket | null = null;
  private listeners = new Set<(job: Job) => void>();

  constructor(private info: EngineInfo) {
    this.base = `http://127.0.0.1:${info.port}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method,
      headers: { "x-token": this.info.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.json().then((d) => d.detail).catch(() => r.statusText);
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return r.json();
  }

  health = () => this.call<Health>("GET", "/health");
  separate = (body: { inputPath: string; outDir: string; stems: Stem[]; quality: Quality; duration: number }) =>
    this.call<Job>("POST", "/separate", body);
  cancel = (jobId: string) => this.call<Job>("DELETE", `/jobs/${jobId}`);
  job = (jobId: string) => this.call<Job>("GET", `/jobs/${jobId}`);

  /** Subscribe to job updates (opens the WebSocket on first use). */
  onJob(fn: (job: Job) => void): () => void {
    this.listeners.add(fn);
    if (!this.ws) {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.info.port}/ws?token=${this.info.token}`);
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "job") this.listeners.forEach((l) => l(msg.job));
      };
      this.ws.onclose = () => {
        this.ws = null;
      };
    }
    return () => {
      this.listeners.delete(fn);
    };
  }
}

let client: EngineClient | null = null;
let clientPort = -1;

/** One shared client per engine process. */
export function engineClient(info: EngineInfo): EngineClient {
  if (!client || clientPort !== info.port) {
    client = new EngineClient(info);
    clientPort = info.port;
  }
  return client;
}
