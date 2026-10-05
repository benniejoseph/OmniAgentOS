import { describe, expect, it } from "vitest";
import { nativeOpenapiImportFixture, nativeOpenapiImportNormalizationFixtures } from "../../../tests/fixtures/native-openapi-import";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { connectorNativeActionSchema } from "./native-control-contracts";
import { connectorNativeMcpRegistrationActionSchema, connectorNativeMcpRegistrationPrepareRequestSchema } from "./native-mcp-registration-contracts";
import { connectorNativeCredentialRotationActionSchema } from "./native-credential-rotation-contracts";
import {
  buildConnectorNativeOpenapiImportPreparationIntent, connectorNativeOpenapiImportTargetId,
  connectorNativeOpenapiImportPrepareRequestSchema, connectorNativeOpenapiImportPreparationIntentSchema,
  connectorNativeOpenapiImportAttemptSchema, connectorNativeOpenapiImportPreparationSchema,
  connectorNativeOpenapiImportSummarySchema, connectorNativeOpenapiImportPreparationReadSchema,
  connectorNativeOpenapiImportActionSchema, isNativeOpenapiImportHeaderAllowed, isNativeOpenapiImportPathAllowed,
  normalizeNativeOpenapiImportBaseUrl, normalizeNativeOpenapiImportSourceUrl,
} from "./native-openapi-import-contracts";

const authModes = ["none", "bearer_env", "api_key_header_env"] as const;
const sources = ["text", "url"] as const;
function rehash<T extends Record<string, unknown>>(value: T, field: string) {
  const body = { ...value }; delete body[field];
  return { ...body, [field]: canonicalJsonSha256(body) };
}

describe("native OpenAPI import strict domain boundary", () => {
  it("admits all six auth/source combinations while keeping private input out of durable evidence", () => {
    for (const auth of authModes) for (const source of sources) {
      const f = nativeOpenapiImportFixture(auth, source, source === "url");
      expect(buildConnectorNativeOpenapiImportPreparationIntent(f.scope, f.preparationKey, f.prepareRequest)).toEqual(f.intent);
      for (const read of [f.preparing, f.ready, f.expired, f.expiredAttempt, f.failed, f.consumed, f.abandonedAbsent, f.abandonedAttempt, f.abandonedPrepared]) {
        expect(connectorNativeOpenapiImportPreparationReadSchema.parse(read)).toEqual(read);
      }
      const publicEvidence = JSON.stringify([f.intent, f.preparation, f.ready, f.consumed, f.action]);
      for (const privateValue of ["synthetic-private-query", "synthetic-fragment", f.preparationKey, f.finalKey]) expect(publicEvidence).not.toContain(privateValue);
      if (f.prepareRequest.payload.specText) expect(publicEvidence).not.toContain(f.prepareRequest.payload.specText);
      expect(f.action.settlement?.result).toMatchObject({ connectorStatus: "disabled", credentialVersion: 0, contractCount: 2 });
      expect(f.preparation.declaration.endpoint).toBeNull();
      expect(f.preparation.resolvedDeclaration.endpoint).toBe("https://api.example.test/v1");
    }
  });
  it("keeps scope-derived targets and original declarations immutable", () => {
    const f = nativeOpenapiImportFixture();
    expect(f.connectorId).toMatch(/^native-openapi-[a-f0-9]{64}$/);
    for (const scope of [{ ...f.scope, tenantId: "other" }, { ...f.scope, ownerActorId: "other@example.test" },
      { ...f.scope, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" }]) {
      expect(connectorNativeOpenapiImportTargetId(scope, f.nonce)).not.toBe(f.connectorId);
    }
    expect(connectorNativeOpenapiImportPreparationIntentSchema.safeParse({ ...f.intent, connectorId: "native-openapi-" + "f".repeat(64) }).success).toBe(false);
    for (const patch of [{ resolvedDeclaration: { ...f.preparation.resolvedDeclaration, name: "Changed" } },
      { declaration: { ...f.intent.declaration, endpoint: f.preparation.resolvedDeclaration.endpoint } }]) {
      expect(connectorNativeOpenapiImportPreparationSchema.safeParse(rehash({ ...f.preparation, ...patch }, "preparationSha256")).success).toBe(false);
    }
  });
  it("normalizes source URLs separately from bases and refuses even empty base delimiters", () => {
    const rows = nativeOpenapiImportNormalizationFixtures(), byInput = new Map(rows.map((r) => [r.input, r]));
    expect(byInput.get("https://EXAMPLE.test:443/doc")?.source).toBe("https://example.test/doc");
    expect(byInput.get("https://example.test")?.base).toBe("https://example.test");
    expect(byInput.get("https://example.test/a/%2f/%7e/doc")?.source).toBe("https://example.test/a/%2f/%7e/doc");
    for (const suffix of ["?", "#", "?#"]) {
      expect(byInput.get(`https://example.test/doc${suffix}`)).toMatchObject({ specUrl: "https://example.test/doc", specUrlRedacted: true, base: null });
      expect(() => normalizeNativeOpenapiImportBaseUrl(`https://example.test/doc${suffix}`)).toThrow();
    }
    for (const bad of [" https://example.test/doc", "https://example.test/doc\n", "https://user:password@example.test/doc", "file:///tmp/spec", "javascript:spec"]) {
      expect(() => normalizeNativeOpenapiImportSourceUrl(bad)).toThrow();
    }
  });
  it("enforces real reserved-header and safe relative-path rules", () => {
    for (const name of ["X-Api-Key", "api_key", "X-Fixture-Key"]) expect(isNativeOpenapiImportHeaderAllowed(name)).toBe(true);
    for (const name of ["Authorization", "COOKIE", "Host", "Connection", "Content-Length", "Transfer-Encoding", "Forwarded", "Proxy-Key",
      "Sec-Token", "Cf-Connecting-Ip", "True-Client-Ip", "X-Forwarded-Key", "X-Original-Url", "X-Rewrite-Url", "X-HTTP-Method-Override",
      "X-Method-Override", "X-Real-Ip", "X-Client-Ip", "X-Vercel-Id", "bad header", "a".repeat(81)]) expect(isNativeOpenapiImportHeaderAllowed(name), name).toBe(false);
    for (const path of ["/items", "/items/{id}", "/", "/escaped%20name"]) expect(isNativeOpenapiImportPathAllowed(path)).toBe(true);
    for (const path of ["relative", "//elsewhere", "/items?key=x", "/items#", "/../secret", "/%2e%2e/secret", "/%252e/secret", "/back\\slash", "/%5cname", "/%00", "/%invalid"]) {
      expect(isNativeOpenapiImportPathAllowed(path), path).toBe(false);
    }
  });
  it("bounds decoded source by UTF-8 bytes and rejects source/auth declaration drift", () => {
    const f = nativeOpenapiImportFixture();
    expect(connectorNativeOpenapiImportPrepareRequestSchema.parse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, specText: "é".repeat(1_000_000) } }).payload.specText?.length).toBe(1_000_000);
    expect(connectorNativeOpenapiImportPrepareRequestSchema.safeParse({ ...f.prepareRequest, payload: { ...f.prepareRequest.payload, specText: "é".repeat(1_000_001) } }).success).toBe(false);
    for (const patch of [{ payload: { ...f.prepareRequest.payload, specUrl: "https://example.test/spec" } },
      { payload: { ...f.prepareRequest.payload, bearerToken: "private" } }, { declaration: { ...f.intent.declaration, authType: "bearer_vault" } },
      { declaration: { ...f.intent.declaration, authTokenEnv: "UNEXPECTED_HANDLE" } }, { declaration: { ...f.intent.declaration, specUrlRedacted: true } }]) {
      expect(connectorNativeOpenapiImportPrepareRequestSchema.safeParse({ ...f.prepareRequest, ...patch }).success).toBe(false);
    }
    const url = nativeOpenapiImportFixture("none", "url", true);
    expect(connectorNativeOpenapiImportPrepareRequestSchema.safeParse({ ...url.prepareRequest, declaration: { ...url.intent.declaration, specUrlRedacted: false } }).success).toBe(false);
  });
  it("binds immutable attempt and proof deadlines without rejecting historical evidence", () => {
    const f = nativeOpenapiImportFixture();
    expect(connectorNativeOpenapiImportPreparationReadSchema.parse(f.expired)).toEqual(f.expired);
    expect(connectorNativeOpenapiImportAttemptSchema.safeParse(rehash({ ...f.attempt, expiresAt: "2026-10-05T00:00:45.001Z" }, "attemptSha256")).success).toBe(false);
    expect(connectorNativeOpenapiImportPreparationSchema.safeParse(rehash({ ...f.preparation, expiresAt: "2026-10-05T00:15:10.001Z" }, "preparationSha256")).success).toBe(false);
    const late = rehash({ ...f.preparation, preparedAt: f.attempt.expiresAt, expiresAt: "2026-10-05T00:15:45.000Z" }, "preparationSha256");
    expect(connectorNativeOpenapiImportPreparationReadSchema.safeParse({ ...f.ready, preparation: late }).success).toBe(false);
    expect(connectorNativeOpenapiImportPreparationReadSchema.safeParse({ ...f.failed, failure: { ...f.failed.failure, failedAt: "2026-10-05T00:00:45.001Z" } }).success).toBe(false);
  });
  it("binds every ordered safe summary operation and rejects omissions, duplicates or oversized summaries", () => {
    const f = nativeOpenapiImportFixture();
    for (const operations of [[f.summary.operations[0]], [...f.summary.operations].reverse(),
      [f.summary.operations[0], { ...f.summary.operations[1], definitionSha256: "f".repeat(64) }]]) {
      expect(connectorNativeOpenapiImportPreparationReadSchema.safeParse({ ...f.ready, summary: { ...f.summary, operations } }).success).toBe(false);
    }
    for (const operations of [[f.summary.operations[0], f.summary.operations[0]], [],
      [{ ...f.summary.operations[0], method: "TRACE" }], [{ ...f.summary.operations[0], id: "openapi:other:list_items" }],
      [{ ...f.summary.operations[1], riskLevel: 1 }]]) {
      expect(connectorNativeOpenapiImportSummarySchema.safeParse({ ...f.summary, operations }).success).toBe(false);
    }
    const ops = Array.from({ length: 200 }, (_, n) => ({ ...f.summary.operations[0], operationId: `read_${n}`, id: `openapi:${f.connectorId}:read_${n}` }));
    expect(connectorNativeOpenapiImportSummarySchema.safeParse({ ...f.summary, operations: ops }).success).toBe(true);
    expect(connectorNativeOpenapiImportSummarySchema.safeParse({ ...f.summary, operations: [...ops, { ...ops[0], operationId: "extra", id: `openapi:${f.connectorId}:extra` }] }).success).toBe(false);
    expect(connectorNativeOpenapiImportSummarySchema.safeParse({ ...f.summary, operations: ops.map((op) => ({ ...op, path: "/" + "a".repeat(1900) })) }).success).toBe(false);
  });
  it("keeps pending, failed, consumed and absent-key abandonment semantically distinct", () => {
    const f = nativeOpenapiImportFixture();
    for (const read of [{ ...f.preparing, preparation: f.preparation }, { ...f.failed, summary: f.summary },
      { ...f.failed, failure: { ...f.failed.failure, message: "private spec" } }, { ...f.consumed, consumedKeySha256: "f".repeat(64) },
      { ...f.abandonedAbsent, attempt: f.attempt }, { ...f.abandonedAbsent, preparation: f.preparation },
      { ...f.expired, summary: f.summary }, { ...f.ready, intent: nativeOpenapiImportFixture("bearer_env").intent }]) {
      expect(connectorNativeOpenapiImportPreparationReadSchema.safeParse(read).success).toBe(false);
    }
    expect(JSON.stringify(f.abandonedAbsent)).not.toContain("expiresAt");
    expect(JSON.stringify(f.abandonedAbsent)).not.toContain("preparedAt");
    expect(f.consumed.consumedKeySha256).toBe(f.actionIntent.keySha256);
  });
  it("publishes only disabled complete imports and keeps old-family parsers strict", () => {
    const f = nativeOpenapiImportFixture();
    for (const change of [{ kind: "mcp" }, { operation: "register_mcp" }, { connectorStatus: "active" }, { status: "failed" },
      { contractCount: 0 }, { contractCount: 201 }, { credentialVersion: 1 }, { configurationSha256: null }]) {
      const settlement = rehash({ ...f.action.settlement!, result: { ...f.action.settlement!.result, ...change } }, "settlementSha256");
      expect(connectorNativeOpenapiImportActionSchema.safeParse({ ...f.action, settlement }).success).toBe(false);
    }
    for (const schema of [connectorNativeActionSchema, connectorNativeMcpRegistrationActionSchema, connectorNativeCredentialRotationActionSchema]) {
      expect(schema.safeParse(f.action).success).toBe(false);
    }
    expect(connectorNativeMcpRegistrationPrepareRequestSchema.safeParse(f.prepareRequest).success).toBe(false);
  });
});
