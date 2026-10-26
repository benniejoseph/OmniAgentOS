import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NATIVE_API_CURRENT_VERSION, NATIVE_API_PREVIOUS_VERSION, nativeOperationsForVersion } from "./contracts";
import { improvementConfigureInput, improvementNativeMutationSchema, improvementReadQuerySchema, nativeSelfImprovementSchemas } from "@/lib/self-improvement/app-contracts";

const sha = "a".repeat(64), cycleId = `self_cycle_${sha}`;
const inputs = {
  configure: { projectId: "project", repositoryId: "42", dailyBudgetUsd: 100, maxCycleBudgetUsd: 10, autoReleaseRoutineChanges: true, notifyOutcomes: true, timeZone: "Asia/Kolkata", dailyHour: 7 },
  run: { configurationId: "config", expectedGeneration: 2 },
  pause: { configurationId: "config", expectedGeneration: 2, paused: true },
  review: { cycleId, expectedRevision: 3, candidateSha256: sha, validationSha256: sha, decision: "approve" },
  retry: { configurationId: "config", expectedGeneration: 2, failedCycleId: cycleId, expectedRevision: 3 },
  stop_native_check: { cycleId, expectedRevision: 3, requestId: `self_native_${sha}`, requestSha256: sha },
};
describe("native Self-improvement publication", () => {
  it("extends the unpublished v62 surface while retaining v61 operations", () => {
    expect([NATIVE_API_CURRENT_VERSION, NATIVE_API_PREVIOUS_VERSION]).toEqual([62, 61]);
    const previous = nativeOperationsForVersion(61)!, current = nativeOperationsForVersion(62)!;
    expect(current.slice(0, previous.length)).toEqual(previous);
    expect(current.filter(({ id }) => id.startsWith("selfImprovement.")).map(({ id }) => id)).toEqual(["selfImprovement.get", "selfImprovement.mutate"]);
    expect(previous.some(({ path }) => path.startsWith("/api/self-improvement"))).toBe(false);
    expect(current.some(({ path }) => path.includes("self-improvement/release-controller"))).toBe(false);
    expect(current.some(({ path }) => path.includes("self-improvement/native-controller"))).toBe(false);
  });
  it.each(Object.entries(inputs))("publishes exact %s owner intent with no authority override", (action, input) => {
    expect(improvementNativeMutationSchema.safeParse({ action, input }).success).toBe(true);
    expect(improvementNativeMutationSchema.safeParse({ action, input: { ...input, ownerActorId: "other" } }).success).toBe(false);
    expect(improvementNativeMutationSchema.safeParse({ action, input, tenantId: "other" }).success).toBe(false);
  });
  it.each(["advance", "claim", "prepare", "complete", "heartbeat", "status", "hold"])("does not publish internal action %s", action => {
    expect(improvementNativeMutationSchema.safeParse({ action, input: { cycleId, expectedRevision: 3 } }).success).toBe(false);
  });
  it("keeps the shared budget and exact review bindings intact", () => {
    expect(improvementConfigureInput.safeParse({ ...inputs.configure, maxCycleBudgetUsd: 101 }).success).toBe(false);
    expect(improvementConfigureInput.safeParse({ ...inputs.configure, dailyBudgetUsd: 5, maxCycleBudgetUsd: 10 }).success).toBe(false);
    expect(improvementNativeMutationSchema.safeParse({ action: "review", input: { ...inputs.review, validationSha256: undefined } }).success).toBe(false);
    expect(improvementNativeMutationSchema.safeParse({ action: "run", input: { configurationId: "config" } }).success).toBe(false);
  });
  it("describes only mutually exclusive owner reads", () => {
    for (const query of [{}, { view: "repositories" }, { cycleId }]) expect(improvementReadQuerySchema.safeParse(query).success).toBe(true);
    for (const query of [{ view: "controller" }, { view: "repositories", cycleId }, { cycleId, tenantId: "other" }]) expect(improvementReadQuerySchema.safeParse(query).success).toBe(false);
  });
  it("publishes closed serializable responses without private controller fields", () => {
    for (const schema of Object.values(nativeSelfImprovementSchemas)) expect(() => z.toJSONSchema(schema)).not.toThrow();
    const schema = JSON.stringify(z.toJSONSchema(nativeSelfImprovementSchemas.NativeSelfImprovementReadResponse));
    expect(schema).not.toContain('"leaseToken"'); expect(schema).not.toContain('"controllerId"');
    for (const field of ["candidateSha256", "validationSha256", "releaseReceipt", "sourceCandidateRevision", "agentRuns", "setupRetryAvailable", "serviceReceipt", "nativeCheck", "pairedBaseline", "nativeInstall"]) expect(schema).toContain(`"${field}"`);
  });
  it("keeps prior frozen documents unchanged and generates bounded Mac paths", async () => {
    const prior = await readFile(new URL("../../../public/native-contracts/v61/openapi.json", import.meta.url));
    expect(createHash("sha256").update(prior).digest("hex")).toBe("d8c1fb6f3947bfe5b3e7d6a85536aebf4c4dd1dd3304988b6a78dade4246806a");
    const current = JSON.parse(await readFile(new URL("../../../public/native-contracts/v62/openapi.json", import.meta.url), "utf8"));
    const read = current.paths["/api/self-improvement"].get, write = current.paths["/api/self-improvement"].post;
    expect(read.operationId).toBe("selfImprovement.get"); expect(read["x-asael-query-policy"]).toEqual({ unknownParameters: "reject", repeatedParameters: "reject" });
    expect(read.parameters).toContainEqual(expect.objectContaining({ name: "cycleId", schema: expect.objectContaining({ pattern: "^self_cycle_[a-f0-9]{64}$" }) }));
    expect(write.operationId).toBe("selfImprovement.mutate"); expect(write.requestBody["x-asael-max-bytes"]).toBe(64_000);
    expect(write.parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", required: true }));
    expect(current.paths["/api/self-improvement/release-controller"]).toBeUndefined();
    expect(current.paths["/api/self-improvement/native-controller"]).toBeUndefined();
    const dart = await readFile(new URL("../../../apps/flutter/lib/generated/native_contract.g.dart", import.meta.url), "utf8");
    expect(dart).toContain("selfImprovementGet({String? view, String? cycleId})");
    expect(dart).toContain("selfImprovementMutate = '/api/self-improvement'");
  });
});
