import { z } from "zod";
import { CANONICAL_STATUSES } from "@/lib/status/canonical";

export const CANONICAL_WORK_ITEM_SURFACE_VERSION =
  "p11.4-work-item-surface:1" as const;

const identifierSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("canonical_work_item_v1"),
  persistence: z.enum(["postgres", "local_projection"]),
  workspaceId: identifierSchema.nullable(),
  projectId: identifierSchema,
  workItemId: identifierSchema,
  kind: z.enum(["task", "milestone"]),
  sourceAuthority: z.enum([
    "legacy_project_task",
    "legacy_mission",
    "legacy_mission_task",
  ]),
  sourceId: identifierSchema,
  status: z.enum(CANONICAL_STATUSES),
  sourceStatus: z.string().trim().min(1).max(160),
  statusRevision: z.number().int().min(1),
  updatedAt: timestampSchema,
}).strict();

export const canonicalWorkItemSurfaceSchema = z.object({
  version: z.literal(CANONICAL_WORK_ITEM_SURFACE_VERSION),
  projection: z.object({
    authority: z.literal("canonical_work_item_v1"),
    sha256: sha256Schema.nullable(),
    sourceRevisionSha256: sha256Schema.nullable(),
  }).strict(),
  status: statusSchema,
  assignment: z.object({
    authority: z.literal("canonical_work_item_v1"),
    agents: z.array(z.object({
      agentId: identifierSchema,
      principalId: identifierSchema.nullable(),
      principalGeneration: z.number().int().min(1).nullable(),
    }).strict()).max(32),
  }).strict(),
  artifacts: z.object({
    authority: z.literal("canonical_work_item_v1"),
    count: z.number().int().min(0).max(256),
    items: z.array(z.object({
      artifactId: identifierSchema,
      kind: identifierSchema,
      evidenceCount: z.number().int().min(0).max(128),
    }).strict()).max(256),
  }).strict().superRefine((value, context) => {
    if (value.count !== value.items.length) {
      context.addIssue({ code: "custom", message: "Artifact count is inconsistent." });
    }
  }),
  execution: z.object({
    authority: z.literal("governed_workflow_v1"),
    availability: z.enum(["not_started", "current", "unavailable"]),
    workflowRunId: identifierSchema.nullable(),
    sourceStatus: z.enum([
      "queued",
      "running",
      "waiting_approval",
      "paused",
      "completed",
      "failed",
      "canceled",
    ]).nullable(),
    currentStep: identifierSchema.nullable(),
    completedSteps: z.number().int().min(0),
    totalSteps: z.number().int().min(0),
    progressPercent: z.number().int().min(0).max(100).nullable(),
    updatedAt: timestampSchema.nullable(),
  }).strict().superRefine((value, context) => {
    if (value.completedSteps > value.totalSteps) {
      context.addIssue({ code: "custom", message: "Workflow progress is inconsistent." });
    }
    if (value.availability === "not_started" && value.workflowRunId !== null) {
      context.addIssue({ code: "custom", message: "Unstarted execution has a workflow id." });
    }
  }),
  cost: z.object({
    authority: z.literal("ai_usage_ledger_v1"),
    state: z.enum(["not_recorded", "known", "partial", "unknown"]),
    usageReceiptCount: z.number().int().min(0),
    unknownCostReceiptCount: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    knownEstimatedCostMicrousd: z.number().int().min(0),
  }).strict().superRefine((value, context) => {
    if (value.unknownCostReceiptCount > value.usageReceiptCount) {
      context.addIssue({ code: "custom", message: "Usage cost coverage is inconsistent." });
    }
    if (value.state === "not_recorded" && value.usageReceiptCount !== 0) {
      context.addIssue({ code: "custom", message: "Unrecorded usage has receipts." });
    }
  }),
}).strict();

export type CanonicalWorkItemSurface = Readonly<
  z.infer<typeof canonicalWorkItemSurfaceSchema>
>;

export function parseCanonicalWorkItemSurface(value: unknown) {
  const parsed = canonicalWorkItemSurfaceSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

export function canonicalWorkItemStatusLabel(status: string) {
  return ({
    preview: "Draft",
    waiting: "Waiting",
    running: "Running",
    blocked: "Blocked",
    partial: "Partial",
    unverified: "Closed · unverified",
    failed: "Failed",
    canceled: "Canceled",
    succeeded: "Verified success",
  } as Record<string, string>)[status] || "Unknown";
}

export function canonicalWorkItemCostLabel(
  cost: CanonicalWorkItemSurface["cost"],
) {
  if (cost.state === "not_recorded") return "No recorded AI cost";
  if (cost.state === "unknown") return "Cost unavailable";
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(cost.knownEstimatedCostMicrousd / 1_000_000);
  return cost.state === "partial" ? `${amount} known · partial` : `${amount} estimated`;
}

