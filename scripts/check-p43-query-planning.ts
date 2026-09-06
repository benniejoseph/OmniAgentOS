import { evaluateRetrievalQueryPlanBenchmark } from "../src/lib/rag/query-planner-benchmark";

const report = evaluateRetrievalQueryPlanBenchmark();
const failedCases = report.results.filter((result) => {
  const expected = [...result.expectedDomains].sort().join(",");
  const actual = [...result.actualDomains].sort().join(",");
  return expected !== actual ||
    result.expectedTemporalMode !== undefined &&
      result.expectedTemporalMode !== result.actualTemporalMode ||
    !result.anchored;
});

process.stdout.write(`${JSON.stringify({
  version: report.version,
  passed: report.passed,
  caseCount: report.caseCount,
  thresholds: report.thresholds,
  metrics: {
    domainPrecision: report.domainPrecision,
    domainRecall: report.domainRecall,
    temporalModeAccuracy: report.temporalModeAccuracy,
    originalQueryAnchorRate: report.originalQueryAnchorRate,
  },
  failedCaseIds: failedCases.map((result) => result.id),
}, null, 2)}\n`);

if (!report.passed || failedCases.length) process.exitCode = 1;
