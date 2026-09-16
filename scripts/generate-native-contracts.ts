import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  NATIVE_API_CONTRACT_ID,
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
  NATIVE_API_SUPPORTED_VERSIONS,
  nativeContractSchemas,
  nativeOperationsForVersion,
  type NativeOperation,
  type NativeQueryParameter,
} from "../src/lib/mobile/contracts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const frozenDocumentSha256ByVersion = Object.freeze({
  7: Object.freeze({
    "openapi.json": "5bd9b2d62d94caedee930a9b032ab55154a5ae3cddfa9f5295685cbd3fe5fee8",
    "events.schema.json": "54ad4d7e0a686efecd0b3a436ab16df640755c7c4da9b20f4f703cb45a835049",
    "fixtures.json": "f69fc5b08b1006e4943c4e5a38df63e91ac5ef3b4f7c325e873f98d64746edb0",
    "manifest.json": "ba176b99472920cd9a4ca0ca34770e43812cc1653d5d99ce3e94c3e26e416f41",
  }),
  8: Object.freeze({
    "openapi.json": "64ee18c3a5cf79fb7cd145897ccabaf45e9a7b23aca6510fb77cbab13923d7f7",
    "events.schema.json": "54ad4d7e0a686efecd0b3a436ab16df640755c7c4da9b20f4f703cb45a835049",
    "fixtures.json": "8c677a783d4004b3d947d9a6abfbbae3012a83a7efa034ba76d73047ad64d395",
    "manifest.json": "d5c41419fbd4ff6885519a349117e3d529fcb28207966bf0d9577bacdc4a3745",
  }),
});

const fixtures = Object.freeze({
  loginRequest: {
    email: "operator@example.test",
    password: "fixture-password",
    device: {
      id: "asael-fixture-device",
      name: "Asael on macOS",
      platform: "macos",
      appVersion: "1.0.0",
      buildNumber: 2,
      clientContractVersion: NATIVE_API_CURRENT_VERSION,
    },
  },
  refreshRequest: {
    refreshToken: "fixture-refresh-token-00000000000000000000",
    deviceId: "asael-fixture-device",
    client: {
      platform: "macos",
      appVersion: "1.0.0",
      buildNumber: 2,
      clientContractVersion: NATIVE_API_CURRENT_VERSION,
    },
  },
  conversationRequest: {
    message: "Summarize what needs my attention.",
    mode: "orchestrate",
    strategy: "auto",
    requestId: "native-fixture-request",
  },
  conversationEvents: [
    { type: "run", runId: "run-fixture", threadId: "thread-fixture" },
    { type: "status", label: "Working", detail: "Reviewing evidence." },
    { type: "delta", text: "Here is what needs attention." },
    { type: "waiting_approval", executionId: "execution-fixture", toolId: "calendar.event.create", message: "Approval is required." },
    { type: "done", response: "Here is what needs attention." },
  ],
});

void generate().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function generate() {
  const expected = new Map<string, string>();
  for (const [version, documents] of Object.entries(
    frozenDocumentSha256ByVersion,
  )) {
    await retainFrozenContract(
      expected,
      path.join(repositoryRoot, "public", "native-contracts", `v${version}`),
      documents,
    );
  }
  for (const version of NATIVE_API_SUPPORTED_VERSIONS) {
    const directory = path.join(repositoryRoot, "public", "native-contracts", `v${version}`);
    if (version === NATIVE_API_PREVIOUS_VERSION) {
      continue;
    }
    const operations = nativeOperationsForVersion(version);
    if (!operations) throw new Error(`Missing native operations for v${version}.`);
    const openapi = openApiDocument(version, operations);
    const events = schemaDocument("NativeConversationEvent");
    const versionFixtures = fixtures;
    const openapiText = stableJson(openapi);
    const eventsText = stableJson(events);
    const fixturesText = stableJson(versionFixtures);
    const manifest = {
      schemaVersion: 1,
      contractId: NATIVE_API_CONTRACT_ID,
      version,
      state: version === NATIVE_API_CURRENT_VERSION ? "current" : "previous",
      compatibility: {
        currentVersion: NATIVE_API_CURRENT_VERSION,
        previousVersion: NATIVE_API_PREVIOUS_VERSION,
        supportedVersions: [...NATIVE_API_SUPPORTED_VERSIONS],
      },
      documents: {
        openapi: { path: "openapi.json", sha256: sha256(openapiText) },
        events: { path: "events.schema.json", sha256: sha256(eventsText) },
        fixtures: { path: "fixtures.json", sha256: sha256(fixturesText) },
      },
    };
    expected.set(path.join(directory, "openapi.json"), openapiText);
    expected.set(path.join(directory, "events.schema.json"), eventsText);
    expected.set(path.join(directory, "fixtures.json"), fixturesText);
    expected.set(path.join(directory, "manifest.json"), stableJson(manifest));
  }
  expected.set(
    path.join(repositoryRoot, "apps", "flutter", "lib", "generated", "native_contract.g.dart"),
    renderDartContract(nativeOperationsForVersion(NATIVE_API_CURRENT_VERSION) || []),
  );

  if (checkOnly) {
    const drift: string[] = [];
    for (const [filename, content] of expected) {
      const current = await readFile(filename, "utf8").catch(() => "");
      if (current !== content) drift.push(path.relative(repositoryRoot, filename));
    }
    if (drift.length) {
      throw new Error(`Generated native contracts are stale: ${drift.join(", ")}`);
    }
    process.stdout.write("Native contract artifacts are current.\n");
    return;
  }

  for (const [filename, content] of expected) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, "utf8");
  }
  process.stdout.write(`Generated native contracts v${NATIVE_API_CURRENT_VERSION} and v${NATIVE_API_PREVIOUS_VERSION}.\n`);
}

async function retainFrozenContract(
  expected: Map<string, string>,
  directory: string,
  documents: Readonly<Record<string, string>>,
) {
  for (const [basename, expectedSha256] of Object.entries(
    documents,
  )) {
    const filename = path.join(directory, basename);
    const content = await readFile(filename, "utf8").catch(() => undefined);
    if (content === undefined) {
      throw new Error(`Missing frozen native contract: ${path.relative(repositoryRoot, filename)}`);
    }
    if (sha256(content) !== expectedSha256) {
      throw new Error(`Frozen native contract changed: ${path.relative(repositoryRoot, filename)}`);
    }
    expected.set(filename, content);
  }
}

function openApiDocument(version: number, operations: readonly NativeOperation[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const pathParameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
    }));
    const queryParameters = (operation.queryParameters || []).map((parameter) => ({
      name: parameter.name,
      in: "query",
      required: parameter.required || false,
      schema: openApiQueryParameterSchema(parameter),
    }));
    const parameters = [...pathParameters, ...queryParameters];
    const mediaType = operation.mediaType || "application/json";
    const requestBody = operation.requestSchema && operation.method !== "GET"
      ? {
          required: true,
          content: {
            [mediaType === "text/event-stream" ? "application/json" : mediaType]: {
              schema: ref(operation.requestSchema),
            },
          },
        }
      : undefined;
    paths[operation.path] ||= {};
    paths[operation.path][operation.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      tags: [operation.id.split(".")[0]],
      ...(operation.auth === "bearer" ? { security: [{ bearerAuth: [] }] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        "200": {
          description: "Successful response.",
          content: {
            [mediaType]: { schema: ref(operation.responseSchema) },
            ...(operation.binaryResponse
              ? {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                }
              : {}),
          },
        },
        "400": errorResponse(),
        "401": errorResponse(),
        "403": errorResponse(),
        "409": errorResponse(),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Asael native API",
      version: String(version),
      description: version === NATIVE_API_CURRENT_VERSION
        ? "Generated current native contract. Domain behavior remains in the authoritative server services used by web and native clients."
        : "Generated previous native contract retained for one compatibility rollout window.",
    },
    servers: [{ url: "https://asael.bennierichard.com" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
      },
      schemas: Object.fromEntries(schemaNamesForVersion(version).map((name) => [
        name,
        schemaDocument(name),
      ])),
    },
  };
}

function schemaNamesForVersion(version: number) {
  const names = Object.keys(nativeContractSchemas);
  return version === NATIVE_API_CURRENT_VERSION ? names : [];
}

function schemaDocument(name: string) {
  const schema = nativeContractSchemas[name as keyof typeof nativeContractSchemas];
  if (!schema) throw new Error(`Unknown native schema ${name}.`);
  const document = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const { $schema: _, ...component } = document;
  return component;
}

function errorResponse() {
  return {
    description: "Bounded error response.",
    content: { "application/json": { schema: ref("NativeErrorResponse") } },
  };
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function renderDartContract(operations: readonly NativeOperation[]) {
  const operationIds = operations
    .map((operation) => `    '${operation.id}',`)
    .join("\n");
  const paths = operations.map((operation) => {
    const name = dartName(operation.id);
    const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const queryParameters = operation.queryParameters || [];
    if (!parameters.length && !queryParameters.length) {
      return `  static const ${name} = '${operation.path}';`;
    }
    const positionalArgs = parameters.map((parameter) => `String ${parameter}`);
    const namedArgs = queryParameters.map(dartQueryParameterDeclaration);
    const args = [
      ...positionalArgs,
      ...(namedArgs.length ? [`{${namedArgs.join(", ")}}`] : []),
    ].join(", ");
    let rendered = operation.path;
    for (const parameter of parameters) {
      rendered = rendered.replace(`{${parameter}}`, `\${Uri.encodeComponent(${parameter})}`);
    }
    if (!queryParameters.length) {
      return `  static String ${name}(${args}) => '${rendered}';`;
    }
    const queryEntries = queryParameters
      .map(dartQueryParameterEntry)
      .join("\n");
    return `  static String ${name}(${args}) {
    final path = '${rendered}';
    final query = <String, String>{
${queryEntries}
    };
    if (query.isEmpty) return path;
    final encoded = query.entries
        .map((entry) => '\${Uri.encodeQueryComponent(entry.key)}=\${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return '\$path?\$encoded';
  }`;
  }).join("\n");
  const eventTypes = agentEventSchemasForDart().map((value) => `    '${value}',`).join("\n");
  return `// GENERATED FILE. DO NOT EDIT.\n// Run npm run generate:native-contracts from the repository root.\n\nabstract final class NativeContract {\n  static const id = '${NATIVE_API_CONTRACT_ID}';\n  static const currentVersion = ${NATIVE_API_CURRENT_VERSION};\n  static const previousVersion = ${NATIVE_API_PREVIOUS_VERSION};\n  static const supportedVersions = <int>[${NATIVE_API_SUPPORTED_VERSIONS.join(", ")}];\n  static const discoveryPath = '/api/mobile/contracts';\n  static const operationIds = <String>{\n${operationIds}\n  };\n\n  static bool supports(int version) => supportedVersions.contains(version);\n  static bool supportsOperation(String operationId) => operationIds.contains(operationId);\n\n  static void verifyBootstrap(Map<String, dynamic> response) {\n    final api = response['api'];\n    if (api is! Map || api['nativeContract'] == null) {\n      // The immediately previous server did not advertise discovery metadata.\n      return;\n    }\n    final contract = api['nativeContract'];\n    if (contract is! Map || contract['id'] != id) {\n      throw const FormatException('The service returned a different native contract.');\n    }\n    final versions = contract['supportedVersions'];\n    if (versions is! List || !versions.contains(currentVersion)) {\n      throw const FormatException('This native client contract is not supported by the service.');\n    }\n  }\n}\n\nabstract final class NativePaths {\n${paths}\n}\n\nabstract final class NativeConversationEvents {\n  static const supportedTypes = <String>{\n${eventTypes}\n  };\n\n  static Map<String, dynamic> parse(String eventName, Object? value) {\n    if (value is! Map) {\n      throw const FormatException('Native event payload must be an object.');\n    }\n    final event = Map<String, dynamic>.from(value);\n    final type = event['type'];\n    if (type is! String || type != eventName || !supportedTypes.contains(type)) {\n      throw const FormatException('Native event discriminant is invalid.');\n    }\n    return event;\n  }\n}\n`;
}

function agentEventSchemasForDart() {
  return [
    "run", "delegated", "clarification", "status", "harness", "delta",
    "memory", "model", "council_member", "council_verdict", "tool",
    "waiting_approval", "budget_exhausted", "done", "canceled", "error",
  ];
}

function openApiQueryParameterSchema(parameter: NativeQueryParameter) {
  if (parameter.type === "flag") {
    return { type: "string", enum: ["1"] };
  }
  if (parameter.type === "integer") {
    return {
      type: "integer",
      ...(parameter.minimum !== undefined ? { minimum: parameter.minimum } : {}),
      ...(parameter.maximum !== undefined ? { maximum: parameter.maximum } : {}),
    };
  }
  return {
    type: "string",
    ...(parameter.minLength !== undefined ? { minLength: parameter.minLength } : {}),
    ...(parameter.maxLength !== undefined ? { maxLength: parameter.maxLength } : {}),
  };
}

function dartQueryParameterDeclaration(parameter: NativeQueryParameter) {
  if (parameter.type === "flag") {
    return parameter.required
      ? `required bool ${parameter.name}`
      : `bool ${parameter.name} = false`;
  }
  const type = parameter.type === "integer" ? "int" : "String";
  return parameter.required
    ? `required ${type} ${parameter.name}`
    : `${type}? ${parameter.name}`;
}

function dartQueryParameterEntry(parameter: NativeQueryParameter) {
  if (parameter.type === "string" && !parameter.required) {
    return `      '${parameter.name}': ?${parameter.name},`;
  }
  const condition = parameter.type === "flag"
    ? parameter.name
    : parameter.required
      ? "true"
      : `${parameter.name} != null`;
  const value = parameter.type === "flag"
    ? "'1'"
    : parameter.type === "integer"
      ? `${parameter.name}.toString()`
      : parameter.name;
  return condition === "true"
    ? `      '${parameter.name}': ${value},`
    : `      if (${condition}) '${parameter.name}': ${value},`;
}

function dartName(id: string) {
  return id.replace(/\.([a-z])/g, (_, character: string) => character.toUpperCase());
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
