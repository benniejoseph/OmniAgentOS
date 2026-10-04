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
// The previous contract and the one archive before it, byte for byte. When a
// new contract ships, the oldest entry goes, and its directory with it.
const frozenDocumentSha256ByVersion = Object.freeze({
  33: Object.freeze({
    "openapi.json": "10be81a8dc2a713d4f85ae84a5585d5a899905f4331953b74dbedff963712aee", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "771a2b311c5a62d1af5010b1afc03228c41b282a8a84126329ae5bc8dc3276d9", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "292b6e6681f5046246afb440b556d4f08196d50e8377ef1cbd27eb5480483994", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "9ea3092df3d97eb6cc8aa72fb7f34f82b3ebeb4cdd3b8e00af38308faafb8e2f", // gitleaks:allow -- public artifact integrity digest
  }),
  34: Object.freeze({
    "openapi.json": "9d9c35c0085c9f1d5473ce26e0d77d86e5188b8c33ab7061308eb3c7750d62fe", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "771a2b311c5a62d1af5010b1afc03228c41b282a8a84126329ae5bc8dc3276d9", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "081a006740ef7603fd13e783317cb009e52c6e288b35dda4958dce3dc174e2cf", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "3079eb94d3b21c75feffc715b8bc445090fdb02458681ab06a78bfc6257422e5", // gitleaks:allow -- public artifact integrity digest
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
    agentId: "agent-fixture",
    modelSelection: {
      schemaVersion: 1,
      assignmentId: "assignment-fixture",
      assignmentRevision: 7,
      assignmentConfigurationSha256: "a".repeat(64),
      route: "primary",
      provider: "openai",
      modelId: "gpt-6-astra",
      reasoningLevel: "ultra",
    },
    requestId: "native-fixture-request",
  },
  conversationEvents: [
    { type: "run", runId: "run-fixture", threadId: "thread-fixture" },
    { type: "status", label: "Working", detail: "Reviewing evidence." },
    { type: "delta", text: "Here is what needs attention." },
    {
      type: "model",
      provider: "openai",
      model: "gpt-6-astra",
      tier: "reasoning",
      inputTokens: 120,
      outputTokens: 24,
      totalTokens: 144,
      latencyMs: 420,
      reasoningEffort: "max",
      commandSelectionSha256: "b".repeat(64),
    },
    { type: "waiting_approval", executionId: "execution-fixture", toolId: "calendar.event.create", message: "Approval is required." },
    { type: "done", response: "Here is what needs attention." },
  ],
  realtimeVoiceSessionStartRequest: {
    providerConsent: true,
    audioRetention: "not_stored_by_asael",
    mode: "orchestrate",
    language: "en",
    reconnectAttempt: 0,
  },
  realtimeVoiceSessionFinishRequest: {
    sessionId: "33333333-3333-4333-8333-333333333333",
    conversationId: "22222222-2222-4222-8222-222222222222",
    outcome: "sent",
    durationMilliseconds: 12_500,
    turnCount: 2,
    reconnectCount: 0,
    transcriptCharacters: 84,
    confidenceBand: "high",
    confidenceMean: 0.92,
    confidenceMinimum: 0.71,
    confidenceSampleCount: 12,
    reviewRequired: false,
    reviewAttested: true,
  },
  speechStreamRequest: {
    text: "Here is what needs attention.",
    agentId: "asael",
    threadId: "22222222-2222-4222-8222-222222222222",
    runId: "run-fixture",
    voiceProfileVersion: "asael-voice:1",
    audioRetention: "not_stored_by_asael",
  },
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
    const pathParameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => {
      const declared = operation.pathParameters?.find((parameter) => parameter.name === match[1]);
      return {
        name: match[1], in: "path", required: true,
        schema: { type: "string", minLength: declared?.minLength ?? 1, maxLength: declared?.maxLength ?? 200,
          ...(declared?.pattern !== undefined ? { pattern: declared.pattern } : {}) },
      };
    });
    const queryParameters = (operation.queryParameters || []).map((parameter) => ({
      name: parameter.name,
      in: "query",
      required: parameter.required || false,
      ...(parameter.description !== undefined ? { description: parameter.description } : {}),
      schema: openApiQueryParameterSchema(parameter),
    }));
    const headerParameters = (operation.headerParameters || []).map((parameter) => ({
      name: parameter.name,
      in: "header",
      required: parameter.required,
      schema: {
        type: "string",
        ...(parameter.minLength !== undefined ? { minLength: parameter.minLength } : {}),
        ...(parameter.maxLength !== undefined ? { maxLength: parameter.maxLength } : {}),
        ...(parameter.pattern !== undefined ? { pattern: parameter.pattern } : {}),
      },
    }));
    const parameters = [...pathParameters, ...queryParameters, ...headerParameters];
    const mediaType = operation.mediaType || "application/json";
    const responseMediaType = operation.responseMediaType || mediaType;
    const requestBody = operation.requestSchema && operation.method !== "GET"
      ? {
          required: true,
          ...(operation.requestBodyMaxBytes !== undefined ? { "x-asael-max-bytes": operation.requestBodyMaxBytes } : {}),
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
      ...(operation.queryPolicy === "exact" ? { "x-asael-query-policy": { unknownParameters: "reject", repeatedParameters: "reject" } } : {}),
      responses: {
        ...Object.fromEntries((operation.successStatuses ?? [200]).map((status) => [String(status), {
          description: "Successful response.",
          ...(operation.responseHeaders?.length
            ? { headers: responseHeaders(operation.responseHeaders) }
            : {}),
          content: {
            [responseMediaType]: {
              schema: operation.responseSchema
                ? ref(operation.responseSchema)
                : { type: "string", format: "binary" },
            },
            ...(operation.binaryResponse
              ? {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                }
              : {}),
          },
        }])),
        ...Object.fromEntries((operation.errorStatuses ?? [400, 401, 403, 409]).map((status) => [String(status), errorResponse(operation.errorResponseSchema)])),
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

function errorResponse(schema = "NativeErrorResponse") {
  return {
    description: "Bounded error response.",
    content: { "application/json": { schema: ref(schema) } },
  };
}

function responseHeaders(
  headers: NonNullable<NativeOperation["responseHeaders"]>,
) {
  return Object.fromEntries(headers.map((header) => [
    header.name,
    {
      description: header.description,
      required: true,
      schema: {
        type: "string",
        ...(header.constValue !== undefined
          ? { const: header.constValue }
          : {}),
        ...(header.pattern !== undefined ? { pattern: header.pattern } : {}),
      },
    },
  ]));
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
      ...(parameter.defaultValue !== undefined ? { default: parameter.defaultValue } : {}),
    };
  }
  return {
    type: "string",
    ...(parameter.minLength !== undefined ? { minLength: parameter.minLength } : {}),
    ...(parameter.maxLength !== undefined ? { maxLength: parameter.maxLength } : {}),
    ...(parameter.pattern !== undefined ? { pattern: parameter.pattern } : {}),
    ...(parameter.enumValues?.length ? { enum: [...parameter.enumValues] } : {}),
    ...(parameter.defaultValue !== undefined ? { default: parameter.defaultValue } : {}),
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
