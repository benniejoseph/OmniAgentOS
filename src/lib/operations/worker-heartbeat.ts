import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type WorkerHeartbeat = {
  instanceId: string;
  lane: WorkerLane;
  protocol?: string;
  revision?: string;
  recordedAt: string;
};

export type WorkerLane = "fast" | "background" | "maintenance" | "all";

export function workerHeartbeatId(instanceId: string, lane: WorkerLane = "all") {
  return `worker_heartbeat_${createHash("sha256")
    .update(`${instanceId.trim() || "dedicated-worker"}:${lane}`)
    .digest("hex")
    .slice(0, 32)}`;
}

type WorkerHeartbeatLedger = {
  latestByLane?: Partial<Record<WorkerLane, WorkerHeartbeat>>;
};

export async function recordWorkerHeartbeat(input: {
  instanceId: string;
  lane: WorkerLane;
  protocol?: string;
  revision?: string;
}) {
  const heartbeat: WorkerHeartbeat = {
    instanceId: input.instanceId.slice(0, 160),
    lane: input.lane,
    protocol: input.protocol?.slice(0, 40) || undefined,
    revision: input.revision?.slice(0, 160) || undefined,
    recordedAt: new Date().toISOString(),
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseSystemScope(
      "Record the dedicated worker heartbeat for release readiness.",
      () =>
        getSql()`
          INSERT INTO omni_system_health_checks (
            id, tenant_id, status, scope, components, metrics, incidents,
            recovery_actions, latency_ms, created_at
          )
          VALUES (
            ${workerHeartbeatId(heartbeat.instanceId, heartbeat.lane)},
            'system',
            'healthy',
            'worker_heartbeat',
            ${[{
              name: "dedicated_worker",
              status: "healthy",
              instanceId: heartbeat.instanceId,
              lane: heartbeat.lane,
              protocol: heartbeat.protocol,
              revision: heartbeat.revision,
            }]}::jsonb,
            '{}'::jsonb,
            '[]'::jsonb,
            '[]'::jsonb,
            0,
            ${heartbeat.recordedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            components = EXCLUDED.components,
            metrics = EXCLUDED.metrics,
            incidents = EXCLUDED.incidents,
            recovery_actions = EXCLUDED.recovery_actions,
            latency_ms = EXCLUDED.latency_ms,
            created_at = EXCLUDED.created_at
        `,
    );
    return heartbeat;
  }

  await updateJsonFile<WorkerHeartbeatLedger>(
    getDataPath("worker-heartbeat.json"),
    {},
    (ledger) => ({
      latestByLane: {
        ...ledger.latestByLane,
        [heartbeat.lane]: heartbeat,
      },
    }),
  );
  return heartbeat;
}

export async function getLatestWorkerHeartbeats() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseSystemScope(
      "Read the dedicated worker heartbeat for release readiness.",
      () =>
        getSql()`
          SELECT components, created_at
          FROM omni_system_health_checks
          WHERE scope = 'worker_heartbeat'
          ORDER BY created_at DESC
          LIMIT 100
        `,
    );
    const latestByLane = new Map<WorkerLane, WorkerHeartbeat>();
    for (const row of rows) {
      const component =
        Array.isArray(row?.components) &&
        row.components[0] &&
        typeof row.components[0] === "object"
          ? row.components[0] as Record<string, unknown>
          : {};
      const lane = workerLane(component.lane);
      if (latestByLane.has(lane)) {
        continue;
      }
      latestByLane.set(lane, {
          instanceId: String(component.instanceId || "unknown"),
          lane,
          protocol: component.protocol
            ? String(component.protocol)
            : undefined,
          revision: component.revision
            ? String(component.revision)
            : undefined,
          recordedAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(String(row.created_at)).toISOString(),
      });
    }
    return [...latestByLane.values()];
  }

  return Object.values((
    await readJsonFile<WorkerHeartbeatLedger>(
      getDataPath("worker-heartbeat.json"),
      {},
    )
  ).latestByLane || {});
}

export async function getLatestWorkerHeartbeat() {
  const heartbeats = await getLatestWorkerHeartbeats();
  return heartbeats.sort(
    (left, right) =>
      Date.parse(right.recordedAt) - Date.parse(left.recordedAt),
  )[0];
}

function workerLane(value: unknown): WorkerLane {
  return value === "fast" ||
    value === "background" ||
    value === "maintenance"
    ? value
    : "all";
}
