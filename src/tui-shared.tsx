import { Box, Text } from "ink";
import React, { useRef } from "react";
import { sanitizeTerminal } from "./sanitize.js";
import { accentFor, BRAND, FOCUS, IDLE } from "./theme.js";

/** Border props for any surface that can hold keyboard focus. */
export function focusFrame(active: boolean) {
  const borderStyle: "double" | "round" = active ? "double" : "round";
  return { borderStyle, borderColor: active ? FOCUS : IDLE };
}

/** Text props for the selected row of a list, dimmed while its panel is unfocused. */
export function rowStyle(selected: boolean, active = true) {
  if (!selected) return {};
  return active ? { inverse: true, color: FOCUS } : { color: IDLE as string };
}

/** A bordered surface. Focused surfaces take the focus colour; unfocused keep their own accent title. */
export function Panel({ title, accent, active = false, width, minHeight, children }: { title: string; accent?: string; active?: boolean; width?: number | `${number}%`; minHeight?: number; children: React.ReactNode }) {
  return <Box flexDirection="column" {...(width ? { width } : {})} {...(minHeight ? { minHeight } : {})} {...focusFrame(active)} paddingX={1}>
    <Text bold color={active ? FOCUS : accent ?? BRAND}>{active ? "› " : ""}{title}</Text>
    {children}
  </Box>;
}

/** A full-page surface: modal wizards, confirmations, and non-floor pages. */
export function PageFrame({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return <Panel title={title} accent={accent ?? accentFor(title)} minHeight={22} width="100%">{children}</Panel>;
}

export function ChoiceList({ title, values, selected }: { title: string; values: readonly string[]; selected: number }) {
  return <><Text bold color={BRAND}>{title}</Text>{values.map((value, index) => <Text key={value} {...rowStyle(index === selected)}>{index === selected ? "›" : " "} {value}</Text>)}<Text dimColor>↑↓ select · Enter continue · Esc back</Text></>;
}

/** One row of a suggestion menu: the token to insert plus what it does. */
export type Suggestion = { name: string; description: string };

export function SuggestionList({ items, selected, hint }: { items: readonly Suggestion[]; selected: number; hint?: string }) {
  const start = Math.max(0, Math.min(selected - 4, Math.max(0, items.length - 9)));
  return <Box flexDirection="column" paddingX={1}>
    {items.slice(start, start + 9).map((item, visibleIndex) => { const index = start + visibleIndex; return <Text key={item.name} {...rowStyle(index === selected)}>{index === selected ? "›" : " "} {item.name.padEnd(16)} <Text dimColor>{item.description}</Text></Text>; })}
    {hint && <Text dimColor>{hint}</Text>}
  </Box>;
}

/**
 * Two-press Escape. The first press arms and reports intent; a second press within the window
 * commits. Arming expires so a stray Escape never silently primes a later navigation.
 */
export function useEscapeGesture(windowMilliseconds = 1_000): (onArm: () => void, onCommit: () => void) => void {
  const armedAt = useRef(0);
  return (onArm, onCommit) => {
    const now = Date.now();
    if (now - armedAt.current <= windowMilliseconds) { armedAt.current = 0; onCommit(); return; }
    armedAt.current = now;
    onArm();
  };
}

export function errorMessage(reason: unknown): string { return sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240); }
