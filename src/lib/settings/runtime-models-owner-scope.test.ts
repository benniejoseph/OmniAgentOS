import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  listModelAssignments: vi.fn(), listModelCatalog: vi.fn(), listProviderConnections: vi.fn(), getProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/settings/store", () => stores);

import { getDatabaseActorContext } from "@/lib/db/client";
import { getModelRuntime } from "@/lib/models/runtime-context";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { credentialBinding, openCredentialBundle, sealCredentialBundle } from "./credential-vault";
import { ModelRouteUnavailableError, resolveRuntimeModelAssignment, withRuntimeModelRequestCache } from "./runtime-models";
import type { ModelAssignment, ModelCatalogEntry, RedactedProviderConnection } from "./types";

const tenantId = "owner-scope-test", userId = "11111111-1111-4111-8111-111111111111";
const actorId = `actor:${userId}`, email = "synthetic-owner@example.test";
const binding: CanonicalRequestActorBindingV1 = Object.freeze({ version: 1, kind: "auth_user", authUserId: userId,
  canonicalActorId: actorId, legacyOwnerActorIds: Object.freeze([email]), readableOwnerActorIds: Object.freeze([actorId, email]) });
const at = "2026-10-28T00:00:00.000Z";
const assignment: ModelAssignment = { id: "assignment", tenantId, actorId: email, scope: "verifier", provider: "openai",
  modelId: "gpt-6-astra", allowCrossProviderFallback: false, runtimeReadiness: "active", runtimeNote: "active",
  contractVersion: "p11.8-model-assignment:1", revision: 9, configurationSha256: "a".repeat(64), validatedAt: at, createdAt: at, updatedAt: at };
const catalog: ModelCatalogEntry = { id: "catalog", tenantId, actorId: email, provider: "openai", modelId: "gpt-6-astra",
  displayName: "Synthetic model", capabilities: ["text", "tools"], lifecycle: "available", discoveredAt: at, updatedAt: at };
const connection: RedactedProviderConnection = { id: "connection", tenantId, actorId: email, provider: "openai", source: "tenant_vault",
  label: "Synthetic provider", status: "connected", enabled: true, credentialVersion: 1, configuredFields: ["apiKey"],
  runtimeReadiness: "active_tenant_runtime", runtimeNote: "active" };
let assignments: ModelAssignment[], catalogs: ModelCatalogEntry[], connections: RedactedProviderConnection[];
let observedScopes: string[][];

const resolve = (overrides: Partial<Parameters<typeof resolveRuntimeModelAssignment>[0]> = {}) => resolveRuntimeModelAssignment({
  tenantId, actorId, requestActorBinding: binding, scope: "verifier", tier: "reasoning", requiredFeature: "tools",
  deploymentFallback: { provider: "openai", model: "deployment-model", configured: true }, ...overrides,
});

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "test", keys: { test: Buffer.alloc(32, 7).toString("base64url") } }));
  assignments = [{ ...assignment }]; catalogs = [{ ...catalog }]; connections = [{ ...connection }]; observedScopes = [];
  for (const fn of Object.values(stores)) fn.mockReset();
  const read = <T extends { actorId: string }>(rows: () => T[]) => async ({ actorId: requested }: { actorId: string }) => {
    observedScopes.push(getDatabaseActorContext());
    return rows().filter(row => row.actorId === requested);
  };
  stores.listModelAssignments.mockImplementation(read(() => assignments));
  stores.listModelCatalog.mockImplementation(read(() => catalogs));
  stores.listProviderConnections.mockImplementation(read(() => connections));
  const sealed = sealCredentialBundle({ apiKey: "synthetic-key-not-a-live-credential" }, credentialBinding({
    tenantId, actorId: email, connectionId: connection.id, provider: "openai", credentialVersion: 1,
  }));
  stores.getProviderCredentials.mockImplementation(async (input: { tenantId: string; actorId: string; connectionId: string }) => {
    observedScopes.push(getDatabaseActorContext());
    return { connection: { ...connection }, credentials: openCredentialBundle(sealed, credentialBinding({ ...input, provider: "openai", credentialVersion: 1 })) };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("verified canonical model Settings owner", () => {
  it("selects the email-owned assignment and opens its real synthetic AAD while retaining canonical usage", async () => {
    const route = await resolve();
    expect(route).toMatchObject({ source: "tenant_assignment", model: "gpt-6-astra", assignmentId: assignment.id, assignmentRevision: 9 });
    expect(stores.getProviderCredentials).toHaveBeenCalledExactlyOnceWith({ tenantId, actorId: email, connectionId: connection.id });
    expect(observedScopes).toHaveLength(7);
    expect(observedScopes.every(scope => JSON.stringify(scope) === JSON.stringify([actorId, email]))).toBe(true);
    const request = route.bind({ input: "Synthetic request", usageScope: { tenantId, actorId, operation: "tool_turn", purpose: "test", sourceStreamId: "run" } });
    expect(request.usageScope).toMatchObject({ tenantId, actorId, assignmentId: assignment.id, assignmentRevision: 9, credentialSource: "tenant_vault" });
    expect(getModelRuntime(request)?.targets[0]).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
    await expect(route.withProviderApiKey("openai", async key => key === "synthetic-key-not-a-live-credential")).resolves.toBe(true);
    expect(JSON.stringify(route)).not.toContain("synthetic-key");
    expect(getDatabaseActorContext()).toEqual([]);
  });

  it("leaves an unbound canonical call exact-owner instead of guessing an email", async () => {
    const route = await resolve({ requestActorBinding: undefined });
    expect(route.source).toBe("deployment_environment");
    expect(stores.listModelAssignments.mock.calls.map(([input]) => input.actorId)).toEqual([actorId]);
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("keeps existing email-coordinate calls exact-owner even with their valid binding", async () => {
    expect((await resolve({ actorId: email })).source).toBe("tenant_assignment");
    expect(stores.listModelAssignments.mock.calls.map(([input]) => input.actorId)).toEqual([email]);
  });

  it("uses a canonical-owned provider connection with an email-owned assignment without rewriting either owner", async () => {
    connections[0].actorId = actorId;
    const sealed = sealCredentialBundle({ apiKey: "synthetic-canonical-key" }, credentialBinding({
      tenantId, actorId, connectionId: connection.id, provider: "openai", credentialVersion: 1,
    }));
    stores.getProviderCredentials.mockImplementation(async (input: { tenantId: string; actorId: string; connectionId: string }) => ({
      connection: connections[0], credentials: openCredentialBundle(sealed, credentialBinding({ ...input, provider: "openai", credentialVersion: 1 })),
    }));
    const route = await resolve();
    expect(route).toMatchObject({ assignmentId: assignment.id, model: assignment.modelId });
    expect(stores.getProviderCredentials).toHaveBeenCalledExactlyOnceWith({ tenantId, actorId, connectionId: connection.id });
    await expect(route.withProviderApiKey("openai", async key => key === "synthetic-canonical-key")).resolves.toBe(true);
  });

  it.each([
    ["another canonical actor", { actorId: "actor:22222222-2222-4222-8222-222222222222" }],
    ["another alias", { legacyOwnerActorIds: ["other@example.test"] }],
    ["additional aliases", { readableOwnerActorIds: [actorId, email, "other@example.test"] }],
    ["reversed aliases", { readableOwnerActorIds: [email, actorId] }],
    ["mismatched user identity", { authUserId: "22222222-2222-4222-8222-222222222222" }],
  ] as const)("refuses %s before any Settings or credential read", async (_label, change) => {
    const { actorId: otherActor, ...bindingChange } = change as Partial<CanonicalRequestActorBindingV1> & { actorId?: string };
    await expect(resolve({ actorId: otherActor ?? actorId, requestActorBinding: { ...binding, ...bindingChange } })).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.listModelAssignments).not.toHaveBeenCalled();
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(["assignment", "catalog", "connection"] as const)("rejects a foreign tenant in a %s row", async kind => {
    ({ assignment: assignments, catalog: catalogs, connection: connections }[kind])[0].tenantId = "foreign";
    await expect(resolve()).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("rejects rows returned outside the exact owner query", async () => {
    stores.listModelAssignments.mockResolvedValue([{ ...assignment, actorId: "other@example.test" }]);
    await expect(resolve()).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(["assignment", "catalog", "connection"] as const)("rejects conflicting canonical/email %s rows even when deployment fallback is enabled", async kind => {
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
    if (kind === "assignment") assignments.push({ ...assignment, id: "other-assignment", actorId });
    if (kind === "catalog") catalogs.push({ ...catalog, id: "other-catalog", actorId });
    if (kind === "connection") connections.push({ ...connection, id: "other-connection", actorId });
    await expect(resolve()).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(["tenant", "actor", "id", "provider", "disabled", "revoked"] as const)("refuses changed credential %s metadata without using deployment credentials", async change => {
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
    stores.getProviderCredentials.mockResolvedValue({ connection: { ...connection,
      ...(change === "tenant" ? { tenantId: "foreign" } : change === "actor" ? { actorId } : change === "id" ? { id: "other" }
        : change === "provider" ? { provider: "google" } : change === "disabled" ? { enabled: false } : { status: "revoked" }) }, credentials: { apiKey: "synthetic" } });
    await expect(resolve()).rejects.toMatchObject({ degradation: { outcome: "blocked", code: "credential_unavailable" } });
  });

  it("blocks a failed alias read rather than treating it as no saved assignment", async () => {
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
    stores.listModelCatalog.mockRejectedValue(new Error("Synthetic read unavailable"));
    await expect(resolve()).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("refuses an empty tenant even with a well-formed owner binding", async () => {
    await expect(resolve({ tenantId: "" })).rejects.toBeInstanceOf(ModelRouteUnavailableError);
    expect(stores.listModelAssignments).not.toHaveBeenCalled();
  });

  it("blocks a credential whose ciphertext is bound to another actor", async () => {
    connections[0].actorId = actorId;
    // The mock vault still contains the email-bound ciphertext. Opening it
    // with the selected canonical row owner must fail real AES-GCM AAD checks.
    await expect(resolve()).rejects.toMatchObject({ degradation: { outcome: "blocked", code: "credential_unavailable" } });
    expect(stores.getProviderCredentials).toHaveBeenCalledExactlyOnceWith({ tenantId, actorId, connectionId: connection.id });
  });

  it("blocks a saved assignment whose provider connection disappeared", async () => {
    vi.stubEnv("OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK", "true");
    connections = [];
    await expect(resolve()).rejects.toMatchObject({ degradation: { outcome: "blocked", code: "connection_unavailable" } });
    expect(stores.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not reuse an unbound Settings cache entry for the verified pair", async () => {
    await withRuntimeModelRequestCache(async () => {
      expect((await resolve({ requestActorBinding: undefined })).source).toBe("deployment_environment");
      expect((await resolve()).source).toBe("tenant_assignment");
      expect((await resolve()).source).toBe("tenant_assignment");
    })();
    expect(stores.listModelAssignments.mock.calls.map(([input]) => input.actorId)).toEqual([actorId, actorId, email]);
    expect(stores.getProviderCredentials).toHaveBeenCalledTimes(1);
  });
});
