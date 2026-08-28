import { z } from "zod";

const loose = z.object({}).passthrough();

export const appUserSchema = z.object({
  id: z.string(), email: z.string(), displayName: z.string(), onboardedAt: z.number().nullable(),
}).passthrough();

export const sessionSchema = z.object({
  id: z.string(), title: z.string(), objective: z.string().nullable(), role: z.enum(["owner", "member"]),
  createdAt: z.number(), updatedAt: z.number(), endedAt: z.number().nullable(), archivedAt: z.number().nullable().optional(),
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

export const floorSchema = z.object({
  revision: z.number(), autoDispatch: z.boolean(), autoProvisionAgents: z.boolean(), autoResolveConflicts: z.boolean(),
  agents: z.array(agentSchema), assignments: z.array(loose), messages: z.array(loose), files: z.array(loose),
  queue: z.array(queueItemSchema), runs: z.array(runSchema), repository: loose.nullable(), activeCandidate: loose.nullable(),
  latestPreflight: loose.nullable(), review: loose.nullable(),
}).passthrough();

export const bootstrapMeSchema = z.object({ user: appUserSchema, onboarded: z.boolean() }).passthrough();
export const bootstrapHomeSchema = z.object({ props: z.object({ user: appUserSchema, sessions: z.array(sessionSchema), usage: loose }).passthrough() }).passthrough();
export const bootstrapSessionSchema = z.object({ props: z.object({ user: appUserSchema, session: sessionSchema, initialMembers: z.array(memberSchema) }).passthrough() }).passthrough();
export const bootstrapFloorSchema = z.object({ props: z.object({ user: appUserSchema, session: sessionSchema, initialMembers: z.array(memberSchema), initialFloor: floorSchema }).passthrough() }).passthrough();
export const floorResponseSchema = z.object({ floor: floorSchema }).passthrough();
export const eventsResponseSchema = z.object({ events: z.array(z.object({ id: z.string(), runId: z.string(), sequence: z.number(), kind: z.string(), detail: z.string(), createdAt: z.number() }).passthrough()) }).passthrough();
export const errorResponseSchema = z.object({ error: z.string(), code: z.string().optional(), runId: z.string().optional() }).passthrough();
export const recordResponseSchema = loose;

export type AppUser = z.infer<typeof appUserSchema>;
export type SessionSummary = z.infer<typeof sessionSchema>;
export type SessionMember = z.infer<typeof memberSchema>;
export type FloorSnapshot = z.infer<typeof floorSchema>;
export type RunActivityEvent = z.infer<typeof eventsResponseSchema>["events"][number];
