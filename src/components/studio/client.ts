import {
  studioGraphSchema,
  studioViewportSchema,
  type StudioFlow,
  type StudioRun,
} from "@/lib/studio/contracts";

export {
  StudioClient,
  StudioResponseError,
  StudioScopeChanged,
  StudioRequestTimeout,
  errorMessage,
  uncertainFailure,
} from "./transport";

export function readFlow(value: unknown): StudioFlow {
  const v = value as StudioFlow;
  if (
    !v ||
    typeof v.id !== "string" ||
    typeof v.name !== "string" ||
    !Number.isInteger(v.revision) ||
    v.revision < 1 ||
    !studioGraphSchema.safeParse(v.graph).success ||
    !studioViewportSchema.safeParse(v.viewport).success
  )
    throw new Error("The saved flow is incomplete. Refresh before editing.");
  return v;
}
export function readRun(value: unknown, flowId?: string): StudioRun {
  const v = value as StudioRun;
  if (
    !v ||
    typeof v.id !== "string" ||
    (flowId && v.flowId !== flowId) ||
    !Array.isArray(v.nodes) ||
    !studioGraphSchema.safeParse(v.graph).success ||
    ![
      "queued",
      "running",
      "succeeded",
      "partial",
      "failed",
      "canceled",
      "uncertain",
    ].includes(v.status) ||
    v.nodes.some(
      (n) =>
        !n.nodeId ||
        !Array.isArray(n.outputAssets) ||
        !Array.isArray(n.attempts),
    )
  )
    throw new Error(
      "The run response did not match this flow. Refresh its history.",
    );
  return v;
}
