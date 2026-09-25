import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: [] as string[],
  events: [] as string[],
  returnedMemoryRows: [] as Array<Record<string, unknown>>,
  returnedReviewRows: [] as Array<Record<string, unknown>>,
}));

function createSql(transactionScoped = false) {
  const sql = Object.assign(async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    const query = strings.join("?");
    mocks.queries.push(query);
    mocks.events.push("query");
    if (query.includes("INSERT INTO omni_memories")) {
      return ((params[0] || []) as Array<Record<string, unknown>>).map(
        (row) => ({ ...row, _inserted: true }),
      );
    }
    if (query.includes("INSERT INTO omni_agent_memory_grants")) {
      return [{ grant_id: "agent-memory-grant:inserted" }];
    }
    if (query.includes("INSERT INTO omni_memory_reconciliation_reviews")) {
      return [{ id: "memory-reconciliation-a" }];
    }
    if (
      query.includes("SELECT review.*") &&
      query.includes("FROM omni_memory_reconciliation_reviews")
    ) {
      return mocks.returnedReviewRows;
    }
    if (
      query.includes("COUNT(*) FILTER") &&
      query.includes("FROM omni_memory_reconciliation_reviews")
    ) {
      return [{ pending: 7, resolved: 3 }];
    }
    if (query.includes("INSERT INTO omni_entity_relation_projection_queue")) {
      return [{
        tenant_id: "tenant-a",
        owner_actor_id: ownerActorId,
        generation: "1",
        requested_at: "2026-09-06T00:00:00.000Z",
      }];
    }
    if (
      query.includes("FROM omni_memories memory") &&
      query.includes("memory.id <> ALL(")
    ) {
      return mocks.returnedMemoryRows.map((row) => ({
        memory_record: row,
        vector_score: 0,
        lexical_score: 0,
      }));
    }
    if (
      (query.includes("SELECT *") || query.includes("SELECT memory.*")) &&
      query.includes("FROM omni_memories")
    ) {
      return mocks.returnedMemoryRows;
    }
    if (query.includes("UPDATE omni_memories") && query.includes("RETURNING id")) {
      return [{ id: "feedback-memory" }];
    }
    return [];
  }, {
    transactionScoped,
    transaction: async <T>(operation: (
      transaction: ReturnType<typeof createSql>,
    ) => Promise<T>) => operation(createSql(true)),
  });
  return sql;
}

const sql = createSql();

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => undefined),
  hasDatabaseUrl: vi.fn(() => true),
  getSql: vi.fn(() => sql),
}));

vi.mock("@/lib/db/memory-access-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/memory-access-scope")>()),
  setTransactionLocalDatabaseMemoryAccessScope: vi.fn(async () => {
    mocks.events.push("scope");
  }),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: vi.fn(async () => {
    mocks.events.push("event");
  }),
}));

import {
  buildAgentPrivateMemoryAccessBindingV1,
  buildProjectSharedMemoryAccessBindingV1,
  buildUserPrivateMemoryAccessBindingV1,
  buildWorkspaceSharedMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  applyRunMemoryFeedback,
  getMemoryReconciliationStats,
  listMemoryCatalog,
  listMemoryReconciliationReviews,
  listMemories,
  previewMemoryDeletion,
  correctMemory,
  resolveMemoryReconciliationReview,
  saveMemory,
  searchMemories,
  shareAgentPrivateMemory,
} from "@/lib/memory/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
  embedLocalMultilingualTexts,
} from "@/lib/rag/retrieval-embedding";

const ownerActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";

function accessScope(purposeId: string) {
  return {
    version: 1 as const,
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "user" as const,
    executingPrincipalId: ownerActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId,
    purpose: `test.${purposeId}`,
  };
}

function executionScope(purposeId: string) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "user",
    executingPrincipalId: ownerActorId,
    correlationId: "memory_test",
    purpose: `test.${purposeId}`,
  });
}

function agentAccessScope(purposeId: string, agentId = "agent:atlas") {
  return {
    ...accessScope(purposeId),
    executingPrincipalType: "agent" as const,
    executingPrincipalId: agentId,
  };
}

function agentExecutionScope(purposeId: string, agentId = "agent:atlas") {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: agentId,
    correlationId: "agent_memory_test",
    purpose: `test.${purposeId}`,
  });
}

function sharedAccessScope(
  purposeId: string,
  scope: "project" | "workspace",
) {
  return {
    ...accessScope(purposeId),
    workspaceId: "workspace:team-a",
    projectId: scope === "project" ? "project:launch" : null,
  };
}

function sharedExecutionScope(
  purposeId: string,
  scope: "project" | "workspace",
) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "user",
    executingPrincipalId: ownerActorId,
    workspaceId: "workspace:team-a",
    projectId: scope === "project" ? "project:launch" : undefined,
    correlationId: `shared_${scope}_memory_test`,
    purpose: `test.${purposeId}`,
  });
}

describe("Postgres memory recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queries.length = 0;
    mocks.events.length = 0;
    mocks.returnedMemoryRows.length = 0;
    mocks.returnedReviewRows.length = 0;
  });

  it("projects the durable catalogue without transferring raw source chunks", async () => {
    await expect(listMemoryCatalog({
      tenantId: "tenant-a",
      catalogClass: "durable",
    })).resolves.toEqual([]);

    const catalogueQuery = mocks.queries.find((query) =>
      query.includes("FROM omni_memories memory") &&
      query.includes("canonical_source_observation")
    );
    expect(catalogueQuery).toContain("memory.type <> 'knowledge'");
    expect(catalogueQuery).toContain("'rag' = ANY(memory.tags)");
  });

  it("counts review states without loading review content", async () => {
    await expect(getMemoryReconciliationStats({ tenantId: "tenant-a" }))
      .resolves.toEqual({ pending: 7, resolved: 3 });

    const countQuery = mocks.queries.find((query) =>
      query.includes("COUNT(*) FILTER")
    );
    expect(countQuery).not.toContain("SELECT review.*");
  });

  it("selects only the actor-bound reconciliation lane for scoped resolutions", async () => {
    await expect(resolveMemoryReconciliationReview(
      "memory-reconciliation-private",
      "confirm_candidate",
      {
        tenantId: "tenant-a",
        actorId: ownerActorId,
        accessScope: accessScope(MEMORY_PURPOSE_IDS.correct),
        executionScope: executionScope(MEMORY_PURPOSE_IDS.correct),
      },
    )).resolves.toBeNull();

    const resolutionQuery = mocks.queries.find((query) =>
      query.includes("FROM omni_memory_reconciliation_reviews") &&
      query.includes("FOR UPDATE")
    );
    expect(resolutionQuery).toContain("owner_actor_id IS NOT NULL");
    expect(resolutionQuery).toContain("owner_actor_id IS NULL");
  });

  it("canonicalizes JSON projection timestamps before verifying review bindings", async () => {
    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "memory.verified_effect",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    mocks.returnedReviewRows.push({
      id: "memory-reconciliation-json-timestamp",
      tenant_id: "tenant-a",
      owner_actor_id: ownerActorId,
      kind: "confirmation",
      status: "pending",
      decision: null,
      detection_reason: "unverified_inference",
      candidate_memory: {
        id: "candidate-json-timestamp",
        tenant_id: "tenant-a",
        type: "fact",
        tier: "semantic",
        formation_reason: "assistant_inference_candidate",
        title: "Canonical timestamp",
        content: "A review projection may serialize timestamptz with an offset.",
        tags: [],
        evidence_refs: [],
        scope: "user",
        source: "agent",
        importance: 0.7,
        confidence: 0.8,
        claim_status: "candidate",
        asserted_by: "agent",
        created_at: "2026-09-06T00:00:00+00:00",
        updated_at: "2026-09-06T00:00:00+00:00",
        access_contract_version: binding.version,
        access_state: binding.state,
        owner_actor_id: binding.ownerActorId,
        owner_agent_id: null,
        workspace_id: null,
        project_id: null,
        mission_id: null,
        visibility: binding.visibility,
        sensitivity: binding.sensitivity,
        origin_purpose: binding.originPurpose,
        allowed_purpose_ids: binding.allowedPurposeIds,
        access_scope_sha256: binding.accessScopeSha256,
        access_bound_at: "2026-09-06T00:00:00+00:00",
      },
      existing_memory: null,
      created_at: "2026-09-06T00:00:00+00:00",
      updated_at: "2026-09-06T00:00:00+00:00",
      resolved_at: null,
      resolved_by: null,
    });

    const reviews = await listMemoryReconciliationReviews({
      tenantId: "tenant-a",
      status: "all",
      limit: 20,
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.candidate.accessBinding).toEqual(binding);
    expect(reviews[0]?.candidate.updatedAt).toBe("2026-09-06T00:00:00.000Z");
  });

  it("fails closed before an unscoped production memory insert", async () => {
    await expect(saveMemory({
      tenantId: "tenant-a",
      title: "Unscoped",
      content: "This write must not reach Postgres.",
    })).rejects.toThrow("requires an execution scope");
    expect(mocks.queries.some((query) =>
      query.includes("INSERT INTO omni_memories")
    )).toBe(false);
  });

  it("ranks the projected lexical score from an outer query", async () => {
    await expect(
      searchMemories("release verification", { tenantId: "tenant-a" }),
    ).resolves.toEqual([]);

    const lexicalQuery = mocks.queries.find((query) =>
      query.includes("AS lexical_score"),
    );
    expect(lexicalQuery).toMatch(
      /FROM \(\s*SELECT to_jsonb\(memory\) - ARRAY\[\s*'embedding', 'embedding_vector'\s*\]::text\[\] AS memory_record/,
    );
    expect(lexicalQuery).toContain(") ranked");
    expect(lexicalQuery).toContain("CASE ranked.rank_tier");
    expect(lexicalQuery).toContain("WHERE memory.tenant_id = ?");
    expect(lexicalQuery).toContain("lifecycle.archived_at IS NULL");
    expect(lexicalQuery).toContain("WHEN 'commitment' THEN 1.15");
    expect(lexicalQuery).toContain(
      "memory.retention_expires_at IS NULL OR memory.retention_expires_at > ?::timestamptz",
    );
    expect(lexicalQuery).not.toContain("ORDER BY (lexical_score *");
  });

  it("installs scope before persisting and reconstructs the immutable binding", async () => {
    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "api.memory.write",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    const record = await saveMemory({
      id: "private-memory-a",
      tenantId: "tenant-a",
      title: "Private preference",
      content: "Keep this isolated.",
      accessBinding: binding,
      databaseAccessScope: accessScope(MEMORY_PURPOSE_IDS.write),
      executionScope: executionScope(MEMORY_PURPOSE_IDS.write),
    });

    expect(mocks.events.slice(0, 2)).toEqual(["scope", "query"]);
    expect(mocks.queries[0]).toContain("access_contract_version");
    expect(record.accessBinding).toEqual(binding);
  });

  it("persists verified agent-private tiers and rejects sibling agents", async () => {
    const binding = buildAgentPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      ownerAgentId: "agent:atlas",
      originPurpose: "memory.verified_effect",
    });
    const record = await saveMemory({
      id: "agent-private-memory-a",
      tenantId: "tenant-a",
      type: "episode",
      tier: "episodic",
      title: "Verified effect",
      content: "The committed target matched the expected state.",
      accessBinding: binding,
      databaseAccessScope: agentAccessScope(MEMORY_PURPOSE_IDS.formation),
      executionScope: agentExecutionScope(MEMORY_PURPOSE_IDS.formation),
    });

    expect(record.accessBinding).toEqual(binding);
    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory.agent_private.created" }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );

    await expect(saveMemory({
      id: "agent-private-memory-sibling",
      tenantId: "tenant-a",
      type: "episode",
      tier: "episodic",
      title: "Sibling attempt",
      content: "This must fail before SQL.",
      accessBinding: binding,
      databaseAccessScope: agentAccessScope(
        MEMORY_PURPOSE_IDS.formation,
        "agent:sibling",
      ),
      executionScope: agentExecutionScope(
        MEMORY_PURPOSE_IDS.formation,
        "agent:sibling",
      ),
    })).rejects.toThrow("does not authorize this write");
  });

  it.each([
    ["project", "memory.project_shared.created"],
    ["workspace", "memory.workspace_shared.created"],
  ] as const)("persists %s-shared memory with its typed event", async (
    scope,
    eventType,
  ) => {
    const binding = scope === "project"
      ? buildProjectSharedMemoryAccessBindingV1({
          tenantId: "tenant-a",
          ownerActorId,
          workspaceId: "workspace:team-a",
          projectId: "project:launch",
          originPurpose: "app.memory.shared.write",
        })
      : buildWorkspaceSharedMemoryAccessBindingV1({
          tenantId: "tenant-a",
          ownerActorId,
          workspaceId: "workspace:team-a",
          originPurpose: "app.memory.shared.write",
        });

    const record = await saveMemory({
      id: `${scope}-shared-memory-a`,
      tenantId: "tenant-a",
      type: "knowledge",
      tier: "semantic",
      title: `${scope} knowledge`,
      content: "Durable shared context.",
      scope,
      accessBinding: binding,
      databaseAccessScope: sharedAccessScope(
        MEMORY_PURPOSE_IDS.write,
        scope,
      ),
      executionScope: sharedExecutionScope(MEMORY_PURPOSE_IDS.write, scope),
    });

    expect(record.accessBinding).toEqual(binding);
    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: eventType }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );
  });

  it("shares through a target-owned copy and immutable provenance artifact", async () => {
    const sourceBinding = buildAgentPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      ownerAgentId: "agent:atlas",
      originPurpose: "memory.verified_effect",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    mocks.returnedMemoryRows.push({
      id: "agent-source-memory",
      tenant_id: "tenant-a",
      type: "episode",
      tier: "episodic",
      tier_policy_version: 1,
      formation_reason: "verified_effect",
      title: "Verified deployment",
      content: "The committed target matched the expected state.",
      tags: ["verified-effect"],
      evidence_refs: [
        "run:one",
        "tool-execution:one",
        "effect-receipt:one",
      ],
      scope: "user",
      source: "effect-receipt",
      importance: 0.8,
      confidence: 1,
      claim_status: "active",
      asserted_by: "system",
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
      access_contract_version: sourceBinding.version,
      access_state: sourceBinding.state,
      owner_actor_id: sourceBinding.ownerActorId,
      owner_agent_id: sourceBinding.ownerAgentId,
      visibility: sourceBinding.visibility,
      sensitivity: sourceBinding.sensitivity,
      origin_purpose: sourceBinding.originPurpose,
      allowed_purpose_ids: sourceBinding.allowedPurposeIds,
      access_scope_sha256: sourceBinding.accessScopeSha256,
      access_bound_at: sourceBinding.accessBoundAt,
    });

    const result = await shareAgentPrivateMemory({
      tenantId: "tenant-a",
      sourceMemoryId: "agent-source-memory",
      targetAgentId: "agent:scout",
      idempotencyKey: "share-request-one",
      sharedAt: "2026-09-07T00:00:00.000Z",
      executionScope: agentExecutionScope(
        MEMORY_PURPOSE_IDS.read,
        "agent:atlas",
      ),
    });

    expect(result.memory.accessBinding).toMatchObject({
      visibility: "agent_private",
      ownerActorId,
      ownerAgentId: "agent:scout",
    });
    expect(result.memory.evidenceRefs).toEqual(expect.arrayContaining([
      "memory:agent-source-memory",
      result.grant.grantId,
    ]));
    expect(result.grant).toMatchObject({
      sourceAgentId: "agent:atlas",
      sourceMemoryId: "agent-source-memory",
      targetAgentId: "agent:scout",
      targetMemoryId: result.memory.id,
    });
    expect(mocks.events.filter((event) => event === "scope")).toHaveLength(2);
    expect(mocks.queries.some((query) =>
      query.includes("INSERT INTO omni_agent_memory_grants")
    )).toBe(true);
    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory.agent_private.shared" }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );
  });

  it("owns a scoped read transaction and rejects read purpose for writes", async () => {
    await expect(listMemories({
      tenantId: "tenant-a",
      accessScope: accessScope(MEMORY_PURPOSE_IDS.read),
    })).resolves.toEqual([]);
    expect(mocks.events.slice(0, 2)).toEqual(["scope", "query"]);

    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "api.memory.write",
    });
    await expect(saveMemory({
      tenantId: "tenant-a",
      title: "Wrong purpose",
      content: "This must fail before SQL.",
      accessBinding: binding,
      databaseAccessScope: accessScope(MEMORY_PURPOSE_IDS.read),
      executionScope: executionScope(MEMORY_PURPOSE_IDS.read),
    })).rejects.toThrow("not authorized for this operation");
  });

  it("authorizes the bounded candidate read before local semantic scoring", async () => {
    mocks.returnedMemoryRows.push({
      id: "private-local-memory",
      tenant_id: "tenant-a",
      type: "procedure",
      tier: "procedural",
      title: "Database restore procedure",
      content: "Restore the latest database backup.",
      tags: [],
      evidence_refs: [],
      scope: "user",
      source: "manual",
      importance: 0.8,
      confidence: 1,
      claim_status: "active",
      asserted_by: "user",
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
    });
    const query = "restaurar la copia de la base de datos";
    const results = await searchMemories(query, {
      tenantId: "tenant-a",
      accessScope: accessScope(MEMORY_PURPOSE_IDS.retrieve),
      queryEmbedding: embedLocalMultilingualTexts([query])[0],
      queryEmbeddingSpaceId: LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
    });

    expect(mocks.events.slice(0, 2)).toEqual(["scope", "query"]);
    // Local multilingual similarity is scored by the context engine's learned
    // reranker; the store only returns bounded candidates read under scope.
    const candidateQuery = mocks.queries.find((queryText) =>
      queryText.includes("memory.id <> ALL(")
    );
    expect(candidateQuery).toMatch(
      /SELECT to_jsonb\(memory\) - ARRAY\[\s*'embedding', 'embedding_vector'\s*\]::text\[\] AS memory_record/,
    );
    expect(candidateQuery).toContain("WHERE memory.tenant_id = ?");
    expect(candidateQuery).toContain("lifecycle.archived_at IS NULL");
    expect(candidateQuery).toMatch(/LIMIT \?\s*$/);
    expect(results.map((result) => result.record.id)).toEqual([
      "private-local-memory",
    ]);
    expect(mocks.queries.some((queryText) =>
      queryText.includes("embedding_vector <=>")
    )).toBe(false);
  });

  it("uses indexed trace lineage for governed deletion previews", async () => {
    mocks.returnedMemoryRows.push({
      id: "private-memory-a",
      tenant_id: "tenant-a",
      type: "preference",
      title: "Private preference",
      content: "Keep this isolated.",
      tags: [],
      evidence_refs: [],
      claim_status: "active",
      asserted_by: "user",
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
    });

    await expect(previewMemoryDeletion("private-memory-a", {
      tenantId: "tenant-a",
      accessScope: accessScope(MEMORY_PURPOSE_IDS.forget),
    })).resolves.toMatchObject({
      memory: { id: "private-memory-a" },
    });

    const traceQuery = mocks.queries.find((query) =>
      query.includes("FROM omni_retrieval_traces trace"),
    );
    expect(traceQuery).toContain("trace.memory_ids &&");
    expect(traceQuery).not.toContain("jsonb_array_elements");
  });

  it("commits correction state and scoped events through one transaction client", async () => {
    mocks.returnedMemoryRows.push({
      id: "memory-original",
      tenant_id: "tenant-a",
      type: "fact",
      title: "Original",
      content: "Original value",
      tags: [],
      scope: "workspace",
      source: "manual",
      importance: 0.5,
      confidence: 0.9,
      claim_status: "active",
      asserted_by: "user",
      evidence_refs: [],
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
    });

    await expect(correctMemory("memory-original", {
      content: "Corrected value",
    }, {
      tenantId: "tenant-a",
      actorId: ownerActorId,
      executionScope: executionScope(MEMORY_PURPOSE_IDS.correct),
    })).resolves.toMatchObject({
      previous: { id: "memory-original", claimStatus: "superseded" },
      corrected: { content: "Corrected value", supersedesId: "memory-original" },
    });

    expect(mocks.queries.some((query) => query.includes("FOR UPDATE"))).toBe(true);
    expect(mocks.queries.some((query) =>
      query.includes("SET claim_status")
    )).toBe(true);
    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory.corrected" }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );
  });

  it("projects every inserted candidate into the reconciliation inbox", async () => {
    await saveMemory({
      id: "candidate-memory-a",
      tenantId: "tenant-a",
      title: "Unconfirmed candidate",
      content: "This candidate must remain outside recall.",
      claimStatus: "candidate",
      assertedBy: "agent",
      executionScope: executionScope(MEMORY_PURPOSE_IDS.formation),
    });

    expect(mocks.queries.some((query) =>
      query.includes("INSERT INTO omni_memory_reconciliation_reviews")
    )).toBe(true);
    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.reconciliation.detected",
        payload: expect.objectContaining({
          kind: "confirmation",
          detectionReason: "unverified_inference",
        }),
      }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );
  });

  it("rejects unreviewed model output before it can become source cognition", async () => {
    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "memory.source_cognition",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });

    await expect(saveMemory({
      id: "unreviewed-source-cognition",
      tenantId: "tenant-a",
      type: "knowledge",
      title: "Unreviewed model output",
      content: "relation: related_to | project: \"Phoenix\" -> person: \"Ada\"",
      source: "cognify-proposed:cognition-batch-a",
      formationReason: "source_cognition",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: ["knowledge:document-a", "evidence:evidence-a"],
      accessBinding: binding,
      databaseAccessScope: accessScope(MEMORY_PURPOSE_IDS.correct),
      executionScope: executionScope(MEMORY_PURPOSE_IDS.correct),
    })).rejects.toThrow(/reviewed source cognition/i);

    expect(mocks.queries.some((query) =>
      query.includes("INSERT INTO omni_memories")
    )).toBe(false);
    expect(mocks.queries.some((query) =>
      query.includes("INSERT INTO omni_entity_relation_projection_queue")
    )).toBe(false);
  });

  it("binds run feedback mutation to a deterministic scoped event", async () => {
    await expect(applyRunMemoryFeedback("run-a", "useful", {
      tenantId: "tenant-a",
      executionScope: executionScope("feedback"),
    })).resolves.toEqual(["feedback-memory"]);

    expect(vi.mocked(appendScopedDomainEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.feedback_applied",
        streamId: "agent_run:run-a",
      }),
      expect.objectContaining({
        sql: expect.objectContaining({ transactionScoped: true }),
      }),
    );
  });
});
