import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { ApiClient } from "./client.js";
import type { RunActivityEvent } from "./contracts.js";
import { eventsResponseSchema } from "./contracts.js";
import { sanitizeDeep } from "./sanitize.js";

export type PresenceEvent =
  | { type: "presence.snapshot"; onlineUserIds: string[]; typingDrafts: TypingDraft[] }
  | { type: "presence.changed"; userId: string; online: boolean }
  | { type: "typing.changed"; draft: TypingDraft }
  | { type: "members.changed" }
  | { type: "session.changed"; objective: string | null; updatedAt: number }
  | { type: "session.ended"; endedAt: number; reason: string }
  | { type: "session.locked"; lockedAt: number | null }
  | { type: "floor.changed"; revision: number; domains: string[] }
  | { type: "run.activity"; runId: string; agentId: string; events: RunActivityEvent[] }
  | { type: "error"; code: string };

export type TypingDraft = { userId: string; displayName: string; text: string; typing: boolean; updatedAt: number };
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "idle" | "quota-exhausted" | "closed";

export class PresenceClient extends EventEmitter {
  private socket: WebSocket | undefined;
  private retry: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private attempts = 0;
  private disposed = false;
  private lastInputAt = 0;
  private status: ConnectionStatus = "connecting";
  private readonly sequences = new Map<string, number>();
  private readonly runAgents = new Map<string, string>();

  constructor(private readonly api: ApiClient, private readonly sessionId: string) { super(); }

  async connect(): Promise<void> {
    if (this.disposed || this.status === "quota-exhausted") return;
    this.setStatus(this.attempts ? "reconnecting" : "connecting");
    const url = new URL(`/api/sessions/${encodeURIComponent(this.sessionId)}/presence`, this.api.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const token = await this.api.token();
    const reconnecting = this.attempts > 0;
    const socket = new WebSocket(url, { headers: token ? { "cf-access-token": token } : {} });
    this.socket = socket;
    socket.on("open", () => { if (reconnecting) void this.catchUp(); });
    socket.on("message", (raw) => {
      const text = raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString("utf8");
      if (text === "pong") return;
      let event: PresenceEvent;
      try { event = sanitizeDeep(JSON.parse(text)) as PresenceEvent; } catch { return; }
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      if (event.type === "run.activity") {
        this.runAgents.set(event.runId, event.agentId);
        const after = this.sequences.get(event.runId) ?? 0;
        event = { ...event, events: event.events.filter((item) => item.sequence > after) };
        if (!event.events.length) return;
        this.sequences.set(event.runId, Math.max(after, ...event.events.map((item) => item.sequence)));
      }
      this.attempts = 0; this.setStatus("live"); this.emit("event", event);
    });
    socket.on("close", (code, reasonBuffer) => {
      if (this.socket === socket) this.socket = undefined;
      if (this.disposed) return;
      const reason = String(reasonBuffer);
      this.emit("close", { code, reason });
      if (code === 4003) { this.setStatus("quota-exhausted"); return; }
      if (code === 4004) { this.setStatus("idle"); return; }
      if (code === 4001 || code === 4005) { this.setStatus("closed"); return; }
      this.attempts += 1; this.setStatus("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** Math.min(Math.max(this.attempts - 1, 0), 5));
      this.retry = setTimeout(() => void this.connect().catch((error) => this.emit("error", error)), delay);
    });
    socket.on("error", (error) => this.emit("socket-error", error));
    this.heartbeat ??= setInterval(() => {
      if (Date.now() - this.lastInputAt <= 5 * 60_000 && this.socket?.readyState === WebSocket.OPEN) this.socket.send("ping");
    }, 30_000);
  }

  noteInput(): void {
    this.lastInputAt = Date.now();
    if (this.status === "idle") { this.attempts = 0; void this.connect().catch((error) => this.emit("error", error)); }
  }

  sendDraft(text: string, typing = text.length > 0): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "typing.update", text: text.slice(0, 4_000), typing }));
  }

  close(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(1000, "TUI left session");
    this.socket = undefined;
    this.setStatus("closed");
  }

  private async catchUp(): Promise<void> {
    await Promise.all([...this.sequences].map(async ([runId, after]) => {
      try {
        const result = await this.api.request(`/api/sessions/${encodeURIComponent(this.sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { schema: eventsResponseSchema });
        const events = result.events.filter((item) => item.sequence > (this.sequences.get(runId) ?? 0));
        if (!events.length) return;
        this.sequences.set(runId, Math.max(...events.map((item) => item.sequence)));
        this.emit("event", { type: "run.activity", runId, agentId: this.runAgents.get(runId) ?? "", events } satisfies PresenceEvent);
      } catch (error) { this.emit("catchup-error", error); }
    }));
  }

  private setStatus(status: ConnectionStatus): void { this.status = status; this.emit("status", status); }
}
