import { capabilityJsonSha256, isCapabilityId } from "../automation/capability-state";
import { isJsonRecord, recordAt, type JsonRecord } from "../automation/automation-model";
import type { TrashActionPreviewV1 } from "@/lib/trash/contracts";

const records = (value: unknown): value is JsonRecord[] => Array.isArray(value) && value.every(isJsonRecord);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => text(value) && /^[a-f0-9]{64}$/.test(value);
function requireReceipt(value: unknown): asserts value {
  if (!value) throw new Error("No matching complete receipt was returned. The outcome is unconfirmed; refresh current connections before trying again.");
}

export function parseConnectionInventory(key: string, value: unknown): JsonRecord {
  if (!isJsonRecord(value)) throw new Error("The connection inventory returned an unreadable response.");
  let valid = true;
  if (key === "oauth") {
    valid = records(value.providers) && records(value.grants) &&
      value.providers.every((provider) => isCapabilityId(provider.id) && typeof provider.configured === "boolean" && Array.isArray(provider.scopes) && provider.scopes.every(text)) &&
      value.grants.every((grant) => isCapabilityId(grant.id) && isCapabilityId(grant.provider) &&
        ["active", "revoked"].includes(String(grant.status)) && Array.isArray(grant.scopes) && grant.scopes.every(text));
  } else if (key === "connectors" || key === "openapi") {
    const operations = value[key === "connectors" ? "tools" : "operations"];
    valid = records(value.connectors) && value.connectors.every((connector) => isCapabilityId(connector.id) &&
      text(connector.name) && ["active", "disabled", "error"].includes(String(connector.status)) &&
      count(connector[key === "connectors" ? "toolCount" : "operationCount"]) && count(recordAt(connector, "review")?.pendingCount)) && records(operations) &&
      operations.every((operation) => isCapabilityId(operation.id) && isCapabilityId(operation.connectorId));
  } else if (key === "tools") valid = records(value.tools);
  else if (key === "catalog") valid = records(value.connectors);
  if (!valid) throw new Error("The connection inventory response is incomplete. Last-loaded records are retained.");
  return value;
}

export function parseGoogleSyncReceipt(value: unknown, connectionId: string) {
  requireReceipt(isJsonRecord(value) && value.provider === "google" && recordAt(value, "grant")?.id === connectionId &&
    ["healthy", "partial", "error"].includes(String(value.status)) && count(value.imported) && count(value.removed) && records(value.sources));
  const sources = value.sources;
  requireReceipt(sources.length <= 3 && new Set(sources.map((source) => source.source)).size === sources.length &&
    sources.every((source) => ["mail", "calendar", "drive"].includes(String(source.source)) &&
      ["healthy", "syncing", "error"].includes(String(source.status)) && count(source.imported) && count(source.removed)) &&
    sources.reduce((total, source) => total + Number(source.imported), 0) === value.imported &&
    sources.reduce((total, source) => total + Number(source.removed), 0) === value.removed);
  const failed = sources.filter((source) => source.status === "error").length;
  const expectedStatus = failed ? failed === sources.length ? "error" : "partial" : sources.some((source) => source.status === "syncing") ? "partial" : "healthy";
  requireReceipt(value.status === expectedStatus);
  return { status: String(value.status), imported: value.imported, removed: value.removed,
    sources: sources.map((source) => ({ source: String(source.source), status: String(source.status), imported: Number(source.imported), removed: Number(source.removed) })) };
}

export function parseGoogleDisconnectReceipt(value: unknown) {
  requireReceipt(isJsonRecord(value) && value.revoked === true && value.provider === "google" &&
    ["revoked", "not_needed", "failed"].includes(String(value.providerRevocation)) &&
    value.providerRevoked === (value.providerRevocation === "revoked"));
  return { providerRevocation: String(value.providerRevocation) };
}

export function parseMcpReceipt(value: unknown, expected: { id?: string; fields?: JsonRecord; discovered?: boolean }) {
  const connector = recordAt(value, "connector");
  requireReceipt(connector && isCapabilityId(connector.id) && (!expected.id || connector.id === expected.id) &&
    text(connector.endpoint) && ["active", "disabled", "error"].includes(String(connector.status)));
  for (const [key, expectedValue] of Object.entries(expected.fields || {})) requireReceipt(connector[key] === expectedValue);
  if (expected.discovered) {
    requireReceipt(isJsonRecord(value) && records(value.tools) && value.tools.every((tool) => tool.connectorId === connector.id && isCapabilityId(tool.id)));
  }
  return connector;
}

export function parseContractReviewReceipt(value: unknown, kind: "mcp" | "openapi", connectorId: string) {
  requireReceipt(isJsonRecord(value) && count(value.promoted) &&
    ["active", "disabled", "error"].includes(String(value.connectorStatus)) && value.activationRequired === (value.connectorStatus !== "active"));
  const contracts = value[kind === "mcp" ? "tools" : "operations"];
  requireReceipt(records(contracts) && contracts.every((contract) => contract.connectorId === connectorId && isCapabilityId(contract.id)) && value.promoted <= contracts.length);
  return { promoted: value.promoted, activationRequired: Boolean(value.activationRequired), status: String(value.connectorStatus) };
}

export function parseOpenApiCreationReceipt(value: unknown, submitted: JsonRecord) {
  const connector = recordAt(value, "connector");
  requireReceipt(connector && isCapabilityId(connector.id) && connector.name === submitted.name &&
    connector.authType === submitted.authType && ["active", "disabled", "error"].includes(String(connector.status)) &&
    isJsonRecord(value) && records(value.operations) && value.operations.every((operation) => operation.connectorId === connector.id && isCapabilityId(operation.id)));
  if (submitted.baseUrl) requireReceipt(connector.baseUrl === submitted.baseUrl);
  if (submitted.specUrl) requireReceipt(connector.specUrl === submitted.specUrl);
  return { connector, importFailed: typeof value.error === "string" && value.error.length > 0 };
}

export async function parseMcpTrashPreview(value: unknown, connectorId: string): Promise<TrashActionPreviewV1> {
  const preview = recordAt(value, "preview");
  const target = recordAt(value, "target");
  requireReceipt(preview && preview.version === "p9.3-trash-preview:1" && preview.action === "trash" && preview.trashId === null &&
    preview.resourceType === "mcp_connector" && preview.resourceId === connectorId && count(preview.lifecycleRevision) &&
    digest(preview.targetSha256) && digest(preview.previewSha256) && isJsonRecord(value) && preview.targetSha256 === value.targetSha256 &&
    target?.kind === "mcp" && recordAt(target, "connector")?.id === connectorId && recordsOrIds(target.operationIds) &&
    text(preview.effectSummary) && preview.effectSummary.length <= 500 && typeof preview.reversible === "boolean" &&
    text(preview.issuedAt) && text(preview.expiresAt) && Date.parse(preview.expiresAt) > Date.parse(preview.issuedAt));
  requireReceipt(await capabilityJsonSha256(target) === preview.targetSha256);
  const { previewSha256, ...body } = preview;
  requireReceipt(await capabilityJsonSha256(body) === previewSha256);
  return preview as unknown as TrashActionPreviewV1;
}

function recordsOrIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(isCapabilityId); }

export async function parseMcpTrashReceipt(value: unknown, preview: TrashActionPreviewV1) {
  const item = recordAt(value, "trash");
  const receipt = recordAt(value, "effectReceipt");
  requireReceipt(isJsonRecord(value) && value.movedToTrash === true && item && receipt &&
    item.version === "p9.3-trash-item:1" && item.resourceType === "mcp_connector" && item.resourceId === preview.resourceId &&
    item.state === "retained" && item.targetSha256 === preview.targetSha256 && isCapabilityId(item.trashId) &&
    text(item.restoreUntil) && Number.isFinite(Date.parse(item.restoreUntil)) && digest(item.itemSha256) &&
    receipt.version === "p9.3-trash-effect-receipt:1" && receipt.action === "trash" && receipt.resourceId === preview.resourceId &&
    receipt.resourceType === "mcp_connector" && receipt.trashId === item.trashId && receipt.previewSha256 === preview.previewSha256 &&
    receipt.targetSha256 === preview.targetSha256 && receipt.afterState === "retained" &&
    ["applied", "already_applied"].includes(String(receipt.outcome)) && digest(receipt.receiptSha256));
  requireReceipt(count(item.lifecycleRevision) && item.lifecycleRevision >= 1 && receipt.afterRevision === item.lifecycleRevision &&
    receipt.beforeRevision === preview.lifecycleRevision && item.restoredAt === null && item.purgedAt === null);
  const { itemSha256, ...itemBody } = item;
  const { receiptSha256, ...receiptBody } = receipt;
  requireReceipt(await capabilityJsonSha256(itemBody) === itemSha256 && await capabilityJsonSha256(receiptBody) === receiptSha256);
  return { trashId: String(item.trashId), restoreUntil: item.restoreUntil, receiptSha256: String(receipt.receiptSha256) };
}
