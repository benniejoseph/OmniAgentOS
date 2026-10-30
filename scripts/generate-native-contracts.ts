import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CSM_AGENT_TEMPLATE } from "../src/lib/csm/template";
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
// Supported prior publications remain byte-frozen. Retired documents live in
// Git history and are not regenerated or deployed.
const frozenDocumentSha256ByVersion = Object.freeze({
  61: Object.freeze({
    "openapi.json": "d8c1fb6f3947bfe5b3e7d6a85536aebf4c4dd1dd3304988b6a78dade4246806a", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "484a2a3c5592ddc066b484c6a9842e39749070c8a88715da735d5167fe69c7be", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "8cc3f4b832263b4787f78d4219de115bb6a216a812a6be664e4c8138460b4da6", // gitleaks:allow -- public artifact integrity digest
  }),
  60: Object.freeze({
    "openapi.json": "b2b519a30b8602d94886f33bee6444674c30327b751345ea35400dc5ca2ba8c4", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "eb4023b7ccccd4ca63b5d5bba55859e72b2ba4c6bae975dec0bd263bb2728d8f", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "54a905db855e6d756873e915c105a4cb5ea239aa4510c626880f012f57174c2a", // gitleaks:allow -- public artifact integrity digest
  }),
  59: Object.freeze({
    "openapi.json": "c40efe892d0b77a21f204b449110db5d05edacec3308f0f909ef6e63670910aa", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "f7e95ccb430a10ee378c5121f46cf762295565c61dbccda03d2d0db63a8d8566", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "ffbeab69efd9a6f17c74ab0a56766eb8df03c64cd478db3d43f201aaeb78fc26", // gitleaks:allow -- public artifact integrity digest
  }),
  58: Object.freeze({
    "openapi.json": "390f84a5f6df8c139b0522ffb0b156a4848672ba0bc60fd44815fbbc3a2b6d2e", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "96812e8f0bfe90f203dbce1706fbb642508ada50ece8027674578b54a259bb64", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "41fd3a44a94ec60207e73a1ef643e88f940a5167b601229b09c1e136c5fbd38e", // gitleaks:allow -- public artifact integrity digest
  }),
  57: Object.freeze({
    "openapi.json": "0204a9fa5693ff681f8424f2cf592903c497a2c1dcc96a03bde91fe722c482e9", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "909ee7f2ae6bc1d3ed130d8299868263548632bcc589245464b5a2cc9120fd25", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "b943ae3875ee6e635dca261fc15adfb4993821fd586f05a04f35a45ea932b87c", // gitleaks:allow -- public artifact integrity digest
  }),
  56: Object.freeze({
    "openapi.json": "7ff51284a2913a9bcb812edb25bfc1912e898f3c192f8286ade26e918e0dcac0", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "1ebda73ee54baba52e7befc691cef24747fea247334a0f00a494146ba3810329", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "5d823b2c4e7a5420efb9f80aeffd7d4d40b194a78ab6149be4e462005cd9af71", // gitleaks:allow -- public artifact integrity digest
  }),
  55: Object.freeze({
    "openapi.json": "762c522975ba34d19e5ae22b4dbf7ff1a9e91adbc1cb851b66081497a326e3fd", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "dfabc330a19ebfac18b78708a3e2b5c27aef09522ab2d119ced7f8b6b4a6263e", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "9d7a762182bd7081a5ed85ab578480695b8db06089b36d3b861a89ec709d8e72", // gitleaks:allow -- public artifact integrity digest
  }),
  54: Object.freeze({
    "openapi.json": "aa67baafd9c3b5be5da61b06128be97a7e7873bb474c32fae458a23427e2d482", // gitleaks:allow -- public artifact integrity digest
    "events.schema.json": "86aa365fcc455ed5d8ca2e1861a646d614af6080cbbd743035ed0503ad71c0e7", // gitleaks:allow -- public artifact integrity digest
    "fixtures.json": "7410245f163715c941c042a119aedaf3a40e25d144f54d93fcb9827478fe8b54", // gitleaks:allow -- public artifact integrity digest
    "manifest.json": "e96b390bf576e2fddb24978039efbcec830197894c8ac0ff65459a7fd9df831f", // gitleaks:allow -- public artifact integrity digest
  }),

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
    path.join(repositoryRoot, "apps", "flutter", "lib", "features", "csm", "csm_agent_template.dart"),
    `// GENERATED FILE. Source: src/lib/csm/template.ts. Run npm run generate:native-contracts.\nimport 'dart:convert';\n\nMap<String, dynamic> csmAgentTemplate() => Map<String, dynamic>.from(jsonDecode(${JSON.stringify(JSON.stringify(CSM_AGENT_TEMPLATE)).replaceAll("$", "\\$")}));\n`,
  );
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
