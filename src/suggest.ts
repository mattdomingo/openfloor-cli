/** Text matching shared by the slash-command menus and the @agent mention menu. Pure; no I/O. */

export type CommandSpec = { name: string; description: string };
export type MentionToken = { start: number; end: number; query: string };

/** True when every character of `needle` appears in order inside `haystack`. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) { if (char === needle[index]) index += 1; if (index === needle.length) return true; }
  return needle.length === 0;
}

/** Prefix matches first, then fuzzy subsequence matches, both case-insensitive. */
export function rankNames(names: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  if (!needle) return [...names];
  const prefix = names.filter((name) => name.toLowerCase().startsWith(needle));
  const fuzzy = names.filter((name) => !prefix.includes(name) && isSubsequence(needle, name.toLowerCase()));
  return [...prefix, ...fuzzy];
}

/** Suggestions for the leading `/token` of a command bar value. */
export function commandSuggestions(commands: readonly CommandSpec[], value: string): CommandSpec[] {
  const token = (value.split(/\s/, 1)[0] || "/").toLowerCase();
  if (token === "/") return [...commands];
  const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(token));
  const needle = token.slice(1);
  const fuzzy = commands.filter((command) => !prefix.includes(command) && needle && isSubsequence(needle, command.name.slice(1).toLowerCase()));
  return [...prefix, ...fuzzy];
}

/**
 * Finds the `@mention` the caret sits inside, if any. The `@` must open a word, and the query
 * stops at whitespace, so `hi @bui` completes while `matt@example.com` never does.
 */
export function mentionAt(value: string, cursor: number): MentionToken | null {
  const point = Math.max(0, Math.min(cursor, value.length));
  let start = point;
  while (start > 0 && !/[\s@]/.test(value[start - 1]!)) start -= 1;
  if (start === 0 || value[start - 1] !== "@") return null;
  const at = start - 1;
  if (at > 0 && !/\s/.test(value[at - 1]!)) return null;
  return { start: at, end: point, query: value.slice(start, point) };
}

/**
 * Replaces a mention token with the chosen name and leaves the caret one space past it, reusing a
 * space that already follows the token rather than doubling it.
 */
export function applyMention(value: string, token: MentionToken, name: string): { value: string; cursor: number } {
  const spaced = /\s/.test(value[token.end] ?? "");
  const inserted = spaced ? `@${name}` : `@${name} `;
  return { value: value.slice(0, token.start) + inserted + value.slice(token.end), cursor: token.start + inserted.length + (spaced ? 1 : 0) };
}
