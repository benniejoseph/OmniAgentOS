import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { instantSchema } from "./contracts";
import { PILOT_CHECK_RESERVATION, reserveResponsibilityBudget, settleResponsibilityBudget, verifyCumulativeBudget, zeroResponsibilityBudget } from "./cumulative-budget";
import { RESPONSIBILITY_RUNTIME_CONTRACT, pilotConfigurationSchema, responsibilityLifecycleRequestSchema, responsibilityLifecycleSchema, responsibilityWakeSchema, runtimeReceiptSchema,
  type PilotConfiguration, type ResponsibilityLifecycle, type ResponsibilityLifecycleRequest, type ResponsibilityRuntimeReceipt, type ResponsibilityWake } from "./runtime-contracts";
import { idempotencySha256, ResponsibilityError, storageInvalid, type ResponsibilityOwner } from "./state";

export function verifyPilotConfiguration(value: unknown): PilotConfiguration {
  const config = pilotConfigurationSchema.parse(value); const { configurationSha256, ...body } = config;
  if (configurationSha256 !== canonicalJsonSha256(body) || canonicalJsonSha256(config.checkReservation) !== canonicalJsonSha256(PILOT_CHECK_RESERVATION) ||
    config.pins.sources.length !== 1 || canonicalJsonSha256(config.pins.sources[0].source) !== canonicalJsonSha256(config.source) ||
    config.tool.input.workspaceId !== config.source.workspaceId ||
    (config.pilot === "native_meeting_metadata_v1" ? config.tool.input.meetingId !== config.source.id :
      config.tool.input.workItemId !== config.source.id || config.tool.input.projectId !== config.source.projectId ||
      config.pins.work.workItemId !== config.source.id || config.pins.work.workspaceId !== config.source.workspaceId || config.pins.work.projectId !== config.source.projectId)) throw storageInvalid();
  reserveResponsibilityBudget({ limits: config.cumulativeLimits, maximumChecks: config.maximumChecks, used: zeroResponsibilityBudget(), reserved: zeroResponsibilityBudget(), usedChecks: 0, reservedChecks: 0 }, config.checkReservation);
  return config;
}
export function verifyLifecycle(value: unknown): ResponsibilityLifecycle {
  const current = responsibilityLifecycleSchema.parse(value); verifyPilotConfiguration(current.configuration); verifyCumulativeBudget(current.budget);
  if (current.updatedAt < current.activatedAt || (current.state !== "active" && current.nextDueAt !== null) ||
    current.budget.maximumChecks !== current.configuration.maximumChecks || canonicalJsonSha256(current.budget.limits) !== canonicalJsonSha256(current.configuration.cumulativeLimits)) throw storageInvalid();
  return current;
}
export function verifyWake(value: unknown): ResponsibilityWake {
  const wake = responsibilityWakeSchema.parse(value);
  const terminal = isTerminalWake(wake);
  if (terminal !== (wake.settledAt !== null) || terminal !== (wake.charged !== null) || (wake.startedAt === null && ["running", "uncertain"].includes(wake.state)) ||
    ((wake.observationId === null) !== (wake.observationReceiptSha256 === null)) || (wake.state === "completed" && !wake.observationId) ||
    ((wake.leaseTokenSha256 === null) !== (wake.leaseExpiresAt === null))) throw storageInvalid();
  return wake;
}
export const isTerminalWake = (wake: ResponsibilityWake) => ["completed", "failed", "canceled"].includes(wake.state);
export const responsibilityWakeId = (current: ResponsibilityLifecycle, scheduledFor: string) => `responsibility-wake:${canonicalJsonSha256([current.tenantId, current.actorId, current.responsibilityId, current.generation, instantSchema.parse(scheduledFor)])}`;

/** A new review may replace reference versions, never the saved responsibility's
 * scope, schedule or finite bounds. This is deliberately separate from an
 * ordinary pause/resume, which still requires the original exact configuration. */
export function assertResponsibilityRecovery(currentValue: ResponsibilityLifecycle, configurationValue: PilotConfiguration, reviewedAt?: string) {
  const current = verifyLifecycle(currentValue); const configuration = verifyPilotConfiguration(configurationValue);
  if (current.state !== "blocked" || current.reason !== "authority_changed" || current.budget.reservedChecks !== 0 || Object.values(current.budget.reserved).some((amount) => amount !== 0) ||
    !reviewedAt || instantSchema.parse(reviewedAt) <= current.updatedAt || configuration.responsibilityRevision <= current.configuration.responsibilityRevision ||
    configuration.reviewSha256 === current.configuration.reviewSha256 ||
    !sameResponsibilityRecoveryScope(configuration, current.configuration)) throw conflict("responsibility_recovery_changed");
}
export function sameResponsibilityRecoveryScope(left: PilotConfiguration, right: PilotConfiguration) {
  return canonicalJsonSha256(recoveryScope(left)) === canonicalJsonSha256(recoveryScope(right));
}
function recoveryScope(configuration: PilotConfiguration) {
  const { responsibilityRevision: _revision, reviewSha256: _review, configurationSha256: _hash, pins, tool, ...scope } = configuration;
  void _revision; void _review; void _hash;
  const { contractSha256: _contract, ...toolScope } = tool; void _contract;
  return { ...scope, tool: toolScope, pins: {
    sources: pins.sources.map(({ source }) => source),
    work: { workspaceId: pins.work.workspaceId, projectId: pins.work.projectId, workItemId: pins.work.workItemId },
    procedure: { id: pins.procedure.id }, agent: { id: pins.agent.id },
  } };
}

/** Called under the same owner lock as wake reservations. A stop changes
 * generation immediately, but retains transitional state while receipts remain
 * outstanding. Resume never replenishes cumulative counters. */
export function changeResponsibilityLifecycle(input: {
  owner: ResponsibilityOwner; responsibilityId: string; request: ResponsibilityLifecycleRequest; current: ResponsibilityLifecycle | null;
  configuration?: PilotConfiguration; reviewedAt?: string; now: string; nextDueAt?: string | null;
}): ResponsibilityLifecycle {
  const { owner, responsibilityId } = input; const request = responsibilityLifecycleRequestSchema.parse(input.request); const now = instantSchema.parse(input.now);
  const current = input.current ? verifyLifecycle(input.current) : null;
  if (current && (current.tenantId !== owner.tenantId || current.actorId !== owner.actorId || current.responsibilityId !== responsibilityId)) throw storageInvalid();
  if ((current?.revision ?? 0) !== request.expectedRevision || (current?.generation ?? 0) !== request.expectedGeneration) throw conflict("responsibility_lifecycle_changed");
  if (current && now < current.updatedAt) throw conflict("responsibility_clock_changed");
  if (request.action === "activate") {
    if (current || !input.configuration) throw conflict("responsibility_already_activated");
    const configuration = verifyPilotConfiguration(input.configuration);
    if (configuration.pilot !== request.acknowledgePilot || configuration.configurationSha256 !== request.configurationSha256 || configuration.cadence.expiresAt <= now || !input.nextDueAt) throw conflict("responsibility_activation_changed");
    return verifyLifecycle({ schemaVersion: 1, contract: RESPONSIBILITY_RUNTIME_CONTRACT, ...owner, responsibilityId,
      revision: 1, generation: 1, state: "active", reason: "owner_activated", configuration, nextDueAt: input.nextDueAt,
      budget: { limits: configuration.cumulativeLimits, maximumChecks: configuration.maximumChecks, used: zeroResponsibilityBudget(), reserved: zeroResponsibilityBudget(), usedChecks: 0, reservedChecks: 0 }, activatedAt: now, updatedAt: now });
  }
  if (!current) throw conflict("responsibility_not_activated");
  if (request.action === "resume") {
    if (!input.configuration) throw conflict("responsibility_resume_changed");
    const configuration = verifyPilotConfiguration(input.configuration);
    if (current.state === "blocked") {
      assertResponsibilityRecovery(current, configuration, input.reviewedAt);
      if (input.reviewedAt! > now) throw conflict("responsibility_clock_changed");
    }
    else if (current.state !== "paused" || configuration.configurationSha256 !== current.configuration.configurationSha256) throw conflict("responsibility_resume_changed");
    if (current.budget.reservedChecks !== 0 || request.configurationSha256 !== configuration.configurationSha256 || request.acknowledgePilot !== configuration.pilot ||
      configuration.cadence.expiresAt <= now || !input.nextDueAt || input.nextDueAt < now || input.nextDueAt >= configuration.cadence.expiresAt) throw conflict("responsibility_resume_changed");
    reserveResponsibilityBudget(current.budget, current.configuration.checkReservation);
    return verifyLifecycle({ ...current, configuration, revision: current.revision + 1, generation: current.generation + 1, state: "active", reason: "owner_resumed", nextDueAt: input.nextDueAt, updatedAt: now });
  }
  if (current.state === "ended" || (request.action === "pause" && current.state !== "active")) throw conflict("responsibility_transition_unavailable");
  const pending = current.budget.reservedChecks > 0;
  return verifyLifecycle({ ...current, revision: current.revision + 1, generation: current.generation + 1,
    state: request.action === "end" ? pending ? "ending" : "ended" : pending ? "pausing" : "paused",
    reason: request.action === "end" ? "owner_ended" : "owner_paused", nextDueAt: null, updatedAt: now });
}

export function reserveResponsibilityWake(currentValue: ResponsibilityLifecycle, now: string, nextDueAt: string | null) {
  const current = verifyLifecycle(currentValue); instantSchema.parse(now);
  if (current.state !== "active" || !current.nextDueAt || current.nextDueAt > now || current.configuration.cadence.expiresAt <= now || current.budget.reservedChecks > 0) throw conflict("responsibility_wake_unavailable");
  const budget = reserveResponsibilityBudget(current.budget, current.configuration.checkReservation);
  const wake = verifyWake({ schemaVersion: 1, id: responsibilityWakeId(current, current.nextDueAt), tenantId: current.tenantId, actorId: current.actorId, responsibilityId: current.responsibilityId,
    generation: current.generation, configurationSha256: current.configuration.configurationSha256, scheduledFor: current.nextDueAt,
    revision: 1, state: "reserved", reservation: current.configuration.checkReservation, charged: null, workflowRunId: null, operationJobId: null,
    leaseGeneration: 0, leaseTokenSha256: null, leaseExpiresAt: null, startedAt: null, settledAt: null, observationId: null, observationReceiptSha256: null, createdAt: now, updatedAt: now });
  return { current: verifyLifecycle({ ...current, revision: current.revision + 1, budget, nextDueAt, updatedAt: now }), wake };
}

export function settleResponsibilityWake(input: { current: ResponsibilityLifecycle; wake: ResponsibilityWake; now: string;
  outcome: "completed" | "failed" | "canceled" | "uncertain"; observation?: { id: string; receiptSha256: string } }) {
  const current = verifyLifecycle(input.current); const wake = verifyWake(input.wake); instantSchema.parse(input.now);
  if (wake.tenantId !== current.tenantId || wake.actorId !== current.actorId || wake.responsibilityId !== current.responsibilityId ||
    wake.configurationSha256 !== current.configuration.configurationSha256 || wake.generation > current.generation || isTerminalWake(wake)) throw conflict("responsibility_settlement_changed");
  if ((input.outcome === "completed") !== Boolean(input.observation) || (input.outcome === "uncertain" && !wake.startedAt) ||
    (input.outcome === "canceled" && wake.startedAt)) throw conflict("responsibility_settlement_unconfirmed");
  // Actual model/token/provider usage cannot occur in this closed pilot. Charge
  // its entire finite dispatch reservation when terminal; no guessed savings.
  const charged = wake.startedAt ? wake.reservation : zeroResponsibilityBudget();
  const budget = settleResponsibilityBudget(current.budget, wake.reservation, input.outcome === "uncertain" ? { kind: "uncertain_started" }
    : wake.startedAt ? { kind: "terminal", charged } : { kind: "unstarted" });
  const state = budget.reservedChecks === 0 ? current.state === "pausing" ? "paused" : current.state === "ending" ? "ended" : current.state : current.state;
  return { current: verifyLifecycle({ ...current, revision: current.revision + 1, state, budget, updatedAt: input.now }),
    wake: verifyWake({ ...wake, revision: wake.revision + 1, state: input.outcome, charged: input.outcome === "uncertain" ? null : charged,
      settledAt: input.outcome === "uncertain" ? null : input.now, observationId: input.observation?.id ?? null, observationReceiptSha256: input.observation?.receiptSha256 ?? null,
      leaseTokenSha256: input.outcome === "uncertain" ? wake.leaseTokenSha256 : null,
      leaseExpiresAt: input.outcome === "uncertain" ? wake.leaseExpiresAt : null, updatedAt: input.now }) };
}
export function buildRuntimeReceipt(input: { key: string; request: unknown; action: ResponsibilityRuntimeReceipt["action"]; previousRevision: number; current: ResponsibilityLifecycle; wake?: ResponsibilityWake | null }) {
  const snapshot = verifyLifecycle(input.current); const key = idempotencySha256(input.key);
  const body = { schemaVersion: 1 as const, id: `responsibility-runtime-receipt:${canonicalJsonSha256([snapshot.tenantId, snapshot.actorId, key])}`,
    idempotencySha256: key, requestSha256: canonicalJsonSha256(input.request), action: input.action, previousRevision: input.previousRevision,
    snapshot, wake: input.wake ? verifyWake(input.wake) : null, savedAt: snapshot.updatedAt };
  return verifyRuntimeReceipt({ ...body, receiptSha256: canonicalJsonSha256(body) });
}
export function verifyRuntimeReceipt(value: unknown) {
  const receipt = runtimeReceiptSchema.parse(value); const { receiptSha256, ...body } = receipt;
  verifyLifecycle(receipt.snapshot); if (receipt.wake) verifyWake(receipt.wake);
  if (receiptSha256 !== canonicalJsonSha256(body) || receipt.snapshot.revision !== receipt.previousRevision + 1 || receipt.savedAt !== receipt.snapshot.updatedAt ||
    receipt.id !== `responsibility-runtime-receipt:${canonicalJsonSha256([receipt.snapshot.tenantId, receipt.snapshot.actorId, receipt.idempotencySha256])}`) throw storageInvalid();
  return receipt;
}
function conflict(code: string) { return new ResponsibilityError("The responsibility lifecycle or exact wake changed. Reload its current receipt.", 409, code); }
