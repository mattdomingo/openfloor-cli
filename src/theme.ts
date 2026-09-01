/**
 * Terminal colour tokens.
 *
 * Structure and meaning are deliberately separate palettes: focus/idle describe where the
 * keyboard is, status/notice describe what the server said. Nothing shares a colour across the
 * two, so a focused panel never reads as a warning and a warning never reads as focus.
 */

/** Border, title, and selected-row colour of whatever currently takes keystrokes. */
export const FOCUS = "magentaBright";
/** Chrome that is present but not taking keystrokes. */
export const IDLE = "gray";
/** openfloor wordmark. */
export const BRAND = "cyan";

/** Per-surface accent, used for a panel's title while it is not focused. */
export const ACCENT = {
  sessions: "blueBright",
  chat: "blue",
  drafts: "cyan",
  agents: "greenBright",
  queue: "yellowBright",
  floor: "greenBright",
  overview: "blueBright",
  review: "greenBright",
  settings: "yellowBright",
  help: "cyan",
  credentials: "magenta",
  create: "greenBright",
  workspace: "yellowBright",
  danger: "red",
} as const;

export type Accent = (typeof ACCENT)[keyof typeof ACCENT];

/** Accent for a named surface, falling back to the brand colour for unnamed pages. */
export function accentFor(name: string): string {
  return (ACCENT as Record<string, string>)[name] ?? BRAND;
}

/** Colour for a server-reported run, queue, or repository status. */
export function statusColor(status: string): string {
  if (["completed", "integrated", "ready", "passed"].includes(status)) return "green";
  if (["failed", "cancelled", "conflicted"].includes(status)) return "red";
  if (["running", "publishing", "integrating"].includes(status)) return "cyan";
  if (["paused", "queued", "pending", "awaiting_input"].includes(status)) return "yellow";
  return "white";
}

/** Colour for a transient notice tone. */
export function noticeColor(tone: "info" | "success" | "warn" | "error"): string {
  return tone === "success" ? "green" : tone === "warn" ? "yellow" : tone === "error" ? "red" : BRAND;
}
