import { describe, expect, it } from "vitest";
import { modelRouteDegradedActivity } from "@/components/model-route-degraded";

describe("model route degraded activity", () => {
  it("shows a stopped route as blocked, in the run's own words", () => {
    expect(modelRouteDegradedActivity({
      type: "model_route_degraded",
      outcome: "blocked",
      code: "credential_unavailable",
      message: "The assigned workspace credential could not be opened, so no model was called.",
    })).toEqual({
      title: "Model route blocked",
      detail: "The assigned workspace credential could not be opened, so no model was called.",
      tone: "bg-danger",
    });
  });

  it("shows a stand-in route as degraded", () => {
    expect(modelRouteDegradedActivity({
      type: "model_route_degraded",
      outcome: "deployment_environment",
      code: "route_inactive",
      message: "The saved route is a legacy or unvalidated configuration, so deployment-environment routing remains in effect.",
    })).toEqual({
      title: "Model route degraded",
      detail: "The saved route is a legacy or unvalidated configuration, so deployment-environment routing remains in effect.",
      tone: "bg-warning",
    });
  });

  it("explains a stored event whose message was kept only as a hash", () => {
    expect(modelRouteDegradedActivity({
      type: "model_route_degraded",
      outcome: "blocked",
    }).detail).toBe(
      "The workspace model route could not be used, so no model was called.",
    );
    expect(modelRouteDegradedActivity({
      type: "model_route_degraded",
      outcome: "deployment_environment",
    }).detail).toBe(
      "The workspace model route could not be used, so the deployment's models ran instead.",
    );
  });
});
