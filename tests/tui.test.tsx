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
    expect(instance.lastFrame()).toContain("Arrow keys navigate");
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
    instance.stdin.write("Test\r");
    await pause();
    instance.stdin.write("\r");
    await pause();
    instance.stdin.write("\r");
    await pause();
    if (instance.lastFrame()?.includes("Candidate branch name")) { instance.stdin.write("\r"); await pause(); }
    await waitForFrame(instance, "Select repository");
    expect(instance.lastFrame()).toContain("Select repository");
    instance.stdin.write("\u001b[B\r");
    await pause();
    expect(instance.lastFrame()).toContain("Repository: openfloor/docs");
    instance.stdin.write("\r");
    await pause(40);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ title: "Test", repositoryId: "repo-2" }));
    expect(instance.lastFrame()).toContain("Candidate branch provisioning failed.");
  });
});

function pause(milliseconds = 20): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForFrame(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (instance.lastFrame()?.includes(text)) return;
    await pause(10);
  }
  throw new Error(`Timed out waiting for TUI text: ${text}`);
}
