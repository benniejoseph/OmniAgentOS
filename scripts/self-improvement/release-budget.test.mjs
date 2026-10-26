import assert from "node:assert/strict";
import test from "node:test";
import { releaseVerificationBudget, beginReleaseVerification, readReleaseVerification, releaseVerificationUsage, paidVerificationRequestBudgets, paidVerificationMeasuredCost } from "./release-budget.mjs";
import { writeControllerRunnerReceipt } from "./runner-receipt.mjs";

test("two release phases share one exact ceiling and missing cost stays unknown", () => {
  const budget = releaseVerificationBudget("1000000");
  const first = beginReleaseVerification(budget,"a".repeat(40),"https://example.test");
  assert.equal(first.costMicrousd,500000);
  assert.equal(releaseVerificationUsage(budget).actualMicrousd,null);
  writeControllerRunnerReceipt(first.receiptPath,{revision:first.revision,origin:first.origin,limitMicrousd:500000,actualMicrousd:80,runId:"run-a"});
  readReleaseVerification(first);
  assert.equal(releaseVerificationUsage(budget).actualMicrousd,80);
  beginReleaseVerification(budget,"a".repeat(40),"https://example.test");
  assert.throws(() => beginReleaseVerification(budget,"a".repeat(40),"https://example.test"), /already/);
  assert.equal(releaseVerificationUsage(budget).actualMicrousd,null);
});
test("paid requests have no tool/fallback/retry authority and require persisted bounded actual cost", () => {
  const budgets = paidVerificationRequestBudgets("10000");
  assert.equal(budgets.toolCalls,0); assert.equal(budgets.modelTurns,1); assert.equal(budgets.retries,0);
  assert.throws(() => paidVerificationRequestBudgets("0"));
  const receipt = {provider:"openai",model:"known-model",costKnown:true,estimatedCostUsd:0.0001};
  assert.equal(paidVerificationMeasuredCost(receipt,10000,receipt),100);
  const excessive = {...receipt,estimatedCostUsd:0.011};
  assert.throws(() => paidVerificationMeasuredCost(excessive,10000,excessive));
  assert.throws(() => paidVerificationMeasuredCost({...receipt,costKnown:false},10000,receipt));
  assert.throws(() => paidVerificationMeasuredCost(receipt,10000,{...receipt,estimatedCostUsd:0}));
});
