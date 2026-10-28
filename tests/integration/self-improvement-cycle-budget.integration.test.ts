/** Real owner RLS and PostgreSQL guards; no provider, scheduler or production access. */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabaseClient, getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { createStudioProject } from "@/lib/studio/projects";
import { studioProjectProfileDefaults } from "@/lib/studio/contracts";
import type { SecurityContext } from "@/lib/security/types";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema, type ImprovementPhase } from "@/lib/self-improvement/runtime";
import { createSelfImprovementPolicy } from "@/lib/self-improvement/policy";
import { selfImprovementPolicySchema, selfImprovementSha256, type SelfImprovementPolicy } from "@/lib/self-improvement/contracts";
import { claimManualSelfImprovementCycle, configureSelfImprovement, getSelfImprovementCycle, pauseSelfImprovement,
  reserveSelfImprovementPhaseBudget, settleSelfImprovementPhaseBudget, transitionSelfImprovementCycle,
  updateSelfImprovementCycleRuntime, type StoredSelfImprovementCycle } from "@/lib/self-improvement/store";

const setup = vi.hoisted(() => ({ serving: false }));
vi.mock("@/lib/db/client", async (original) => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return { ...actual, ensureDatabaseSchema: () => setup.serving ? Promise.resolve() : actual.ensureDatabaseSchema() };
});
const candidate = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const tenantId = `cycle-budget-${randomUUID()}`, role = `cycle_budget_${randomBytes(6).toString("hex")}`;
const at = "2026-10-26T12:00:00.000Z", sha = "a".repeat(64);
type Actor = { userId: string; email: string; ownerActorId: string };
const scoped = <T>(actor: Actor, run: () => Promise<T>) => runWithDatabaseActorScope(tenantId, [actor.ownerActorId, actor.email], run);
const legacyPolicy = (dailyBudgetUsd: number) => {
  const { maxCycleBudgetUsd: _cap, policySha256: _hash, ...body } = createSelfImprovementPolicy({ dailyBudgetUsd, notifyOutcomes: false });
  return selfImprovementPolicySchema.parse({ ...body, policySha256: selfImprovementSha256("policy", body) });
};

candidate("Self-improvement separate daily and cycle budget PostgreSQL guards", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the disposable loopback candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the disposable loopback candidate is allowed.");
    await closeDatabaseClient();
    admin = postgres(address, { ssl: false, prepare: false, max: 2, onnotice: () => undefined });
    expect(Number((await admin`SELECT MAX(version) AS version FROM omni_schema_version`)[0].version)).toBe(266);
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.unsafe(`GRANT SELECT,INSERT,UPDATE ON omni_events,omni_projects TO ${role}`);
    await admin.unsafe(`GRANT SELECT,UPDATE ON omni_auth_users,omni_auth_memberships TO ${role}`);
    await admin.unsafe(`GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts,omni_project_tasks,omni_project_artifacts TO ${role}`);
    await admin.unsafe(`GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${role}`);
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Cycle budget regression',${tenantId})`;
    url.username = role; url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString()); vi.stubEnv("VERCEL", ""); vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", tenantId); setup.serving = true;
  });
  afterAll(async () => {
    await closeDatabaseClient();
    if (admin) { await admin.unsafe(`DROP OWNED BY ${role}`); await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  async function fixture(policy: SelfImprovementPolicy, now = at) {
    const userId = randomUUID(), actor = { userId, email: `${userId}@example.test`, ownerActorId: `actor:${userId}` };
    const owner = { tenantId, ownerActorId: actor.ownerActorId };
    await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${userId},${actor.email},'synthetic-no-login')`;
    await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${userId},'admin')`;
    vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", actor.ownerActorId);
    await scoped(actor, () => getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${actor.email})`);
    const context: SecurityContext = { tenantId, actorId: actor.email, source: "session", role: "operator",
      auth: { userId, email: actor.email, sessionId: "local-no-login", tenantName: "Budget regression" } };
    const project = await scoped(actor, () => createStudioProject(context, { title: "Synthetic budget verification", profile: studioProjectProfileDefaults("ai-tech", "Budget boundaries") }, randomUUID()));
    const repositoryId = String(100_000 + Number.parseInt(randomBytes(4).toString("hex"), 16));
    const configuration = await configureSelfImprovement({ ...owner, projectId: project.id, repositoryId,
      repository: { owner: "isolated", name: `budget-${repositoryId}`, defaultBranch: "main" }, policy, now });
    return { actor, owner, configuration, leaseTokens: new Map<string, string>() };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const request = (f: Fixture, key: string, now = at) => ({ owner: f.owner, configurationId: f.configuration.id,
    expectedGeneration: f.configuration.generation, baseRevision: "b".repeat(40), idempotencyKey: key, now });
  const fence = (f: Fixture, cycle: StoredSelfImprovementCycle, now = at) => {
    if (cycle.leaseToken) f.leaseTokens.set(cycle.cycle.id, cycle.leaseToken);
    const leaseToken = f.leaseTokens.get(cycle.cycle.id);
    if (!leaseToken) throw new Error("The fixture must retain its admitted execution token.");
    return { owner: f.owner, cycleId: cycle.cycle.id, expectedRevision: cycle.cycle.revision, leaseToken, now };
  };
  async function configure(f: Fixture, policy: SelfImprovementPolicy, now = at) {
    f.configuration = await configureSelfImprovement({ ...f.owner, projectId: f.configuration.projectId, repositoryId: f.configuration.repositoryId,
      repository: f.configuration.repository, policy, expectedGeneration: f.configuration.generation, now });
  }
  // Seed only synthetic historical rows for the already-shipped generic budget tests.
  // Actual new-cycle marker admission is exercised separately below.
  async function historical(cycle: StoredSelfImprovementCycle) {
    const snapshot = { ...cycle.cycle, revision: cycle.cycle.revision + 1 };
    await admin`UPDATE omni_self_improvement_cycles SET runtime='{}'::jsonb,revision=${snapshot.revision},snapshot=${JSON.stringify(snapshot)}::jsonb WHERE tenant_id=${tenantId} AND owner_actor_id=${cycle.cycle.scope.ownerActorId} AND id=${cycle.cycle.id}`;
    return { ...cycle, cycle: snapshot, runtime: {} };
  }
  async function phase(f: Fixture, cycle: StoredSelfImprovementCycle, value: ImprovementPhase) {
    return updateSelfImprovementCycleRuntime({ ...fence(f, cycle), runtime: { ...selfImprovementRuntimeSchema.parse(cycle.runtime), phase: value, phaseAttempt: null } });
  }
  async function complete(f: Fixture, cycle: StoredSelfImprovementCycle, actualUsd: number | null) {
    const runtime = selfImprovementRuntimeSchema.parse(cycle.runtime), attempt = runtime.phaseAttempt!;
    cycle = await settleSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: attempt.key, actualUsd, evidenceSha256: sha });
    if (actualUsd === null) return cycle;
    return updateSelfImprovementCycleRuntime({ ...fence(f, cycle), runtime: { ...runtime, phaseAttempt: null,
      agentRuns: [...runtime.agentRuns, { phase: attempt.phase, agentId: attempt.phase === "inspect" ? "atlas" : attempt.phase === "review" ? "sentinel" : "forge", runId: randomUUID(), costCeilingUsd: attempt.costCeilingUsd, completed: true }] } });
  }
  const reserve = (f: Fixture, cycle: StoredSelfImprovementCycle) => {
    const runtime = selfImprovementRuntimeSchema.parse(cycle.runtime);
    return reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: `${runtime.phase}:${runtime.agentRuns.length}`, engineeringPhase: runtime.phase });
  };
  async function finish(f: Fixture, cycle: StoredSelfImprovementCycle, now = at) {
    return transitionSelfImprovementCycle({ ...fence(f, cycle, now), nextStage: "no_change" });
  }

  it("preserves a legacy policy and gross20, then admits one bounded10 cycle without resetting earlier history", async () => {
    const f = await fixture(legacyPolicy(10));
    const first = (await claimManualSelfImprovementCycle(request(f, "legacy"))).cycle!;
    await finish(f, first);
    await configure(f, createSelfImprovementPolicy({ dailyBudgetUsd: 20, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    await finish(f, (await claimManualSelfImprovementCycle(request(f, "second"))).cycle!);
    const savedCycles = await scoped(f.actor, () => getSql()`SELECT id,snapshot FROM omni_self_improvement_cycles WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} ORDER BY id`);
    const savedReservations = await scoped(f.actor, () => getSql()`SELECT cycle_id,reserved_usd FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} ORDER BY cycle_id`);
    expect(savedReservations.reduce((sum, row) => sum + Number(row.reserved_usd), 0)).toBe(20);
    await configure(f, createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    const input = request(f, "third"), admitted = await claimManualSelfImprovementCycle(input);
    expect(admitted).toMatchObject({ outcome: "claimed", cycle: { cycle: { dailyReservationUsd: 10 } } });
    expect((await claimManualSelfImprovementCycle(input)).outcome).toBe("duplicate");
    expect((await claimManualSelfImprovementCycle(request(f, "overlap"))).outcome).toBe("busy");
    const rows = await scoped(f.actor, () => getSql()`SELECT cycle_id,reserved_usd FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} ORDER BY cycle_id`);
    expect(rows).toHaveLength(3); expect(rows.reduce((sum, row) => sum + Number(row.reserved_usd), 0)).toBe(30);
    expect(rows.filter(row => row.cycle_id !== admitted.cycle!.cycle.id)).toEqual(savedReservations);
    expect(await scoped(f.actor, () => getSql()`SELECT id,snapshot FROM omni_self_improvement_cycles WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND id<>${admitted.cycle!.cycle.id} ORDER BY id`)).toEqual(savedCycles);
    expect((await getSelfImprovementCycle(f.owner, first.cycle.id))?.cycle.policy).toEqual(legacyPolicy(10));
    let cycle = await historical(admitted.cycle!);
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "too-large", reservedUsd: 10.01 })).rejects.toThrow(/remaining/);
    cycle = (await reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "full-cycle", reservedUsd: 10 })).cycle;
    cycle = await settleSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "full-cycle", actualUsd: 10, evidenceSha256: sha });
    await finish(f, cycle);
    const fourth = await historical((await claimManualSelfImprovementCycle(request(f, "fourth"))).cycle!);
    // This insert used to compare owner-day spending to this cycle's10 allowance.
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, fourth), phaseId: "next-cycle", reservedUsd: 1 })).resolves.toMatchObject({ outcome: "reserved" });
  });

  it("serializes competing admissions at the exact daily limit and cannot recover capacity by pausing", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    for (let index = 0; index < 9; index++) await finish(f, (await claimManualSelfImprovementCycle(request(f, `cycle-${index}`))).cycle!);
    const concurrent = await Promise.all(["last-a", "last-b"].map(key => claimManualSelfImprovementCycle(request(f, key))));
    expect(concurrent.map(result => result.outcome).sort()).toEqual(["budget_exhausted", "claimed"]);
    await finish(f, concurrent.find(result => result.outcome === "claimed")!.cycle!);
    f.configuration = await pauseSelfImprovement({ owner: f.owner, configurationId: f.configuration.id, expectedGeneration: f.configuration.generation, paused: true, now: at });
    f.configuration = await pauseSelfImprovement({ owner: f.owner, configurationId: f.configuration.id, expectedGeneration: f.configuration.generation, paused: false, now: at });
    expect((await claimManualSelfImprovementCycle(request(f, "after-pause"))).outcome).toBe("budget_exhausted");
    const rows = await scoped(f.actor, () => getSql()`SELECT reserved_usd FROM omni_self_improvement_budget_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId}`);
    expect(rows).toHaveLength(10); expect(rows.reduce((sum, row) => sum + Number(row.reserved_usd), 0)).toBe(100);
    await expect(scoped(f.actor, () => getSql()`UPDATE omni_self_improvement_budget_reservations SET reserved_usd=0 WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId}`)).rejects.toThrow();
  });

  it("retains unknown carried-over usage against the daily ceiling independently of the smaller current cycle", async () => {
    const before = "2026-10-25T23:59:00.000Z", f = await fixture(legacyPolicy(100), before);
    let old = await historical((await claimManualSelfImprovementCycle(request(f, "unknown-previous-day", before))).cycle!);
    old = (await reserveSelfImprovementPhaseBudget({ ...fence(f, old, before), phaseId: "unmetered", reservedUsd: 95 })).cycle;
    old = await settleSelfImprovementPhaseBudget({ ...fence(f, old, before), phaseId: "unmetered", actualUsd: null, evidenceSha256: sha });
    await transitionSelfImprovementCycle({ ...fence(f, old, before), nextStage: "failed" });
    await configure(f, createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    const current = await historical((await claimManualSelfImprovementCycle(request(f, "today"))).cycle!);
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, current), phaseId: "six", reservedUsd: 6 })).rejects.toThrow(/daily UTC/);
    // Exercise the SQL guard directly, bypassing the application check but retaining runtime RLS.
    const insert = (phase: string, amount: number) => scoped(f.actor, () => getSql()`INSERT INTO omni_self_improvement_phase_reservations(tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,state,created_at)
      VALUES(${tenantId},${f.owner.ownerActorId},${current.cycle.id},${phase},${amount},'reserved',${at})`);
    await expect(insert("sql-six", 6)).rejects.toThrow(/Daily UTC/);
    const attempts = await Promise.allSettled(["a", "b"].map(phase => insert(phase, 5)));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await getSelfImprovementCycle(f.owner, old.cycle.id))?.usageState).toBe("unknown");
  });

  it("enforces invalid caps at the database boundary without rewriting existing sealed policy", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    for (const maxCycleBudgetUsd of [0, -1, 101, null, "10"]) {
      const policy = { ...f.configuration.policy, maxCycleBudgetUsd };
      await expect(scoped(f.actor, () => getSql()`UPDATE omni_self_improvement_configurations SET policy=${policy}::jsonb,generation=generation+1 WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND id=${f.configuration.id}`)).rejects.toThrow();
    }
    const rows = await scoped(f.actor, () => getSql()`SELECT policy FROM omni_self_improvement_configurations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND id=${f.configuration.id}`);
    expect(rows[0].policy).toEqual(f.configuration.policy);
    const constraints = await admin`SELECT convalidated FROM pg_constraint WHERE conname IN ('omni_self_improvement_configuration_cycle_budget_check','omni_self_improvement_cycle_budget_check')`;
    expect(constraints).toHaveLength(2); expect(constraints.every(row => row.convalidated === false)).toBe(true);
  });
  it("marks only new admission, preserves it through projections, and refuses legacy upgrades or pool bypass", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    let cycle = (await claimManualSelfImprovementCycle(request(f, "marked"))).cycle!;
    expect(cycle.runtime.engineeringAllocation).toBe("settled_pool_v1");
    expect((await claimManualSelfImprovementCycle(request(f, "marked"))).cycle?.runtime).toEqual(cycle.runtime);
    cycle = await updateSelfImprovementCycleRuntime({ ...fence(f, cycle), runtime: { ...initialSelfImprovementRuntime(), phase: "inspect" } });
    expect(cycle.runtime.engineeringAllocation).toBe("settled_pool_v1");
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "inspect:0", reservedUsd: 9 })).rejects.toThrow(/admitted engineering allocation/);
    await expect(updateSelfImprovementCycleRuntime({ ...fence(f, cycle), runtime: { ...cycle.runtime, engineeringAllocation: "other" } })).rejects.toThrow(/immutable/);
    cycle = await historical(cycle);
    await expect(updateSelfImprovementCycleRuntime({ ...fence(f, cycle), runtime: { ...initialSelfImprovementRuntime(), engineeringAllocation: "settled_pool_v1" } })).rejects.toThrow(/immutable/);
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "inspect:0", engineeringPhase: "inspect" })).rejects.toThrow(/admitted engineering allocation/);
    const legacy = await reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "legacy", reservedUsd: 1 });
    expect(legacy.cycle.runtime).toEqual({});
  });

  it("reuses settled dollars, retains gross telemetry, and never consumes the release tenth", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    let cycle = (await claimManualSelfImprovementCycle(request(f, "settled-pool"))).cycle!;
    const phases = ["inspect", "reproduce", "implement", "review", "implement", "review"] as const;
    const actuals = [0.1, 2.1, 2.1, 2.1, 0.60000001, 1.999999];
    const ceilings: number[] = [];
    for (const [index, value] of phases.entries()) {
      cycle = await phase(f, cycle, value);
      const admitted = await reserve(f, cycle); cycle = admitted.cycle;
      ceilings.push(admitted.reservation.reservedUsd);
      expect(selfImprovementRuntimeSchema.parse(cycle.runtime).phaseAttempt?.costCeilingUsd).toBe(admitted.reservation.reservedUsd);
      cycle = await complete(f, cycle, actuals[index]);
    }
    expect(ceilings).toEqual([9, 8.9, 6.8, 4.7, 2.6, 1.999999]);
    expect(cycle.spendUsd).toBeCloseTo(8.99999901, 8);
    expect(Number(cycle.runtime.reservedModelUsd)).toBeGreaterThan(9);
    cycle = await phase(f, cycle, "review");
    await expect(reserve(f, cycle)).rejects.toThrow(/engineering pool/);
    const rows = await scoped(f.actor, () => getSql()`SELECT state,actual_usd,reserved_usd FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND cycle_id=${cycle.cycle.id}`);
    expect(rows).toHaveLength(6); expect(rows.every(row => row.state === "settled")).toBe(true);
    expect(rows.reduce((sum, row) => sum + Number(row.actual_usd), 0)).toBeLessThanOrEqual(9);
  });

  it("serializes pool-one contenders, holds duplicate reservations, and refuses stale leases and unknown usage", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    let cycle = await phase(f, (await claimManualSelfImprovementCycle(request(f, "concurrent-pool"))).cycle!, "inspect");
    const original = cycle;
    const contenders = await Promise.allSettled([reserve(f, cycle), reserve(f, cycle)]);
    expect(contenders.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter(result => result.status === "rejected")).toHaveLength(1);
    cycle = contenders.find(result => result.status === "fulfilled")!.value.cycle;
    const duplicate = await reserve(f, cycle);
    expect(duplicate.outcome).toBe("duplicate"); expect(duplicate.reservation.reservedUsd).toBe(9);
    expect(duplicate.cycle.cycle.revision).toBe(cycle.cycle.revision);
    await expect(reserve(f, original)).rejects.toThrow(/stale/);
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), leaseToken: "wrong-token", phaseId: "inspect:0", engineeringPhase: "inspect" })).rejects.toThrow(/stale/);
    await expect(reserveSelfImprovementPhaseBudget({ ...fence(f, cycle), phaseId: "review:0", engineeringPhase: "review" })).rejects.toThrow(/current cycle attempt/);
    cycle = await complete(f, cycle, null);
    await expect(reserve(f, cycle)).rejects.toThrow(/Unknown usage/);
    expect(await scoped(f.actor, () => getSql()`SELECT phase_id FROM omni_self_improvement_phase_reservations WHERE tenant_id=${tenantId} AND owner_actor_id=${f.owner.ownerActorId} AND cycle_id=${cycle.cycle.id}`)).toHaveLength(1);
  });

  it("charges full unresolved reservations to the pool even before actual usage is known", async () => {
    const f = await fixture(createSelfImprovementPolicy({ dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, notifyOutcomes: false }));
    let cycle = await phase(f, (await claimManualSelfImprovementCycle(request(f, "outstanding-pool"))).cycle!, "inspect");
    // A retained reservation from an interrupted old admission must not become free capacity.
    await scoped(f.actor, () => getSql()`INSERT INTO omni_self_improvement_phase_reservations(tenant_id,owner_actor_id,cycle_id,phase_id,reserved_usd,state,created_at)
      VALUES(${tenantId},${f.owner.ownerActorId},${cycle.cycle.id},'retained-unresolved',7.12345678,'reserved',${at})`);
    const admitted = await reserve(f, cycle); cycle = admitted.cycle;
    expect(admitted.reservation.reservedUsd).toBe(1.876543);
    expect(cycle.runtime.phaseAttempt).toMatchObject({ costCeilingUsd: 1.876543 });
  });

});
