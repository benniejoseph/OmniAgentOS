import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCustomAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { evaluateAgentReleaseCandidateV1 } from "@/lib/agents/release-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { CustomAgentDefinition } from "@/lib/skills/types";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
  resolveDefinition: vi.fn(),
  revokeIdentity: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: () => true,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveCustomAgentDefinitionVersionWithSql: mocks.resolveDefinition,
  revokeCustomAgentIdentityWithSql: mocks.revokeIdentity,
}));

import {
  AGENT_RELEASE_EVENT_TYPES,
  evaluateAgentRelease,
  getAgentRelease,
  initializeAgentReleaseChannelWithSql,
  promoteAgentRelease,
} from "@/lib/agents/release-store";

const owner = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T04:00:00.000Z"));
  mocks.ensureDatabaseSchema.mockClear();
  mocks.appendScopedDomainEvent.mockClear();
  mocks.resolveDefinition.mockReset();
  mocks.revokeIdentity.mockClear();
});

describe("P7.5 Agent release store", () => {
  it("converges with database enrollment of the initial release", async () => {
    const database = fakeReleaseSql();
    const executionScope = createExecutionScope({
      tenantId: owner.tenantId,
      initiatingActorId: owner.canonicalActorId,
      executingPrincipalType: "user",
      executingPrincipalId: owner.canonicalActorId,
      correlationId: "agent-release:agent-one:initialize:test",
      purpose: "agent.release.initialize.v1",
    });

    const channel = await initializeAgentReleaseChannelWithSql({
      agent: agent(),
      definitionVersion: 1,
      canonicalActorId: owner.canonicalActorId,
      executionScope,
      sql: database.sql as unknown as Parameters<
        typeof initializeAgentReleaseChannelWithSql
      >[0]["sql"],
    });

    expect(channel).toMatchObject({
      state: "active",
      releaseRevision: 1,
      activeDefinitionVersion: 1,
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AGENT_RELEASE_EVENT_TYPES.initialized,
        executionScope,
      }),
      { sql: database.sql },
    );
  });

  it("shows the active version separately from an unevaluated draft", async () => {
    const database = fakeReleaseSql();
    mocks.getSql.mockReturnValue(database.sql);

    const release = await getAgentRelease("agent-one", owner);

    expect(release).toMatchObject({
      state: "active",
      activeDefinitionVersion: 1,
      latestDefinitionVersion: 2,
      candidateEvaluation: null,
    });
    expect(release.versions).toEqual([
      expect.objectContaining({ definitionVersion: 1, active: true }),
      expect.objectContaining({ definitionVersion: 2, active: false }),
    ]);
  });

  it("persists one exact metadata-only evaluation for the current baseline", async () => {
    const database = fakeReleaseSql();
    mocks.getSql.mockReturnValue(database.sql);
    mocks.resolveDefinition.mockImplementation(async ({ definitionVersion }) =>
      definitionVersion === 1 ? definition(1, agent()) : definition(2, {
        ...agent(),
        instructions: "Use exact evidence and report uncertainty.",
        updatedAt: "2026-09-07T03:00:00.000Z",
      })
    );

    const release = await evaluateAgentRelease("agent-one", 2, owner);

    expect(release.candidateEvaluation).toMatchObject({
      direction: "promotion",
      definitionVersion: 2,
      baselineDefinitionVersion: 1,
      changedFields: ["instructions"],
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AGENT_RELEASE_EVENT_TYPES.evaluated,
        streamId: "agent:agent-one",
        payload: expect.not.objectContaining({
          instructions: expect.anything(),
          definitionSnapshot: expect.anything(),
        }),
      }),
      { sql: database.sql },
    );
  });

  it("atomically promotes only an evaluation bound to the active version", async () => {
    const candidate = definition(2, {
      ...agent(),
      role: "Evidence lead",
      updatedAt: "2026-09-07T03:00:00.000Z",
    });
    const evaluation = evaluateAgentReleaseCandidateV1({
      baseline: definition(1, agent()),
      candidate,
      evaluatedAt: "2026-09-07T04:00:00.000Z",
    });
    const database = fakeReleaseSql(evaluationRow(evaluation, candidate));
    mocks.getSql.mockReturnValue(database.sql);

    const release = await promoteAgentRelease(
      "agent-one",
      evaluation.evaluationId,
      owner,
    );

    expect(release).toMatchObject({
      activeDefinitionVersion: 2,
      previousDefinitionVersion: 1,
      releaseRevision: 2,
    });
    expect(database.statements.some((statement) =>
      /UPDATE omni_agent_release_channels/.test(statement)
    )).toBe(true);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: AGENT_RELEASE_EVENT_TYPES.promoted }),
      { sql: database.sql },
    );
  });
});

function fakeReleaseSql(initialEvaluation?: Record<string, unknown>) {
  let channel: Record<string, unknown> = channelRow();
  let storedEvaluation = initialEvaluation;
  const statements: string[] = [];
  const callable = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = render(strings);
      statements.push(text);
      if (/FROM omni_custom_agents agent/.test(text)) return [agentRow()];
      if (/SELECT \*\s+FROM omni_agent_release_channels/.test(text)) return [channel];
      if (/SELECT definition_version, published_at/.test(text)) {
        return [
          { definition_version: 1, published_at: agent().updatedAt },
          { definition_version: 2, published_at: "2026-09-07T03:00:00.000Z" },
        ];
      }
      if (/SELECT definition_snapshot/.test(text)) return [];
      if (/INSERT INTO omni_agent_release_evaluations/.test(text)) {
        storedEvaluation = {
          schema_version: 1,
          evaluation_id: params[1],
          agent_definition_id: params[2],
          definition_version: params[3],
          baseline_definition_version: params[4],
          owner_actor_id: params[5],
          evaluated_by_actor_id: params[6],
          policy_version_id: params[7],
          direction: params[8],
          changed_fields: params[9],
          checks: params[10],
          verdict: params[11],
          definition_sha256: params[12],
          baseline_definition_sha256: params[13],
          definition_snapshot: params[14],
          evaluation_sha256: params[15],
          evaluated_at: params[16],
        };
        return [storedEvaluation];
      }
      if (/FROM omni_agent_release_evaluations/.test(text)) {
        if (!storedEvaluation) return [];
        const requestedBaseline = params.find((value) => value === 1 || value === 2);
        if (
          /baseline_definition_version/.test(text) &&
          requestedBaseline !== undefined &&
          Number(storedEvaluation.baseline_definition_version) !== requestedBaseline
        ) return [];
        return [storedEvaluation];
      }
      if (/UPDATE omni_agent_release_channels/.test(text)) {
        channel = {
          ...channel,
          release_revision: 2,
          active_definition_version: params[0],
          previous_definition_version: 1,
          last_evaluation_id: params[1],
          updated_at: "2026-09-07T04:00:01.000Z",
        };
        return [channel];
      }
      return [];
    },
    {
      transaction: async (callback: (sql: unknown) => unknown) => callback(callable),
    },
  );
  return { sql: callable, statements };
}

function evaluationRow(
  evaluation: ReturnType<typeof evaluateAgentReleaseCandidateV1>,
  snapshot: ReturnType<typeof definition>,
) {
  return {
    schema_version: evaluation.schemaVersion,
    evaluation_id: evaluation.evaluationId,
    agent_definition_id: evaluation.agentId,
    definition_version: evaluation.definitionVersion,
    baseline_definition_version: evaluation.baselineDefinitionVersion,
    owner_actor_id: owner.canonicalActorId,
    evaluated_by_actor_id: owner.canonicalActorId,
    policy_version_id: evaluation.policyVersionId,
    direction: evaluation.direction,
    changed_fields: evaluation.changedFields,
    checks: evaluation.checks,
    verdict: evaluation.verdict,
    definition_sha256: evaluation.definitionSha256,
    baseline_definition_sha256: evaluation.baselineDefinitionSha256,
    definition_snapshot: snapshot,
    evaluation_sha256: evaluation.evaluationSha256,
    evaluated_at: evaluation.evaluatedAt,
  };
}

function channelRow() {
  return {
    schema_version: 1,
    tenant_id: owner.tenantId,
    agent_definition_id: "agent-one",
    owner_actor_id: owner.canonicalActorId,
    state: "active",
    release_revision: 1,
    active_definition_version: 1,
    previous_definition_version: null,
    last_evaluation_id: null,
    updated_by_actor_id: owner.canonicalActorId,
    updated_at: "2026-09-07T01:00:00.000Z",
    retired_at: null,
  };
}

function agentRow() {
  const value = agent();
  return {
    id: value.id,
    tenant_id: value.tenantId,
    actor_id: value.actorId,
    slug: value.slug,
    name: value.name,
    role: value.role,
    description: value.description,
    instructions: value.instructions,
    persona_profile: value.persona,
    status: value.status,
    accent: value.accent,
    model_policy: value.modelPolicy,
    autonomy: value.autonomy,
    approval_policy: value.approvalPolicy,
    memory_scope: value.memoryScope,
    skill_ids: value.skillIds,
    tool_ids: value.toolIds,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function definition(version: number, value: CustomAgentDefinition) {
  return buildCustomAgentIdentityV1({
    agent: value,
    skills: [],
    definitionVersion: version,
    principalGeneration: 1,
  }).definition;
}

function agent(): CustomAgentDefinition {
  return {
    id: "agent-one",
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    slug: "researcher",
    name: "Researcher",
    role: "Research specialist",
    description: "Finds exact evidence.",
    instructions: "Use exact evidence.",
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    modelPolicy: "openai_fast",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    memoryScope: "all",
    skillIds: [],
    toolIds: [],
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:00:00.000Z",
  };
}

function render(strings: TemplateStringsArray) {
  return strings.join("?");
}
