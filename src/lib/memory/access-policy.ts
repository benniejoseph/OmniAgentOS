import type { ExecutionScope } from "@/lib/security/execution-scope";

const MAX_MEMORY_ACCESS_RECORDS = 512;
const CONTRACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;

export type MemoryAccessDescriptor = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  visibility: "private" | `grant:${string}`;
}>;

export type MemoryAccessSelection = Readonly<{
  visible: readonly MemoryAccessDescriptor[];
  deniedIds: readonly string[];
  invalidRecordCount: number;
}>;

/**
 * Pure, bounded actor/grant boundary used before any memory content is
 * disclosed. Unknown or malformed descriptors are denied rather than treated
 * as tenant-wide workspace data.
 */
export function selectVisibleMemoryDescriptors(
  scope: ExecutionScope,
  records: readonly unknown[],
): MemoryAccessSelection {
  if (records.length > MAX_MEMORY_ACCESS_RECORDS) {
    throw new Error(`Memory access selection is bounded to ${MAX_MEMORY_ACCESS_RECORDS} records.`);
  }
  const seenIds = new Set<string>();
  const visible: MemoryAccessDescriptor[] = [];
  const deniedIds: string[] = [];
  let invalidRecordCount = 0;
  const grantIds = new Set(scope.contextGrantIds);

  for (const candidate of records) {
    const descriptor = parseDescriptor(candidate);
    if (!descriptor) {
      invalidRecordCount += 1;
      continue;
    }
    if (seenIds.has(descriptor.id)) {
      throw new Error("Memory access descriptors must have unique IDs.");
    }
    seenIds.add(descriptor.id);

    const grantId = descriptor.visibility.startsWith("grant:")
      ? descriptor.visibility.slice("grant:".length)
      : null;
    const allowed = descriptor.tenantId === scope.tenantId && (
      descriptor.visibility === "private"
        ? scope.initiatingActorId !== null && descriptor.ownerActorId === scope.initiatingActorId
        : grantId !== null && grantIds.has(grantId)
    );
    if (allowed) {
      visible.push(descriptor);
    } else {
      deniedIds.push(descriptor.id);
    }
  }

  return Object.freeze({
    visible: Object.freeze(visible),
    deniedIds: Object.freeze(deniedIds),
    invalidRecordCount,
  });
}

function parseDescriptor(value: unknown): MemoryAccessDescriptor | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["id", "ownerActorId", "tenantId", "visibility"].sort().join("\0")) {
    return null;
  }
  const id = contractId(value.id);
  const tenantId = contractId(value.tenantId);
  const ownerActorId = contractId(value.ownerActorId);
  const visibility = typeof value.visibility === "string" ? value.visibility : "";
  if (!id || !tenantId || !ownerActorId || !validVisibility(visibility)) {
    return null;
  }
  return Object.freeze({ id, tenantId, ownerActorId, visibility });
}

function validVisibility(value: string): value is MemoryAccessDescriptor["visibility"] {
  if (value === "private") return true;
  if (!value.startsWith("grant:")) return false;
  return contractId(value.slice("grant:".length)) !== null;
}

function contractId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 240 && CONTRACT_ID_PATTERN.test(normalized)
    ? normalized
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
