import { parse as parseYaml } from "yaml";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { assertSafeOpenApiOperationPath, importOpenApiSpec, MAX_OPENAPI_SPEC_BYTES } from "./openapi-importer";
import type { OpenApiConnectorRecord } from "./openapi-types";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
export class NativeOpenapiImportError extends Error {
  constructor(readonly reason: "timeout" | "fetch_failed" | "unsupported_spec" | "bounds_exceeded") {
    super("This specification cannot be imported by the bounded native importer. Use the browser for other specifications.");
  }
}
export function checkNativeOpenapiDeadline(deadlineAt: number) {
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw new NativeOpenapiImportError("timeout");
}
export async function withNativeOpenapiDeadline<T>(work: Promise<T>, deadlineAt: number, abort?: AbortController): Promise<T> {
  checkNativeOpenapiDeadline(deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort?.abort(); reject(new NativeOpenapiImportError("timeout")); }, Math.max(1, deadlineAt - Date.now()));
    })]);
    checkNativeOpenapiDeadline(deadlineAt);
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** Exactly one unauthenticated spec GET, with guarded DNS/redirect policy. No
 * connector headers, environment values or provider operations reach this seam. */
export async function loadNativeOpenapiSpec(specUrl: string, deadlineAt: number): Promise<string> {
  checkNativeOpenapiDeadline(deadlineAt);
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    const fetch = fetchPublicHttpUrl(specUrl, { method: "GET", redirect: "manual", credentials: "omit",
      headers: { accept: "application/json, application/yaml, text/yaml, text/plain" }, signal: abort.signal }, "OpenAPI spec URL");
    // DNS is not cancelable; an eventual fetch receives the already-aborted
    // signal. A late response is canceled and can never finalize preparation.
    void fetch.then((response) => { if (abort.signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
    const response = await withNativeOpenapiDeadline(fetch, deadlineAt, abort);
    if (!response.ok || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new NativeOpenapiImportError("fetch_failed");
    }
    if (Number(response.headers.get("content-length")) > MAX_OPENAPI_SPEC_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new NativeOpenapiImportError("bounds_exceeded");
    }
    if (!response.body) throw new NativeOpenapiImportError("unsupported_spec");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const next = await withNativeOpenapiDeadline(reader.read(), deadlineAt, abort);
      if (next.done) { complete = true; break; }
      total += next.value.byteLength;
      if (total > MAX_OPENAPI_SPEC_BYTES) throw new NativeOpenapiImportError("bounds_exceeded");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    checkNativeOpenapiDeadline(deadlineAt);
    return text;
  } catch (error) {
    if (error instanceof NativeOpenapiImportError) throw error;
    throw new NativeOpenapiImportError(Date.now() >= deadlineAt ? "timeout" : "fetch_failed");
  } finally {
    abort.abort();
    if (!complete) void reader?.cancel().catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* A canceled pending read owns its final cleanup. */ }
  }
}

/** Native-only preflight rejects every reference/routing case that the legacy
 * importer would weaken or truncate. Browser parsing and its limits stay exact. */
export function importNativeOpenapiSpec(input: { connector: OpenApiConnectorRecord; specText: string; baseUrlOverride?: string; deadlineAt: number }) {
  checkNativeOpenapiDeadline(input.deadlineAt);
  if (Buffer.byteLength(input.specText, "utf8") > MAX_OPENAPI_SPEC_BYTES) throw new NativeOpenapiImportError("bounds_exceeded");
  let document: unknown;
  try { document = parseYaml(input.specText, { maxAliasCount: 50, strict: true, uniqueKeys: true }); }
  catch { throw new NativeOpenapiImportError("unsupported_spec"); }
  checkNativeOpenapiDeadline(input.deadlineAt);
  if (!record(document) || !record(document.paths) || !(typeof document.openapi === "string" && /^3\.(0|1)\./.test(document.openapi) || document.swagger === "2.0")) {
    throw new NativeOpenapiImportError("unsupported_spec");
  }
  let budget = 8_000_000;
  const spend = (n = 1) => { checkNativeOpenapiDeadline(input.deadlineAt); if ((budget -= n) < 0) throw new NativeOpenapiImportError("bounds_exceeded"); };
  const pointer = (ref: string): unknown => {
    if (!ref.startsWith("#/") || /~(?:[^01]|$)/.test(ref)) throw new NativeOpenapiImportError("unsupported_spec");
    let current: unknown = document;
    for (const segment of ref.slice(2).split("/")) {
      spend(segment.length + 1); const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!record(current) || !Object.hasOwn(current, key)) throw new NativeOpenapiImportError("unsupported_spec");
      current = current[key];
    }
    if (!record(current)) throw new NativeOpenapiImportError("unsupported_spec");
    return current;
  };
  const walk = (value: unknown, refs: Set<string>, objects: Set<object>, depth: number): void => {
    spend();
    if (depth >= 48) throw new NativeOpenapiImportError("unsupported_spec");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new NativeOpenapiImportError("unsupported_spec"); return; }
    if (typeof value === "string") { spend(value.length); return; }
    if (!value || typeof value !== "object" || objects.has(value)) throw new NativeOpenapiImportError("unsupported_spec");
    const nextObjects = new Set(objects).add(value);
    if (record(value) && Object.hasOwn(value, "$ref")) {
      if (typeof value.$ref !== "string" || refs.has(value.$ref) || Object.keys(value).length !== 1) throw new NativeOpenapiImportError("unsupported_spec");
      walk(pointer(value.$ref), new Set(refs).add(value.$ref), nextObjects, depth + 1);
    }
    for (const [key, child] of Object.entries(value)) { spend(key.length); if (key !== "$ref") walk(child, refs, nextObjects, depth + 1); }
  };
  walk(document, new Set(), new Set(), 0);
  const resolve = (value: unknown): unknown => {
    let current = value;
    for (let depth = 0; record(current) && typeof current.$ref === "string"; depth += 1) {
      spend(); if (depth >= 48) throw new NativeOpenapiImportError("unsupported_spec"); current = pointer(current.$ref);
    }
    return current;
  };
  const containsReference = (value: unknown): boolean => {
    spend();
    return Boolean(value && typeof value === "object" && (record(value) && Object.hasOwn(value, "$ref") ||
      Object.values(value).some(containsReference)));
  };
  const schema = (raw: unknown, depth = 0): void => {
    spend();
    const value = resolve(raw);
    if (!record(value) || depth >= 48 || Object.hasOwn(value, "allOf")) throw new NativeOpenapiImportError("unsupported_spec");
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties") {
        if (!record(child)) throw new NativeOpenapiImportError("unsupported_spec");
        for (const property of Object.values(child)) schema(property, depth + 1);
      } else if (key === "items") schema(child, depth + 1);
      else if (key === "oneOf" || key === "anyOf") {
        if (!Array.isArray(child) || !child.length) throw new NativeOpenapiImportError("unsupported_spec");
        for (const branch of child) schema(branch, depth + 1);
      } else if (containsReference(child)) {
        // These keywords are copied verbatim by the ordinary importer. A ref
        // here would point back into a document absent from the emitted schema.
        throw new NativeOpenapiImportError("unsupported_spec");
      }
    }
  };
  if (!input.baseUrlOverride && (document.swagger === "2.0" || document.host !== undefined || document.basePath !== undefined || document.schemes !== undefined)) {
    throw new NativeOpenapiImportError("unsupported_spec");
  }
  const servers = Array.isArray(document.servers) ? document.servers : [];
  if (!input.baseUrlOverride && servers.some((item) => { const server = resolve(item); return !record(server) || typeof server.url !== "string" || /[{}]/.test(server.url) || server.variables !== undefined; })) {
    throw new NativeOpenapiImportError("unsupported_spec");
  }
  const identities = new Set<string>(); let count = 0;
  for (const [path, raw] of Object.entries(document.paths)) {
    spend(path.length);
    try { assertSafeOpenApiOperationPath(path); } catch { throw new NativeOpenapiImportError("unsupported_spec"); }
    if (/[?#]/.test(path)) throw new NativeOpenapiImportError("unsupported_spec");
    const pathItem = resolve(raw);
    if (!record(pathItem) || !input.baseUrlOverride && pathItem.servers !== undefined) throw new NativeOpenapiImportError("unsupported_spec");
    if (Object.keys(pathItem).some((key) => ![...METHODS, "parameters", "servers", "summary", "description"].includes(key) && !key.startsWith("x-"))) {
      throw new NativeOpenapiImportError("unsupported_spec");
    }
    for (const method of METHODS) {
      if (!Object.hasOwn(pathItem, method)) continue;
      const operation = resolve(pathItem[method]);
      if (!record(operation) || !input.baseUrlOverride && operation.servers !== undefined) throw new NativeOpenapiImportError("unsupported_spec");
      const id = String(operation.operationId || `${method}_${path}`).trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "operation";
      if (identities.has(id)) throw new NativeOpenapiImportError("unsupported_spec");
      identities.add(id); count += 1;
      if (count > 200) throw new NativeOpenapiImportError("bounds_exceeded");
      const parameterSlots = new Set<string>();
      for (const parameters of [pathItem.parameters, operation.parameters]) {
        if (parameters !== undefined && !Array.isArray(parameters)) throw new NativeOpenapiImportError("unsupported_spec");
        for (const rawParameter of Array.isArray(parameters) ? parameters : []) {
          const parameter = resolve(rawParameter);
          if (!record(parameter) || typeof parameter.name !== "string" || !["path", "query", "header"].includes(String(parameter.in)) ||
            parameter.content !== undefined || parameter.style !== undefined || parameter.explode !== undefined) {
            throw new NativeOpenapiImportError("unsupported_spec");
          }
          const slot = `${parameter.in}:${parameter.name}`;
          if (parameterSlots.has(slot)) throw new NativeOpenapiImportError("unsupported_spec");
          parameterSlots.add(slot); schema(parameter.schema);
        }
      }
      if (operation.requestBody !== undefined) {
        const body = resolve(operation.requestBody);
        if (!record(body) || !record(body.content) || Object.keys(body.content).length !== 1) throw new NativeOpenapiImportError("unsupported_spec");
        for (const rawMedia of Object.values(body.content)) {
          const media = resolve(rawMedia);
          if (!record(media) || media.encoding !== undefined) throw new NativeOpenapiImportError("unsupported_spec");
          schema(media.schema);
        }
      }
    }
  }
  if (!count) throw new NativeOpenapiImportError("unsupported_spec");
  let result: ReturnType<typeof importOpenApiSpec>;
  try { result = importOpenApiSpec(input); } catch { throw new NativeOpenapiImportError("unsupported_spec"); }
  checkNativeOpenapiDeadline(input.deadlineAt);
  const base = new URL(result.baseUrl);
  if (/[?#{}]/.test(result.baseUrl) || base.username || base.password || !["https:", "http:"].includes(base.protocol) || result.operations.length !== count ||
    new Set(result.operations.map((operation) => operation.id)).size !== count) throw new NativeOpenapiImportError("unsupported_spec");
  const operations = result.operations.map((operation) => ({ ...operation, tenantId: input.connector.tenantId, status: "pending_review" as const }));
  return { ...result, operations };
}
