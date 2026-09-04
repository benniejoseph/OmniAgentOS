import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RedactedServiceApiKey,
  RequestServiceApiKey,
} from "@/lib/settings/types";

type StoredServiceApiKey = RedactedServiceApiKey & { tokenHash: string };

const storeMocks = vi.hoisted(() => ({
  getServiceApiKeyRecord: vi.fn(
    async (_input: { tenantId: string; keyId: string }): Promise<StoredServiceApiKey | undefined> =>
      undefined,
  ),
  insertServiceApiKey: vi.fn(async (record: StoredServiceApiKey) => record),
  listServiceApiKeyRecords: vi.fn(async () => [] as StoredServiceApiKey[]),
  listServiceApiKeyRecordsForRequest: vi.fn(
    async () => [] as RequestServiceApiKey[],
  ),
  updateServiceApiKeyRecord: vi.fn(
    async (_input: {
      tenantId: string;
      actorId: string;
      keyId: string;
      status?: "revoked";
      lastUsedAt?: string;
    }): Promise<StoredServiceApiKey | undefined> => undefined,
  ),
}));
const eventMocks = vi.hoisted(() => ({
  appendDomainEventSafely: vi.fn(async () => undefined),
}));

vi.mock("@/lib/settings/store", () => storeMocks);
vi.mock("@/lib/events/store", () => eventMocks);

import {
  createServiceApiKey,
  listServiceApiKeysForRequest,
  resolveServiceApiKeyToken,
} from "@/lib/settings/service-api-keys";

const tenantId = "tenant-a";
const actorId = "actor-a";

describe("service API key identity compatibility", () => {
  beforeEach(() => {
    storeMocks.getServiceApiKeyRecord.mockReset();
    storeMocks.insertServiceApiKey.mockReset().mockImplementation(
      async (record: StoredServiceApiKey) => record,
    );
    storeMocks.listServiceApiKeyRecords.mockReset();
    storeMocks.listServiceApiKeyRecordsForRequest.mockReset();
    storeMocks.updateServiceApiKeyRecord.mockReset();
    eventMocks.appendDomainEventSafely.mockReset();
  });

  it("issues asael_sk keys with the versioned Asael digest domain", async () => {
    const created = await createServiceApiKey({
      tenantId,
      actorId,
      name: "MCP client",
      scopes: ["mcp:discover"],
    });

    expect(created.token).toMatch(/^asael_sk_/);
    expect(created.record.tokenPrefix).toMatch(/^asael_sk_/);
    expect(storeMocks.insertServiceApiKey).toHaveBeenCalledOnce();

    const stored = storeMocks.insertServiceApiKey.mock.calls[0]![0];
    expect(stored.tokenHash).toBe(
      digestToken("asael:service-api-key:v1\0", created.token),
    );
    expect(stored.tokenHash).not.toBe(
      digestToken("omniagent:service-api-key:v1\0", created.token),
    );

    storeMocks.getServiceApiKeyRecord.mockResolvedValue(stored);
    storeMocks.updateServiceApiKeyRecord.mockResolvedValue(stored);

    await expect(resolveServiceApiKeyToken(created.token)).resolves.toEqual({
      keyId: stored.id,
      tenantId,
      actorId,
      name: "MCP client",
      scopes: ["mcp:discover"],
    });
  });

  it("rejects control characters in service-key names before persistence", async () => {
    await expect(createServiceApiKey({
      tenantId,
      actorId,
      name: "Automation\nkey",
      scopes: ["mcp:discover"],
    })).rejects.toThrow("unsupported characters");
    expect(storeMocks.insertServiceApiKey).not.toHaveBeenCalled();
  });

  it("continues to verify omni_sk keys with the legacy digest domain", async () => {
    const keyId = "123e4567-e89b-12d3-a456-426614174000";
    const tenantSegment = Buffer.from(tenantId, "utf8").toString("base64url");
    const secret = "A".repeat(43);
    const token = `omni_sk_${tenantSegment}.${keyId}.${secret}`;
    const now = new Date().toISOString();
    const stored: StoredServiceApiKey = {
      id: keyId,
      tenantId,
      actorId,
      name: "Legacy MCP client",
      tokenHash: digestToken("omniagent:service-api-key:v1\0", token),
      tokenPrefix: `omni_sk_${tenantSegment}…${keyId.slice(0, 8)}`,
      tokenLastFour: secret.slice(-4),
      scopes: ["mcp:discover"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    storeMocks.getServiceApiKeyRecord.mockResolvedValue(stored);
    storeMocks.updateServiceApiKeyRecord.mockResolvedValue(stored);

    await expect(resolveServiceApiKeyToken(token)).resolves.toEqual({
      keyId,
      tenantId,
      actorId,
      name: "Legacy MCP client",
      scopes: ["mcp:discover"],
    });
    expect(storeMocks.getServiceApiKeyRecord).toHaveBeenCalledWith({
      tenantId,
      keyId,
    });
  });

  it("returns only the request-safe key projection", async () => {
    const requestRecord: RequestServiceApiKey = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      tenantId,
      actorId,
      name: "Read-only key",
      tokenPrefix: "asael_sk_dGVuYW50LW…123e4567",
      tokenLastFour: "abcd",
      scopes: ["mcp:discover"],
      status: "active",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
      manageable: false,
    };
    storeMocks.listServiceApiKeyRecordsForRequest.mockResolvedValue([
      requestRecord,
    ]);

    const input = {
      tenantId,
      actorId,
      requestActorBinding: undefined,
    };
    await expect(listServiceApiKeysForRequest(input)).resolves.toEqual([
      requestRecord,
    ]);
    expect(storeMocks.listServiceApiKeyRecordsForRequest).toHaveBeenCalledWith(
      input,
    );
    expect(JSON.stringify(requestRecord)).not.toContain("tokenHash");
  });
});

function digestToken(domain: string, token: string) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(token, "utf8")
    .digest("hex");
}
