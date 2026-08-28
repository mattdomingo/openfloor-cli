import { z } from "zod";

const loose = z.object({}).passthrough();

export const usageSchema = z.object({
  plan: z.enum(["free", "pro", "max", "enterprise"]),
  planStatus: z.enum(["inactive", "active", "past_due", "canceled"]),
  effectivePlan: z.enum(["free", "pro", "max", "enterprise"]),
  seconds: z.number().nonnegative(),
  // Server-side Infinity serializes as null in JSON. Null therefore means
  // unlimited for both fields, never missing data.
  limitHours: z.number().nonnegative().nullable(),
  limitSeats: z.number().nonnegative().nullable(),
}).passthrough();

export const repositoryOptionSchema = z.object({
  id: z.string(),
  accountInstallationId: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
}).passthrough();

export const repositoryOptionsResponseSchema = z.object({ repositories: z.array(repositoryOptionSchema) }).passthrough();

export const appUserSchema = z.object({
  id: z.string(), email: z.string(), displayName: z.string(), onboardedAt: z.number().nullable(),
}).passthrough();

export const onboardingProfileResponseSchema = z.object({ user: appUserSchema }).passthrough();
export const onboardingCompleteResponseSchema = z.object({ url: z.string() }).passthrough();
export const githubDeviceStartSchema = z.object({
  deviceCode: z.string(), userCode: z.string(), verificationUri: z.string().url(), interval: z.number().positive(), expiresIn: z.number().positive(),
}).passthrough();
export const githubDevicePollSchema = z.object({
  connected: z.boolean().optional(), pending: z.boolean().optional(), expired: z.boolean().optional(), interval: z.number().positive().optional(), installations: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

export const credentialSchema = z.object({
  provider: z.enum(["openai", "anthropic", "kimi", "gemini", "glm"]), kind: z.enum(["api_key", "oauth"]), fingerprint: z.string(),
  validatedAt: z.number().nullable(), createdAt: z.number(), updatedAt: z.number(), monthSpendMicroUsd: z.number(), monthlyLimitMicroUsd: z.number().nullable(),
  monthInputTokens: z.number(), monthOutputTokens: z.number(),
}).passthrough();
export const credentialsResponseSchema = z.object({ credentials: z.array(credentialSchema) }).passthrough();
export const credentialResponseSchema = z.object({ credential: credentialSchema }).passthrough();

export const sessionSchema = z.object({
  id: z.string(), title: z.string(), objective: z.string().nullable(), role: z.enum(["owner", "member"]),
  createdAt: z.number(), updatedAt: z.number(), endedAt: z.number().nullable(), archivedAt: z.number().nullable().optional(),
}).passthrough();

export const sessionCreateResponseSchema = z.object({
  session: sessionSchema,
  setupStatus: z.enum(["ready", "failed"]),
  setupError: z.string().nullable(),
}).passthrough();

export const memberSchema = z.object({
  id: z.string(), displayName: z.string(), role: z.enum(["owner", "member"]), joinedAt: z.number(), online: z.boolean(),
}).passthrough();

export const agentSchema = z.object({
  id: z.string(), name: z.string(), role: z.string(), task: z.string(), ownerUserId: z.string(), ownerName: z.string(),
  provider: z.string(), model: z.string().nullable(), pausedAt: z.number().nullable(), kind: z.string().nullable(),
}).passthrough();

export const queueItemSchema = z.object({
  id: z.string(), agentId: z.string().nullable(), agentName: z.string().nullable(), position: z.number(), status: z.string(),
  prompts: z.array(z.object({ id: z.string(), authorName: z.string(), text: z.string(), createdAt: z.number() }).passthrough()),
}).passthrough();

export const runSchema = z.object({
  id: z.string(), queueItemId: z.string(), agentId: z.string(), agentName: z.string(), status: z.string(), model: z.string(),
  summary: z.string().nullable(), finalResponse: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
  checks: z.array(loose), files: z.array(loose),
}).passthrough();

export const repositorySchema = z.object({
  repositoryFullName: z.string(),
  status: z.enum(["connected", "ready", "revoked", "inaccessible", "externally_modified", "disconnected"]),
}).passthrough();

export const candidateSchema = z.object({
  branchName: z.string(),
  candidateSha: z.string().nullable(),
  remoteCandidateSha: z.string().nullable(),
  status: z.enum(["creating", "active", "merged", "abandoned", "creation_failed"]),
}).passthrough();

export const floorSchema = z.object({
  revision: z.number(), autoDispatch: z.boolean(), autoProvisionAgents: z.boolean(), autoResolveConflicts: z.boolean(),
  autoAgentProvider: z.enum(["openai", "anthropic", "kimi", "gemini", "glm"]).optional(),
  agents: z.array(agentSchema), assignments: z.array(loose), messages: z.array(loose), files: z.array(loose),
  queue: z.array(queueItemSchema), runs: z.array(runSchema), repository: repositorySchema.nullable(), activeCandidate: candidateSchema.nullable(),
  latestPreflight: loose.nullable(), review: loose.nullable(),
}).passthrough();

export const bootstrapMeSchema = z.object({ user: appUserSchema, onboarded: z.boolean() }).passthrough();
export const bootstrapHomeSchema = z.object({ props: z.object({ user: appUserSchema, sessions: z.array(sessionSchema), usage: usageSchema }).passthrough() }).passthrough();
export const bootstrapSessionSchema = z.object({ props: z.object({ user: appUserSchema, session: sessionSchema, initialMembers: z.array(memberSchema) }).passthrough() }).passthrough();
export const bootstrapFloorSchema = z.object({ props: z.object({ user: appUserSchema, session: sessionSchema, initialMembers: z.array(memberSchema), initialFloor: floorSchema }).passthrough() }).passthrough();
export const floorResponseSchema = z.object({ floor: floorSchema }).passthrough();
const reviewPromptSchema = z.object({ id: z.string(), authorUserId: z.string(), authorName: z.string(), text: z.string(), createdAt: z.number() }).passthrough();
const reviewDiffLineSchema = z.object({ type: z.enum(["add", "remove", "context"]), text: z.string() }).passthrough();
const reviewFileSchema = z.object({ id: z.string(), path: z.string(), changeKind: z.string(), additions: z.number(), deletions: z.number(), summary: z.string().nullable(), diff: z.array(reviewDiffLineSchema).optional() }).passthrough();
export const reviewContributionSchema = z.object({
  runId: z.string(), queueItemId: z.string(), agentId: z.string(), agentName: z.string(), agentOwnerUserId: z.string(), integratedAt: z.number(),
  rollbackStatus: z.string().nullable(), rollbackFailureReason: z.string().nullable(), canRollback: z.boolean(), prompts: z.array(reviewPromptSchema), files: z.array(reviewFileSchema),
}).passthrough();
const reviewFacetSchema = z.object({ id: z.string(), name: z.string(), activePromptGroups: z.number(), activeFiles: z.number() }).passthrough();
export const reviewContributionsSchema = z.object({ items: z.array(reviewContributionSchema), nextCursor: z.string().nullable(), engineers: z.array(reviewFacetSchema), agents: z.array(reviewFacetSchema) }).passthrough();
export const reviewContributionResponseSchema = z.object({ contribution: reviewContributionSchema }).passthrough();
export const eventsResponseSchema = z.object({ events: z.array(z.object({ id: z.string(), runId: z.string(), sequence: z.number(), kind: z.string(), detail: z.string(), createdAt: z.number() }).passthrough()) }).passthrough();
export const errorResponseSchema = z.object({ error: z.string(), code: z.string().optional(), runId: z.string().optional() }).passthrough();
export const recordResponseSchema = loose;

export type AppUser = z.infer<typeof appUserSchema>;
export type SessionSummary = z.infer<typeof sessionSchema>;
export type SessionMember = z.infer<typeof memberSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type RepositoryOption = z.infer<typeof repositoryOptionSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type FloorSnapshot = z.infer<typeof floorSchema>;
export type RunActivityEvent = z.infer<typeof eventsResponseSchema>["events"][number];
export type ProviderCredential = z.infer<typeof credentialSchema>;
export type ReviewContribution = z.infer<typeof reviewContributionSchema>;
export type ReviewContributionPage = z.infer<typeof reviewContributionsSchema>;
