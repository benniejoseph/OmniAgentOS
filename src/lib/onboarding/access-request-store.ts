import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { getDataPath } from "@/lib/storage/paths";
import { withJsonFileLock } from "@/lib/storage/json";

export type AccessRequestStatus =
  | "pending_review"
  | "approved"
  | "provisioning_pending"
  | "provisioned"
  | "declined";

export type AccessRequestRecord = {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  company: string;
  role: "founder" | "engineering" | "product" | "operations" | "security" | "other";
  timeline: "now" | "30_days" | "quarter" | "research";
  useCase: string;
  status: AccessRequestStatus;
  reviewedBy?: string;
  reviewNote?: string;
  reviewedAt?: string;
  provisionedUserId?: string;
  provisionedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AccessRequestReceipt = {
  id: string;
  persistedAt: string;
  storage: "postgres" | "file";
};

export interface AccessRequestStore {
  save(record: AccessRequestRecord): Promise<AccessRequestReceipt>;
  get(input: { id: string; tenantId: string }): Promise<AccessRequestRecord | null>;
  list(options: {
    tenantId: string;
    status?: AccessRequestStatus;
    limit?: number;
  }): Promise<AccessRequestRecord[]>;
  count(options: {
    tenantId: string;
    status?: AccessRequestStatus;
  }): Promise<number>;
  review(input: {
    id: string;
    tenantId: string;
    status: Exclude<AccessRequestStatus, "pending_review">;
    reviewedBy: string;
    reviewNote?: string;
  }): Promise<AccessRequestRecord | null>;
  markProvisioned(input: {
    id: string;
    tenantId: string;
    userId: string;
  }): Promise<AccessRequestRecord | null>;
  sweepRetention(input: {
    pendingBefore: string;
    reviewedBefore: string;
    tenantId?: string;
  }): Promise<{ expired: number; deleted: number }>;
}

export class AccessRequestStoreUnavailableError extends Error {
  constructor(message = "Access request storage is not configured.") {
    super(message);
    this.name = "AccessRequestStoreUnavailableError";
  }
}

export class FileAccessRequestStore implements AccessRequestStore {
  constructor(private readonly filePath: string) {}

  async save(record: AccessRequestRecord): Promise<AccessRequestReceipt> {
    const safeRecord = sanitizeAccessRequestRecord(record);
    await withJsonFileLock(this.filePath, () =>
      this.appendEntry({ version: 2, type: "request", record: safeRecord }));

    return {
      id: safeRecord.id,
      persistedAt: new Date().toISOString(),
      storage: "file",
    };
  }

  async list(options: {
    tenantId: string;
    status?: AccessRequestStatus;
    limit?: number;
  }): Promise<AccessRequestRecord[]> {
    return withJsonFileLock(this.filePath, async () => {
      const records = await this.readRecords();
      return records
        .filter(
          (record) =>
            record.tenantId === options.tenantId &&
            (!options.status || record.status === options.status),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, normalizeLimit(options.limit));
    });
  }

  async get(input: { id: string; tenantId: string }): Promise<AccessRequestRecord | null> {
    return withJsonFileLock(this.filePath, async () => {
      const records = await this.readRecords();
      return records.find(
        (record) => record.id === input.id && record.tenantId === input.tenantId,
      ) || null;
    });
  }

  async count(options: {
    tenantId: string;
    status?: AccessRequestStatus;
  }): Promise<number> {
    return withJsonFileLock(this.filePath, async () => {
      const records = await this.readRecords();
      return records.filter(
        (record) =>
          record.tenantId === options.tenantId &&
          (!options.status || record.status === options.status),
      ).length;
    });
  }

  async review(input: {
    id: string;
    tenantId: string;
    status: Exclude<AccessRequestStatus, "pending_review">;
    reviewedBy: string;
    reviewNote?: string;
  }): Promise<AccessRequestRecord | null> {
    return withJsonFileLock(this.filePath, async () => {
      const current = (await this.readRecords()).find(
        (record) =>
          record.id === input.id &&
          record.tenantId === input.tenantId &&
          record.status === "pending_review",
      );
      if (!current) {
        return null;
      }
      const reviewedAt = new Date().toISOString();
      const nextStatus =
        input.status === "approved" ? "provisioning_pending" : "declined";
      const updated: AccessRequestRecord = {
        ...current,
        status: nextStatus,
        reviewedBy: input.reviewedBy,
        reviewNote: input.reviewNote
          ? String(redactSensitive(input.reviewNote))
          : undefined,
        reviewedAt,
        updatedAt: reviewedAt,
      };
      await this.appendEntry({
        version: 2,
        type: "review",
        id: input.id,
        tenantId: input.tenantId,
        status: nextStatus,
        reviewedBy: input.reviewedBy,
        reviewNote: input.reviewNote
          ? String(redactSensitive(input.reviewNote))
          : undefined,
        reviewedAt,
      });
      return updated;
    });
  }

  async markProvisioned(input: {
    id: string;
    tenantId: string;
    userId: string;
  }): Promise<AccessRequestRecord | null> {
    return withJsonFileLock(this.filePath, async () => {
      const current = (await this.readRecords()).find(
        (record) =>
          record.id === input.id &&
          record.tenantId === input.tenantId &&
          (record.status === "approved" ||
            record.status === "provisioning_pending" ||
            (record.status === "provisioned" &&
              record.provisionedUserId === input.userId)),
      );
      if (!current) {
        return null;
      }
      const provisionedAt = current.provisionedAt || new Date().toISOString();
      const updated: AccessRequestRecord = {
        ...current,
        status: "provisioned",
        provisionedUserId: input.userId,
        provisionedAt,
        updatedAt: provisionedAt,
      };
      await this.appendEntry({
        version: 2,
        type: "provision",
        id: input.id,
        tenantId: input.tenantId,
        userId: input.userId,
        provisionedAt,
      });
      return updated;
    });
  }

  async sweepRetention(input: {
    pendingBefore: string;
    reviewedBefore: string;
    tenantId?: string;
  }) {
    return withJsonFileLock(this.filePath, async () => {
      const records = await this.readRecords();
      const now = new Date().toISOString();
      let expired = 0;
      let deleted = 0;
      const retained: AccessRequestRecord[] = [];
      for (const record of records) {
        if (input.tenantId && record.tenantId !== input.tenantId) {
          retained.push(record);
          continue;
        }
        if (
          record.status === "pending_review" &&
          Date.parse(record.createdAt) < Date.parse(input.pendingBefore)
        ) {
          expired += 1;
          retained.push({
            ...record,
            name: "[expired]",
            email: `expired+${record.id}@invalid`,
            company: "[expired]",
            role: "other",
            useCase: "[expired by retention policy]",
            timeline: "research",
            status: "declined",
            reviewedBy: "retention",
            reviewNote: "Expired before administrator review.",
            reviewedAt: now,
            updatedAt: now,
          });
          continue;
        }
        if (
          (record.status === "declined" ||
            record.status === "provisioned") &&
          Date.parse(record.updatedAt) < Date.parse(input.reviewedBefore)
        ) {
          deleted += 1;
          continue;
        }
        retained.push(record);
      }
      await this.replaceRecords(retained);
      return { expired, deleted };
    });
  }

  private async appendEntry(entry: Record<string, unknown>) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const flags =
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW || 0);
    const handle = await open(this.filePath, flags, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify(entry)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readRecords() {
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }

    const records = new Map<string, AccessRequestRecord>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "request" && isAccessRequestRecord(entry.record)) {
          records.set(entry.record.id, entry.record);
          continue;
        }
        // Version 1 stored the request fields directly on each NDJSON line.
        if (isAccessRequestRecord(entry)) {
          records.set(entry.id, entry);
          continue;
        }
        if (entry.type === "review") {
          const id = typeof entry.id === "string" ? entry.id : "";
          const current = records.get(id);
          if (
            current &&
            entry.tenantId === current.tenantId &&
            (entry.status === "approved" ||
              entry.status === "provisioning_pending" ||
              entry.status === "declined")
          ) {
            records.set(id, {
              ...current,
              status: entry.status,
              reviewedBy: typeof entry.reviewedBy === "string" ? entry.reviewedBy : undefined,
              reviewNote: typeof entry.reviewNote === "string" ? entry.reviewNote : undefined,
              reviewedAt: typeof entry.reviewedAt === "string" ? entry.reviewedAt : undefined,
              updatedAt:
                typeof entry.reviewedAt === "string"
                  ? entry.reviewedAt
                  : current.updatedAt,
            });
          }
          continue;
        }
        if (entry.type === "provision") {
          const id = typeof entry.id === "string" ? entry.id : "";
          const current = records.get(id);
          if (
            current &&
            entry.tenantId === current.tenantId &&
            typeof entry.userId === "string" &&
            typeof entry.provisionedAt === "string"
          ) {
            records.set(id, {
              ...current,
              status: "provisioned",
              provisionedUserId: entry.userId,
              provisionedAt: entry.provisionedAt,
              updatedAt: entry.provisionedAt,
            });
          }
        }
      } catch {
        // Preserve valid entries in an append-only ledger if one line is corrupt.
      }
    }
    return [...records.values()].map(sanitizeAccessRequestRecord);
  }

  private async replaceRecords(records: AccessRequestRecord[]) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.retention-${process.pid}-${crypto.randomUUID()}`;
    const contents = records
      .map((record) => JSON.stringify({ version: 2, type: "request", record }))
      .join("\n");
    try {
      await writeFile(temporaryPath, contents ? `${contents}\n` : "", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

class DatabaseAccessRequestStore implements AccessRequestStore {
  async save(record: AccessRequestRecord): Promise<AccessRequestReceipt> {
    const safeRecord = sanitizeAccessRequestRecord(record);
    await ensureDatabaseSchema();
    await runWithDatabaseTenantScope(safeRecord.tenantId, () =>
      getSql()`
        INSERT INTO omni_access_requests (
          id, tenant_id, name, email, company, role, use_case, timeline,
          status, created_at, updated_at
        )
        VALUES (
          ${safeRecord.id}, ${safeRecord.tenantId}, ${safeRecord.name}, ${safeRecord.email},
          ${safeRecord.company}, ${safeRecord.role}, ${safeRecord.useCase}, ${safeRecord.timeline},
          ${safeRecord.status}, ${safeRecord.createdAt}, ${safeRecord.updatedAt}
        )
      `);
    return {
      id: safeRecord.id,
      persistedAt: safeRecord.createdAt,
      storage: "postgres",
    };
  }

  async list(options: {
    tenantId: string;
    status?: AccessRequestStatus;
    limit?: number;
  }): Promise<AccessRequestRecord[]> {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(options.tenantId, () =>
      getSql()`
        SELECT *
        FROM omni_access_requests
        WHERE tenant_id = ${options.tenantId}
          AND (${options.status || null}::text IS NULL OR status = ${options.status || null})
        ORDER BY created_at DESC
        LIMIT ${normalizeLimit(options.limit)}
      `);
    return rows.map(accessRequestFromRow);
  }

  async get(input: { id: string; tenantId: string }): Promise<AccessRequestRecord | null> {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(input.tenantId, () =>
      getSql()`
        SELECT *
        FROM omni_access_requests
        WHERE id = ${input.id}
          AND tenant_id = ${input.tenantId}
        LIMIT 1
      `);
    return rows[0] ? accessRequestFromRow(rows[0]) : null;
  }

  async count(options: {
    tenantId: string;
    status?: AccessRequestStatus;
  }): Promise<number> {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(options.tenantId, () =>
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_access_requests
        WHERE tenant_id = ${options.tenantId}
          AND (${options.status || null}::text IS NULL OR status = ${options.status || null})
      `);
    return Number(rows[0]?.count || 0);
  }

  async review(input: {
    id: string;
    tenantId: string;
    status: Exclude<AccessRequestStatus, "pending_review">;
    reviewedBy: string;
    reviewNote?: string;
  }): Promise<AccessRequestRecord | null> {
    await ensureDatabaseSchema();
    const reviewedAt = new Date().toISOString();
    const reviewNote = input.reviewNote
      ? String(redactSensitive(input.reviewNote))
      : undefined;
    const nextStatus =
      input.status === "approved" ? "provisioning_pending" : "declined";
    const rows = await runWithDatabaseTenantScope(input.tenantId, () =>
      getSql()`
        UPDATE omni_access_requests
        SET
          status = ${nextStatus},
          reviewed_by = ${input.reviewedBy},
          review_note = ${reviewNote || null},
          reviewed_at = ${reviewedAt},
          updated_at = ${reviewedAt}
        WHERE id = ${input.id}
          AND tenant_id = ${input.tenantId}
          AND status = 'pending_review'
        RETURNING *
      `);
    return rows[0] ? accessRequestFromRow(rows[0]) : null;
  }

  async markProvisioned(input: {
    id: string;
    tenantId: string;
    userId: string;
  }): Promise<AccessRequestRecord | null> {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseTenantScope(input.tenantId, () =>
      getSql()`
        UPDATE omni_access_requests
        SET status = 'provisioned',
            provisioned_user_id = ${input.userId},
            provisioned_at = COALESCE(provisioned_at, NOW()),
            updated_at = NOW()
        WHERE id = ${input.id}
          AND tenant_id = ${input.tenantId}
          AND (
            status IN ('approved', 'provisioning_pending')
            OR (
              status = 'provisioned'
              AND provisioned_user_id = ${input.userId}
            )
          )
        RETURNING *
      `);
    return rows[0] ? accessRequestFromRow(rows[0]) : null;
  }

  async sweepRetention() {
    return { expired: 0, deleted: 0 };
  }
}

export function getAccessRequestStore(): AccessRequestStore {
  if (hasDatabaseUrl()) {
    return new DatabaseAccessRequestStore();
  }

  const configuredPath = process.env.OMNIAGENT_ACCESS_REQUEST_FILE?.trim();
  if (configuredPath) {
    return new FileAccessRequestStore(path.resolve(configuredPath));
  }

  if (process.env.NODE_ENV === "production") {
    throw new AccessRequestStoreUnavailableError(
      "Access request storage is unavailable. Configure a durable access-request store before accepting requests.",
    );
  }

  return new FileAccessRequestStore(getDataPath("access-requests.ndjson"));
}

function accessRequestFromRow(row: Record<string, unknown>): AccessRequestRecord {
  return sanitizeAccessRequestRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    email: String(row.email),
    company: String(row.company),
    role: String(row.role) as AccessRequestRecord["role"],
    useCase: String(row.use_case),
    timeline: String(row.timeline) as AccessRequestRecord["timeline"],
    status: String(row.status) as AccessRequestStatus,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewNote: row.review_note ? String(row.review_note) : undefined,
    reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : undefined,
    provisionedUserId: row.provisioned_user_id
      ? String(row.provisioned_user_id)
      : undefined,
    provisionedAt: row.provisioned_at
      ? new Date(String(row.provisioned_at)).toISOString()
      : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  });
}

function sanitizeAccessRequestRecord(
  record: AccessRequestRecord,
): AccessRequestRecord {
  return {
    ...record,
    useCase: String(redactSensitive(record.useCase)).slice(0, 800),
    reviewNote: record.reviewNote
      ? String(redactSensitive(record.reviewNote)).slice(0, 1_000)
      : undefined,
  };
}

function isAccessRequestRecord(value: unknown): value is AccessRequestRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.email !== "string" ||
    typeof record.company !== "string" ||
    typeof record.role !== "string" ||
    typeof record.timeline !== "string" ||
    typeof record.useCase !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return false;
  }
  const tenantId =
    typeof record.tenantId === "string"
      ? record.tenantId
      : process.env.OMNIAGENT_ACCESS_REQUEST_TENANT_ID ||
        process.env.OMNIAGENT_DEFAULT_TENANT ||
        "default";
  const status: AccessRequestStatus =
    record.status === "approved" ||
    record.status === "provisioning_pending" ||
    record.status === "provisioned" ||
    record.status === "declined"
      ? record.status
      : "pending_review";
  Object.assign(record, {
    tenantId,
    status,
    updatedAt:
      typeof record.updatedAt === "string"
        ? record.updatedAt
        : record.createdAt,
  });
  return true;
}

function normalizeLimit(value?: number) {
  return Math.min(Math.max(Number(value || 50), 1), 200);
}
