import { OpenFloorError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveId<T extends { id: string }>(input: string, values: T[], label: string): string {
  const value = input.trim().toLowerCase();
  if (UUID.test(value)) return value;
  if (value.length < 8 || !/^[0-9a-f-]+$/.test(value)) throw new OpenFloorError(`${label} ID prefix must contain at least eight hexadecimal characters`, "usage");
  const matches = values.filter((item) => item.id.toLowerCase().startsWith(value));
  if (matches.length === 0) throw new OpenFloorError(`${label} not found`, "not_found", 404);
  if (matches.length > 1) throw new OpenFloorError(`${label} prefix is ambiguous`, "usage");
  return matches[0]!.id;
}

export function shortId(id: string): string { return id.slice(0, 8); }
