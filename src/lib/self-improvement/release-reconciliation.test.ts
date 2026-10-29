import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { sealEngineeringSignal } from "./evidence";
import { createSelfImprovementPolicy } from "./policy";
import { sealSelfImprovementCandidate, sealSelfImprovementReleaseBinding, sealSelfImprovementValidation } from "./contracts";
import { executeSelfImprovementControllerAction, selfImprovementControllerActionSchema } from "./release-service";
import { reconcileSelfImprovementWebPredeploymentFailure } from "./store";

// Exercise the real service, store predicates and terminal transition. Only
// database transport, notifications and independent HTTP transport are synthetic.
const db = vi.hoisted(() => ({ sql: vi.fn(), event: vi.fn(), notify: vi.fn(),
  row: null as Record<string, unknown> | null, phases: [] as Record<string, unknown>[], admin: true, project: true }));
vi.mock("@/lib/availability-watches/store", () => ({ withAvailabilityOwner: async (_scope: unknown, work: (sql: typeof db.sql) => Promise<unknown>) => work(db.sql) }));
vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: db.event }));
vi.mock("./notifications", () => ({ admitSelfImprovementNotificationWithSql: db.notify }));
vi.mock("@/lib/app-builder/github", () => ({ readBuilderGithubReleaseProof: vi.fn(), readBuilderGithubNativeOnlyAdvance: vi.fn() }));

const now = "2026-10-29T12:00:00.000Z", expired = "2026-10-29T11:50:00.000Z";
const userId = "11111111-1111-4111-8111-111111111111", owner = { tenantId: "synthetic-tenant", ownerActorId: `actor:${userId}` };
const auth: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId, email: "owner@example.test", sessionId: "synthetic-session", tenantName: "Synthetic" } };
const sha = (value: string) => value.repeat(64), git = (value: string) => value.repeat(40);
function fixture() {
  const scope = { ...owner, repository: { owner: "synthetic", name: "app", defaultBranch: "main" }, baseRevision: git("a") };
  const policy = createSelfImprovementPolicy({ maxCycleBudgetUsd: 10 });
  const signal = sealEngineeringSignal({ version: 1, scope, kind: "owner_correction", symptomSha256: sha("a"), summary: "Synthetic validation failure",
    observations: [{ sourceKind: "owner_feedback", sourceId: "synthetic", sourceSha256: sha("b"), observedAt: expired, outcome: "needs_work" }] });
  const candidate = sealSelfImprovementCandidate({ revision: git("b"), workspaceSha256: sha("c"), diffSha256: sha("d"),
    changedFiles: [{ path: "src/lib/example.ts", beforeSha256: sha("e"), afterSha256: sha("f") }], changedLines: 5, architectureImpact: "minor" });
  const validation = sealSelfImprovementValidation({ scope, policySha256: policy.policySha256, signalSha256: signal.signalSha256, candidateSha256: candidate.candidateSha256,
    candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256,
    checks: (["focused_regression", "adjacent_regression", "typecheck", "independent_review"] as const).map(kind => ({ id: kind, kind, outcome: "passed", producerKind: kind === "independent_review" ? "agent_review" : "command", producerId: `synthetic:${kind}`, candidateRevision: candidate.revision, workspaceSha256: candidate.workspaceSha256, evidenceSha256: sha("a"), declaredCases: 1, executedCases: 1, failedCases: 0, completedAt: expired })) });
  const release = sealSelfImprovementReleaseBinding({ releaseId: "synthetic-release", scope, previousRevision: git("a"), sourceCandidateRevision: git("b"), candidateRevision: git("c"),
    sourceTree: git("d"), mergedTree: git("d"), pullRequestUrl: "https://github.com/synthetic/app/pull/1", candidateSha256: candidate.candidateSha256,
    policySha256: policy.policySha256, validationSha256: validation.validationSha256, runner: "asael_paired_production" });
  const cycle = { id: "synthetic-cycle", scope, policy, signal, candidate, validation, release, releaseReceipt: null, approval: null,
    stage: "releasing", revision: 76, correctionsUsed: 0, dailyReservationUsd: 10, createdAt: expired, updatedAt: expired,
    pullRequestUrl: release.pullRequestUrl };
  const hold = { category: "trusted_command_failed", occurredAt: expired };
  const phaseId = "release:synthetic-controller";
  return { row: { id: cycle.id, tenant_id: owner.tenantId, owner_actor_id: owner.ownerActorId, configuration_id: "synthetic-configuration", configuration_generation: 55,
    project_id: "synthetic-project", repository_id: "42", budget_day: "2026-10-29", lease_expires_at: expired, lease_token_sha256: sha("e"),
    release_controller_id: "synthetic-controller", controller_hold: hold, snapshot: cycle, stage: cycle.stage, revision: 76,
    runtime: { phase: "release_wait" }, spend_usd: 3.820655, usage_state: "known", policy_sha256: policy.policySha256, base_revision: git("a"), reservation_usd: 10 },
  phases: [
    { phase_id: "inspect:0", reserved_usd: 9, actual_usd: 3.820655, state: "settled", evidence_sha256: sha("b") },
    { phase_id: phaseId, reserved_usd: 1, actual_usd: 0, state: "settled", evidence_sha256: canonicalJsonSha256({ releaseBudget: { phaseId, reservedUsd: 1 }, usage: null, started: false }) },
  ], action: { action: "reconcile_web_predeployment_failure" as const, cycleId: cycle.id, expectedRevision: 76, controllerId: "synthetic-controller",
    releaseBindingSha256: release.releaseBindingSha256, controllerHoldSha256: canonicalJsonSha256(hold),
    attestation: { version: 1 as const, kind: "operator_attested_predeployment_failure" as const, diagnosticSha256: sha("d"), attemptEvidenceSha256: sha("e"), recordedAt: now } } };
}
let state: ReturnType<typeof fixture>;
let fetchMock: ReturnType<typeof vi.fn>;
const priorPair = { webRevision: git("a"), workerRevision: git("a"), manifestSha256: canonicalJsonSha256("synthetic-prior-manifest"), serverHealthEvidenceSha256: sha("d"), observedAt: now };
const reconcile = () => reconcileSelfImprovementWebPredeploymentFailure({ owner, action: state.action, priorPair, now });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_TENANT_ID", owner.tenantId); vi.stubEnv("OMNIAGENT_SELF_IMPROVEMENT_OWNER_ACTOR_ID", owner.ownerActorId);
  state = fixture(); db.row = state.row; db.phases = state.phases; db.admin = true; db.project = true;
  db.event.mockReset(); db.notify.mockReset(); db.sql.mockReset();
  db.sql.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("SELECT membership.role")) return db.admin ? [{ role: "admin" }] : [];
    if (query.includes("omni_studio_projects_v1")) return db.project ? [{ project_id: "synthetic-project" }] : [];
    if (query.includes("SELECT cycle.*")) return db.row && values[0] === db.row.tenant_id && values[1] === db.row.owner_actor_id && values[2] === db.row.id ? [db.row] : [];
    if (query.includes("SELECT * FROM omni_self_improvement_cycles")) {
      expect(query).toContain("FOR UPDATE");
      return db.row && values[0] === db.row.id && values[1] === db.row.tenant_id && values[2] === db.row.owner_actor_id ? [db.row] : [];
    }
    if (query.includes("SELECT * FROM omni_self_improvement_phase_reservations")) {
      expect(values).toEqual([owner.tenantId, owner.ownerActorId, state.action.cycleId]); expect(query).toContain("FOR UPDATE"); return db.phases;
    }
    if (query.startsWith("UPDATE omni_self_improvement_cycles")) {
      expect(values.slice(6, 8)).toEqual([null, null]); // No replacement lease, even on success.
      expect(values.slice(9)).toEqual([state.action.cycleId, owner.tenantId, owner.ownerActorId, db.row?.revision]);
      db.row = { ...db.row, stage: values[0], revision: values[1], snapshot: values[2], runtime: values[3], spend_usd: values[4], usage_state: values[5], updated_at: values[8] };
      return [db.row];
    }
    throw new Error(`Unexpected SQL in narrow reconciliation: ${query}`);
  });
  fetchMock = vi.fn(async (url: string) => Response.json(url.includes("fly.dev") ?
    { status: "healthy", service: "asael-openai-egress", revision: git("a") } :
    { status: "healthy", revision: git("a"), releaseManifest: "synthetic-prior-manifest" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("operator terminal reconciliation of a held predeployment web release", () => {
  it("records failure and exact attestation without changing liability, hold, binding or lease", async () => {
    const before = structuredClone(db.row), phases = structuredClone(db.phases);
    const result = await executeSelfImprovementControllerAction(auth, state.action);
    expect(result).toMatchObject({ cycleId: state.action.cycleId, stage: "failed", revision: 77, automaticRetry: false,
      reconciliation: "operator_attested_predeployment_failure", receipt: { outcome: "failed", releaseBindingSha256: state.action.releaseBindingSha256,
        webRevision: git("a"), workerRevision: git("a"), evidenceSha256: canonicalJsonSha256(state.action), serverHealthEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    for (const key of ["runtime", "spend_usd", "usage_state", "reservation_usd", "controller_hold", "release_controller_id", "lease_token_sha256", "lease_expires_at"]) expect(db.row![key]).toEqual(before![key]);
    expect(db.phases).toEqual(phases); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.event).toHaveBeenCalledWith(expect.objectContaining({ type: "self_improvement.release.operator_reconciled", payload: expect.objectContaining({ attestation: state.action.attestation, outcome: "failed", automaticRetry: false }) }), expect.anything());
  });
  it("returns only the exact terminal replay after the serving pair changes, without another write or health read", async () => {
    const original = await executeSelfImprovementControllerAction(auth, state.action), snapshot = structuredClone(db.row);
    db.event.mockClear(); db.notify.mockClear(); db.sql.mockClear(); fetchMock.mockClear(); fetchMock.mockRejectedValue(new Error("A later release now serves"));
    vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
    expect(await executeSelfImprovementControllerAction(auth, state.action)).toEqual(original);
    expect(db.row).toEqual(snapshot); expect(fetchMock).not.toHaveBeenCalled(); expect(db.event).not.toHaveBeenCalled(); expect(db.notify).not.toHaveBeenCalled();
    expect(db.sql.mock.calls.some(([parts]) => /^UPDATE/.test(parts.join("")))).toBe(false);
    await expect(executeSelfImprovementControllerAction(auth, { ...state.action, attestation: { ...state.action.attestation, diagnosticSha256: sha("f") } })).rejects.toThrow(/expired, exactly attested/);
    db.admin = false; await expect(executeSelfImprovementControllerAction(auth, state.action)).rejects.toThrow(/administrator/);
  });
  it.each(["revision", "controller", "binding", "hold", "missing-hold", "live-lease", "unknown-usage", "stale-attestation", "pre-hold-attestation", "not-releasing"])("refuses the %s fence inside the locked store", async mode => {
    if (mode === "revision") state.action.expectedRevision--;
    if (mode === "controller") state.action.controllerId = "other-controller";
    if (mode === "binding") state.action.releaseBindingSha256 = sha("f");
    if (mode === "hold") state.action.controllerHoldSha256 = sha("f");
    if (mode === "missing-hold") db.row!.controller_hold = null;
    if (mode === "live-lease") db.row!.lease_expires_at = "2026-10-29T12:01:00.000Z";
    if (mode === "unknown-usage") db.row!.usage_state = "unknown";
    if (mode === "stale-attestation") state.action.attestation.recordedAt = "2026-10-29T11:54:00.000Z";
    if (mode === "pre-hold-attestation") { state.action.attestation.recordedAt = "2026-10-29T11:59:00.000Z"; db.row!.lease_expires_at = "2026-10-29T11:59:30.000Z"; }
    if (mode === "not-releasing") { state.row.snapshot.stage = "ready_for_release"; db.row!.stage = "ready_for_release"; }
    await expect(reconcile()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled(); expect(db.event).not.toHaveBeenCalled();
  });
  it.each(["unknown", "reserved", "missing-actual", "over-reservation", "sum-mismatch", "no-release", "other-release", "nonzero-release", "started-true", "arbitrary-zero-digest"])("preserves the held state for %s usage", async mode => {
    if (mode === "unknown" || mode === "reserved") db.phases[0].state = mode;
    if (mode === "missing-actual") db.phases[0].actual_usd = null;
    if (mode === "over-reservation") db.phases[0].reserved_usd = 1;
    if (mode === "sum-mismatch") db.row!.spend_usd = 4;
    if (mode === "no-release") db.phases.pop();
    if (mode === "other-release") db.phases.push({ ...db.phases[1], phase_id: "release:other-controller" });
    if (mode === "nonzero-release") { db.phases[1].actual_usd = 0.01; db.row!.spend_usd = 3.830655; }
    if (mode === "started-true") db.phases[1].evidence_sha256 = canonicalJsonSha256({ releaseBudget: { phaseId: "release:synthetic-controller", reservedUsd: 1 }, usage: null, started: true });
    if (mode === "arbitrary-zero-digest") db.phases[1].evidence_sha256 = sha("a");
    await expect(reconcile()).rejects.toThrow(/usage|pre-dispatch/);
    expect(fetchMock).not.toHaveBeenCalled(); expect(db.event).not.toHaveBeenCalled(); expect(db.row!.stage).toBe("releasing");
  });
  it.each(["new-web", "new-worker", "unhealthy", "health-error"])("refuses %s independent evidence without writing", async mode => {
    fetchMock.mockImplementation(async (url: string) => {
      if (mode === "health-error") throw new Error("Unavailable");
      const worker = url.includes("fly.dev");
      return Response.json({ status: mode === "unhealthy" ? "unhealthy" : "healthy", ...(worker ? { service: "asael-openai-egress" } : { releaseManifest: "synthetic-prior-manifest" }),
        revision: mode === (worker ? "new-worker" : "new-web") ? git("c") : git("a") });
    });
    await expect(executeSelfImprovementControllerAction(auth, state.action)).rejects.toThrow();
    expect(db.event).not.toHaveBeenCalled(); expect(db.row!.stage).toBe("releasing");
  });
  it("requires the retained manifest when the binding has a separately observed prior pair", async () => {
    const { releaseBindingSha256: _old, ...release } = state.row.snapshot.release;
    state.row.snapshot.release = sealSelfImprovementReleaseBinding({ ...release, pairedBaseline: { webRevision: git("a"), workerRevision: git("a"), manifestSha256: sha("e") } });
    state.action.releaseBindingSha256 = state.row.snapshot.release.releaseBindingSha256;
    await expect(executeSelfImprovementControllerAction(auth, state.action)).rejects.toThrow(/prior serving pair/); expect(db.event).not.toHaveBeenCalled();
  });
  it("keeps the action closed to execution, budget, lease and success overrides", () => {
    expect(selfImprovementControllerActionSchema.parse(state.action)).toEqual(state.action);
    for (const extra of [{ leaseToken: "new" }, { outcome: "deployed" }, { budget: 100 }, { retry: true }, { mergedRevision: git("c") }, { receipt: {} }]) {
      expect(selfImprovementControllerActionSchema.safeParse({ ...state.action, ...extra }).success).toBe(false);
    }
  });
  it.each(["absent", "stale", "future"])("requires a fresh private server observation: %s", async mode => {
    const observed = mode === "absent" ? undefined : { ...priorPair, observedAt: mode === "stale" ? "2026-10-29T11:59:29.000Z" : "2026-10-29T12:00:01.000Z" };
    await expect(reconcileSelfImprovementWebPredeploymentFailure({ owner, action: state.action, priorPair: observed, now })).rejects.toThrow(/prior serving pair/);
    expect(db.event).not.toHaveBeenCalled();
  });
  it.each(["internal", "mobile", "operator", "foreign", "revoked", "project"])("requires current exact owner session authority: %s", async mode => {
    const context = mode === "internal" || mode === "mobile" ? { ...auth, source: mode } : mode === "operator" ? { ...auth, role: "operator" as const } : mode === "foreign" ? { ...auth, tenantId: "foreign" } : auth;
    if (mode === "revoked") db.admin = false;
    if (mode === "project") db.project = false;
    await expect(executeSelfImprovementControllerAction(context as SecurityContext, state.action)).rejects.toThrow();
    if (mode !== "revoked" && mode !== "project") expect(fetchMock).not.toHaveBeenCalled();
    expect(db.event).not.toHaveBeenCalled();
  });
  it("matches the retained maintained started=false envelope, without importing private attempt content", () => {
    expect(canonicalJsonSha256({ releaseBudget: { phaseId: "release:asael-mac-self-improvement", reservedUsd: 1 }, usage: null, started: false }))
      .toBe("1762ec1e3b2872b64a5d04b870080ee4074abb4497030578a1e1dd9100d56ec3");
  });
});
