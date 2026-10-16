import { createHash } from "node:crypto";
import { readPublicWebReadFailureDetails, type PublicWebReadFailureCode } from "@/lib/web-search/read-failure";
import { redactSensitive } from "@/lib/security/context";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const failureCodes = new Set<PublicWebReadFailureCode>([
  "source_access_restricted", "source_not_readable", "source_too_large",
  "source_rate_limited", "source_http_error", "source_timeout", "source_unsupported",
]);
const MAX_FAILED_SOURCES = 128;
const MAX_SCOPE_LENGTH = 256;

type FailedSource = { executionId: string; code: PublicWebReadFailureCode };
type RecoveryScope = { tenantId: string; actorId: string; runId: string };
export type PublicWebReadRecoverySnapshot = RecoveryScope & {
  version: 1;
  sources: Array<FailedSource & { sourceSha256: string }>;
};

function record(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validScope(scope: RecoveryScope) {
  return [scope.tenantId, scope.actorId, scope.runId]
    .every((part) => typeof part === "string" && part.length > 0 && part.length <= MAX_SCOPE_LENGTH);
}

function sourceDigest(input: Record<string, unknown>) {
  if (typeof input.url !== "string" || input.url.length > 4_000) return;
  try {
    // Receipts contain redacted inputs. Hash the same representation for a
    // newly proposed URL so sensitive query values cannot defeat repeat checks.
    // Redaction collisions may deny a read; they never grant new authority.
    const url = new URL(String(redactSensitive(input.url.trim())));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    url.hash = "";
    return createHash("sha256").update(url.toString()).digest("hex");
  } catch { return; }
}

/** Only locally persisted, exact-run metadata may seed a tracker. A rejected
 * snapshot must not be replaced silently with an empty one on resume. */
export function readPublicWebReadRecoverySnapshot(value: unknown, scope: RecoveryScope): PublicWebReadRecoverySnapshot | undefined {
  const input = record(value);
  if (!input || Object.keys(input).length !== 5 ||
    Object.keys(input).some((key) => !["version", "tenantId", "actorId", "runId", "sources"].includes(key)) ||
    input.version !== 1 || input.tenantId !== scope.tenantId || input.actorId !== scope.actorId || input.runId !== scope.runId ||
    !validScope(scope) ||
    !Array.isArray(input.sources) || input.sources.length > MAX_FAILED_SOURCES) return;
  const sources: PublicWebReadRecoverySnapshot["sources"] = [];
  const seen = new Set<string>();
  for (const item of input.sources) {
    const source = record(item);
    if (!source || Object.keys(source).length !== 3 ||
      Object.keys(source).some((key) => !["sourceSha256", "executionId", "code"].includes(key)) ||
      typeof source.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || seen.has(source.sourceSha256) ||
      typeof source.executionId !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(source.executionId) ||
      !failureCodes.has(source.code as PublicWebReadFailureCode)) return;
    seen.add(source.sourceSha256);
    sources.push({ sourceSha256: source.sourceSha256, executionId: source.executionId, code: source.code as PublicWebReadFailureCode });
  }
  return { version: 1, tenantId: scope.tenantId, actorId: scope.actorId, runId: scope.runId, sources };
}

/** One run's failed public reads. This tracks observations, never permission,
 * and performs no requests. Callers still own admission, budgets and auditing. */
export function createPublicWebReadRecoveryTracker(inputScope: RecoveryScope, seed?: unknown) {
  const scope = { tenantId: inputScope.tenantId, actorId: inputScope.actorId, runId: inputScope.runId };
  if (!validScope(scope)) throw new Error("Public source recovery requires a bounded tenant, actor and run scope.");
  const failures = new Map<string, FailedSource>();
  if (seed !== undefined) {
    const snapshot = readPublicWebReadRecoverySnapshot(seed, scope);
    if (!snapshot) throw new Error("Stored public source recovery evidence does not match this run.");
    for (const { sourceSha256, ...source } of snapshot.sources) failures.set(sourceSha256, source);
  }
  return {
    observe(execution: ToolExecutionRecord) {
      if (execution.tenantId !== scope.tenantId || execution.actorId !== scope.actorId ||
        execution.toolId !== "web.read" || execution.status !== "failed" || execution.dryRun ||
        !/^[A-Za-z0-9:._-]{1,200}$/.test(execution.id)) return;
      const failure = readPublicWebReadFailureDetails(record(execution.output)?.webReadFailure);
      if (!failure) return;
      const digest = sourceDigest(execution.input);
      if (!digest || failures.has(digest) || failures.size >= MAX_FAILED_SOURCES) return;
      failures.set(digest, { executionId: execution.id, code: failure.code as PublicWebReadFailureCode });
    },
    snapshot(): PublicWebReadRecoverySnapshot {
      return { version: 1, ...scope, sources: [...failures].map(([sourceSha256, source]) => ({ sourceSha256, ...source })) };
    },
    skip(toolId: string, input: Record<string, unknown>) {
      if (toolId !== "web.read") return;
      const digest = sourceDigest(input);
      const prior = digest ? failures.get(digest) : undefined;
      if (!prior) {
        // A full saved map is itself the durable saturation signal, including
        // for older snapshots. Do not forget later failures and retry them.
        if (failures.size < MAX_FAILED_SOURCES) return;
        return {
          executed: false as const,
          webReadRecovery: {
            version: 1 as const,
            reason: "failure_capacity_reached" as const,
            retrySameSource: false as const,
            nextStep: "This run reached its 128-source failure tracking limit, so no new page request was made. Further page reads are stopped. Use existing evidence or another already admitted tool or search within the remaining budget, and disclose unresolved evidence gaps. This does not mean the proposed URL was previously read or failed.",
          },
        };
      }
      return {
        executed: false as const,
        webReadRecovery: {
          version: 1 as const,
          reason: "source_already_failed" as const,
          priorExecutionId: prior.executionId,
          code: prior.code,
          retrySameSource: false as const,
          nextStep: "This URL already failed in this run; no new request was made. Continue with a different public source or an already admitted search within the remaining budget. Preserve the original task constraints, do not bypass access restrictions, and disclose any unresolved evidence gap.",
        },
      };
    },
  };
}
