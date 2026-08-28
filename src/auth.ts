import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { OpenFloorError } from "./errors.js";
import { authHomePath, clearIdentityConfig, configPath, isLoopback } from "./config.js";
import { redact } from "./sanitize.js";

const execFile = promisify(execFileCallback);

export type AuthOptions = {
  baseUrl: string;
  cloudflaredPath?: string;
  debug?: boolean;
  authHome?: string;
};

export function accessAppUrl(baseUrl: string): string {
  return `${baseUrl}/api/bootstrap/me`;
}

async function cloudflaredEnvironment(authHome: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(authHome, { recursive: true, mode: 0o700 });
  await chmod(authHome, 0o700);
  return { ...process.env, HOME: authHome };
}

export async function accessToken(options: AuthOptions, login = false): Promise<string | null> {
  if (isLoopback(options.baseUrl)) return null;
  const binary = options.cloudflaredPath || process.env.OPENFLOOR_CLOUDFLARED || "cloudflared";
  const environment = await cloudflaredEnvironment(options.authHome ?? authHomePath());
  try {
    if (login) {
      const result = await execFile(binary, ["access", "login", "--no-verbose", "--app", accessAppUrl(options.baseUrl)], { encoding: "utf8", maxBuffer: 1024 * 1024, env: environment });
      if (options.debug && result.stderr.trim()) process.stderr.write(`${redact(result.stderr.trim())}\n`);
    }
    const { stdout, stderr } = await execFile(binary, ["access", "token", "--app", accessAppUrl(options.baseUrl)], { encoding: "utf8", maxBuffer: 1024 * 1024, env: environment });
    const token = stdout.trim();
    if (!token || token.split(".").length !== 3) throw new OpenFloorError("cloudflared returned no valid Access token", "authentication");
    if (options.debug && stderr.trim()) process.stderr.write(`${redact(stderr.trim())}\n`);
    return token;
  } catch (error: any) {
    if (error instanceof OpenFloorError) throw error;
    if (error?.code === "ENOENT") {
      throw new OpenFloorError(`cloudflared was not found (${binary}). Install current stable cloudflared or set OPENFLOOR_CLOUDFLARED.`, "authentication");
    }
    const detail = redact(String(error?.stderr || error?.message || error));
    const guidance = login ? "Cloudflare Access login failed" : "No cached Cloudflare Access token. Run `openfloor auth login`.";
    throw new OpenFloorError(`${guidance}${detail ? `: ${detail}` : ""}`, "authentication");
  }
}

export async function logoutAccess(options: { configFile?: string; authHome?: string } = {}): Promise<void> {
  const configFile = options.configFile ?? configPath();
  await rm(options.authHome ?? authHomePath(configFile), { recursive: true, force: true });
  await clearIdentityConfig(configFile);
}
