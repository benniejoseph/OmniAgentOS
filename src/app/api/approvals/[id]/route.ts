import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  applyObservabilitySloPolicyChange,
  getObservabilitySloPolicyChange,
  rejectObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import {
  getAgentResumeJobDedupeKey,
  wakeOperationJobByDedupeKey,
} from "@/lib/operations/job-queue";
import { rejectAgentRunApproval } from "@/lib/orchestration/agent-runner";
import { findAgentRunWaitingForToolApproval } from "@/lib/runs/store";
import {
  approveAndClaimToolExecution,
  failClaimedToolExecution,
  getToolExecution,
  openToolExecutionInput,
  publicToolExecution,
  recoverStaleToolExecutionClaim,
  rejectPendingToolExecution,
} from "@/lib/tools/audit-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";
import { RISK3_QUORUM } from "@/lib/tools/types";
import { actionClassFor, recordActionOutcome } from "@/lib/trust/ledger";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  signalWorkflowRun,
  WorkflowNotFoundError,
  WorkflowSignalConflictError,
} from "@/lib/workflows/runner";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const approvalDecisionSchema = z.object({
  kind: z.enum(["tool", "workflow", "slo_policy"]),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(1000).optional(),
  breakGlass: z.boolean().optional(),
  ticket: z.string().max(120).optional(),
}).strict();

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = approvalDecisionSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid approval decision", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.kind === "workflow") {
    try {
      const securityContext = await authorizeRequest({
        request,
        action: "manage.workflow",
        resourceType: "workflow",
        resourceId: id,
        metadata: {
          kind: parsed.data.kind,
          decision: parsed.data.decision,
          breakGlass: Boolean(parsed.data.breakGlass),
          hasReason: Boolean(parsed.data.reason),
          hasTicket: Boolean(parsed.data.ticket),
        },
      });
      const signal = parsed.data.decision === "approve" ? "approve" : "cancel";
      const detail = await signalWorkflowRun(id, signal, {
        tenantId: securityContext.tenantId,
        actorId: securityContext.actorId,
        reason: parsed.data.reason,
      });
      if (signal === "approve") {
        const queueJob = await enqueueWorkflowRunTick(
          id,
          "workflow_approval",
          undefined,
          securityContext.tenantId,
        );
        scheduleWorkflowQueueDrain(undefined, securityContext.tenantId);
        return Response.json({ ...detail, queueJob });
      }
      const canceledJobs = await cancelWorkflowRunTick(
        id,
        "Workflow approval rejected.",
        securityContext.tenantId,
      );
      return Response.json({ ...detail, canceledJobs });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkflowSignalConflictError) {
        return Response.json(
          { error: "Workflow approval conflict", message: error.message },
          { status: 409 },
        );
      }
      try {
        return forbiddenResponse(error);
      } catch {
        return Response.json(
          { error: error instanceof Error ? error.message : "Workflow approval decision failed." },
          { status: 500 },
        );
      }
    }
  }

  if (parsed.data.kind === "slo_policy") {
    let securityContext;
    try {
      securityContext = await authorizeRequest({
        request,
        action: "manage.workflow",
        resourceType: "observability_slo_policy_change",
        resourceId: id,
        metadata: { decision: parsed.data.decision },
      });
    } catch (error) {
      return forbiddenResponse(error);
    }

    const change = await getObservabilitySloPolicyChange(id, { tenantId: securityContext.tenantId });
    if (!change) {
      return Response.json({ error: "SLO policy change approval record not found." }, { status: 404 });
    }
    if (change.status !== "pending") {
      return Response.json(
        { error: "SLO policy change is not pending.", status: change.status },
        { status: 409 },
      );
    }

    try {
      const result = parsed.data.decision === "approve"
        ? await applyObservabilitySloPolicyChange(id, {
            reviewedBy: securityContext.actorId,
            reviewedRole: securityContext.role,
            tenantId: securityContext.tenantId,
            reviewReason: parsed.data.reason,
            breakGlass: parsed.data.breakGlass,
            ticket: parsed.data.ticket,
          })
        : {
            change: await rejectObservabilitySloPolicyChange(id, {
              reviewedBy: securityContext.actorId,
              reviewedRole: securityContext.role,
              tenantId: securityContext.tenantId,
              reviewReason: parsed.data.reason,
            }),
            policies: [],
          };
      if (result.change.status === "conflicted") {
        return Response.json(
          {
            ...result,
            code: "SLO_POLICY_STATE_CONFLICT",
            message:
              "The policy changed after this request was created. Review the current policy and submit a new change.",
          },
          { status: 409 },
        );
      }
      return Response.json(result, {
        status: result.change.status === "pending" ? 202 : 200,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "SLO policy decision failed.";
      return Response.json(
        { error: "SLO policy approval conflict", message },
        { status: message.includes("was not found") ? 404 : 409 },
      );
    }
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "tool_execution",
      resourceId: id,
      metadata: { decision: parsed.data.decision },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const record = await getToolExecution(id, { tenantId: securityContext.tenantId });
  if (!record) {
    return Response.json({ error: "Tool approval record not found." }, { status: 404 });
  }

  if (record.status !== "approval_required") {
    const recovered = record.status === "executing"
      ? await recoverStaleToolExecutionClaim(record.id, { tenantId: securityContext.tenantId })
      : undefined;
    return Response.json(
      {
        error: recovered
          ? "A stale execution claim was recovered without replaying its side effect."
          : "Tool approval record is not pending.",
        status: recovered?.status || record.status,
        record: recovered ? publicToolExecution(recovered) : undefined,
      },
      { status: 409 },
    );
  }

  if (parsed.data.decision === "reject") {
    const rejection = await rejectPendingToolExecution({
      id: record.id,
      tenantId: securityContext.tenantId,
      rejectedBy: securityContext.actorId,
      reason: parsed.data.reason,
    });
    if (rejection.outcome !== "rejected" || !rejection.record) {
      return Response.json(
        {
          error: rejection.outcome === "not_found"
            ? "Tool approval record not found."
            : "Tool approval record is not pending.",
          status: rejection.record?.status,
        },
        { status: rejection.outcome === "not_found" ? 404 : 409 },
      );
    }
    const rejected = rejection.record;
    const rejectedTool = getGovernedTool(record.toolId) ||
      await getMcpGovernedTool(record.toolId, { tenantId: securityContext.tenantId }) ||
      await getOpenApiGovernedTool(record.toolId, { tenantId: securityContext.tenantId });
    // A rejection is a trust signal: it resets the action class's clean streak.
    await recordActionOutcome({
      actionClass: actionClassFor(record.toolId),
      toolId: record.toolId,
      tenantId: securityContext.tenantId,
      kind: "rejected",
      reversible: rejectedTool?.reversible ?? false,
      riskLevel: record.riskLevel,
      humanApproved: false,
    }).catch(() => undefined);
    const continuation = await rejectAgentRunApproval({
      executionId: record.id,
      tenantId: securityContext.tenantId,
      reason: parsed.data.reason,
    });
    const resumeJobs = await wakeOperationJobByDedupeKey(
      getAgentResumeJobDedupeKey(record.id),
      { tenantId: securityContext.tenantId },
    );
    return Response.json({
      record: publicToolExecution(rejected),
      result: null,
      continuation: {
        ...continuation,
        scheduled: false,
        reconciliationJobs: resumeJobs.length,
      },
    });
  }

  // Risk-3 tools need a quorum of distinct admin approvals before execution.
  if (record.riskLevel >= 3) {
    if (securityContext.role !== "admin" && securityContext.role !== "system") {
      return Response.json(
        { error: "Risk 3 approvals require an admin role." },
        { status: 403 },
      );
    }
    if (record.actorId && securityContext.actorId === record.actorId) {
      return Response.json(
        { error: "The requester cannot approve their own risk 3 execution." },
        { status: 403 },
      );
    }

  }

  const claimToken = randomUUID();
  const claim = await approveAndClaimToolExecution({
    id: record.id,
    tenantId: securityContext.tenantId,
    approvedBy: securityContext.actorId,
    approvedRole: securityContext.role,
    approvalReason: parsed.data.reason,
    claimToken,
  });
  if (claim.outcome === "not_found") {
    return Response.json({ error: "Tool approval record not found." }, { status: 404 });
  }
  if (claim.outcome === "conflict" || !claim.record) {
    const recovered = claim.record?.status === "executing"
      ? await recoverStaleToolExecutionClaim(record.id, { tenantId: securityContext.tenantId })
      : undefined;
    return Response.json(
      {
        error: recovered
          ? "A stale execution claim was recovered without replaying its side effect."
          : "Tool approval record is not pending.",
        status: recovered?.status || claim.record?.status,
        record: recovered
          ? publicToolExecution(recovered)
          : claim.record
            ? publicToolExecution(claim.record)
            : undefined,
      },
      { status: 409 },
    );
  }
  if (claim.outcome === "pending") {
    const have = new Set(
      (claim.record.approvals || [])
        .filter((approval) => approval.role === "admin" || approval.role === "system")
        .map((approval) => approval.by),
    ).size;
    return Response.json(
      {
        record: publicToolExecution(claim.record),
        result: null,
        quorum: {
          have,
          need: RISK3_QUORUM,
          message: `Approval recorded. ${Math.max(0, RISK3_QUORUM - have)} more distinct admin approval(s) required.`,
        },
      },
      { status: 202 },
    );
  }

  let approvedInput: Record<string, unknown>;
  try {
    approvedInput = openToolExecutionInput(claim.record);
  } catch {
    const failed = await failClaimedToolExecution({
      record: claim.record,
      claimToken,
      reason:
        "Approved execution payload is missing or failed integrity verification. Submit the action again.",
    });
    return Response.json(
      {
        error:
          "The approved action could not be verified and was not executed. Submit the action again.",
        record: failed ? publicToolExecution(failed) : undefined,
      },
      { status: 409 },
    );
  }

  const waitingRun = await findAgentRunWaitingForToolApproval(
    claim.record.id,
    { tenantId: securityContext.tenantId },
  );
  const waitingContext = waitingRun?.continuation?.context;

  const result = await executeGovernedTool({
    toolId: claim.record.toolId,
    input: approvedInput,
    dryRun: false,
    approved: true,
    context: securityContext,
    existingRecord: claim.record,
    approvalReason: parsed.data.reason,
    executionClaimToken: claimToken,
    mcpSessionScope: waitingRun && waitingContext
      ? {
          tenantId: waitingContext.tenantId,
          actorId: waitingContext.actorId,
          executionId: `agent:${waitingRun.id}`,
        }
      : undefined,
  });

  const resumeJobs = await wakeOperationJobByDedupeKey(
    getAgentResumeJobDedupeKey(claim.record.id),
    { tenantId: securityContext.tenantId },
  );
  const continuation = {
    scheduled: true,
    status: "queued" as const,
    resumeJobs: resumeJobs.length,
  };

  // The approval decision and durable execution claim both succeeded even when
  // the downstream tool reports a failed outcome. Return the record as a
  // completed decision so clients do not retry the side effect.
  return Response.json({
    ...result,
    record: publicToolExecution(result.record),
    continuation,
  });
}
