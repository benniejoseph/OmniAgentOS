import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
  it("retains exactly the current and previous rollout versions", () => {
    // Tripwire: a native contract bump must be a deliberate, reviewed change.
    // The other tests follow these constants.
    expect(NATIVE_API_CURRENT_VERSION).toBe(29);
    expect(NATIVE_API_PREVIOUS_VERSION).toBe(28);
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

  it("keeps v19 immutable while v20 adds only exact Agent selection to Conversation", async () => {
    const [v19, v19Manifest, v20] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v19/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v19/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v20/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(sha256(v19)).toBe(
      "7c6e8283a7ad06f2b4525ababa350de23d1f7a57ce293f7917058fd2e0bbcdaf",
    );
    expect(sha256(v19Manifest)).toBe(
      "d69b15a524ede1e83af3fac712ed4d938f37053e50dacb3f77863e3a5c857c57",
    );
    const v19Conversation = JSON.parse(v19).components.schemas.NativeConversationRequest;
    const v20Conversation = JSON.parse(v20).components.schemas.NativeConversationRequest;
    expect(v19Conversation.properties).not.toHaveProperty("agentId");
    expect(v20Conversation.properties.agentId).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 120,
      pattern: "^[a-zA-Z0-9_.:-]+$",
    });
    expect(nativeOperationsForVersion(20)).toEqual(nativeOperationsForVersion(19));
  });

  it("keeps v20 immutable while v21 adds only the Council read projection", async () => {
    const v20 = await readFile(
      new URL("../../../public/native-contracts/v20/openapi.json", import.meta.url),
      "utf8",
    );
    expect(sha256(v20)).toBe(
      "3c265c3ed4635176506e425019d20182bcb767fd424a376c5f3dd78e6e9d80d4",
    );
    const v20Ids = new Set(
      nativeOperationsForVersion(20)?.map((operation) => operation.id),
    );
    expect(
      nativeOperationsForVersion(21)
        ?.map((operation) => operation.id)
        .filter((id) => !v20Ids.has(id)),
    ).toEqual(["agents.council"]);
    expect(
      nativeOperationsForVersion(21)?.find(
        (operation) => operation.id === "agents.council",
      ),
    ).toMatchObject({
      method: "GET",
      path: "/api/agents/council",
      auth: "bearer",
    });
  });

  it("keeps v21 immutable while v22 adds only exact child cancellation", async () => {
    const [v21, v21Manifest] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v21/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v21/manifest.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v21)).toBe(
      "fbdd07358133c4488e92ee84f97afe6cc48422830c2897071a37aafacad9d326",
    );
    expect(sha256(v21Manifest)).toBe(
      "9515ef2ea73412b97c94e5dcb2f61d7078d6171210fd59114f63d9857503fde3",
    );
    const v21Ids = new Set(
      nativeOperationsForVersion(21)?.map((operation) => operation.id),
    );
    expect(
      nativeOperationsForVersion(22)
        ?.map((operation) => operation.id)
        .filter((id) => !v21Ids.has(id)),
    ).toEqual(["agents.tasks.cancel"]);
    expect(
      nativeOperationsForVersion(22)?.find(
        (operation) => operation.id === "agents.tasks.cancel",
      ),
    ).toMatchObject({
      method: "POST",
      path: "/api/agents/tasks/{id}/cancel",
      auth: "bearer",
      requestSchema: "NativeAgentTaskCancelRequest",
      responseSchema: "NativeAgentTaskCancelResponse",
      headerParameters: [expect.objectContaining({ name: "Idempotency-Key", required: true })],
    });
  });

  it("keeps v22 immutable while v23 adds only the generic notification push cause", async () => {
    const [v22, v22Manifest, v23] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v22/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v22/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v23/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v22)).toBe(
      "90fb2947e304d12831e2fa5828341b3b0d7e436bc97c2b207840b78156896b98",
    );
    expect(sha256(v22Manifest)).toBe(
      "00a6f09a21764f4c1b1aba5b5a9a0ead4991dae2e936c8ff197f7f0b482486df",
    );
    const v22Cause = JSON.parse(v22).components.schemas.NativePushAcknowledgementResponse
      .properties.causeKind.enum;
    const v23Cause = JSON.parse(v23).components.schemas.NativePushAcknowledgementResponse
      .properties.causeKind.enum;
    expect(v22Cause).not.toContain("notification");
    expect(v23Cause).toEqual([
      ...v22Cause.slice(0, -1),
      "notification",
      "canary",
    ]);
    expect(nativeOperationsForVersion(23)).toEqual(nativeOperationsForVersion(22));
  });

  it("keeps v23 immutable while v24 adds only the persistent prompt queue", async () => {
    const [v23, v23Manifest] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v23/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v23/manifest.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v23)).toBe(
      "3db4579277e5e75595be53ad0d6441ddb01437cfa301bfd4f2b522ad836f2820",
    );
    expect(sha256(v23Manifest)).toBe(
      "21094d6c045c7886583f81f472ae1e6d75f6b541856555cd9c52fac6cfd60a7a",
    );
    const v23Ids = new Set(
      nativeOperationsForVersion(23)?.map((operation) => operation.id),
    );
    expect(
      nativeOperationsForVersion(24)
        ?.map((operation) => operation.id)
        .filter((id) => !v23Ids.has(id)),
    ).toEqual([
      "promptQueue.list",
      "promptQueue.create",
      "promptQueue.update",
      "promptQueue.delete",
      "promptQueue.reorder",
      "promptQueue.dispatch",
    ]);
  });

  it("keeps v24 immutable while v25 adds only actor-private management parity", async () => {
    const [v24, v24Manifest] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v24/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v24/manifest.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v24)).toBe(
      "2015e184515f20a176348a59cfa13bc257168889b26c7b2eaa94dd1c79ef5f19",
    );
    expect(sha256(v24Manifest)).toBe(
      "42349d425d652f263fb3e1282c129f179fa9e36f45c1a20d84057c5e54ae978c",
    );
    const v24Ids = new Set(
      nativeOperationsForVersion(24)?.map((operation) => operation.id),
    );
    expect(
      nativeOperationsForVersion(25)
        ?.map((operation) => operation.id)
        .filter((id) => !v24Ids.has(id)),
    ).toEqual([
      "agents.release.show",
      "agents.release.manage",
      "agents.adaptations.list",
      "agents.adaptations.manage",
      "agents.tasks.show",
      "automation.schedule.show",
      "notifications.dispositions.list",
    ]);
    expect(nativeOperationsForVersion(25)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agents.release.retire" }),
        expect.objectContaining({ id: "agents.grants.revoke" }),
      ]),
    );
  });

  it("keeps the retired v20 bridge and v21-v24 archived outside the advertised window", async () => {
    const discovery = nativeContractDiscovery();
    expect(discovery.supportedVersions).toEqual([
      NATIVE_API_CURRENT_VERSION,
      NATIVE_API_PREVIOUS_VERSION,
    ]);
    expect(discovery.versions).toEqual([
      expect.objectContaining({
        version: NATIVE_API_CURRENT_VERSION,
        state: "current",
      }),
      expect.objectContaining({
        version: NATIVE_API_PREVIOUS_VERSION,
        state: "previous",
      }),
    ]);
    for (const archived of [20, 21, 22, 23, 24]) {
      expect(discovery.supportedVersions).not.toContain(archived);
      expect(nativeOperationsForVersion(archived)).toBeDefined();
    }
    expect(nativeOperationsForVersion(20)).toEqual(
      nativeOperationsForVersion(19),
    );
    const [v20, v20Manifest] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v20/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v20/manifest.json", import.meta.url),
        "utf8",
      ),
    ]);
    expect(sha256(v20)).toBe(
      "3c265c3ed4635176506e425019d20182bcb767fd424a376c5f3dd78e6e9d80d4",
    );
    expect(sha256(v20Manifest)).toBe(
      "74bf7033f61bd45ae9b6074659c7b8f1b5ae97ac728e889a65534c3537db1a27",
    );
    expect(nativeOperationsForVersion(24)).toBeDefined();
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

  it("keeps v18 immutable while v19 enrolls only Agent and Moltbook management", async () => {
    const [v18, v18Manifest, v19] = await Promise.all([
      readFile(
        new URL("../../../public/native-contracts/v18/openapi.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v18/manifest.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../public/native-contracts/v19/openapi.json", import.meta.url),
        "utf8",
      ),
    ]);

    expect(sha256(v18)).toBe(
      "ece0a7d0eaa566a7ec9a111feb3bf1cdfab55a467e77f34eeffc20692a0da48d",
    );
    expect(sha256(v18Manifest)).toBe(
      "3ad8ac174c0acaa53f9581782e0762f20ad111f0e13a45348b6af75440d3615e",
    );
    expect(v18).not.toContain('"agents.create"');
    expect(v18).not.toContain('"moltbook.connection.show"');
    expect(v19).toContain('"agents.create"');
    expect(v19).toContain('"agents.update"');
    expect(v19).not.toContain('"agents.delete"');
    expect(v19).not.toContain('"skills.create"');
    expect(v19).not.toContain('"skills.update"');
    expect(v19).not.toContain('"skills.delete"');
    expect(v19).toContain('"moltbook.connection.show"');
    expect(v19).toContain('"moltbook.connection.manage"');
    expect(v19).toContain('"/api/agents/{id}/moltbook"');
    const v18Ids = new Set(
      nativeOperationsForVersion(18)?.map((operation) => operation.id),
    );
    expect(
      nativeOperationsForVersion(19)
        ?.map((operation) => operation.id)
        .filter((id) => !v18Ids.has(id)),
    ).toEqual([
      "agents.create",
      "agents.update",
      "moltbook.connection.show",
      "moltbook.connection.manage",
    ]);
  });

  it("keeps v17 immutable while v18 adds only generated artifact reads", async () => {
    const [v17, v17Manifest, v18] = await Promise.all([
      readFile(new URL("../../../public/native-contracts/v17/openapi.json", import.meta.url), "utf8"),
      readFile(new URL("../../../public/native-contracts/v17/manifest.json", import.meta.url), "utf8"),
      readFile(new URL("../../../public/native-contracts/v18/openapi.json", import.meta.url), "utf8"),
    ]);
    expect(sha256(v17)).toBe("4cac8cadf63061626fce1a18d215a8b7fe2069ef8707aec6eaa4ad9d24aa94d8");
    expect(sha256(v17Manifest)).toBe("8101958ab99d8bd73a943a26aa7eac3293478f1ef0604da278f8e20c43d3ec74");
    expect(v17).not.toContain('"artifacts.content"');
    expect(v18).toContain('"artifacts.content"');
    expect(v18).toContain('"artifacts.list"');
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
