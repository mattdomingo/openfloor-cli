const ANSI_PATTERN = new RegExp(`[${String.fromCharCode(27)}${String.fromCharCode(155)}][[\\]\\()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?${String.fromCharCode(7)})|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`, "g");

export function sanitizeTerminal(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/[^\P{C}\n\t]/gu, "")
    .replace(/\r\n?/g, "\n");
}

export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeTerminal(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeDeep(entry)])) as T;
  }
  return value;
}

export function redact(value: string): string {
  return value
    .replace(/cf-access-token\s*[:=]\s*\S+/gi, "cf-access-token: [redacted]")
    .replace(/CF_Authorization\s*=\s*[^;\s]+/gi, "CF_Authorization=[redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted-jwt]");
}
