import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES,
  openCredentialBundle,
  openNativeOpenapiImportSnapshot,
  sealCredentialBundle,
  sealNativeOpenapiImportSnapshot,
} from "./credential-vault";

const binding = `asael:native-openapi-import-snapshot:v1:${"1".repeat(64)}`;
let firstKey: string;
beforeEach(() => {
  firstKey = randomBytes(32).toString("base64url");
  vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "fixture1", keys: { fixture1: firstKey } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("native OpenAPI snapshot envelope", () => {
  it("authenticates a complete snapshot larger than the ordinary credential reader allows", () => {
    const snapshot = { configuration: { source: "private specification fixture" }, operations: [{ schema: "x".repeat(90_000) }] };
    const sealed = sealNativeOpenapiImportSnapshot(snapshot, binding);
    expect(openNativeOpenapiImportSnapshot(sealed, binding)).toEqual(snapshot);
    expect(() => openCredentialBundle(sealed, binding)).toThrow();
    expect(JSON.stringify(sealed)).not.toContain("private specification fixture");
  });

  it("keeps the ordinary reader limit and both authenticated-data families separate", () => {
    const ordinary = sealCredentialBundle({ value: "fixture" }, binding);
    expect(openCredentialBundle(ordinary, binding)).toEqual({ value: "fixture" });
    expect(() => openNativeOpenapiImportSnapshot(ordinary, binding)).toThrow(/authenticated/);
    const snapshot = sealNativeOpenapiImportSnapshot({ value: "fixture" }, binding);
    expect(() => openCredentialBundle(snapshot, binding)).toThrow(/authenticated/);
    expect(() => openCredentialBundle(sealCredentialBundle({ value: "x".repeat(64_001) }, binding), binding)).toThrow();
  });

  it("counts plaintext UTF-8 bytes and rejects oversized encoded envelopes before opening", () => {
    const within = { text: "é".repeat((NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES - 20) / 2) };
    expect(openNativeOpenapiImportSnapshot(sealNativeOpenapiImportSnapshot(within, binding), binding)).toEqual(within);
    expect(() => sealNativeOpenapiImportSnapshot({ text: "é".repeat(NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES / 2) }, binding)).toThrow(/bound/);
    const sealed = sealNativeOpenapiImportSnapshot({ value: "fixture" }, binding);
    expect(() => openNativeOpenapiImportSnapshot({ ...sealed, ciphertext: "A".repeat(Math.ceil(NATIVE_OPENAPI_SNAPSHOT_MAX_BYTES * 4 / 3) + 1) }, binding)).toThrow();
  });

  it.each(["ciphertext", "iv", "tag"] as const)("refuses changed %s without disclosing snapshot contents", (field) => {
    const sealed = sealNativeOpenapiImportSnapshot({ value: "private fixture" }, binding);
    const changed = { ...sealed, [field]: `${sealed[field][0] === "A" ? "B" : "A"}${sealed[field].slice(1)}` };
    expect(() => openNativeOpenapiImportSnapshot(changed, binding)).toThrow("The OpenAPI snapshot could not be authenticated.");
  });

  it("binds the complete family/scope commitment without truncation", () => {
    const sealed = sealNativeOpenapiImportSnapshot({ value: "fixture" }, binding);
    const other = `asael:native-openapi-import-snapshot:v1:${"2".repeat(64)}`;
    expect(() => openNativeOpenapiImportSnapshot(sealed, other)).toThrow(/authenticated/);
    expect(() => sealNativeOpenapiImportSnapshot({}, binding + "suffix")).toThrow(/binding/);
    expect(() => sealNativeOpenapiImportSnapshot({}, binding.replace("snapshot", "credential"))).toThrow(/binding/);
  });

  it("reads retained key versions after rotation and fails when the original key is unavailable", () => {
    const sealed = sealNativeOpenapiImportSnapshot({ value: "fixture" }, binding);
    const nextKey = randomBytes(32).toString("base64url");
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "fixture2", keys: { fixture1: firstKey, fixture2: nextKey } }));
    expect(openNativeOpenapiImportSnapshot(sealed, binding)).toEqual({ value: "fixture" });
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", JSON.stringify({ activeKeyId: "fixture2", keys: { fixture2: nextKey } }));
    expect(() => openNativeOpenapiImportSnapshot(sealed, binding)).toThrow();
    vi.stubEnv("OMNIAGENT_CREDENTIAL_KEYRING", "");
    expect(() => sealNativeOpenapiImportSnapshot({}, binding)).toThrow(/keyring/);
  });
});
