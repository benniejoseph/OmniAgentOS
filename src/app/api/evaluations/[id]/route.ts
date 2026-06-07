import { getEvaluationEvidenceBundle } from "@/lib/evaluations/evidence";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const detail = await getEvaluationEvidenceBundle(id, { tenantId: securityContext.tenantId });

  if (!detail) {
    return Response.json({ error: "Evaluation run not found." }, { status: 404 });
  }

  return Response.json(detail);
}
