import { z } from "zod";
import {
  applyObservabilitySloPolicyChange,
  getObservabilitySloPolicyChange,
  rejectObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import { getToolExecution, saveToolExecution } from "@/lib/tools/audit-store";
import { executeGovernedTool } from "@/lib/tools/executor";
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
      await authorizeRequest({
        request,
        action: "manage.workflow",
        resourceType: "workflow",
        resourceId: id,
        metadata: parsed.data,
      });
      const signal = parsed.data.decision === "approve" ? "approve" : "cancel";
      const detail = await signalWorkflowRun(id, signal);
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
    const change = await getObservabilitySloPolicyChange(id);
    if (!change) {
      return Response.json({ error: "SLO policy change approval record not found." }, { status: 404 });
    }
    if (change.status !== "pending") {
      return Response.json(
        { error: "SLO policy change is not pending.", status: change.status },
        { status: 409 },
      );
    }

    let securityContext;
    try {
      securityContext = await authorizeRequest({
        request,
        action: "manage.workflow",
        resourceType: "observability_slo_policy_change",
        resourceId: id,
        riskLevel: change.riskLevel,
        metadata: { policyId: change.policyId, action: change.action, decision: parsed.data.decision },
      });
    } catch (error) {
      return forbiddenResponse(error);
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

  const record = await getToolExecution(id);
  if (!record) {
    return Response.json({ error: "Tool approval record not found." }, { status: 404 });
  }

  if (record.status !== "approval_required") {
    return Response.json(
      { error: "Tool approval record is not pending.", status: record.status },
      { status: 409 },
    );
  }

  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "execute.tool",
      resourceType: "tool_execution",
      resourceId: id,
      metadata: { toolId: record.toolId, decision: parsed.data.decision },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  if (parsed.data.decision === "reject") {
    const now = new Date().toISOString();
    return Response.json({
      record: await saveToolExecution({
        ...record,
        status: "rejected",
        approvalDecision: "rejected",
        approvedBy: securityContext.actorId,
        approvedAt: now,
        approvalReason: parsed.data.reason,
        reason: parsed.data.reason ? `Rejected: ${parsed.data.reason}` : "Rejected by operator.",
        completedAt: now,
      }),
      result: null,
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

  return Response.json(result, {
    status: result.record.status === "failed" ? 500 : 200,
  });
}
