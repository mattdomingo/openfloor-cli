import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { existingSetupIsReady, findExecutable, installCloudflared, logoOrbitPositions, waitForSetupExit } from "../src/setup.js";

describe("first-run setup", () => {
  it("clears the setup renderer before returning to application startup", async () => {
    const order: string[] = [];
    await waitForSetupExit({
      waitUntilExit: async () => { order.push("exit"); },
      clear: () => { order.push("clear"); },
    });
    order.push("main");
    expect(order).toEqual(["exit", "clear", "main"]);
  });

  it("clears the setup renderer when its exit rejects", async () => {
    const clear = vi.fn();
    await expect(waitForSetupExit({ waitUntilExit: async () => { throw new Error("setup failed"); }, clear })).rejects.toThrow("setup failed");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("finds executable files only", async () => {
    const root = join(tmpdir(), `openfloor-setup-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const executable = join(root, "cloudflared");
    const plain = join(root, "plain");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(plain, "not executable", { mode: 0o600 });
    await chmod(executable, 0o700);
    expect(await findExecutable("cloudflared", { PATH: root })).toBe(executable);
    expect(await findExecutable(plain, { PATH: root })).toBeNull();
  });

  it("runs Homebrew with exact non-shell arguments", async () => {
    const root = join(tmpdir(), `openfloor-brew-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const brew = join(root, "brew");
    const log = join(root, "args.log");
    await writeFile(brew, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`, { mode: 0o700 });
    await chmod(brew, 0o700);
    await installCloudflared(brew);
    expect(await readFile(log, "utf8")).toBe("install\ncloudflared\n");
  });

  it("needs no dependency or authentication for loopback development", async () => {
    await expect(existingSetupIsReady("http://127.0.0.1:8787", "/missing/cloudflared")).resolves.toBe(true);
  });

  it("animates all three logo dots inside the splash canvas", () => {
    const first = logoOrbitPositions(0, 92);
    const next = logoOrbitPositions(1, 92);
    expect(first).toHaveLength(3);
    expect(next).not.toEqual(first);
    expect(next.every(({ x, y }) => x >= 0 && x <= 82 && y >= 0 && y <= 14)).toBe(true);
    expect(logoOrbitPositions(1, 58, true).every(({ x, y }) => x >= 0 && x <= 52 && y >= 0 && y <= 8)).toBe(true);
  });
});
