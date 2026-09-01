import { Text, useInput } from "ink";
import React, { useRef, useState } from "react";

export type EditableInputProps = {
  value: string;
  onChange: (value: string, cursor: number) => void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  /** Tab while this field has focus. Used by command bars to accept a highlighted suggestion. */
  onTab?: () => void;
  placeholder?: string;
  active?: boolean;
  multiline?: boolean;
  secret?: boolean;
  /** Caret moved without changing the value (arrows, Ctrl+A/E). */
  onCursor?: (cursor: number) => void;
  /** Caret position on mount. Defaults to end of value. */
  initialCursor?: number;
};

export function deleteWordLeft(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  let start = cursor;
  while (start > 0 && /\s/.test(value[start - 1]!)) start -= 1;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1;
  return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
}

export function EditableInput({ value, onChange, onSubmit, onEscape, onUp, onDown, onTab, onCursor, placeholder = "", active = true, multiline = false, secret = false, initialCursor }: EditableInputProps): React.ReactElement {
  const start = Math.max(0, Math.min(initialCursor ?? value.length, value.length));
  const [cursor, setCursor] = useState(start);
  const valueRef = useRef(value); const cursorRef = useRef(start);

  const update = (next: string, nextCursor: number) => { valueRef.current = next; cursorRef.current = nextCursor; onChange(next, nextCursor); setCursor(nextCursor); };
  const move = (nextCursor: number) => { cursorRef.current = nextCursor; setCursor(nextCursor); onCursor?.(nextCursor); };

  useInput((input, key) => {
    const current = valueRef.current; const point = Math.min(cursorRef.current, current.length);
    if (key.escape) { onEscape?.(); return; }
    if (key.upArrow && onUp) { onUp(); return; }
    if (key.downArrow && onDown) { onDown(); return; }
    if (key.leftArrow) { move(Math.max(0, point - 1)); return; }
    if (key.rightArrow) { move(Math.min(current.length, point + 1)); return; }
    if (key.return && !(multiline && key.ctrl)) {
      const typed = input.replace(/[\r\n]/g, "");
      if (typed) { const next = current.slice(0, point) + typed + current.slice(point); update(next, point + typed.length); onSubmit?.(next); }
      else onSubmit?.(current);
      return;
    }
    if (multiline && key.ctrl && (input === "j" || key.return)) {
      const next = current.slice(0, point) + "\n" + current.slice(point);
      update(next, point + 1); return;
    }
    if (key.backspace || key.delete) {
      if (key.meta) {
        const next = deleteWordLeft(current, point);
        update(next.value, next.cursor); return;
      }
      if (point > 0) update(current.slice(0, point - 1) + current.slice(point), point - 1);
      return;
    }
    if (key.ctrl && input === "a") { move(0); return; }
    if (key.ctrl && input === "e") { move(current.length); return; }
    if (key.ctrl && input === "u") { update(current.slice(point), 0); return; }
    if (key.ctrl && input === "w") { const next = deleteWordLeft(current, point); update(next.value, next.cursor); return; }
    if (key.tab) { if (!key.shift) onTab?.(); return; }
    if (key.ctrl || key.meta || !input) return;
    const safe = multiline ? input.replace(/\r\n?/g, "\n") : input.replace(/[\r\n]/g, "");
    if (!safe) return;
    update(current.slice(0, point) + safe + current.slice(point), point + safe.length);
  }, { isActive: active });

  if (secret) return <Text>{value ? "••••••••" : <Text dimColor>{placeholder}</Text>}{active && <Text inverse> </Text>}</Text>;
  if (!value) return <Text>{active ? <Text inverse> </Text> : null}<Text dimColor>{placeholder}</Text></Text>;
  const display = multiline ? value.replace(/\n/g, "↵") : value;
  const point = Math.min(cursor, display.length);
  return <Text>{display.slice(0, point)}{active ? <Text inverse>{display[point] ?? " "}</Text> : display[point] ?? ""}{display.slice(point + (display[point] ? 1 : 0))}</Text>;
}
