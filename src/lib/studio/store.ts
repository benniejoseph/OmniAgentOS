import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import {
  StudioError,
  type StudioOwner,
  type StudioRecordKind,
  type StudioEvent,
} from "./server-types";

type RecordRow = {
  kind: StudioRecordKind;
  id: string;
  parentId: string | null;
  state: string;
  body: unknown;
  createdAt: string;
  updatedAt: string;
};
type Ledger = {
  records: RecordRow[];
  events: Array<StudioEvent & { runId: string }>;
};
export type StudioTransaction = {
  sql?: SqlClient;
  get<T>(kind: StudioRecordKind, id: string): Promise<T | null>;
  list<T>(
    kind: StudioRecordKind,
    parentId?: string,
    limit?: number,
  ): Promise<T[]>;
  count(kind: StudioRecordKind, states: string[]): Promise<number>;
  put(
    kind: StudioRecordKind,
    id: string,
    body: unknown,
    options?: { parentId?: string; state?: string },
  ): Promise<void>;
  event(
    runId: string,
    type: string,
    message: string,
    options?: Pick<StudioEvent, "nodeId" | "status">,
  ): Promise<StudioEvent>;
  events(runId: string, afterSeq: number): Promise<StudioEvent[]>;
};
const blank = (): Ledger => ({ records: [], events: [] });
const file = (owner: StudioOwner) =>
  getDataPath(
    "studio",
    createHash("sha256")
      .update(JSON.stringify([owner.tenantId, owner.actorId]))
      .digest("hex") + ".json",
  );
export async function withStudioTransaction<T>(
  owner: StudioOwner,
  work: (tx: StudioTransaction) => Promise<T>,
): Promise<T> {
  if (!owner.tenantId || !/^actor:[a-f0-9-]{36}$/.test(owner.actorId))
    throw new StudioError(
      "A signed-in workspace account is required.",
      403,
      "studio_owner_required",
    );
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(
      owner.tenantId,
      [owner.actorId, ...(owner.legacyActorId ? [owner.legacyActorId] : [])],
      () =>
        getSql().transaction(async (sql: SqlClient) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["studio:1", owner.tenantId, owner.actorId])},0))`;
          return work(sqlTransaction(sql, owner));
        }) as Promise<T>,
    );
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production")
    throw new StudioError(
      "Studio requires durable server database storage.",
      503,
      "studio_storage_required",
    );
  let result: T | undefined;
  await updateJsonFile<Ledger>(file(owner), blank(), async (ledger) => {
    result = await work(localTransaction(ledger));
    return ledger;
  });
  return result as T;
}
export async function readStudioRecord<T>(
  owner: StudioOwner,
  kind: StudioRecordKind,
  id: string,
) {
  return withStudioTransaction(owner, (tx) => tx.get<T>(kind, id));
}
export async function listStudioRecords<T>(
  owner: StudioOwner,
  kind: StudioRecordKind,
  parentId?: string,
  limit = 100,
) {
  return withStudioTransaction(owner, (tx) =>
    tx.list<T>(kind, parentId, limit),
  );
}
export async function readLocalStudioRecords(owner: StudioOwner) {
  return readJsonFile<Ledger>(file(owner), blank());
}
function bounded(limit = 100) {
  return Math.max(1, Math.min(200, Math.floor(limit)));
}
function validateBody(body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024)
    throw new StudioError(
      "The saved studio result is too large.",
      413,
      "studio_record_limit",
    );
}
function sqlTransaction(sql: SqlClient, owner: StudioOwner): StudioTransaction {
  return {
    sql,
    async get<T>(kind: StudioRecordKind, id: string) {
      const r =
        await sql`SELECT body FROM omni_studio_records WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.actorId} AND kind=${kind} AND id=${id} FOR UPDATE`;
      return r[0] ? (r[0].body as T) : null;
    },
    async list<T>(kind: StudioRecordKind, parentId?: string, limit = 100) {
      const p = parentId ?? null;
      const r =
        await sql`SELECT body FROM omni_studio_records WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.actorId} AND kind=${kind} AND (${p}::text IS NULL OR parent_id=${p}) ORDER BY created_at DESC,id DESC LIMIT ${bounded(limit)}`;
      return r.map((v) => v.body as T);
    },
    async count(kind, states) {
      const rows =
        await sql`SELECT COUNT(*) AS count FROM omni_studio_records WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.actorId} AND kind=${kind} AND state=ANY(${states}::text[])`;
      return Number(rows[0].count);
    },
    async put(kind, id, body, options = {}) {
      validateBody(body);
      await sql`INSERT INTO omni_studio_records(tenant_id,actor_id,kind,id,parent_id,state,body,created_at,updated_at) VALUES(${owner.tenantId},${owner.actorId},${kind},${id},${options.parentId ?? null},${options.state ?? "active"},${body}::jsonb,clock_timestamp(),clock_timestamp()) ON CONFLICT(tenant_id,actor_id,kind,id) DO UPDATE SET body=EXCLUDED.body,state=EXCLUDED.state,updated_at=clock_timestamp()`;
    },
    async event(runId, type, message, options = {}) {
      const r =
        await sql`INSERT INTO omni_studio_run_events(tenant_id,actor_id,run_id,type,message,node_id,status) VALUES(${owner.tenantId},${owner.actorId},${runId},${type},${message.slice(0, 1000)},${options.nodeId ?? null},${options.status ?? null}) RETURNING seq,created_at`;
      return {
        id: `studio_event_${r[0].seq}`,
        seq: Number(r[0].seq),
        type,
        message: message.slice(0, 1000),
        createdAt: new Date(String(r[0].created_at)).toISOString(),
        ...options,
      };
    },
    async events(runId, afterSeq) {
      const r =
        await sql`SELECT seq,type,message,node_id,status,created_at FROM omni_studio_run_events WHERE tenant_id=${owner.tenantId} AND actor_id=${owner.actorId} AND run_id=${runId} AND seq>${afterSeq} ORDER BY seq ASC LIMIT 200`;
      return r.map((v) => ({
        id: `studio_event_${v.seq}`,
        seq: Number(v.seq),
        type: String(v.type),
        message: String(v.message),
        createdAt: new Date(String(v.created_at)).toISOString(),
        ...(v.node_id ? { nodeId: String(v.node_id) } : {}),
        ...(v.status ? { status: v.status as StudioEvent["status"] } : {}),
      }));
    },
  };
}
function localTransaction(ledger: Ledger): StudioTransaction {
  return {
    async get<T>(kind: StudioRecordKind, id: string) {
      return (ledger.records.find((v) => v.kind === kind && v.id === id)
        ?.body ?? null) as T | null;
    },
    async list<T>(kind: StudioRecordKind, parentId?: string, limit = 100) {
      return ledger.records
        .filter(
          (v) => v.kind === kind && (!parentId || v.parentId === parentId),
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, bounded(limit))
        .map((v) => v.body as T);
    },
    async count(kind, states) {
      return ledger.records.filter(
        (r) => r.kind === kind && states.includes(r.state),
      ).length;
    },
    async put(kind, id, body, options = {}) {
      validateBody(body);
      const at = new Date().toISOString();
      const prev = ledger.records.find((v) => v.kind === kind && v.id === id);
      if (prev) {
        prev.body = body;
        prev.state = options.state ?? prev.state;
        prev.updatedAt = at;
      } else
        ledger.records.push({
          kind,
          id,
          parentId: options.parentId ?? null,
          state: options.state ?? "active",
          body,
          createdAt: at,
          updatedAt: at,
        });
    },
    async event(runId, type, message, options = {}) {
      const seq = (ledger.events.at(-1)?.seq ?? 0) + 1;
      const e = {
        id: `studio_event_${seq}`,
        seq,
        type,
        message: message.slice(0, 1000),
        createdAt: new Date().toISOString(),
        ...options,
      };
      ledger.events.push({ ...e, runId });
      return e;
    },
    async events(runId, afterSeq) {
      return ledger.events
        .filter((e) => e.runId === runId && e.seq > afterSeq)
        .slice(0, 200)
        .map(({ runId: _runId, ...e }) => e);
    },
  };
}
