import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileAccessRequestStore,
  type AccessRequestRecord,
} from "@/lib/onboarding/access-request-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("file access-request store", () => {
  it("persists the complete request before returning a receipt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omniagent-access-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "requests.ndjson");
    const store = new FileAccessRequestStore(filePath);
    const record: AccessRequestRecord = {
      id: "request-1",
      tenantId: "tenant-a",
      name: "Ada Operator",
      email: "ada@example.com",
      company: "Example",
      role: "engineering",
      timeline: "30_days",
      useCase: "Review incidents and prepare a remediation plan.",
      status: "pending_review",
      createdAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z",
    };

    const receipt = await store.save(record);
    const saved = JSON.parse((await readFile(filePath, "utf8")).trim()) as Record<string, unknown>;

    expect(receipt).toMatchObject({ id: record.id, storage: "file" });
    expect(saved).toMatchObject({ version: 2, type: "request", record });
    await expect(store.get({ id: record.id, tenantId: "tenant-a" })).resolves.toEqual(record);
    await expect(store.get({ id: record.id, tenantId: "tenant-b" })).resolves.toBeNull();
    await expect(store.list({ tenantId: "tenant-b" })).resolves.toEqual([]);
    await expect(store.list({ tenantId: "tenant-a" })).resolves.toEqual([record]);
    await expect(
      store.count({ tenantId: "tenant-a", status: "pending_review" }),
    ).resolves.toBe(1);
  });

  it("keeps approved requests durable until provisioning completes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omniagent-access-"));
    temporaryDirectories.push(directory);
    const store = new FileAccessRequestStore(path.join(directory, "requests.ndjson"));
    const record: AccessRequestRecord = {
      id: "request-2",
      tenantId: "tenant-a",
      name: "Grace Admin",
      email: "grace@example.com",
      company: "Example",
      role: "operations",
      timeline: "now",
      useCase: "Operate incident response workflows with human approvals.",
      status: "pending_review",
      createdAt: "2026-08-19T11:00:00.000Z",
      updatedAt: "2026-08-19T11:00:00.000Z",
    };
    await store.save(record);

    const reviewed = await store.review({
      id: record.id,
      tenantId: record.tenantId,
      status: "approved",
      reviewedBy: "admin-1",
      reviewNote: "Verified.",
    });

    expect(reviewed).toMatchObject({
      id: record.id,
      status: "provisioning_pending",
      reviewedBy: "admin-1",
      reviewNote: "Verified.",
    });
    await expect(
      store.list({ tenantId: record.tenantId, status: "pending_review" }),
    ).resolves.toEqual([]);
    await expect(
      store.review({
        id: record.id,
        tenantId: record.tenantId,
        status: "declined",
        reviewedBy: "admin-2",
      }),
    ).resolves.toBeNull();
    await expect(
      store.markProvisioned({
        id: record.id,
        tenantId: record.tenantId,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      status: "provisioned",
      provisionedUserId: "user-1",
    });
    await expect(
      store.get({ id: record.id, tenantId: record.tenantId }),
    ).resolves.toMatchObject({
      status: "provisioned",
      provisionedUserId: "user-1",
    });
  });

  it("redacts credentials from request and review free text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omniagent-access-"));
    temporaryDirectories.push(directory);
    const store = new FileAccessRequestStore(
      path.join(directory, "requests.ndjson"),
    );
    const record: AccessRequestRecord = {
      id: "request-redacted",
      tenantId: "tenant-a",
      name: "Security Reviewer",
      email: "security@example.com",
      company: "Example",
      role: "security",
      timeline: "now",
      useCase:
        "Investigate with sk-abcdefghijklmnopqrstuvwxyz1234567890 safely.",
      status: "pending_review",
      createdAt: "2026-08-19T11:00:00.000Z",
      updatedAt: "2026-08-19T11:00:00.000Z",
    };
    await store.save(record);

    await expect(
      store.get({ id: record.id, tenantId: record.tenantId }),
    ).resolves.toMatchObject({
      useCase: "Investigate with [redacted-api-key] safely.",
    });
    await expect(
      store.review({
        id: record.id,
        tenantId: record.tenantId,
        status: "declined",
        reviewedBy: "admin-1",
        reviewNote:
          "Removed postgresql://operator:password@example.test:5432/app",
      }),
    ).resolves.toMatchObject({
      reviewNote: "Removed [redacted-connection-url]",
    });
  });

  it("compacts expired requests without sweeping another tenant", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omniagent-access-"));
    temporaryDirectories.push(directory);
    const store = new FileAccessRequestStore(path.join(directory, "requests.ndjson"));
    const base: AccessRequestRecord = {
      id: "pending-a",
      tenantId: "tenant-a",
      name: "Pending Person",
      email: "pending@example.com",
      company: "Example",
      role: "engineering",
      timeline: "now",
      useCase: "Operate governed workflows for the organization.",
      status: "pending_review",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    await store.save(base);
    await store.save({
      ...base,
      id: "reviewed-a",
      email: "reviewed@example.com",
      status: "provisioned",
      provisionedUserId: "user-1",
      provisionedAt: "2020-01-01T00:00:00.000Z",
    });
    await store.save({
      ...base,
      id: "pending-b",
      tenantId: "tenant-b",
      email: "other@example.com",
    });

    await expect(
      store.sweepRetention({
        pendingBefore: "2021-01-01T00:00:00.000Z",
        reviewedBefore: "2021-01-01T00:00:00.000Z",
        tenantId: "tenant-a",
      }),
    ).resolves.toEqual({ expired: 1, deleted: 1 });

    await expect(store.list({ tenantId: "tenant-a" })).resolves.toEqual([
      expect.objectContaining({
        id: "pending-a",
        status: "declined",
        name: "[expired]",
        email: "expired+pending-a@invalid",
      }),
    ]);
    await expect(store.list({ tenantId: "tenant-b" })).resolves.toEqual([
      expect.objectContaining({ id: "pending-b", status: "pending_review" }),
    ]);
  });
});
