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
// Product retirement keeps these prior public artifacts byte-frozen. The v47
// compatibility publication is withdrawn narrowly from its archived original.
const frozenDocumentSha256ByVersion = Object.freeze({
  53: Object.freeze({
    "openapi.json": "441a3e1bc68ad9258245c02c5dd9bb6a6f5c4e3dc32c92822452e1d4492f2a14", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "645e3cc49be364fb894ab8683eb150b91d3b2a8b19ed8981bcb2932a7e44954b", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "c241a4454c22b97103122248241587cdc76cdea237fe5155e6eb9614bb122b86", // gitleaks:allow -- public artifact integrity digest
  }),

  52: Object.freeze({
    "openapi.json": "dd524fba01e935a8837cef430cc973a590340c0c41bdcb5fece2db9fc6e6b776", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "4381c08e47498a5ca8eaf1c72e109e75185acd796ab236fe7925e7a54b680435", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "20b683ce5e225e70e0d9ffe9933ababd041f35166f5f2a02537ffed489d23746", // gitleaks:allow -- public artifact integrity digest
  }),

  51: Object.freeze({
    "openapi.json": "aed11c793c1614b62e83fd03e714b642cee20febc3ee8603641d3a351109d506", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "846aeac3f18d7998323292758b4b1ed0624a07dec22db270ac204373574993bf", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "d2f4eb39bdf294ffe2b0b296ddf3d09a741b24630e53745b327f171221cab299", // gitleaks:allow -- public artifact integrity digest
  }),
  49: Object.freeze({
    "openapi.json": "aa4fd99f6820a31cad8c2ecf808e560f7c9cd0de54a43caa5b161e43ba49702f", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "db948c3e1bac14bfe01652167a698c9d5e8e2bcb6d982a8bba76bf2c980f8e98", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "4c3505ade9a98c40cee85816961b7d6dd83a15272b6865c657fff982a4a9793b", // gitleaks:allow -- public artifact integrity digest
  }),
  50: Object.freeze({
    "openapi.json": "294f37a0461730ae7a0ccd121bb5dc81275d02d36472b452f31c81678c3496ae", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "288a403cda188d1a83b76a2402fce630ba5fc478ad7a67c8aa19733454362c8e", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "3af2ea57685e42c6b543537a681877ce56e0208ffb38869c1e105370a8b99426", // gitleaks:allow -- public artifact integrity digest
  }),
  45: Object.freeze({
    "openapi.json": "0550a5cd1cc7df01168164ec8e68710e90743c2145d2a6db2162127f7ab22123", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "771a2b311c5a62d1af5010b1afc03228c41b282a8a84126329ae5bc8dc3276d9", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "066eb546a3043a1bb16f89f8bea771f00f43b9b80cf91bf77d0eca43a7dd7d6e", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "cd5c20e3cffeb331d0f4ce7c4288604ac3e9f1d0e327292e3ce2bfdfad40a5a9", // gitleaks:allow -- public artifact integrity digest
  }),
  46: Object.freeze({
    "openapi.json": "338f0ffe6f4e2051a87b85d77f8aec605bb639b7c06de232b4989a69e15a1233", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "771a2b311c5a62d1af5010b1afc03228c41b282a8a84126329ae5bc8dc3276d9", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "7dbf329ac4ad5f51c78fb00012421d4c6e9832e204b4744d7eb06bbf542f79f7", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "80df210e108bcaa7f281504f154b50c7e53cdc3c13cd0b65553c486ce1f2657c", // gitleaks:allow -- public artifact integrity digest
  }),
});

const originalV47DocumentSha256 = Object.freeze({
  "openapi.json": "cc783eff3bf60b6a198607c4fce70c8d87b12bbbccec5b1909106e67084f6b24", // gitleaks:allow -- public artifact integrity digest
  "events.schema.json": "771a2b311c5a62d1af5010b1afc03228c41b282a8a84126329ae5bc8dc3276d9", // gitleaks:allow -- public artifact integrity digest
  "fixtures.json": "738bc72f1a1ff8d175549b00903437bb265f28adce74d92500970a65889f9eba", // gitleaks:allow -- public artifact integrity digest
  "manifest.json": "7213892e4b6e4143e8f87dec58fffac88fef3a1cc7b610ea24dd99687be30dae", // gitleaks:allow -- public artifact integrity digest
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
  await retainRetiredV47Compatibility(expected);
  for (const version of NATIVE_API_SUPPORTED_VERSIONS) {
    const directory = path.join(repositoryRoot, "public", "native-contracts", `v${version}`);
    if (version !== NATIVE_API_CURRENT_VERSION) {
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

async function retainRetiredV47Compatibility(expected: Map<string, string>) {
  const archived = path.join(repositoryRoot, "docs", "archive", "native-contracts", "v47");
  await retainFrozenContract(expected, archived, originalV47DocumentSha256);
  const document = JSON.parse(expected.get(path.join(archived, "openapi.json"))!) as {
    paths: Record<string, Record<string, { operationId: string }>>;
    components: { schemas: Record<string, unknown> };
  };
  for (const [route, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId.startsWith("customers.")) delete methods[method];
    }
    if (Object.keys(methods).length === 0) delete document.paths[route];
  }
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    if (/^Native(?:Customer|Salesforce)/.test(name)) {
      delete document.components.schemas[name];
    } else if (name.startsWith("NativePush")) {
      document.components.schemas[name] = withoutRetiredPushTarget(schema);
    }
  }
  const directory = path.join(repositoryRoot, "public", "native-contracts", "v47");
  const openapiText = stableJson(document);
  const eventsText = expected.get(path.join(archived, "events.schema.json"))!;
  const fixturesText = expected.get(path.join(archived, "fixtures.json"))!;
  const manifest = {
    schemaVersion: 1,
    contractId: NATIVE_API_CONTRACT_ID,
    version: 47,
    state: "previous",
    compatibility: {
      // This retired publication retains its last published compatibility metadata.
      // Current compatibility is discovered through /api/mobile/contracts.
      currentVersion: 53,
      previousVersion: 52,
      supportedVersions: [53, 52, 51],
    },
    retirement: {
      reason: "crm_workspace_retired",
      originalManifestSha256: originalV47DocumentSha256["manifest.json"],
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

function withoutRetiredPushTarget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRetiredPushTarget);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "enum" && Array.isArray(item)
      ? item.filter((entry) => entry !== "customer")
      : withoutRetiredPushTarget(item),
  ]));
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
            ...(operation.id === "listen.ingest" ? {
              "multipart/form-data": { schema: ref("NativeListenSegmentRequest") },
            } : {}),
          },
        }
      : undefined;
    paths[operation.path] ||= {};
    paths[operation.path][operation.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      tags: [operation.id.split(".")[0]],
      ...(operation.auth === "bearer" ? { security: [{ bearerAuth: [] }] } : operation.auth === "listen" ? { security: [{ listenGrant: [] }] } : {}),
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
        ...(version >= 54 ? { listenGrant: { type: "http", scheme: "Listen", description: "A device/session/origin-bound upload grant; never an ordinary bearer credential." } } : {}),
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
  return id.replace(/[.-]([a-z])/g, (_, character: string) => character.toUpperCase());
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
