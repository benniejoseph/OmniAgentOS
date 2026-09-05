#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import postgres from "postgres";

const confirmation = required("CONFIRM_CHECKPOINT_CANARY_INTERRUPT");
const databaseUrl = required("OMNIAGENT_MAINTENANCE_DATABASE_URL");
const expectedRevision = required("EXPECTED_REVISION");
const tenantId = required("SMOKE_TENANT_ID");
const flyMachineId = required("FLY_MACHINE_ID");
const flyApp = process.env.FLY_APP?.trim() || "omniagent-os-worker";
const gatewayHealthUrl = "https://omniagent-os-worker.fly.dev/healthz";

if (confirmation !== "restart-production-worker-once") {
  throw new Error("Explicit checkpoint canary interruption confirmation is required.");
}
if (!/^[a-f0-9]{40}$/.test(expectedRevision)) {
  throw new Error("EXPECTED_REVISION must be an exact Git revision.");
}
if (!/^[a-f0-9]{14}$/.test(flyMachineId)) {
  throw new Error("FLY_MACHINE_ID is invalid.");
}

const startedAt = new Date().toISOString();
const deadline = Date.now() + 240_000;
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 0,
  max_lifetime: null,
});

try {
  await requireExactWorkerHealth();
  const fenced = await waitForFencedResume();
  const stop = spawnSync(
    "fly",
    [
      "machine",
      "kill",
      flyMachineId,
      "--app",
      flyApp,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (stop.status !== 0) {
    throw new Error("Fly could not kill the fenced checkpoint canary worker.");
  }
  const start = spawnSync(
    "fly",
    ["machine", "start", flyMachineId, "--app", flyApp],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (start.status !== 0) {
    throw new Error("Fly could not restart the interrupted checkpoint worker.");
  }
  await waitForExactWorkerHealth();
  const proof = await waitForRecoveryProof(fenced.runId);
  console.log(JSON.stringify({
    status: "PASS",
    revision: expectedRevision,
    tenantId,
    runId: fenced.runId,
    checkpointId: fenced.checkpointId,
    interruptedLeaseGeneration: fenced.leaseGeneration,
    recoveredLeaseGeneration: proof.leaseGeneration,
    runStatus: proof.runStatus,
    claimStatus: proof.claimStatus,
    reclaimedEventCount: proof.reclaimedEventCount,
    externalEffectCount: proof.externalEffectCount,
    effectReceiptCount: proof.effectReceiptCount,
  }));
} finally {
  await sql.end({ timeout: 5 });
}

async function waitForFencedResume() {
  for (;;) {
    const rows = await sql`
      SELECT r.id AS run_id, claim.checkpoint_id, claim.lease_generation
      FROM omni_agent_runs r
      JOIN omni_run_checkpoint_resume_claims claim
        ON claim.tenant_id = r.tenant_id AND claim.run_id = r.id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'resuming'
        AND r.started_at >= ${startedAt}::timestamptz
        AND claim.status = 'claimed'
      ORDER BY r.started_at DESC
      LIMIT 2
    `;
    if (rows.length > 1) {
      throw new Error("Checkpoint canary interruption target was ambiguous.");
    }
    if (rows.length === 1) {
      return {
        runId: String(rows[0].run_id),
        checkpointId: String(rows[0].checkpoint_id),
        leaseGeneration: Number(rows[0].lease_generation),
      };
    }
    assertWithinDeadline("Timed out waiting for a fenced checkpoint resume.");
    await pause(50);
  }
}

async function waitForRecoveryProof(runId) {
  for (;;) {
    const rows = await sql`
      SELECT r.status AS run_status,
             claim.status AS claim_status,
             claim.lease_generation,
             COALESCE(checkpoints.external_effect_count, 0)::int AS external_effect_count,
             COALESCE(tools.effect_receipt_count, 0)::int AS effect_receipt_count,
             COALESCE(events.reclaimed_event_count, 0)::int AS reclaimed_event_count
      FROM omni_agent_runs r
      JOIN omni_run_checkpoint_resume_claims claim
        ON claim.tenant_id = r.tenant_id AND claim.run_id = r.id
      LEFT JOIN LATERAL (
        SELECT MAX(
          (checkpoint_json->'resourceUsage'->>'externalEffectCount')::int
        ) AS external_effect_count
        FROM omni_run_checkpoints checkpoint
        WHERE checkpoint.tenant_id = r.tenant_id
          AND checkpoint.run_id = r.id
      ) checkpoints ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE execution.effect_receipt IS NOT NULL)
          AS effect_receipt_count
        FROM omni_tool_executions execution
        WHERE COALESCE(execution.tenant_id, 'default') = r.tenant_id
          AND execution.id IN (
            SELECT checkpoint.boundary_id
            FROM omni_run_checkpoints checkpoint
            WHERE checkpoint.tenant_id = r.tenant_id
              AND checkpoint.run_id = r.id
              AND checkpoint.boundary_kind IN ('approval', 'tool')
          )
      ) tools ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS reclaimed_event_count
        FROM omni_events event
        WHERE event.tenant_id = r.tenant_id
          AND event.stream_id = ${`run:${runId}`}
          AND event.type = 'run.checkpoint.resume_reclaimed'
      ) events ON true
      WHERE r.tenant_id = ${tenantId} AND r.id = ${runId}
      LIMIT 2
    `;
    if (rows.length !== 1) {
      throw new Error("Checkpoint recovery proof row was missing or ambiguous.");
    }
    const row = rows[0];
    const proof = {
      runStatus: String(row.run_status),
      claimStatus: String(row.claim_status),
      leaseGeneration: Number(row.lease_generation),
      externalEffectCount: Number(row.external_effect_count),
      effectReceiptCount: Number(row.effect_receipt_count),
      reclaimedEventCount: Number(row.reclaimed_event_count),
    };
    if (
      proof.runStatus === "completed" &&
      proof.claimStatus === "completed" &&
      proof.leaseGeneration >= 2 &&
      proof.reclaimedEventCount >= 1 &&
      proof.externalEffectCount === 0 &&
      proof.effectReceiptCount === 0
    ) {
      return proof;
    }
    if (["failed", "canceled"].includes(proof.runStatus)) {
      throw new Error(`Interrupted checkpoint canary ended as ${proof.runStatus}.`);
    }
    assertWithinDeadline("Timed out waiting for checkpoint recovery proof.");
    await pause(500);
  }
}

async function requireExactWorkerHealth() {
  const response = await fetch(gatewayHealthUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.status !== "healthy" || body.revision !== expectedRevision) {
    throw new Error("Worker health does not match the expected canary revision.");
  }
}

async function waitForExactWorkerHealth() {
  for (;;) {
    try {
      await requireExactWorkerHealth();
      return;
    } catch {
      assertWithinDeadline("Worker did not recover after the canary interruption.");
      await pause(500);
    }
  }
}

function assertWithinDeadline(message) {
  if (Date.now() >= deadline) throw new Error(message);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
