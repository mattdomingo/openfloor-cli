import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { accessAppUrl, accessToken } from "../src/auth.js";

async function fakeCloudflared(): Promise<{ binary: string; log: string }> {
  const root = join(tmpdir(), `openfloor-auth-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const binary = join(root, "cloudflared");
  const log = join(root, "args.log");
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$2" = "login" ]; then exit 0; fi\nprintf 'eyJheader.eyJbody.signature\\n'\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, log };
}

describe("cloudflared authentication", () => {
  it("uses exact login then token commands without persisting JWT", async () => {
    const fake = await fakeCloudflared();
    await expect(accessToken({ baseUrl: "https://app.opnflr.com", cloudflaredPath: fake.binary }, true)).resolves.toBe("eyJheader.eyJbody.signature");
    const calls = await import("node:fs/promises").then(({ readFile }) => readFile(fake.log, "utf8"));
    expect(calls).toContain("access login --no-verbose --app https://app.opnflr.com/api/bootstrap/me");
    expect(calls).toContain("access token --app https://app.opnflr.com/api/bootstrap/me");
    expect(calls).not.toContain("eyJheader");
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
});
