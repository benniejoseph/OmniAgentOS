import { defaultEvalCases, summarizeEvaluationGovernance } from "@/lib/evaluations/runner";
import { getEvalRunDetail } from "@/lib/evaluations/store";
import { listObservabilityEvents } from "@/lib/observability/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = await getEvalRunDetail(id);

  if (!detail) {
    return Response.json({ error: "Evaluation run not found." }, { status: 404 });
  }

  const caseDefinitions = new Map(defaultEvalCases.map((evalCase) => [evalCase.id, evalCase]));
  const selectedCases = detail.results
    .map((result) => caseDefinitions.get(result.caseId))
    .filter((evalCase): evalCase is NonNullable<typeof evalCase> => Boolean(evalCase));
  const events = await listObservabilityEvents({
    category: "evaluation",
    action: "evaluation.run",
    resourceType: "evaluation",
    resourceId: id,
    limit: 5,
  });
  const runEvent = events[0];
  const metadata = runEvent?.metadata || {};
  const governance = readRecord(metadata.governance) || summarizeEvaluationGovernance(selectedCases);
  const override = readRecord(metadata.override);
  const caseEvidence = detail.results.map((result) => {
    const definition = caseDefinitions.get(result.caseId);

    return {
      result,
      definition,
      governance: definition?.governance,
    };
  });

  return Response.json({
    ...detail,
    governance,
    override,
    caseEvidence,
    events,
  });
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
