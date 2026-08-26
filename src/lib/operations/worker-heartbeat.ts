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
  target?: string;
  recordedAt: string;
};

export type WorkerLane = "fast" | "background" | "maintenance" | "all";

type WorkerHeartbeatFilter = {
  protocol?: string;
  revision?: string;
  target?: string;
};

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
  target?: string;
}) {
  const heartbeat: WorkerHeartbeat = {
    instanceId: input.instanceId.slice(0, 160),
    lane: input.lane,
    protocol: input.protocol?.slice(0, 40) || undefined,
    revision: input.revision?.slice(0, 160) || undefined,
    target: normalizeWorkerTarget(input.target),
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
              target: heartbeat.target,
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

export async function getLatestWorkerHeartbeats(
  filter: WorkerHeartbeatFilter = {},
) {
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
    const candidates = rows.map((row) => {
      const component =
        Array.isArray(row?.components) &&
        row.components[0] &&
        typeof row.components[0] === "object"
          ? row.components[0] as Record<string, unknown>
          : {};
      const lane = workerLane(component.lane);
      return {
        instanceId: String(component.instanceId || "unknown"),
        lane,
        protocol: component.protocol
          ? String(component.protocol)
          : undefined,
        revision: component.revision
          ? String(component.revision)
          : undefined,
        target: normalizeWorkerTarget(component.target),
        recordedAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date(String(row.created_at)).toISOString(),
      } satisfies WorkerHeartbeat;
    });
    return selectLatestWorkerHeartbeats(candidates, filter);
  }

  const ledger = await readJsonFile<WorkerHeartbeatLedger>(
    getDataPath("worker-heartbeat.json"),
    {},
  );
  return selectLatestWorkerHeartbeats(
    Object.values(ledger.latestByLane || {}),
    filter,
  );
}

export function selectLatestWorkerHeartbeats(
  candidates: WorkerHeartbeat[],
  filter: WorkerHeartbeatFilter = {},
) {
  const expectedTarget = normalizeWorkerTarget(filter.target);
  const targetFilterRequested = filter.target !== undefined;
  const latestByLane = new Map<WorkerLane, WorkerHeartbeat>();
  for (const heartbeat of candidates) {
    if (
      (filter.protocol && heartbeat.protocol !== filter.protocol) ||
      (filter.revision && heartbeat.revision !== filter.revision) ||
      (targetFilterRequested &&
        (!expectedTarget ||
          normalizeWorkerTarget(heartbeat.target) !== expectedTarget))
    ) {
      continue;
    }
    const current = latestByLane.get(heartbeat.lane);
    if (
      !current ||
      Date.parse(heartbeat.recordedAt) > Date.parse(current.recordedAt)
    ) {
      latestByLane.set(heartbeat.lane, heartbeat);
    }
  }
  return [...latestByLane.values()];
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

function normalizeWorkerTarget(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return url.origin.slice(0, 300);
  } catch {
    return undefined;
  }
}
