import {
  embedLocalMultilingualTexts,
  retrievalEmbeddingCosine,
} from "@/lib/rag/retrieval-embedding";

export const LOCAL_LEARNED_RERANKER_VERSION =
  "asael-local-pairwise-reranker:1" as const;

const FEATURE_ORDER = [
  "semanticSimilarity",
  "lexicalOverlap",
  "baseScore",
  "freshnessScore",
] as const;

type FeatureVector = readonly [number, number, number, number];

export type RetrievalRerankerCandidate<T> = Readonly<{
  value: T;
  text: string;
  baseScore: number;
  freshnessScore?: number;
}>;

export type RetrievalRerankerResult<T> = Readonly<{
  value: T;
  score: number;
  features: Readonly<Record<(typeof FEATURE_ORDER)[number], number>>;
}>;

export type RetrievalRerankerReceipt = Readonly<{
  version: "p4.4-reranker-receipt:1";
  modelVersion: typeof LOCAL_LEARNED_RERANKER_VERSION;
  algorithm: "pairwise_logistic_regression";
  trainingFixtureVersion: typeof TRAINING_FIXTURE_VERSION;
  trainingCaseCount: number;
  candidateCount: number;
  externalDisclosure: false;
}>;

type TrainingCandidate = Readonly<{
  text: string;
  baseScore: number;
  freshnessScore: number;
}>;

type TrainingCase = Readonly<{
  query: string;
  positive: TrainingCandidate;
  negatives: readonly TrainingCandidate[];
}>;

const TRAINING_FIXTURE_VERSION = "p4.4-reranker-training:1" as const;

/**
 * This small, deterministic corpus trains only the four public ranking
 * features. It contains no user or production content and is distinct from
 * the held-out acceptance fixtures in `retrieval-reranker-benchmark.ts`.
 */
const TRAINING_CASES: readonly TrainingCase[] = [
  trainingCase(
    "como desplegar la base de datos",
    "Database deployment procedure and rollback steps",
    ["Customer invoice renewal terms", "Meeting notes for the sales team"],
    0.31,
    0.76,
  ),
  trainingCase(
    "procedure de sauvegarde",
    "Backup procedure for the database worker",
    ["Project ownership record", "Customer billing status"],
    0.72,
    0.48,
  ),
  trainingCase(
    "wer ist der projekt eigentumer",
    "The owner of Project Orion is Mira",
    ["Password rotation process", "Invoice contract renewal"],
    0.44,
    0.63,
  ),
  trainingCase(
    "restauracao do banco de dados",
    "Restore the database from its latest backup",
    ["Customer meeting agenda", "Project contract owner"],
    0.28,
    0.81,
  ),
  trainingCase(
    "पासवर्ड बदलने की प्रक्रिया",
    "Password rotation procedure for the worker",
    ["Database backup status", "Customer invoice meeting"],
    0.66,
    0.38,
  ),
  trainingCase(
    "estado del trabajador desplegado",
    "Current deployment status of the worker",
    ["Invoice renewal process", "Project owner meeting"],
    0.37,
    0.74,
  ),
  trainingCase(
    "renouvellement facture client",
    "Customer invoice renewal contract",
    ["Database restore procedure", "Worker deployment failure"],
    0.79,
    0.42,
  ),
  trainingCase(
    "fehlgeschlagene bereitstellung",
    "Failed deployment incident and recovery",
    ["Billing contract owner", "Database backup meeting"],
    0.35,
    0.69,
  ),
  trainingCase(
    "procedimento de copia do banco",
    "Database backup procedure",
    ["Customer renewal status", "Project owner contract"],
    0.58,
    0.55,
  ),
  trainingCase(
    "परियोजना मालिक की बैठक",
    "Meeting with the project owner",
    ["Invoice renewal procedure", "Failed database worker"],
    0.46,
    0.61,
  ),
] as const;

const learnedWeights = Object.freeze(trainPairwiseModel(TRAINING_CASES));

export const localLearnedRerankerModel = Object.freeze({
  version: LOCAL_LEARNED_RERANKER_VERSION,
  algorithm: "pairwise_logistic_regression" as const,
  featureOrder: FEATURE_ORDER,
  trainingFixtureVersion: TRAINING_FIXTURE_VERSION,
  trainingCaseCount: TRAINING_CASES.length,
  weights: Object.freeze({
    semanticSimilarity: learnedWeights[0],
    lexicalOverlap: learnedWeights[1],
    baseScore: learnedWeights[2],
    freshnessScore: learnedWeights[3],
  }),
  externalDisclosure: false as const,
});

export function rerankRetrievalCandidates<T>(
  query: string,
  candidates: readonly RetrievalRerankerCandidate<T>[],
): { results: RetrievalRerankerResult<T>[]; receipt: RetrievalRerankerReceipt } {
  const queryEmbedding = embedLocalMultilingualTexts([query])[0];
  const results = candidates
    .map((candidate, index) => {
      const features = candidateFeatureVector(query, queryEmbedding, candidate);
      return {
        value: candidate.value,
        score: roundScore(sigmoid(dot(learnedWeights, features))),
        features: featureRecord(features),
        index,
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...result }) => result);
  return {
    results,
    receipt: {
      version: "p4.4-reranker-receipt:1",
      modelVersion: LOCAL_LEARNED_RERANKER_VERSION,
      algorithm: "pairwise_logistic_regression",
      trainingFixtureVersion: TRAINING_FIXTURE_VERSION,
      trainingCaseCount: TRAINING_CASES.length,
      candidateCount: candidates.length,
      externalDisclosure: false,
    },
  };
}

export function lexicalHeuristicScore(
  query: string,
  candidate: Pick<RetrievalRerankerCandidate<unknown>, "text" | "baseScore" | "freshnessScore">,
) {
  return roundScore(
    lexicalOverlap(query, candidate.text) * 0.72 +
      clamp01(candidate.baseScore) * 0.2 +
      clamp01(candidate.freshnessScore || 0) * 0.08,
  );
}

function trainPairwiseModel(cases: readonly TrainingCase[]): FeatureVector {
  const rows = cases.flatMap((training) => {
    const queryEmbedding = embedLocalMultilingualTexts([training.query])[0];
    const positive = candidateFeatureVector(
      training.query,
      queryEmbedding,
      { value: undefined, ...training.positive },
    );
    return training.negatives.map((negative) => ({
      difference: subtract(
        positive,
        candidateFeatureVector(
          training.query,
          queryEmbedding,
          { value: undefined, ...negative },
        ),
      ),
    }));
  });
  const weights = [0, 0, 0, 0];
  const learningRate = 0.16;
  const l2 = 0.002;
  for (let epoch = 0; epoch < 320; epoch += 1) {
    for (const row of rows) {
      const probability = sigmoid(dot(weights, row.difference));
      for (let index = 0; index < weights.length; index += 1) {
        weights[index] += learningRate * (
          (1 - probability) * row.difference[index] - l2 * weights[index]
        );
      }
    }
  }
  return weights.map((weight) => roundScore(weight)) as unknown as FeatureVector;
}

function candidateFeatureVector(
  query: string,
  queryEmbedding: readonly number[],
  candidate: RetrievalRerankerCandidate<unknown>,
): FeatureVector {
  const candidateEmbedding = embedLocalMultilingualTexts([candidate.text])[0];
  return [
    clamp01(retrievalEmbeddingCosine(queryEmbedding, candidateEmbedding)),
    lexicalOverlap(query, candidate.text),
    clamp01(candidate.baseScore),
    clamp01(candidate.freshnessScore || 0),
  ];
}

function trainingCase(
  query: string,
  positiveText: string,
  negativeTexts: readonly string[],
  positiveBaseScore: number,
  negativeBaseScore: number,
): TrainingCase {
  return {
    query,
    positive: {
      text: positiveText,
      baseScore: clamp01(0.58 + positiveBaseScore * 0.25),
      freshnessScore: clamp01(0.55 + positiveBaseScore * 0.1),
    },
    negatives: negativeTexts.map((text, index) => ({
      text,
      baseScore: clamp01(0.25 + negativeBaseScore * 0.22 - index * 0.03),
      freshnessScore: clamp01(0.35 + negativeBaseScore * 0.1 - index * 0.04),
    })),
  };
}

function lexicalOverlap(query: string, candidate: string) {
  const queryTerms = tokens(query);
  if (!queryTerms.length) return 0;
  const candidateTerms = new Set(tokens(candidate));
  return clamp01(
    queryTerms.filter((term) => candidateTerms.has(term)).length /
      queryTerms.length,
  );
}

function tokens(value: string) {
  return Array.from(new Set(
    value
      .normalize("NFKD")
      .toLocaleLowerCase("und")
      .replace(/\p{M}+/gu, "")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 1) || [],
  ));
}

function featureRecord(features: FeatureVector) {
  return Object.freeze({
    semanticSimilarity: features[0],
    lexicalOverlap: features[1],
    baseScore: features[2],
    freshnessScore: features[3],
  });
}

function subtract(left: FeatureVector, right: FeatureVector): FeatureVector {
  return left.map((value, index) => value - right[index]) as unknown as FeatureVector;
}

function dot(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundScore(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
