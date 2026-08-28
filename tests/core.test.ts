import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { configPath, readConfig, validateBaseUrl, writeConfig } from "../src/config.js";
import { bootstrapMeSchema } from "../src/contracts.js";
import { OpenFloorError, apiError, exitCodeFor } from "../src/errors.js";
import { resolveId } from "../src/id.js";
import { redact, sanitizeTerminal } from "../src/sanitize.js";

describe("trust-boundary helpers", () => {
  it("removes ANSI and unsafe controls while preserving layout", () => {
    expect(sanitizeTerminal("\u001b[31mred\u001b[0m\u0000\r\nnext\tcell")).toBe("red\nnext\tcell");
  });

  it("redacts Access headers and JWT-shaped values", () => {
    const input = "cf-access-token: secret CF_Authorization=secret eyJabc.def.ghi";
    expect(redact(input)).not.toContain("secret");
    expect(redact(input)).not.toContain("eyJabc.def.ghi");
  });

  it("accepts additive API fields and rejects missing required fields", () => {
    const valid = { user: { id: "u", email: "a@example.com", displayName: "A", onboardedAt: 1, future: true }, onboarded: true, future: {} };
    expect(bootstrapMeSchema.parse(valid).future).toEqual({});
    expect(() => bootstrapMeSchema.parse({ user: { id: "u" }, onboarded: true })).toThrow();
  });

  it("resolves full UUIDs and unique prefixes only", () => {
    const values = [
      { id: "12345678-1234-4234-8234-1234567890ab" },
      { id: "abcdef12-1234-4234-8234-1234567890ab" },
    ];
    expect(resolveId("12345678", values, "Run")).toBe(values[0]!.id);
    expect(() => resolveId("1234", values, "Run")).toThrow(/at least eight/);
    expect(() => resolveId("deadbeef", values, "Run")).toThrow(/not found/);
  });

  it("maps stable exit codes", () => {
    expect(exitCodeFor(new OpenFloorError("bad", "usage"))).toBe(2);
    expect(exitCodeFor(apiError(401, "auth"))).toBe(3);
    expect(exitCodeFor(apiError(404, "missing"))).toBe(4);
    expect(exitCodeFor(apiError(409, "stale"))).toBe(5);
    expect(exitCodeFor(apiError(503, "down"))).toBe(6);
  });
});

describe("config", () => {
  it("uses platform config location", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/tmp/example" })).toBe("/tmp/example/openfloor/config.json");
  });

  it("writes owner-only config atomically", async () => {
    const root = join(tmpdir(), `openfloor-config-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, "nested", "config.json");
    await writeConfig({ currentSessionId: "12345678-1234-4234-8234-1234567890ab", color: false }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readConfig(path)).toEqual({ currentSessionId: "12345678-1234-4234-8234-1234567890ab", color: false });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("token");
  });

  it("permits HTTP only for loopback", () => {
    expect(validateBaseUrl("http://127.0.0.1:8787/path")).toBe("http://127.0.0.1:8787");
    expect(() => validateBaseUrl("http://example.com")).toThrow(/HTTPS/);
  });
});
