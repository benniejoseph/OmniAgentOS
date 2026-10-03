import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
  NATIVE_API_SUPPORTED_VERSIONS,
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
  it("exposes owner-bound presentation preferences only in v31 with strict revision-bound input", () => {
    expect(nativeOperationsForVersion(30)?.some((item) => item.id.startsWith("companion."))).toBe(false);
    const operations = nativeOperationsForVersion(31)?.filter((item) => item.id.startsWith("companion."));
    expect(operations?.map((item) => item.id)).toEqual(["companion.preferences.get", "companion.preferences.update"]);
    for (const operation of operations ?? []) {
      expect(operation.path).toBe("/api/companion/preferences");
      expect(operation.headerParameters).toContainEqual(expect.objectContaining({ name: "x-asael-companion-owner-sha256", required: true, pattern: "^[a-f0-9]{64}$" }));
    }
    expect(operations?.[1].headerParameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", required: true }));
    const schema = nativeContractSchemas.NativeCompanionPreferencesRequest;
    expect(schema.safeParse({ action: "reset", expectedRevision: 3 }).success).toBe(true);
    expect(schema.safeParse({ action: "reset" }).success).toBe(false);
    expect(schema.safeParse({ action: "reset", expectedRevision: 3, actorId: "other" }).success).toBe(false);
    expect(schema.safeParse({ action: "save", expectedRevision: 0, preferences: { intensity: "quiet", visible: true, motion: "reduced", defaultDestination: "activity", preferredThreadId: null } }).success).toBe(true);
    expect(schema.safeParse({ action: "save", expectedRevision: 0, preferences: { intensity: "quiet" } }).success).toBe(false);
  });
  it("retains exactly the current and previous rollout versions", () => {
    // Tripwire: a native contract bump must be a deliberate, reviewed change.
    // The other tests follow these constants.
    expect(NATIVE_API_CURRENT_VERSION).toBe(31);
    expect(NATIVE_API_PREVIOUS_VERSION).toBe(30);
    expect(NATIVE_API_SUPPORTED_VERSIONS).toEqual([
      NATIVE_API_CURRENT_VERSION,
      NATIVE_API_PREVIOUS_VERSION,
    ]);
    expect(NATIVE_API_PREVIOUS_VERSION).toBeLessThan(NATIVE_API_CURRENT_VERSION);
    expect(nativeOperationsForVersion(NATIVE_API_CURRENT_VERSION)).toBeDefined();
    expect(nativeOperationsForVersion(NATIVE_API_PREVIOUS_VERSION)).toBeDefined();
    expect(nativeOperationsForVersion(NATIVE_API_CURRENT_VERSION + 1))
      .toBeUndefined();
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
    expect(nativeOperationsForVersion(19)?.length).toBe(
      (nativeOperationsForVersion(18)?.length || 0) + 4,
    );
    expect(nativeOperationsForVersion(20)?.length).toBe(
      nativeOperationsForVersion(19)?.length,
    );
    expect(nativeOperationsForVersion(21)?.length).toBe(
      (nativeOperationsForVersion(20)?.length || 0) + 1,
    );
    expect(nativeOperationsForVersion(22)?.length).toBe(
      (nativeOperationsForVersion(21)?.length || 0) + 1,
    );
    expect(nativeOperationsForVersion(23)?.length).toBe(
      nativeOperationsForVersion(22)?.length,
    );
    expect(nativeOperationsForVersion(24)?.length).toBe(
      (nativeOperationsForVersion(23)?.length || 0) + 6,
    );
    expect(nativeOperationsForVersion(25)?.length).toBe(
      (nativeOperationsForVersion(24)?.length || 0) + 7,
    );
    expect(nativeOperationsForVersion(30)?.length).toBe(
      nativeOperationsForVersion(29)?.length,
    );
    const discovery = nativeContractDiscovery();
    expect(nativeContractSchemas.NativeContractDiscovery.parse(
      discovery,
    ).supportedVersions).toEqual([
      NATIVE_API_CURRENT_VERSION,
      NATIVE_API_PREVIOUS_VERSION,
    ]);
    for (const supportedVersions of [
      [NATIVE_API_CURRENT_VERSION + 1, NATIVE_API_CURRENT_VERSION],
      [NATIVE_API_CURRENT_VERSION, NATIVE_API_PREVIOUS_VERSION - 1],
      [
        NATIVE_API_CURRENT_VERSION,
        NATIVE_API_PREVIOUS_VERSION,
        NATIVE_API_PREVIOUS_VERSION - 1,
      ],
    ]) {
      expect(nativeContractSchemas.NativeContractDiscovery.safeParse({
        ...discovery,
        supportedVersions,
      }).success).toBe(false);
    }
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

  it("admits reviewed voice input only when it is bound to the command conversation", () => {
    const conversationId = "0b8e2f9a-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const voiceInput = {
      schemaVersion: 1,
      source: "realtime_voice",
      sessionId: "5f0c9a1e-2b3d-4c4e-9f5a-6b7c8d9e0f10",
      conversationId,
      provider: "openai",
      confidenceBand: "high",
      confidenceMean: 0.94,
      confidenceMinimum: 0.81,
      confidenceSampleCount: 12,
      reviewMethod: "send_button",
      reviewAttested: true,
    };
    const request = {
      message: "Move the review to Friday.",
      requestId: "native-voice-a",
      threadId: conversationId,
      voiceInput,
    };
    expect(nativeConversationRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      threadId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
    }).success).toBe(false);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      threadId: undefined,
    }).success).toBe(false);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      voiceInput: { ...voiceInput, reviewAttested: false },
    }).success).toBe(false);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      voiceInput: { ...voiceInput, transcript: "Move the review to Friday." },
    }).success).toBe(false);
  });

  it("admits only a bounded exact Agent identity in the native conversation envelope", () => {
    const request = {
      message: "Read the Moltbook home feed.",
      requestId: "native-agent-target-a",
      strategy: "direct",
      agentId: "agent-moltbook.steward:1",
    };
    expect(nativeConversationRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeConversationRequestSchema.safeParse({
      ...request,
      agentId: "../another-owner",
    }).success).toBe(false);
  });

  it("records exactly which operations each contract version added or removed", () => {
    const ids = (version: number) =>
      nativeOperationsForVersion(version)?.map((operation) => operation.id) || [];
    const changes = (version: number) => {
      const before = new Set(ids(version - 1));
      const after = new Set(ids(version));
      return {
        added: [...after].filter((id) => !before.has(id)),
        removed: [...before].filter((id) => !after.has(id)),
      };
    };
    const added = (...operations: string[]) => ({ added: operations, removed: [] });

    // Older published documents are deleted, so the registry is the record of
    // what each version changed. A new version adds its line here.
    expect(Object.fromEntries(
      Array.from({ length: NATIVE_API_CURRENT_VERSION - 8 }, (_, index) => [
        index + 9,
        changes(index + 9),
      ]),
    )).toEqual({
      9: added("threads.list", "threads.get", "capture.asset.get"),
      10: added("evidence.run.computerFrame"),
      11: added(
        "localComputer.device",
        "localComputer.device.update",
        "localComputer.command.claim",
        "localComputer.command.complete",
        "localComputer.stop",
      ),
      12: added(),
      13: added(),
      14: { added: [], removed: ["evidence.run.computerFrame"] },
      15: added("push.delivery.receipts", "push.canary.targets", "push.canary.run"),
      16: added("plugins.list"),
      17: added(
        "integrations.overview",
        "plugins.preview",
        "plugins.install",
        "plugins.change",
        "plugins.uninstall",
      ),
      18: added("artifacts.list", "artifacts.content"),
      19: added(
        "agents.create",
        "agents.update",
        "moltbook.connection.show",
        "moltbook.connection.manage",
      ),
      20: added(),
      21: added("agents.council"),
      22: added("agents.tasks.cancel"),
      23: added(),
      24: added(
        "promptQueue.list",
        "promptQueue.create",
        "promptQueue.update",
        "promptQueue.delete",
        "promptQueue.reorder",
        "promptQueue.dispatch",
      ),
      25: added(
        "agents.release.show",
        "agents.release.manage",
        "agents.adaptations.list",
        "agents.adaptations.manage",
        "agents.tasks.show",
        "automation.schedule.show",
        "notifications.dispositions.list",
      ),
      26: added("agents.learning.show"),
      27: added(),
      28: added("settings.models.commandCatalog"),
      29: added(
        "voice.realtime.session.start",
        "voice.realtime.session.finish",
        "voice.speech.stream",
      ),
      30: added(),
      31: added("companion.preferences.get", "companion.preferences.update"),
    });
    // v20 and v23 changed only request and push schemas.
    expect(nativeOperationsForVersion(20)).toEqual(nativeOperationsForVersion(19));
    expect(nativeOperationsForVersion(23)).toEqual(nativeOperationsForVersion(22));
    const operation = (version: number, id: string) =>
      nativeOperationsForVersion(version)?.find((item) => item.id === id);
    expect(operation(21, "agents.council")).toMatchObject({
      method: "GET",
      path: "/api/agents/council",
      auth: "bearer",
    });
    expect(operation(22, "agents.tasks.cancel")).toMatchObject({
      method: "POST",
      path: "/api/agents/tasks/{id}/cancel",
      auth: "bearer",
      requestSchema: "NativeAgentTaskCancelRequest",
      responseSchema: "NativeAgentTaskCancelResponse",
      headerParameters: [expect.objectContaining({ name: "Idempotency-Key", required: true })],
    });
    // A native client can release an Agent, but not retire it or revoke its grants.
    for (const version of [25, NATIVE_API_CURRENT_VERSION]) {
      expect(ids(version)).not.toContain("agents.release.retire");
      expect(ids(version)).not.toContain("agents.grants.revoke");
    }
  });

  it("publishes the current and previous contracts plus one unadvertised archive", async () => {
    const published = (await readdir(
      new URL("../../../public/native-contracts/", import.meta.url),
    )).filter((name) => !name.startsWith(".")).sort();

    // Shipping a new contract deletes the oldest of these directories.
    expect(published).toEqual([
      `v${NATIVE_API_PREVIOUS_VERSION - 1}`,
      `v${NATIVE_API_PREVIOUS_VERSION}`,
      `v${NATIVE_API_CURRENT_VERSION}`,
    ].sort());
    const discovery = nativeContractDiscovery();
    expect(discovery.versions).toEqual([
      expect.objectContaining({ version: NATIVE_API_CURRENT_VERSION, state: "current" }),
      expect.objectContaining({ version: NATIVE_API_PREVIOUS_VERSION, state: "previous" }),
    ]);
    expect(discovery.supportedVersions).not.toContain(NATIVE_API_PREVIOUS_VERSION - 1);
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
    expect(dart).toContain("'agents.create',");
    expect(dart).toContain("'agents.update',");
    expect(dart).not.toContain("'agents.delete',");
    expect(dart).toContain("'moltbook.connection.show',");
    expect(dart).toContain("'moltbook.connection.manage',");
    expect(dart).toContain("static String moltbookConnectionShow(String id");
    expect(dart).toContain("static String moltbookConnectionManage(String id");
    expect(dart).not.toContain("'admin.workflows.tick',");
    expect(dart).toContain("'agents.tasks.cancel',");
    expect(dart).toContain("static String agentsTasksCancel(String id)");
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

  it("keeps v29 immutable while v30 adds only the task-authority command marker", async () => {
    const [v29, v29Manifest, v30] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v29/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v29/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v30/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v29)).toBe(
      "4c05b72fb2533b5d001600ee843252b65012fef9ec62d38fc586a4d84ed1cf3a",
    );
    expect(sha256(v29Manifest)).toBe(
      "f18dd634d6e319dae4de4b07e7bd7c161356817a9fc78b36357e64550bcc258d",
    );
    expect(nativeOperationsForVersion(30)).toEqual(nativeOperationsForVersion(29));
    const claimedCommand = (document: string) =>
      JSON.parse(document).components.schemas.NativeLocalComputerClaimResponse
        .properties.command.anyOf[0];
    const previous = claimedCommand(v29);
    const current = claimedCommand(v30);
    expect(previous.properties).not.toHaveProperty("authority");
    expect(current.properties.authority).toEqual({ type: "string", const: "task" });
    expect(current.required).toEqual(previous.required);
    const { authority: _authority, ...unchanged } = current.properties;
    expect(unchanged).toEqual(previous.properties);
  });

  it("sends the task-authority marker only to a v30 client on a checked action", () => {
    const claimed = {
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        id: `local_computer_command_${"c".repeat(48)}`,
        runId: "4f778556-e171-4af0-ae9c-c5a269276236",
        executionId: `idem_${"a".repeat(64)}`,
        action: "press",
        input: { elementId: "e:aaaaaaaaaaaa:3" },
        presentScreenshot: false,
        claimToken: "claim-token-that-is-long-enough-123456",
        claimGeneration: 1,
        expiresAt: "2026-09-17T08:00:30.000Z",
        authority: "task",
      },
      pollAfterMs: 0,
    };

    expect(nativeLocalComputerClaimResponseForClient(claimed, 30)).toEqual(
      claimed,
    );
    // Removing the marker would send the action without its target check.
    for (const olderClient of [29, 12, 11]) {
      expect(() => nativeLocalComputerClaimResponseForClient(claimed, olderClient))
        .toThrow("requires a newer native client");
    }
    const { authority: _authority, ...reviewed } = claimed.command;
    expect(nativeLocalComputerClaimResponseForClient(
      { ...claimed, command: reviewed },
      29,
    )).toEqual({ ...claimed, command: reviewed });

    for (const command of [
      { ...claimed.command, action: "observe", input: { includeScreenshot: true } },
      { ...claimed.command, action: "scroll", input: { direction: "down" } },
      { ...claimed.command, action: "activate_app", input: { name: "Safari" } },
      { ...claimed.command, authority: "approved" },
      { ...claimed.command, authority: true },
    ]) {
      expect(nativeContractSchemas.NativeLocalComputerClaimResponse.safeParse({
        ...claimed,
        command,
      }).success).toBe(false);
    }
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
      device: { id: "device-one", name: "Asael on macOS", platform: "macos", appVersion: "1.0.0", buildNumber: 2, clientContractVersion: NATIVE_API_CURRENT_VERSION },
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
          currentVersion: NATIVE_API_CURRENT_VERSION,
          previousVersion: NATIVE_API_PREVIOUS_VERSION,
          supportedVersions: [
            NATIVE_API_CURRENT_VERSION,
            NATIVE_API_PREVIOUS_VERSION,
          ],
          discoveryPath: "/api/mobile/contracts",
        },
      },
      client: {
        schemaVersion: 1,
        platform: "macos",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: NATIVE_API_CURRENT_VERSION,
        minimumVersion: "1.0.0",
        requiredContractVersion: NATIVE_API_CURRENT_VERSION,
        supportedContractVersions: [
          NATIVE_API_CURRENT_VERSION,
          NATIVE_API_PREVIOUS_VERSION,
        ],
        status: "compatible",
        agentCatalogEnrollment: { state: "held", clientReady: true },
      },
      nativeClientPolicy: { schemaVersion: 1 },
    }).api.nativeContract.currentVersion).toBe(NATIVE_API_CURRENT_VERSION);
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
