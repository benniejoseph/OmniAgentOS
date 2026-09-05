import { describe, expect, it } from "vitest";
import { openAIHealthComponent } from "@/lib/diagnostics/health";

const checkedAt = "2026-09-05T06:00:00.000Z";

describe("OpenAI diagnostics", () => {
  it("requires authenticated readiness before reporting healthy", () => {
    expect(openAIHealthComponent({
      configured: true,
      reachable: true,
      model: "gpt-5",
      checkedAt,
    })).toMatchObject({
      status: "healthy",
      metrics: { configured: true, reachable: true },
    });

    expect(openAIHealthComponent({
      configured: true,
      reachable: false,
      model: "gpt-5",
      checkedAt,
      error: "401 Incorrect API key provided: sk-sensitive",
    })).toEqual({
      id: "openai",
      name: "OpenAI",
      status: "degraded",
      summary: "OpenAI is configured but its authenticated model-readiness check failed.",
      metrics: {
        configured: true,
        reachable: false,
        model: "gpt-5",
        checkedAt,
        failureKind: "authentication",
      },
    });
  });

  it("does not persist provider error text in health projections", () => {
    const component = openAIHealthComponent({
      configured: true,
      reachable: false,
      model: "gpt-5",
      checkedAt,
      error: "upstream included private-token-material",
    });

    expect(JSON.stringify(component)).not.toContain("private-token-material");
    expect(component.metrics.failureKind).toBe("provider_unavailable");
  });
});
