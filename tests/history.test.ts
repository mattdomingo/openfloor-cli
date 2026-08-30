import { describe, expect, it } from "vitest";
import { HistoryBuffer } from "../src/history.js";

describe("HistoryBuffer", () => {
  it("recalls entries oldest-first walking up, then restores the draft walking back down", () => {
    const history = new HistoryBuffer();
    history.push("first");
    history.push("second");
    expect(history.previous("draft")).toBe("second");
    expect(history.previous("draft")).toBe("first");
    expect(history.previous("draft")).toBe("first");
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("draft");
    expect(history.next()).toBeNull();
  });

  it("skips blanks and consecutive duplicates", () => {
    const history = new HistoryBuffer();
    history.push("   ");
    history.push("hello");
    history.push("hello");
    history.push("world");
    expect(history.previous("")).toBe("world");
    expect(history.previous("")).toBe("hello");
    expect(history.previous("")).toBe("hello");
  });

  it("caps at 100 entries, dropping the oldest", () => {
    const history = new HistoryBuffer();
    for (let index = 0; index < 105; index += 1) history.push(`entry-${index}`);
    let oldest: string | null = null;
    for (let index = 0; index < 100; index += 1) oldest = history.previous("");
    expect(oldest).toBe("entry-5");
  });

  it("returns null when there is no history", () => {
    const history = new HistoryBuffer();
    expect(history.previous("draft")).toBeNull();
    expect(history.next()).toBeNull();
  });
});
