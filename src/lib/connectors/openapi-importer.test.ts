import { describe, expect, it } from "vitest";
import { importOpenApiSpec } from "@/lib/connectors/openapi-importer";
import type { OpenApiConnectorRecord } from "@/lib/connectors/openapi-types";

const connector: OpenApiConnectorRecord = {
  id: "connector-1",
  name: "Example",
  baseUrl: "https://api.example.com",
  authType: "none",
  status: "active",
  defaultRiskLevel: 0,
  approvalRequired: false,
  operationCount: 0,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};
const PAST_BUDGET = /expands past the importer limit/;
// 100 copies of a part this long go past the import budget; 20 fit.
const LONG = "x".repeat(100_000);

function importSpec(spec: unknown) {
  return importOpenApiSpec({
    connector,
    specText: typeof spec === "string" ? spec : JSON.stringify(spec),
  });
}

function spec(paths: Record<string, unknown>, components: Record<string, unknown> = {}) {
  return { openapi: "3.1.0", info: { title: "Example", version: "1" }, paths, components };
}

function eachPath(uses: number, pathItem: unknown) {
  return Object.fromEntries(
    Array.from({ length: uses }, (_, index) => [`/items/${index}`, pathItem]),
  );
}

function jsonBody(schema: unknown) {
  return { requestBody: { content: { "application/json": { schema } } } };
}

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

describe("OpenAPI import", () => {
  it("copies each use of a shared schema in full and cuts a reference back to itself", () => {
    const { operations } = importSpec(spec({
      "/pairs": {
        post: {
          operationId: "createPair",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaRef("Pair") } },
          },
        },
        put: {
          operationId: "tagPair",
          parameters: [{ $ref: "#/components/parameters/Label" }],
          ...jsonBody(schemaRef("Tagged")),
        },
      },
    }, {
      parameters: {
        Label: { name: "label", in: "query", required: true, schema: schemaRef("Name") },
      },
      schemas: {
        Name: { type: "string", maxLength: 40 },
        Pair: {
          type: "object",
          properties: { first: schemaRef("Name"), second: schemaRef("Name"), node: schemaRef("Node") },
          required: ["first"],
        },
        Node: {
          type: "object",
          properties: {
            label: schemaRef("Name"),
            children: { type: "array", items: schemaRef("Node") },
          },
        },
        Base: { type: "object", properties: { id: schemaRef("Name") }, required: ["id"] },
        Tagged: {
          allOf: [
            schemaRef("Base"),
            { properties: { tag: schemaRef("Name") }, required: ["tag", "id"] },
          ],
        },
      },
    }));

    const name = { type: "string", maxLength: 40 };
    expect(operations.map((operation) => [operation.operationId, operation.inputSchema])).toEqual([
      ["createPair", {
        type: "object",
        additionalProperties: false,
        properties: {
          body: {
            type: "object",
            properties: {
              first: name,
              second: name,
              node: {
                type: "object",
                properties: { label: name, children: { type: "array", items: {} } },
              },
            },
            required: ["first"],
          },
        },
        required: ["body"],
      }],
      ["tagPair", {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "object",
            additionalProperties: false,
            properties: { label: name },
            required: ["label"],
          },
          body: {
            type: "object",
            properties: { id: name, tag: name },
            required: ["id", "tag"],
          },
        },
        required: ["query"],
      }],
    ]);
  });

  it("refuses references that fan out past the import budget", () => {
    // Each schema uses the next one twice, so 19 of them expand to 2^19 copies.
    const schemas: Record<string, unknown> = { S19: { type: "string" } };
    for (let level = 0; level < 19; level += 1) {
      const next = schemaRef(`S${level + 1}`);
      schemas[`S${level}`] = { type: "object", properties: { a: next, b: next } };
    }

    expect(() => importSpec(spec(
      { "/fan": { post: jsonBody(schemaRef("S0")) } },
      { schemas },
    ))).toThrow(PAST_BUDGET);
  });

  it("refuses a YAML spec with a value that contains itself", () => {
    const yaml = [
      "openapi: 3.0.3",
      "info: {title: Loop, version: '1'}",
      "paths:",
      "  /loop:",
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema: &node",
      "              type: object",
      "              properties:",
      "                left: *node",
      "                right: *node",
    ].join("\n");

    expect(() => importSpec(yaml)).toThrow("OpenAPI spec contains a value that refers to itself.");
  });

  const longPointer = "p".repeat(5_000);
  it.each<[string, (uses: number) => unknown]>([
    ["a shared schema's example", (uses) => spec(
      eachPath(uses, { post: jsonBody(schemaRef("Shared")) }),
      { schemas: { Shared: { type: "object", example: { [LONG]: true } } } },
    )],
    ["a shared schema's keyword", (uses) => spec(
      eachPath(uses, { post: jsonBody(schemaRef("Shared")) }),
      { schemas: { Shared: { type: "string", [`x-${LONG}`]: true } } },
    )],
    ["a shared schema's property name", (uses) => spec(
      eachPath(uses, { post: jsonBody(schemaRef("Shared")) }),
      { schemas: { Shared: { type: "object", properties: { [LONG]: { type: "string" } } } } },
    )],
    ["a shared schema's alternatives", (uses) => spec(
      eachPath(uses, { post: jsonBody(schemaRef("Shared")) }),
      { schemas: { Shared: { oneOf: Array.from({ length: 50_000 }, () => ({})) } } },
    )],
    ["a shared parameter's name", (uses) => spec(
      eachPath(uses, { post: { parameters: [{ $ref: "#/components/parameters/Shared" }] } }),
      { parameters: { Shared: { name: LONG, in: "query", schema: { type: "string" } } } },
    )],
    ["a shared parameter's description", (uses) => spec(
      eachPath(uses, { post: { parameters: [{ $ref: "#/components/parameters/Shared" }] } }),
      { parameters: { Shared: { name: "q", in: "query", description: LONG } } },
    )],
    ["a shared operation's description", (uses) => spec(
      eachPath(uses, { post: { $ref: "#/components/x-operations/Shared" } }),
      { "x-operations": { Shared: { description: LONG } } },
    )],
    ["a reference with a long pointer", (uses) => spec(
      eachPath(uses, { post: jsonBody(schemaRef("Shared")) }),
      {
        schemas: {
          [longPointer]: { type: "string" },
          Shared: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [`f${index}`, schemaRef(longPointer)]),
            ),
          },
        },
      },
    )],
    ["a path item's parameter list", (uses) => spec(
      { "/ok": { get: {} }, ...eachPath(uses, { $ref: "#/components/x-path-items/Wide" }) },
      { "x-path-items": { Wide: { parameters: Array.from({ length: 100_000 }, () => 0) } } },
    )],
  ])("charges %s each time it is used", (_, build) => {
    expect(importSpec(build(20)).operations.length).toBeGreaterThan(0);
    expect(() => importSpec(build(100))).toThrow(PAST_BUDGET);
  });

  it("charges the spec info for each place YAML anchors copy into it", () => {
    const yaml = (copies: number) => [
      "openapi: 3.0.3",
      `x-note: &note {text: ${LONG}}`,
      "info:",
      "  title: Notes",
      "  version: '1'",
      `  x-notes: [${Array.from({ length: copies }, () => "*note").join(", ")}]`,
      "paths:",
      "  /ok: {get: {}}",
    ].join("\n");

    expect(importSpec(yaml(20)).info).toMatchObject({ title: "Notes" });
    expect(() => importSpec(yaml(90))).toThrow(PAST_BUDGET);
  });
});
