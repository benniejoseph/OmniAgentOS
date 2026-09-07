import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { mcpContractReviewSummary, openApiContractReviewSummary } from "@/lib/connectors/contract-review";
import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import { importOpenApiSpec, loadOpenApiSpec } from "@/lib/connectors/openapi-importer";
import {
  createOpenApiConnectorRecord,
  getOpenApiConnector,
  listOpenApiConnectors,
  listOpenApiOperations,
  promoteOpenApiContracts,
  saveOpenApiConnector,
  saveOpenApiImport,
  updateOpenApiConnector,
} from "@/lib/connectors/openapi-store";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import {
  createMcpConnectorRecord,
  getMcpConnector,
  listMcpConnectors,
  listMcpTools,
  promoteMcpContracts,
  saveMcpConnector,
  saveMcpDiscovery,
  updateMcpConnector,
} from "@/lib/connectors/store";
import { assertPublicHttpUrl } from "@/lib/security/network";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { trashActionPreviewV1Schema } from "@/lib/trash/contracts";
import {
  captureRestorableResource,
  compensationForSnapshot,
  moveRestorableResourceToTrash,
} from "@/lib/trash/resources";
import {
  createTrashPreview,
  getTrashLifecycleResultByPreview,
} from "@/lib/trash/store";

const kindSchema = z.enum(["mcp", "openapi"]);
const envNameSchema = z.string().regex(/^[A-Z0-9_]+$/).max(120);
const riskSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const listSchema = z.object({ kind: kindSchema.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
const targetSchema = z.object({ kind: kindSchema, connectorId: z.string().trim().min(1).max(200) }).strict();
const registerSchema = z.object({
  kind: kindSchema, name: z.string().trim().min(1).max(120),
  endpoint: z.string().url().max(2_048).optional(), specUrl: z.string().url().max(2_048).optional(),
  baseUrl: z.string().url().max(2_048).optional(),
  authType: z.enum(["none", "bearer_env", "api_key_header_env"]).default("none"),
  authTokenEnv: envNameSchema.optional(), authHeaderName: z.string().trim().min(1).max(80).optional(),
  defaultRiskLevel: riskSchema.default(2), approvalRequired: z.boolean().default(true),
}).strict().superRefine((value, refinement) => {
  if (value.kind === "mcp" && !value.endpoint) refinement.addIssue({ code: "custom", path: ["endpoint"], message: "MCP registration requires endpoint." });
  if (value.kind === "openapi" && !value.baseUrl) refinement.addIssue({ code: "custom", path: ["baseUrl"], message: "OpenAPI registration requires baseUrl." });
  if (value.authType !== "none" && !value.authTokenEnv) refinement.addIssue({ code: "custom", path: ["authTokenEnv"], message: "Environment auth requires authTokenEnv." });
  if (value.authType === "api_key_header_env" && !value.authHeaderName) refinement.addIssue({ code: "custom", path: ["authHeaderName"], message: "API-key auth requires authHeaderName." });
  if (value.kind === "mcp" && value.authType === "api_key_header_env") refinement.addIssue({ code: "custom", path: ["authType"], message: "MCP supports none or bearer_env in Agent control." });
});
const updateSchema = z.object({
  kind: kindSchema, connectorId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120).optional(), endpoint: z.string().url().max(2_048).optional(),
  specUrl: z.string().url().max(2_048).nullable().optional(), baseUrl: z.string().url().max(2_048).optional(),
  status: z.enum(["active", "error", "disabled"]).optional(), defaultRiskLevel: riskSchema.optional(), approvalRequired: z.boolean().optional(),
}).strict().refine(({ kind: _kind, connectorId: _connectorId, ...change }) => Object.keys(change).length > 0, { message: "A connector change is required." });
const refreshSchema = targetSchema.extend({ specUrl: z.string().url().max(2_048).optional(), baseUrl: z.string().url().max(2_048).optional() }).strict();
const reviewSchema = targetSchema.extend({ expectedFingerprint: z.string().trim().min(20).max(200) }).strict();
const deleteSchema = targetSchema.extend({ preview: trashActionPreviewV1Schema }).strict();

export async function listConnectorsService(caller: AppServiceCaller, input: z.input<typeof listSchema>) {
  const value = listSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.list"));
  const owner = { tenantId: caller.context.tenantId };
  const [mcpConnectors, mcpTools, openApiConnectors, openApiOperations] = await Promise.all([
    value.kind === "openapi" ? Promise.resolve([]) : listMcpConnectors(value.limit, owner),
    value.kind === "openapi" ? Promise.resolve([]) : listMcpTools(undefined, owner),
    value.kind === "mcp" ? Promise.resolve([]) : listOpenApiConnectors(value.limit, owner),
    value.kind === "mcp" ? Promise.resolve([]) : listOpenApiOperations(undefined, owner),
  ]);
  const connectors = [
    ...mcpConnectors.map((connector) => ({ kind: "mcp" as const, connector: redactConnector(connector), review: mcpContractReviewSummary(mcpTools.filter((tool) => tool.connectorId === connector.id), connector) })),
    ...openApiConnectors.map((connector) => ({ kind: "openapi" as const, connector: redactConnector(connector), review: openApiContractReviewSummary(openApiOperations.filter((operation) => operation.connectorId === connector.id), connector) })),
  ];
  return completeAppServiceCall(authorized, { connectors }, { resourceCount: connectors.length });
}

export async function showConnectorService(caller: AppServiceCaller, input: z.input<typeof targetSchema>) {
  const value = targetSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.show"));
  const owner = { tenantId: caller.context.tenantId };
  if (value.kind === "mcp") {
    const [connector, tools] = await Promise.all([getMcpConnector(value.connectorId, owner), listMcpTools(value.connectorId, owner)]);
    return completeAppServiceCall(authorized, { kind: value.kind, connector: connector ? redactConnector(connector) : null, operations: tools }, { resourceCount: connector ? 1 : 0 });
  }
  const [connector, operations] = await Promise.all([getOpenApiConnector(value.connectorId, owner), listOpenApiOperations(value.connectorId, owner)]);
  return completeAppServiceCall(authorized, { kind: value.kind, connector: connector ? redactConnector(connector) : null, operations }, { resourceCount: connector ? 1 : 0 });
}

export async function registerConnectorService(caller: AppServiceCaller, input: z.input<typeof registerSchema>) {
  const value = registerSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.register"));
  const targetUrl = value.kind === "mcp" ? value.endpoint! : value.baseUrl!;
  await assertPublicHttpUrl(targetUrl, `${value.kind} connector URL`);
  if (value.specUrl) await assertPublicHttpUrl(value.specUrl, "OpenAPI spec URL");
  assertSecretBinding(caller, value.authType === "none" ? undefined : value.authTokenEnv, targetUrl);
  const executionScope = caller.executionScope!;
  const connector = value.kind === "mcp"
    ? await saveMcpConnector(createMcpConnectorRecord({
        tenantId: caller.context.tenantId, name: value.name, endpoint: value.endpoint!,
        authType: value.authType === "bearer_env" ? "bearer_env" : "none", authTokenEnv: value.authTokenEnv,
        defaultRiskLevel: value.defaultRiskLevel, approvalRequired: value.approvalRequired,
      }), { executionScope })
    : await saveOpenApiConnector(createOpenApiConnectorRecord({
        tenantId: caller.context.tenantId, name: value.name, specUrl: value.specUrl, baseUrl: value.baseUrl!,
        authType: value.authType, authTokenEnv: value.authTokenEnv, authHeaderName: value.authHeaderName,
        defaultRiskLevel: value.defaultRiskLevel, approvalRequired: value.approvalRequired,
      }), { executionScope });
  return completeAppServiceCall(authorized, { kind: value.kind, connector: redactConnector(connector) });
}

export async function updateConnectorService(caller: AppServiceCaller, input: z.input<typeof updateSchema>) {
  const value = updateSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.update"));
  const owner = { tenantId: caller.context.tenantId };
  const executionScope = caller.executionScope!;
  if (value.kind === "mcp") {
    const current = await getMcpConnector(value.connectorId, owner);
    if (!current) return completeAppServiceCall(authorized, { kind: value.kind, connector: null }, { resourceCount: 0 });
    if (value.endpoint) await assertPublicHttpUrl(value.endpoint, "MCP endpoint");
    if (value.status === "active") {
      const tools = await listMcpTools(value.connectorId, owner);
      if (!current.lastDiscoveredAt || tools.some((tool) => tool.status === "pending_review")) throw new Error("MCP connector requires discovery and contract review before activation.");
    }
    assertSecretBinding(caller, current.authType === "bearer_env" ? current.authTokenEnv : undefined, value.endpoint || current.endpoint);
    const { kind: _kind, connectorId: _connectorId, specUrl: _specUrl, baseUrl: _baseUrl, ...change } = value;
    const connector = await updateMcpConnector(value.connectorId, change, { executionScope });
    return completeAppServiceCall(authorized, { kind: value.kind, connector: connector ? redactConnector(connector) : null }, { resourceCount: connector ? 1 : 0 });
  }
  const current = await getOpenApiConnector(value.connectorId, owner);
  if (!current) return completeAppServiceCall(authorized, { kind: value.kind, connector: null }, { resourceCount: 0 });
  if (value.specUrl) await assertPublicHttpUrl(value.specUrl, "OpenAPI spec URL");
  if (value.baseUrl) await assertPublicHttpUrl(value.baseUrl, "OpenAPI base URL");
  if (value.status === "active") {
    const operations = await listOpenApiOperations(value.connectorId, owner);
    if (!current.lastImportedAt || operations.some((operation) => operation.status === "pending_review")) throw new Error("OpenAPI connector requires import and contract review before activation.");
  }
  assertSecretBinding(caller, current.authType === "none" ? undefined : current.authTokenEnv, value.baseUrl || current.baseUrl);
  const { kind: _kind, connectorId: _connectorId, endpoint: _endpoint, ...change } = value;
  const connector = await updateOpenApiConnector(value.connectorId, { ...change, specUrl: change.specUrl === null ? "" : change.specUrl }, { executionScope });
  return completeAppServiceCall(authorized, { kind: value.kind, connector: connector ? redactConnector(connector) : null }, { resourceCount: connector ? 1 : 0 });
}

export async function refreshConnectorService(caller: AppServiceCaller, input: z.input<typeof refreshSchema>) {
  const value = refreshSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.refresh"));
  const owner = { tenantId: caller.context.tenantId };
  if (value.kind === "mcp") {
    const connector = await getMcpConnector(value.connectorId, owner);
    if (!connector) return completeAppServiceCall(authorized, { kind: value.kind, connector: null, operations: [] }, { resourceCount: 0 });
    const discovery = await discoverMcpTools(connector, { actorId: caller.context.actorId, actorRole: caller.context.role });
    const saved = await saveMcpDiscovery({ connector, tools: discovery.tools, capabilities: discovery.capabilities, instructions: discovery.instructions, serverVersion: discovery.serverVersion }, { executionScope: caller.executionScope! });
    return completeAppServiceCall(authorized, { kind: value.kind, connector: redactConnector(saved.connector), operations: saved.tools, review: mcpContractReviewSummary(saved.tools, saved.connector) });
  }
  const connector = await getOpenApiConnector(value.connectorId, owner);
  if (!connector) return completeAppServiceCall(authorized, { kind: value.kind, connector: null, operations: [] }, { resourceCount: 0 });
  const specUrl = value.specUrl || connector.specUrl;
  if (!specUrl) throw new Error("OpenAPI refresh requires a saved or supplied spec URL.");
  await assertPublicHttpUrl(specUrl, "OpenAPI spec URL");
  const specText = await loadOpenApiSpec(specUrl);
  const imported = importOpenApiSpec({ connector: { ...connector, specUrl }, specText, baseUrlOverride: value.baseUrl });
  await assertPublicHttpUrl(imported.baseUrl, "OpenAPI base URL");
  assertSecretBinding(caller, connector.authType === "none" ? undefined : connector.authTokenEnv, imported.baseUrl);
  const saved = await saveOpenApiImport({ connector: { ...connector, specUrl }, operations: imported.operations, specHash: imported.specHash, baseUrl: imported.baseUrl, info: imported.info }, { executionScope: caller.executionScope! });
  return completeAppServiceCall(authorized, { kind: value.kind, connector: redactConnector(saved.connector), operations: saved.operations, review: openApiContractReviewSummary(saved.operations, saved.connector) });
}

export async function reviewConnectorService(caller: AppServiceCaller, input: z.input<typeof reviewSchema>) {
  const value = reviewSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.review"));
  const options = { executionScope: caller.executionScope! };
  const result = value.kind === "mcp"
    ? await promoteMcpContracts({ connectorId: value.connectorId, expectedFingerprint: value.expectedFingerprint }, options)
    : await promoteOpenApiContracts({ connectorId: value.connectorId, expectedFingerprint: value.expectedFingerprint }, options);
  return completeAppServiceCall(authorized, { kind: value.kind, result: result || null }, { resourceCount: result ? 1 : 0 });
}

export async function previewConnectorDeleteService(caller: AppServiceCaller, input: z.input<typeof targetSchema>) {
  const value = targetSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.delete.preview"));
  const detail = await showConnectorService(caller, value);
  const target = detail.data.connector ? {
    kind: value.kind,
    connector: detail.data.connector,
    operationIds: detail.data.operations.map((operation: { id: string }) => operation.id).sort(),
  } : null;
  const resourceType = value.kind === "mcp" ? "mcp_connector" as const : "openapi_connector" as const;
  const snapshot = target && caller.executionScope
    ? await captureRestorableResource(resourceType, value.connectorId, caller.executionScope)
    : undefined;
  const preview = target ? createTrashPreview({
    resourceType,
    resourceId: value.connectorId,
    target,
    effectSummary: `Move ${value.kind.toUpperCase()} connector ${String(detail.data.connector?.name || value.connectorId)} and ${target.operationIds.length} contract(s) to trash.`,
  }) : null;
  return completeAppServiceCall(authorized, {
    target,
    targetSha256: canonicalJsonSha256(target),
    preview,
    reversible: Boolean(preview),
    compensation: snapshot ? compensationForSnapshot(snapshot) : null,
  }, { resourceCount: target ? 1 : 0 });
}

export async function deleteConnectorService(caller: AppServiceCaller, input: z.input<typeof deleteSchema>) {
  const value = deleteSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.connectors.delete"));
  const prior = await getTrashLifecycleResultByPreview(
    value.preview.previewSha256,
    { executionScope: caller.executionScope! },
  );
  if (prior) {
    return completeAppServiceCall(authorized, {
      movedToTrash: true,
      trash: prior.item,
      effectReceipt: prior.receipt,
      target: null,
      targetSha256: prior.item.targetSha256,
    });
  }
  const owner = { tenantId: caller.context.tenantId };
  const detail = value.kind === "mcp"
    ? await Promise.all([
        getMcpConnector(value.connectorId, owner),
        listMcpTools(value.connectorId, owner),
      ])
    : await Promise.all([
        getOpenApiConnector(value.connectorId, owner),
        listOpenApiOperations(value.connectorId, owner),
      ]);
  const connector = detail[0];
  if (!connector) throw new Error("Connector not found.");
  const target = {
    kind: value.kind,
    connector: redactConnector(connector),
    operationIds: detail[1].map((operation) => operation.id).sort(),
  };
  const resourceType = value.kind === "mcp" ? "mcp_connector" as const : "openapi_connector" as const;
  const snapshot = await captureRestorableResource(
    resourceType,
    value.connectorId,
    caller.executionScope!,
  );
  if (!snapshot) throw new Error("Connector changed after preview.");
  const moved = await moveRestorableResourceToTrash({
    preview: value.preview,
    displayLabel: connector.name,
    target,
    snapshot,
    executionScope: caller.executionScope!,
  });
  return completeAppServiceCall(authorized, {
    movedToTrash: true,
    trash: moved.item,
    effectReceipt: moved.receipt,
    target,
    targetSha256: canonicalJsonSha256(target),
  });
}

function assertSecretBinding(caller: AppServiceCaller, envName: string | undefined, targetUrl: string) {
  const binding = evaluateConnectorSecretBinding({ envName, tenantId: caller.context.tenantId, targetUrl, role: caller.context.role });
  if (!binding.allowed) throw new Error(binding.reason);
}

function redactConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return { ...connector, authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined, lastError: connector.lastError ? "[redacted]" : undefined };
}
