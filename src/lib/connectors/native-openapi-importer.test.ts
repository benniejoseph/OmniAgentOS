import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { importOpenApiSpec, MAX_OPENAPI_SPEC_BYTES } from "./openapi-importer";
import { importNativeOpenapiSpec, loadNativeOpenapiSpec, NativeOpenapiImportError } from "./native-openapi-importer";
import type { OpenApiConnectorRecord } from "./openapi-types";

vi.mock("@/lib/security/network", () => ({ fetchPublicHttpUrl: vi.fn() }));
const fetchMock = vi.mocked(fetchPublicHttpUrl);
const connector: OpenApiConnectorRecord = {
  id: `native-openapi-${"1".repeat(64)}`, tenantId: "native-import-fixture", name: "Import fixture", baseUrl: "",
  authType: "none", status: "disabled", defaultRiskLevel: 1, approvalRequired: false, operationCount: 0,
  createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
};
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const body = (schema: unknown) => ({ requestBody: { required: true, content: { "application/json": { schema } } } });
const spec = (paths: Record<string, unknown> = { "/items": { get: { operationId: "list_items" } } }, rest: Record<string, unknown> = {}) => ({
  openapi: "3.1.0", info: { title: "Synthetic fixture", version: "1" }, servers: [{ url: "https://api.example.test/v1" }], paths, ...rest,
});
function parse(value: unknown, options: Partial<Parameters<typeof importNativeOpenapiSpec>[0]> = {}) {
  return importNativeOpenapiSpec({ connector, specText: typeof value === "string" ? value : JSON.stringify(value), deadlineAt: Date.now() + 45_000, ...options });
}
beforeEach(() => fetchMock.mockReset());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("complete bounded native OpenAPI parsing", () => {
  it("imports JSON and YAML without fetching and keeps every operation pending review", () => {
    const input = spec({ "/items": { get: { operationId: "list_items" }, post: { operationId: "create_item", ...body({ type: "object", additionalProperties: false, properties: { title: { type: "string" } } }) } } });
    const json = parse(input);
    expect(json.operations.map((operation) => [operation.method, operation.status, operation.riskLevel, operation.approvalRequired]))
      .toEqual([["GET", "pending_review", 1, false], ["POST", "pending_review", 2, true]]);
    expect(json.operations.every((operation) => operation.tenantId === connector.tenantId && operation.connectorId === connector.id)).toBe(true);
    const yaml = parse("openapi: 3.0.3\ninfo:\n  title: Fixture\n  version: '1'\nservers:\n  - url: https://api.example.test/v1\npaths:\n  /items:\n    get:\n      operationId: list_items\n");
    expect(yaml.operations.map((operation) => operation.id)).toEqual([json.operations[0].id]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expands supported internal schema references consistently for each operation", () => {
    const result = parse(spec({ "/items": { post: { ...body({ type: "object", properties: { first: schemaRef("Label"), second: schemaRef("Label") } }) } } },
      { components: { schemas: { Label: { type: "string", minLength: 1, maxLength: 40 } } } }));
    expect(JSON.stringify(result.operations[0].inputSchema)).not.toContain("$ref");
    expect(result.operations[0].inputSchema).toMatchObject({ properties: { body: { properties: {
      first: { type: "string", minLength: 1, maxLength: 40 }, second: { type: "string", minLength: 1, maxLength: 40 },
    } } } });
  });

  it("resolves relative servers from the spec URL and admits explicit routing overrides", () => {
    expect(parse(spec(undefined, { servers: [{ url: "../v1" }] }), { connector: { ...connector, specUrl: "https://spec.example.test/root/openapi.yaml" } }).baseUrl)
      .toBe("https://spec.example.test/v1");
    const routing = spec({ "/items": { servers: [{ url: "https://path.example.test" }], get: { servers: [{ url: "https://operation.example.test" }] } } },
      { servers: [{ url: "https://{region}.example.test", variables: { region: { default: "fixture" } } }] });
    expect(() => parse(routing)).toThrow(NativeOpenapiImportError);
    expect(parse(routing, { baseUrlOverride: "https://override.example.test/api" }).baseUrl).toBe("https://override.example.test/api");
    const swagger = { swagger: "2.0", info: { title: "Fixture", version: "1" }, host: "ignored.example.test", paths: { "/items": { get: {} } } };
    expect(() => parse(swagger)).toThrow(NativeOpenapiImportError);
    expect(parse(swagger, { baseUrlOverride: "https://override.example.test/api" }).operations).toHaveLength(1);
  });

  it.each(["?", "#", "?draft=fixture", "#fixture"])("refuses discarded base delimiters %s", (suffix) => {
    expect(() => parse(spec(undefined, { servers: [{ url: `https://api.example.test/v1${suffix}` }] }))).toThrow(NativeOpenapiImportError);
  });

  it.each(["/items?draft=fixture", "/items#fixture", "/../items", "/%2e%2e/items", "//other.example.test/items"])("refuses unsupported operation path %s", (path) => {
    expect(() => parse(spec({ [path]: { get: {} } }))).toThrow(NativeOpenapiImportError);
  });

  it.each([
    ["external reference", spec({ "/items": { post: body({ $ref: "https://schema.example.test/label.json" }) } })],
    ["unresolved reference", spec({ "/items": { post: body(schemaRef("Absent")) } })],
    ["reference cycle", spec({ "/items": { post: body(schemaRef("Loop")) } }, { components: { schemas: { Loop: { type: "object", properties: { next: schemaRef("Loop") } } } } })],
    ["ref siblings", spec({ "/items": { post: body({ ...schemaRef("Label"), maxLength: 2 }) } }, { components: { schemas: { Label: { type: "string" } } } })],
    ["unimported TRACE", spec({ "/items": { get: {}, trace: {} } })],
    ["false body schema", spec({ "/items": { post: body(false) } })],
    ["false nested schema", spec({ "/items": { post: body({ type: "object", properties: { denied: false } }) } })],
    ["missing body schema", spec({ "/items": { post: { requestBody: { content: { "application/json": {} } } } } })],
    ["allOf constraint merge", spec({ "/items": { post: body({ allOf: [{ type: "string" }, { type: "integer" }], maxLength: 1 }) } })],
    ["reference in copied keyword", spec({ "/items": { post: body({ type: "object", additionalProperties: schemaRef("Label") }) } }, { components: { schemas: { Label: { type: "string" } } } })],
  ])("rejects %s instead of weakening or omitting the input", (_label, value) => {
    expect(() => parse(value)).toThrow(NativeOpenapiImportError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects colliding normalized operation identities and duplicate YAML keys", () => {
    expect(() => parse(spec({ "/first": { get: { operationId: "same-id" } }, "/second": { get: { operationId: "same id" } } }))).toThrow(NativeOpenapiImportError);
    expect(() => parse("openapi: 3.1.0\npaths: {}\npaths: {}\n")).toThrow(NativeOpenapiImportError);
  });

  it("requires all operations to fit the 200-operation boundary instead of taking a prefix", () => {
    const paths = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`/item/${index}`, { get: { operationId: `item_${index}` } }]));
    expect(parse(spec(paths(200))).operations).toHaveLength(200);
    expect(() => parse(spec(paths(201)))).toThrow(NativeOpenapiImportError);
    expect(() => parse(spec({}))).toThrow(NativeOpenapiImportError);
  });

  it("bounds UTF-8 source, reference expansion, traversal depth and the attempt deadline", () => {
    expect(() => parse(spec(undefined, { "x-fixture": "é".repeat(MAX_OPENAPI_SPEC_BYTES / 2) }))).toThrow(NativeOpenapiImportError);
    const paths = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`/item/${index}`, { post: body(schemaRef("Large")) }]));
    expect(() => parse(spec(paths, { components: { schemas: { Large: { type: "string", description: "x".repeat(150_000) } } } }))).toThrow(NativeOpenapiImportError);
    let schema: unknown = { type: "string" };
    for (let index = 0; index < 50; index += 1) schema = { type: "object", properties: { nested: schema } };
    expect(() => parse(spec({ "/items": { post: body(schema) } }))).toThrow(NativeOpenapiImportError);
    expect(() => parse(spec(), { deadlineAt: Date.now() - 1 })).toThrow(NativeOpenapiImportError);
  });

  it("leaves the existing browser interpreter's cycle handling unchanged", () => {
    const input = spec({ "/items": { post: body(schemaRef("Loop")) } }, { components: { schemas: { Loop: { type: "object", properties: { next: schemaRef("Loop") } } } } });
    expect(() => parse(input)).toThrow(NativeOpenapiImportError);
    expect(importOpenApiSpec({ connector, specText: JSON.stringify(input) }).operations).toHaveLength(1);
  });
});

describe("one bounded native specification download", () => {
  it("uses the guarded fetch once with only Accept and no connector authentication", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(spec())));
    expect(await loadNativeOpenapiSpec("https://spec.example.test/spec.json?fixture=private", Date.now() + 45_000)).toContain("openapi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(Object.keys(options?.headers ?? {})).toEqual(["accept"]);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([302, 404, 503])("does not follow or retry status %s", async (status) => {
    fetchMock.mockResolvedValue(new Response("fixture", { status, headers: { location: "https://other.example.test/spec.json" } }));
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 45_000)).rejects.toBeInstanceOf(NativeOpenapiImportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves guarded network refusal without exposing the original error", async () => {
    fetchMock.mockRejectedValue(new Error("private fixture network diagnosis"));
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 45_000)).rejects.toThrow("This specification cannot be imported by the bounded native importer.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces both announced and streamed byte bounds and strict UTF-8", async () => {
    fetchMock.mockResolvedValueOnce(new Response("fixture", { headers: { "content-length": String(MAX_OPENAPI_SPEC_BYTES + 1) } }));
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 45_000)).rejects.toBeInstanceOf(NativeOpenapiImportError);
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_OPENAPI_SPEC_BYTES + 1)); }, cancel })));
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 45_000)).rejects.toBeInstanceOf(NativeOpenapiImportError);
    expect(cancel).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])));
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 45_000)).rejects.toBeInstanceOf(NativeOpenapiImportError);
  });

  it("aborts an expired download and cancels a late response without another fetch", async () => {
    vi.useFakeTimers();
    let resolve: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    const pending = loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() + 1000);
    const rejection = expect(pending).rejects.toBeInstanceOf(NativeOpenapiImportError);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(loadNativeOpenapiSpec("https://spec.example.test/spec.json", Date.now() - 1)).rejects.toBeInstanceOf(NativeOpenapiImportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
