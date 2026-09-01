import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderedQueue, paneWindow, startTui } from "../src/tui.js";
import type { OpenFloorActions } from "../src/actions.js";
import type { ApiClient } from "../src/client.js";
import { OpenFloorError } from "../src/errors.js";

const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); vi.unstubAllEnvs(); });
const usage = { plan: "pro" as const, planStatus: "inactive" as const, effectivePlan: "enterprise" as const, seconds: 2_707, limitHours: null, limitSeats: null };

describe("TUI", () => {
  it("renders honest home empty state", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("openfloor");
    expect(instance.lastFrame()).toContain("No sessions.");
    expect(instance.lastFrame()).toContain("Enterprise plan");
    expect(instance.lastFrame()).toContain("Unlimited session time · Unlimited seats");
    expect(instance.lastFrame()).toContain("45m 7s used this month");
  });

  it("stops initial loading with Escape", async () => {
    let aborted = false;
    const actions = {
      home: (signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      }),
    } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Loading openfloor…");
    instance.stdin.write("\u001b");
    await pause(50);
    expect(aborted).toBe(true);
  });

  it("opens help from keyboard", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("↑↓ select · Enter opens · n creates · a session actions");
  });

  it("uses inline slash suggestions instead of a home filter popup", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Type / for commands");

    instance.stdin.write("/");
    await waitForFrame(instance, "/new");
    expect(instance.lastFrame()).not.toContain("Filter sessions");
    instance.stdin.write("set");
    await waitForFrame(instance, "/settings");
    instance.stdin.write("\r");
    await pause();
    expect(instance.lastFrame()).toContain("sessions › /settings");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Authentication: Cloudflare Access");
    expect(instance.lastFrame()).toContain("Cloudflare Access in an openfloor-only local cache");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
    instance.stdin.write("\u000b");
    await waitForFrame(instance, "/new");
    instance.stdin.write("set");
    await waitForFrame(instance, "/settings");
    instance.stdin.write("\r");
    await pause();
    instance.stdin.write("\r");
    await waitForFrame(instance, "CLI settings");
  });

  it("logs out through the Sessions command bar", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787", logout }));
    instances.push(instance);
    await waitForFrame(instance, "Type / for commands");
    instance.stdin.write("/"); await pause(); instance.stdin.write("logout"); await pause(); instance.stdin.write("\r");
    await pause(50);
    expect(logout).toHaveBeenCalledOnce();
  });

  it("creates a session through native repository selection", async () => {
    const createSession = vi.fn().mockResolvedValue({
      session: { id: "12345678-1234-4234-8234-1234567890ab", title: "Test", objective: null, role: "owner", createdAt: 1, updatedAt: 1, endedAt: null },
      setupStatus: "failed",
      setupError: "Candidate branch provisioning failed.",
    });
    const actions = {
      home: () => Promise.resolve({ props: { sessions: [], usage } }),
      repositories: () => Promise.resolve({ repositories: [
        { id: "repo-1", accountInstallationId: "install-1", fullName: "openfloor/app", private: true, defaultBranch: "main" },
        { id: "repo-2", accountInstallationId: "install-1", fullName: "openfloor/docs", private: false, defaultBranch: "main" },
      ] }),
      createSession,
    } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await pause();
    instance.stdin.write("n");
    await waitForFrame(instance, "Task");
    expect(instance.lastFrame()).toContain("Task");
    expect(instance.lastFrame()).not.toContain("Enterprise plan");
    instance.stdin.write("Test");
    await waitForFrame(instance, "Test");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Goal");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Candidate branch name");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Select repository");
    expect(instance.lastFrame()).toContain("Select repository");
    instance.stdin.write("\u001b[B");
    await pause();
    instance.stdin.write("\r");
    await pause();
    expect(instance.lastFrame()).toContain("Repository: openfloor/docs");
    instance.stdin.write("\r");
    await pause(40);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ title: "Test", repositoryId: "repo-2" }));
    expect(instance.lastFrame()).toContain("Candidate branch provisioning failed.");
  });

  it("never retries a create mutation with an unknown outcome", async () => {
    const createSession = vi.fn().mockRejectedValue(new Error("Connection lost after submit"));
    const actions = {
      home: () => Promise.resolve({ props: { sessions: [], usage } }),
      repositories: () => Promise.resolve({ repositories: [repositoryOption()] }),
      createSession,
    } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Sessions");
    instance.stdin.write("n"); await waitForFrame(instance, "Task");
    instance.stdin.write("Unknown outcome"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Goal");
    instance.stdin.write("\r"); await waitForFrame(instance, "Candidate branch name");
    instance.stdin.write("\r"); await waitForFrame(instance, "Select repository");
    instance.stdin.write("\r"); await waitForFrame(instance, "Repository: openfloor/app");
    instance.stdin.write("\r"); await waitForFrame(instance, "outcome may be unknown");
    instance.stdin.write("r"); await pause(50);
    expect(createSession).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).toContain("Connection lost after submit");
  });

  it("renders collaborative floor and routes slash commands through bottom bar", async () => {
    const session = { id: "12345678-1234-4234-8234-1234567890ab", title: "CLI floor", objective: "Ship", role: "owner" as const, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null };
    const floor = {
      revision: 1, autoDispatch: true, autoProvisionAgents: true, autoResolveConflicts: true,
      agents: [{ id: "agent-1", name: "Builder", role: "Engineer", task: "Implement", ownerUserId: "user-1", ownerName: "Matt", provider: "openai", model: null, pausedAt: null, kind: null }],
      assignments: [], messages: [{ id: "message-1", authorName: "Matt", recipientUserId: null, text: "hello" }], files: [],
      queue: [{ id: "queue-1", agentId: "agent-1", agentName: "Builder", position: 0, status: "running", prompts: [{ id: "prompt-1", authorName: "Matt", text: "Fix it", createdAt: 1 }] }],
      runs: [{ id: "run-1", queueItemId: "queue-1", agentId: "agent-1", agentName: "Builder", status: "running", model: "gpt", summary: null, finalResponse: null, createdAt: 1, updatedAt: 2, checks: [], files: [] }],
      repository: null, activeCandidate: null, latestPreflight: null, review: null,
    };
    const post = vi.fn().mockResolvedValue({});
    const actions = {
      home: () => Promise.resolve({ props: { sessions: [session], usage } }),
      session: () => Promise.resolve({ props: { session, initialMembers: [{ id: "user-1", displayName: "Matt", role: "owner", joinedAt: 1, online: true }] } }),
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
      post,
    } as unknown as OpenFloorActions;
    const client = { baseUrl: "http://127.0.0.1:9", token: () => Promise.resolve(null) } as unknown as ApiClient;
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    expect(instance.lastFrame()).toContain("Team chat");
    expect(instance.lastFrame()).toContain("Live teammate prompts");
    expect(instance.lastFrame()).toContain("Agent floor");
    expect(instance.lastFrame()).toContain("floor ›");

    instance.stdin.write("\t");
    await waitForFrame(instance, "› Team chat");
    instance.stdin.write("\u001b[C");
    await waitForFrame(instance, "› Live teammate prompts");
    instance.stdin.write("\u001b[C");
    await waitForFrame(instance, "› Agent floor");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Owner: Matt");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "floor ›");

    instance.stdin.write("Run tests"); await pause(); instance.stdin.write("\r");
    await pause(80);
    expect(post).toHaveBeenCalledWith(`/api/sessions/${session.id}/queue`, { prompt: "Run tests", agentId: null });
    expect(instance.lastFrame()).not.toContain("Command output");

    instance.stdin.write("/overview"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Members");
    expect(instance.lastFrame()).toContain("Members");

    instance.stdin.write("/commands"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "/sync");

    instance.stdin.write("/sessions"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Sessions");
    expect(instance.lastFrame()).toContain("CLI floor");
  });

  it("stops session loading with Escape and returns to Sessions", async () => {
    const { actions, client, session } = floorHarness();
    let aborted = false;
    Object.assign(actions, {
      floor: (_id: string, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Loading session floor…");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
    expect(aborted).toBe(true);
    expect(instance.lastFrame()).toContain("Session loading stopped.");
  });

  it("shows session load errors instead of an endless loading state", async () => {
    const { actions, client, session } = floorHarness();
    Object.assign(actions, { floor: () => Promise.reject(new Error("Server response is incompatible with this CLI")) });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Unable to load session floor");
    expect(instance.lastFrame()).toContain("Server response is incompatible with this CLI");
    expect(instance.lastFrame()).not.toContain("Loading session floor…");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
  });

  it("stops repository loading with Escape", async () => {
    let aborted = false;
    const actions = {
      home: () => Promise.resolve({ props: { sessions: [], usage } }),
      repositories: (signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      }),
    } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Sessions");
    instance.stdin.write("n");
    await waitForFrame(instance, "Loading GitHub repositories…");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
    expect(aborted).toBe(true);
  });

  it("stacks floor panes on narrow terminals", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    Object.defineProperty(instance.stdout, "columns", { value: 80, configurable: true });
    instance.stdout.emit("resize");
    await pause(50);
    const lines = instance.lastFrame()?.split("\n") ?? [];
    expect(lines.find((line) => line.includes("Team chat"))).not.toContain("Agent floor");
    expect(lines.find((line) => line.includes("Agent floor"))).not.toContain("Prompt queue");
  });

  it("supports help and logout from a session command bar", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id, logout }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("?");
    await waitForFrame(instance, "/help");
    expect(instance.lastFrame()).toContain("Type ordinary text to queue work");
    instance.stdin.write("/logout"); await pause(); instance.stdin.write("\r"); await pause(50);
    expect(logout).toHaveBeenCalledOnce();
  });

  it("autocompletes and runs direct command aliases without an output overlay", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id, runCommand }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/inv"); await waitForFrame(instance, "/invite"); instance.stdin.write("\r"); await pause();
    expect(instance.lastFrame()).toContain("floor › /invite");
    instance.stdin.write("\r"); await pause(60);
    expect(runCommand).toHaveBeenCalledWith("invite show", session.id, "http://127.0.0.1:9");
    expect(instance.lastFrame()).not.toContain("Command output");
  });

  it("uses contextual exit navigation and omits repository navigation", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/overview"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Members");
    instance.stdin.write("/exit"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/exit"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Sessions");
    instance.stdin.write("?"); await waitForFrame(instance, "Neither cancels a remote run.");
    expect(instance.lastFrame()).not.toContain("/repository");
  });

  it("creates an agent from the agent pane", async () => {
    const { actions, client, session, post } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("\t"); await waitForFrame(instance, "› Team chat");
    instance.stdin.write("\u001b[C"); await waitForFrame(instance, "› Live teammate prompts");
    instance.stdin.write("\u001b[C"); await waitForFrame(instance, "› Agent floor");
    instance.stdin.write("\u001b[B"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Create agent");
    instance.stdin.write("Reviewer"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Role");
    instance.stdin.write("Code reviewer"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Task");
    instance.stdin.write("Review changes"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Owner");
    instance.stdin.write("\r"); await waitForFrame(instance, "Provider");
    instance.stdin.write("\r"); await waitForFrame(instance, "Credential");
    instance.stdin.write("\r"); await waitForFrame(instance, "Model");
    instance.stdin.write("\r"); await waitForFrame(instance, "Enter creates once");
    instance.stdin.write("\r"); await pause(80);
    expect(post).toHaveBeenCalledWith(`/api/sessions/${session.id}/agents`, expect.objectContaining({ name: "Reviewer", role: "Code reviewer", task: "Review changes", provider: "openai" }));
  });

  it("toggles owner session settings after Tab enters the page", async () => {
    const { actions, client, session } = floorHarness();
    const patch = vi.fn().mockResolvedValue({}); Object.assign(actions, { patch });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/settings"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "Auto-dispatch");
    instance.stdin.write("\t"); await pause(); instance.stdin.write("\r"); await pause(60);
    expect(patch).toHaveBeenCalledWith(`/api/sessions/${session.id}/routing`, { autoDispatch: false });
  });

  it("opens review changes by file and renders one diff", async () => {
    const { actions, client, session, floor } = floorHarness({ review: { pullRequest: { url: "https://github.com/openfloor/app/pull/1" } } });
    Object.assign(actions, {
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
      reviewContributions: () => Promise.resolve({ items: [reviewContribution(false)], nextCursor: null, engineers: [], agents: [] }),
      reviewContribution: () => Promise.resolve({ contribution: reviewContribution(true) }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/review"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "src/app.ts");
    instance.stdin.write("\t"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "+ const answer = 42;");
    expect(instance.lastFrame()).toContain("wrap on");
  });

  it("stops review loading with Escape even while command bar has focus", async () => {
    const { actions, client, session, floor } = floorHarness({ review: { pullRequest: { url: "https://github.com/openfloor/app/pull/1" } } });
    let aborted = false;
    Object.assign(actions, {
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
      reviewContributions: (_id: string, _status: string, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    instance.stdin.write("/review"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Loading review contributions…");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Review loading stopped");
    expect(aborted).toBe(true);
  });

  it("pastes credentials without rendering or persisting the secret", async () => {
    const connectCredential = vi.fn().mockResolvedValue({ credential: credentialSummary("openai", "api_key") });
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }), credentials: () => Promise.resolve({ credentials: [] }), connectCredential, disconnectCredential: vi.fn() } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Type / for commands");
    instance.stdin.write("/"); await pause(); instance.stdin.write("credentials"); await pause(); instance.stdin.write("\r"); await waitForFrame(instance, "OpenAI API key");
    instance.stdin.write("\r"); await waitForFrame(instance, "Paste credential."); instance.stdin.write("sk-test-super-secret"); await pause();
    expect(instance.lastFrame()).not.toContain("sk-test-super-secret");
    instance.stdin.write("\r"); await waitForFrame(instance, "sent directly"); instance.stdin.write("\r"); await pause(80);
    expect(connectCredential).toHaveBeenCalledWith("openai", { apiKey: "sk-test-super-secret" });
    expect(instance.lastFrame()).not.toContain("sk-test-super-secret");
  });

  it("stops credential loading with Escape", async () => {
    let aborted = false;
    const actions = {
      home: () => Promise.resolve({ props: { sessions: [], usage } }),
      credentials: (signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      }),
    } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "Type / for commands");
    instance.stdin.write("/"); await pause(); instance.stdin.write("credentials"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Loading credential status…");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
    expect(aborted).toBe(true);
  });

  it("sorts live queue work above terminal results", () => {
    const { floor } = floorHarness();
    const values = [
      { ...floor.queue[0]!, id: "done", position: 0, status: "completed" },
      { ...floor.queue[0]!, id: "live", position: 3, status: "running" },
      { ...floor.queue[0]!, id: "failed", position: 1, status: "failed" },
      { ...floor.queue[0]!, id: "queued", position: 2, status: "queued" },
    ];
    expect(orderedQueue({ ...floor, queue: values }).map((item) => item.id)).toEqual(["queued", "live", "done", "failed"]);
  });

  it("clamps a scrolling pane window at both ends and skips windowing when everything fits", () => {
    expect(paneWindow(0, 10, 0)).toEqual({ start: 0, end: 0 });
    expect(paneWindow(5, 10, 3)).toEqual({ start: 0, end: 5 });
    expect(paneWindow(30, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(paneWindow(30, 10, 29)).toEqual({ start: 20, end: 30 });
    expect(paneWindow(30, 10, 15)).toEqual({ start: 10, end: 20 });
  });

  it("asks teammates before binding a matching local clone", async () => {
    const { actions, client, session, floor } = floorHarness({
      repository: { repositoryFullName: "openfloor/app", status: "ready" },
      activeCandidate: { branchName: "openfloor/demo/candidate/task-12345678", candidateSha: "a".repeat(40), remoteCandidateSha: "a".repeat(40), status: "active" },
    });
    Object.assign(actions, { repositories: () => Promise.resolve({ repositories: [{ id: "repo-1", accountInstallationId: "install-1", fullName: "openfloor/app", private: true, defaultBranch: "main" }] }), floor: () => Promise.resolve({ props: { initialFloor: floor } }) });
    const workspace = { root: "/projects/app", remoteName: "origin", remoteUrl: "git@github.com:openfloor/app.git", repositoryFullName: "openfloor/app" };
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", workspace }));
    instances.push(instance);
    await waitForFrame(instance, "Task");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Sessions");
    instance.stdin.write("\r");
    await waitForFrame(instance, "Enable local live sync?");
    expect(instance.lastFrame()).toContain(session.title);
    expect(instance.lastFrame()).toContain("openfloor/demo/candidate/task-12345678");
    expect(instance.lastFrame()).toContain("aaaaaaaaaaaa");
  });

  it("opens an archived bound workspace session directly", async () => {
    const { actions, client, session, floor } = floorHarness({
      repository: { repositoryFullName: "openfloor/app", status: "ready" },
      activeCandidate: { branchName: "openfloor/demo/candidate/task-12345678", candidateSha: "a".repeat(40), remoteCandidateSha: "a".repeat(40), status: "active" },
    });
    const archived = { ...session, archivedAt: 2 };
    Object.assign(actions, {
      home: () => Promise.resolve({ props: { sessions: [archived], usage } }),
      session: () => Promise.resolve({ props: { session: archived, initialMembers: [] } }),
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
    });
    const workspace = localWorkspace();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", workspace, initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "Prompt queue");
    expect(instance.lastFrame()).toContain("CLI floor");
    expect(instance.lastFrame()).not.toContain("New local session");
  });

  it("clears an ended binding and opens local session creation", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(tmpdir(), `openfloor-tui-${crypto.randomUUID()}`));
    const { actions, client, session, floor } = floorHarness();
    const ended = { ...session, endedAt: 2 };
    Object.assign(actions, {
      home: () => Promise.resolve({ props: { sessions: [ended], usage } }),
      session: () => Promise.resolve({ props: { session: ended, initialMembers: [] } }),
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
      repositories: () => Promise.resolve({ repositories: [repositoryOption()] }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", workspace: localWorkspace(), initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "New local session · openfloor/app");
    expect(instance.lastFrame()).toContain("Task");
  });

  it("clears a missing binding and opens local session creation", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(tmpdir(), `openfloor-tui-${crypto.randomUUID()}`));
    const { actions, client, session } = floorHarness();
    Object.assign(actions, {
      home: () => Promise.resolve({ props: { sessions: [], usage } }),
      repositories: () => Promise.resolve({ repositories: [repositoryOption()] }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", workspace: localWorkspace(), initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "New local session · openfloor/app");
    expect(instance.lastFrame()).toContain("Task");
  });

  it("clears a repository-mismatched binding and opens creation", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(tmpdir(), `openfloor-tui-${crypto.randomUUID()}`));
    const { actions, client, session, floor } = floorHarness({ repository: { repositoryFullName: "openfloor/other", status: "ready" } });
    Object.assign(actions, {
      floor: () => Promise.resolve({ props: { initialFloor: floor } }),
      repositories: () => Promise.resolve({ repositories: [repositoryOption()] }),
    });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", workspace: localWorkspace(), initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "New local session · openfloor/app");
    expect(instance.lastFrame()).toContain("repository no longer matches");
  });

  it("arms exit on Ctrl+C and only exits on a second press", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "No sessions.");
    instance.stdin.write("");
    await waitForFrame(instance, "Press Ctrl+C again to exit");
    instance.stdin.write("?");
    await waitForFrame(instance, "keyboard help");
    instance.stdin.write("");
    await waitForFrame(instance, "Sessions");
    instance.stdin.write("");
    await pause(30);
    const framesBeforeSecondPress = instance.frames.length;
    instance.stdin.write("");
    await pause(50);
    instance.stdin.write("?");
    await pause(50);
    expect(instance.frames.length).toBe(framesBeforeSecondPress);
  });

  it("recalls the previous prompt with Up and restores the in-progress draft with Down", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("first prompt"); await pause(); instance.stdin.write("\r");
    await pause(50);
    instance.stdin.write("draft two");
    await pause();
    expect(instance.lastFrame()).toContain("draft two");
    instance.stdin.write("[A");
    await waitForFrame(instance, "first prompt");
    instance.stdin.write("[B");
    await waitForFrame(instance, "draft two");
  });

  it("shows a working indicator while a background command runs", async () => {
    const { actions, client, session } = floorHarness();
    let resolveRun: () => void = () => {};
    const runCommand = vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve; }));
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id, runCommand }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("/agents"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "agents list");
    expect(instance.lastFrame()).toContain("agents list");
    resolveRun();
    await pause(80);
    expect(instance.lastFrame()).not.toContain("agents list");
    expect(instance.lastFrame()).toContain("Command completed in background.");
  });

  it("scrolls the chat pane past its fixed window to reach the oldest message", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: `message-${index}`, authorName: "Matt", recipientUserId: null, text: `chat-${index}` }));
    const { actions, client, session } = floorHarness({ messages });
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("\t");
    await waitForFrame(instance, "› Team chat");
    expect(instance.lastFrame()).toContain("more above");
    expect(instance.lastFrame()).toContain("chat-11");
    for (let index = 0; index < 11; index += 1) { instance.stdin.write("[A"); await pause(25); }
    await waitForFrame(instance, "chat-0");
    expect(instance.lastFrame()).not.toContain("more above");
    await pause(30);
    instance.stdin.write("\r");
    await waitForFrame(instance, "Team message");
    expect(instance.lastFrame()).toContain("chat-0");
  });

  it("completes an @agent mention with Tab instead of cycling panels", async () => {
    const { actions, client, session, post } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("@bu");
    await waitForFrame(instance, "@Builder");
    expect(instance.lastFrame()).toContain("Engineer · openai/default");
    instance.stdin.write("\t");
    await waitForFrame(instance, "floor › @Builder");
    expect(instance.lastFrame()).not.toContain("› Team chat");
    instance.stdin.write("ship it"); await pause(); instance.stdin.write("\r");
    await pause(80);
    expect(post).toHaveBeenCalledWith(`/api/sessions/${session.id}/queue`, { prompt: "@Builder ship it", agentId: null });
  });

  it("completes an @agent mention with Enter before it can submit a partial name", async () => {
    const { actions, client, session, post } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("@bu"); await waitForFrame(instance, "@Builder");
    instance.stdin.write("\r"); await pause(60);
    expect(post).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain("floor › @Builder");
  });

  it("clears the prompt on a double Escape, then leaves the session on the next double Escape", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("draft text");
    await waitForFrame(instance, "draft text");
    instance.stdin.write("\u001b"); await pause();
    expect(instance.lastFrame()).toContain("Press Esc again to clear the prompt.");
    expect(instance.lastFrame()).toContain("draft text");
    instance.stdin.write("\u001b"); await pause(40);
    expect(instance.lastFrame()).not.toContain("draft text");
    instance.stdin.write("\u001b"); await pause();
    expect(instance.lastFrame()).toContain("Press Esc again to return to Sessions.");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "CLI floor");
    expect(instance.lastFrame()).toContain("Sessions");
  });

  it("returns a nested session page to the floor on a double Escape", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("/overview"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Members");
    instance.stdin.write("\u001b"); await pause();
    expect(instance.lastFrame()).toContain("Press Esc again to return to the floor.");
    instance.stdin.write("\u001b");
    await waitForFrame(instance, "Prompt queue");
  });

  it("first Escape closes an open suggestion list without clearing typed text", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("/ov"); await waitForFrame(instance, "session overview");
    instance.stdin.write("\u001b"); await pause(40);
    expect(instance.lastFrame()).not.toContain("session overview");
    expect(instance.lastFrame()).toContain("floor › /ov");
  });

  it("cycles floor panels backwards with Shift+Tab", async () => {
    const { actions, client, session } = floorHarness();
    const instance = render(startTui({ actions, client, baseUrl: "http://127.0.0.1:9", initialSessionId: session.id }));
    instances.push(instance);
    await waitForFrame(instance, "floor ›");
    instance.stdin.write("[Z");
    await waitForFrame(instance, "› Prompt queue");
  });

  it("no longer exits the app on bare q (superseded by two-press Ctrl+C and Ctrl+D)", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "No sessions.");
    instance.stdin.write("q");
    await pause(50);
    expect(instance.lastFrame()).toContain("Commands start with /. Press / to open commands.");
  });

  it("archives a session from the Sessions list with a", async () => {
    const session = { id: "12345678-1234-4234-8234-1234567890ab", title: "CLI floor", objective: null, role: "owner" as const, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null };
    const home = vi.fn().mockResolvedValue({ props: { sessions: [session], usage } });
    const post = vi.fn().mockResolvedValue({});
    const actions = { home, post } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "CLI floor");
    instance.stdin.write("a");
    await waitForFrame(instance, "Session actions");
    expect(instance.lastFrame()).toContain("› Archive");
    instance.stdin.write("\r");
    await pause(80);
    expect(post).toHaveBeenCalledWith(`/api/sessions/${session.id}/archive`);
    await waitForFrame(instance, "Sessions");
    expect(home.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("delete discloses a live candidate branch and issues exactly one DELETE for the chosen resolution", async () => {
    const session = { id: "12345678-1234-4234-8234-1234567890ab", title: "CLI floor", objective: null, role: "owner" as const, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null };
    const home = vi.fn().mockResolvedValue({ props: { sessions: [session], usage } });
    const del = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new OpenFloorError("Request refused", "conflict", 409, { code: "candidate_live", branch: "openfloor/session/candidate", canDeleteBranch: true })))
      .mockImplementationOnce(() => Promise.resolve({}));
    const actions = { home, delete: del } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "CLI floor");
    instance.stdin.write("/"); await pause(); instance.stdin.write("delete"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Delete session");
    instance.stdin.write("\r");
    await waitForFrame(instance, "hasn't merged yet");
    expect(instance.lastFrame()).toContain("openfloor/session/candidate");
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenNthCalledWith(1, `/api/sessions/${session.id}`, undefined);

    instance.stdin.write("o");
    await pause(80);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenNthCalledWith(2, `/api/sessions/${session.id}`, { candidate: "orphan" });
    await waitForFrame(instance, "Sessions");
  });

  it("reports a blocking integrating run without retrying delete automatically", async () => {
    const session = { id: "12345678-1234-4234-8234-1234567890ab", title: "CLI floor", objective: null, role: "owner" as const, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null };
    const home = vi.fn().mockResolvedValue({ props: { sessions: [session], usage } });
    const del = vi.fn().mockRejectedValue(new OpenFloorError("The candidate is still being updated", "conflict", 409, { runId: "aaaaaaaa-0000-4000-8000-000000000000" }));
    const actions = { home, delete: del } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await waitForFrame(instance, "CLI floor");
    instance.stdin.write("/"); await pause(); instance.stdin.write("delete"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Delete session");
    instance.stdin.write("\r");
    await waitForFrame(instance, "still integrating");
    expect(del).toHaveBeenCalledTimes(1);
    instance.stdin.write("");
    await waitForFrame(instance, "Sessions");
    expect(del).toHaveBeenCalledTimes(1);
  });
});

function localWorkspace() { return { root: "/projects/app", remoteName: "origin", remoteUrl: "git@github.com:openfloor/app.git", repositoryFullName: "openfloor/app" }; }
function repositoryOption() { return { id: "repo-1", accountInstallationId: "install-1", fullName: "openfloor/app", private: true, defaultBranch: "main" }; }
function credentialSummary(provider: "openai", kind: "api_key") { return { provider, kind, fingerprint: "cret", validatedAt: 1, createdAt: 1, updatedAt: 1, monthSpendMicroUsd: 0, monthlyLimitMicroUsd: null, monthInputTokens: 0, monthOutputTokens: 0 }; }
function reviewContribution(withDiff: boolean) { return { runId: "run-1", queueItemId: "queue-1", agentId: "agent-1", agentName: "Builder", agentOwnerUserId: "user-1", integratedAt: 2, rollbackStatus: null, rollbackFailureReason: null, canRollback: true, prompts: [{ id: "prompt-1", authorUserId: "user-1", authorName: "Matt", text: "Build feature", createdAt: 1 }], files: [{ id: "file-1", path: "src/app.ts", changeKind: "modified", additions: 1, deletions: 0, summary: "Add answer", ...(withDiff ? { diff: [{ type: "add" as const, text: "const answer = 42;" }] } : {}) }] }; }

function floorHarness(overrides: Record<string, unknown> = {}) {
  const session = { id: "12345678-1234-4234-8234-1234567890ab", title: "CLI floor", objective: "Ship", role: "owner" as const, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null };
  const floor = {
    revision: 1, autoDispatch: true, autoProvisionAgents: true, autoResolveConflicts: true,
    agents: [{ id: "agent-1", name: "Builder", role: "Engineer", task: "Implement", ownerUserId: "user-1", ownerName: "Matt", provider: "openai", model: null, pausedAt: null, kind: null }],
    assignments: [], messages: [{ id: "message-1", authorName: "Matt", recipientUserId: null, text: "hello" }], files: [],
    queue: [{ id: "queue-1", agentId: "agent-1", agentName: "Builder", position: 0, status: "running", prompts: [{ id: "prompt-1", authorName: "Matt", text: "Fix it", createdAt: 1 }] }],
    runs: [{ id: "run-1", queueItemId: "queue-1", agentId: "agent-1", agentName: "Builder", status: "running", model: "gpt", summary: null, finalResponse: null, createdAt: 1, updatedAt: 2, checks: [], files: [] }],
    repository: null, activeCandidate: null, latestPreflight: null, review: null, ...overrides,
  };
  const post = vi.fn().mockResolvedValue({});
  const actions = {
    home: () => Promise.resolve({ props: { sessions: [session], usage } }),
    session: () => Promise.resolve({ props: { session, initialMembers: [{ id: "user-1", displayName: "Matt", role: "owner", joinedAt: 1, online: true }] } }),
    floor: () => Promise.resolve({ props: { initialFloor: floor } }), post,
  } as unknown as OpenFloorActions;
  const client = { baseUrl: "http://127.0.0.1:9", token: () => Promise.resolve(null) } as unknown as ApiClient;
  return { actions, client, session, floor, post };
}

function pause(milliseconds = 20): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForFrame(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (instance.lastFrame()?.includes(text)) { await pause(50); return; }
    await pause(10);
  }
  throw new Error(`Timed out waiting for TUI text: ${text}\nLast frame:\n${instance.lastFrame()}`);
}
