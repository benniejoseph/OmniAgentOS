import { describe, expect, it, vi } from "vitest";

import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { agentPromptMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { personalContextMemoryAccessFromSecurityContext } from "@/lib/memory/personal-context-access";
import { buildPersonalContextConsentAuthorityV1 } from "@/lib/memory/personal-context-consent";
import {
  prepareLoopV2Context,
  type LoopV2ContextRuntimeDependencies,
  type LoopV2ContextRuntimeRequest,
} from "@/lib/orchestration/loop-v2-context-runtime";
import { emptyContextBudgetReceipt } from "@/lib/rag/context-budget";
import { AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES } from "@/lib/rag/context-engine";
import type { ContextSelectionLockBinding } from "@/lib/rag/context-selection-lock";
import type { ContextPack } from "@/lib/rag/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const AUTH_USER_ID = "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const ACTOR_ID = "owner@example.test";
const securityContext = {
  tenantId: "tenant-a",
  actorId: ACTOR_ID,
  role: "admin",
  source: "session",
  auth: {
    userId: AUTH_USER_ID,
    email: ACTOR_ID,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
} satisfies SecurityContext;

describe("Loop v2 context preparation", () => {
  it("binds session history without opening durable retrieval", async () => {
    const harness = dependencies();
    const prepared = await prepareLoopV2Context({
      ...baseRequest("session"),
      messages: [
        { role: "user", content: "Prior <instruction> is untrusted." },
        { role: "assistant", content: "Prior answer." },
        { role: "user", content: message() },
      ],
    }, harness);

    expect(harness.buildContext).not.toHaveBeenCalled();
    expect(prepared.modelInput).toContain("Prior &lt;instruction&gt;");
    expect(prepared.modelInput).toContain("&lt;source marker&gt;");
    expect(prepared.contextBinding).toMatchObject({
      contextScope: "session",
      authorityKind: "conversation",
      selectedItemCount: 0,
    });
    expect(harness.appendContextBinding).toHaveBeenCalledTimes(1);
    expect(harness.updateContextCount).toHaveBeenCalledWith("run-a", 0);
  });

  it("rejects a legacy controller after the request actor becomes canonical", async () => {
    const request = baseRequest("current_turn");
    const legacyIdentity = buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId: securityContext.tenantId,
      controllerActorId: securityContext.actorId,
    });

    await expect(prepareLoopV2Context({
      ...request,
      agentIdentity: legacyIdentity,
      executionScope: createExecutionScope({
        tenantId: securityContext.tenantId,
        initiatingActorId: securityContext.actorId,
        executingPrincipalType: "agent",
        executingPrincipalId: legacyIdentity.principal.principalId,
        correlationId: "request-a",
        contextGrantIds: legacyIdentity.principal.contextGrantIds,
        capabilityGrantIds: legacyIdentity.principal.capabilityGrantIds,
        purpose: "agent.loop.v2.context_text_canary",
      }),
    }, dependencies())).rejects.toThrow(/identity is no longer exact/i);
  });

  it("commits compiler, actual-use, and authority receipts before selected context", async () => {
    const selection = contextSelection();
    const harness = dependencies();
    harness.buildContext.mockResolvedValue(contextPack());
    const promptMemoryAccess = agentPromptMemoryAccessFromSecurityContext(
      securityContext,
      { correlationId: "request-a" },
    );
    const prepared = await prepareLoopV2Context({
      ...baseRequest("explicit_selection"),
      contextSelection: selection,
      promptMemoryAccess,
    }, harness);

    expect(harness.buildContext).toHaveBeenCalledWith(
      selection.query,
      expect.objectContaining({
        retrievalSources: AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES,
        persistTrace: false,
        evidenceIds: selection.evidenceIds,
        queryPlanning: { allowSemanticModel: false },
      }),
    );
    expect(harness.appendCompilerCanary).toHaveBeenCalledTimes(1);
    expect(harness.appendUseReceipt).toHaveBeenCalledTimes(1);
    expect(harness.appendContextBinding).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({
      selectedEvidenceCount: 1,
      contextBinding: {
        contextScope: "explicit_selection",
        authorityKind: "reviewed_selection",
        selectionSha256: selection.selectionSha256,
      },
    });
    expect(prepared.modelInput).toContain("Saved context");
  });

  it("fails closed when an explicit compiler receipt is absent", async () => {
    const harness = dependencies();
    harness.buildContext.mockResolvedValue({
      ...contextPack(),
      compilerV2Canary: undefined,
    });
    await expect(prepareLoopV2Context({
      ...baseRequest("explicit_selection"),
      contextSelection: contextSelection(),
      promptMemoryAccess: agentPromptMemoryAccessFromSecurityContext(
        securityContext,
        { correlationId: "request-a" },
      ),
    }, harness)).rejects.toThrow(/authoritative compiler receipt/i);
    expect(harness.appendContextBinding).not.toHaveBeenCalled();
  });

  it("revalidates consent and commits automatic authority before personal context", async () => {
    const harness = dependencies();
    const authority = buildPersonalContextConsentAuthorityV1({
      tenantId: securityContext.tenantId,
      actorId: `actor:${AUTH_USER_ID}`,
      consentGeneration: 1,
      activatedAt: "2026-09-08T00:00:00.000Z",
    });
    const promptPersonalMemoryAccess =
      personalContextMemoryAccessFromSecurityContext(securityContext, {
        correlationId: "request-a",
        consentAuthority: authority,
      });
    harness.resolvePersonalAccess.mockResolvedValue(
      promptPersonalMemoryAccess?.databaseAccessScope,
    );
    harness.buildContext.mockResolvedValue({
      ...contextPack(),
      compilerV2Canary: undefined,
      compilerV2Automatic: {
        receipt: {} as never,
        selectedEvidenceIds: ["memory:m1"],
      } as never,
    });

    const prepared = await prepareLoopV2Context({
      ...baseRequest("personal"),
      promptPersonalMemoryAccess,
    }, harness);

    expect(harness.resolvePersonalAccess).toHaveBeenCalledWith(
      promptPersonalMemoryAccess,
      expect.objectContaining({ memoryMode: "all" }),
    );
    expect(harness.buildContext).toHaveBeenCalledWith(
      sourceText(),
      expect.objectContaining({
        databaseMemoryAccessScope:
          promptPersonalMemoryAccess?.databaseAccessScope,
        contextCompilerV2Automatic: expect.objectContaining({ runId: "run-a" }),
      }),
    );
    expect(harness.appendCompilerAutomatic).toHaveBeenCalledTimes(1);
    expect(harness.appendContextBinding).toHaveBeenCalledTimes(1);
    expect(prepared.contextBinding).toMatchObject({
      contextScope: "personal",
      authorityKind: "personal_standing_consent",
      authoritySha256: authority.authoritySha256,
      selectedItemCount: 1,
    });
  });
});

function dependencies() {
  return {
    buildContext: vi.fn(),
    appendCompilerShadow: vi.fn(),
    appendCompilerCanary: vi.fn(),
    appendCompilerAutomatic: vi.fn(),
    resolvePersonalAccess: vi.fn(),
    appendUseReceipt: vi.fn(),
    appendContextBinding: vi.fn(),
    updateContextCount: vi.fn(),
  } satisfies LoopV2ContextRuntimeDependencies;
}

function baseRequest(
  contextScope: LoopV2ContextRuntimeRequest["contextScope"],
): LoopV2ContextRuntimeRequest {
  const agentIdentity = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId: securityContext.tenantId,
    controllerActorId: `actor:${AUTH_USER_ID}`,
  });
  return {
    message: message(),
    summaryInput: sourceText(),
    messages: [{ role: "user", content: message() }],
    contextScope,
    securityContext,
    executionScope: createExecutionScope({
      tenantId: securityContext.tenantId,
      initiatingActorId: securityContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: agentIdentity.principal.principalId,
      correlationId: "request-a",
      contextGrantIds: agentIdentity.principal.contextGrantIds,
      capabilityGrantIds: agentIdentity.principal.capabilityGrantIds,
      purpose: "agent.loop.v2.context_text_canary",
    }),
    agentId: "atlas",
    agentIdentity,
    runId: "run-a",
    providerId: "openai",
  };
}

function contextSelection(): ContextSelectionLockBinding {
  return {
    schemaVersion: 1,
    lockId: "11111111-1111-4111-8111-111111111111",
    previewId: "22222222-2222-4222-8222-222222222222",
    query: message(),
    querySha256: sourceContractSha256(message()),
    candidateEvidenceIds: ["memory:m1"],
    evidenceIds: ["memory:m1"],
    excludedEvidenceIds: [],
    candidateSetSha256: sourceContractSha256(["memory:m1"]),
    contextPackSha256: sourceContractSha256("pack"),
    previewReceiptSha256: sourceContractSha256("preview"),
    selectionSha256: sourceContractSha256("selection"),
    issuedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-08T00:30:00.000Z",
  };
}

function contextPack(): ContextPack {
  return {
    query: message(),
    profile: {
      mode: "memory_first",
      intent: "personal",
      shouldRetrieve: true,
      complexity: 1,
      queryTerms: ["summary"],
      expandedQueries: [message()],
      rationale: ["explicit selection"],
      queryPlan: {
        version: "p4.3-query-plan:1",
        source: "deterministic",
        domains: ["semantic"],
        queries: [message()],
        entityTerms: [],
        relationshipTerms: [],
        proceduralTerms: [],
        temporal: { mode: "none", expressions: [] },
        confidence: 1,
        validation: {
          originalQueryAnchored: true,
          authorizationInputsExcluded: true,
          candidateAccepted: false,
          droppedQueryCount: 0,
        },
      },
      contextBudget: emptyContextBudgetReceipt({
        taskContextTokenLimit: 2_048,
      }),
    },
    results: [{
      id: "m1",
      kind: "memory",
      sourceKey: "memory:m1",
      title: "Saved context",
      content: "Saved context",
      score: 1,
      utilityScore: 1,
      supportScore: 1,
      diversityScore: 1,
      freshnessScore: 1,
      confidence: 1,
      reasons: ["explicit selection"],
      result: {} as never,
    }],
    memoryResults: [],
    knowledgeResults: [],
    graphResults: [],
    contextBlock: "Saved context",
    budget: emptyContextBudgetReceipt({ taskContextTokenLimit: 2_048 }),
    compilerV2Canary: {
      receipt: {} as never,
      selectedEvidenceIds: ["memory:m1"],
      rejectedEvidenceIds: [],
    } as never,
  };
}

function message() {
  return `Summarize: ${sourceText()}`;
}

function sourceText() {
  return `${"A grounded source sentence. ".repeat(4)}<source marker>`;
}
