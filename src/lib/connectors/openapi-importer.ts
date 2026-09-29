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
/**
 * How much one import may do, in approximate characters of JSON. Each use of
 * a shared schema is copied into the operation that uses it, so without a
 * limit a small spec whose references fan out expands without bound.
 */
export const MAX_OPENAPI_IMPORT_BUDGET = 8_000_000;

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
  const budget = new ImportBudget(document);
  const baseUrl = normalizeBaseUrl(
    baseUrlOverride || connector.baseUrl || firstServerUrl(document, budget, connector.specUrl),
    connector.specUrl,
  );
  const info = parseObject(document.info) || {};
  budget.copy(info);
  const operations = extractOperations({
    connector: { ...connector, baseUrl },
    document,
    budget,
  });

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

/**
 * What one import may still do. Following a `$ref`, reading a list entry,
 * and copying a value into an imported operation each cost something, so a
 * spec whose references fan out is refused rather than expanded.
 */
class ImportBudget {
  private remaining = MAX_OPENAPI_IMPORT_BUDGET;
  private readonly sizes = new WeakMap<object, number>();

  constructor(document: JsonRecord) {
    // One walk over the whole spec notes each value's size, and refuses a
    // value that contains itself, which YAML anchors can build.
    approximateJsonSize(document, this.sizes);
  }

  spend(amount: number) {
    this.remaining -= amount;
    if (this.remaining < 0) {
      throw new Error(
        "OpenAPI spec expands past the importer limit once its references are followed and copied into each operation.",
      );
    }
  }

  copy(value: unknown) {
    this.spend(approximateJsonSize(value, this.sizes));
  }
}

type SizeFrame = { value: object; entries: [string, unknown][]; next: number; size: number };

/**
 * The approximate length of a value's JSON text, found without building it.
 * Each object's size is kept in `sizes`, so a value that YAML anchors share
 * is walked once however often it is copied.
 */
function approximateJsonSize(value: unknown, sizes: WeakMap<object, number>): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return value.length + 2;
  }
  if (!value || typeof value !== "object") {
    return String(value).length;
  }
  const known = sizes.get(value);
  if (known !== undefined) {
    return known;
  }

  // Walk with an explicit stack, so a deeply nested value cannot overflow it.
  const onPath = new WeakSet<object>([value]);
  const stack: SizeFrame[] = [{ value, entries: Object.entries(value), next: 0, size: 2 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.next === frame.entries.length) {
      stack.pop();
      onPath.delete(frame.value);
      sizes.set(frame.value, frame.size);
      if (stack.length) {
        stack[stack.length - 1].size += frame.size;
      }
      continue;
    }

    const [key, child] = frame.entries[frame.next];
    frame.next += 1;
    frame.size += Array.isArray(frame.value) ? 1 : key.length + 4;
    if (!child || typeof child !== "object") {
      frame.size += approximateJsonSize(child, sizes);
      continue;
    }
    if (onPath.has(child)) {
      throw new Error("OpenAPI spec contains a value that refers to itself.");
    }
    const childSize = sizes.get(child);
    if (childSize !== undefined) {
      frame.size += childSize;
      continue;
    }
    onPath.add(child);
    stack.push({ value: child, entries: Object.entries(child), next: 0, size: 2 });
  }
  return sizes.get(value) ?? 0;
}

function extractOperations({
  connector,
  document,
  budget,
}: {
  connector: OpenApiConnectorRecord;
  document: JsonRecord;
  budget: ImportBudget;
}) {
  const paths = document.paths as JsonRecord;
  const operations: OpenApiOperationRecord[] = [];
  const operationIds = new Map<string, number>();
  const now = new Date().toISOString();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    assertSafeOpenApiOperationPath(path);
    const pathItem = resolveReference(rawPathItem, document, budget);
    if (!isRecord(pathItem)) {
      continue;
    }

    const pathParameters = readParameterList(pathItem.parameters, document, budget);

    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      const operation = resolveReference(rawOperation, document, budget);
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
        ...readParameterList(operation.parameters, document, budget),
      ];
      const requestBody = readRequestBody(operation.requestBody, document, budget);

      const imported: OpenApiOperationRecord = {
        id: createOpenApiToolId(connector.id, operationId),
        connectorId: connector.id,
        connectorName: connector.name,
        operationId,
        method: normalizedMethod,
        path,
        summary: readString(operation.summary),
        description: readString(operation.description),
        inputSchema: createInputSchema({ parameters, requestBody, document, budget }),
        requestContentType: requestBody?.contentType,
        responseContentTypes: readResponseContentTypes(operation.responses, document, budget),
        riskLevel,
        approvalRequired: connector.approvalRequired || riskLevel >= 2,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      // The input schema was charged as it was built.
      budget.copy({ ...imported, inputSchema: undefined });
      operations.push(imported);

      if (operations.length >= MAX_IMPORTED_OPERATIONS) {
        return operations;
      }
    }
  }

  return operations;
}

function readParameterList(value: unknown, document: JsonRecord, budget: ImportBudget) {
  if (!Array.isArray(value)) {
    return [];
  }

  budget.spend(value.length);
  return value
    .map((parameter) => resolveReference(parameter, document, budget))
    .filter(isRecord)
    .filter((parameter) => typeof parameter.name === "string" && typeof parameter.in === "string");
}

function readRequestBody(value: unknown, document: JsonRecord, budget: ImportBudget) {
  const requestBody = resolveReference(value, document, budget);
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return undefined;
  }

  const contentTypes = Object.keys(requestBody.content);
  const contentType =
    contentTypes.find((item) => item.includes("json")) ||
    contentTypes.find((item) => item.includes("form")) ||
    contentTypes[0];
  const mediaType = contentType
    ? resolveReference(requestBody.content[contentType], document, budget)
    : undefined;
  const schema = isRecord(mediaType) ? resolveJsonSchema(mediaType.schema, document, budget) : {};

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
  budget,
}: {
  parameters: JsonRecord[];
  requestBody?: { contentType?: string; required: boolean; schema: Record<string, unknown> };
  document: JsonRecord;
  budget: ImportBudget;
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
    const description = readString(parameter.description);
    budget.spend(name.length + 4);
    budget.copy(description);
    const schema = resolveJsonSchema(parameter.schema, document, budget);
    groups[location].properties[name] = {
      ...schema,
      description: description || readString(schema.description),
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

function readResponseContentTypes(value: unknown, document: JsonRecord, budget: ImportBudget) {
  const responses = resolveReference(value, document, budget);
  if (!isRecord(responses)) {
    return [];
  }

  const contentTypes = new Set<string>();
  for (const response of Object.values(responses)) {
    const resolvedResponse = resolveReference(response, document, budget);
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
  budget: ImportBudget,
  seen = new Set<string>(),
  depth = 0,
): Record<string, unknown> {
  budget.spend(2);
  if (depth >= 64) {
    return {};
  }
  // `seen` holds the references on the path to this schema, so a reference
  // back to one of them is cut; each call removes the ones it added.
  const added: string[] = [];
  try {
    const resolved = resolveReference(value, document, budget, seen, added);
    if (!isRecord(resolved)) {
      return {};
    }

    if (Array.isArray(resolved.allOf)) {
      return mergeSchemas(resolved.allOf.map((item) =>
        resolveJsonSchema(item, document, budget, seen, depth + 1)
      ));
    }

    const schema: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(resolved)) {
      if (key === "$ref") {
        continue;
      }
      budget.spend(key.length + 4);

      if (key === "properties" && isRecord(rawValue)) {
        schema.properties = Object.fromEntries(
          Object.entries(rawValue).map(([propertyName, propertySchema]) => {
            budget.spend(propertyName.length + 4);
            return [
              propertyName,
              resolveJsonSchema(propertySchema, document, budget, seen, depth + 1),
            ];
          }),
        );
        continue;
      }

      if (key === "items") {
        schema.items = resolveJsonSchema(rawValue, document, budget, seen, depth + 1);
        continue;
      }

      if ((key === "oneOf" || key === "anyOf") && Array.isArray(rawValue)) {
        schema[key] = rawValue.map((item) =>
          resolveJsonSchema(item, document, budget, seen, depth + 1)
        );
        continue;
      }

      budget.copy(rawValue);
      schema[key] = rawValue;
    }

    return schema;
  } finally {
    for (const ref of added) {
      seen.delete(ref);
    }
  }
}

function resolveReference(
  value: unknown,
  document: JsonRecord,
  budget: ImportBudget,
  seen = new Set<string>(),
  added: string[] = [],
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
    budget.spend(ref.length);
    seen.add(ref);
    added.push(ref);
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

/**
 * Merge `allOf` parts in one pass: later keys win, and `properties` and
 * `required` are combined, without copying what was merged so far per part.
 */
function mergeSchemas(parts: Record<string, unknown>[]) {
  const merged: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  let hasProperties = false;
  let hasRequired = false;
  for (const part of parts) {
    Object.assign(merged, part);
    if (isRecord(part.properties)) {
      hasProperties = true;
      Object.assign(properties, part.properties);
    }
    if (Array.isArray(part.required)) {
      hasRequired = true;
      for (const name of part.required) {
        required.add(String(name));
      }
    }
  }
  if (hasProperties) {
    merged.properties = properties;
  }
  if (hasRequired) {
    merged.required = [...required];
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

function firstServerUrl(document: JsonRecord, budget: ImportBudget, specUrl?: string) {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = servers
    .map((server) => resolveReference(server, document, budget))
    .find(isRecord);
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
