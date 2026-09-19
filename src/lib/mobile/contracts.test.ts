import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
  nativeBootstrapResponseSchema,
  nativeContractDiscovery,
  nativeContractSchemas,
  nativeConversationEventSchema,
  nativeConversationRequestSchema,
  nativeLocalComputerClaimResponseForClient,
  nativeLoginRequestSchema,
  nativeOperationsForVersion,
  nativePushReceiptResponseSchema,
} from "@/lib/mobile/contracts";

describe("native API contracts", () => {
  it("retains exactly the current and previous rollout versions", () => {
    expect(NATIVE_API_CURRENT_VERSION).toBe(18);
    expect(NATIVE_API_PREVIOUS_VERSION).toBe(17);
    expect(nativeOperationsForVersion(8)?.length).toBeLessThan(
      nativeOperationsForVersion(7)?.length || 0,
    );
    expect(nativeOperationsForVersion(9)?.length).toBe(
      (nativeOperationsForVersion(8)?.length || 0) + 3,
    );
    expect(nativeOperationsForVersion(10)?.length).toBe(
      (nativeOperationsForVersion(9)?.length || 0) + 1,
    );
    expect(nativeOperationsForVersion(11)?.length).toBe(
      (nativeOperationsForVersion(10)?.length || 0) + 5,
    );
    expect(nativeOperationsForVersion(12)?.length).toBe(
      nativeOperationsForVersion(11)?.length,
    );
    expect(nativeOperationsForVersion(13)?.length).toBe(
      nativeOperationsForVersion(12)?.length,
    );
    expect(nativeOperationsForVersion(14)?.length).toBe(
      (nativeOperationsForVersion(13)?.length || 0) - 1,
    );
    expect(nativeOperationsForVersion(15)?.length).toBe(
      (nativeOperationsForVersion(14)?.length || 0) + 3,
    );
    expect(nativeOperationsForVersion(16)?.length).toBe(
      (nativeOperationsForVersion(15)?.length || 0) + 1,
    );
    expect(nativeOperationsForVersion(17)?.length).toBe(
      (nativeOperationsForVersion(16)?.length || 0) + 5,
    );
    expect(nativeOperationsForVersion(18)?.length).toBe(
      (nativeOperationsForVersion(17)?.length || 0) + 2,
    );
    expect(nativeContractSchemas.NativeContractDiscovery.parse(
      nativeContractDiscovery(),
    ).supportedVersions).toEqual([18, 17]);
  });

  it("exposes only explicit local Computer Use in the current request schema", () => {
    const request = {
      message: "Open the chart on this Mac.",
      requestId: "native-local-computer-a",
      computerUseTarget: "local_macos",
    };
    expect(nativeConversationRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      computerUseTarget: "isolated_browser",
    }).success).toBe(false);
  });

  it("does not advertise unenrolled native mutations in v8", () => {
    const v8OperationIds = new Set(
      nativeOperationsForVersion(8)?.map((operation) => operation.id),
    );
    const v7OperationIds = new Set(
      nativeOperationsForVersion(7)?.map((operation) => operation.id),
    );
    const unenrolledMutationIds = [
      "agents.create", "agents.update", "agents.delete",
      "skills.create", "skills.update", "skills.delete",
      "memory.create", "memory.update", "memory.delete",
      "memory.graph.rebuild", "knowledge.source.delete",
      "missions.create", "missions.update", "admin.workflows.tick",
    ];
    expect(unenrolledMutationIds.every((id) => v7OperationIds.has(id))).toBe(true);
    expect(unenrolledMutationIds.every((id) => !v8OperationIds.has(id))).toBe(true);
  });

  it("adds only scoped reads for durable conversations in v9", () => {
    const v8OperationIds = new Set(
      nativeOperationsForVersion(8)?.map((operation) => operation.id),
    );
    const v9Operations = nativeOperationsForVersion(9) || [];
    const v9OperationIds = new Set(v9Operations.map((operation) => operation.id));
    expect([...v9OperationIds].filter((id) => !v8OperationIds.has(id))).toEqual([
      "threads.list",
      "threads.get",
      "capture.asset.get",
    ]);
    expect(
      v9Operations
        .filter((operation) => !v8OperationIds.has(operation.id))
        .every((operation) => operation.method === "GET" && operation.auth === "bearer"),
    ).toBe(true);
    expect(
      v9Operations.find((operation) => operation.id === "memory.list"),
    ).toMatchObject({
      method: "GET",
      path: "/api/memory",
      queryParameters: [
        { name: "threadId", type: "string", maxLength: 200 },
        { name: "limit", type: "integer", maximum: 100 },
      ],
    });
  });

  it("generates the current Dart capability set and native paths", async () => {
    const dart = await readFile(
      new URL(
        "../../../apps/flutter/lib/generated/native_contract.g.dart",
        import.meta.url,
      ),
      "utf8",
    );

    expect(dart).toContain("static const operationIds = <String>{");
    expect(dart).toContain("'market.backtests.run',");
    expect(dart).toContain("'threads.list',");
    expect(dart).toContain("'threads.get',");
    expect(dart).toContain("'capture.asset.get',");
    expect(dart).not.toContain("'evidence.run.computerFrame',");
    expect(dart).toContain("'localComputer.device',");
    expect(dart).toContain("'localComputer.command.claim',");
    expect(dart).toContain("'localComputer.command.complete',");
    expect(dart).toContain("'localComputer.stop',");
    expect(dart).not.toContain("evidenceRunComputerFrame");
    expect(dart).toContain("static const localComputerDevice = '/api/mobile/computer-use/device';");
    expect(dart).toMatch(
      /static const localComputerCommandClaim\s*=\s*'\/api\/mobile\/computer-use\/commands\/claim';/,
    );
    expect(dart).toContain("static String localComputerCommandComplete(String id)");
    expect(dart).toContain("static const localComputerStop = '/api/mobile/computer-use/stop';");
    expect(dart).toContain("static String pushDeliveryReceipts(String id)");
    expect(dart).toContain("static const pushCanaryTargets = '/api/mobile/push/canary';");
    expect(dart).toContain("static const pushCanaryRun = '/api/mobile/push/canary';");
    expect(dart).toContain("'plugins.list',");
    expect(dart).toContain("static const pluginsList = '/api/plugins';");
    expect(dart).toContain("'integrations.overview',");
    expect(dart).toContain("static String integrationsOverview({String? workspaceId})");
    expect(dart).toContain("'plugins.preview',");
    expect(dart).toContain("static const pluginsPreview = '/api/plugins/preview';");
    expect(dart).toContain("static const pluginsInstall = '/api/plugins/install';");
    expect(dart).toContain("static String pluginsChange(String id)");
    expect(dart).toContain("static String pluginsUninstall(String id)");
    expect(dart).toContain("'artifacts.content',");
    expect(dart).toContain("'artifacts.list',");
    expect(dart).toContain("static String artifactsList({String? kind, int? limit})");
    expect(dart).toContain("static String artifactsContent(String id, {int? version})");
    expect(dart).toContain("static String memoryList({String? threadId, int? limit})");
    expect(dart).not.toContain("'agents.create',");
    expect(dart).not.toContain("'admin.workflows.tick',");
  });

  it("keeps v17 immutable while v18 adds only generated artifact reads", async () => {
    const [v17, v17Manifest, v18] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v17/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v17/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v18/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(sha256(v17)).toBe(
      "4cac8cadf63061626fce1a18d215a8b7fe2069ef8707aec6eaa4ad9d24aa94d8",
    );
    expect(sha256(v17Manifest)).toBe(
      "8101958ab99d8bd73a943a26aa7eac3293478f1ef0604da278f8e20c43d3ec74",
    );
    expect(v17).not.toContain('"artifacts.content"');
    expect(v17).not.toContain('"artifacts.list"');
    expect(v18).toContain('"artifacts.content"');
    expect(v18).toContain('"artifacts.list"');
    expect(v18).toContain('"/api/artifacts"');
    expect(v18).toContain('"/api/artifacts/{id}/content"');
    expect(v18).toContain('"name": "version"');
    expect(v18).toContain('"format": "binary"');
  });

  it("keeps v16 immutable while v17 adds the native Automation control plane", async () => {
    const [v16, v16Manifest, v17] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v16/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v16/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v17/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(sha256(v16)).toBe(
      "a2076a807873ef4d15f6867084c2fff34ec0af79e405b87a1dbbe0da61a48bfe",
    );
    expect(sha256(v16Manifest)).toBe(
      "f07374ccf6409d3e8da0bdd047e710d8f0e431eaca0560cd0768ca09c219031d",
    );
    expect(v16).not.toContain('"integrations.overview"');
    expect(v16).not.toContain('"plugins.preview"');
    expect(v17).toContain('"integrations.overview"');
    expect(v17).toContain('"plugins.preview"');
    expect(v17).toContain('"plugins.install"');
    expect(v17).toContain('"plugins.change"');
    expect(v17).toContain('"plugins.uninstall"');
    expect(v17).toContain('"name": "Idempotency-Key"');
    expect(v17).toContain('"required": true');
    expect(v17).toContain('"expectedRevision"');
    expect(v17).toContain('"manifestSha256"');
  });

  it("keeps v15 immutable while v16 adds only the Plugin inventory read", async () => {
    const [v15, v15Manifest, v16] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v15/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v15/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v16/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(sha256(v15)).toBe(
      "0e3aa9c804220eee471ecebc86857d4e521f06586ac983a07bb347edde458bd3",
    );
    expect(sha256(v15Manifest)).toBe(
      "96271696b5df123078fc716c59420c9ae46ae342046ac07fd61bbf4005a12144",
    );
    expect(v15).not.toContain('"plugins.list"');
    expect(v16).toContain('"plugins.list"');
    expect(v16).toContain('"/api/plugins"');
  });

  it("keeps v14 immutable while v15 adds receipt and canary routes", async () => {
    const [v12, v13, v14, v14Manifest, v15] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v12/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v13/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v14/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v14/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v15/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(v12).not.toContain('"open_url"');
    expect(v13).toContain('"open_url"');
    expect(v13).toContain('"evidence.run.computerFrame"');
    expect(v14).toContain('"open_url"');
    expect(v14).not.toContain('"evidence.run.computerFrame"');
    expect(v14).not.toContain('/api/runs/{id}/activity/frames/{frameId}');
    expect(sha256(v14)).toBe(
      "0767c49d8753fcf03313340e9c9786aad02577a2fe15970ba3eda052e6354950",
    );
    expect(sha256(v14Manifest)).toBe(
      "de4f96ea9fd8629b22ab4f794e89fd6b2a05ef08d0d7ec28203df8f7d5f45410",
    );
    expect(v13).not.toContain('/api/mobile/push/deliveries/{id}/receipts');
    expect(v14).not.toContain('/api/mobile/push/deliveries/{id}/receipts');
    expect(v14).not.toContain('/api/mobile/push/canary');
    expect(v15).toContain('/api/mobile/push/deliveries/{id}/receipts');
    expect(v15).toContain('/api/mobile/push/canary');
  });

  it("accepts current and previous device envelopes but rejects partial attestation", () => {
    const request = {
      email: "operator@example.test",
      password: "fixture-password",
      device: {
        id: "asael-fixture-device",
        name: "Asael on macOS",
        platform: "macos",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: 17,
      },
    };
    expect(nativeLoginRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, clientContractVersion: 16 },
    }).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, buildNumber: undefined },
    }).success).toBe(false);
  });

  it("accepts the 240-character push identifiers allowed by the durable store", () => {
    const timestamp = "2026-09-18T12:00:00.000Z";
    expect(nativePushReceiptResponseSchema.safeParse({
      schemaVersion: 1,
      recorded: true,
      newlyRecorded: true,
      receipt: {
        id: "receipt-one",
        kind: "received",
        action: null,
        observedAt: timestamp,
        recordedAt: timestamp,
        appLifecycle: "background",
        platform: "macos",
      },
      delivery: {
        id: "delivery-one",
        notificationId: "n".repeat(240),
        causeKind: "customer",
        causeId: "c".repeat(240),
        deepLink: "/customers/customer-one",
        providerState: "accepted",
        providerAcceptedAt: timestamp,
        appState: "received",
        receivedAt: timestamp,
        openedAt: null,
        lastAction: null,
        failureCode: null,
      },
    }).success).toBe(true);
  });

  it("keeps the frozen v11 local command envelope free of v12 preview bindings", () => {
    const claimed = {
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        id: `local_computer_command_${"b".repeat(48)}`,
        runId: "4f778556-e171-4af0-ae9c-c5a269276236",
        executionId: `idem_${"a".repeat(64)}`,
        action: "observe",
        input: { includeScreenshot: true },
        presentScreenshot: true,
        claimToken: "claim-token-that-is-long-enough-123456",
        claimGeneration: 1,
        expiresAt: "2026-09-17T08:00:30.000Z",
      },
      pollAfterMs: 0,
    };

    expect(nativeLocalComputerClaimResponseForClient(claimed, 12)).toEqual(
      claimed,
    );
    expect(nativeLocalComputerClaimResponseForClient(claimed, 11)).toEqual({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        id: `local_computer_command_${"b".repeat(48)}`,
        action: "observe",
        input: { includeScreenshot: true },
        claimToken: "claim-token-that-is-long-enough-123456",
        claimGeneration: 1,
        expiresAt: "2026-09-17T08:00:30.000Z",
      },
      pollAfterMs: 0,
    });
  });

  it("publishes a discriminated event contract for every streamed event family", () => {
    expect(nativeConversationEventSchema.parse({
      type: "waiting_approval",
      executionId: "execution-one",
      toolId: "calendar.event.create",
      message: "Approval is required.",
    }).type).toBe("waiting_approval");
    expect(nativeConversationEventSchema.safeParse({
      type: "invented_event",
      content: "untrusted",
    }).success).toBe(false);
  });

  it("requires bootstrap to advertise the authoritative contract rollout", () => {
    const timestamp = "2026-09-08T08:00:00.000Z";
    const identity = {
      context: {
        tenantId: "tenant-one",
        actorId: "operator@example.test",
        role: "operator",
        source: "mobile",
        auth: {
          userId: "user-one",
          email: "operator@example.test",
          sessionId: "session-one",
          tenantName: "Example",
        },
      },
      user: { id: "user-one", email: "operator@example.test", status: "active", createdAt: timestamp, updatedAt: timestamp },
      tenant: { id: "tenant-one", name: "Example", slug: "example", createdAt: timestamp, updatedAt: timestamp },
      membership: { id: "membership-one", tenantId: "tenant-one", userId: "user-one", role: "operator", status: "active", createdAt: timestamp, updatedAt: timestamp },
      device: { id: "device-one", name: "Asael on macOS", platform: "macos", appVersion: "1.0.0", buildNumber: 2, clientContractVersion: 18 },
    };
    expect(nativeBootstrapResponseSchema.parse({
      authenticated: true,
      ...identity,
      permissions: ["read"],
      api: {
        version: 1,
        basePath: "/api",
        mobileBasePath: "/api/mobile",
        nativeContract: {
          id: "asael.native-api",
          currentVersion: 18,
          previousVersion: 17,
          supportedVersions: [18, 17],
          discoveryPath: "/api/mobile/contracts",
        },
      },
      client: {
        schemaVersion: 1,
        platform: "macos",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: 18,
        minimumVersion: "1.0.0",
        requiredContractVersion: 18,
        supportedContractVersions: [18, 17],
        status: "compatible",
        agentCatalogEnrollment: { state: "held", clientReady: true },
      },
      nativeClientPolicy: { schemaVersion: 1 },
    }).api.nativeContract.currentVersion).toBe(18);
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
