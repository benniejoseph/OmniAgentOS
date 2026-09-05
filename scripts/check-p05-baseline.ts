import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseP05ObservationSet,
  scoreP05Suite,
} from "../src/lib/evals2/p05";
import { observeP05Suite } from "../src/lib/evals2/p05-observer";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
void main();

async function main() {
  const suite = await readJson("evals/p05/suite.v1.json");
  const baseline = await readJson("evals/p05/baseline.v1.json");
  const observed = observeP05Suite(suite);
  const parsedBaseline = parseP05ObservationSet(suite, baseline);

  assert.deepEqual(
    parsedBaseline,
    observed,
    "P0.5 baseline is stale. Review the adapter change and update the baseline explicitly.",
  );

  const score = scoreP05Suite(suite, baseline);
  process.stdout.write(
    `${JSON.stringify({
      suiteId: score.suiteId,
      suiteSha256: score.suiteSha256,
      passedCases: score.passedCases,
      totalCases: score.totalCases,
      scoreBasisPoints: score.scoreBasisPoints,
      hardFailure: score.hardFailure,
    })}\n`,
  );
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8"),
  ) as unknown;
}
