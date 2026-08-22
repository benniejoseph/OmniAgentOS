import { parse as parseYaml } from "yaml";
import type {
  OpenApiConnectorRecord,
  OpenApiHttpMethod,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import { createOpenApiToolId, hashOpenApiSpec } from "@/lib/connectors/openapi-store";
import { readResponseTextLimited } from "@/lib/http/body";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import type { ToolRiskLevel } from "@/lib/tools/types";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const SAFE_METHODS = new Set<OpenApiHttpMethod>(["GET", "HEAD", "OPTIONS"]);
const MAX_IMPORTED_OPERATIONS = 250;
export const MAX_OPENAPI_SPEC_BYTES = 2_000_000;

type JsonRecord = Record<string, unknown>;

type OpenApiImportResult = {
  specHash: string;
  baseUrl: string;
  info: Record<string, unknown>;
  operations: OpenApiOperationRecord[];
};

export async function loadOpenApiSpec(specUrl: string) {
  const response = await fetchPublicHttpUrl(specUrl, {
    headers: { accept: "application/json, application/yaml, text/yaml, text/plain" },
    signal: AbortSignal.timeout(30_000),
  }, "OpenAPI spec URL");

  if (!response.ok) {
    throw new Error(`OpenAPI spec fetch failed with HTTP ${response.status}.`);
  }

  const body = await readResponseTextLimited(response, MAX_OPENAPI_SPEC_BYTES);
  if (body.truncated) {
    throw new Error("OpenAPI spec is too large for the current importer limit.");
  }

  return body.text;
}

export function importOpenApiSpec({
  connector,
  specText,
  baseUrlOverride,
}: {
  connector: OpenApiConnectorRecord;
  specText: string;
  baseUrlOverride?: string;
}): OpenApiImportResult {
  if (new TextEncoder().encode(specText).byteLength > MAX_OPENAPI_SPEC_BYTES) {
    throw new Error("OpenAPI spec is too large for the current importer limit.");
  }

  const document = parseOpenApiSpec(specText);
  const baseUrl = normalizeBaseUrl(
    baseUrlOverride || connector.baseUrl || firstServerUrl(document, connector.specUrl),
    connector.specUrl,
  );
  const info = parseObject(document.info) || {};
  const operations = extractOperations({ connector: { ...connector, baseUrl }, document });

  if (!operations.length) {
    throw new Error("OpenAPI spec did not contain importable operations.");
  }

  return {
    specHash: hashOpenApiSpec(specText),
    baseUrl,
    info,
    operations,
  };
}

function parseOpenApiSpec(specText: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(specText);
  } catch {
    parsed = parseYaml(specText);
  }

  if (!isRecord(parsed)) {
    throw new Error("OpenAPI spec must parse to an object.");
  }

  if (!parsed.openapi && !parsed.swagger) {
    throw new Error("OpenAPI spec is missing an openapi/swagger version.");
  }

  if (!isRecord(parsed.paths)) {
    throw new Error("OpenAPI spec is missing a paths object.");
  }

  return parsed;
}

function extractOperations({
  connector,
  document,
}: {
  connector: OpenApiConnectorRecord;
  document: JsonRecord;
}) {
  const paths = document.paths as JsonRecord;
  const operations: OpenApiOperationRecord[] = [];
  const operationIds = new Map<string, number>();
  const now = new Date().toISOString();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    assertSafeOpenApiOperationPath(path);
    const pathItem = resolveReference(rawPathItem, document);
    if (!isRecord(pathItem)) {
      continue;
    }

    const pathParameters = readParameterList(pathItem.parameters, document);

    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      const operation = resolveReference(rawOperation, document);
      if (!isRecord(operation)) {
        continue;
      }

      const normalizedMethod = method.toUpperCase() as OpenApiHttpMethod;
      const operationId = uniqueOperationId(
        normalizeOperationId(String(operation.operationId || `${method}_${path}`)),
        operationIds,
      );
      const riskLevel = inferOpenApiRiskLevel(normalizedMethod, operation, connector.defaultRiskLevel);
      const parameters = [
        ...pathParameters,
        ...readParameterList(operation.parameters, document),
      ];
      const requestBody = readRequestBody(operation.requestBody, document);

      operations.push({
        id: createOpenApiToolId(connector.id, operationId),
        connectorId: connector.id,
        connectorName: connector.name,
        operationId,
        method: normalizedMethod,
        path,
        summary: readString(operation.summary),
        description: readString(operation.description),
        inputSchema: createInputSchema({ parameters, requestBody, document }),
        requestContentType: requestBody?.contentType,
        responseContentTypes: readResponseContentTypes(operation.responses, document),
        riskLevel,
        approvalRequired: connector.approvalRequired || riskLevel >= 2,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      if (operations.length >= MAX_IMPORTED_OPERATIONS) {
        return operations;
      }
    }
  }

  return operations;
}

function readParameterList(value: unknown, document: JsonRecord) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((parameter) => resolveReference(parameter, document))
    .filter(isRecord)
    .filter((parameter) => typeof parameter.name === "string" && typeof parameter.in === "string");
}

function readRequestBody(value: unknown, document: JsonRecord) {
  const requestBody = resolveReference(value, document);
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return undefined;
  }

  const contentTypes = Object.keys(requestBody.content);
  const contentType =
    contentTypes.find((item) => item.includes("json")) ||
    contentTypes.find((item) => item.includes("form")) ||
    contentTypes[0];
  const mediaType = contentType ? resolveReference(requestBody.content[contentType], document) : undefined;
  const schema = isRecord(mediaType) ? resolveJsonSchema(mediaType.schema, document) : {};

  return {
    contentType,
    required: Boolean(requestBody.required),
    schema,
  };
}

function createInputSchema({
  parameters,
  requestBody,
  document,
}: {
  parameters: JsonRecord[];
  requestBody?: { contentType?: string; required: boolean; schema: Record<string, unknown> };
  document: JsonRecord;
}) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const groups: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
    headers: { properties: {}, required: [] },
  };

  for (const parameter of parameters) {
    const location = parameter.in === "header" ? "headers" : String(parameter.in);
    if (!(location in groups)) {
      continue;
    }

    const name = String(parameter.name);
    const schema = resolveJsonSchema(parameter.schema, document);
    groups[location].properties[name] = {
      ...schema,
      description: readString(parameter.description) || readString(schema.description),
    };
    if (parameter.required) {
      groups[location].required.push(name);
    }
  }

  for (const [groupName, group] of Object.entries(groups)) {
    if (!Object.keys(group.properties).length) {
      continue;
    }

    properties[groupName] = {
      type: "object",
      additionalProperties: false,
      properties: group.properties,
      ...(group.required.length ? { required: group.required } : {}),
    };

    if (group.required.length) {
      required.push(groupName);
    }
  }

  if (requestBody) {
    properties.body = requestBody.schema || { type: "object" };
    if (requestBody.required) {
      required.push("body");
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function readResponseContentTypes(value: unknown, document: JsonRecord) {
  const responses = resolveReference(value, document);
  if (!isRecord(responses)) {
    return [];
  }

  const contentTypes = new Set<string>();
  for (const response of Object.values(responses)) {
    const resolvedResponse = resolveReference(response, document);
    if (!isRecord(resolvedResponse) || !isRecord(resolvedResponse.content)) {
      continue;
    }
    for (const contentType of Object.keys(resolvedResponse.content)) {
      contentTypes.add(contentType);
    }
  }
  return [...contentTypes];
}

function resolveJsonSchema(
  value: unknown,
  document: JsonRecord,
  seen = new Set<string>(),
  depth = 0,
): Record<string, unknown> {
  if (depth >= 64) {
    return {};
  }
  const resolved = resolveReference(value, document, seen);
  if (!isRecord(resolved)) {
    return {};
  }

  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.reduce<Record<string, unknown>>((merged, item) => {
      return mergeSchemas(
        merged,
        resolveJsonSchema(item, document, new Set(seen), depth + 1),
      );
    }, {});
  }

  const schema: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(resolved)) {
    if (key === "$ref") {
      continue;
    }

    if (key === "properties" && isRecord(rawValue)) {
      schema.properties = Object.fromEntries(
        Object.entries(rawValue).map(([propertyName, propertySchema]) => [
          propertyName,
          resolveJsonSchema(propertySchema, document, new Set(seen), depth + 1),
        ]),
      );
      continue;
    }

    if (key === "items") {
      schema.items = resolveJsonSchema(
        rawValue,
        document,
        new Set(seen),
        depth + 1,
      );
      continue;
    }

    if ((key === "oneOf" || key === "anyOf") && Array.isArray(rawValue)) {
      schema[key] = rawValue.map((item) =>
        resolveJsonSchema(item, document, new Set(seen), depth + 1)
      );
      continue;
    }

    schema[key] = rawValue;
  }

  return schema;
}

function resolveReference(
  value: unknown,
  document: JsonRecord,
  seen = new Set<string>(),
): unknown {
  let current = value;
  for (let depth = 0; depth < 64; depth += 1) {
    if (!isRecord(current) || typeof current.$ref !== "string") {
      return current;
    }
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) {
      return {};
    }
    seen.add(ref);
    current = readJsonPointer(document, ref.slice(2));
  }
  return {};
}

function readJsonPointer(document: JsonRecord, pointer: string) {
  return pointer.split("/").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) {
      return undefined;
    }

    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return current[key];
  }, document);
}

function mergeSchemas(left: Record<string, unknown>, right: Record<string, unknown>) {
  const merged = { ...left, ...right };
  if (isRecord(left.properties) || isRecord(right.properties)) {
    merged.properties = {
      ...(isRecord(left.properties) ? left.properties : {}),
      ...(isRecord(right.properties) ? right.properties : {}),
    };
  }
  if (Array.isArray(left.required) || Array.isArray(right.required)) {
    const leftRequired = Array.isArray(left.required) ? left.required.map(String) : [];
    const rightRequired = Array.isArray(right.required) ? right.required.map(String) : [];
    merged.required = [...new Set([...leftRequired, ...rightRequired])];
  }
  return merged;
}

export function inferOpenApiRiskLevel(
  method: OpenApiHttpMethod,
  operation: JsonRecord,
  defaultRiskLevel: ToolRiskLevel,
) {
  const explicitRisk = Number(operation["x-omni-risk-level"]);
  const remoteRisk = [0, 1, 2, 3].includes(explicitRisk)
    ? explicitRisk as ToolRiskLevel
    : 0;
  const methodFloor: ToolRiskLevel = SAFE_METHODS.has(method) ? 0 : 2;
  return Math.max(defaultRiskLevel, methodFloor, remoteRisk) as ToolRiskLevel;
}

function firstServerUrl(document: JsonRecord, specUrl?: string) {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = servers.map((server) => resolveReference(server, document)).find(isRecord);
  const url = firstServer && typeof firstServer.url === "string" ? firstServer.url : "";
  return normalizeBaseUrl(url, specUrl);
}

function normalizeBaseUrl(baseUrl: string, specUrl?: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("OpenAPI connector requires a base URL or a spec server URL.");
  }

  const resolvedUrl = specUrl ? new URL(trimmed, specUrl).toString() : new URL(trimmed).toString();
  return resolvedUrl.replace(/\/$/, "");
}

export function assertSafeOpenApiOperationPath(path: string) {
  if (!path.startsWith("/")) {
    throw new Error(`OpenAPI operation path must start with "/": ${path}`);
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error(`OpenAPI operation path contains invalid percent encoding: ${path}`);
  }
  if (
    path.startsWith("//") ||
    path.includes("\\") ||
    /%5c/i.test(path) ||
    /%25(?:2e|2f|5c)/i.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    decodedPath.startsWith("//") ||
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`OpenAPI operation path is not a safe relative path: ${path}`);
  }
  return path;
}

function normalizeOperationId(value: string) {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "operation";
}

function uniqueOperationId(operationId: string, seen: Map<string, number>) {
  const count = seen.get(operationId) || 0;
  seen.set(operationId, count + 1);
  return count ? `${operationId}_${count + 1}` : operationId;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
