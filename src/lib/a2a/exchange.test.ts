import { describe, expect, it } from "vitest";

import {
  buildA2AExchangeV1,
  parseA2AExchangeV1,
} from "@/lib/a2a/exchange";

describe("A2A exchange record", () => {
  it("preserves bounded external messages as untrusted non-authority data", () => {
    const exchange = buildA2AExchangeV1({
      ...base(),
      payload: {
        type: "message",
        message: {
          messageId: "message:1",
          taskId: "task:1",
          contextId: "context:1",
          role: "ROLE_USER",
          parts: [{ text: "Untrusted peer instruction.", mediaType: "text/plain" }],
        },
      },
    });
    expect(exchange.untrusted).toBe(true);
    expect(exchange.authorityImpact).toBe("none");
    expect(exchange.exchangeId).toMatch(/^a2a-exchange:[a-f0-9]{64}$/);
  });

  it("accepts bounded artifacts and statuses", () => {
    expect(buildA2AExchangeV1({
      ...base(),
      payload: {
        type: "artifact",
        artifact: {
          artifactId: "artifact:1",
          parts: [{ data: { finding: "bounded" }, mediaType: "application/json" }],
        },
      },
    }).payload.type).toBe("artifact");
    expect(buildA2AExchangeV1({
      ...base(),
      payload: {
        type: "status",
        status: { state: "TASK_STATE_WORKING" },
      },
    }).payload.type).toBe("status");
  });

  it("rejects mutation even when only external content changes", () => {
    const exchange = buildA2AExchangeV1({
      ...base(),
      payload: {
        type: "status",
        status: { state: "TASK_STATE_SUBMITTED" },
      },
    });
    expect(() => parseA2AExchangeV1({
      ...exchange,
      payload: {
        type: "status",
        status: { state: "TASK_STATE_COMPLETED" },
      },
    })).toThrow(/integrity/i);
  });
});

function base() {
  return {
    tenantId: "tenant:1",
    ownerActorId: "actor:1",
    peerId: "peer:1",
    mappingId: `a2a-task-map:${"a".repeat(64)}`,
    externalTaskId: "task:1",
    direction: "inbound" as const,
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}
