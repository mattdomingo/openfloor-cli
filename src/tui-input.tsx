import { Text, useInput } from "ink";
import React, { useRef, useState } from "react";

export type EditableInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  placeholder?: string;
  active?: boolean;
  multiline?: boolean;
  secret?: boolean;
};

export function deleteWordLeft(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  let start = cursor;
  while (start > 0 && /\s/.test(value[start - 1]!)) start -= 1;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1;
  return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
}

export function EditableInput({ value, onChange, onSubmit, onEscape, onUp, onDown, placeholder = "", active = true, multiline = false, secret = false }: EditableInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);
  const valueRef = useRef(value); const cursorRef = useRef(value.length);

  const update = (next: string, nextCursor: number) => { valueRef.current = next; cursorRef.current = nextCursor; onChange(next); setCursor(nextCursor); };

  useInput((input, key) => {
    const current = valueRef.current; const point = Math.min(cursorRef.current, current.length);
    if (key.escape) { onEscape?.(); return; }
    if (key.upArrow && onUp) { onUp(); return; }
    if (key.downArrow && onDown) { onDown(); return; }
    if (key.leftArrow) { cursorRef.current = Math.max(0, point - 1); setCursor(cursorRef.current); return; }
    if (key.rightArrow) { cursorRef.current = Math.min(current.length, point + 1); setCursor(cursorRef.current); return; }
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
    if (key.ctrl && input === "a") { cursorRef.current = 0; setCursor(0); return; }
    if (key.ctrl && input === "e") { cursorRef.current = current.length; setCursor(current.length); return; }
    if (key.ctrl && input === "u") { update(current.slice(point), 0); return; }
    if (key.ctrl && input === "w") { const next = deleteWordLeft(current, point); update(next.value, next.cursor); return; }
    if (key.tab || key.ctrl || key.meta || !input) return;
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
