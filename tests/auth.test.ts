import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { accessAppUrl, accessToken, logoutAccess } from "../src/auth.js";
import { readConfig, writeConfig } from "../src/config.js";

async function fakeCloudflared(): Promise<{ binary: string; log: string; homeLog: string }> {
  const root = join(tmpdir(), `openfloor-auth-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binary = join(root, "cloudflared");
  const log = join(root, "args.log");
  const homeLog = join(root, "home.log");
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf '%s\\n' "$HOME" >> "${homeLog}"\nif [ "$2" = "login" ]; then exit 0; fi\nprintf 'eyJheader.eyJbody.signature\\n'\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, log, homeLog };
}

describe("cloudflared authentication", () => {
  it("uses exact login then token commands without persisting JWT", async () => {
    const fake = await fakeCloudflared();
    const authHome = join(tmpdir(), `openfloor-access-home-${crypto.randomUUID()}`);
    await expect(accessToken({ baseUrl: "https://app.opnflr.com", cloudflaredPath: fake.binary, authHome }, true)).resolves.toBe("eyJheader.eyJbody.signature");
    const calls = await readFile(fake.log, "utf8");
    expect(calls).toContain("access login --no-verbose --app https://app.opnflr.com/api/bootstrap/me");
    expect(calls).toContain("access token --app https://app.opnflr.com/api/bootstrap/me");
    expect(calls).not.toContain("eyJheader");
    expect((await readFile(fake.homeLog, "utf8")).trim().split("\n")).toEqual([authHome, authHome]);
    expect((await stat(authHome)).mode & 0o777).toBe(0o700);
  });

  it("bypasses cloudflared for loopback", async () => {
    await expect(accessToken({ baseUrl: "http://127.0.0.1:8787", cloudflaredPath: "/missing" })).resolves.toBeNull();
  });

  it("reports missing cloudflared without leaking process output", async () => {
    await expect(accessToken({ baseUrl: "https://app.opnflr.com", cloudflaredPath: "/definitely/missing/cloudflared" })).rejects.toMatchObject({ code: "authentication" });
  });

  it("builds bootstrap audience URL", () => {
    expect(accessAppUrl("https://app.opnflr.com")).toBe("https://app.opnflr.com/api/bootstrap/me");
  });

  it("logs out only the isolated cache and clears identity-bound config", async () => {
    const root = join(tmpdir(), `openfloor-logout-${crypto.randomUUID()}`);
    const configFile = join(root, "config.json");
    const authHome = join(root, "cloudflared-home");
    const shared = join(root, "shared-cloudflared");
    await mkdir(authHome, { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeFile(join(authHome, "token"), "secret");
    await writeFile(join(shared, "token"), "keep");
    await writeConfig({
      baseUrl: "https://example.com",
      color: false,
      currentSessionId: "11111111-1111-4111-8111-111111111111",
      setupVersion: 1,
      workspaceSessions: { "/repo": "22222222-2222-4222-8222-222222222222" },
    }, configFile);

    await logoutAccess({ configFile, authHome });

    await expect(stat(authHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(shared, "token"), "utf8")).toBe("keep");
    expect(await readConfig(configFile)).toEqual({ baseUrl: "https://example.com", color: false });
  });
});
