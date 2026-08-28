import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTui } from "../src/tui.js";
import type { OpenFloorActions } from "../src/actions.js";
import type { ApiClient } from "../src/client.js";

const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); });
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

  it("opens help from keyboard", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("Home: arrows select");
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
    expect(instance.lastFrame()).toContain("Agent floor");
    expect(instance.lastFrame()).toContain("floor ›");

    instance.stdin.write("\t");
    await waitForFrame(instance, "› Team chat");
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
    await waitForFrame(instance, "/overview");
    expect(instance.lastFrame()).toContain("Members");

    instance.stdin.write("/commands"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "/sync");

    instance.stdin.write("/sessions"); await pause(); instance.stdin.write("\r");
    await waitForFrame(instance, "Sessions");
    expect(instance.lastFrame()).toContain("CLI floor");
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
});

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
  const actions = {
    home: () => Promise.resolve({ props: { sessions: [session], usage } }),
    session: () => Promise.resolve({ props: { session, initialMembers: [{ id: "user-1", displayName: "Matt", role: "owner", joinedAt: 1, online: true }] } }),
    floor: () => Promise.resolve({ props: { initialFloor: floor } }), post: vi.fn().mockResolvedValue({}),
  } as unknown as OpenFloorActions;
  const client = { baseUrl: "http://127.0.0.1:9", token: () => Promise.resolve(null) } as unknown as ApiClient;
  return { actions, client, session, floor };
}

function pause(milliseconds = 20): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForFrame(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (instance.lastFrame()?.includes(text)) { await pause(50); return; }
    await pause(10);
  }
  throw new Error(`Timed out waiting for TUI text: ${text}`);
}
