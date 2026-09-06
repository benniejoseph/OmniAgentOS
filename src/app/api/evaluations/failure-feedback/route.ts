import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getEvaluationFailureCluster,
  HarnessRuleReviewConflictError,
  listEvaluationFailureFeedback,
  reviewHarnessRuleProposal,
} from "@/lib/evaluations/failure-feedback-store";
import {
  defaultEvalCases,
  evaluateEvaluationGovernance,
} from "@/lib/evaluations/runner";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueEvaluationJob,
} from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("review"),
    proposalId: z.string().trim().min(1).max(240),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(12).max(500),
  }).strict(),
  z.object({
    action: z.literal("replay"),
    clusterId: z.string().trim().min(1).max(240),
  }).strict(),
]);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation_failure_feedback",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const limit = parseBoundedInteger(
    new URL(request.url).searchParams.get("limit"),
    50,
    { max: 100 },
  );
  const feedback = await listEvaluationFailureFeedback({
    tenantId: context.tenantId,
    limit,
  });
  return Response.json(feedback, {
    headers: { "cache-control": "private, no-store" },
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid failure feedback action", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: parsed.data.action === "review"
        ? "harness_rule_proposal"
        : "evaluation_failure_replay",
      resourceId: parsed.data.action === "review"
        ? parsed.data.proposalId
        : parsed.data.clusterId,
      metadata: {
        feedbackAction: parsed.data.action,
        decision: parsed.data.action === "review" ? parsed.data.decision : undefined,
        automaticApplication: false,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    if (parsed.data.action === "replay") {
      const cluster = await getEvaluationFailureCluster(parsed.data.clusterId, {
        tenantId: context.tenantId,
      });
      if (!cluster) {
        return Response.json({ error: "Failure replay cluster not found." }, { status: 404 });
      }
      const evalCase = defaultEvalCases.find((candidate) =>
        candidate.id === cluster.replayCase.caseId
      );
      if (
        !evalCase ||
        canonicalJsonSha256(evalCase) !== cluster.replayCase.caseDefinitionSha256
      ) {
        return Response.json(
          { error: "Failure replay case definition changed; review a new minimized case." },
          { status: 409 },
        );
      }
      const governance = evaluateEvaluationGovernance({
        cases: [evalCase],
        role: context.role,
        allowMutation: false,
      });
      if (!governance.allowed) {
        return Response.json(
          {
            error: "Failure replay requires explicit mutation governance.",
            violations: governance.violations,
          },
          { status: 403 },
        );
      }
      const job = await enqueueEvaluationJob({
        tenantId: context.tenantId,
        actorId: context.actorId,
        idempotencyKey: request.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined,
        request: {
          suite: `failure-replay:${cluster.id.slice(0, 48)}`,
          caseIds: [evalCase.id],
        },
      });
      return Response.json(
        {
          job: projectOperationJobStatus(job),
          replayCase: cluster.replayCase,
          mutationAuthorityInherited: false,
        },
        {
          status: 202,
          headers: {
            location: `/api/operations/jobs/${job.id}`,
            "retry-after": "2",
            "cache-control": "private, no-store",
          },
        },
      );
    }
    const proposal = await reviewHarnessRuleProposal({
      tenantId: context.tenantId,
      proposalId: parsed.data.proposalId,
      actorId: context.actorId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
    });
    return Response.json({
      proposal,
      applied: false,
      message: "Review recorded. Harness changes remain inactive until separately implemented and released.",
    });
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof HarnessRuleReviewConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
