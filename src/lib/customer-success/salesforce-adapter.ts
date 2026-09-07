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
  async function rawRequest(path: string, signal?: AbortSignal, retry = true) {
    assertSalesforcePath(path);
    let response: Response;
    try {
      response = await fetch(`${connection.instanceOrigin}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
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
        return rawRequest(path, signal, false);
      } catch {
        throw providerError(
          "authorization_expired",
          "Salesforce access expired and could not be refreshed. Reconnect the workspace.",
          "reconnect",
        );
      }
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw salesforceResponseError(response.status, body);
    if (!isRecord(body) && !Array.isArray(body)) {
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

function salesforceResponseError(status: number, body: unknown) {
  const errorCode = Array.isArray(body) && isRecord(body[0])
    ? String(body[0].errorCode || "")
    : "";
  if (status === 401) return providerError(
    "authorization_expired",
    "Salesforce authorization expired. Reconnect the workspace.",
    "reconnect",
  );
  if (status === 403 || ["INSUFFICIENT_ACCESS", "INVALID_FIELD"].includes(errorCode)) {
    return providerError(
      "insufficient_scope",
      "Salesforce object or field permissions are insufficient for the reviewed read scope.",
      "review_permissions",
    );
  }
  if (status === 429 || errorCode === "REQUEST_LIMIT_EXCEEDED") return providerError(
    "rate_limited",
    "Salesforce API limits are temporarily exhausted. Retry after the provider window resets.",
    "retry",
  );
  if (status === 404 || errorCode === "INVALID_QUERY_LOCATOR") return providerError(
    "cursor_expired",
    "Salesforce query cursor expired. Restart the bounded backfill page.",
    "restart_backfill",
  );
  return providerError(
    "provider_unavailable",
    "Salesforce could not complete the read request. Retry later.",
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
