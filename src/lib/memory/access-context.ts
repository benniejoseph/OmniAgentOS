import {
  executionScopeFromSecurityContext,
  type ExecutionPrincipalType,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export const MEMORY_ACCESS_CONTEXT_VERSION = 1 as const;

export type MemoryAccessMode = "session" | "project" | "all";
export type MemoryVisibility = "user" | "workspace" | "project";

export type MemoryAccessContext = Readonly<{
  version: typeof MEMORY_ACCESS_CONTEXT_VERSION;
  executionScope: ExecutionScope;
  tenantId: string;
  actorId: string | null;
  projectId: string | null;
  mode: MemoryAccessMode;
}>;

export type SecurityContextMemoryAccessInput = {
  mode: MemoryAccessMode;
  correlationId: string;
  purpose: string;
  executingPrincipalType?: ExecutionPrincipalType;
  executingPrincipalId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  delegationId?: string | null;
  causationId?: string | null;
  contextGrantIds?: readonly string[];
  capabilityGrantIds?: readonly string[];
};

export type LegacyMemoryAccessDiagnostic =
  | "actor_missing"
  | "project_missing_for_project_mode"
  | "legacy_tenant_enforcement";

export function createMemoryAccessContext(input: {
  executionScope: ExecutionScope;
  mode: MemoryAccessMode;
}): MemoryAccessContext {
  return Object.freeze({
    version: MEMORY_ACCESS_CONTEXT_VERSION,
    executionScope: input.executionScope,
    tenantId: input.executionScope.tenantId,
    actorId: input.executionScope.initiatingActorId,
    projectId: input.executionScope.projectId,
    mode: input.mode,
  });
}

export function memoryAccessFromSecurityContext(
  context: SecurityContext,
  input: SecurityContextMemoryAccessInput,
): MemoryAccessContext {
  return createMemoryAccessContext({
    executionScope: executionScopeFromSecurityContext(context, input),
    mode: input.mode,
  });
}

/**
 * P0.1 compatibility adapter. It intentionally preserves current tenant-only
 * retrieval until owner/project columns and policies are introduced in their
 * own additive migration.
 */
export function toLegacyTenantOptions(
  access: MemoryAccessContext,
): Readonly<{ tenantId: string }> {
  return Object.freeze({ tenantId: access.tenantId });
}

export function usesDurableMemory(access: MemoryAccessContext): boolean {
  // The legacy durable index is tenant-scoped. Treating the requested
  // "project" mode as durable would silently broaden it to all tenant memory
  // until P3.1 has a canonical project authority and bound project rows.
  return access.mode === "all";
}

export function legacyMemoryAccessDiagnostics(
  access: MemoryAccessContext,
): readonly LegacyMemoryAccessDiagnostic[] {
  const diagnostics: LegacyMemoryAccessDiagnostic[] = ["legacy_tenant_enforcement"];
  if (!access.actorId) {
    diagnostics.push("actor_missing");
  }
  if (access.mode === "project" && !access.projectId) {
    diagnostics.push("project_missing_for_project_mode");
  }
  return Object.freeze(diagnostics);
}
