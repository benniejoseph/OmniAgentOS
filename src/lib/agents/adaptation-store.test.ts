import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: () => true,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  AGENT_ADAPTATION_EVENT_TYPES,
  activateAgentAdaptation,
  evaluateAgentAdaptation,
  getActiveAgentAdaptationGuidance,
  observeAgentAdaptationEvidence,
  rollbackAgentAdaptation,
} from "@/lib/agents/adaptation-store";

const owner = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T06:00:00.000Z"));
  vi.clearAllMocks();
});

describe("P7.6 Agent adaptation store", () => {
  it("observes exact owner feedback without activating it", async () => {
    const database = fakeAdaptationSql();
    mocks.getSql.mockReturnValue(database.sql);

    const adaptations = await observeAgentAdaptationEvidence("scout", 1, owner);

    expect(adaptations).toHaveLength(1);
    expect(adaptations[0]).toMatchObject({
      state: "observed",
      confidence: 0.95,
      effect: { guidance: "Cite the exact source." },
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AGENT_ADAPTATION_EVENT_TYPES.observed,
        payload: expect.not.objectContaining({ guidance: expect.anything() }),
      }),
      { sql: database.sql },
    );
  });

  it("evaluates, activates with a numbered version, and rolls back", async () => {
    const database = fakeAdaptationSql();
    mocks.getSql.mockReturnValue(database.sql);
    const [observed] = await observeAgentAdaptationEvidence("scout", 1, owner);

    const evaluated = await evaluateAgentAdaptation(
      "scout",
      observed.adaptationId,
      1,
      owner,
    );
    expect(evaluated[0]).toMatchObject({
      state: "evaluated",
      evaluation: { verdict: "passed", definitionVersion: 1 },
    });
    const active = await activateAgentAdaptation(
      "scout",
      observed.adaptationId,
      1,
      owner,
    );
    expect(active[0]).toMatchObject({ state: "active", activationVersion: 1 });
    const guidance = await getActiveAgentAdaptationGuidance({
      tenantId: owner.tenantId,
      ownerActorId: owner.canonicalActorId,
      agentId: "scout",
      definitionVersion: 1,
    });
    expect(guidance).toEqual([
      expect.objectContaining({
        activationVersion: 1,
        guidance: "Cite the exact source.",
      }),
    ]);
    expect(await getActiveAgentAdaptationGuidance({
      tenantId: owner.tenantId,
      ownerActorId: owner.canonicalActorId,
      agentId: "scout",
      definitionVersion: 2,
    })).toEqual([]);

    const rolledBack = await rollbackAgentAdaptation(
      "scout",
      observed.adaptationId,
      1,
      owner,
    );
    expect(rolledBack[0]).toMatchObject({
      state: "rolled_back",
      activationVersion: 1,
    });
  });
});

function fakeAdaptationSql() {
  let adaptation: Record<string, unknown> | undefined;
  const callable = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const statement = strings.join("?");
      if (/FROM omni_agent_runs/.test(statement)) {
        return [{
          id: "run-one",
          agent_id: "scout",
          feedback: {
            verdict: "needs_work",
            correction: "Cite the exact source.",
            updatedAt: "2026-09-07T05:00:00.000Z",
          },
          grounding: { status: "verified" },
          completed_at: "2026-09-07T04:59:00.000Z",
          started_at: "2026-09-07T04:00:00.000Z",
        }];
      }
      if (/INSERT INTO omni_agent_adaptations/.test(statement)) {
        adaptation = {
          schema_version: 1,
          tenant_id: params[0],
          adaptation_id: params[1],
          agent_definition_id: params[2],
          owner_actor_id: params[3],
          owner_binding_sha256: params[4],
          observed_definition_version: params[5],
          state: params[6],
          lifecycle_revision: params[7],
          evidence: params[8],
          evidence_sha256: params[9],
          confidence: params[10],
          effect_kind: params[11],
          effect_payload: params[12],
          evaluation: null,
          evaluation_sha256: null,
          evaluated_definition_version: null,
          activation_version: null,
          created_at: params[13],
          updated_at: params[14],
          evaluated_at: null,
          activated_at: null,
          rolled_back_at: null,
        };
        return [adaptation];
      }
      if (/SELECT pg_advisory_xact_lock/.test(statement)) return [{}];
      if (/MAX\(activation_version\)/.test(statement)) return [{ next_version: 1 }];
      if (/UPDATE omni_agent_adaptations/.test(statement)) {
        if (!adaptation) return [];
        adaptation = {
          ...adaptation,
          state: params[0],
          lifecycle_revision: params[1],
          evaluation: params[2],
          evaluation_sha256: params[3],
          evaluated_definition_version: params[4],
          activation_version: params[5],
          updated_at: params[6],
          evaluated_at: params[7],
          activated_at: params[8],
          rolled_back_at: params[9],
        };
        return [adaptation];
      }
      if (/FROM omni_agent_adaptations/.test(statement)) {
        if (!adaptation) return [];
        if (/state = 'active'/.test(statement)) {
          return adaptation.state === "active" &&
              Number(adaptation.evaluated_definition_version) === Number(params[3])
            ? [adaptation]
            : [];
        }
        return [adaptation];
      }
      return [];
    },
    {
      transaction: async (callback: (sql: unknown) => unknown) => callback(callable),
    },
  );
  return { sql: callable };
}
