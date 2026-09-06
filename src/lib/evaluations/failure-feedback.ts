import { redactSensitive } from "@/lib/security/context";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type {
  EvalCaseDefinition,
  EvalResultRecord,
} from "@/lib/evaluations/types";

export const RECURRING_FAILURE_THRESHOLD = 2;
export const FAILURE_RESOLUTION_PASS_THRESHOLD = 2;

export type EvaluationFailureCategory =
  | "timeout"
  | "schema_validation"
  | "authorization"
  | "isolation"
  | "approval"
  | "tool_contract"
  | "verification"
  | "instruction_contract"
  | "recovery"
  | "provider"
  | "evaluator_failure";

export type HarnessRuleKind =
  | "evaluation_case"
  | "tool_contract"
  | "prompt_change"
  | "workflow_guard"
  | "architecture_constraint"
  | "runbook";

export type MinimizedReplayCaseV1 = {
  schemaVersion: 1;
  lane: "governed_evaluation";
  suite: string;
  caseId: string;
  caseType: EvalCaseDefinition["type"];
  caseDefinitionSha256: string;
  failureCategory: EvaluationFailureCategory;
  failureSignalSha256: string;
  inputShape: JsonShape;
  expectedKeys: string[];
  replay: {
    selector: "case_id_and_definition_digest";
    mutationAuthority: "not_inherited";
  };
};

export type HarnessRuleProposalV1 = {
  schemaVersion: 1;
  kind: HarnessRuleKind;
  target: string;
  failureCategory: EvaluationFailureCategory;
  replayCaseSha256: string;
  reviewRequired: true;
  automaticApplication: false;
  change: {
    operation:
      | "add_regression_assertion"
      | "tighten_tool_contract"
      | "review_instruction_contract"
      | "add_bounded_runtime_guard"
      | "preserve_security_boundary"
      | "document_recovery_procedure";
    scope: string;
  };
};

type JsonShape =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | { array: JsonShape | "empty" }
  | { object: Record<string, JsonShape | "depth_limited"> };

export function classifyEvaluationFailure(
  result: Pick<EvalResultRecord, "error" | "output">,
): EvaluationFailureCategory {
  const signal = failureSignal(result);
  if (/timeout|timed out|abort(?:ed)?/.test(signal)) return "timeout";
  if (/zod|json schema|schema validation|invalid (?:json|contract)|too_small|too_big/.test(signal)) {
    return "schema_validation";
  }
  if (/tenant|cross[- ]tenant|actor scope|row[- ]level|\brls\b|isolation/.test(signal)) {
    return "isolation";
  }
  if (/unauthori[sz]ed|forbidden|permission|authentication|policy block/.test(signal)) {
    return "authorization";
  }
  if (/approval|quorum|review required/.test(signal)) return "approval";
  if (/tool (?:input|output|contract|schema)|unknown tool|governed tool/.test(signal)) {
    return "tool_contract";
  }
  if (/verification|assert(?:ion)?|expected|mismatch|did not verify/.test(signal)) {
    return "verification";
  }
  if (/instruction|exact output|formatting|response format/.test(signal)) {
    return "instruction_contract";
  }
  if (/lease|checkpoint|resume|retry|replan|queue|interrupted/.test(signal)) {
    return "recovery";
  }
  if (/openai|anthropic|gemini|bedrock|model provider|provider unavailable/.test(signal)) {
    return "provider";
  }
  return "evaluator_failure";
}

export function buildMinimizedReplayCase({
  suite,
  evalCase,
  result,
}: {
  suite: string;
  evalCase: EvalCaseDefinition;
  result: Pick<EvalResultRecord, "error" | "output">;
}): MinimizedReplayCaseV1 {
  const failureCategory = classifyEvaluationFailure(result);
  return {
    schemaVersion: 1,
    lane: "governed_evaluation",
    suite: boundedIdentifier(suite, "core", 80),
    caseId: boundedIdentifier(evalCase.id, "unknown-case", 120),
    caseType: evalCase.type,
    caseDefinitionSha256: canonicalJsonSha256(evalCase),
    failureCategory,
    failureSignalSha256: canonicalJsonSha256({
      category: failureCategory,
      signal: normalizedFailureSignal(result),
    }),
    inputShape: jsonShape(evalCase.input),
    expectedKeys: Object.keys(evalCase.expected).sort().slice(0, 64),
    replay: {
      selector: "case_id_and_definition_digest",
      mutationAuthority: "not_inherited",
    },
  };
}

export function failureClusterFingerprint(
  replayCase: MinimizedReplayCaseV1,
): string {
  return canonicalJsonSha256({
    schemaVersion: replayCase.schemaVersion,
    lane: replayCase.lane,
    caseId: replayCase.caseId,
    caseDefinitionSha256: replayCase.caseDefinitionSha256,
    failureCategory: replayCase.failureCategory,
  });
}

export function buildHarnessRuleProposal(
  replayCase: MinimizedReplayCaseV1,
): HarnessRuleProposalV1 {
  const replayCaseSha256 = canonicalJsonSha256(replayCase);
  const selected = proposalTarget(replayCase);
  return {
    schemaVersion: 1,
    kind: selected.kind,
    target: selected.target,
    failureCategory: replayCase.failureCategory,
    replayCaseSha256,
    reviewRequired: true,
    automaticApplication: false,
    change: {
      operation: selected.operation,
      scope: replayCase.caseId,
    },
  };
}

function proposalTarget(replayCase: MinimizedReplayCaseV1): Pick<
  HarnessRuleProposalV1,
  "kind" | "target"
> & { operation: HarnessRuleProposalV1["change"]["operation"] } {
  switch (replayCase.failureCategory) {
    case "schema_validation":
    case "tool_contract":
      return {
        kind: "tool_contract",
        target: `evaluation:${replayCase.caseId}:contract`,
        operation: "tighten_tool_contract",
      };
    case "instruction_contract":
      return {
        kind: "prompt_change",
        target: `evaluation:${replayCase.caseId}:instructions`,
        operation: "review_instruction_contract",
      };
    case "timeout":
    case "recovery":
      return {
        kind: "workflow_guard",
        target: `evaluation:${replayCase.caseId}:runtime`,
        operation: "add_bounded_runtime_guard",
      };
    case "authorization":
    case "isolation":
    case "approval":
      return {
        kind: "architecture_constraint",
        target: `evaluation:${replayCase.caseId}:security`,
        operation: "preserve_security_boundary",
      };
    case "provider":
      return {
        kind: "runbook",
        target: "models:provider-recovery",
        operation: "document_recovery_procedure",
      };
    case "verification":
    case "evaluator_failure":
      return {
        kind: "evaluation_case",
        target: `evaluation:${replayCase.caseId}:assertions`,
        operation: "add_regression_assertion",
      };
  }
}

function failureSignal(result: Pick<EvalResultRecord, "error" | "output">) {
  return `${result.error || ""}\n${JSON.stringify(result.output || {})}`
    .toLowerCase()
    .slice(0, 12_000);
}

function normalizedFailureSignal(
  result: Pick<EvalResultRecord, "error" | "output">,
) {
  return String(redactSensitive(failureSignal(result)))
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function jsonShape(value: unknown, depth = 0): JsonShape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { array: value.length ? jsonShape(value[0], depth + 1) : "empty" };
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return {
      object: Object.fromEntries(
        Object.keys(object)
          .sort()
          .slice(0, 64)
          .map((key) => [
            key.slice(0, 120),
            depth >= 3 ? "depth_limited" : jsonShape(object[key], depth + 1),
          ]),
      ),
    };
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function boundedIdentifier(value: string, fallback: string, maxLength: number) {
  return value.trim().slice(0, maxLength) || fallback;
}
