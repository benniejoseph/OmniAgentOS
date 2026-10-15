import { z } from "zod";
import {
  checkLocalComputerRecovery,
  recordLocalComputerRecovery,
  restoreLocalComputerRecoveryState,
  snapshotLocalComputerRecovery,
} from "@/lib/local-computer/command-recovery";
import { createPublicWebReadRecoveryTracker } from "@/lib/web-search/recovery";
import type { executeGovernedTool } from "@/lib/tools/executor";
import type { ToolRecoveryConstraint } from "@/lib/tools/recovery-constraint";

type Executor = typeof executeGovernedTool;
type Execution = Pick<Awaited<ReturnType<Executor>>, "record" | "computerObservation" | "precedingRefusal"> & { result?: unknown };
const scopeSchema = z.object({
  tenantId: z.string().min(1).max(256),
  actorId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
}).strict();
type Scope = z.infer<typeof scopeSchema>;
export type RunToolRecoverySnapshot = {
  version: 1;
  scope: Scope;
  web: ReturnType<ReturnType<typeof createPublicWebReadRecoveryTracker>["snapshot"]>;
  mac: ReturnType<typeof snapshotLocalComputerRecovery>;
  observedExecutionIds: string[];
};

const seedSchema = z.object({
  version: z.literal(1), scope: scopeSchema, web: z.unknown(), mac: z.unknown(),
  observedExecutionIds: z.array(z.string().min(1).max(256)).max(1_024),
}).strict();

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Metadata from actual governed receipts only. It can deny repeated attempts,
 * never grant authority, perform an effect, or make a failed action successful. */
export function createRunToolRecovery(inputScope: Scope, seed?: unknown) {
  const scope = scopeSchema.parse(inputScope);
  const saved = seed === undefined ? undefined : seedSchema.parse(seed);
  if (saved && (saved.scope.tenantId !== scope.tenantId ||
    saved.scope.actorId !== scope.actorId || saved.scope.runId !== scope.runId ||
    saved.web === undefined || saved.mac === undefined)) {
    throw new Error("Tool recovery state does not match this run.");
  }
  const web = createPublicWebReadRecoveryTracker(scope, saved?.web);
  const mac = restoreLocalComputerRecoveryState(saved?.mac, scope);
  // A replay of a failed idempotency key is the same attempt, not a new refusal.
  const seen = new Set<string>(saved?.observedExecutionIds);
  function observe(execution: Execution) {
    const refused = execution.precedingRefusal;
    if (refused?.status === "failed" && refused.toolId.startsWith("local.macos.")) {
      observe({ record: refused });
    }
    const { record } = execution;
    if (record.tenantId !== scope.tenantId || record.actorId !== scope.actorId ||
      record.dryRun || !["executed", "failed"].includes(record.status)) return;
    web.observe(record);
    if (!record.toolId.startsWith("local.macos.") || seen.has(record.id)) return;
    if (seen.size >= 1_024) throw new Error("Tool recovery observation limit reached.");
    seen.add(record.id);
    recordLocalComputerRecovery(mac, {
      toolId: record.toolId, input: record.input, status: record.status,
      failure: object(record.output).localComputerFailure,
      observationRevision: execution.computerObservation?.snapshotRevision,
    });
  }
  function constraint(toolId: string, input: Record<string, unknown>): ToolRecoveryConstraint | undefined {
    const skipped = web.skip(toolId, input);
    if (skipped) return { reason: skipped.webReadRecovery.nextStep, output: skipped };
    const decision = checkLocalComputerRecovery(mac, { toolId, input });
    if (!decision.allowed) return {
      reason: decision.guidance,
      output: { executed: false, localComputerRecovery: {
        schemaVersion: 1, code: decision.code, guidance: decision.guidance,
      } },
    };
  }
  function wrap(execute: Executor): Executor {
    return async (input) => {
      if (input.context?.tenantId !== scope.tenantId || input.context.actorId !== scope.actorId ||
        input.agentRunId !== scope.runId) throw new Error("Tool recovery executor scope mismatch.");
      const execution = await execute({ ...input,
        // Only the executor can verify a reviewed approval. A caller's raw
        // approved flag must not erase a refusal or imply new authority.
        recoveryConstraint: input.dryRun ? undefined : constraint(input.toolId, input.input),
      });
      observe(execution);
      return execution;
    };
  }
  function snapshot(): RunToolRecoverySnapshot {
    return { version: 1, scope: { ...scope }, web: web.snapshot(),
      mac: snapshotLocalComputerRecovery(mac, scope), observedExecutionIds: [...seen] };
  }
  return { wrap, observe, snapshot };
}

/** Continuation parsing rebuilds bounded guidance and refuses malformed state. */
export function readRunToolRecoverySnapshot(value: unknown): RunToolRecoverySnapshot | undefined {
  try {
    const parsed = seedSchema.parse(value);
    return createRunToolRecovery(parsed.scope, parsed).snapshot();
  } catch { return undefined; }
}
