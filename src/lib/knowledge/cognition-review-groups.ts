import type {
  KnowledgeCognitionRecord,
  KnowledgeCognitionStatus,
} from "@/lib/knowledge/cognification-store";
import type { CognificationClaimCandidateV1 } from "@/lib/knowledge/cognification-contract";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_RECORDS = 128;
export const KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_CLAIMS = 2_048;
export const KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_TOKENS_PER_CLAIM = 512;

const MAX_CLAIMS_PER_RECORD = 32;
const MAX_BLOCK_BUCKET_SIZE = 96;
const MAX_BLOCK_TOKENS_PER_CLAIM = 3;
const MAX_PAIR_COMPARISONS = 50_000;
const MAX_REVIEW_GROUPS = 2_048;
const MAX_PROJECTED_REFERENCES = 32_768;
const DUPLICATE_SCORE_THRESHOLD = 8_500;
const CONTRADICTION_SCORE_THRESHOLD = 8_800;

const epistemicKinds = new Set([
  "fact",
  "procedure",
  "opinion",
  "prediction",
]);
const reviewStatuses = new Set<KnowledgeCognitionStatus>([
  "pending_review",
  "confirmed",
  "dismissed",
]);
const negativeTokens = new Set([
  "cannot",
  "neither",
  "never",
  "no",
  "none",
  "nor",
  "not",
  "without",
]);
const insignificantTokens = new Set(["a", "an", "the"]);

export type KnowledgeCognitionClaimPolarity = "affirmed" | "negated";
export type KnowledgeCognitionReviewGroupKind =
  | "duplicate"
  | "contradiction";

export type KnowledgeCognitionClaimReference = Readonly<{
  candidateContractSha256: string;
  batchId: string;
  claimCandidateId: string;
  claimIndex: number;
  documentId: string;
  sourceItemId: string;
  sourceRevisionId: string;
  status: "pending_review" | "confirmed";
  epistemicKind: CognificationClaimCandidateV1["epistemicKind"];
  polarity: KnowledgeCognitionClaimPolarity;
}>;

/**
 * A deterministic review hint. It relates candidates; it does not establish
 * truth, change review state, or promote any model-authored content.
 */
export type KnowledgeCognitionReviewGroup = Readonly<{
  groupId: string;
  kind: KnowledgeCognitionReviewGroupKind;
  epistemicKind: CognificationClaimCandidateV1["epistemicKind"];
  scoreBasisPoints: number;
  confidenceBasisPoints: number;
  references: readonly KnowledgeCognitionClaimReference[];
}>;

type PreparedClaim = Readonly<{
  reference: KnowledgeCognitionClaimReference;
  confidenceBasisPoints: number;
  semanticTokens: readonly string[];
  orderedSemanticKey: string;
  polarity: KnowledgeCognitionClaimPolarity;
}>;

type ClaimEdge = Readonly<{
  left: number;
  right: number;
  scoreBasisPoints: number;
}>;

/**
 * Projects bounded, actor-private duplicate and likely-contradiction review
 * groups from already validated cognition records. Confirmed records are used
 * only as the current comparison set. Every emitted group contains at least
 * one pending candidate and remains review-only.
 */
export function projectKnowledgeCognitionReviewGroups(input: Readonly<{
  tenantId: string;
  actorId: string;
  records: readonly KnowledgeCognitionRecord[];
}>): readonly KnowledgeCognitionReviewGroup[] {
  const tenantId = parseScopeId(input.tenantId, "tenant");
  const actorId = parseScopeId(input.actorId, "actor");
  if (!Array.isArray(input.records)) {
    throw new Error("Knowledge cognition review records must be an array.");
  }
  if (input.records.length > KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_RECORDS) {
    throw new Error("Knowledge cognition review record limit exceeded.");
  }

  const claims: PreparedClaim[] = [];
  const referenceKeys = new Set<string>();
  for (const record of input.records) {
    assertActorScope(record, tenantId, actorId);
    if (record.status === "dismissed") continue;
    if (!Array.isArray(record.candidate.claims)) {
      throw new Error("Knowledge cognition claims must be an array.");
    }
    if (record.candidate.claims.length > MAX_CLAIMS_PER_RECORD) {
      throw new Error("Knowledge cognition record claim limit exceeded.");
    }
    for (const [claimIndex, claim] of record.candidate.claims.entries()) {
      if (claims.length === KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_CLAIMS) {
        throw new Error("Knowledge cognition review claim limit exceeded.");
      }
      const prepared = prepareClaim(record, claim, claimIndex, record.status);
      const key = referenceKey(prepared.reference);
      if (referenceKeys.has(key)) {
        throw new Error("Duplicate knowledge cognition claim reference.");
      }
      referenceKeys.add(key);
      claims.push(prepared);
    }
  }
  if (claims.length < 2 || !claims.some(isPendingClaim)) {
    return Object.freeze([]);
  }

  const duplicateSets = new DisjointSets(claims.length);
  const duplicateEdges: ClaimEdge[] = [];
  unionExactDuplicates(claims, duplicateSets, duplicateEdges);

  const comparisonPairs = buildComparisonPairs(claims);
  const contradictionEdges: ClaimEdge[] = [];
  for (const pair of comparisonPairs) {
    const [leftIndex, rightIndex] = parsePairKey(pair);
    const left = claims[leftIndex];
    const right = claims[rightIndex];
    if (left.reference.epistemicKind !== right.reference.epistemicKind) {
      continue;
    }
    const scoreBasisPoints = semanticSimilarityBasisPoints(left, right);
    if (
      left.polarity === right.polarity &&
      scoreBasisPoints >= DUPLICATE_SCORE_THRESHOLD
    ) {
      duplicateSets.union(leftIndex, rightIndex);
      duplicateEdges.push({ left: leftIndex, right: rightIndex, scoreBasisPoints });
    } else if (
      left.polarity !== right.polarity &&
      scoreBasisPoints >= CONTRADICTION_SCORE_THRESHOLD
    ) {
      contradictionEdges.push({
        left: leftIndex,
        right: rightIndex,
        scoreBasisPoints,
      });
    }
  }

  const duplicateGroups = buildDuplicateGroups(
    claims,
    duplicateSets,
    duplicateEdges,
  );
  const contradictionGroups = buildContradictionGroups(
    claims,
    duplicateSets,
    contradictionEdges,
  );
  const groups = [...duplicateGroups, ...contradictionGroups];
  if (
    groups.length > MAX_REVIEW_GROUPS ||
    groups.reduce((total, group) => total + group.references.length, 0) >
      MAX_PROJECTED_REFERENCES
  ) {
    throw new Error("Knowledge cognition review projection limit exceeded.");
  }
  groups.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.groupId.localeCompare(right.groupId)
  );
  return deepFreeze(groups);
}

function prepareClaim(
  record: KnowledgeCognitionRecord,
  claim: CognificationClaimCandidateV1,
  claimIndex: number,
  status: "pending_review" | "confirmed",
): PreparedClaim {
  assertContractHash(record.candidate.contractSha256);
  assertContractId(record.candidate.batchId, "cognition batch");
  assertContractId(record.candidate.documentId, "cognition document");
  assertContractId(record.candidate.sourceItemId, "cognition source item");
  assertContractId(record.candidate.sourceRevisionId, "cognition source revision");
  assertContractId(claim.candidateId, "cognition claim");
  if (
    typeof claim.statement !== "string" ||
    !claim.statement.trim() ||
    claim.statement.length > 1_200
  ) {
    throw new Error("Knowledge cognition claim statement is invalid.");
  }
  if (!epistemicKinds.has(claim.epistemicKind)) {
    throw new Error("Knowledge cognition claim epistemic kind is invalid.");
  }
  if (
    !Number.isInteger(claim.confidenceBasisPoints) ||
    claim.confidenceBasisPoints < 0 ||
    claim.confidenceBasisPoints > 10_000
  ) {
    throw new Error("Knowledge cognition claim confidence is invalid.");
  }

  const normalized = normalizeClaim(claim.statement);
  return {
    reference: {
      candidateContractSha256: record.candidate.contractSha256,
      batchId: record.candidate.batchId,
      claimCandidateId: claim.candidateId,
      claimIndex,
      documentId: record.candidate.documentId,
      sourceItemId: record.candidate.sourceItemId,
      sourceRevisionId: record.candidate.sourceRevisionId,
      status,
      epistemicKind: claim.epistemicKind,
      polarity: normalized.polarity,
    },
    confidenceBasisPoints: claim.confidenceBasisPoints,
    semanticTokens: normalized.semanticTokens,
    orderedSemanticKey: normalized.semanticTokens.join("\u0001"),
    polarity: normalized.polarity,
  };
}

function normalizeClaim(statement: string): Readonly<{
  semanticTokens: readonly string[];
  polarity: KnowledgeCognitionClaimPolarity;
}> {
  const normalizedContractions = statement.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\bwon[\u2019']t\b/gu, "will not")
    .replace(/\bcan[\u2019']t\b/gu, "can not")
    .replace(/\b([\p{L}]+)n[\u2019']t\b/gu, "$1 not");
  const tokens = normalizedContractions.match(/[\p{L}\p{N}]+/gu) || [];
  if (tokens.length > KNOWLEDGE_COGNITION_REVIEW_GROUP_MAX_TOKENS_PER_CLAIM) {
    throw new Error("Knowledge cognition claim token limit exceeded.");
  }
  const polarity = tokens.some((token) => negativeTokens.has(token))
    ? "negated" as const
    : "affirmed" as const;
  const semanticTokens = tokens.filter((token) =>
    !negativeTokens.has(token) && !insignificantTokens.has(token)
  );
  return {
    semanticTokens: Object.freeze(semanticTokens),
    polarity,
  };
}

function unionExactDuplicates(
  claims: readonly PreparedClaim[],
  sets: DisjointSets,
  edges: ClaimEdge[],
) {
  const exactGroups = new Map<string, number[]>();
  for (const [index, claim] of claims.entries()) {
    if (!claim.semanticTokens.length) continue;
    const key = [
      claim.reference.epistemicKind,
      claim.polarity,
      claim.orderedSemanticKey,
    ].join("\u0000");
    const group = exactGroups.get(key) || [];
    group.push(index);
    exactGroups.set(key, group);
  }
  for (const indices of exactGroups.values()) {
    const first = indices[0];
    for (const index of indices.slice(1)) {
      sets.union(first, index);
      edges.push({ left: first, right: index, scoreBasisPoints: 10_000 });
    }
  }
}

function buildComparisonPairs(claims: readonly PreparedClaim[]) {
  const documentFrequency = new Map<string, number>();
  const exactSemanticGroups = new Map<
    string,
    { affirmed: number[]; negated: number[] }
  >();
  for (const claim of claims) {
    for (const token of new Set(claim.semanticTokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  for (const [index, claim] of claims.entries()) {
    if (!claim.semanticTokens.length) continue;
    const key = `${claim.reference.epistemicKind}\u0000${claim.orderedSemanticKey}`;
    const group = exactSemanticGroups.get(key) || {
      affirmed: [],
      negated: [],
    };
    group[claim.polarity].push(index);
    exactSemanticGroups.set(key, group);
  }

  const buckets = new Map<string, number[]>();
  for (const [index, claim] of claims.entries()) {
    const blockingTokens = [...new Set(claim.semanticTokens)]
      .filter((token) =>
        (documentFrequency.get(token) || 0) <= MAX_BLOCK_BUCKET_SIZE
      )
      .sort((left, right) =>
        (documentFrequency.get(left) || 0) -
          (documentFrequency.get(right) || 0) || left.localeCompare(right)
      )
      .slice(0, MAX_BLOCK_TOKENS_PER_CLAIM);
    for (const token of blockingTokens) {
      const key = `${claim.reference.epistemicKind}\u0000${token}`;
      const bucket = buckets.get(key) || [];
      bucket.push(index);
      buckets.set(key, bucket);
    }
  }

  const pairs = new Set<string>();
  for (const group of exactSemanticGroups.values()) {
    if (!group.affirmed.length || !group.negated.length) continue;
    const pendingAffirmed = group.affirmed.find((index) =>
      isPendingClaim(claims[index])
    );
    const pendingNegated = group.negated.find((index) =>
      isPendingClaim(claims[index])
    );
    if (pendingAffirmed === undefined && pendingNegated === undefined) continue;
    addComparisonPair(
      pairs,
      pendingAffirmed ?? group.affirmed[0],
      pendingNegated ?? group.negated[0],
    );
  }
  for (const bucket of buckets.values()) {
    for (let leftOffset = 0; leftOffset < bucket.length; leftOffset += 1) {
      for (
        let rightOffset = leftOffset + 1;
        rightOffset < bucket.length;
        rightOffset += 1
      ) {
        const left = bucket[leftOffset];
        const right = bucket[rightOffset];
        if (!claims[left] || !claims[right]) continue;
        if (!isPendingClaim(claims[left]) && !isPendingClaim(claims[right])) {
          continue;
        }
        addComparisonPair(pairs, left, right);
      }
    }
  }
  return pairs;
}

function addComparisonPair(pairs: Set<string>, left: number, right: number) {
  pairs.add(pairKey(left, right));
  if (pairs.size > MAX_PAIR_COMPARISONS) {
    throw new Error("Knowledge cognition review comparison limit exceeded.");
  }
}

function semanticSimilarityBasisPoints(
  left: PreparedClaim,
  right: PreparedClaim,
) {
  if (!left.semanticTokens.length || !right.semanticTokens.length) return 0;
  if (left.orderedSemanticKey === right.orderedSemanticKey) return 10_000;
  if (left.semanticTokens.length < 2 || right.semanticTokens.length < 2) {
    return 0;
  }
  const tokenDice = diceCoefficient(
    new Set(left.semanticTokens),
    new Set(right.semanticTokens),
  );
  const bigramDice = diceCoefficient(
    tokenBigrams(left.semanticTokens),
    tokenBigrams(right.semanticTokens),
  );
  const orderBound = 0.75 + 0.25 * bigramDice;
  return Math.round(Math.min(tokenDice, orderBound) * 10_000);
}

function buildDuplicateGroups(
  claims: readonly PreparedClaim[],
  sets: DisjointSets,
  edges: readonly ClaimEdge[],
): KnowledgeCognitionReviewGroup[] {
  const components = componentIndices(claims, sets);
  const scoreByRoot = new Map<number, number>();
  for (const edge of edges) {
    const root = sets.find(edge.left);
    if (sets.find(edge.right) !== root) continue;
    scoreByRoot.set(
      root,
      Math.min(scoreByRoot.get(root) ?? 10_000, edge.scoreBasisPoints),
    );
  }
  const groups: KnowledgeCognitionReviewGroup[] = [];
  for (const indices of components.values()) {
    if (indices.length < 2 || !indices.some((index) => isPendingClaim(claims[index]))) {
      continue;
    }
    const root = sets.find(indices[0]);
    groups.push(buildGroup(
      "duplicate",
      indices.map((index) => claims[index]),
      scoreByRoot.get(root) ?? 10_000,
    ));
  }
  return groups;
}

function buildContradictionGroups(
  claims: readonly PreparedClaim[],
  sets: DisjointSets,
  edges: readonly ClaimEdge[],
): KnowledgeCognitionReviewGroup[] {
  const components = componentIndices(claims, sets);
  const relationGroups = new Map<string, ClaimEdge[]>();
  for (const edge of edges) {
    const leftRoot = sets.find(edge.left);
    const rightRoot = sets.find(edge.right);
    if (leftRoot === rightRoot) continue;
    const key = pairKey(leftRoot, rightRoot);
    const group = relationGroups.get(key) || [];
    group.push(edge);
    relationGroups.set(key, group);
    if (relationGroups.size > MAX_REVIEW_GROUPS) {
      throw new Error("Knowledge cognition review projection limit exceeded.");
    }
  }

  const groups: KnowledgeCognitionReviewGroup[] = [];
  for (const [key, relationEdges] of relationGroups) {
    const [leftRoot, rightRoot] = parsePairKey(key);
    const indices = [
      ...(components.get(leftRoot) || []),
      ...(components.get(rightRoot) || []),
    ];
    if (!indices.some((index) => isPendingClaim(claims[index]))) continue;
    groups.push(buildGroup(
      "contradiction",
      indices.map((index) => claims[index]),
      Math.max(...relationEdges.map((edge) => edge.scoreBasisPoints)),
    ));
  }
  return groups;
}

function buildGroup(
  kind: KnowledgeCognitionReviewGroupKind,
  claims: readonly PreparedClaim[],
  scoreBasisPoints: number,
): KnowledgeCognitionReviewGroup {
  const orderedClaims = [...claims].sort((left, right) =>
    referenceKey(left.reference).localeCompare(referenceKey(right.reference))
  );
  const references = orderedClaims.map((claim) => claim.reference);
  const confidenceBasisPoints = Math.min(
    scoreBasisPoints,
    ...orderedClaims.map((claim) => claim.confidenceBasisPoints),
  );
  const epistemicKind = orderedClaims[0].reference.epistemicKind;
  const groupId = `cognition_review_group_${sourceContractSha256({
    kind,
    epistemicKind,
    references: references.map((reference) => ({
      candidateContractSha256: reference.candidateContractSha256,
      batchId: reference.batchId,
      claimCandidateId: reference.claimCandidateId,
      claimIndex: reference.claimIndex,
    })),
  }).slice(0, 48)}`;
  return {
    groupId,
    kind,
    epistemicKind,
    scoreBasisPoints,
    confidenceBasisPoints,
    references,
  };
}

function componentIndices(
  claims: readonly PreparedClaim[],
  sets: DisjointSets,
) {
  const components = new Map<number, number[]>();
  for (const index of claims.keys()) {
    const root = sets.find(index);
    const group = components.get(root) || [];
    group.push(index);
    components.set(root, group);
  }
  return components;
}

function tokenBigrams(tokens: readonly string[]) {
  const bigrams = new Set<string>();
  for (let index = 1; index < tokens.length; index += 1) {
    bigrams.add(`${tokens[index - 1]}\u0001${tokens[index]}`);
  }
  return bigrams;
}

function diceCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

function isPendingClaim(claim: PreparedClaim) {
  return claim.reference.status === "pending_review";
}

function assertActorScope(
  record: KnowledgeCognitionRecord,
  tenantId: string,
  actorId: string,
) {
  if (!record || typeof record !== "object" || !record.candidate) {
    throw new Error("Knowledge cognition review record is invalid.");
  }
  if (!reviewStatuses.has(record.status)) {
    throw new Error("Knowledge cognition review status is invalid.");
  }
  if (
    record.candidate.tenantId !== tenantId ||
    record.candidate.ownerActorId !== actorId
  ) {
    throw new Error("Knowledge cognition review requires exact actor scope.");
  }
}

function parseScopeId(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 320 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  ) {
    throw new Error(`Knowledge cognition review ${label} is invalid.`);
  }
  return value;
}

function assertContractId(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 320 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  ) {
    throw new Error(`Knowledge ${label} reference is invalid.`);
  }
}

function assertContractHash(value: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Knowledge cognition candidate contract hash is invalid.");
  }
}

function referenceKey(reference: KnowledgeCognitionClaimReference) {
  return [
    reference.candidateContractSha256,
    reference.batchId,
    reference.claimCandidateId,
    reference.claimIndex,
  ].join("\u0000");
}

function pairKey(left: number, right: number) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function parsePairKey(value: string): readonly [number, number] {
  const [left, right] = value.split(":").map(Number);
  return [left, right];
}

class DisjointSets {
  private readonly parents: number[];
  private readonly ranks: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
    this.ranks = Array.from({ length: size }, () => 0);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent !== index) this.parents[index] = this.find(parent);
    return this.parents[index];
  }

  union(left: number, right: number) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = this.ranks[leftRoot];
    const rightRank = this.ranks[rightRoot];
    if (leftRank < rightRank) {
      this.parents[leftRoot] = rightRoot;
    } else if (rightRank < leftRank) {
      this.parents[rightRoot] = leftRoot;
    } else {
      this.parents[rightRoot] = leftRoot;
      this.ranks[leftRoot] += 1;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
