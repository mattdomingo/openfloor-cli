import Table from "cli-table3";
import { OpenFloorError } from "./errors.js";
import { sanitizeDeep } from "./sanitize.js";

export type OutputOptions = { json?: boolean; quiet?: boolean; color?: boolean };

export function writeResult(data: unknown, options: OutputOptions = {}): void {
  if (options.quiet) return;
  const clean = sanitizeDeep(data);
  if (options.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, data: clean })}\n`);
  else if (Array.isArray(clean)) writeTable(clean);
  else process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
}

export function writeError(error: unknown, options: OutputOptions = {}): void {
  const value = error instanceof OpenFloorError ? error : new OpenFloorError(error instanceof Error ? error.message : String(error), "unavailable");
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: value.code, message: value.message, ...(value.status ? { status: value.status } : {}) } })}\n`);
  } else process.stderr.write(`Error: ${value.message}\n`);
}

function writeTable(rows: unknown[]): void {
  if (rows.length === 0) { process.stdout.write("No results.\n"); return; }
  const objects = rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  if (objects.length !== rows.length) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  const keys = [...new Set(objects.flatMap(Object.keys))].slice(0, 8);
  const table = new Table({ head: keys });
  for (const row of objects) table.push(keys.map((key) => cell(row[key])));
  process.stdout.write(`${table.toString()}\n`);
}

function cell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || typeof value === "symbol") return String(value);
  return "";
}
