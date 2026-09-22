import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispositionRows: [] as Record<string, unknown>[],
  watermark: undefined as Record<string, unknown> | undefined,
  queries: [] as string[],
  enqueueMobilePush: vi.fn(),
  appendNotificationDispositionEvent: vi.fn(async () => undefined),
  appendNotificationDigestEvent: vi.fn(async () => undefined),
}));

type MockSql = ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};

const sql = vi.fn(async (
  strings: TemplateStringsArray,
  ...parameters: unknown[]
) => {
  const query = strings.join("?");
  mocks.queries.push(query);
  if (query.includes("FROM omni_notification_dispositions") && query.includes("FOR UPDATE")) {
    return query.includes("outcome = 'digest'")
      ? mocks.dispositionRows
          .filter((row) => row.outcome === "digest" && row.state === "pending")
          .slice(0, 100)
      : mocks.dispositionRows.slice(0, 1);
  }
  if (query.includes("INSERT INTO omni_notification_dispositions")) {
    const row = dispositionInsertRow(parameters);
    mocks.dispositionRows.splice(0, mocks.dispositionRows.length, row);
    return [row];
  }
  if (query.includes("UPDATE omni_notification_dispositions")) {
    const index = mocks.dispositionRows.findIndex(
      (row) => row.id === parameters[17],
    );
    const row = dispositionUpdateRow(mocks.dispositionRows[index], parameters);
    mocks.dispositionRows.splice(index, 1, row);
    return [row];
  }
  if (query.includes("INSERT INTO omni_notification_digest_watermarks")) {
    mocks.watermark ||= {
      schema_version: 1,
      tenant_id: parameters[0],
      owner_actor_id: parameters[1],
      sequence_number: 0,
      lifecycle_revision: 0,
      last_window_ended_at: null,
      created_at: parameters[2],
      updated_at: parameters[3],
    };
    return [];
  }
  if (query.includes("FROM omni_notification_digest_watermarks")) {
    return mocks.watermark ? [mocks.watermark] : [];
  }
  if (query.includes("INSERT INTO omni_notification_digest_deliveries")) {
    return [];
  }
  if (query.includes("UPDATE omni_notification_digest_watermarks")) {
    mocks.watermark = {
      ...mocks.watermark,
      sequence_number: parameters[0],
      last_window_ended_at: parameters[1],
      last_delivery_id: parameters[2],
      last_candidate_manifest_sha256: parameters[3],
      lifecycle_revision: Number(parameters[7]) + 1,
      updated_at: parameters[4],
    };
    return [{ tenant_id: parameters[5] }];
  }
  return [];
}) as MockSql;

sql.transaction = vi.fn(async (
  operation: (client: typeof sql) => unknown,
) => operation(sql));

vi.mock("@/lib/db/client", () => ({
  getSql: () => sql,
}));

vi.mock("@/lib/mobile/push-store", () => ({
  enqueueMobilePush: mocks.enqueueMobilePush,
}));

vi.mock("@/lib/mobile/notification-decision-events", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("@/lib/mobile/notification-decision-events")
  >(),
  appendNotificationDispositionEvent: mocks.appendNotificationDispositionEvent,
  appendNotificationDigestEvent: mocks.appendNotificationDigestEvent,
}));

import { buildNotificationDecisionV1 } from "@/lib/mobile/notification-decision";
import { notificationDispositionCoordinates } from "@/lib/mobile/notification-delivery-policy";
import { buildNotificationDispositionRecordV1 } from "@/lib/mobile/notification-disposition";
import {
  applyNotificationDispositionDecision,
  flushDueNotificationDigest,
} from "@/lib/mobile/notification-disposition-store";
import { notificationDecisionExecutionScope } from "@/lib/mobile/notification-decision-events";

beforeEach(() => {
  mocks.dispositionRows.splice(0);
  mocks.watermark = undefined;
  mocks.queries.splice(0);
  mocks.enqueueMobilePush.mockReset().mockResolvedValue([]);
  mocks.appendNotificationDispositionEvent.mockClear();
  mocks.appendNotificationDigestEvent.mockClear();
  sql.mockClear();
  sql.transaction.mockClear();
});

describe("notification disposition store", () => {
  it("binds direct delivery once and treats the terminal retry as idempotent", async () => {
    const decision = decisionFor("approval", "2026-09-22T09:00:00.000Z");
    const coordinates = notificationDispositionCoordinates({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      sourceKind: "tool_approval",
      sourceId: "approval-one",
      occurrenceKey: "revision-one",
      decision,
    });
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "approval-one",
      producerId: "test-producer",
      decision,
    });
    const directDelivery = vi.fn(async () => ({
      deliveryKind: "mobile_push_outbox" as const,
      deliveryIds: ["delivery-one"],
      targetSha256: "f".repeat(64),
    }));

    const first = await applyNotificationDispositionDecision({
      coordinates,
      decision,
      executionScope,
      directDelivery,
      now: new Date(decision.evaluatedAt),
    });
    const second = await applyNotificationDispositionDecision({
      coordinates,
      decision,
      executionScope,
      directDelivery,
      now: new Date(decision.evaluatedAt),
    });

    expect(first).toMatchObject({
      applied: true,
      deliveryIds: ["delivery-one"],
      record: { outcome: "send", state: "terminal" },
    });
    expect(second).toMatchObject({ applied: false, deliveryIds: [] });
    expect(directDelivery).toHaveBeenCalledOnce();
    expect(mocks.appendNotificationDispositionEvent).toHaveBeenCalledOnce();
  });

  it("persists an unavailable direct target as a bounded retry without a false delivery binding", async () => {
    const decision = decisionFor("approval", "2026-09-22T09:00:00.000Z");
    const coordinates = notificationDispositionCoordinates({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      sourceKind: "scheduled_routine",
      sourceId: "schedule-one",
      occurrenceKey: "approval-one",
      decision,
    });
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "schedule-one",
      producerId: "test-producer",
      decision,
    });
    const directDelivery = vi.fn(async () => ({
      deliveryKind: "mobile_push_outbox" as const,
      deliveryIds: [],
      targetSha256: "f".repeat(64),
    }));

    const first = await applyNotificationDispositionDecision({
      coordinates,
      decision,
      executionScope,
      directDelivery,
      now: new Date(decision.evaluatedAt),
    });
    const early = await applyNotificationDispositionDecision({
      coordinates,
      decision,
      executionScope,
      directDelivery,
      now: new Date("2026-09-22T09:14:59.999Z"),
    });

    expect(first).toMatchObject({
      applied: true,
      deliveryIds: [],
      record: {
        outcome: "send",
        state: "pending",
        dueAt: "2026-09-22T09:15:00.000Z",
        deliveryKind: null,
        deliveryBindingSha256: null,
      },
    });
    expect(early).toMatchObject({ applied: false, deliveryIds: [] });
    expect(directDelivery).toHaveBeenCalledOnce();
  });

  it("keeps a due digest pending without a device and binds one logical push when available", async () => {
    const decision = decisionFor("informational", "2026-09-22T09:00:00.000Z");
    const coordinates = notificationDispositionCoordinates({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      sourceKind: "agent_run",
      sourceId: "run-one",
      occurrenceKey: "canceled-one",
      decision,
    });
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "run-one",
      producerId: "test-producer",
      decision,
    });
    await applyNotificationDispositionDecision({
      coordinates,
      decision,
      executionScope,
      now: new Date(decision.evaluatedAt),
    });

    await expect(flushDueNotificationDigest({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      now: new Date("2026-09-22T09:30:00.000Z"),
    })).resolves.toBeUndefined();
    expect(mocks.dispositionRows[0]).toMatchObject({
      outcome: "digest",
      state: "pending",
    });

    mocks.enqueueMobilePush.mockResolvedValueOnce([{ id: "digest-delivery-one" }]);
    const delivered = await flushDueNotificationDigest({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      now: new Date("2026-09-22T09:30:00.000Z"),
    });

    expect(delivered).toMatchObject({
      candidateCount: 1,
      sequence: 1,
      contentIncluded: false,
    });
    expect(mocks.enqueueMobilePush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: "tenant-one",
        actorId: "actor-one",
        target: { kind: "notification", id: delivered?.id },
      }),
    );
    expect(mocks.dispositionRows[0]).toMatchObject({
      outcome: "digest",
      state: "terminal",
      digest_delivery_id: delivered?.id,
      delivery_kind: "digest_ledger",
    });
    expect(mocks.appendNotificationDigestEvent).toHaveBeenCalledOnce();
  });

  it("advances a 100-record digest watermark only through the last included candidate", async () => {
    mocks.dispositionRows.push(...Array.from({ length: 101 }, (_, index) => {
      const evaluatedAt = new Date(
        Date.parse("2026-09-22T09:00:00.000Z") + index * 1_000,
      ).toISOString();
      const decision = buildNotificationDecisionV1({
        candidate: {
          candidateId: `candidate-${index}`,
          occurrenceSha256: index.toString(16).padStart(64, "0"),
          kind: "informational",
        },
        evaluatedAt,
        quietHoursActive: false,
        cooldownActive: false,
        digestEnabled: true,
      });
      return dispositionRecordRow(buildNotificationDispositionRecordV1({
        coordinates: {
          tenantId: "tenant-one",
          ownerActorId: "actor-one",
          sourceKind: "agent_run",
          sourceId: `run-${index}`,
          occurrenceKey: `occurrence-${index}`,
          occurrenceSha256: index.toString(16).padStart(64, "0"),
          candidateSha256: decision.candidateSha256,
        },
        decision,
        now: evaluatedAt,
      }));
    }));
    mocks.enqueueMobilePush.mockImplementation(async (input) => [{
      id: `delivery-${input.occurrenceKey}`,
    }]);

    const first = await flushDueNotificationDigest({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      now: new Date("2026-09-22T09:30:00.000Z"),
    });
    const second = await flushDueNotificationDigest({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      now: new Date("2026-09-22T09:30:00.000Z"),
    });

    expect(first).toMatchObject({
      sequence: 1,
      candidateCount: 100,
      windowEndedAt: "2026-09-22T09:01:39.000Z",
    });
    expect(second).toMatchObject({
      sequence: 2,
      candidateCount: 1,
      windowStartedAt: "2026-09-22T09:01:39.000Z",
      windowEndedAt: "2026-09-22T09:01:40.000Z",
    });
    expect(mocks.dispositionRows.every((row) => row.state === "terminal"))
      .toBe(true);
    expect(mocks.watermark).toMatchObject({
      sequence_number: 2,
      lifecycle_revision: 2,
      last_window_ended_at: "2026-09-22T09:01:40.000Z",
    });
  });
});

function decisionFor(
  kind: "approval" | "informational",
  evaluatedAt: string,
) {
  return buildNotificationDecisionV1({
    candidate: {
      candidateId: "candidate-one",
      occurrenceSha256: "a".repeat(64),
      kind,
    },
    evaluatedAt,
    quietHoursActive: false,
    cooldownActive: false,
    digestEnabled: true,
  });
}

function dispositionInsertRow(parameters: unknown[]) {
  return {
    schema_version: parameters[0],
    id: parameters[1],
    tenant_id: parameters[2],
    owner_actor_id: parameters[3],
    source_kind: parameters[4],
    source_id: parameters[5],
    occurrence_key: parameters[6],
    occurrence_sha256: parameters[7],
    candidate_sha256: parameters[8],
    outcome: parameters[9],
    state: parameters[10],
    reason: parameters[11],
    must_send: parameters[12],
    critical: parameters[13],
    policy_sha256: parameters[14],
    decision_receipt_sha256: parameters[15],
    evaluated_at: parameters[16],
    due_at: parameters[17],
    digest_delivery_id: parameters[18],
    delivery_kind: parameters[19],
    delivery_binding_sha256: parameters[20],
    lifecycle_revision: parameters[21],
    created_at: parameters[22],
    updated_at: parameters[23],
    terminal_at: parameters[24],
    content_included: false,
    decision_grants_authority: false,
  };
}

function dispositionUpdateRow(
  existing: Record<string, unknown>,
  parameters: unknown[],
) {
  return {
    ...existing,
    outcome: parameters[0],
    state: parameters[1],
    reason: parameters[2],
    must_send: parameters[3],
    critical: parameters[4],
    policy_sha256: parameters[5],
    decision_receipt_sha256: parameters[6],
    evaluated_at: parameters[7],
    due_at: parameters[8],
    digest_delivery_id: parameters[9],
    delivery_kind: parameters[10],
    delivery_binding_sha256: parameters[11],
    lifecycle_revision: parameters[12],
    updated_at: parameters[13],
    terminal_at: parameters[14],
  };
}

function dispositionRecordRow(record: ReturnType<
  typeof buildNotificationDispositionRecordV1
>) {
  return {
    schema_version: record.schemaVersion,
    id: record.id,
    tenant_id: record.tenantId,
    owner_actor_id: record.ownerActorId,
    source_kind: record.sourceKind,
    source_id: record.sourceId,
    occurrence_key: record.occurrenceKey,
    occurrence_sha256: record.occurrenceSha256,
    candidate_sha256: record.candidateSha256,
    outcome: record.outcome,
    state: record.state,
    reason: record.reason,
    must_send: record.mustSend,
    critical: record.critical,
    policy_sha256: record.policySha256,
    decision_receipt_sha256: record.decisionReceiptSha256,
    evaluated_at: record.evaluatedAt,
    due_at: record.dueAt,
    digest_delivery_id: record.digestDeliveryId,
    delivery_kind: record.deliveryKind,
    delivery_binding_sha256: record.deliveryBindingSha256,
    lifecycle_revision: record.lifecycleRevision,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    terminal_at: record.terminalAt,
    content_included: record.contentIncluded,
    decision_grants_authority: record.decisionGrantsAuthority,
  };
}
