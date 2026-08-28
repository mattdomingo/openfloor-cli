export const PROVIDERS = ["openai", "anthropic", "kimi", "gemini", "glm"] as const;
export type Provider = typeof PROVIDERS[number];
export type CredentialKind = "api_key" | "oauth";

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI", anthropic: "Anthropic", kimi: "Moonshot", gemini: "Google", glm: "Z.ai",
};

export const PROVIDER_CREDENTIAL_KINDS: Record<Provider, readonly CredentialKind[]> = {
  openai: ["api_key", "oauth"], anthropic: ["api_key", "oauth"], kimi: ["api_key", "oauth"], gemini: ["api_key"], glm: ["api_key"],
};

export const PROVIDER_MODELS: Record<Provider, readonly string[]> = {
  openai: ["gpt-5.6-terra"],
  anthropic: ["claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  kimi: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-for-coding", "kimi-for-coding-highspeed", "k3-256k"],
  gemini: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  glm: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5-air", "glm-4.5"],
};

export function credentialLabel(provider: Provider, kind: CredentialKind): string {
  if (kind === "api_key") return `${PROVIDER_LABELS[provider]} API key`;
  if (provider === "anthropic") return "Claude setup token";
  if (provider === "openai") return "ChatGPT auth.json";
  return "Kimi Code plan key";
}

export function credentialBody(provider: Provider, kind: CredentialKind, secret: string): Record<string, string> {
  if (kind === "api_key") return { apiKey: secret.trim() };
  if (provider === "openai") return { authJson: secret.trim() };
  return { setupToken: secret.trim() };
}
