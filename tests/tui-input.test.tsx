import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { deleteWordLeft, EditableInput } from "../src/tui-input.js";

const instances: Array<ReturnType<typeof render>> = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); });

describe("editable TUI input", () => {
  it("deletes the preceding word without deleting earlier text", () => {
    expect(deleteWordLeft("alpha beta", 10)).toEqual({ value: "alpha ", cursor: 6 });
    expect(deleteWordLeft("alpha beta   ", 13)).toEqual({ value: "alpha ", cursor: 6 });
  });

  it("handles the terminal Option+Backspace sequence", async () => {
    function Harness() { const [value, setValue] = useState(""); return <><EditableInput value={value} onChange={setValue} /><Text>value:{value}</Text></>; }
    const instance = render(<Harness />); instances.push(instance);
    instance.stdin.write("alpha beta"); await pause();
    instance.stdin.write("\u001b\u007f"); await pause();
    expect(instance.lastFrame()).toContain("value:alpha");
    expect(deleteWordLeft("alpha beta", 10).value).toBe("alpha ");
  });

  it("supports readline-style ctrl chords: A/E jump, U kills to line start, W deletes a word", async () => {
    function Harness() { const [value, setValue] = useState(""); return <><EditableInput value={value} onChange={setValue} /><Text>value:{value}|</Text></>; }
    const instance = render(<Harness />); instances.push(instance);
    instance.stdin.write("alpha beta"); await pause();
    instance.stdin.write(""); await pause(); // Ctrl+A -> cursor to start
    instance.stdin.write("X"); await pause();
    expect(instance.lastFrame()).toContain("value:Xalpha beta|");
    instance.stdin.write(""); await pause(); // Ctrl+E -> cursor to end
    instance.stdin.write("Y"); await pause();
    expect(instance.lastFrame()).toContain("value:Xalpha betaY|");
    instance.stdin.write(""); await pause(); // Ctrl+W -> delete word left of cursor (end)
    expect(instance.lastFrame()).toContain("value:Xalpha |");
    instance.stdin.write(""); await pause(); // Ctrl+A -> back to start
    instance.stdin.write(""); await pause(); // Ctrl+U at start is a no-op
    expect(instance.lastFrame()).toContain("value:Xalpha |");
    instance.stdin.write(""); await pause(); // Ctrl+E -> cursor back to end
    instance.stdin.write(""); await pause(); // Ctrl+U -> kill from end to line start
    expect(instance.lastFrame()).toContain("value:|");
  });

  it("never renders secret contents", async () => {
    function Harness() { const [value, setValue] = useState(""); return <EditableInput value={value} onChange={setValue} secret />; }
    const instance = render(<Harness />); instances.push(instance);
    instance.stdin.write("highly-secret"); await pause();
    expect(instance.lastFrame()).toContain("••••••••");
    expect(instance.lastFrame()).not.toContain("highly-secret");
  });
});

function pause(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 20)); }
