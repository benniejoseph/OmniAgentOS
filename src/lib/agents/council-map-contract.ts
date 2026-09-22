import { z } from "zod";

export const AGENT_COUNCIL_MAP_VERSION =
  "p11.5-agent-council-map:1" as const;

const idSchema = z.string().trim().min(1).max(320);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const optionalScopeIdSchema = idSchema.nullable();
const costSchema = z.object({
  authority: z.literal("ai_usage_ledger_v1"),
  state: z.enum(["not_recorded", "exact", "partial", "unknown"]),
  receiptCount: z.number().int().min(0),
  unknownCostReceiptCount: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  knownEstimatedCostMicrousd: z.number().int().min(0),
}).strict();
const runtimeSchema = z.object({
  providerId: idSchema,
  modelId: idSchema,
  modelTier: z.enum(["fast", "reasoning"]),
}).strict();
const identitySchema = z.object({
  agentId: idSchema,
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(160),
  charter: z.string().trim().min(1).max(2_000),
  visualIdentity: z.string().trim().min(1).max(1_000),
  definitionVersion: z.number().int().min(1),
  source: z.enum(["agent_definition", "historical_reference"]),
}).strict();
const channelMessageSchema = z.object({
  messageId: idSchema,
  kind: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(2_000),
  direction: z.enum(["sent", "received"]),
  createdAt: timestampSchema,
  trust: z.literal("untrusted_shared_content"),
}).strict();
const outputSchema = z.object({
  artifactId: idSchema,
  title: z.string().trim().min(1).max(240),
  kind: z.string().trim().min(1).max(80),
  mediaType: z.string().trim().min(1).max(160),
  content: z.string().max(8_000),
  createdAt: timestampSchema,
  trust: z.literal("untrusted_shared_content"),
}).strict();
const authoritySchema = z.object({
  source: z.enum(["delegation_grants", "historical_unavailable"]),
  receiptSha256: sha256Schema.nullable(),
  contractSha256: sha256Schema,
  purpose: z.string().trim().min(1).max(500),
  scope: z.object({
    workspaceId: optionalScopeIdSchema,
    projectId: optionalScopeIdSchema,
    missionId: optionalScopeIdSchema,
  }).strict(),
  context: z.object({
    state: z.enum(["granted", "none", "unavailable"]),
    grantCount: z.number().int().min(0).max(64),
  }).strict(),
  capabilities: z.object({
    state: z.enum(["granted", "none", "unavailable"]),
    grantCount: z.number().int().min(0).max(64),
  }).strict(),
  tools: z.object({
    state: z.enum(["granted", "none", "unavailable"]),
    ids: z.array(idSchema).max(64),
  }).strict(),
  budgets: z.object({
    modelTurns: z.number().int().min(0).nullable(),
    tokens: z.number().int().min(0).nullable(),
    costMicrousd: z.number().int().min(0).nullable(),
    wallTimeMs: z.number().int().min(0).nullable(),
    toolCalls: z.number().int().min(0).nullable(),
    browserActions: z.number().int().min(0).nullable(),
  }).strict(),
}).strict();
const verifierSchema = z.object({
  identity: identitySchema,
  runtime: runtimeSchema.nullable(),
  acceptanceThreshold: z.number().min(0.5).max(1),
  method: z.enum([
    "deterministic_schema_and_evidence",
    "agent_then_deterministic",
    "historical_unavailable",
  ]),
  verdict: z.enum(["pending", "accepted", "rejected", "unavailable"]),
  score: z.number().min(0).max(1).nullable(),
}).strict();
const memberSchema = z.object({
  taskId: idSchema,
  delegationId: idSchema,
  identity: identitySchema,
  state: z.enum([
    "proposed",
    "accepted",
    "working",
    "waiting",
    "challenged",
    "completed_proposed",
    "result_accepted",
    "rejected",
    "canceled",
    "expired",
  ]),
  lifecycleRevision: z.number().int().min(0).max(32),
  canCancel: z.boolean().optional(),
  runtime: runtimeSchema.nullable(),
  currentWork: z.string().trim().min(1).max(4_000),
  updatedAt: timestampSchema,
  authority: authoritySchema,
  messages: z.object({
    state: z.enum(["available", "not_applicable", "unavailable"]),
    items: z.array(channelMessageSchema).max(50),
  }).strict(),
  outputs: z.object({
    state: z.enum(["shared", "receipt_only", "none", "unavailable"]),
    items: z.array(outputSchema).max(20),
    proposalReceiptSha256: sha256Schema.nullable(),
  }).strict(),
  cost: costSchema,
  confidence: z.number().min(0).max(1).nullable(),
  verifier: verifierSchema,
}).strict();
const executionSchema = z.object({
  parentExecutionId: idSchema,
  href: z.string().startsWith("/app/command?run="),
  status: z.enum([
    "unavailable",
    "queued",
    "running",
    "waiting_clarification",
    "waiting_approval",
    "resuming",
    "completed",
    "failed",
    "canceled",
  ]),
  currentWork: z.string().trim().min(1).max(4_000),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  members: z.array(memberSchema).min(1).max(20),
  verifierCost: costSchema,
}).strict();

export const agentCouncilMapSchema = z.object({
  version: z.literal(AGENT_COUNCIL_MAP_VERSION),
  authority: z.literal("canonical_delegation_ledger"),
  generatedAt: timestampSchema,
  state: z.enum(["ready", "empty", "unavailable"]),
  summary: z.object({
    executionCount: z.number().int().min(0).max(100),
    memberCount: z.number().int().min(0).max(100),
    activeMemberCount: z.number().int().min(0).max(100),
    waitingMemberCount: z.number().int().min(0).max(100),
    acceptedMemberCount: z.number().int().min(0).max(100),
    knownEstimatedCostMicrousd: z.number().int().min(0),
  }).strict(),
  executions: z.array(executionSchema).max(50),
}).strict().superRefine((value, context) => {
  const members = value.executions.flatMap((execution) => execution.members);
  if (
    value.summary.executionCount !== value.executions.length ||
    value.summary.memberCount !== members.length ||
    new Set(members.map((member) => member.taskId)).size !== members.length ||
    (value.state === "empty") !== (members.length === 0)
  ) {
    context.addIssue({ code: "custom", message: "Council map summary is inconsistent." });
  }
});

export type AgentCouncilMap = Readonly<z.infer<typeof agentCouncilMapSchema>>;
export type AgentCouncilMapMember = AgentCouncilMap["executions"][number]["members"][number];

export function parseAgentCouncilMap(value: unknown) {
  return agentCouncilMapSchema.parse(value);
}

export function safeParseAgentCouncilMap(value: unknown) {
  const parsed = agentCouncilMapSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
