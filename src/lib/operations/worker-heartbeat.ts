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
  phase: WorkerHeartbeatPhase;
  protocol?: string;
  revision?: string;
  target?: string;
  recordedAt: string;
};

export type WorkerLane = "fast" | "background" | "maintenance" | "all";
export type WorkerHeartbeatPhase = "startup" | "active";

type WorkerHeartbeatFilter = {
  protocol?: string;
  revision?: string;
  target?: string;
};

/**
 * A worker machine's record that it ran a release's work, kept apart from the
 * heartbeat that each startup registration overwrites. `lanes` holds when each
 * lane last did that work.
 */
export type WorkerReleaseActivation = {
  instanceId: string;
  revision: string;
  activatedAt: string;
  lanes: Partial<Record<WorkerLane, string>>;
};

export type WorkerLaneActivity = {
  lane: (typeof monitoredWorkerLanes)[number];
  status: "fresh" | "stale" | "missing";
  ageMs?: number;
};

const monitoredWorkerLanes = ["fast", "background", "maintenance"] as const;

/** How long a lane may go without a heartbeat before it counts as stale. */
export function workerHeartbeatMaxAgeMs() {
  const parsed = Number(process.env.OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2_100_000;
}

export function workerHeartbeatId(instanceId: string, lane: WorkerLane = "all") {
  return `worker_heartbeat_${createHash("sha256")
    .update(`${instanceId.trim() || "dedicated-worker"}:${lane}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function workerReleaseActivationId(instanceId: string, revision: string) {
  return `worker_release_activation_${createHash("sha256")
    .update(`${instanceId.trim() || "dedicated-worker"}:${revision.trim()}`)
    .digest("hex")
    .slice(0, 32)}`;
}

type StoredWorkerHeartbeat = Omit<WorkerHeartbeat, "phase"> & {
  phase?: WorkerHeartbeatPhase;
};

type WorkerHeartbeatLedger = {
  latestByLane?: Partial<Record<WorkerLane, StoredWorkerHeartbeat>>;
  activations?: Record<string, WorkerReleaseActivation>;
};

export async function recordWorkerHeartbeat(input: {
  instanceId: string;
  lane: WorkerLane;
  phase: WorkerHeartbeatPhase;
  protocol?: string;
  revision?: string;
  target?: string;
}) {
  const heartbeat: WorkerHeartbeat = {
    instanceId: input.instanceId.slice(0, 160),
    lane: input.lane,
    phase: input.phase,
    protocol: input.protocol?.slice(0, 40) || undefined,
    revision: input.revision?.slice(0, 160) || undefined,
    target: normalizeWorkerTarget(input.target),
    recordedAt: new Date().toISOString(),
  };
  // Only work proves activation: a held worker registers at startup and
  // does nothing else until its release is activated.
  const activationRevision =
    heartbeat.phase === "active" ? heartbeat.revision : undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseSystemScope(
      "Record the dedicated worker heartbeat for release readiness.",
      async () => {
        await getSql()`
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
              phase: heartbeat.phase,
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
        `;
        if (!activationRevision) return;
        // The first activation time stays; each lane's work time and the
        // row's age, which retention reads, move forward.
        await getSql()`
          INSERT INTO omni_system_health_checks (
            id, tenant_id, status, scope, components, metrics, incidents,
            recovery_actions, latency_ms, created_at
          )
          VALUES (
            ${workerReleaseActivationId(heartbeat.instanceId, activationRevision)},
            'system',
            'healthy',
            'worker_release_activation',
            ${[{
              name: "dedicated_worker_release",
              status: "healthy",
              instanceId: heartbeat.instanceId,
              revision: activationRevision,
              activatedAt: heartbeat.recordedAt,
              lanes: { [heartbeat.lane]: heartbeat.recordedAt },
            }]}::jsonb,
            '{}'::jsonb,
            '[]'::jsonb,
            '[]'::jsonb,
            0,
            ${heartbeat.recordedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            components = jsonb_build_array(
              COALESCE(
                omni_system_health_checks.components -> 0,
                EXCLUDED.components -> 0
              ) || jsonb_build_object(
                'lanes',
                COALESCE(
                  omni_system_health_checks.components -> 0 -> 'lanes',
                  '{}'::jsonb
                ) || (EXCLUDED.components -> 0 -> 'lanes')
              )
            ),
            created_at = EXCLUDED.created_at
        `;
      },
    );
    return heartbeat;
  }

  await updateJsonFile<WorkerHeartbeatLedger>(
    getDataPath("worker-heartbeat.json"),
    {},
    (ledger) => {
      const next: WorkerHeartbeatLedger = {
        ...ledger,
        latestByLane: {
          ...ledger.latestByLane,
          [heartbeat.lane]: heartbeat,
        },
      };
      if (activationRevision) {
        const id = workerReleaseActivationId(
          heartbeat.instanceId,
          activationRevision,
        );
        const previous = ledger.activations?.[id];
        next.activations = {
          ...ledger.activations,
          [id]: {
            instanceId: heartbeat.instanceId,
            revision: activationRevision,
            activatedAt: previous?.activatedAt ?? heartbeat.recordedAt,
            lanes: { ...previous?.lanes, [heartbeat.lane]: heartbeat.recordedAt },
          },
        };
      }
      return next;
    },
  );
  return heartbeat;
}

/**
 * The activation this worker machine recorded for the release it runs, which
 * lets it resume work after a restart that lost its local marker.
 */
export async function getWorkerReleaseActivation(input: {
  instanceId: string;
  revision: string;
}) {
  const instanceId = input.instanceId.slice(0, 160);
  const revision = input.revision.slice(0, 160);
  if (!instanceId.trim() || !revision.trim()) return undefined;
  const activations = await readWorkerReleaseActivations(
    workerReleaseActivationId(instanceId, revision),
  );
  return activations.find(
    (activation) =>
      activation.instanceId === instanceId && activation.revision === revision,
  );
}

export async function listWorkerReleaseActivations(
  filter: { revision?: string } = {},
) {
  const activations = await readWorkerReleaseActivations();
  return filter.revision
    ? activations.filter((activation) => activation.revision === filter.revision)
    : activations;
}

/**
 * How long ago each lane last did release work. A lane that has not worked
 * yet counts from the moment its machine first activated the release.
 */
export function summarizeWorkerLaneActivity(
  activations: WorkerReleaseActivation[],
  options: { maxAgeMs: number; now?: number },
): WorkerLaneActivity[] {
  const now = options.now ?? Date.now();
  return monitoredWorkerLanes.map((lane) => {
    const times = activations
      .map((activation) =>
        Date.parse(activation.lanes[lane] ?? activation.activatedAt),
      )
      .filter(Number.isFinite);
    if (times.length === 0) return { lane, status: "missing" };
    const ageMs = Math.max(0, now - Math.max(...times));
    return {
      lane,
      status: ageMs <= options.maxAgeMs ? "fresh" : "stale",
      ageMs,
    };
  });
}

async function readWorkerReleaseActivations(id?: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseSystemScope(
      "Read the dedicated worker release activations.",
      () =>
        id
          ? getSql()`
              SELECT components
              FROM omni_system_health_checks
              WHERE id = ${id}
                AND scope = 'worker_release_activation'
            `
          : getSql()`
              SELECT components
              FROM omni_system_health_checks
              WHERE scope = 'worker_release_activation'
              ORDER BY created_at DESC
              LIMIT 50
            `,
    );
    return rows.flatMap((row) => {
      const activation = workerReleaseActivation(
        Array.isArray(row?.components) ? row.components[0] : undefined,
      );
      return activation ? [activation] : [];
    });
  }

  const ledger = await readJsonFile<WorkerHeartbeatLedger>(
    getDataPath("worker-heartbeat.json"),
    {},
  );
  return Object.entries(ledger.activations || {}).flatMap(([key, value]) => {
    const activation = id && key !== id ? undefined : workerReleaseActivation(value);
    return activation ? [activation] : [];
  });
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
        phase: workerHeartbeatPhase(component.phase),
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
    Object.values(ledger.latestByLane || {})
      .filter((heartbeat): heartbeat is StoredWorkerHeartbeat => Boolean(heartbeat))
      .map((heartbeat) => ({
        ...heartbeat,
        phase: workerHeartbeatPhase(heartbeat.phase),
      })),
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

function workerReleaseActivation(
  value: unknown,
): WorkerReleaseActivation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.instanceId !== "string" ||
    typeof record.revision !== "string" ||
    typeof record.activatedAt !== "string"
  ) {
    return undefined;
  }
  const lanes: Partial<Record<WorkerLane, string>> = {};
  if (record.lanes && typeof record.lanes === "object") {
    for (const [lane, at] of Object.entries(record.lanes)) {
      if (typeof at === "string" && workerLane(lane) === lane) {
        lanes[lane as WorkerLane] = at;
      }
    }
  }
  return {
    instanceId: record.instanceId,
    revision: record.revision,
    activatedAt: record.activatedAt,
    lanes,
  };
}

function workerLane(value: unknown): WorkerLane {
  return value === "fast" ||
    value === "background" ||
    value === "maintenance"
    ? value
    : "all";
}

function workerHeartbeatPhase(value: unknown): WorkerHeartbeatPhase {
  return value === "active" ? "active" : "startup";
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
