import { localLearnedRerankerModel } from "../src/lib/rag/learned-reranker";
import { evaluateRetrievalRerankerBenchmark } from "../src/lib/rag/retrieval-reranker-benchmark";

const report = evaluateRetrievalRerankerBenchmark();
process.stdout.write(`${JSON.stringify({
  version: report.version,
  model: {
    version: localLearnedRerankerModel.version,
    algorithm: localLearnedRerankerModel.algorithm,
    trainingFixtureVersion: localLearnedRerankerModel.trainingFixtureVersion,
    trainingCaseCount: localLearnedRerankerModel.trainingCaseCount,
    weights: localLearnedRerankerModel.weights,
  },
  passed: report.passed,
  caseCount: report.caseCount,
  thresholds: report.thresholds,
  metrics: {
    baselineTopOneAccuracy: report.baselineTopOneAccuracy,
    learnedTopOneAccuracy: report.learnedTopOneAccuracy,
    topOneAccuracyImprovement: report.topOneAccuracyImprovement,
    baselineMeanReciprocalRank: report.baselineMeanReciprocalRank,
    learnedMeanReciprocalRank: report.learnedMeanReciprocalRank,
    meanReciprocalRankImprovement: report.meanReciprocalRankImprovement,
  },
  failedCaseIds: report.results
    .filter((result) => result.learnedRank !== 1)
    .map((result) => result.id),
}, null, 2)}\n`);

if (!report.passed) process.exitCode = 1;
