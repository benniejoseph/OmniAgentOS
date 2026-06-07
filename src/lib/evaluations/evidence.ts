import { defaultEvalCases, summarizeEvaluationGovernance, type EvalGovernanceSummary } from "@/lib/evaluations/runner";
import { getEvalRunDetail } from "@/lib/evaluations/store";
import type { EvalCaseDefinition, EvalCaseGovernance, EvalResultRecord, EvalRunDetail } from "@/lib/evaluations/types";
import { listObservabilityEvents, type ObservabilityEventRecord } from "@/lib/observability/store";

export type EvalCaseEvidence = {
  result: EvalResultRecord;
  definition?: EvalCaseDefinition;
  governance?: EvalCaseGovernance;
};

export type EvalRunEvidenceBundle = EvalRunDetail & {
  governance: EvalGovernanceSummary | Record<string, unknown>;
  override?: Record<string, unknown>;
  caseEvidence: EvalCaseEvidence[];
  events: ObservabilityEventRecord[];
};

export async function getEvaluationEvidenceBundle(
  runId: string,
  options: { tenantId?: string } = {},
): Promise<EvalRunEvidenceBundle | null> {
  const detail = await getEvalRunDetail(runId, options);

  if (!detail) {
    return null;
  }

  const caseDefinitions = new Map(defaultEvalCases.map((evalCase) => [evalCase.id, evalCase]));
  const selectedCases = detail.results
    .map((result) => caseDefinitions.get(result.caseId))
    .filter((evalCase): evalCase is EvalCaseDefinition => Boolean(evalCase));
  const events = await listObservabilityEvents({
    category: "evaluation",
    action: "evaluation.run",
    resourceType: "evaluation",
    resourceId: runId,
    tenantId: options.tenantId,
    limit: 5,
  });
  const metadata = events[0]?.metadata || {};
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

  return {
    ...detail,
    governance,
    override,
    caseEvidence,
    events,
  };
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
