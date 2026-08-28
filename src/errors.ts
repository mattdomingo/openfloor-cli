export type ErrorCode = "usage" | "authentication" | "not_found" | "conflict" | "unavailable" | "invalid_response";

export class OpenFloorError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenFloorError";
  }
}

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof OpenFloorError)) return 6;
  switch (error.code) {
    case "usage": return 2;
    case "authentication": return 3;
    case "not_found": return 4;
    case "conflict": return 5;
    default: return 6;
  }
}

export function apiError(status: number, message: string, details?: unknown): OpenFloorError {
  if (status === 401 || status === 302 || status === 303 || status === 307 || status === 308) {
    return new OpenFloorError(message || "Cloudflare Access authentication is required", "authentication", status, details);
  }
  if (status === 404) return new OpenFloorError(message || "Not found", "not_found", status, details);
  if (status === 400 || status === 403 || status === 409 || status === 413) {
    return new OpenFloorError(message || "Request refused", status === 400 ? "usage" : "conflict", status, details);
  }
  return new OpenFloorError(message || `openfloor returned HTTP ${status}`, "unavailable", status, details);
}
