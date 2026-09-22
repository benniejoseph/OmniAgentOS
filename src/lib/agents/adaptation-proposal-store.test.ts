import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseActorScope: vi.fn(
    async (
      _tenantId: string,
      _actorIds: readonly string[],
      operation: () => unknown,
    ) => operation(),
  ),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  runWithDatabaseActorScope: mocks.runWithDatabaseActorScope,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  listProactiveAgentAdaptationTargets,
  loadAgentAdaptationProposalEvidence,
  persistProactiveAgentAdaptationProposal,
} from "@/lib/agents/adaptation-proposal-store";
import {
  AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION,
  buildObservedAgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const owner = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
};
const digest = "a".repeat(64);

type EvidenceSource =
  | "run_feedback"
  | "project_artifact"
  | "delegated_task"
  | "scheduled_trigger";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasDatabaseUrl.mockReturnValue(true);
  mocks.runWithDatabaseActorScope.mockImplementation(
    async (
      _tenantId: string,
      _actorIds: readonly string[],
      operation: () => unknown,
    ) => operation(),
  );
});

describe("proactive Agent adaptation evidence store", () => {
  it("discovers candidates from only the four bounded negative-signal sources", async () => {
    const statements: CapturedStatement[] = [];
    mocks.getSql.mockReturnValue(capturingSql(statements, (statement) =>
      /FROM \(\s*SELECT run\.owner_actor_id/.test(statement)
        ? [{ actor_id: owner.canonicalActorId, agent_id: "scout" }]
        : []));

    await expect(listProactiveAgentAdaptationTargets({
      tenantId: owner.tenantId,
      limit: 7,
    })).resolves.toEqual([{
      actorId: owner.canonicalActorId,
      agentId: "scout",
    }]);

    const discovery = statements.at(0);
    expect(discovery?.text).toContain("FROM omni_agent_runs run");
    expect(discovery?.text).toContain("FROM omni_project_artifacts artifact");
    expect(discovery?.text).toContain("FROM omni_delegation_tasks task");
    expect(discovery?.text).toContain("FROM omni_workflow_schedule_occurrences occurrence");
    expect(discovery?.text).toContain("run.feedback->>'verdict' = 'needs_work'");
    expect(discovery?.text).toContain("artifact.status = 'verified'");
    expect(discovery?.text).toContain("task.state = 'rejected'");
    expect(discovery?.text).toContain("occurrence.status = 'failed'");
    expect(discovery?.params).toEqual([
      owner.tenantId,
      owner.tenantId,
      owner.tenantId,
      owner.tenantId,
      7,
    ]);
  });

  it.each([
    [
      "run_feedback",
      /FROM omni_agent_runs run/,
      {
        id: "run-one",
        feedback: { correction: "Require an exact primary-source citation." },
        grounding: { status: "verified" },
        observed_at: "2026-09-22T08:00:00.000Z",
      },
    ],
    [
      "project_artifact",
      /FROM omni_project_artifacts artifact/,
      {
        id: "artifact-one",
        verdict: "needs_work",
        lesson: "Verify the artifact against its acceptance contract.",
        reviewed_at: "2026-09-22T08:01:00.000Z",
        updated_at: "2026-09-22T08:01:00.000Z",
        status: "verified",
      },
    ],
    [
      "delegated_task",
      /FROM omni_delegation_tasks/,
      {
        task_id: "task-one",
        state: "rejected",
        task: {
          taskSha256: digest,
          evaluation: { score: 0.25, evaluationSha256: digest },
        },
        updated_at: "2026-09-22T08:02:00.000Z",
      },
    ],
    [
      "scheduled_trigger",
      /FROM omni_workflow_schedule_occurrences occurrence/,
      {
        id: "occurrence-one",
        status: "failed",
        failure_code: "governed_action_failed",
        authority_sha256: digest,
        updated_at: "2026-09-22T08:03:00.000Z",
      },
    ],
  ] satisfies ReadonlyArray<readonly [
    EvidenceSource,
    RegExp,
    Record<string, unknown>,
  ]>)("pins %s evidence to tenant, owner, Agent, and definition", async (
    kind,
    sourcePattern,
    row,
  ) => {
    const statements: CapturedStatement[] = [];
    mocks.getSql.mockReturnValue(capturingSql(statements, (statement) =>
      sourcePattern.test(statement) ? [row] : []));

    const evidence = await loadAgentAdaptationProposalEvidence({
      owner,
      agentId: "scout",
      definitionVersion: 7,
    });

    expect(evidence).toEqual([
      expect.objectContaining({
        tenantId: owner.tenantId,
        ownerActorId: owner.canonicalActorId,
        agentId: "scout",
        definitionVersion: 7,
        evidence: expect.objectContaining({ kind }),
      }),
    ]);
    expect(mocks.runWithDatabaseActorScope).toHaveBeenCalledWith(
      owner.tenantId,
      [owner.canonicalActorId, owner.actorId],
      expect.any(Function),
    );

    const source = statements.find(({ text }) => sourcePattern.test(text));
    expect(source).toBeDefined();
    expect(source?.params).toEqual(expect.arrayContaining([
      owner.tenantId,
      owner.canonicalActorId,
      "scout",
      7,
    ]));
    assertSourceBoundary(kind, source!.text, source!.params);
  });

  it("persists only an observed proposal and emits content-free non-authority metadata", async () => {
    const statements: CapturedStatement[] = [];
    const sql = capturingSql(statements, (statement) =>
      /INSERT INTO omni_agent_adaptations/.test(statement)
        ? [{ adaptation_id: "inserted" }]
        : []);
    mocks.getSql.mockReturnValue(sql);
    const reviewBody = {
      verdict: "passed" as const,
      score: 0.9,
      findings: [
        "evidence_bound" as const,
        "definition_bound" as const,
        "non_authority" as const,
        "measurable" as const,
      ],
    };
    const adaptation = buildObservedAgentAdaptationV1({
      tenantId: owner.tenantId,
      ownerActorId: owner.canonicalActorId,
      agentId: "scout",
      definitionVersion: 7,
      evidence: [{
        evidenceId: "run-feedback:run-one",
        kind: "run_feedback",
        sourceId: "run-one",
        sourceSha256: digest,
        verdict: "needs_work",
        groundingStatus: "verified",
        observedAt: "2026-09-22T08:00:00.000Z",
      }],
      guidance: "Require exact evidence for every material claim.",
      confidence: 0.9,
      proposalReview: {
        version: AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION,
        targetIdentity: identityPin("scout", "b"),
        sentinelRuntime: {
          ...identityPin("sentinel", "c"),
          agentId: "sentinel",
          provider: "openai",
          model: "gpt-5.5",
          tier: "reasoning",
          routeSource: "tenant_assignment",
          assignmentId: "assignment-verifier",
          assignmentRevision: 2,
          assignmentConfigurationSha256: "d".repeat(64),
        },
        evidenceSetSha256: "e".repeat(64),
        baselineEffectSha256: null,
        proposalSha256: "f".repeat(64),
        shadowComparisonSha256: "1".repeat(64),
        review: {
          ...reviewBody,
          reviewSha256: sourceContractSha256(reviewBody),
        },
        generatedAt: "2026-09-22T08:04:00.000Z",
        reviewedAt: "2026-09-22T08:04:01.000Z",
        authorityImpact: "none",
      },
      observedAt: "2026-09-22T08:04:01.000Z",
    });

    await expect(persistProactiveAgentAdaptationProposal({
      owner,
      adaptation,
    })).resolves.toBe("inserted");

    const insert = statements.find(({ text }) =>
      /INSERT INTO omni_agent_adaptations/.test(text)
    );
    expect(insert?.text).toContain("state, lifecycle_revision, evidence");
    expect(insert?.text).not.toContain("activation_version");
    expect(insert?.params).toEqual(expect.arrayContaining([
      "observed",
      0,
      adaptation.effect,
    ]));
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.adaptation.proposed",
        payload: expect.objectContaining({
          authorityImpact: "none",
          activationAuthorityGranted: false,
          activeGuidanceChanged: false,
          proposalSha256: "f".repeat(64),
        }),
      }),
      { sql },
    );
    const event = (mocks.appendScopedDomainEvent.mock.calls as unknown[][])[0]?.[0];
    expect(JSON.stringify(event)).not.toContain(adaptation.effect.guidance);
  });
});

type CapturedStatement = Readonly<{
  text: string;
  params: readonly unknown[];
}>;

type CapturingSql = ((
  parts: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>) & Readonly<{
  transaction: (
    operation: (sql: CapturingSql) => unknown,
  ) => Promise<unknown>;
}>;

function capturingSql(
  statements: CapturedStatement[],
  rowsFor: (statement: string) => Record<string, unknown>[],
) {
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...params: unknown[]) => {
      const text = parts.join("?");
      statements.push({ text, params });
      return rowsFor(text);
    },
    {
      transaction: async (operation: (sql: CapturingSql) => unknown) =>
        operation(sql),
    },
  ) as CapturingSql;
  return sql;
}

function assertSourceBoundary(
  kind: EvidenceSource,
  statement: string,
  params: readonly unknown[],
) {
  switch (kind) {
    case "run_feedback":
      expect(statement).toContain("JOIN omni_events identity_event");
      expect(statement).toContain("run.status = 'completed'");
      expect(statement).toContain("run.feedback->>'verdict' = 'needs_work'");
      expect(statement).toContain("identity_event.type = 'run.agent_identity.bound'");
      expect(statement).toContain("identity_event.payload->>'logicalAgentId'");
      expect(statement).toContain("identity_event.payload->>'definitionVersion'");
      expect(params.filter((value) => value === "scout")).toHaveLength(2);
      return;
    case "project_artifact":
      expect(statement).toContain("JOIN omni_projects project");
      expect(statement).toContain("JOIN omni_workflow_runs workflow");
      expect(statement).toContain("artifact.status = 'verified'");
      expect(statement).toContain("artifact.verdict IN ('useful', 'needs_work')");
      expect(statement).toContain("'{metadata,agentIdentity,definition,logicalAgentId}'");
      expect(statement).toContain("'{metadata,agentIdentity,definition,definitionVersion}'");
      expect(params).toEqual(expect.arrayContaining([owner.actorId]));
      return;
    case "delegated_task":
      expect(statement).toContain("owner_actor_id = ?");
      expect(statement).toContain("delegate_agent_id = ?");
      expect(statement).toContain("delegate_definition_version = ?");
      expect(statement).toContain("state IN ('result_accepted', 'rejected')");
      return;
    case "scheduled_trigger":
      expect(statement).toContain("JOIN omni_workflow_triggers trigger");
      expect(statement).toContain("occurrence.owner_actor_id = ?");
      expect(statement).toContain("occurrence.status IN ('completed', 'failed')");
      expect(statement).toContain("'{agentIdentityPin,logicalAgentId}'");
      expect(statement).toContain("'{agentIdentityPin,definitionVersion}'");
  }
}

function identityPin(agentId: string, digestPrefix: string) {
  return {
    agentId,
    definitionVersion: 7,
    definitionSha256: digestPrefix.repeat(64),
    principalId: `principal:${agentId}`,
    principalGeneration: 1,
    principalSha256: digestPrefix.repeat(64),
  };
}
