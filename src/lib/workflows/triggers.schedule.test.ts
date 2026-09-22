import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const tenantId = "tenant:schedule-tests";
const actorId = "actor:schedule-owner";
const occurrenceBudget = {
  modelTurns: 4,
  tokens: 24_000,
  costMicrousd: 600_000,
  wallTimeMs: 180_000,
  toolCalls: 20,
  browserActions: 0,
  agents: 0,
  fanOut: 0,
  retries: 1,
  replans: 1,
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-scheduled-triggers-"),
  );
  delete process.env.DATABASE_URL;
});

function ownerScope(correlationId: string) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId,
    purpose: "workflow.schedule.create",
  });
}

function agentPin(owner = actorId) {
  return buildAgentRunIdentityPinV1({
    runId: `schedule-review-${owner.replaceAll(":", "-")}`,
    identity: buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId,
      controllerActorId: owner,
    }),
  });
}

function scheduleInput(input: {
  id: string;
  startsAt: string;
  timezone?: string;
  rrule?: string;
  missedPolicy?: "skip" | "run_once";
}) {
  return {
    tenantId,
    triggerKind: "schedule" as const,
    name: `Schedule ${input.id}`,
    source: "saved-procedure",
    workflowMode: "orchestrate" as const,
    executionScope: ownerScope(input.id),
    idempotencyKey: input.id,
    schedule: {
      timezone: input.timezone || "UTC",
      rrule: input.rrule || "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0",
      startsAt: input.startsAt,
      maxOccurrences: 40,
      missedPolicy: input.missedPolicy || "skip",
      procedurePin: {
        schemaVersion: 1 as const,
        procedureId: "procedure:daily-review",
        snapshotSha256: "1".repeat(64),
        reviewedSnapshotSha256: "2".repeat(64),
        reviewedAt: "2026-09-01T00:00:00.000Z",
      },
      agentIdentityPin: agentPin(),
      occurrenceBudget,
      failureLimit: 3,
    },
  };
}

describe("scheduled workflow trigger foundation", () => {
  it("persists an immutable actor/agent/procedure binding without widening webhook dispatch", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const created = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-create-1",
      startsAt: "2026-10-01T09:00:00.000Z",
    }));
    const replay = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-create-1",
      startsAt: "2026-10-01T09:00:00.000Z",
    }));

    expect(replay.id).toBe(created.id);
    expect(created).toMatchObject({
      triggerKind: "schedule",
      ownerActorId: actorId,
      authMode: "none",
      schedule: {
        config: {
          timezone: "UTC",
          maxOccurrences: 40,
          missedPolicy: "skip",
          agentIdentityPin: { logicalAgentId: "atlas", actorId },
          procedurePin: { procedureId: "procedure:daily-review" },
        },
        state: {
          nextDueAt: "2026-10-01T09:00:00.000Z",
          shadowNextDueAt: "2026-10-01T09:00:00.000Z",
          circuitState: "closed",
        },
      },
    });
    expect(created.schedule?.config.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.schedule?.config.policyPinSha256).toMatch(/^[a-f0-9]{64}$/);

    await expect(triggers.listWorkflowTriggers(20, { tenantId })).resolves.toEqual([]);
    await expect(triggers.listWorkflowTriggers(20, {
      tenantId,
      actorId: "actor:other",
    })).resolves.toEqual([]);
    await expect(triggers.listWorkflowTriggers(20, {
      tenantId,
      actorId,
    })).resolves.toEqual([expect.objectContaining({ id: created.id })]);
    await expect(triggers.dispatchWorkflowTrigger({
      triggerId: created.id,
      bodyText: "{}",
    })).rejects.toBeInstanceOf(triggers.WorkflowTriggerNotFoundError);

    const events = await listStreamEvents(`workflow-trigger:${created.id}`, { tenantId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "workflow.trigger.created",
      payload: {
        triggerKind: "schedule",
        scheduleConfigurationSha256: created.schedule?.config.configSha256,
      },
    });
    expect(JSON.stringify(events)).not.toContain("Schedule schedule-create-1");
    expect(JSON.stringify(events)).not.toContain("daily-review");
  });

  it("keeps daily wall-clock time deterministic across spring and fall DST", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const spring = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-dst-spring",
      timezone: "America/New_York",
      startsAt: "2027-03-13T02:30:00-05:00",
      rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
    }));
    const springConfig = spring.schedule!.config;
    const springGap = triggers.nextWorkflowScheduleOccurrence({
      config: springConfig,
      after: "2027-03-13T07:30:00.000Z",
      completedOccurrences: 1,
    });
    expect(springGap).toBe("2027-03-14T07:00:00.000Z");
    expect(triggers.nextWorkflowScheduleOccurrence({
      config: springConfig,
      after: springGap!,
      completedOccurrences: 2,
    })).toBe("2027-03-15T06:30:00.000Z");

    const fall = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-dst-fall",
      timezone: "America/New_York",
      startsAt: "2027-11-06T01:30:00-04:00",
      rrule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30",
    }));
    expect(triggers.nextWorkflowScheduleOccurrence({
      config: fall.schedule!.config,
      after: "2027-11-06T05:30:00.000Z",
      completedOccurrences: 1,
    })).toBe("2027-11-07T05:30:00.000Z");
  });

  it("collapses missed occurrences according to skip and run-once policy", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const runOnce = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-missed-once",
      startsAt: "2026-09-20T09:00:00.000Z",
      missedPolicy: "run_once",
    }));
    const runOnceEvaluation = triggers.evaluateWorkflowScheduleShadow({
      config: runOnce.schedule!.config,
      currentNextDueAt: "2026-09-20T09:00:00.000Z",
      occurrenceCount: 0,
      now: "2026-09-22T12:00:00.000Z",
    });
    expect(runOnceEvaluation).toEqual({
      scheduledFor: "2026-09-22T09:00:00.000Z",
      evaluatedThrough: "2026-09-22T12:00:00.000Z",
      outcome: "missed_run_once",
      wouldCreateRun: true,
      occurrencesConsumed: 3,
      occurrenceCount: 3,
      nextDueAt: "2026-09-23T09:00:00.000Z",
    });

    const skip = await triggers.createWorkflowTrigger(scheduleInput({
      id: "schedule-missed-skip",
      startsAt: "2026-09-20T09:00:00.000Z",
      missedPolicy: "skip",
    }));
    expect(triggers.evaluateWorkflowScheduleShadow({
      config: skip.schedule!.config,
      currentNextDueAt: "2026-09-20T09:00:00.000Z",
      occurrenceCount: 0,
      now: "2026-09-22T12:00:00.000Z",
    })).toMatchObject({
      scheduledFor: "2026-09-20T09:00:00.000Z",
      outcome: "missed_skipped",
      wouldCreateRun: false,
      occurrencesConsumed: 3,
      nextDueAt: "2026-09-23T09:00:00.000Z",
    });
  });

  it("fails closed on unsupported recurrence or a cross-actor identity pin", async () => {
    const triggers = await import("@/lib/workflows/triggers");
    const unsupported = scheduleInput({
      id: "schedule-invalid-rrule",
      startsAt: "2026-10-01T09:00:00.000Z",
      rrule: "FREQ=HOURLY;INTERVAL=1",
    });
    await expect(triggers.createWorkflowTrigger(unsupported)).rejects.toThrow();

    const crossActor = scheduleInput({
      id: "schedule-cross-actor",
      startsAt: "2026-10-01T09:00:00.000Z",
    });
    crossActor.schedule.agentIdentityPin = agentPin("actor:other");
    await expect(triggers.createWorkflowTrigger(crossActor)).rejects.toThrow(
      "outside the actor scope",
    );
  });

  it("installs an actor-scoped immutable shadow ledger and SKIP LOCKED claimant", async () => {
    const migration = await readFile(
      path.join(
        process.cwd(),
        "supabase/migrations/20260922130000_scheduled_workflow_trigger_shadow.sql",
      ),
      "utf8",
    );
    const implementation = await readFile(
      path.join(process.cwd(), "src/lib/workflows/triggers.ts"),
      "utf8",
    );
    expect(migration).toContain("CREATE TABLE public.omni_workflow_schedule_shadow_events");
    expect(migration).toContain("omni_workflow_triggers_schedule_actor");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("omni_workflow_schedule_shadow_events_immutable");
    expect(migration).toContain("schedule_config_sha256");
    expect(migration).toContain("agent_identity_pin_sha256");
    expect(migration).toContain("reviewed_snapshot_sha256");
    expect(implementation).toContain("FOR UPDATE SKIP LOCKED");
    expect(implementation).not.toContain("source: \"schedule\"");
  });
});
