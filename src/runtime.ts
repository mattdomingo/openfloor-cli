import { ApiClient } from "./client.js";
import { DEFAULT_BASE_URL, readConfig, validateBaseUrl } from "./config.js";
import { OpenFloorError } from "./errors.js";

export type GlobalOptions = {
  session?: string;
  baseUrl?: string;
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
  debug?: boolean;
  yes?: boolean;
};

export async function createRuntime(options: GlobalOptions) {
  const config = await readConfig();
  const baseUrl = validateBaseUrl(options.baseUrl || process.env.OPENFLOOR_BASE_URL || config.baseUrl || DEFAULT_BASE_URL);
  const client = new ApiClient(baseUrl, options.debug === undefined ? {} : { debug: options.debug });
  return { client, config, baseUrl, options };
}

export function requireSession(options: GlobalOptions, configured?: string): string {
  const id = options.session || configured;
  if (!id) throw new OpenFloorError("Choose a session with `openfloor sessions use <id>` or pass --session", "usage");
  return id;
}
