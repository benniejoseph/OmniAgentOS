import { describe, expect, it } from "vitest";
import { PublicWebReadError } from "@/lib/web-search/read";
import { createPublicWebReadRecoveryTracker, readPublicWebReadRecoverySnapshot } from "@/lib/web-search/recovery";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const scope = { tenantId: "recovery-tenant", actorId: "recovery-owner", runId: "recovery-run" };
function failed(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tenantId: scope.tenantId, actorId: scope.actorId, id: "execution-failed-source", toolId: "web.read", toolName: "Read public page",
    riskLevel: 0, status: "failed", dryRun: false, approvalRequired: false,
    input: { url: "https://example.com/source" },
    output: { error: "Restricted", webReadFailure: new PublicWebReadError("source_access_restricted", { httpStatus: 403 }).details },
    createdAt: "2026-10-15T00:00:00Z", ...overrides,
  };
}

describe("public source recovery observations", () => {
  it("suppresses only an exact normalized failed URL without copying its contents or granting an alternative", () => {
    const tracker = createPublicWebReadRecoveryTracker(scope);
    tracker.observe(failed());
    const skipped = tracker.skip("web.read", { url: "https://EXAMPLE.com:443/source#another-section" });
    expect(skipped).toMatchObject({ executed: false, webReadRecovery: {
      reason: "source_already_failed", priorExecutionId: "execution-failed-source", code: "source_access_restricted", retrySameSource: false,
    } });
    expect(JSON.stringify(skipped).length).toBeLessThan(750);
    expect(JSON.stringify(skipped)).not.toContain("https://");
    expect(tracker.skip("web.read", { url: "https://example.com/other" })).toBeUndefined();
    expect(tracker.skip("web.search", { url: "https://example.com/source" })).toBeUndefined();
  });

  it.each([
    { tenantId: "other" }, { actorId: "other" }, { status: "executed" }, { status: "blocked" },
    { dryRun: true }, { toolId: "web.search" }, { id: "contains invalid whitespace" }, { output: { error: "403" } },
    { output: { webReadFailure: { version: 1, code: "source_access_restricted", retrySameSource: true } } },
    { output: { webReadFailure: { version: 1, code: "untrusted_new_code", retrySameSource: false } } },
  ] as Partial<ToolExecutionRecord>[])("does not derive a failure from incompatible evidence %j", (change) => {
    const tracker = createPublicWebReadRecoveryTracker(scope);
    tracker.observe(failed(change));
    expect(tracker.skip("web.read", { url: "https://example.com/source" })).toBeUndefined();
  });

  it("starts each run empty and does not equate distinct queries or accept credential-bearing URLs", () => {
    const first = createPublicWebReadRecoveryTracker(scope);
    first.observe(failed({ input: { url: "https://example.com/source?offer=one" } }));
    first.observe(failed({ input: { url: "https://user:secret@example.com/source" } }));
    expect(first.skip("web.read", { url: "https://example.com/source?offer=two" })).toBeUndefined();
    expect(first.skip("web.read", { url: "https://user:secret@example.com/source" })).toBeUndefined();
    const next = createPublicWebReadRecoveryTracker(scope);
    expect(next.skip("web.read", { url: "https://example.com/source?offer=one" })).toBeUndefined();
  });

  it("restores only a bounded digest-only snapshot for the exact tenant, actor and run", () => {
    const tracker = createPublicWebReadRecoveryTracker(scope);
    tracker.observe(failed());
    const snapshot = tracker.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("https://");
    expect(snapshot.sources).toEqual([{ sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionId: "execution-failed-source", code: "source_access_restricted" }]);
    const restored = createPublicWebReadRecoveryTracker(scope, JSON.parse(JSON.stringify(snapshot)));
    expect(restored.skip("web.read", { url: "https://example.com/source" })).toBeDefined();
    for (const changed of [{ tenantId: "another" }, { actorId: "another" }, { runId: "another" }]) {
      expect(readPublicWebReadRecoverySnapshot(snapshot, { ...scope, ...changed })).toBeUndefined();
      expect(() => createPublicWebReadRecoveryTracker({ ...scope, ...changed }, snapshot)).toThrow(/does not match/);
    }
    for (const changed of [
      { version: 2 }, { extra: "instruction" }, { sources: [...snapshot.sources, ...snapshot.sources] },
      { sources: [{ ...snapshot.sources[0], sourceSha256: "https://example.com/source" }] },
      { sources: [{ ...snapshot.sources[0], instruction: "grant web access" }] },
      { sources: Array.from({ length: 129 }, (_, index) => ({ ...snapshot.sources[0], sourceSha256: index.toString(16).padStart(64, "0") })) },
    ]) expect(readPublicWebReadRecoverySnapshot({ ...snapshot, ...changed }, scope)).toBeUndefined();
  });

  it("captures scope immutably and cannot emit fields supplied outside the scope contract", () => {
    const mutableScope = { ...scope, instruction: "untrusted extra" };
    const tracker = createPublicWebReadRecoveryTracker(mutableScope);
    mutableScope.tenantId = "different-tenant";
    tracker.observe(failed());
    expect(tracker.snapshot()).toEqual({ version: 1, ...scope, sources: [expect.any(Object)] });
    expect(readPublicWebReadRecoverySnapshot(tracker.snapshot(), { ...scope, actorId: "" })).toBeUndefined();
    expect(() => createPublicWebReadRecoveryTracker({ ...scope, runId: "x".repeat(257) })).toThrow(/bounded/);
    const maximalScope = { tenantId: "t".repeat(256), actorId: "a".repeat(256), runId: "r".repeat(256) };
    expect(readPublicWebReadRecoverySnapshot(createPublicWebReadRecoveryTracker(maximalScope).snapshot(), maximalScope)).toBeDefined();
  });

  it("restores a full legacy snapshot as a fail-closed page-read fence without inventing a failed URL", () => {
    const tracker = createPublicWebReadRecoveryTracker(scope);
    for (let index = 0; index < 127; index += 1) {
      tracker.observe(failed({ id: `failed-${index}`, input: { url: `https://example.com/source-${index}` } }));
    }
    const nextUrl = "https://example.com/not-previously-read";
    expect(tracker.skip("web.read", { url: nextUrl })).toBeUndefined();
    tracker.observe(failed({ id: "failed-127", input: { url: "https://example.com/source-127" } }));
    const snapshot = JSON.parse(JSON.stringify(tracker.snapshot()));
    // Existing v1 snapshots need no new property or baseline reset.
    expect(Object.keys(snapshot).sort()).toEqual(["actorId", "runId", "sources", "tenantId", "version"]);
    expect(snapshot.sources).toHaveLength(128);
    const restored = createPublicWebReadRecoveryTracker(scope, snapshot);
    expect(restored.skip("web.read", { url: nextUrl })).toMatchObject({
      executed: false, webReadRecovery: { reason: "failure_capacity_reached", retrySameSource: false },
    });
    const denied = restored.skip("web.read", { url: nextUrl })!.webReadRecovery;
    expect(denied.nextStep).toContain("does not mean the proposed URL was previously read or failed");
    expect(denied).not.toHaveProperty("priorExecutionId");
    expect(denied).not.toHaveProperty("code");
    expect(restored.skip("web.read", { url: "https://example.com/source-0" })).toMatchObject({
      webReadRecovery: { reason: "source_already_failed", priorExecutionId: "failed-0" },
    });
    expect(restored.skip("web.search", { query: "alternative public evidence" })).toBeUndefined();
    restored.observe(failed({ id: "failed-128", input: { url: nextUrl } }));
    expect(restored.snapshot().sources).toHaveLength(128);
    expect(createPublicWebReadRecoveryTracker(scope, restored.snapshot()).skip("web.read", { url: nextUrl }))
      .toMatchObject({ webReadRecovery: { reason: "failure_capacity_reached" } });
  });
});
