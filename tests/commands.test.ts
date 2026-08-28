import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/commands.js";
import { tokenize } from "../src/tui.js";

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
});
