import { after } from "next/server";
import { z } from "zod";
import {
  applyObservabilitySloPolicyChange,
  getObservabilitySloPolicyChange,
  rejectObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import { rejectAgentRunApproval, resumeAgentRunAfterToolApproval } from "@/lib/orchestration/agent-runner";
import { getToolExecution, saveToolExecution } from "@/lib/tools/audit-store";
import { executeGovernedTool, hasRisk3Quorum } from "@/lib/tools/executor";
import { RISK3_QUORUM } from "@/lib/tools/types";
import { actionClassFor, recordActionOutcome } from "@/lib/trust/ledger";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { signalWorkflowRun } from "@/lib/workflows/runner";

export const runtime = "nodejs";

const approvalDecisionSchema = z.object({
  kind: z.enum(["tool", "workflow", "slo_policy"]),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(1000).optional(),
  breakGlass: z.boolean().optional(),
  ticket: z.string().max(120).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
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
        metadata: parsed.data,
      });
      const signal = parsed.data.decision === "approve" ? "approve" : "cancel";
      const detail = await signalWorkflowRun(id, signal, { tenantId: securityContext.tenantId });
      if (signal === "approve") {
        const queueJob = await enqueueWorkflowRunTick(id, "workflow_approval");
        scheduleWorkflowQueueDrain();
        return Response.json({ ...detail, queueJob });
      }
      const canceledJobs = await cancelWorkflowRunTick(id, "Workflow approval rejected.");
      return Response.json({ ...detail, canceledJobs });
    } catch (error) {
      try {
        return forbiddenResponse(error);
      } catch {
        return Response.json(
          { error: error instanceof Error ? error.message : "Workflow approval decision failed." },
          { status: 404 },
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

    return Response.json(result);
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
    return Response.json(
      { error: "Tool approval record is not pending.", status: record.status },
      { status: 409 },
    );
  }

  if (parsed.data.decision === "reject") {
    const now = new Date().toISOString();
    const rejected = await saveToolExecution({
      ...record,
      status: "rejected",
      approvalDecision: "rejected",
      approvedBy: securityContext.actorId,
      approvedAt: now,
      approvalReason: parsed.data.reason,
      reason: parsed.data.reason ? `Rejected: ${parsed.data.reason}` : "Rejected by operator.",
      completedAt: now,
    });
    // A rejection is a trust signal: it resets the action class's clean streak.
    await recordActionOutcome({
      actionClass: actionClassFor(record.toolId),
      toolId: record.toolId,
      tenantId: securityContext.tenantId,
      kind: "rejected",
      reversible: false,
      riskLevel: record.riskLevel,
      humanApproved: false,
    }).catch(() => undefined);
    const continuation = await rejectAgentRunApproval({
      executionId: record.id,
      tenantId: securityContext.tenantId,
      reason: parsed.data.reason,
    });
    return Response.json({ record: rejected, result: null, continuation });
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

    const approvals = [
      ...(record.approvals || []).filter((approval) => approval.by !== securityContext.actorId),
      {
        by: securityContext.actorId,
        role: securityContext.role,
        at: new Date().toISOString(),
        reason: parsed.data.reason,
      },
    ];
    const pendingRecord = await saveToolExecution({ ...record, approvals });

    if (!hasRisk3Quorum(pendingRecord)) {
      return Response.json(
        {
          record: pendingRecord,
          result: null,
          quorum: {
            have: approvals.length,
            need: RISK3_QUORUM,
            message: `Approval recorded. ${RISK3_QUORUM - approvals.length} more distinct admin approval(s) required.`,
          },
        },
        { status: 202 },
      );
    }

    const quorumResult = await executeGovernedTool({
      toolId: pendingRecord.toolId,
      input: pendingRecord.input,
      dryRun: false,
      approved: true,
      context: securityContext,
      existingRecord: pendingRecord,
      approvalReason: parsed.data.reason,
    });
    const continuation = scheduleAgentRunResume({
      executionId: pendingRecord.id,
      toolExecution: quorumResult,
      tenantId: securityContext.tenantId,
    });
    return Response.json({ ...quorumResult, continuation }, {
      status: quorumResult.record.status === "failed" ? 500 : 200,
    });
  }

  const result = await executeGovernedTool({
    toolId: record.toolId,
    input: record.input,
    dryRun: false,
    approved: true,
    context: securityContext,
    existingRecord: record,
    approvalReason: parsed.data.reason,
  });

  const continuation = scheduleAgentRunResume({
    executionId: record.id,
    toolExecution: result,
    tenantId: securityContext.tenantId,
  });

  return Response.json({ ...result, continuation }, {
    status: result.record.status === "failed" ? 500 : 200,
  });
}

/**
 * The remaining agent run can span many model turns, so it must not block the
 * approver's request (or run into the function timeout mid-stream). after()
 * keeps the function alive past the response while the run continues.
 */
function scheduleAgentRunResume(input: {
  executionId: string;
  toolExecution: { record: Parameters<typeof resumeAgentRunAfterToolApproval>[0]["toolExecution"]["record"]; result?: unknown };
  tenantId?: string;
}) {
  after(async () => {
    try {
      const outcome = await resumeAgentRunAfterToolApproval(input);
      console.log("Agent run resume finished.", JSON.stringify(outcome));
    } catch (error) {
      console.error(
        "Agent run resume crashed.",
        error instanceof Error ? error.message : error,
      );
    }
  });
  return { scheduled: true, status: "resuming" as const };
}
