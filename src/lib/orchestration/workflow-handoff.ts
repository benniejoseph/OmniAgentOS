import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import type { AgentEvent } from "@/lib/orchestration/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { GovernedToolExecutionResult } from "@/lib/tools/executor";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const status = z.enum(["queued", "running", "waiting_approval", "paused", "completed", "failed", "canceled"]);
const startResultSchema = z.object({
  workflowId: id,
  status,
  title: z.string().trim().min(1).max(180),
  threadId: id.optional(),
}).strip();

export const workflowHandoffEventSchema = z.object({
  type: z.literal("delegated"),
  threadId: id,
  workflowId: id,
  missionId: id.optional(),
  acknowledgement: z.string().trim().min(1).max(1_000),
  reason: z.string().trim().min(1).max(300),
}).strict();

export type WorkflowHandoff = Extract<AgentEvent, { type: "delegated" }>;

/** Only a real governed service receipt can end a turn as accepted background work.
 * Model text, previews, failed calls, and third-party tool output cannot do so. */
export function workflowHandoffFromExecution(
  execution: Pick<GovernedToolExecutionResult, "record"> & { result?: unknown },
  owner: { tenantId?: string; actorId?: string; threadId?: string },
): WorkflowHandoff | undefined {
  const { record, result } = execution;
  if (record.status !== "executed" || record.dryRun ||
    !["app.research.start", "app.workflows.start"].includes(record.toolId) ||
    !owner.tenantId || !owner.actorId || !id.safeParse(owner.threadId).success ||
    record.tenantId !== owner.tenantId || record.actorId !== owner.actorId ||
    !result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const { serviceReceipt, ...data } = result as Record<string, unknown>;
  const receipt = appServiceReceiptSchema.safeParse(serviceReceipt);
  const parsed = startResultSchema.safeParse(data);
  if (!receipt.success || !parsed.success || receipt.data.operation !== record.toolId ||
    receipt.data.accessMode !== "mutation" || !receipt.data.idempotencyKeySha256 ||
    receipt.data.outcomeSha256 !== canonicalJsonSha256(data) ||
    (parsed.data.threadId !== undefined && parsed.data.threadId !== owner.threadId) ||
    (record.toolId === "app.research.start" && parsed.data.threadId !== owner.threadId)) return undefined;
  const work = parsed.data;
  const research = record.toolId === "app.research.start";
  const kind = research ? "research" : "workflow";
  const title = work.title.replace(/\s+/g, " ");
  const acknowledgement = work.status === "queued"
    ? `Your ${kind} “${title}” is queued. I’ll keep track of its progress${research ? " and bring the report here" : ""}.`
    : work.status === "running"
      ? `Your ${kind} “${title}” is running. I’ll keep track of its progress${research ? " and bring the report here" : ""}.`
      : work.status === "waiting_approval"
        ? `Your ${kind} “${title}” is waiting for approval before it can continue.`
        : work.status === "paused"
          ? `Your ${kind} “${title}” is paused. Its saved progress is available.`
          : work.status === "completed"
            ? `This ${kind} request “${title}” has already completed. Its saved result is available.`
            : `This ${kind} request “${title}” is ${work.status}. Its saved progress is available.`;
  return workflowHandoffEventSchema.parse({
    type: "delegated", threadId: owner.threadId, workflowId: work.workflowId,
    acknowledgement, reason: `background_${kind}_${work.status}`,
  });
}
