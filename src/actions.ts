import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  bootstrapFloorSchema,
  bootstrapHomeSchema,
  bootstrapMeSchema,
  bootstrapSessionSchema,
  eventsResponseSchema,
  floorResponseSchema,
  credentialResponseSchema,
  credentialsResponseSchema,
  githubDevicePollSchema,
  githubDeviceStartSchema,
  onboardingCompleteResponseSchema,
  onboardingProfileResponseSchema,
  repositoryOptionsResponseSchema,
  reviewContributionResponseSchema,
  reviewContributionsSchema,
  recordResponseSchema,
  sessionCreateResponseSchema,
  type FloorSnapshot,
} from "./contracts.js";
import { ApiClient } from "./client.js";
import { resolveId } from "./id.js";
import { sanitizeTerminal } from "./sanitize.js";

export class OpenFloorActions {
  constructor(readonly client: ApiClient) {}

  me() { return this.client.request("/api/bootstrap/me", { schema: bootstrapMeSchema }); }
  home(signal?: AbortSignal) { return this.client.request("/api/bootstrap/home", { schema: bootstrapHomeSchema, ...(signal ? { signal } : {}) }); }
  session(id: string, signal?: AbortSignal) { return this.client.request(`/api/bootstrap/session/${encodeURIComponent(id)}`, { schema: bootstrapSessionSchema, ...(signal ? { signal } : {}) }); }
  floor(id: string, signal?: AbortSignal) { return this.client.request(`/api/bootstrap/session/${encodeURIComponent(id)}/floor`, { schema: bootstrapFloorSchema, ...(signal ? { signal } : {}) }); }
  floorSnapshot(id: string) { return this.client.request(`/api/sessions/${encodeURIComponent(id)}/floor`, { schema: floorResponseSchema }); }
  repositories(signal?: AbortSignal) { return this.client.request("/api/account/github/repositories", { schema: repositoryOptionsResponseSchema, ...(signal ? { signal } : {}) }); }
  createSession(input: { title: string; objective: string | null; candidateName: string | null; repositoryId: string; accountInstallationId: string }) {
    return this.client.request("/api/sessions", { method: "POST", body: input, schema: sessionCreateResponseSchema });
  }
  events(id: string, runId: string, after = 0) {
    return this.client.request(`/api/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { schema: eventsResponseSchema });
  }
  reviewContributions(id: string, status: "active" | "rolled_back" = "active", signal?: AbortSignal) {
    return this.client.request(`/api/sessions/${encodeURIComponent(id)}/review/contributions?status=${status}&limit=100`, { schema: reviewContributionsSchema, ...(signal ? { signal } : {}) });
  }
  reviewContribution(id: string, runId: string, signal?: AbortSignal) {
    return this.client.request(`/api/sessions/${encodeURIComponent(id)}/review/contributions/${encodeURIComponent(runId)}`, { schema: reviewContributionResponseSchema, ...(signal ? { signal } : {}) });
  }
  credentials(signal?: AbortSignal) { return this.client.request("/api/account/credentials", { schema: credentialsResponseSchema, ...(signal ? { signal } : {}) }); }
  connectCredential(provider: string, body: Record<string, string>) { return this.client.request(`/api/account/credentials/${encodeURIComponent(provider)}`, { method: "PUT", body, schema: credentialResponseSchema }); }
  disconnectCredential(provider: string, kind: string) { return this.client.request(`/api/account/credentials/${encodeURIComponent(provider)}?kind=${encodeURIComponent(kind)}`, { method: "DELETE", schema: recordResponseSchema }); }
  saveOnboardingProfile(input: { firstName: string; lastName: string; githubHandle: string }) {
    const form = new FormData(); form.set("firstName", input.firstName); form.set("lastName", input.lastName); form.set("githubHandle", input.githubHandle);
    return this.client.request("/api/account/onboarding", { method: "PATCH", form, schema: onboardingProfileResponseSchema });
  }
  startGithubDevice() { return this.client.request("/api/account/github/device", { method: "POST", schema: githubDeviceStartSchema }); }
  pollGithubDevice(deviceCode: string) { return this.client.request("/api/account/github/device", { method: "PUT", body: { deviceCode }, schema: githubDevicePollSchema }); }
  completeOnboarding(input: { firstName: string; lastName: string; githubHandle: string }) {
    const form = new FormData(); form.set("firstName", input.firstName); form.set("lastName", input.lastName); form.set("githubHandle", input.githubHandle); form.set("plan", "free"); form.set("quantity", "1"); form.set("returnTo", "/home");
    return this.client.request("/api/account/onboarding", { method: "POST", form, schema: onboardingCompleteResponseSchema });
  }

  get(path: string, signal?: AbortSignal) { return this.client.request(path, { schema: recordResponseSchema, ...(signal ? { signal } : {}) }); }
  async text(path: string): Promise<string> {
    const response = await this.client.request<Response>(path, { raw: true });
    return sanitizeTerminal(await response.text());
  }
  post(path: string, body?: unknown) { return this.client.request(path, { method: "POST", ...(body === undefined ? {} : { body }), schema: recordResponseSchema }); }
  put(path: string, body?: unknown) { return this.client.request(path, { method: "PUT", ...(body === undefined ? {} : { body }), schema: recordResponseSchema }); }
  patch(path: string, body?: unknown) { return this.client.request(path, { method: "PATCH", ...(body === undefined ? {} : { body }), schema: recordResponseSchema }); }
  delete(path: string, body?: unknown) { return this.client.request(path, { method: "DELETE", ...(body === undefined ? {} : { body }), schema: recordResponseSchema }); }

  async resolveSession(input: string): Promise<string> {
    const sessions = (await this.home()).props.sessions;
    return resolveId(input, sessions, "Session");
  }

  async resolveFloorEntity(sessionId: string, input: string, kind: "agent" | "queue" | "run" | "file" | "conflict"): Promise<string> {
    const floor = (await this.floor(sessionId)).props.initialFloor;
    const values = kind === "agent" ? floor.agents
      : kind === "queue" ? floor.queue
      : kind === "run" ? floor.runs
      : kind === "file" ? floor.files as Array<{ id: string }>
      : ((floor.review as any)?.conflicts ?? []) as Array<{ id: string }>;
    return resolveId(input, values, kind[0]!.toUpperCase() + kind.slice(1));
  }

  async uploadFiles(sessionId: string, paths: string[]): Promise<Record<string, unknown>> {
    const form = new FormData();
    for (const path of paths) {
      const bytes = await readFile(path);
      form.append("files", new File([bytes], basename(path)));
    }
    return this.client.request(`/api/sessions/${encodeURIComponent(sessionId)}/files`, { method: "POST", form, schema: recordResponseSchema });
  }

  async download(sessionId: string, fileId: string, destination: string): Promise<{ path: string; bytes: number }> {
    const response = await this.client.request<Response>(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, { raw: true });
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(destination, bytes, { flag: "wx" });
    return { path: destination, bytes: bytes.byteLength };
  }

  async readTextInput(value?: string, file?: string): Promise<string> {
    if (file) return readFile(file, "utf8");
    if (value != null) return value;
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
}

export function floorFromResult(result: Record<string, unknown>): FloorSnapshot | null {
  return result.floor && typeof result.floor === "object" ? result.floor as FloorSnapshot : null;
}
