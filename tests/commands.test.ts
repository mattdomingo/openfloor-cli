import { describe, expect, it } from "vitest";
import { buildProgram, candidateLiveHint, chooseRepository } from "../src/commands.js";
import { OpenFloorError } from "../src/errors.js";
import { formatDuration, tokenize } from "../src/tui.js";

const repositories = [
  { id: "123456789", accountInstallationId: "install-a", fullName: "openfloor/app", private: true, defaultBranch: "main" },
  { id: "987654321", accountInstallationId: "install-b", fullName: "openfloor/docs", private: false, defaultBranch: "trunk" },
];

describe("public command surface", () => {
  it("registers every documented top-level group", () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining([
      "auth", "doctor", "config", "sessions", "invite", "members", "agents", "assignments", "routing",
      "queue", "chat", "files", "runs", "conflicts", "repository", "skills", "mcp", "review", "web",
    ]));
  });

  it("tokenizes palette commands without shell evaluation", () => {
    expect(tokenize('queue add "fix two words" --agent abcdef12')).toEqual(["queue", "add", "fix two words", "--agent", "abcdef12"]);
    expect(tokenize("chat send 'hello world'")).toEqual(["chat", "send", "hello world"]);
    expect(() => tokenize("queue add 'open")).toThrow(/Unclosed quote/);
  });

  it("selects one repository by default or many by explicit name, ID, and installation", async () => {
    await expect(chooseRepository(repositories.slice(0, 1), undefined, undefined)).resolves.toEqual(repositories[0]);
    await expect(chooseRepository(repositories, "openfloor/docs", undefined)).resolves.toEqual(repositories[1]);
    await expect(chooseRepository(repositories, "12345678", undefined)).resolves.toEqual(repositories[0]);
    await expect(chooseRepository(repositories, undefined, "install-b")).resolves.toEqual(repositories[1]);
  });

  it("refuses zero or ambiguous noninteractive repository choices", async () => {
    await expect(chooseRepository([], undefined, undefined)).rejects.toThrow(/No account-authorized repositories/);
    await expect(chooseRepository(repositories, undefined, undefined)).rejects.toThrow(/pass --repository/);
    await expect(chooseRepository([...repositories, { ...repositories[0]!, accountInstallationId: "install-c" }], "openfloor/app", undefined)).rejects.toThrow(/ambiguous/);
  });

  it("formats usage duration for people", () => {
    expect(formatDuration(2_707)).toBe("45m 7s");
    expect(formatDuration(7_200)).toBe("2h");
    expect(formatDuration(0)).toBe("0s");
  });

  it("hints --candidate on a blocked sessions delete", () => {
    const blocked = new OpenFloorError("Request refused", "conflict", 409, { code: "candidate_live", branch: "openfloor/session/candidate", canDeleteBranch: true });
    const hinted = candidateLiveHint(blocked);
    expect(hinted).toBeInstanceOf(OpenFloorError);
    expect((hinted as OpenFloorError).message).toContain("--candidate delete-branch or --candidate orphan");
    expect((hinted as OpenFloorError).message).toContain("openfloor/session/candidate");

    const unrelated = new OpenFloorError("Only the owner can delete this session", "conflict", 403);
    expect(candidateLiveHint(unrelated)).toBe(unrelated);
  });
});
