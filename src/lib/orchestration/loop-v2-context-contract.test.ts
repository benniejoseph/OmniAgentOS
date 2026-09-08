import { describe, expect, it } from "vitest";

import {
  buildLoopV2ContextBindingV1,
  parseLoopV2ContextBindingV1,
} from "@/lib/orchestration/loop-v2-context-contract";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const digest = (value: unknown) => sourceContractSha256(value);

describe("Loop v2 context binding", () => {
  it("binds a conversation-only scope without inventing retrieval authority", () => {
    const binding = buildLoopV2ContextBindingV1({
      ...base(),
      contextScope: "session",
      authoritySha256: digest("session"),
      selectedEvidenceIds: [],
    });

    expect(parseLoopV2ContextBindingV1(binding)).toMatchObject({
      authorityKind: "conversation",
      contextScope: "session",
      selectedItemCount: 0,
      contextBudgetReceiptSha256: null,
      selectionSha256: null,
    });
  });

  it("requires the reviewed selection and durable budget for explicit context", () => {
    const binding = buildLoopV2ContextBindingV1({
      ...base(),
      contextScope: "explicit_selection",
      authoritySha256: digest("selection-authority"),
      selectedEvidenceIds: ["memory:a"],
      contextBudgetReceiptSha256: digest("budget"),
      selectionSha256: digest("selection"),
    });

    expect(binding).toMatchObject({
      authorityKind: "reviewed_selection",
      selectedItemCount: 1,
    });
    expect(() => parseLoopV2ContextBindingV1({
      ...binding,
      selectedItemCount: 2,
    })).toThrow(/digest/i);
    expect(() => buildLoopV2ContextBindingV1({
      ...base(),
      contextScope: "explicit_selection",
      authoritySha256: digest("selection-authority"),
      selectedEvidenceIds: ["memory:a"],
      contextBudgetReceiptSha256: digest("budget"),
    })).toThrow(/selection digest/i);
  });

  it("binds personal retrieval to standing consent authority", () => {
    const binding = buildLoopV2ContextBindingV1({
      ...base(),
      contextScope: "personal",
      authoritySha256: digest("personal-consent-authority"),
      selectedEvidenceIds: ["memory:a"],
      contextBudgetReceiptSha256: digest("budget"),
    });

    expect(binding).toMatchObject({
      authorityKind: "personal_standing_consent",
      selectedItemCount: 1,
      selectionSha256: null,
    });
  });
});

function base() {
  const executionScope = createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "run-a",
    purpose: "agent.loop.v2.context_text_canary",
  });
  return {
    tenantId: "tenant-a",
    runId: "run-a",
    ownerActorId: "actor-a",
    agentPrincipalId: "atlas",
    executionScope,
    querySha256: digest("query"),
    conversationSha256: digest("conversation"),
    contextManifestSha256: digest("manifest"),
    compiledContextSha256: digest("compiled"),
    boundAt: "2026-09-08T00:00:00.000Z",
  };
}
