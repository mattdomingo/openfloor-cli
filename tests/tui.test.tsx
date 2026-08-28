import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { startTui } from "../src/tui.js";
import type { OpenFloorActions } from "../src/actions.js";
import type { ApiClient } from "../src/client.js";

const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); });

describe("TUI", () => {
  it("renders honest home empty state", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage: { used: 0 } } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("openfloor");
    expect(instance.lastFrame()).toContain("No sessions.");
  });

  it("opens help from keyboard", async () => {
    const actions = { home: () => Promise.resolve({ props: { sessions: [], usage: {} } }) } as unknown as OpenFloorActions;
    const instance = render(startTui({ actions, client: {} as ApiClient, baseUrl: "http://127.0.0.1:8787" }));
    instances.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("?");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("Arrow keys navigate");
  });
});
