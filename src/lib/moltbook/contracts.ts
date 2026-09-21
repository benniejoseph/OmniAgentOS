import { z } from "zod";

export const MOLTBOOK_API_ORIGIN = "https://www.moltbook.com" as const;
export const MOLTBOOK_API_BASE = `${MOLTBOOK_API_ORIGIN}/api/v1` as const;
export const MOLTBOOK_HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1_000;
export const MOLTBOOK_DISCLOSURE_VERSION = "moltbook-public-activity-v1" as const;

export const moltbookConnectionStatusSchema = z.enum([
  "registering",
  "pending_claim",
  "claimed",
  "paused",
  "error",
  "revoked",
]);
export type MoltbookConnectionStatus = z.infer<
  typeof moltbookConnectionStatusSchema
>;

const moltbookRegistrationFields = {
  externalName: z.string().trim().min(2).max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, underscores, or hyphens."),
  description: z.string().trim().min(2).max(1_000),
  heartbeatEnabled: z.boolean().optional(),
  disclosureAccepted: z.literal(true),
  disclosureVersion: z.literal(MOLTBOOK_DISCLOSURE_VERSION),
} as const;

export const moltbookRegisterInputSchema = z.object({
  action: z.literal("register"),
  ...moltbookRegistrationFields,
}).strict();

export const moltbookRetryRegistrationInputSchema = z.object({
  action: z.literal("retry_registration"),
  ...moltbookRegistrationFields,
}).strict();

export const moltbookRouteActionSchema = z.discriminatedUnion("action", [
  moltbookRegisterInputSchema,
  moltbookRetryRegistrationInputSchema,
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
]);
export type MoltbookRouteAction = z.infer<typeof moltbookRouteActionSchema>;

const providerIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const externalAgentNameSchema = z.string().trim().min(1).max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const moltbookToolSchemas = {
  "moltbook.home.read": z.object({}).strict(),
  "moltbook.feed.read": z.object({
    sort: z.enum(["new", "hot", "top"]),
    limit: z.number().int().min(1).max(25),
    filter: z.literal("following").optional(),
  }).strict(),
  "moltbook.thread.read": z.object({
    postId: providerIdSchema,
    sort: z.enum(["best", "new", "old"]),
    limit: z.number().int().min(1).max(50),
  }).strict(),
  "moltbook.post.create": z.object({
    submoltName: z.string().trim().min(2).max(30)
      .regex(/^[a-z0-9-]+$/),
    title: z.string().trim().min(1).max(300),
    content: z.string().max(40_000).optional(),
    url: z.string().url().max(2_048).optional(),
    type: z.enum(["text", "link", "image"]).optional(),
  }).strict().superRefine((value, context) => {
    if ((value.type === "link" || value.type === "image") && !value.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `${value.type} posts require a URL.`,
      });
    }
  }),
  "moltbook.comment.create": z.object({
    postId: providerIdSchema,
    content: z.string().trim().min(1).max(40_000),
    parentId: providerIdSchema.optional(),
  }).strict(),
  "moltbook.post.vote": z.object({
    postId: providerIdSchema,
    direction: z.enum(["up", "down"]),
  }).strict(),
  "moltbook.comment.upvote": z.object({
    commentId: providerIdSchema,
  }).strict(),
  "moltbook.agent.follow": z.object({
    name: externalAgentNameSchema,
    follow: z.boolean(),
  }).strict(),
  "moltbook.verify": z.object({
    verificationCode: z.string().trim().min(8).max(240)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    answer: z.string().trim().min(1).max(80)
      .regex(/^-?[0-9]+(?:\.[0-9]+)?$/),
  }).strict(),
} as const;

export type MoltbookToolId = keyof typeof moltbookToolSchemas;

export const MOLTBOOK_TOOL_IDS = Object.freeze(
  Object.keys(moltbookToolSchemas) as MoltbookToolId[],
);

export function isExactMoltbookAgentCapabilityBoundary(input: {
  skillIds: unknown;
  toolIds: unknown;
  memoryScope: unknown;
  autonomy: unknown;
  approvalPolicy: unknown;
}) {
  if (!Array.isArray(input.skillIds) || input.skillIds.length !== 0) return false;
  if (!Array.isArray(input.toolIds) || input.toolIds.length !== MOLTBOOK_TOOL_IDS.length) {
    return false;
  }
  const toolIds = new Set(input.toolIds);
  return toolIds.size === MOLTBOOK_TOOL_IDS.length &&
    MOLTBOOK_TOOL_IDS.every((toolId) => toolIds.has(toolId)) &&
    input.memoryScope === "session" &&
    input.autonomy === "governed" &&
    (input.approvalPolicy === "risk_based" || input.approvalPolicy === "always");
}

export function isMoltbookToolId(value: string): value is MoltbookToolId {
  return Object.hasOwn(moltbookToolSchemas, value);
}

export function parseMoltbookToolInput(
  toolId: MoltbookToolId,
  input: unknown,
): Record<string, unknown> {
  return moltbookToolSchemas[toolId].parse(input) as Record<string, unknown>;
}

export type MoltbookRateLimitProjection = Readonly<{
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
  observedAt: string;
}>;

export type MoltbookConnectionProjection = Readonly<{
  agentId: string;
  status: MoltbookConnectionStatus;
  health: "healthy" | "pending" | "paused" | "error" | "revoked";
  externalName: string;
  claimState: "pending" | "claimed" | "unavailable";
  claimUrl?: string;
  verificationCode?: string;
  heartbeatEnabled: boolean;
  lastHeartbeatAt?: string;
  nextHeartbeatAt?: string;
  rateLimit?: MoltbookRateLimitProjection;
  consecutiveFailures: number;
  registrationRetryable: boolean;
  disclosureAccepted: boolean;
  disclosureVersion: typeof MOLTBOOK_DISCLOSURE_VERSION;
  lastErrorCode?: string;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type MoltbookActivityProjection = Readonly<{
  id: string;
  kind: string;
  status: "succeeded" | "failed" | "uncertain" | "pending_verification" | "published";
  summary: string;
  providerObject?: Readonly<{
    type: string;
    ref: string;
    url?: string;
  }>;
  runId?: string;
  createdAt: string;
}>;
