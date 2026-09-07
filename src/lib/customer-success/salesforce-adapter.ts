import {
  SALESFORCE_OBJECT_FIELDS,
  normalizeSalesforceRecord,
  type SalesforceActionableError,
  type SalesforceObjectCursor,
  type SalesforceObjectType,
  type SalesforceRecordObservation,
} from "@/lib/customer-success/salesforce-contracts";
import type { SalesforceConnection } from "@/lib/customer-success/salesforce-store";
import {
  getOAuthGrantSecrets,
  saveOAuthGrant,
} from "@/lib/connectors/oauth-store";
import {
  isSalesforceInstanceUrl,
  refreshOAuthAccess,
} from "@/lib/connectors/oauth-providers";
import {
  getSalesforceWriteConfiguration,
  providerRecordIdSha256,
  salesforceWriteCommitSchema,
  salesforceWriteExpectedTargetState,
  salesforceWriteExpectedTargetStateSha256,
  salesforceWriteExternalKey,
  salesforceWriteOperationId,
  salesforceWriteToolMetadata,
  type SalesforceRecordWriteInput,
  type SalesforceRecordWriteToolId,
  type SalesforceWriteCommit,
  type SalesforceWriteObject,
} from "@/lib/customer-success/salesforce-write-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const pageSize = 2_000;

export type SalesforcePage = Readonly<{
  objectType: SalesforceObjectType;
  sourceKind: "backfill" | "delta";
  upperBoundAt: string;
  observations: readonly SalesforceRecordObservation[];
  nextRecordsPath: string | null;
  done: boolean;
  totalSize: number;
}>;

export class SalesforceProviderError extends Error {
  readonly actionableError: SalesforceActionableError;

  constructor(actionableError: SalesforceActionableError) {
    super(actionableError.message);
    this.name = "SalesforceProviderError";
    this.actionableError = actionableError;
  }
}

export async function fetchSalesforcePage(input: {
  connection: SalesforceConnection;
  objectType: SalesforceObjectType;
  cursor: SalesforceObjectCursor;
  abortSignal?: AbortSignal;
}): Promise<SalesforcePage> {
  const observedAt = new Date().toISOString();
  const api = await salesforceApi(input.connection, input.abortSignal);
  const sourceKind = input.cursor.phase === "pending" ||
      input.cursor.phase === "backfill"
    ? "backfill" as const
    : "delta" as const;
  const upperBoundAt = input.cursor.upperBoundAt || observedAt;
  const path = input.cursor.nextRecordsPath || await firstQueryPath({
    api,
    objectType: input.objectType,
    cursor: input.cursor,
    sourceKind,
    upperBoundAt,
    abortSignal: input.abortSignal,
  });
  const response = await api.request(path, input.abortSignal);
  if (!isRecord(response)) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid query response shape.",
      "review_permissions",
    );
  }
  const payload = response;
  const records = Array.isArray(payload.records)
    ? payload.records.filter(isRecord)
    : [];
  const nextRecordsPath = payload.done === true
    ? null
    : safeNextRecordsPath(payload.nextRecordsUrl, api.basePath);
  return Object.freeze({
    objectType: input.objectType,
    sourceKind,
    upperBoundAt,
    observations: Object.freeze(records.map((record) =>
      normalizeSalesforceRecord({
        objectType: input.objectType,
        record,
        sourceKind,
        observedAt,
      })
    )),
    nextRecordsPath,
    done: payload.done === true,
    totalSize: safeCount(payload.totalSize),
  });
}

export async function fetchSalesforceRecord(input: {
  connection: SalesforceConnection;
  objectType: SalesforceObjectType;
  externalId: string;
  sourceKind: "webhook" | "reconciliation";
  replayIdSha256?: string | null;
  abortSignal?: AbortSignal;
}): Promise<SalesforceRecordObservation | undefined> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(input.externalId)) {
    throw providerError(
      "schema_changed",
      "Salesforce record identity is invalid.",
      "review_permissions",
    );
  }
  const api = await salesforceApi(input.connection, input.abortSignal);
  const fields = await readableFields(api, input.objectType, input.abortSignal);
  const soql = `SELECT ${fields.join(",")} FROM ${input.objectType} WHERE Id = '${input.externalId}' LIMIT 1`;
  const response = await api.request(
    `${api.basePath}/queryAll?q=${encodeURIComponent(soql)}`,
    input.abortSignal,
  );
  if (!isRecord(response)) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid query response shape.",
      "review_permissions",
    );
  }
  const payload = response;
  const record = Array.isArray(payload.records) && isRecord(payload.records[0])
    ? payload.records[0]
    : undefined;
  if (!record) return undefined;
  return normalizeSalesforceRecord({
    objectType: input.objectType,
    record,
    sourceKind: input.sourceKind,
    observedAt: new Date().toISOString(),
    replayIdSha256: input.replayIdSha256,
  });
}

export type SalesforceWriteExecutionResult =
  | Readonly<{ status: "commit"; commit: SalesforceWriteCommit }>
  | Readonly<{ status: "retryable" }>;

export async function executeSalesforceWrite(input: {
  connection: SalesforceConnection;
  toolId: SalesforceRecordWriteToolId;
  value: SalesforceRecordWriteInput;
  executionId: string;
  salesforceAccountId: string;
  reconcileOnly?: boolean;
  abortSignal?: AbortSignal;
}): Promise<SalesforceWriteExecutionResult> {
  const configuration = getSalesforceWriteConfiguration();
  if (!configuration.configured || !configuration.externalIdField) {
    throw providerError(
      "insufficient_scope",
      "Guarded Salesforce writes are not enabled with a reviewed unique External ID field.",
      "review_permissions",
    );
  }
  const metadata = salesforceWriteToolMetadata(input.toolId);
  if (!/^[A-Za-z0-9]{15,18}$/.test(input.salesforceAccountId)) {
    throw providerError(
      "record_conflict",
      "The Account 360 Salesforce link is invalid. Synchronize before writing.",
      "review_conflict",
    );
  }
  const api = await salesforceApi(input.connection, input.abortSignal);
  const relationship = relationshipField(metadata.objectType);
  const externalKey = metadata.action === "create"
    ? salesforceWriteExternalKey(input.executionId)
    : null;
  const requestedFields = Object.keys(input.value.fields);
  await validateWritableFields({
    api,
    objectType: metadata.objectType,
    action: metadata.action,
    fields: requestedFields,
    relationship,
    externalIdField: configuration.externalIdField,
    abortSignal: input.abortSignal,
  });
  const current = await readSalesforceWriteTarget({
    api,
    objectType: metadata.objectType,
    recordId: input.value.recordId,
    externalIdField: configuration.externalIdField,
    externalKey,
    fields: requestedFields,
    relationship,
    abortSignal: input.abortSignal,
  });
  const existing = evaluateWriteTarget({
    toolId: input.toolId,
    value: input.value,
    executionId: input.executionId,
    record: current,
    relationship,
    salesforceAccountId: input.salesforceAccountId,
    externalIdField: configuration.externalIdField,
    externalKey,
  });
  if (existing.matches) {
    return {
      status: "commit",
      commit: buildSalesforceWriteCommit({
        input,
        record: current!,
        providerAcknowledgement: "provider_idempotency_reconciliation",
        providerResponse: { reconciled: true },
        evaluation: existing,
      }),
    };
  }
  if (metadata.action === "update") {
    if (!current) {
      return {
        status: "commit",
        commit: missingTargetCommit(input),
      };
    }
    if (!existing.relationshipMatches ||
        canonicalProviderTimestamp(current.SystemModstamp || current.LastModifiedDate) !==
          input.value.expectedProviderModifiedAt) {
      return {
        status: "commit",
        commit: buildSalesforceWriteCommit({
          input,
          record: current,
          providerAcknowledgement: "provider_idempotency_reconciliation",
          providerResponse: { reconciled: true, changed: true },
          evaluation: existing,
        }),
      };
    }
    if (input.reconcileOnly) return { status: "retryable" };
  } else if (current) {
    return {
      status: "commit",
      commit: buildSalesforceWriteCommit({
        input,
        record: current,
        providerAcknowledgement: "provider_idempotency_reconciliation",
        providerResponse: { reconciled: true, mismatched: true },
        evaluation: existing,
      }),
    };
  } else if (input.reconcileOnly) {
    return { status: "retryable" };
  }

  const payload: Record<string, unknown> = {
    ...input.value.fields,
    ...(relationship ? { [relationship]: input.salesforceAccountId } : {}),
  };
  const mutationPath = metadata.action === "create"
    ? `${api.basePath}/sobjects/${metadata.objectType}/${configuration.externalIdField}/${externalKey}`
    : `${api.basePath}/sobjects/${metadata.objectType}/${input.value.recordId}`;
  const providerResponse = await api.mutate(mutationPath, {
    method: "PATCH",
    body: payload,
    headers: metadata.action === "update" && current?.LastModifiedDate
      ? { "if-unmodified-since": new Date(String(current.LastModifiedDate)).toUTCString() }
      : {},
  }, input.abortSignal);
  const observed = await readSalesforceWriteTarget({
    api,
    objectType: metadata.objectType,
    recordId: input.value.recordId,
    externalIdField: configuration.externalIdField,
    externalKey,
    fields: requestedFields,
    relationship,
    abortSignal: input.abortSignal,
  });
  if (!observed) {
    return { status: "commit", commit: missingTargetCommit(input, providerResponse) };
  }
  const evaluation = evaluateWriteTarget({
    toolId: input.toolId,
    value: input.value,
    executionId: input.executionId,
    record: observed,
    relationship,
    salesforceAccountId: input.salesforceAccountId,
    externalIdField: configuration.externalIdField,
    externalKey,
  });
  return {
    status: "commit",
    commit: buildSalesforceWriteCommit({
      input,
      record: observed,
      providerAcknowledgement: "provider_response",
      providerResponse,
      evaluation,
    }),
  };
}

async function validateWritableFields(input: {
  api: SalesforceApi;
  objectType: SalesforceWriteObject;
  action: "create" | "update";
  fields: readonly string[];
  relationship: string | null;
  externalIdField: string;
  abortSignal?: AbortSignal;
}) {
  const describe = await input.api.request(
    `${input.api.basePath}/sobjects/${input.objectType}/describe`,
    input.abortSignal,
  );
  if (!isRecord(describe)) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid object description for guarded writes.",
      "review_permissions",
    );
  }
  const fields = new Map(
    (Array.isArray(describe.fields) ? describe.fields : [])
      .filter(isRecord)
      .map((field) => [String(field.name || ""), field] as const),
  );
  for (const fieldName of [
    ...input.fields,
    ...(input.relationship ? [input.relationship] : []),
  ]) {
    const field = fields.get(fieldName);
    const writable = input.action === "create"
      ? field?.createable === true
      : field?.updateable === true;
    if (!writable) {
      throw providerError(
        "insufficient_scope",
        `${input.objectType}.${fieldName} is not writable under the connected Salesforce permission set.`,
        "review_permissions",
      );
    }
  }
  if (input.action === "create") {
    const externalId = fields.get(input.externalIdField);
    if (externalId?.externalId !== true || externalId.unique !== true ||
        externalId.createable !== true || externalId.updateable !== true) {
      throw providerError(
        "insufficient_scope",
        `Salesforce ${input.objectType}.${input.externalIdField} must be a unique writable External ID field.`,
        "review_permissions",
      );
    }
  }
}

async function readSalesforceWriteTarget(input: {
  api: SalesforceApi;
  objectType: SalesforceWriteObject;
  recordId?: string;
  externalIdField: string;
  externalKey: string | null;
  fields: readonly string[];
  relationship: string | null;
  abortSignal?: AbortSignal;
}) {
  const selected = Array.from(new Set([
    "Id",
    "LastModifiedDate",
    "SystemModstamp",
    ...input.fields,
    ...(input.relationship ? [input.relationship] : []),
    ...(input.externalKey ? [input.externalIdField] : []),
  ]));
  const condition = input.externalKey
    ? `${input.externalIdField} = '${input.externalKey}'`
    : `Id = '${input.recordId}'`;
  const soql = `SELECT ${selected.join(",")} FROM ${input.objectType} WHERE ${condition} LIMIT 2`;
  const response = await input.api.request(
    `${input.api.basePath}/query?q=${encodeURIComponent(soql)}`,
    input.abortSignal,
  );
  if (!isRecord(response) || !Array.isArray(response.records)) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid guarded-write verification response.",
      "review_permissions",
    );
  }
  const records = response.records.filter(isRecord);
  if (records.length > 1) {
    throw providerError(
      "record_conflict",
      "Salesforce returned multiple records for one guarded write identity.",
      "review_conflict",
    );
  }
  return records[0];
}

function evaluateWriteTarget(input: {
  toolId: SalesforceRecordWriteToolId;
  value: SalesforceRecordWriteInput;
  executionId: string;
  record?: Record<string, unknown>;
  relationship: string | null;
  salesforceAccountId: string;
  externalIdField: string;
  externalKey: string | null;
}) {
  if (!input.record) {
    return {
      matches: false,
      relationshipMatches: false,
      observedTargetStateSha256: null,
    } as const;
  }
  const metadata = salesforceWriteToolMetadata(input.toolId);
  const recordId = String(input.record.Id || "");
  const relationshipMatches = metadata.objectType === "Account"
    ? recordId === input.salesforceAccountId
    : Boolean(input.relationship &&
      input.record[input.relationship] === input.salesforceAccountId);
  const expected = salesforceWriteExpectedTargetState({
    toolId: input.toolId,
    value: input.value,
    executionId: input.executionId,
  });
  const recordIdentity = metadata.action === "create"
    ? {
        externalKey: input.record[input.externalIdField] === input.externalKey
          ? input.externalKey
          : "mismatched",
      }
    : {
        providerRecordIdSha256: /^[A-Za-z0-9]{15,18}$/.test(recordId)
          ? providerRecordIdSha256(recordId)
          : canonicalJsonSha256({ invalidSalesforceRecordId: true }),
      };
  const observed = {
    ...expected,
    accountBinding: relationshipMatches ? "linked_account" : "mismatched",
    recordIdentity,
    fields: Object.fromEntries(
      Object.keys(input.value.fields).map((field) => [
        field,
        normalizeWriteFieldValue(input.record?.[field]),
      ]),
    ),
  };
  const observedTargetStateSha256 = canonicalJsonSha256(observed);
  return {
    matches: relationshipMatches &&
      observedTargetStateSha256 === canonicalJsonSha256(expected),
    relationshipMatches,
    observedTargetStateSha256,
  } as const;
}

function buildSalesforceWriteCommit(input: {
  input: {
    toolId: SalesforceRecordWriteToolId;
    value: SalesforceRecordWriteInput;
    executionId: string;
  };
  record: Record<string, unknown>;
  providerAcknowledgement: SalesforceWriteCommit["providerAcknowledgement"];
  providerResponse: unknown;
  evaluation: ReturnType<typeof evaluateWriteTarget>;
}) {
  const metadata = salesforceWriteToolMetadata(input.input.toolId);
  const expectedTargetStateSha256 = salesforceWriteExpectedTargetStateSha256({
    toolId: input.input.toolId,
    value: input.input.value,
    executionId: input.input.executionId,
  });
  const providerRecordId = String(input.record.Id || "");
  const providerModifiedAt = canonicalProviderTimestamp(
    input.record.SystemModstamp || input.record.LastModifiedDate,
  );
  const providerAcknowledgementSha256 = canonicalJsonSha256({
    operationId: salesforceWriteOperationId(input.input.executionId),
    providerRecordIdSha256: providerRecordIdSha256(providerRecordId),
    providerModifiedAt,
    providerResponseSha256: canonicalJsonSha256(input.providerResponse ?? null),
    expectedTargetStateSha256,
    observedTargetStateSha256: input.evaluation.observedTargetStateSha256,
  });
  return salesforceWriteCommitSchema.parse({
    schemaVersion: 1,
    contractVersion: "p10.11-salesforce-guarded-write:1",
    operationId: salesforceWriteOperationId(input.input.executionId),
    toolId: input.input.toolId,
    objectType: metadata.objectType,
    action: metadata.action,
    providerRecordIdSha256: providerRecordIdSha256(providerRecordId),
    providerModifiedAt,
    providerAcknowledgement: input.providerAcknowledgement,
    providerAcknowledgementId: `salesforce_ack_${providerAcknowledgementSha256.slice(0, 48)}`,
    providerAcknowledgementSha256,
    expectedTargetStateSha256,
    observedTargetStateSha256: input.evaluation.observedTargetStateSha256,
    verificationState: input.evaluation.matches ? "verified" : "failed",
    verificationReasonCode: input.evaluation.matches
      ? "state_matched"
      : "state_mismatch",
  });
}

function missingTargetCommit(
  input: {
    toolId: SalesforceRecordWriteToolId;
    value: SalesforceRecordWriteInput;
    executionId: string;
  },
  providerResponse?: unknown,
) {
  const metadata = salesforceWriteToolMetadata(input.toolId);
  const expectedTargetStateSha256 = salesforceWriteExpectedTargetStateSha256({
    toolId: input.toolId,
    value: input.value,
    executionId: input.executionId,
  });
  const providerRecordIdSha = input.value.recordId
    ? providerRecordIdSha256(input.value.recordId)
    : canonicalJsonSha256({
        provider: "salesforce",
        externalKey: salesforceWriteExternalKey(input.executionId),
      });
  const providerAcknowledgementSha256 = canonicalJsonSha256({
    operationId: salesforceWriteOperationId(input.executionId),
    providerRecordIdSha256: providerRecordIdSha,
    providerResponseSha256: canonicalJsonSha256(providerResponse ?? null),
    expectedTargetStateSha256,
    targetMissing: true,
  });
  return salesforceWriteCommitSchema.parse({
    schemaVersion: 1,
    contractVersion: "p10.11-salesforce-guarded-write:1",
    operationId: salesforceWriteOperationId(input.executionId),
    toolId: input.toolId,
    objectType: metadata.objectType,
    action: metadata.action,
    providerRecordIdSha256: providerRecordIdSha,
    providerModifiedAt: null,
    providerAcknowledgement: "provider_idempotency_reconciliation",
    providerAcknowledgementId: `salesforce_ack_${providerAcknowledgementSha256.slice(0, 48)}`,
    providerAcknowledgementSha256,
    expectedTargetStateSha256,
    observedTargetStateSha256: null,
    verificationState: "failed",
    verificationReasonCode: "target_missing",
  });
}

function relationshipField(objectType: SalesforceWriteObject) {
  if (["Contact", "Case", "Opportunity"].includes(objectType)) return "AccountId";
  if (objectType === "Task") return "WhatId";
  if (objectType === "Note") return "ParentId";
  return null;
}

function normalizeWriteFieldValue(value: unknown) {
  return value === null || typeof value === "string" ||
      typeof value === "number"
    ? value
    : null;
}

async function firstQueryPath(input: {
  api: SalesforceApi;
  objectType: SalesforceObjectType;
  cursor: SalesforceObjectCursor;
  sourceKind: "backfill" | "delta";
  upperBoundAt: string;
  abortSignal?: AbortSignal;
}) {
  const fields = await readableFields(
    input.api,
    input.objectType,
    input.abortSignal,
  );
  const conditions = [
    `SystemModstamp <= ${soqlTimestamp(input.upperBoundAt)}`,
  ];
  if (input.sourceKind === "delta" && input.cursor.watermarkAt) {
    const watermark = soqlTimestamp(input.cursor.watermarkAt);
    conditions.push(input.cursor.watermarkExternalId
      ? `(SystemModstamp > ${watermark} OR (SystemModstamp = ${watermark} AND Id > '${input.cursor.watermarkExternalId}'))`
      : `SystemModstamp >= ${watermark}`);
  }
  const soql = `SELECT ${fields.join(",")} FROM ${input.objectType} WHERE ${conditions.join(" AND ")} ORDER BY SystemModstamp, Id LIMIT ${pageSize}`;
  return `${input.api.basePath}/queryAll?q=${encodeURIComponent(soql)}`;
}

type SalesforceApi = Readonly<{
  basePath: string;
  request: (path: string, abortSignal?: AbortSignal) => Promise<unknown>;
  mutate: (
    path: string,
    init: {
      method: "PATCH";
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    },
    abortSignal?: AbortSignal,
  ) => Promise<unknown>;
}>;

async function salesforceApi(
  connection: SalesforceConnection,
  abortSignal?: AbortSignal,
): Promise<SalesforceApi> {
  const secret = await getOAuthGrantSecrets(
    connection.tenantId,
    connection.ownerActorId,
    "salesforce",
  );
  if (!secret || secret.grant.id !== connection.oauthGrantId) {
    throw providerError(
      "authorization_expired",
      "Salesforce authorization is unavailable. Reconnect the workspace.",
      "reconnect",
    );
  }
  const grantSecret = secret;
  const instanceOrigin = String(grantSecret.tokens.instance_url || "");
  if (!isSalesforceInstanceUrl(instanceOrigin) ||
      new URL(instanceOrigin).origin !== connection.instanceOrigin) {
    throw providerError(
      "authorization_expired",
      "Salesforce instance authority changed. Reconnect the workspace.",
      "reconnect",
    );
  }
  let accessToken = String(grantSecret.tokens.access_token || "");
  if (!accessToken) {
    throw providerError(
      "authorization_expired",
      "Salesforce authorization has no active access token.",
      "reconnect",
    );
  }
  async function rawRequest(
    path: string,
    signal?: AbortSignal,
    retry = true,
    init?: {
      method: "PATCH";
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ) {
    assertSalesforcePath(path);
    let response: Response;
    try {
      response = await fetch(`${connection.instanceOrigin}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(init ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        method: init?.method,
        body: init ? JSON.stringify(init.body) : undefined,
        signal: combinedSignal(signal || abortSignal),
      });
    } catch {
      throw providerError(
        "provider_unavailable",
        "Salesforce could not be reached. Retry after checking provider availability.",
        "retry",
      );
    }
    if (response.status === 401 && retry) {
      const refreshToken = String(grantSecret.tokens.refresh_token || "");
      if (!refreshToken) {
        throw providerError(
          "authorization_expired",
          "Salesforce access expired and cannot be refreshed. Reconnect the workspace.",
          "reconnect",
        );
      }
      try {
        const refreshed = await refreshOAuthAccess("salesforce", refreshToken);
        const refreshedOrigin = String(
          refreshed.instance_url || grantSecret.tokens.instance_url || "",
        );
        if (!isSalesforceInstanceUrl(refreshedOrigin) ||
            new URL(refreshedOrigin).origin !== connection.instanceOrigin) {
          throw new Error("Instance authority changed.");
        }
        accessToken = String(refreshed.access_token || "");
        await saveOAuthGrant({
          tenantId: connection.tenantId,
          actorId: connection.ownerActorId,
          provider: "salesforce",
          authorizationMode: "refresh",
          tokens: {
            ...grantSecret.tokens,
            ...refreshed,
            instance_url: refreshedOrigin,
          },
        });
        return rawRequest(path, signal, false, init);
      } catch {
        throw providerError(
          "authorization_expired",
          "Salesforce access expired and could not be refreshed. Reconnect the workspace.",
          "reconnect",
        );
      }
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw salesforceResponseError(response.status, body, Boolean(init));
    }
    if (body !== undefined && !isRecord(body) && !Array.isArray(body)) {
      throw providerError(
        "schema_changed",
        "Salesforce returned an invalid response shape.",
        "review_permissions",
      );
    }
    return body;
  }
  const versions = await rawRequest("/services/data/", abortSignal);
  const version = highestApiVersion(versions);
  const basePath = `/services/data/v${version}`;
  return Object.freeze({
    basePath,
    request: (path: string, signal?: AbortSignal) => rawRequest(path, signal),
    mutate: (path, init, signal) => rawRequest(path, signal, true, init),
  });
}

async function readableFields(
  api: SalesforceApi,
  objectType: SalesforceObjectType,
  abortSignal?: AbortSignal,
) {
  const describe = await api.request(
    `${api.basePath}/sobjects/${objectType}/describe`,
    abortSignal,
  );
  if (!isRecord(describe)) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid object description.",
      "review_permissions",
    );
  }
  const readable = new Set(
    (Array.isArray(describe.fields) ? describe.fields : [])
      .filter(isRecord)
      .filter((field) => field.permissionable !== false)
      .map((field) => String(field.name || "")),
  );
  const fields = SALESFORCE_OBJECT_FIELDS[objectType]
    .filter((field) => readable.has(field));
  if (!fields.includes("Id") || !fields.includes("SystemModstamp")) {
    throw providerError(
      "insufficient_scope",
      `${objectType} read permission or revision fields are unavailable in Salesforce.`,
      "review_permissions",
    );
  }
  return fields;
}

function highestApiVersion(payload: unknown) {
  const versions = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.versions)
      ? payload.versions
      : [];
  const available = versions
    .filter(isRecord)
    .map((item) => String(item.version || ""))
    .filter((value) => /^\d{1,3}\.0$/.test(value))
    .sort((left, right) => Number(right) - Number(left));
  if (!available[0]) {
    throw providerError(
      "schema_changed",
      "Salesforce did not advertise a supported REST API version.",
      "review_permissions",
    );
  }
  return available[0];
}

function salesforceResponseError(status: number, body: unknown, mutation = false) {
  const errorCode = Array.isArray(body) && isRecord(body[0])
    ? String(body[0].errorCode || "")
    : "";
  if (status === 401) return providerError(
    "authorization_expired",
    "Salesforce authorization expired. Reconnect the workspace.",
    "reconnect",
  );
  if (status === 412) return providerError(
    "record_conflict",
    "Salesforce changed after approval. Refresh the exact record before retrying.",
    "review_conflict",
  );
  if (status === 403 || ["INSUFFICIENT_ACCESS", "INVALID_FIELD"].includes(errorCode)) {
    return providerError(
      "insufficient_scope",
      "Salesforce object or field permissions are insufficient for the reviewed scope.",
      "review_permissions",
    );
  }
  if (status === 429 || errorCode === "REQUEST_LIMIT_EXCEEDED") return providerError(
    "rate_limited",
    "Salesforce API limits are temporarily exhausted. Retry after the provider window resets.",
    "retry",
  );
  if (mutation && status === 404) return providerError(
    "record_conflict",
    "The Salesforce write target is no longer available. Refresh before retrying.",
    "review_conflict",
  );
  if (errorCode === "INVALID_QUERY_LOCATOR") return providerError(
    "cursor_expired",
    "Salesforce query cursor expired. Restart the bounded backfill page.",
    "restart_backfill",
  );
  return providerError(
    "provider_unavailable",
    "Salesforce could not complete the request. Retry later.",
    "retry",
  );
}

function providerError(
  code: SalesforceActionableError["code"],
  message: string,
  action: SalesforceActionableError["action"],
) {
  return new SalesforceProviderError({
    code,
    message,
    action,
    occurredAt: new Date().toISOString(),
  });
}

function safeNextRecordsPath(value: unknown, basePath: string) {
  if (typeof value !== "string" || value.length > 2_000 ||
      !value.startsWith(`${basePath}/query/`)) {
    throw providerError(
      "cursor_expired",
      "Salesforce returned an invalid query cursor.",
      "restart_backfill",
    );
  }
  return value;
}

function assertSalesforcePath(path: string) {
  if (!/^\/services\/data\/(?:$|v\d{1,3}\.0\/)/.test(path) ||
      path.includes("..") || path.includes("\\") || path.length > 8_000) {
    throw providerError(
      "internal_error",
      "Salesforce request authority is invalid.",
      "contact_support",
    );
  }
}

function soqlTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("Salesforce cursor timestamp is invalid.");
  }
  return value;
}

function canonicalProviderTimestamp(value: unknown) {
  if (typeof value !== "string") {
    throw providerError(
      "schema_changed",
      "Salesforce record has no provider revision timestamp.",
      "review_permissions",
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw providerError(
      "schema_changed",
      "Salesforce returned an invalid provider revision timestamp.",
      "review_permissions",
    );
  }
  return date.toISOString();
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function combinedSignal(signal?: AbortSignal) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
