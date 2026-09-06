import { createHash } from "node:crypto";

import { resolveMemoryTier } from "@/lib/memory/tier-policy";
import type { ContextEvidenceItem } from "@/lib/rag/types";

export const CONTEXT_BUDGET_VERSION = "p4.5-context-budget:1" as const;
export const CONTEXT_BUDGET_POLICY_ID =
  "lineage-tier-budget:1" as const;
export const DEFAULT_CONTEXT_TASK_TOKEN_LIMIT = 8_192;
export const DEFAULT_CONTEXT_MODEL_INPUT_TOKEN_LIMIT = 32_768;
export const DEFAULT_CONTEXT_RESERVED_MODEL_TOKENS = 8_192;
export const DEFAULT_DUPLICATE_TOKEN_SHARE_TARGET = 0.2;

export type ContextBudgetTier =
  | "critical"
  | "procedural"
  | "semantic"
  | "episodic"
  | "summary"
  | "graph";

export type ContextBudgetLimits = Readonly<{
  /** Complete provider input limit available to this model request. */
  modelInputTokenLimit?: number;
  /** Tokens reserved for instructions, conversation, tools, and output. */
  reservedModelTokens?: number;
  /** Task-authorized maximum for retrieval context alone. */
  taskContextTokenLimit?: number;
  /** Maximum share attributable to second-or-later items from one lineage. */
  duplicateTokenShareTarget?: number;
}>;

export type ContextBudgetTierAllocation = Readonly<{
  tier: ContextBudgetTier;
  weight: number;
  targetTokens: number;
  allocatedTokens: number;
  selectedCount: number;
}>;

export type ContextBudgetReceipt = Readonly<{
  version: typeof CONTEXT_BUDGET_VERSION;
  policyId: typeof CONTEXT_BUDGET_POLICY_ID;
  estimator: "utf8_byte_upper_bound:1";
  modelInputTokenLimit: number;
  reservedModelTokens: number;
  taskContextTokenLimit: number;
  effectiveTokenLimit: number;
  estimatedTokens: number;
  withinBudget: true;
  candidateCount: number;
  selectedCount: number;
  uniqueLineageCount: number;
  duplicateCandidateCount: number;
  duplicateSelectedCount: number;
  suppressedDuplicateCount: number;
  truncatedItemCount: number;
  duplicateTokenShareTarget: number;
  duplicateTokenShare: number;
  tierAllocations: readonly ContextBudgetTierAllocation[];
  receiptSha256: string;
}>;

export type BudgetedContextEvidenceItem = ContextEvidenceItem & Required<Pick<
  ContextEvidenceItem,
  "lineageRefSha256" | "contextTier" | "tokenEstimate"
>>;

type NormalizedBudget = Required<ContextBudgetLimits> & {
  effectiveTokenLimit: number;
};

type RenderContext = (items: readonly BudgetedContextEvidenceItem[]) => string;

const TIER_WEIGHTS: Readonly<Record<ContextBudgetTier, number>> = Object.freeze({
  critical: 24,
  procedural: 20,
  semantic: 24,
  episodic: 12,
  summary: 10,
  graph: 10,
});

const TIER_ORDER = Object.freeze(
  (Object.keys(TIER_WEIGHTS) as ContextBudgetTier[]).sort(
    (left, right) => TIER_WEIGHTS[right] - TIER_WEIGHTS[left],
  ),
);

/**
 * A provider-neutral, deliberately conservative upper bound. Byte-fallback
 * tokenizers cannot produce more tokens than the UTF-8 bytes supplied.
 */
export function estimateContextTokens(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function annotateContextEvidenceLineage(
  items: readonly ContextEvidenceItem[],
): BudgetedContextEvidenceItem[] {
  const parents = items.map((_, index) => index);
  const keysByIndex = items.map(lineageKeysForItem);
  const firstByKey = new Map<string, number>();

  for (let index = 0; index < items.length; index += 1) {
    for (const key of keysByIndex[index]) {
      const previous = firstByKey.get(key);
      if (previous === undefined) {
        firstByKey.set(key, index);
      } else {
        union(parents, previous, index);
      }
    }
  }

  const memberKeys = new Map<number, string[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = find(parents, index);
    memberKeys.set(root, [
      ...(memberKeys.get(root) || []),
      ...keysByIndex[index],
    ]);
  }

  return items.map((item, index) => {
    const root = find(parents, index);
    const canonicalKey = [...new Set(memberKeys.get(root) || [])]
      .sort(compareLineageKeys)[0] || `item:${item.kind}:${item.id}`;
    return {
      ...item,
      lineageRefSha256: sha256(canonicalKey),
      contextTier: contextBudgetTier(item),
      tokenEstimate: estimateContextTokens(item.content),
    };
  });
}

export function allocateContextBudget(input: {
  items: readonly BudgetedContextEvidenceItem[];
  limits?: ContextBudgetLimits;
  render: RenderContext;
}): {
  items: BudgetedContextEvidenceItem[];
  contextBlock: string;
  receipt: ContextBudgetReceipt;
} {
  const limits = normalizeBudget(input.limits);
  const emptyContext = input.render([]);
  if (!limits.effectiveTokenLimit) {
    return finalizeAllocation({
      candidates: input.items,
      selected: [],
      contextBlock: "",
      limits,
      allocatedByTier: new Map(),
      duplicateEvidenceTokens: 0,
      evidenceTokens: 0,
    });
  }
  if (estimateContextTokens(emptyContext) > limits.effectiveTokenLimit) {
    return finalizeAllocation({
      candidates: input.items,
      selected: [],
      contextBlock: fitTextToTokenLimit(
        emptyContext,
        limits.effectiveTokenLimit,
      ),
      limits,
      allocatedByTier: new Map(),
      duplicateEvidenceTokens: 0,
      evidenceTokens: 0,
    });
  }

  const baseTokens = estimateContextTokens(emptyContext);
  const evidenceCapacity = Math.max(
    0,
    limits.effectiveTokenLimit - baseTokens,
  );
  const tierTargets = tierTokenTargets(input.items, evidenceCapacity);
  const selected: BudgetedContextEvidenceItem[] = [];
  const selectedIds = new Set<string>();
  const seenLineages = new Set<string>();
  const allocatedByTier = new Map<ContextBudgetTier, number>();
  const originalOrder = compareOriginalOrder(input.items);
  let duplicateEvidenceTokens = 0;
  let evidenceTokens = 0;

  const attempt = (
    candidate: BudgetedContextEvidenceItem,
    requestedDelta: number,
  ) => {
    const isDuplicateLineage = seenLineages.has(candidate.lineageRefSha256);
    const duplicateDeltaLimit = isDuplicateLineage
      ? maximumAdditionalDuplicateTokens(
          evidenceTokens,
          duplicateEvidenceTokens,
          limits.duplicateTokenShareTarget,
        )
      : Number.MAX_SAFE_INTEGER;
    const deltaLimit = Math.min(requestedDelta, duplicateDeltaLimit);
    if (deltaLimit <= 0) return false;
    const fitted = fitCandidate({
      selected,
      candidate,
      render: input.render,
      tokenLimit: limits.effectiveTokenLimit,
      deltaLimit,
      order: originalOrder,
    });
    if (!fitted) return false;
    selected.push(fitted.item);
    selected.sort(originalOrder);
    selectedIds.add(candidateEvidenceId(candidate));
    seenLineages.add(candidate.lineageRefSha256);
    evidenceTokens += fitted.deltaTokens;
    if (isDuplicateLineage) duplicateEvidenceTokens += fitted.deltaTokens;
    allocatedByTier.set(
      candidate.contextTier,
      (allocatedByTier.get(candidate.contextTier) || 0) + fitted.deltaTokens,
    );
    return true;
  };

  // First pass preserves the declared tier shares. A second ranked spill pass
  // reuses quota that an absent or short tier could not consume.
  for (const tier of TIER_ORDER) {
    const target = tierTargets.get(tier) || 0;
    if (!target) continue;
    for (const candidate of input.items) {
      if (candidate.contextTier !== tier) continue;
      const remaining = target - (allocatedByTier.get(tier) || 0);
      if (remaining <= 0) break;
      attempt(candidate, remaining);
    }
  }
  for (const candidate of input.items) {
    if (selectedIds.has(candidateEvidenceId(candidate))) continue;
    const remaining = limits.effectiveTokenLimit - estimateContextTokens(
      input.render(selected),
    );
    if (remaining <= 0) break;
    attempt(candidate, remaining);
  }

  let contextBlock = input.render(selected);
  while (
    selected.length &&
    estimateContextTokens(contextBlock) > limits.effectiveTokenLimit
  ) {
    selected.pop();
    contextBlock = input.render(selected);
  }
  if (estimateContextTokens(contextBlock) > limits.effectiveTokenLimit) {
    contextBlock = fitTextToTokenLimit(
      contextBlock,
      limits.effectiveTokenLimit,
    );
  }

  return finalizeAllocation({
    candidates: input.items,
    selected,
    contextBlock,
    limits,
    allocatedByTier,
    duplicateEvidenceTokens,
    evidenceTokens,
    tierTargets,
  });
}

export function emptyContextBudgetReceipt(
  limits?: ContextBudgetLimits,
): ContextBudgetReceipt {
  const normalized = normalizeBudget(limits);
  return buildReceipt({
    candidates: [],
    selected: [],
    contextBlock: "",
    limits: normalized,
    allocatedByTier: new Map(),
    duplicateEvidenceTokens: 0,
    evidenceTokens: 0,
    tierTargets: new Map(),
  });
}

function finalizeAllocation(input: {
  candidates: readonly BudgetedContextEvidenceItem[];
  selected: readonly BudgetedContextEvidenceItem[];
  contextBlock: string;
  limits: NormalizedBudget;
  allocatedByTier: ReadonlyMap<ContextBudgetTier, number>;
  duplicateEvidenceTokens: number;
  evidenceTokens: number;
  tierTargets?: ReadonlyMap<ContextBudgetTier, number>;
}) {
  return {
    items: [...input.selected],
    contextBlock: input.contextBlock,
    receipt: buildReceipt(input),
  };
}

function buildReceipt(input: {
  candidates: readonly BudgetedContextEvidenceItem[];
  selected: readonly BudgetedContextEvidenceItem[];
  contextBlock: string;
  limits: NormalizedBudget;
  allocatedByTier: ReadonlyMap<ContextBudgetTier, number>;
  duplicateEvidenceTokens: number;
  evidenceTokens: number;
  tierTargets?: ReadonlyMap<ContextBudgetTier, number>;
}): ContextBudgetReceipt {
  const candidateLineageCounts = countLineages(input.candidates);
  const selectedLineageCounts = countLineages(input.selected);
  const duplicateCandidateCount = duplicateCount(candidateLineageCounts);
  const duplicateSelectedCount = duplicateCount(selectedLineageCounts);
  const receiptWithoutDigest = {
    version: CONTEXT_BUDGET_VERSION,
    policyId: CONTEXT_BUDGET_POLICY_ID,
    estimator: "utf8_byte_upper_bound:1" as const,
    modelInputTokenLimit: input.limits.modelInputTokenLimit,
    reservedModelTokens: input.limits.reservedModelTokens,
    taskContextTokenLimit: input.limits.taskContextTokenLimit,
    effectiveTokenLimit: input.limits.effectiveTokenLimit,
    estimatedTokens: estimateContextTokens(input.contextBlock),
    withinBudget: true as const,
    candidateCount: input.candidates.length,
    selectedCount: input.selected.length,
    uniqueLineageCount: selectedLineageCounts.size,
    duplicateCandidateCount,
    duplicateSelectedCount,
    suppressedDuplicateCount: Math.max(
      0,
      duplicateCandidateCount - duplicateSelectedCount,
    ),
    truncatedItemCount: input.selected.filter((item) => item.contentTruncated)
      .length,
    duplicateTokenShareTarget: round(input.limits.duplicateTokenShareTarget),
    duplicateTokenShare: round(
      input.evidenceTokens
        ? input.duplicateEvidenceTokens / input.evidenceTokens
        : 0,
    ),
    tierAllocations: TIER_ORDER.map((tier) => ({
      tier,
      weight: TIER_WEIGHTS[tier],
      targetTokens: input.tierTargets?.get(tier) || 0,
      allocatedTokens: input.allocatedByTier.get(tier) || 0,
      selectedCount: input.selected.filter((item) => item.contextTier === tier)
        .length,
    })),
  };
  return Object.freeze({
    ...receiptWithoutDigest,
    receiptSha256: sha256(JSON.stringify(receiptWithoutDigest)),
  });
}

function fitCandidate(input: {
  selected: readonly BudgetedContextEvidenceItem[];
  candidate: BudgetedContextEvidenceItem;
  render: RenderContext;
  tokenLimit: number;
  deltaLimit: number;
  order: (
    left: BudgetedContextEvidenceItem,
    right: BudgetedContextEvidenceItem,
  ) => number;
}) {
  const beforeTokens = estimateContextTokens(input.render(input.selected));
  const fits = (item: BudgetedContextEvidenceItem) => {
    const ordered = [...input.selected, item].sort(input.order);
    const afterTokens = estimateContextTokens(
      input.render(ordered),
    );
    return {
      fits:
        afterTokens <= input.tokenLimit &&
        afterTokens - beforeTokens <= input.deltaLimit,
      deltaTokens: Math.max(0, afterTokens - beforeTokens),
    };
  };
  const full = fits(input.candidate);
  if (full.fits) return { item: input.candidate, deltaTokens: full.deltaTokens };

  const codePoints = Array.from(input.candidate.content);
  let low = 0;
  let high = codePoints.length;
  let best: { item: BudgetedContextEvidenceItem; deltaTokens: number } | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = truncateContent(codePoints, middle);
    const item = {
      ...input.candidate,
      content,
      tokenEstimate: estimateContextTokens(content),
      contentTruncated: true,
    };
    const result = fits(item);
    if (result.fits) {
      best = { item, deltaTokens: result.deltaTokens };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best && estimateContextTokens(best.item.content) >= 24
    ? best
    : undefined;
}

function truncateContent(codePoints: readonly string[], length: number) {
  if (length >= codePoints.length) return codePoints.join("");
  const raw = codePoints.slice(0, Math.max(0, length)).join("").trimEnd();
  if (!raw) return "";
  const boundary = raw.lastIndexOf(" ");
  const content = boundary >= Math.floor(raw.length * 0.7)
    ? raw.slice(0, boundary)
    : raw;
  return `${content}\n[truncated to context budget]`;
}

function fitTextToTokenLimit(value: string, limit: number) {
  if (estimateContextTokens(value) <= limit) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join("");
    if (estimateContextTokens(candidate) <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function tierTokenTargets(
  items: readonly BudgetedContextEvidenceItem[],
  capacity: number,
) {
  const present = new Set(items.map((item) => item.contextTier));
  const totalWeight = [...present].reduce(
    (sum, tier) => sum + TIER_WEIGHTS[tier],
    0,
  );
  const targets = new Map<ContextBudgetTier, number>();
  if (!totalWeight) return targets;
  let allocated = 0;
  for (const tier of TIER_ORDER) {
    if (!present.has(tier)) continue;
    const target = Math.floor(capacity * TIER_WEIGHTS[tier] / totalWeight);
    targets.set(tier, target);
    allocated += target;
  }
  const first = TIER_ORDER.find((tier) => present.has(tier));
  if (first) targets.set(first, (targets.get(first) || 0) + capacity - allocated);
  return targets;
}

function contextBudgetTier(item: ContextEvidenceItem): ContextBudgetTier {
  if (item.kind === "knowledge") return "semantic";
  if (item.kind === "graph") return "graph";
  switch (resolveMemoryTier(item.result.record.tier, item.result.record.type)) {
    case "commitment":
    case "decision":
    case "preference":
      return "critical";
    case "procedural":
      return "procedural";
    case "semantic":
      return "semantic";
    case "working":
    case "episodic":
      return "episodic";
    case "summary":
      return "summary";
  }
}

function lineageKeysForItem(item: ContextEvidenceItem) {
  const keys = new Set<string>();
  const contentKey = normalizedContentKey(item.content);
  if (contentKey) keys.add(contentKey);

  if (item.kind === "knowledge") {
    const { chunk, document } = item.result;
    if (chunk.sourceRevisionId) keys.add(`source-revision:${chunk.sourceRevisionId}`);
    if (document?.sourceRevisionId) keys.add(`source-revision:${document.sourceRevisionId}`);
    if (document?.sourceItemId) keys.add(`source-item:${document.sourceItemId}`);
    if (chunk.evidenceUnitId) keys.add(`evidence:${chunk.evidenceUnitId}`);
    keys.add(`knowledge:${document?.id || chunk.documentId}`);
  } else if (item.kind === "memory") {
    const record = item.result.record;
    keys.add(`memory:${record.duplicateOfMemoryId || record.supersedesId || record.contradictionOfId || record.id}`);
    if (resolveMemoryTier(record.tier, record.type) !== "summary") {
      for (const reference of record.evidenceRefs || []) {
        const normalized = reference.trim().slice(0, 500);
        if (!normalized) continue;
        keys.add(
          /^(?:evidence|knowledge|memory|source-revision|source-item):/.test(
            normalized,
          )
            ? normalized
            : `evidence-ref:${normalized}`,
        );
      }
    }
  } else {
    const memoryIds = [
      ...item.result.node.memoryIds,
      ...item.result.neighborhood.flatMap((neighbor) => neighbor.node.memoryIds),
    ];
    if (new Set(memoryIds).size === 1) {
      keys.add(`memory:${memoryIds[0]}`);
    } else {
      keys.add(`graph-community:${item.result.communityId}`);
    }
  }

  if (!keys.size) keys.add(`item:${item.kind}:${item.id}`);
  return [...keys];
}

function normalizedContentKey(content: string) {
  const normalized = content
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized.length >= 40 ? `content:${sha256(normalized)}` : undefined;
}

function compareLineageKeys(left: string, right: string) {
  const priority = (value: string) => {
    if (value.startsWith("source-revision:")) return 0;
    if (value.startsWith("source-item:")) return 1;
    if (value.startsWith("knowledge:")) return 2;
    if (value.startsWith("evidence:")) return 3;
    if (value.startsWith("memory:")) return 4;
    if (value.startsWith("evidence-ref:")) return 5;
    if (value.startsWith("graph-community:")) return 6;
    if (value.startsWith("content:")) return 7;
    return 8;
  };
  return priority(left) - priority(right) || left.localeCompare(right);
}

function compareOriginalOrder(original: readonly BudgetedContextEvidenceItem[]) {
  const positions = new Map(
    original.map((item, index) => [candidateEvidenceId(item), index]),
  );
  return (
    left: BudgetedContextEvidenceItem,
    right: BudgetedContextEvidenceItem,
  ) => (positions.get(candidateEvidenceId(left)) || 0) -
    (positions.get(candidateEvidenceId(right)) || 0);
}

function candidateEvidenceId(item: ContextEvidenceItem) {
  return `${item.kind}:${item.id}`;
}

function normalizeBudget(limits: ContextBudgetLimits = {}): NormalizedBudget {
  const modelInputTokenLimit = boundedInteger(
    limits.modelInputTokenLimit,
    DEFAULT_CONTEXT_MODEL_INPUT_TOKEN_LIMIT,
  );
  const reservedModelTokens = Math.min(
    modelInputTokenLimit,
    boundedInteger(
      limits.reservedModelTokens,
      DEFAULT_CONTEXT_RESERVED_MODEL_TOKENS,
    ),
  );
  const taskContextTokenLimit = boundedInteger(
    limits.taskContextTokenLimit,
    DEFAULT_CONTEXT_TASK_TOKEN_LIMIT,
  );
  const duplicateTokenShareTarget = Math.min(
    0.5,
    Math.max(
      0,
      Number.isFinite(limits.duplicateTokenShareTarget)
        ? Number(limits.duplicateTokenShareTarget)
        : DEFAULT_DUPLICATE_TOKEN_SHARE_TARGET,
    ),
  );
  return {
    modelInputTokenLimit,
    reservedModelTokens,
    taskContextTokenLimit,
    duplicateTokenShareTarget,
    effectiveTokenLimit: Math.max(
      0,
      Math.min(
        taskContextTokenLimit,
        modelInputTokenLimit - reservedModelTokens,
      ),
    ),
  };
}

function maximumAdditionalDuplicateTokens(
  evidenceTokens: number,
  duplicateTokens: number,
  target: number,
) {
  if (!target || !evidenceTokens) return 0;
  return Math.max(
    0,
    Math.floor((target * evidenceTokens - duplicateTokens) / (1 - target)),
  );
}

function countLineages(items: readonly BudgetedContextEvidenceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(
      item.lineageRefSha256,
      (counts.get(item.lineageRefSha256) || 0) + 1,
    );
  }
  return counts;
}

function duplicateCount(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
}

function find(parents: number[], index: number): number {
  if (parents[index] !== index) parents[index] = find(parents, parents[index]);
  return parents[index];
}

function union(parents: number[], left: number, right: number) {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function boundedInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(1_000_000, Math.max(0, Math.floor(parsed)))
    : fallback;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
