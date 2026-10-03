import { describe, expect, it } from "vitest";
import { MODEL_ASSIGNMENT_SCOPES, MODEL_PROVIDERS, type SettingsSnapshot } from "@/lib/settings/types";
import { modelSupportsAssignmentRole } from "@/lib/settings/model-assignment-contract";
import { modelSupportsUiRole } from "./settings-advanced-editors";
import { confirmedSettingsMetadata, createAdvancedSettingsGate, reconcileSettingsDraft, settingsMutationReplayable, settingsSnapshot, validateSettingsMutation, type SettingsMutation } from "./settings-advanced-state";

const at = "2026-10-04T10:00:00.000Z";
const owner = { tenantId: "tenant-synthetic", actorId: "actor-synthetic" };
const provider = { ...owner, id: "provider-synthetic", provider: "openai" as const, label: "Synthetic provider", source: "tenant_vault" as const, status: "connected" as const, enabled: true, credentialVersion: 2, configuredFields: ["apiKey"], runtimeReadiness: "active_tenant_runtime" as const, runtimeNote: "Configured", createdAt: at, updatedAt: at, manageable: true };
const assignment = { ...owner, id: "assignment-synthetic", scope: "main_agent" as const, provider: "openai" as const, modelId: "synthetic-model", displayModelId: "synthetic-model", allowCrossProviderFallback: false, runtimeReadiness: "active" as const, runtimeNote: "Active configuration", contractVersion: "p11.8-model-assignment:1" as const, revision: 1, configurationSha256: "a".repeat(64), createdAt: at, updatedAt: at, manageable: true };
const mcp = { ...owner, enabled: false, serverName: "Synthetic MCP", allowedScopes: ["mcp:discover"] as Array<"mcp:discover">, defaultApprovalMode: "governed" as const, exposeResources: false, endpointPath: "/api/mcp" as const, readiness: "disabled" as const, createdAt: at, updatedAt: at, manageable: true };
const key = { ...owner, id: "key-synthetic", name: "Synthetic client", tokenPrefix: "asael_sk_redacted", tokenLastFour: "abcd", scopes: ["mcp:discover"], status: "active", createdAt: at, updatedAt: at };
const snapshot: SettingsSnapshot = {
  requestReadContracts: { providerConnections: "readable_v1", modelAssignments: "readable_v1", mcpExportConfiguration: "readable_v1" },
  platform: { authEnforced: true, bootstrapConfigured: false, databaseConfigured: true, storageBackend: "postgres" }, vault: { configured: true, message: "Ready" },
  providers: [provider], assignments: [assignment], models: [], apiKeys: [], mcp,
  runtime: { contractVersion: "p11.8-functional-model-routing:1", tenantAssignmentsConsumed: true, activeScopes: ["main_agent"], configurationOnlyScopes: [], receipts: [], message: "No call receipt" },
};
const providerRequest: SettingsMutation = { kind: "provider.rotate", label: "Rotate", path: "/synthetic", method: "POST", id: provider.id, provider: "openai", credentialVersion: 1 };

describe("Advanced Settings lifecycle gate", () => {
  it("admits exactly one synchronous effect and releases it only through its ticket", () => {
    const gate = createAdvancedSettingsGate(); const first = gate.begin();
    expect(() => gate.begin()).toThrow("pending"); expect(first.current()).toBe(true);
    first.release(); const second = gate.begin(); first.release();
    expect(second.current()).toBe(true); expect(first.current()).toBe(false);
  });
  it("fences replaced reads and all reads preceding an effect", () => {
    const gate = createAdvancedSettingsGate(); const first = gate.read("settings"); const second = gate.read("settings");
    expect(first.signal.aborted).toBe(true); expect(first.current()).toBe(false); expect(second.current()).toBe(true);
    const action = gate.begin(); expect(second.signal.aborted).toBe(true); expect(second.current()).toBe(false); expect(second.owned()).toBe(true);
    action.release(); expect(second.current()).toBe(false); expect(gate.read("settings").current()).toBe(true);
  });
  it("does not resurrect an effect after a same-owner permission refresh", () => {
    const gate = createAdvancedSettingsGate(); const action = gate.begin(); gate.availability(false);
    expect(action.current()).toBe(false); expect(() => gate.begin()).toThrow("permissions");
    gate.availability(true); expect(action.current()).toBe(false); action.release(); expect(gate.begin().current()).toBe(true);
  });
  it("disposes both reads and writes before owner replacement", () => {
    const gate = createAdvancedSettingsGate(); const read = gate.read("settings"); const action = gate.begin(); gate.dispose();
    expect(read.current()).toBe(false); expect(action.current()).toBe(false); expect(gate.live()).toBe(false); expect(() => gate.begin()).toThrow();
  });
  it("fails closed at 30 uncertain actions without evicting an exact retry", () => {
    const gate = createAdvancedSettingsGate();
    for (let index = 0; index < 30; index++) expect(gate.retry(`digest-${index}`, true, () => `key-${index}`)).toBe(`key-${index}`);
    expect(() => gate.retry("digest-31", true, () => "new")).toThrow("unconfirmed outcomes");
    expect(gate.retry("digest-0", true, () => "must-not-replace")).toBe("key-0");
    gate.confirmed("digest-0"); expect(gate.retry("digest-31", true, () => "new")).toBe("new");
    expect(gate.retry("digest-1", true, () => "must-not-replace")).toBe("key-1");
  });
  it("does not invent replay support for an uncertain compatibility write", () => {
    const gate = createAdvancedSettingsGate(); gate.retry("legacy-digest", false, () => "local-attempt");
    expect(() => gate.retry("legacy-digest", false, () => "duplicate")).toThrow("no replay contract");
    expect(settingsMutationReplayable("provider.rotate")).toBe(false); expect(settingsMutationReplayable("key.create")).toBe(false);
    expect(settingsMutationReplayable("mcp")).toBe(true); expect(settingsMutationReplayable("provider.validate")).toBe(true);
  });
});
describe("Advanced Settings draft continuity", () => {
  it("retains an unsaved draft and its original review basis when source changes", () => {
    const state = { observed: "v1", basis: "v1", original: { name: "Old" }, draft: { name: "My draft" } };
    expect(reconcileSettingsDraft(state, "v2", { name: "Other writer" })).toEqual({ ...state, observed: "v2" });
  });
  it("adopts a fresh source only for a clean draft", () => {
    expect(reconcileSettingsDraft({ observed: "v1", basis: "v1", original: "A", draft: "A" }, "v2", "B")).toEqual({ observed: "v2", basis: "v2", original: "B", draft: "B" });
  });
  it("leaves a same-version user draft untouched", () => {
    const state = { observed: "v1", basis: "v1", original: "A", draft: "typed" };
    expect(reconcileSettingsDraft(state, "v1", "A")).toBe(state);
  });
});
describe("Settings read and exact response validation", () => {
  it("accepts a complete acknowledged read without manufacturing call receipts", () => {
    expect(settingsSnapshot(snapshot)).toBe(snapshot); expect(settingsSnapshot(snapshot).runtime.receipts).toEqual([]);
  });
  it("rejects a missing source, coerced enum and duplicate identity", () => {
    expect(() => settingsSnapshot({ ...snapshot, providers: undefined })).toThrow("incomplete");
    expect(() => settingsSnapshot({ ...snapshot, providers: [{ ...provider, provider: ["openai"] }] })).toThrow();
    expect(() => settingsSnapshot({ ...snapshot, providers: [provider, provider] })).toThrow();
    expect(() => settingsSnapshot({ ...snapshot, mcp: { ...mcp, manageable: "true" } })).toThrow();
  });
  it("accepts distinct retained and manageable connections for the same provider", () => {
    expect(settingsSnapshot({ ...snapshot, providers: [provider, { ...provider, id: "retained", actorId: "retained-owner", manageable: false }] }).providers).toHaveLength(2);
  });
  it("rejects a different tenant and a false manageable-owner projection", () => {
    expect(() => settingsSnapshot(snapshot, { ...owner, tenantId: "other-tenant" })).toThrow();
    expect(() => settingsSnapshot({ ...snapshot, providers: [{ ...provider, actorId: "other-actor" }] }, owner)).toThrow();
    expect(settingsSnapshot({ ...snapshot, providers: [{ ...provider, actorId: "retained-actor", manageable: false }] }, owner).providers[0].manageable).toBe(false);
  });
  it("requires the exact provider identity, owner and advanced credential version", () => {
    expect(validateSettingsMutation({ connection: provider }, providerRequest, owner)).toEqual({ connection: provider });
    for (const changed of [{ id: "other" }, { actorId: "other" }, { tenantId: "other" }, { credentialVersion: 1 }, { credentialVersion: undefined }]) expect(() => validateSettingsMutation({ connection: { ...provider, ...changed } }, providerRequest, owner)).toThrow("reviewed identity");
  });
  it("does not call a validation error a successful connection", () => {
    const result = validateSettingsMutation({ connection: { ...provider, status: "error", validationCode: "authentication_failed" } }, { ...providerRequest, kind: "provider.validate" }, owner);
    expect(confirmedSettingsMetadata(result)).toContainEqual({ label: "status", value: "error" });
  });
  it("rejects an assignment receipt for a different model or consent", () => {
    const request: SettingsMutation = { kind: "assignment", label: "Save route", path: "/synthetic", method: "PUT", body: { scope: "main_agent", provider: "openai", modelId: "synthetic-model" } };
    expect(validateSettingsMutation({ assignment }, request, owner)).toEqual({ assignment });
    expect(() => validateSettingsMutation({ assignment: { ...assignment, modelId: "other" } }, request, owner)).toThrow();
    expect(() => validateSettingsMutation({ assignment: { ...assignment, allowCrossProviderFallback: true } }, request, owner)).toThrow();
  });
  it("binds a one-time token to the exact created key and never stores it in display metadata", () => {
    const token = "asael_sk_synthetic.key-synthetic.random-secret-abcd";
    const request: SettingsMutation = { kind: "key.create", label: "Create", path: "/synthetic", method: "POST", body: { name: key.name, scopes: key.scopes } };
    expect(validateSettingsMutation({ record: key, token }, request, owner).token).toBe(token);
    expect(() => validateSettingsMutation({ record: { ...key, id: "wrong" }, token }, request, owner)).toThrow();
    expect(() => validateSettingsMutation({ record: { ...key, scopes: ["memory:write"] }, token }, request, owner)).toThrow();
    expect(JSON.stringify(confirmedSettingsMetadata({ record: { ...key, credentials: "secret", extraToken: token }, token }))).not.toContain("random-secret");
    expect(JSON.stringify(confirmedSettingsMetadata({ record: { ...key, credentials: "credential-value" } }))).not.toContain("credential-value");
  });
  it("checks exact governed MCP configuration and refuses extra scope", () => {
    const request: SettingsMutation = { kind: "mcp", label: "Save", path: "/synthetic", method: "PUT", body: { enabled: false, serverName: mcp.serverName, allowedScopes: mcp.allowedScopes, exposeResources: false } };
    expect(validateSettingsMutation({ mcp }, request, owner)).toEqual({ mcp });
    expect(() => validateSettingsMutation({ mcp: { ...mcp, allowedScopes: [...mcp.allowedScopes, "memory:write"] } }, request, owner)).toThrow();
    expect(() => validateSettingsMutation({ mcp: { ...mcp, defaultApprovalMode: "automatic" } }, request, owner)).toThrow();
  });
  it("keeps the UI role filter equal to every current server role contract", () => {
    const capabilities = ["tools", "text", "embeddings", "vision", "audio", "transcription", "image", "video", "computer_use", "speech", "semantic_decision", "unknown"];
    for (const scope of MODEL_ASSIGNMENT_SCOPES) for (const provider of MODEL_PROVIDERS) for (const capability of capabilities) {
      expect(modelSupportsUiRole(scope, { provider, capabilities: [capability] }), `${scope}/${provider}/${capability}`).toBe(modelSupportsAssignmentRole(scope, provider, { capabilities: [capability] }));
    }
  });
});
