export type ModelRouteDegradedEvent = {
  type: "model_route_degraded";
  outcome?: "blocked" | "deployment_environment";
  code?: string;
  message?: string;
};

/** How the run view shows a workspace model route that could not be used as saved. */
export function modelRouteDegradedActivity(event: ModelRouteDegradedEvent) {
  const blocked = event.outcome === "blocked";
  return {
    title: blocked ? "Model route blocked" : "Model route degraded",
    detail: event.message || (blocked
      ? "The workspace model route could not be used, so no model was called."
      : "The workspace model route could not be used, so the deployment's models ran instead."),
    tone: blocked ? "bg-danger" : "bg-warning",
  } as const;
}
