import { describe, expect, it, vi } from "vitest";
import { OpenFloorActions } from "../src/actions.js";
import type { ApiClient } from "../src/client.js";
import { credentialBody } from "../src/providers.js";

describe("account actions", () => {
  it("maps every credential kind to the server's write-only body", () => {
    expect(credentialBody("openai", "api_key", " key ")).toEqual({ apiKey: "key" });
    expect(credentialBody("anthropic", "oauth", " token ")).toEqual({ setupToken: "token" });
    expect(credentialBody("kimi", "oauth", " plan ")).toEqual({ setupToken: "plan" });
    expect(credentialBody("openai", "oauth", " {\"tokens\":{}} ")).toEqual({ authJson: "{\"tokens\":{}}" });
  });

  it("uses forms for profile/completion and JSON only for device polling", async () => {
    const request = vi.fn().mockResolvedValue({});
    const actions = new OpenFloorActions({ request } as unknown as ApiClient);
    await actions.saveOnboardingProfile({ firstName: "Matt", lastName: "Domingo", githubHandle: "matt" });
    await actions.pollGithubDevice("device-code");
    await actions.completeOnboarding({ firstName: "Matt", lastName: "Domingo", githubHandle: "matt" });
    const profile = request.mock.calls[0] as [string, { method: string; form: FormData }];
    expect(profile[0]).toBe("/api/account/onboarding");
    expect(profile[1].form.get("firstName")).toBe("Matt");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: { deviceCode: "device-code" } });
    const complete = request.mock.calls[2] as [string, { method: string; form: FormData }];
    expect(complete[1].form.get("plan")).toBe("free");
  });
});
