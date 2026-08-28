import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { OpenFloorError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://app.opnflr.com";
export const CURRENT_SETUP_VERSION = 1;

const configSchema = z.object({
  baseUrl: z.string().url().optional(),
  currentSessionId: z.string().uuid().optional(),
  color: z.boolean().optional(),
  setupVersion: z.literal(CURRENT_SETUP_VERSION).optional(),
  workspaceSessions: z.record(z.string(), z.string().uuid()).optional(),
}).strict();

export type CliConfig = z.infer<typeof configSchema>;

export function configPath(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "openfloor", "config.json");
}

export async function readConfig(path = configPath()): Promise<CliConfig> {
  try {
    return configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new OpenFloorError(`Invalid config file: ${path}`, "usage", undefined, error);
    }
    throw error;
  }
}

export async function writeConfig(config: CliConfig, path = configPath()): Promise<void> {
  const parsed = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function updateConfig(patch: Partial<CliConfig>, path = configPath()): Promise<CliConfig> {
  const next = { ...(await readConfig(path)), ...patch };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete (next as any)[key];
  await writeConfig(next, path);
  return next;
}

export async function bindWorkspaceSession(root: string, sessionId: string, path = configPath()): Promise<CliConfig> {
  const current = await readConfig(path);
  return updateConfig({ workspaceSessions: { ...current.workspaceSessions, [root]: sessionId } }, path);
}

export async function unbindWorkspaceSession(root: string, path = configPath()): Promise<CliConfig> {
  const current = await readConfig(path);
  const workspaceSessions = { ...current.workspaceSessions };
  delete workspaceSessions[root];
  return updateConfig({ workspaceSessions: Object.keys(workspaceSessions).length ? workspaceSessions : undefined }, path);
}

export function validateBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new OpenFloorError("Base URL must be a valid URL", "usage"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new OpenFloorError("Base URL must use HTTPS; HTTP is allowed only for loopback development", "usage");
  }
  if (url.username || url.password || url.search || url.hash) throw new OpenFloorError("Base URL cannot contain credentials, query, or fragment", "usage");
  return url.origin;
}

export function isLoopback(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
