import { z } from "zod";
import { accessToken } from "./auth.js";
import { apiError, OpenFloorError } from "./errors.js";
import { errorResponseSchema } from "./contracts.js";
import { redact, sanitizeDeep } from "./sanitize.js";

export type RequestOptions<T> = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  schema?: z.ZodType<T>;
  timeoutMs?: number;
  signal?: AbortSignal;
  raw?: boolean;
};

export class ApiClient {
  private tokenPromise?: Promise<string | null>;

  constructor(readonly baseUrl: string, private readonly options: { debug?: boolean; cloudflaredPath?: string } = {}) {}

  async token(): Promise<string | null> {
    this.tokenPromise ??= accessToken({ baseUrl: this.baseUrl, ...this.options });
    return this.tokenPromise;
  }

  async request<T = Record<string, unknown>>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const method = options.method ?? "GET";
    const attempts = method === "GET" ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { return await this.requestOnce(path, options, method); }
      catch (error) {
        lastError = error;
        const retryable = error instanceof OpenFloorError && error.code === "unavailable" && (!error.status || [429, 502, 503, 504].includes(error.status));
        if (!retryable || attempt === attempts - 1) throw error;
        const delay = typeof error.details === "object" && error.details && "retryAfterMs" in error.details
          ? Number((error.details as any).retryAfterMs) : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5_000)));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(path: string, options: RequestOptions<T>, method: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new OpenFloorError("API path escaped configured origin", "usage");
    const headers = new Headers({ accept: options.raw ? "*/*" : "application/json" });
    const token = await this.token();
    if (token) headers.set("cf-access-token", token);
    let body: BodyInit | undefined;
    if (options.form) body = options.form;
    else if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? (method === "GET" ? 30_000 : 120_000));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    if (this.options.debug) process.stderr.write(`[openfloor] ${method} ${url.pathname}${url.search}\n`);
    let response: Response;
    const request: RequestInit = { method, headers, redirect: "manual", signal };
    if (body !== undefined) request.body = body;
    try { response = await fetch(url, request); }
    catch (error) {
      throw new OpenFloorError(`Unable to reach openfloor: ${redact(error instanceof Error ? error.message : String(error))}`, "unavailable", undefined, error);
    }
    if (response.status >= 300 && response.status < 400) throw apiError(response.status, "Cloudflare Access authentication expired");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 32 * 1024 * 1024) throw new OpenFloorError("Response exceeded 32 MiB client limit", "invalid_response", response.status);
    if (options.raw) {
      if (!response.ok) throw await this.errorFromResponse(response);
      return response as T;
    }
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024) throw new OpenFloorError("Response exceeded 32 MiB client limit", "invalid_response", response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (text && response.ok && contentType !== "application/json" && !contentType?.endsWith("+json")) {
      throw new OpenFloorError(`Expected JSON from ${url.pathname}; received ${contentType || "unknown content type"}`, "invalid_response", response.status);
    }
    let parsed: unknown = {};
    if (text) {
      try { parsed = JSON.parse(text); }
      catch { throw new OpenFloorError(`Expected JSON from ${url.pathname}; received ${response.status}`, "invalid_response", response.status); }
    }
    if (!response.ok) {
      const result = errorResponseSchema.safeParse(parsed);
      throw apiError(response.status, result.success ? result.data.error : `openfloor returned HTTP ${response.status}`, {
        ...(typeof parsed === "object" && parsed ? parsed : {}),
        ...(retryAfterMs(response.headers.get("retry-after")) !== null ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) } : {}),
      });
    }
    const sanitized = sanitizeDeep(parsed);
    if (!options.schema) return sanitized as T;
    const result = options.schema.safeParse(sanitized);
    if (!result.success) throw new OpenFloorError(`Server response is incompatible with this CLI at ${url.pathname}`, "invalid_response", response.status, result.error.flatten());
    return result.data;
  }

  private async errorFromResponse(response: Response): Promise<OpenFloorError> {
    let message = `openfloor returned HTTP ${response.status}`;
    try {
      const parsed = errorResponseSchema.safeParse(await response.clone().json());
      if (parsed.success) message = parsed.data.error;
    } catch { /* binary/text error */ }
    return apiError(response.status, message);
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
