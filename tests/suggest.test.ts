import { describe, expect, it } from "vitest";
import { applyMention, commandSuggestions, mentionAt, rankNames } from "../src/suggest.js";

describe("suggestion matching", () => {
  it("finds an @mention only where one opens a word", () => {
    expect(mentionAt("@bui", 4)).toEqual({ start: 0, end: 4, query: "bui" });
    expect(mentionAt("ship it @bui", 12)).toEqual({ start: 8, end: 12, query: "bui" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("matt@example", 12)).toBeNull();
    expect(mentionAt("@builder ship", 13)).toBeNull();
    expect(mentionAt("plain text", 10)).toBeNull();
  });

  it("keeps the caret inside the token it is editing", () => {
    expect(mentionAt("@builder ship", 5)).toEqual({ start: 0, end: 5, query: "buil" });
  });

  it("ranks prefix matches ahead of fuzzy matches", () => {
    expect(rankNames(["Builder", "Reviewer", "Bundler"], "bu")).toEqual(["Builder", "Bundler"]);
    expect(rankNames(["Builder", "Reviewer"], "rvw")).toEqual(["Reviewer"]);
    expect(rankNames(["Builder", "Reviewer"], "")).toEqual(["Builder", "Reviewer"]);
  });

  it("replaces the mention token and leaves the caret after the trailing space", () => {
    expect(applyMention("@bui", { start: 0, end: 4, query: "bui" }, "Builder")).toEqual({ value: "@Builder ", cursor: 9 });
    expect(applyMention("ship @bui now", { start: 5, end: 9, query: "bui" }, "Builder")).toEqual({ value: "ship @Builder now", cursor: 14 });
  });

  it("still ranks slash commands by prefix then subsequence", () => {
    const commands = [{ name: "/delete", description: "" }, { name: "/floor", description: "" }];
    expect(commandSuggestions(commands, "/dlt").map((command) => command.name)).toEqual(["/delete"]);
    expect(commandSuggestions(commands, "/").length).toBe(2);
  });
});
