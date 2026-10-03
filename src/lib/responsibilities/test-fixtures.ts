import type { ResponsibilityDraft, ResponsibilityPins } from "./contracts";
export const ownerFixture = { tenantId: "tenant-a", actorId: "actor:11111111-1111-4111-8111-111111111111" };
export const nowFixture = "2026-10-04T00:00:00.000Z";
export const draftFixture: ResponsibilityDraft = {
  schemaVersion: 1, purpose: "Prepare for the selected meeting", desiredOutcome: "An evidence-backed owner brief",
  sources: [{ kind: "thread", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  cadence: { frequency: "daily", interval: 1, timezone: "Asia/Kolkata", startsAt: nowFixture, expiresAt: "2026-10-11T00:00:00.000Z", missedPolicy: "skip" },
  limits: { maxChecks: 7, maxNotifications: 3, cumulative: { modelTurns: 7, tokens: 70_000, costMicrousd: 1_000_000, wallTimeMs: 700_000, toolCalls: 30, browserActions: 0, agents: 7, fanOut: 0, retries: 3, replans: 0 } },
  notificationRule: { kind: "material_change_only", destination: "owner_in_app", quietOnNoChange: true },
  successCondition: "The owner has the meeting brief", stopConditions: ["Meeting begins"],
  work: { workspaceId: "workspace:owner", projectId: "project-a", workItemId: "work-a" }, procedureId: "meeting-brief", agentId: "atlas",
};
export const pinsFixture: ResponsibilityPins = {
  sources: [{ source: draftFixture.sources[0], revisionSha256: "a".repeat(64) }],
  work: { ...draftFixture.work!, projectionSha256: "b".repeat(64) },
  procedure: { id: "meeting-brief", snapshotSha256: "c".repeat(64), toolBindingsSha256: "d".repeat(64) },
  agent: { id: "atlas", definitionVersionId: "atlas:v1", principalVersionId: "atlas-principal:v1", identityPinSha256: "e".repeat(64), policySha256: "f".repeat(64) },
};
