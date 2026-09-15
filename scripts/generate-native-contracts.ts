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
} from "../src/lib/mobile/contracts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const frozenPreviousDocumentSha256 = Object.freeze({
  "openapi.json": "881f089ecb26dfc8b95ef8116acc449a130d06d5f10dbf1b1afe9e48ac60ba6f",
  "events.schema.json": "54ad4d7e0a686efecd0b3a436ab16df640755c7c4da9b20f4f703cb45a835049",
  "fixtures.json": "75486c3fe7d5654a6531b2f23e31427b4f2623f7f3e73d4d0418e746e5717bbc",
  "manifest.json": "a795ec2cddff310039a2991c11017209a94e6a366fbec7e2cb1978abadcbfc39",
});

const fixtures = Object.freeze({
  loginRequest: {
    email: "operator@example.test",
    password: "fixture-password",
    device: {
      id: "asael-fixture-device",
      name: "Asael on iOS",
      platform: "ios",
      appVersion: "1.0.0",
      buildNumber: 2,
      clientContractVersion: NATIVE_API_CURRENT_VERSION,
    },
  },
  refreshRequest: {
    refreshToken: "fixture-refresh-token-00000000000000000000",
    deviceId: "asael-fixture-device",
    client: {
      platform: "ios",
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
  for (const version of NATIVE_API_SUPPORTED_VERSIONS) {
    const directory = path.join(repositoryRoot, "public", "native-contracts", `v${version}`);
    if (version === NATIVE_API_PREVIOUS_VERSION) {
      await retainFrozenPreviousContract(expected, directory);
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

async function retainFrozenPreviousContract(
  expected: Map<string, string>,
  directory: string,
) {
  for (const [basename, expectedSha256] of Object.entries(
    frozenPreviousDocumentSha256,
  )) {
    const filename = path.join(directory, basename);
    const content = await readFile(filename, "utf8").catch(() => undefined);
    if (content === undefined) {
      throw new Error(`Missing frozen previous native contract: ${path.relative(repositoryRoot, filename)}`);
    }
    if (sha256(content) !== expectedSha256) {
      throw new Error(`Frozen previous native contract changed: ${path.relative(repositoryRoot, filename)}`);
    }
    expected.set(filename, content);
  }
}

function openApiDocument(version: number, operations: readonly NativeOperation[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
    }));
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
          content: { [mediaType]: { schema: ref(operation.responseSchema) } },
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
  const paths = operations.map((operation) => {
    const name = dartName(operation.id);
    const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (!parameters.length) return `  static const ${name} = '${operation.path}';`;
    const args = parameters.map((parameter) => `String ${parameter}`).join(", ");
    let rendered = operation.path;
    for (const parameter of parameters) {
      rendered = rendered.replace(`{${parameter}}`, `\${Uri.encodeComponent(${parameter})}`);
    }
    return `  static String ${name}(${args}) => '${rendered}';`;
  }).join("\n");
  const eventTypes = agentEventSchemasForDart().map((value) => `    '${value}',`).join("\n");
  return `// GENERATED FILE. DO NOT EDIT.\n// Run npm run generate:native-contracts from the repository root.\n\nabstract final class NativeContract {\n  static const id = '${NATIVE_API_CONTRACT_ID}';\n  static const currentVersion = ${NATIVE_API_CURRENT_VERSION};\n  static const previousVersion = ${NATIVE_API_PREVIOUS_VERSION};\n  static const supportedVersions = <int>[${NATIVE_API_SUPPORTED_VERSIONS.join(", ")}];\n  static const discoveryPath = '/api/mobile/contracts';\n\n  static bool supports(int version) => supportedVersions.contains(version);\n\n  static void verifyBootstrap(Map<String, dynamic> response) {\n    final api = response['api'];\n    if (api is! Map || api['nativeContract'] == null) {\n      // The immediately previous server did not advertise discovery metadata.\n      return;\n    }\n    final contract = api['nativeContract'];\n    if (contract is! Map || contract['id'] != id) {\n      throw const FormatException('The service returned a different native contract.');\n    }\n    final versions = contract['supportedVersions'];\n    if (versions is! List || !versions.contains(currentVersion)) {\n      throw const FormatException('This native client contract is not supported by the service.');\n    }\n  }\n}\n\nabstract final class NativePaths {\n${paths}\n}\n\nabstract final class NativeConversationEvents {\n  static const supportedTypes = <String>{\n${eventTypes}\n  };\n\n  static Map<String, dynamic> parse(String eventName, Object? value) {\n    if (value is! Map) {\n      throw const FormatException('Native event payload must be an object.');\n    }\n    final event = Map<String, dynamic>.from(value);\n    final type = event['type'];\n    if (type is! String || type != eventName || !supportedTypes.contains(type)) {\n      throw const FormatException('Native event discriminant is invalid.');\n    }\n    return event;\n  }\n}\n`;
}

function agentEventSchemasForDart() {
  return [
    "run", "delegated", "clarification", "status", "harness", "delta",
    "memory", "model", "council_member", "council_verdict", "tool",
    "waiting_approval", "budget_exhausted", "done", "canceled", "error",
  ];
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
