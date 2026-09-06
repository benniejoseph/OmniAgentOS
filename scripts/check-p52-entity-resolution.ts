import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { scoreP52EntityResolutionBenchmark } from
  "../src/lib/entities/resolution-benchmark";

const suitePath = path.resolve("evals/p52/entity-resolution.v1.json");
void main();

async function main() {
  const suite = JSON.parse(await readFile(suitePath, "utf8")) as unknown;
  const report = scoreP52EntityResolutionBenchmark(suite);

  process.stdout.write(`${JSON.stringify(report)}\n`);
  assert.equal(
    report.passed,
    true,
    `P5.2 entity-resolution gate failed: ${report.failedCaseIds.join(", ")}`,
  );
}
