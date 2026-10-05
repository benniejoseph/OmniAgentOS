const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const NON_EXHAUSTED = new Set(["insufficient", "within", "recovering"]);

// The full report stays in memory. Only these bounded, non-secret fields are
// copied into the local release artifact for forward-schema admission.
export function selectedErrorBudgetProof(gate) {
  const details = record(gate?.details) ? gate.details : {};
  const exception = record(details.exception) ? details.exception : {};
  return {
    measured: details.measured === true ? true : details.measured === false ? false : null,
    exception: {
      reason: boundedString(exception.reason, 200),
      applied: typeof exception.applied === "boolean" ? exception.applied : null,
    },
    objectives: Array.isArray(details.objectives)
      ? details.objectives.slice(0, 3).map((item) => ({
          id: boundedString(item?.id, 30),
          objective: Number.isFinite(item?.objective) ? item.objective : null,
          verdict: boundedString(item?.verdict, 30),
        }))
      : null,
  };
}

export function isSafeErrorBudgetProof(proof, expectedReason) {
  if (!validReason(expectedReason) || !exactKeys(proof, ["measured", "exception", "objectives"]) ||
    proof.measured !== true || !exactKeys(proof.exception, ["reason", "applied"]) ||
    proof.exception.reason !== expectedReason) {
    return false;
  }
  const objectives = objectiveMap(proof.objectives);
  const runs = objectives?.get("agent_runs");
  const tools = objectives?.get("tool_calls");
  if (runs?.objective !== 0.95 || tools?.objective !== 0.9 ||
    !NON_EXHAUSTED.has(tools.verdict)) return false;
  if (proof.exception.applied === true) return runs.verdict === "exhausted";
  if (proof.exception.applied === false) return NON_EXHAUSTED.has(runs.verdict);
  return false;
}

export function isSafeReleaseErrorBudgetException(gate, expectedReason) {
  if (!expectedReason) return gate?.details?.exception === undefined;
  return isSafeErrorBudgetProof(selectedErrorBudgetProof(gate), expectedReason);
}

function objectiveMap(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const objectives = new Map();
  for (const item of value) {
    if (!exactKeys(item, ["id", "objective", "verdict"]) ||
      (item.id !== "agent_runs" && item.id !== "tool_calls") || objectives.has(item.id)) {
      return undefined;
    }
    objectives.set(item.id, item);
  }
  return objectives;
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !CONTROL_CHARACTERS.test(value) ? value : null;
}
function validReason(value) { return boundedString(value, 200) === value; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
