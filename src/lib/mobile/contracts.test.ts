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
} from "@/lib/mobile/contracts";

describe("native API contracts", () => {
  it("retains exactly the current and previous rollout versions", () => {
    expect(NATIVE_API_CURRENT_VERSION).toBe(13);
    expect(NATIVE_API_PREVIOUS_VERSION).toBe(12);
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
    expect(nativeContractSchemas.NativeContractDiscovery.parse(
      nativeContractDiscovery(),
    ).supportedVersions).toEqual([13, 12]);
  });

  it("exposes only explicit local Computer Use in the v13 request schema", () => {
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

  it("generates a Dart capability set and local courier paths from v13", async () => {
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
    expect(dart).toContain("'evidence.run.computerFrame',");
    expect(dart).toContain("'localComputer.device',");
    expect(dart).toContain("'localComputer.command.claim',");
    expect(dart).toContain("'localComputer.command.complete',");
    expect(dart).toContain("'localComputer.stop',");
    expect(dart).toContain("static String evidenceRunComputerFrame(String id, String frameId)");
    expect(dart).toContain("static const localComputerDevice = '/api/mobile/computer-use/device';");
    expect(dart).toMatch(
      /static const localComputerCommandClaim\s*=\s*'\/api\/mobile\/computer-use\/commands\/claim';/,
    );
    expect(dart).toContain("static String localComputerCommandComplete(String id)");
    expect(dart).toContain("static const localComputerStop = '/api/mobile/computer-use/stop';");
    expect(dart).toContain("static String memoryList({String? threadId, int? limit})");
    expect(dart).not.toContain("'agents.create',");
    expect(dart).not.toContain("'admin.workflows.tick',");
  });

  it("publishes browser navigation only in v13 and leaves v12 immutable", async () => {
    const [v12, v13] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v12/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v13/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(v12).not.toContain('"open_url"');
    expect(v13).toContain('"open_url"');
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
        clientContractVersion: 13,
      },
    };
    expect(nativeLoginRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, clientContractVersion: 12 },
    }).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, buildNumber: undefined },
    }).success).toBe(false);
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
      device: { id: "device-one", name: "Asael on macOS", platform: "macos", appVersion: "1.0.0", buildNumber: 2, clientContractVersion: 12 },
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
          currentVersion: 13,
          previousVersion: 12,
          supportedVersions: [13, 12],
          discoveryPath: "/api/mobile/contracts",
        },
      },
      client: {
        schemaVersion: 1,
        platform: "macos",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: 12,
        minimumVersion: "1.0.0",
        requiredContractVersion: 13,
        supportedContractVersions: [13, 12],
        status: "compatible",
        agentCatalogEnrollment: { state: "held", clientReady: true },
      },
      nativeClientPolicy: { schemaVersion: 1 },
    }).api.nativeContract.currentVersion).toBe(13);
  });
});
