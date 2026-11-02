import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { decodeNativeTestEvidence, MAX_NATIVE_TEST_EVIDENCE_BYTES, nativeTestEvidenceSchema, nativeValidationCheckSchema, nativeValidationReceiptSchema, selfImprovementNativeSha, type NativeTestEvidence } from "./native-contracts";
import { nativeValidationFixture } from "./native-test-fixtures";

function checkFixture() {
  const { receipt } = nativeValidationFixture();
  const original = receipt.checks[1];
  const testEvidence: NativeTestEvidence = { version: 1, outputSha256: original.outputSha256, complete: true, omittedCases: 0,
    suites: [{ id: 0, path: original.paths[0] }],
    cases: [{ id: 1, suiteId: 0, name: "shared fixture control", line: 10, status: "passed" },
      { id: 2, suiteId: 0, name: "retains trailing explanation", line: 20, status: "failed", failureMessages: ["Expected: whole paragraph\nActual: first sentence"] }] };
  return { ...original, exitCode: 1, testSummary: { ...original.testSummary!, totalTests: 2, passedTests: 1, failedTests: 1, pendingTests: 0 }, testEvidence };
}

describe("bounded native named test evidence", () => {
  it("binds the shared control and unmodified failure message to the exact output hash", () => {
    const check = checkFixture();
    expect(nativeValidationCheckSchema.parse(check)).toEqual(check);
    expect(check.testEvidence.cases[1].failureMessages?.[0]).toBe("Expected: whole paragraph\nActual: first sentence");
  });
  it.each(["hash", "foreign_path", "duplicate_suite", "duplicate_case", "unknown_suite", "counts", "status", "missing_message", "omitted_message", "wrong_command"])("refuses %s evidence", kind => {
    const check = checkFixture();
    if (kind === "hash") check.testEvidence.outputSha256 = "0".repeat(64);
    if (kind === "foreign_path") check.testEvidence.suites[0].path = "apps/flutter/test/foreign_test.dart";
    if (kind === "duplicate_suite") check.testEvidence.suites.push(check.testEvidence.suites[0]);
    if (kind === "duplicate_case") check.testEvidence.cases[1].id = 1;
    if (kind === "unknown_suite") check.testEvidence.cases[1].suiteId = 1;
    if (kind === "counts") check.testEvidence.omittedCases = 1;
    if (kind === "status") check.testEvidence.cases[1].status = "passed";
    if (kind === "missing_message") delete check.testEvidence.cases[1].failureMessages;
    if (kind === "omitted_message") check.testEvidence.cases[1].omittedFailureMessages = 1;
    if (kind === "wrong_command") check.command = "macos_analyze";
    expect(nativeValidationCheckSchema.safeParse(check).success).toBe(false);
  });
  it("keeps bounded partial evidence visibly incomplete instead of treating counts as named proof", () => {
    const check = checkFixture();
    check.testEvidence.cases = [check.testEvidence.cases[0]];
    check.testEvidence.omittedCases = 1; check.testEvidence.complete = false;
    expect(decodeNativeTestEvidence(nativeValidationCheckSchema.parse(check).testEvidence!).complete).toBe(false);
    check.testEvidence.complete = true;
    expect(nativeValidationCheckSchema.safeParse(check).success).toBe(false);
  });
  it("retains complete messages up to the field bound, with a separate aggregate bound", () => {
    const evidence = checkFixture().testEvidence;
    evidence.cases[1].failureMessages = ["x".repeat(2_000)];
    expect(nativeTestEvidenceSchema.safeParse(evidence).success).toBe(true);
    evidence.cases[1].failureMessages = ["x".repeat(2_001)];
    expect(nativeTestEvidenceSchema.safeParse(evidence).success).toBe(false);
    evidence.cases = Array.from({ length: 5 }, (_, id) => ({ id, suiteId: 0, name: `case ${id}`, status: "failed", failureMessages: ["x".repeat(2_000), "y".repeat(2_000), "z".repeat(2_000)] }));
    expect(nativeTestEvidenceSchema.safeParse(evidence).success).toBe(false);
  });
  it("refuses unpaired surrogate messages instead of silently changing their bytes", () => {
    const evidence = checkFixture().testEvidence;
    evidence.cases[1].failureMessages = ["invalid\ud800text"];
    expect(nativeTestEvidenceSchema.safeParse(evidence).success).toBe(false);
  });
  it("leaves historical sealed receipts unchanged and binds any newly supplied case evidence into the seal", () => {
    const { receipt } = nativeValidationFixture();
    expect(nativeValidationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt.checks.every(check => check.testEvidence === undefined)).toBe(true);
    const added = { ...receipt, checks: [receipt.checks[0], checkFixture(), ...receipt.checks.slice(2)] };
    expect(nativeValidationReceiptSchema.safeParse(added).success).toBe(false);
    const { receiptSha256: _old, ...body } = added;
    expect(nativeValidationReceiptSchema.safeParse({ ...body, receiptSha256: selfImprovementNativeSha("native_validation_receipt", body) }).success).toBe(true);
  });
});

function encodeBytes(raw: Buffer, compressed = deflateRawSync(raw)) {
  return { version: 1 as const, encoding: "deflate-raw-json-v1" as const, decodedByteLength: raw.length,
    decodedSha256: createHash("sha256").update(raw).digest("hex"), data: compressed.toString("base64") };
}
// A fixed canonical fixture keeps byte-level mutations independent of the decoder.
const canonicalEvidence = () => Buffer.from(JSON.stringify(checkFixture().testEvidence,
  ["cases", "complete", "failureMessages", "id", "line", "name", "omittedCases", "outputSha256", "path", "status", "suiteId", "suites", "version"]));

describe("compressed native evidence transport", () => {
  it("reads the real Python writer without changing Unicode assertions, counts or receipt bytes", () => {
    const check = checkFixture();
    check.testEvidence.cases[1].failureMessages = ["Expected: தமிழ் 🤖\nActual: café"];
    const wire = JSON.parse(execFileSync(process.env.ASAEL_SELF_IMPROVEMENT_TEST_PYTHON || "python3", ["-c", `
import json,sys
sys.path.insert(0, 'scripts/self-improvement')
from macos_protocol import encode_test_evidence,validate_test_evidence
check=json.load(sys.stdin)
check['testEvidence']=encode_test_evidence(check['testEvidence'])
validate_test_evidence(check)
print(json.dumps(check['testEvidence']))
`], { input: JSON.stringify(check), encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 }));
    expect(decodeNativeTestEvidence(wire)).toEqual(check.testEvidence);
    expect(nativeValidationCheckSchema.parse({ ...check, testEvidence: wire }).testEvidence).toEqual(wire);
  });
  it("decodes canonical bytes and rejects a mutated output binding after decompression", () => {
    const check = checkFixture(), wire = encodeBytes(canonicalEvidence());
    expect(decodeNativeTestEvidence(wire)).toEqual(check.testEvidence);
    expect(nativeValidationCheckSchema.safeParse({ ...check, testEvidence: wire }).success).toBe(true);
    expect(nativeValidationCheckSchema.safeParse({ ...check, outputSha256: "0".repeat(64), testEvidence: wire }).success).toBe(false);
  });
  it.each(["length", "digest", "trailing_bytes", "trailing_stream", "truncated_stream", "invalid_stream", "base64", "noncanonical_json", "duplicate_key", "invalid_utf8", "oversized", "invalid_schema"] as const)("refuses %s before using compressed evidence", kind => {
    const raw = canonicalEvidence();
    let wire = encodeBytes(raw);
    if (kind === "length") wire.decodedByteLength++;
    if (kind === "digest") wire.decodedSha256 = "0".repeat(64);
    if (kind === "trailing_bytes") wire = encodeBytes(raw, Buffer.concat([deflateRawSync(raw), Buffer.from([0])]));
    if (kind === "trailing_stream") wire = encodeBytes(raw, Buffer.concat([deflateRawSync(raw), deflateRawSync(raw)]));
    if (kind === "truncated_stream") wire = encodeBytes(raw, deflateRawSync(raw).subarray(0, -1));
    if (kind === "invalid_stream") wire.data = Buffer.from("invalid deflate").toString("base64");
    if (kind === "base64") wire.data = "AB=="; // Decodes as AA==, but has nonzero padding bits.
    if (kind === "noncanonical_json") wire = encodeBytes(Buffer.from(raw.toString() + " "));
    if (kind === "duplicate_key") wire = encodeBytes(Buffer.from(raw.toString().replace('"version":1', '"version":1,"version":1')));
    if (kind === "invalid_utf8") wire = encodeBytes(Buffer.concat([raw.subarray(0, -1), Buffer.from([0xff, 0x7d])]));
    if (kind === "oversized") wire = { ...encodeBytes(Buffer.alloc(MAX_NATIVE_TEST_EVIDENCE_BYTES + 1, 0x20)), decodedByteLength: MAX_NATIVE_TEST_EVIDENCE_BYTES };
    if (kind === "invalid_schema") wire = encodeBytes(Buffer.from('{"version":true}'));
    expect(nativeValidationCheckSchema.safeParse({ ...checkFixture(), testEvidence: wire }).success).toBe(false);
  });
});
