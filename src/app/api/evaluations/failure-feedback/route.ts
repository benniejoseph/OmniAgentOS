import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  HarnessRuleReviewConflictError,
  listEvaluationFailureFeedback,
  reviewHarnessRuleProposal,
} from "@/lib/evaluations/failure-feedback-store";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const reviewSchema = z.object({
  proposalId: z.string().trim().min(1).max(240),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(12).max(500),
}).strict();

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
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid harness rule review", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: "harness_rule_proposal",
      resourceId: parsed.data.proposalId,
      metadata: {
        decision: parsed.data.decision,
        automaticApplication: false,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
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
    if (error instanceof HarnessRuleReviewConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
