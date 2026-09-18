import { describe, expect, it, vi } from "vitest";

import { createTypeSafeSemanticDecisionProvider } from "@/lib/semantic-decisions/typesafe-provider";

const apiKey = "typesafe-test-key-never-use-in-production";

describe("TypeSafe semantic decision provider", () => {
  it("sends the exact configured model and validates a typed choice response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "jev-release-2026-09-18",
      answers: {
        execution_shape: {
          type: "choice",
          choice: "direct",
          confidence: 0.83,
          probabilities: {
            direct: 0.83,
            durable_workflow: 0.12,
            clarify: 0.05,
          },
        },
      },
      usage: { input_tokens: 41, output_tokens: 8 },
    }), {
      status: 200,
      headers: { "x-request-id": "typesafe-request-1" },
    }));
    const provider = createTypeSafeSemanticDecisionProvider({ apiKey, fetchImpl });

    const result = await provider.decide({
      model: "jev-configured-by-settings",
      state: { current_request: "Summarize this note." },
      question: {
        id: "execution_shape",
        criteria: {
          direct: "One bounded run.",
          durable_workflow: "Durable multi-stage work.",
          clarify: "Essential input is missing.",
        },
      },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      model: "jev-release-2026-09-18",
      answer: {
        choice: "direct",
        confidence: 0.83,
        probabilities: {
          direct: 0.83,
          durable_workflow: 0.12,
          clarify: 0.05,
        },
      },
      usage: { inputTokens: 41, outputTokens: 8 },
      providerRequestId: "typesafe-request-1",
    });
    const [, request] = fetchImpl.mock.calls[0];
    const payload = JSON.parse(String(request?.body));
    expect(payload.model).toBe("jev-configured-by-settings");
    expect(payload.questions.execution_shape.type).toBe("choice");
    expect(request?.headers).toEqual(expect.objectContaining({
      authorization: `Bearer ${apiKey}`,
    }));
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("rejects schema drift and incomplete probability maps", async () => {
    const provider = createTypeSafeSemanticDecisionProvider({
      apiKey,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        model: "jev-release-2026-09-18",
        answers: {
          execution_shape: {
            type: "choice",
            choice: "direct",
            confidence: 0.9,
            probabilities: { direct: 0.9, clarify: 0.1 },
          },
        },
        usage: { input_tokens: 20, output_tokens: 5 },
      }), { status: 200 })),
    });

    await expect(provider.decide({
      model: "jev-configured-by-settings",
      state: "classify",
      question: {
        id: "execution_shape",
        criteria: {
          direct: "One bounded run.",
          durable_workflow: "Durable work.",
          clarify: "Missing input.",
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});
