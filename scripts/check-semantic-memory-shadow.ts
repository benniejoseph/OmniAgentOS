import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { scoreSemanticMemoryShadowGate } from
  "../src/lib/evals2/semantic-memory-shadow";

void main();

async function main() {
  const observationPath = process.argv[2];
  if (!observationPath) {
    throw new Error(
      "Usage: npx tsx scripts/check-semantic-memory-shadow.ts <content-free-observation.json>",
    );
  }
  const absolutePath = path.resolve(observationPath);
  const observation = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const report = scoreSemanticMemoryShadowGate(observation);

  process.stdout.write(`${JSON.stringify(report)}\n`);
  assert.equal(
    report.activationReady,
    true,
    `Semantic memory shadow gate failed: ${report.failureCodes.join(", ")}`,
  );
}
