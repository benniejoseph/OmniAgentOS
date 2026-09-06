import {
  lexicalHeuristicScore,
  rerankRetrievalCandidates,
} from "@/lib/rag/learned-reranker";

type BenchmarkCandidate = Readonly<{
  id: string;
  text: string;
  baseScore: number;
  freshnessScore: number;
}>;

type BenchmarkCase = Readonly<{
  id: string;
  query: string;
  relevantId: string;
  candidates: readonly BenchmarkCandidate[];
}>;

export const RETRIEVAL_RERANKER_BENCHMARK_VERSION =
  "p4.4-multilingual-reranker-benchmark:1" as const;

export const RETRIEVAL_RERANKER_THRESHOLDS = Object.freeze({
  learnedTopOneAccuracy: 0.9,
  topOneAccuracyImprovement: 0.3,
  meanReciprocalRankImprovement: 0.2,
});

/** Held-out multilingual queries and phrasing are separate from training. */
export const retrievalRerankerBenchmarkCases: readonly BenchmarkCase[] = [
  fixture("es-restore", "como restaurar la copia de la base", "database-restore"),
  fixture("fr-owner", "qui est le proprietaire du projet", "project-owner"),
  fixture("de-invoice", "aktuelle rechnung und verlangerung", "invoice-renewal"),
  fixture("pt-failed-deploy", "implantacao falha do processador", "failed-deployment"),
  fixture("hi-password", "पासवर्ड बदलें प्रक्रिया", "password-rotation"),
  fixture("es-customer-billing", "estado de facturacion del cliente", "customer-billing"),
  fixture("fr-backup", "etapes pour restaurer la sauvegarde", "database-restore"),
  fixture("de-project-status", "aktueller zustand des projekts", "project-status"),
  fixture("pt-meeting", "reuniao com proprietario do projeto", "owner-meeting"),
  fixture("hi-database-backup", "डेटाबेस बैकअप स्थिति", "backup-status"),
  fixture("es-contract", "renovacion del contrato", "contract-renewal"),
  fixture("fr-worker", "statut du deploiement agent", "worker-status"),
  fixture("de-restore", "datenbank wiederherstellen verfahren", "database-restore"),
  fixture("pt-invoice", "fatura do cliente", "customer-invoice"),
  fixture("hi-project-owner", "परियोजना मालिक", "project-owner"),
  fixture("es-incident", "incidente de despliegue fallido", "failed-deployment"),
] as const;

export function evaluateRetrievalRerankerBenchmark(
  cases: readonly BenchmarkCase[] = retrievalRerankerBenchmarkCases,
) {
  let baselineTopOne = 0;
  let learnedTopOne = 0;
  let baselineReciprocalRank = 0;
  let learnedReciprocalRank = 0;
  const results = cases.map((benchmarkCase) => {
    const baseline = benchmarkCase.candidates
      .map((candidate, index) => ({
        id: candidate.id,
        score: lexicalHeuristicScore(benchmarkCase.query, candidate),
        index,
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const learned = rerankRetrievalCandidates(
      benchmarkCase.query,
      benchmarkCase.candidates.map((candidate) => ({
        value: candidate.id,
        text: candidate.text,
        baseScore: candidate.baseScore,
        freshnessScore: candidate.freshnessScore,
      })),
    ).results;
    const baselineRank = rankOf(
      baseline.map((candidate) => candidate.id),
      benchmarkCase.relevantId,
    );
    const learnedRank = rankOf(
      learned.map((candidate) => candidate.value),
      benchmarkCase.relevantId,
    );
    if (baselineRank === 1) baselineTopOne += 1;
    if (learnedRank === 1) learnedTopOne += 1;
    baselineReciprocalRank += 1 / baselineRank;
    learnedReciprocalRank += 1 / learnedRank;
    return {
      id: benchmarkCase.id,
      baselineRank,
      learnedRank,
      baselineTopId: baseline[0]?.id,
      learnedTopId: learned[0]?.value,
    };
  });
  const caseCount = cases.length;
  const baselineTopOneAccuracy = ratio(baselineTopOne, caseCount);
  const learnedTopOneAccuracy = ratio(learnedTopOne, caseCount);
  const baselineMeanReciprocalRank = ratio(baselineReciprocalRank, caseCount);
  const learnedMeanReciprocalRank = ratio(learnedReciprocalRank, caseCount);
  const topOneAccuracyImprovement = round(
    learnedTopOneAccuracy - baselineTopOneAccuracy,
  );
  const meanReciprocalRankImprovement = round(
    learnedMeanReciprocalRank - baselineMeanReciprocalRank,
  );
  return {
    version: RETRIEVAL_RERANKER_BENCHMARK_VERSION,
    caseCount,
    thresholds: RETRIEVAL_RERANKER_THRESHOLDS,
    baselineTopOneAccuracy,
    learnedTopOneAccuracy,
    topOneAccuracyImprovement,
    baselineMeanReciprocalRank,
    learnedMeanReciprocalRank,
    meanReciprocalRankImprovement,
    passed:
      learnedTopOneAccuracy >=
        RETRIEVAL_RERANKER_THRESHOLDS.learnedTopOneAccuracy &&
      topOneAccuracyImprovement >=
        RETRIEVAL_RERANKER_THRESHOLDS.topOneAccuracyImprovement &&
      meanReciprocalRankImprovement >=
        RETRIEVAL_RERANKER_THRESHOLDS.meanReciprocalRankImprovement,
    results,
  };
}

function fixture(
  id: string,
  query: string,
  relevantId: string,
): BenchmarkCase {
  const corpus: readonly BenchmarkCandidate[] = [
    candidate("customer-invoice", "Customer invoice and billing record", 0.62, 0.88),
    candidate("database-restore", "Database backup restore procedure", 0.41, 0.44),
    candidate("project-owner", "Project ownership and owner record", 0.47, 0.51),
    candidate("invoice-renewal", "Latest invoice contract renewal status", 0.54, 0.57),
    candidate("failed-deployment", "Failed worker deployment incident", 0.39, 0.42),
    candidate("password-rotation", "Password rotation procedure", 0.45, 0.48),
    candidate("customer-billing", "Current customer billing status", 0.51, 0.54),
    candidate("project-status", "Latest project status", 0.58, 0.61),
    candidate("owner-meeting", "Meeting with the project owner", 0.43, 0.46),
    candidate("backup-status", "Current database backup status", 0.49, 0.52),
    candidate("contract-renewal", "Contract renewal record", 0.56, 0.59),
    candidate("worker-status", "Worker deployment status", 0.52, 0.55),
  ];
  const relevant = corpus.find((item) => item.id === relevantId);
  if (!relevant) throw new Error(`Missing relevant benchmark candidate ${relevantId}.`);
  const distractors = corpus
    .filter((item) => item.id !== relevantId)
    .sort((left, right) => right.baseScore - left.baseScore)
    .slice(0, 3);
  return {
    id,
    query,
    relevantId,
    candidates: [distractors[0], relevant, distractors[1], distractors[2]],
  };
}

function candidate(
  id: string,
  text: string,
  baseScore: number,
  freshnessScore: number,
): BenchmarkCandidate {
  return { id, text, baseScore, freshnessScore };
}

function rankOf(ids: readonly string[], relevantId: string) {
  const index = ids.indexOf(relevantId);
  return index < 0 ? ids.length + 1 : index + 1;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? round(numerator / denominator) : 1;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
