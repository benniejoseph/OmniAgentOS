import { randomUUID } from "node:crypto";
import { readFileSync, lstatSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Two existing paid smoke turns, each bound before IO; missing cost is unknown. */
export function releaseVerificationBudget(value) {
  if (value === undefined || value === "") return null;
  const totalMicrousd = Number(value);
  if (!Number.isSafeInteger(totalMicrousd) || totalMicrousd < 20_000 || totalMicrousd > 10_000_000) throw new Error("Release verification requires an exact reserved cost between $0.02 and $10.");
  return { totalMicrousd, phases: [] };
}
export function beginReleaseVerification(budget, revision, origin) {
  if (!budget) return null;
  if (budget.phases.length >= 2) throw new Error("The two reserved release checks have already been attempted.");
  const phase = { revision, origin: new URL(origin).origin, costMicrousd: Math.floor(budget.totalMicrousd / 2),
    receiptPath: path.join(tmpdir(), `asael-release-controller-${randomUUID().replaceAll("-", "")}.json`), actualMicrousd: null, runId: null };
  budget.phases.push(phase);
  return phase;
}
export function readReleaseVerification(phase) {
  if (!phase) return;
  try {
    const info = lstatSync(phase.receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 8192) throw new Error("Invalid cost receipt file.");
    const receipt = JSON.parse(readFileSync(phase.receiptPath, "utf8"));
    if (receipt.version !== 1 || receipt.revision !== phase.revision || receipt.origin !== phase.origin ||
        !Number.isSafeInteger(receipt.actualMicrousd) || receipt.actualMicrousd < 0 || receipt.actualMicrousd > phase.costMicrousd ||
        receipt.limitMicrousd !== phase.costMicrousd || typeof receipt.runId !== "string" || !receipt.runId) throw new Error("Release cost is missing or exceeds its reserved ceiling.");
    phase.actualMicrousd = receipt.actualMicrousd; phase.runId = receipt.runId;
  } finally { try { unlinkSync(phase.receiptPath); } catch {} }
}
export function releaseVerificationUsage(budget) {
  if (!budget) return undefined;
  return { reservedMicrousd: budget.totalMicrousd,
    actualMicrousd: budget.phases.some(phase => phase.actualMicrousd === null) ? null : budget.phases.reduce((sum,phase) => sum + phase.actualMicrousd,0),
    phases: budget.phases.map(({revision,origin,costMicrousd,actualMicrousd,runId}) => ({revision,origin,limitMicrousd:costMicrousd,actualMicrousd,runId})) };
}
export function paidVerificationRequestBudgets(value) {
  const costMicrousd = Number(value);
  if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 10_000 || costMicrousd > 5_000_000) throw new Error("The paid release check has no valid cost reservation.");
  return { modelTurns: 1, tokens: 32_000, costMicrousd, wallTimeMs: 180_000, toolCalls: 0, browserActions: 0, agents: 1, fanOut: 0, retries: 0, replans: 0 };
}
export function paidVerificationMeasuredCost(persisted, limitMicrousd, streamed) {
  if (persisted?.costKnown !== true || streamed?.costKnown !== true ||
      !Number.isFinite(persisted.estimatedCostUsd) || persisted.estimatedCostUsd < 0 ||
      persisted.estimatedCostUsd !== streamed.estimatedCostUsd || persisted.model !== streamed.model ||
      persisted.provider !== "openai" || streamed.provider !== "openai") throw new Error("The persisted paid run has no matching known model cost.");
  const actual = Math.round(persisted.estimatedCostUsd * 1_000_000);
  if (!Number.isSafeInteger(actual) || actual > limitMicrousd) throw new Error("The paid model cost exceeds its reserved ceiling.");
  return actual;
}
