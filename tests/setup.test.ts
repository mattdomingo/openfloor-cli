import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { existingSetupIsReady, findExecutable, installCloudflared } from "../src/setup.js";

describe("first-run setup", () => {
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
});
