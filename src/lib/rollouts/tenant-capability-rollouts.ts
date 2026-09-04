import { z } from "zod";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  sourceContractIdSchema,
  sourceContractSha256,
  sourceContractSha256Schema,
  sourceTimestampSchema,
} from "@/lib/sources/contracts";

export const TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION = 1 as const;

export const tenantCapabilityRolloutModeSchema = z.enum([
  "shadow",
  "canary",
  "enabled",
]);

export const tenantCapabilityRolloutStatusSchema = z.enum([
  "registered",
  "active",
  "paused",
  "superseded",
]);

const rolloutGenerationSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const rolloutLifecycleRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const tenantCapabilityRolloutSchema = z
  .object({
    schemaVersion: z.literal(TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION),
    tenantId: sourceContractIdSchema,
    capabilityId: sourceContractIdSchema,
    rolloutGeneration: rolloutGenerationSchema,
    engineVersion: sourceContractIdSchema,
    contractVersionId: sourceContractIdSchema,
    configurationSha256: sourceContractSha256Schema,
    mode: tenantCapabilityRolloutModeSchema,
    status: tenantCapabilityRolloutStatusSchema,
    lifecycleRevision: rolloutLifecycleRevisionSchema,
    createdByActorId: sourceContractIdSchema,
    activatedByActorId: sourceContractIdSchema.optional(),
    activatedAt: sourceTimestampSchema.optional(),
    supersededAt: sourceTimestampSchema.optional(),
    createdAt: sourceTimestampSchema,
    updatedAt: sourceTimestampSchema,
  })
  .strict()
  .superRefine((rollout, context) => {
    if (
      (rollout.status === "registered" && rollout.lifecycleRevision !== 0) ||
      (rollout.status !== "registered" && rollout.lifecycleRevision < 1)
    ) {
      context.addIssue({
        code: "custom",
        message: "Rollout lifecycle revision must match its lifecycle status.",
        path: ["lifecycleRevision"],
      });
    }
    const hasActivationActor = rollout.activatedByActorId !== undefined;
    const hasActivationTime = rollout.activatedAt !== undefined;
    if (hasActivationActor !== hasActivationTime) {
      context.addIssue({
        code: "custom",
        message: "Rollout activation actor and timestamp must be recorded together.",
        path: ["activatedAt"],
      });
    }
    if (
      (rollout.status === "active" || rollout.status === "paused") &&
      !hasActivationTime
    ) {
      context.addIssue({
        code: "custom",
        message: "An active or paused rollout must retain its activation metadata.",
        path: ["status"],
      });
    }
    if (rollout.status === "registered" && hasActivationTime) {
      context.addIssue({
        code: "custom",
        message: "A registered rollout cannot already have activation metadata.",
        path: ["status"],
      });
    }
    if ((rollout.status === "superseded") !== Boolean(rollout.supersededAt)) {
      context.addIssue({
        code: "custom",
        message: "Only a superseded rollout may have a supersession timestamp.",
        path: ["supersededAt"],
      });
    }

    const createdAt = Date.parse(rollout.createdAt);
    const updatedAt = Date.parse(rollout.updatedAt);
    const activatedAt = rollout.activatedAt
      ? Date.parse(rollout.activatedAt)
      : undefined;
    const supersededAt = rollout.supersededAt
      ? Date.parse(rollout.supersededAt)
      : undefined;
    if (updatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Rollout updatedAt cannot precede createdAt.",
        path: ["updatedAt"],
      });
    }
    if (activatedAt !== undefined && activatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Rollout activatedAt cannot precede createdAt.",
        path: ["activatedAt"],
      });
    }
    if (activatedAt !== undefined && activatedAt > updatedAt) {
      context.addIssue({
        code: "custom",
        message: "Rollout activatedAt cannot follow updatedAt.",
        path: ["activatedAt"],
      });
    }
    if (supersededAt !== undefined && supersededAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Rollout supersededAt cannot precede createdAt.",
        path: ["supersededAt"],
      });
    }
    if (supersededAt !== undefined && supersededAt > updatedAt) {
      context.addIssue({
        code: "custom",
        message: "Rollout supersededAt cannot follow updatedAt.",
        path: ["supersededAt"],
      });
    }
    if (
      activatedAt !== undefined &&
      supersededAt !== undefined &&
      supersededAt < activatedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Rollout supersededAt cannot precede activatedAt.",
        path: ["supersededAt"],
      });
    }
  });

export type TenantCapabilityRolloutMode = z.infer<
  typeof tenantCapabilityRolloutModeSchema
>;
export type TenantCapabilityRolloutStatus = z.infer<
  typeof tenantCapabilityRolloutStatusSchema
>;
export type TenantCapabilityRollout = Readonly<
  z.infer<typeof tenantCapabilityRolloutSchema>
>;

export const tenantCapabilityRolloutRegisteredEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION),
    capabilityId: sourceContractIdSchema,
    rolloutGeneration: rolloutGenerationSchema,
    engineVersion: sourceContractIdSchema,
    contractVersionId: sourceContractIdSchema,
    configurationSha256: sourceContractSha256Schema,
    mode: tenantCapabilityRolloutModeSchema,
    status: z.literal("registered"),
    lifecycleRevision: z.literal(0),
    createdByActorId: sourceContractIdSchema,
    supersededRolloutGeneration: rolloutGenerationSchema.nullable(),
    supersededRolloutPreviousStatus:
      tenantCapabilityRolloutStatusSchema.nullable(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      (payload.supersededRolloutGeneration === null) !==
        (payload.supersededRolloutPreviousStatus === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Superseded rollout generation and status must be recorded together.",
      });
    }
    if (
      payload.supersededRolloutGeneration !== null &&
      payload.supersededRolloutGeneration >= payload.rolloutGeneration
    ) {
      context.addIssue({
        code: "custom",
        message: "A registered rollout must supersede an older generation.",
        path: ["supersededRolloutGeneration"],
      });
    }
    if (payload.supersededRolloutPreviousStatus === "superseded") {
      context.addIssue({
        code: "custom",
        message: "A registered rollout cannot supersede a terminal generation.",
        path: ["supersededRolloutPreviousStatus"],
      });
    }
  });

export const tenantCapabilityRolloutTransitionEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION),
    capabilityId: sourceContractIdSchema,
    rolloutGeneration: rolloutGenerationSchema,
    engineVersion: sourceContractIdSchema,
    contractVersionId: sourceContractIdSchema,
    configurationSha256: sourceContractSha256Schema,
    mode: tenantCapabilityRolloutModeSchema,
    fromStatus: tenantCapabilityRolloutStatusSchema,
    toStatus: tenantCapabilityRolloutStatusSchema,
    lifecycleRevision: rolloutLifecycleRevisionSchema,
    transitionedByActorId: sourceContractIdSchema,
    activatedByActorId: sourceContractIdSchema.nullable(),
    activatedAt: sourceTimestampSchema.nullable(),
    supersededAt: sourceTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.lifecycleRevision < 1) {
      context.addIssue({
        code: "custom",
        message: "A rollout transition event requires a positive lifecycle revision.",
        path: ["lifecycleRevision"],
      });
    }
    if (
      !isTenantCapabilityRolloutTransitionAllowed(
        payload.fromStatus,
        payload.toStatus,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Rollout event status transition is invalid.",
        path: ["toStatus"],
      });
    }
    const hasActivation = payload.activatedByActorId !== null &&
      payload.activatedAt !== null;
    if (
      (payload.activatedByActorId === null) !==
        (payload.activatedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Rollout event activation metadata must be recorded together.",
        path: ["activatedAt"],
      });
    }
    if (
      (payload.toStatus === "active" || payload.toStatus === "paused") &&
      !hasActivation
    ) {
      context.addIssue({
        code: "custom",
        message: "An active or paused rollout event requires activation metadata.",
        path: ["toStatus"],
      });
    }
    if (
      (payload.fromStatus === "active" || payload.fromStatus === "paused") &&
      !hasActivation
    ) {
      context.addIssue({
        code: "custom",
        message: "A previously activated rollout event must retain activation metadata.",
        path: ["activatedAt"],
      });
    }
    if (payload.fromStatus === "registered" && hasActivation &&
      payload.toStatus !== "active") {
      context.addIssue({
        code: "custom",
        message: "An unactivated rollout cannot gain activation metadata while superseding.",
        path: ["activatedAt"],
      });
    }
    if (
      (payload.toStatus === "superseded") !==
        (payload.supersededAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a superseded rollout event has a supersession timestamp.",
        path: ["supersededAt"],
      });
    }
    if (
      payload.activatedAt !== null &&
      payload.supersededAt !== null &&
      Date.parse(payload.supersededAt) < Date.parse(payload.activatedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Rollout event supersession cannot precede activation.",
        path: ["supersededAt"],
      });
    }
  });

export type RegisterTenantCapabilityRolloutInput = Readonly<{
  tenantId: string;
  capabilityId: string;
  rolloutGeneration: number;
  engineVersion: string;
  contractVersionId: string;
  configurationSha256: string;
  mode: TenantCapabilityRolloutMode;
  executionScope: ExecutionScope;
}>;

export type TransitionTenantCapabilityRolloutStatusInput = Readonly<{
  tenantId: string;
  capabilityId: string;
  expectedRolloutGeneration: number;
  expectedStatus: TenantCapabilityRolloutStatus;
  nextStatus: TenantCapabilityRolloutStatus;
  executionScope: ExecutionScope;
}>;

export type TenantCapabilityRolloutErrorCode =
  | "postgres_required"
  | "scope_mismatch"
  | "generation_conflict"
  | "rollout_not_found"
  | "status_conflict"
  | "invalid_transition"
  | "storage_invariant";

export class TenantCapabilityRolloutError extends Error {
  constructor(
    readonly code: TenantCapabilityRolloutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TenantCapabilityRolloutError";
  }
}

type RolloutSqlClient = ReturnType<typeof getSql>;
type RolloutRow = Readonly<Record<string, unknown>>;

const ROLLOUT_COLUMNS = `
  schema_version,
  tenant_id,
  capability_id,
  rollout_generation,
  engine_version,
  contract_version_id,
  configuration_sha256,
  mode,
  status,
  lifecycle_revision,
  created_by_actor_id,
  activated_by_actor_id,
  activated_at,
  superseded_at,
  created_at,
  updated_at
`;

const legalTransitions: Readonly<
  Record<TenantCapabilityRolloutStatus, readonly TenantCapabilityRolloutStatus[]>
> = Object.freeze({
  registered: ["active", "superseded"] as readonly TenantCapabilityRolloutStatus[],
  active: ["paused", "superseded"] as readonly TenantCapabilityRolloutStatus[],
  paused: ["active", "superseded"] as readonly TenantCapabilityRolloutStatus[],
  superseded: [] as readonly TenantCapabilityRolloutStatus[],
});

export function isTenantCapabilityRolloutTransitionAllowed(
  fromStatus: TenantCapabilityRolloutStatus,
  toStatus: TenantCapabilityRolloutStatus,
): boolean {
  return legalTransitions[fromStatus].includes(toStatus);
}

/** Returns the one rollout generation that may govern newly created work. */
export async function getCurrentTenantCapabilityRollout(input: {
  tenantId: string;
  capabilityId: string;
}): Promise<TenantCapabilityRollout | null> {
  requirePostgresRolloutStore();
  const tenantId = databaseTenantId(input.tenantId);
  const capabilityId = sourceContractIdSchema.parse(input.capabilityId);
  await ensureDatabaseSchema();

  return runWithDatabaseTenantScope(tenantId, async () => {
    const rows = await getSql().query(
      `SELECT ${ROLLOUT_COLUMNS}
       FROM omni_tenant_capability_rollouts
       WHERE tenant_id = $1
         AND capability_id = $2
         AND status <> 'superseded'
       ORDER BY rollout_generation DESC
       LIMIT 2`,
      [tenantId, capabilityId],
    );
    if (rows.length > 1) {
      throw new TenantCapabilityRolloutError(
        "storage_invariant",
        "Capability rollout storage contains more than one current generation.",
      );
    }
    return rows[0] ? rolloutFromRow(rows[0]) : null;
  });
}

/**
 * Registers an immutable generation and supersedes the prior current
 * generation in the same tenant-scoped transaction.
 */
export async function registerTenantCapabilityRollout(
  input: RegisterTenantCapabilityRolloutInput,
): Promise<TenantCapabilityRollout> {
  requirePostgresRolloutStore();
  const registration = validatedRegistration(input);
  const { executionScope, createdByActorId } = exactMutationScope(
    input.executionScope,
    registration.tenantId,
  );
  await ensureDatabaseSchema();

  return runWithDatabaseTenantScope(registration.tenantId, () =>
    getSql().transaction(async (sql: RolloutSqlClient) => {
      await lockRolloutIdentity(
        sql,
        registration.tenantId,
        registration.capabilityId,
      );

      const latestRows = await sql`
        SELECT rollout_generation
        FROM omni_tenant_capability_rollouts
        WHERE tenant_id = ${registration.tenantId}
          AND capability_id = ${registration.capabilityId}
        ORDER BY rollout_generation DESC
        LIMIT 1
        FOR UPDATE
      `;
      const latestGeneration = latestRows[0]
        ? storedPositiveSafeInteger(
            latestRows[0].rollout_generation,
            "rollout_generation",
          )
        : 0;
      if (registration.rolloutGeneration <= latestGeneration) {
        throw new TenantCapabilityRolloutError(
          "generation_conflict",
          `Capability rollout generation must be greater than ${latestGeneration}.`,
        );
      }

      const currentRows = await sql.query(
        `SELECT ${ROLLOUT_COLUMNS}
         FROM omni_tenant_capability_rollouts
         WHERE tenant_id = $1
           AND capability_id = $2
           AND status <> 'superseded'
         LIMIT 2
         FOR UPDATE`,
        [registration.tenantId, registration.capabilityId],
      );
      if (currentRows.length > 1) {
        throw new TenantCapabilityRolloutError(
          "storage_invariant",
          "Capability rollout storage contains more than one current generation.",
        );
      }
      const prior = currentRows[0] ? rolloutFromRow(currentRows[0]) : null;
      let superseded: TenantCapabilityRollout | null = null;
      if (prior) {
        const supersededRows = await sql.query(
          `UPDATE omni_tenant_capability_rollouts
           SET status = 'superseded',
               lifecycle_revision = lifecycle_revision + 1,
               superseded_at = GREATEST(
                 statement_timestamp(),
                 updated_at + INTERVAL '1 microsecond'
               ),
               updated_at = GREATEST(
                 statement_timestamp(),
                 updated_at + INTERVAL '1 microsecond'
               )
           WHERE tenant_id = $1
             AND capability_id = $2
             AND rollout_generation = $3
             AND status = $4
           RETURNING ${ROLLOUT_COLUMNS}`,
          [
            registration.tenantId,
            registration.capabilityId,
            prior.rolloutGeneration,
            prior.status,
          ],
        );
        if (supersededRows.length !== 1) {
          throw new TenantCapabilityRolloutError(
            "status_conflict",
            "The current capability rollout changed during registration.",
          );
        }
        superseded = rolloutFromRow(supersededRows[0]);
      }

      const insertedRows = await sql.query(
        `INSERT INTO omni_tenant_capability_rollouts (
          schema_version,
          tenant_id,
          capability_id,
          rollout_generation,
          engine_version,
          contract_version_id,
          configuration_sha256,
          mode,
          status,
          created_by_actor_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          'registered',
          $9
        )
        RETURNING ${ROLLOUT_COLUMNS}`,
        [
          TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
          registration.tenantId,
          registration.capabilityId,
          registration.rolloutGeneration,
          registration.engineVersion,
          registration.contractVersionId,
          registration.configurationSha256,
          registration.mode,
          createdByActorId,
        ],
      );
      if (insertedRows.length !== 1) {
        throw new TenantCapabilityRolloutError(
          "storage_invariant",
          "Capability rollout registration did not persist exactly one generation.",
        );
      }
      const rollout = rolloutFromRow(insertedRows[0]);

      if (superseded && prior) {
        await appendRolloutTransitionEvent(sql, {
          executionScope,
          rollout: superseded,
          fromStatus: prior.status,
          transitionedByActorId: createdByActorId,
        });
      }

      const registrationPayload =
        tenantCapabilityRolloutRegisteredEventPayloadSchema.parse({
          schemaVersion: TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
          capabilityId: rollout.capabilityId,
          rolloutGeneration: rollout.rolloutGeneration,
          engineVersion: rollout.engineVersion,
          contractVersionId: rollout.contractVersionId,
          configurationSha256: rollout.configurationSha256,
          mode: rollout.mode,
          status: rollout.status,
          lifecycleRevision: rollout.lifecycleRevision,
          createdByActorId: rollout.createdByActorId,
          supersededRolloutGeneration:
            superseded?.rolloutGeneration ?? null,
          supersededRolloutPreviousStatus: prior?.status ?? null,
        });
      await appendScopedDomainEvent({
        id: rolloutEventId(
          "registered",
          rollout,
        ),
        streamId: `capability:${rollout.capabilityId}`,
        type: "capability.rollout.registered",
        executionScope,
        payload: registrationPayload,
      }, { sql });

      return rollout;
    }) as Promise<TenantCapabilityRollout>
  );
}

/** Applies one compare-and-swap lifecycle transition and its event atomically. */
export async function transitionTenantCapabilityRolloutStatus(
  input: TransitionTenantCapabilityRolloutStatusInput,
): Promise<TenantCapabilityRollout> {
  requirePostgresRolloutStore();
  const tenantId = databaseTenantId(input.tenantId);
  const capabilityId = sourceContractIdSchema.parse(input.capabilityId);
  const expectedRolloutGeneration = rolloutGenerationSchema.parse(
    input.expectedRolloutGeneration,
  );
  const expectedStatus = tenantCapabilityRolloutStatusSchema.parse(
    input.expectedStatus,
  );
  const nextStatus = tenantCapabilityRolloutStatusSchema.parse(input.nextStatus);
  const { executionScope, createdByActorId: transitionActorId } =
    exactMutationScope(input.executionScope, tenantId);
  if (!isTenantCapabilityRolloutTransitionAllowed(expectedStatus, nextStatus)) {
    throw new TenantCapabilityRolloutError(
      "invalid_transition",
      `Capability rollout cannot transition from ${expectedStatus} to ${nextStatus}.`,
    );
  }
  await ensureDatabaseSchema();

  return runWithDatabaseTenantScope(tenantId, () =>
    getSql().transaction(async (sql: RolloutSqlClient) => {
      await lockRolloutIdentity(sql, tenantId, capabilityId);
      const rows = await sql.query(
        `SELECT ${ROLLOUT_COLUMNS}
         FROM omni_tenant_capability_rollouts
         WHERE tenant_id = $1
           AND capability_id = $2
           AND rollout_generation = $3
         LIMIT 2
         FOR UPDATE`,
        [tenantId, capabilityId, expectedRolloutGeneration],
      );
      if (rows.length > 1) {
        throw new TenantCapabilityRolloutError(
          "storage_invariant",
          "Capability rollout identity resolved to more than one generation.",
        );
      }
      if (!rows[0]) {
        throw new TenantCapabilityRolloutError(
          "rollout_not_found",
          "The expected capability rollout generation does not exist.",
        );
      }
      const current = rolloutFromRow(rows[0]);
      if (current.status !== expectedStatus) {
        throw new TenantCapabilityRolloutError(
          "status_conflict",
          `Capability rollout status is ${current.status}, not ${expectedStatus}.`,
        );
      }

      const updatedRows = await sql.query(
        `UPDATE omni_tenant_capability_rollouts
         SET status = $5,
             lifecycle_revision = lifecycle_revision + 1,
             activated_by_actor_id = CASE
               WHEN status = 'registered' AND $5 = 'active'
                 THEN $6
               ELSE activated_by_actor_id
             END,
             activated_at = CASE
               WHEN status = 'registered' AND $5 = 'active'
                 THEN GREATEST(
                   statement_timestamp(),
                   updated_at + INTERVAL '1 microsecond'
                 )
               ELSE activated_at
             END,
             superseded_at = CASE
               WHEN $5 = 'superseded'
                 THEN GREATEST(
                   statement_timestamp(),
                   updated_at + INTERVAL '1 microsecond'
                 )
               ELSE superseded_at
             END,
             updated_at = GREATEST(
               statement_timestamp(),
               updated_at + INTERVAL '1 microsecond'
             )
         WHERE tenant_id = $1
           AND capability_id = $2
           AND rollout_generation = $3
           AND status = $4
         RETURNING ${ROLLOUT_COLUMNS}`,
        [
          tenantId,
          capabilityId,
          expectedRolloutGeneration,
          expectedStatus,
          nextStatus,
          transitionActorId,
        ],
      );
      if (updatedRows.length !== 1) {
        throw new TenantCapabilityRolloutError(
          "status_conflict",
          "The capability rollout changed during its status transition.",
        );
      }
      const rollout = rolloutFromRow(updatedRows[0]);

      await appendRolloutTransitionEvent(sql, {
        executionScope,
        rollout,
        fromStatus: expectedStatus,
        transitionedByActorId: transitionActorId,
      });

      return rollout;
    }) as Promise<TenantCapabilityRollout>
  );
}

function requirePostgresRolloutStore() {
  if (!hasDatabaseUrl()) {
    throw new TenantCapabilityRolloutError(
      "postgres_required",
      "Tenant capability rollouts require DATABASE_URL.",
    );
  }
}

function validatedRegistration(input: RegisterTenantCapabilityRolloutInput) {
  return Object.freeze({
    tenantId: databaseTenantId(input.tenantId),
    capabilityId: sourceContractIdSchema.parse(input.capabilityId),
    rolloutGeneration: rolloutGenerationSchema.parse(input.rolloutGeneration),
    engineVersion: sourceContractIdSchema.parse(input.engineVersion),
    contractVersionId: sourceContractIdSchema.parse(input.contractVersionId),
    configurationSha256: sourceContractSha256Schema.parse(
      input.configurationSha256,
    ),
    mode: tenantCapabilityRolloutModeSchema.parse(input.mode),
  });
}

function exactMutationScope(scopeValue: ExecutionScope, tenantId: string) {
  const executionScope = parsePersistedExecutionScope(scopeValue);
  if (!executionScope?.initiatingActorId) {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout mutations require an initiating actor.",
    );
  }
  if (executionScope.tenantId !== tenantId) {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout tenant does not match its execution scope.",
    );
  }
  if (!executionScope.executingPrincipalId) {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout mutations require a named executing principal.",
    );
  }
  try {
    sourceContractIdSchema.parse(executionScope.executingPrincipalId);
  } catch {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout executing principal is not a valid opaque ID.",
    );
  }
  if (
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId !== executionScope.initiatingActorId
  ) {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "A user rollout principal must match the initiating actor.",
    );
  }
  let createdByActorId: string;
  try {
    createdByActorId = sourceContractIdSchema.parse(
      executionScope.initiatingActorId,
    );
  } catch {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout initiating actor is not a valid opaque ID.",
    );
  }
  return { executionScope, createdByActorId };
}

async function lockRolloutIdentity(
  sql: RolloutSqlClient,
  tenantId: string,
  capabilityId: string,
) {
  if (!sql.transactionScoped) {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      "Capability rollout mutations require a Postgres transaction.",
    );
  }
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${tenantId}),
      hashtext(${capabilityId})
    )
  `;
}

async function appendRolloutTransitionEvent(
  sql: RolloutSqlClient,
  input: {
    executionScope: ExecutionScope;
    rollout: TenantCapabilityRollout;
    fromStatus: TenantCapabilityRolloutStatus;
    transitionedByActorId: string;
  },
) {
  const payload = tenantCapabilityRolloutTransitionEventPayloadSchema.parse({
    schemaVersion: TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
    capabilityId: input.rollout.capabilityId,
    rolloutGeneration: input.rollout.rolloutGeneration,
    engineVersion: input.rollout.engineVersion,
    contractVersionId: input.rollout.contractVersionId,
    configurationSha256: input.rollout.configurationSha256,
    mode: input.rollout.mode,
    fromStatus: input.fromStatus,
    toStatus: input.rollout.status,
    lifecycleRevision: input.rollout.lifecycleRevision,
    transitionedByActorId: input.transitionedByActorId,
    activatedByActorId: input.rollout.activatedByActorId ?? null,
    activatedAt: input.rollout.activatedAt ?? null,
    supersededAt: input.rollout.supersededAt ?? null,
  });
  await appendScopedDomainEvent({
    id: rolloutEventId(
      `${payload.fromStatus}_to_${payload.toStatus}`,
      input.rollout,
    ),
    streamId: `capability:${input.rollout.capabilityId}`,
    type: "capability.rollout.status_transitioned",
    executionScope: input.executionScope,
    payload,
  }, { sql });
}

function rolloutEventId(
  eventKind: string,
  rollout: TenantCapabilityRollout,
) {
  return `tenant_capability_rollout_event_${sourceContractSha256({
    eventKind,
    tenantId: rollout.tenantId,
    capabilityId: rollout.capabilityId,
    rolloutGeneration: rollout.rolloutGeneration,
    lifecycleRevision: rollout.lifecycleRevision,
  }).slice(0, 56)}`;
}

function databaseTenantId(value: string) {
  const tenantId = sourceContractIdSchema.parse(value);
  const normalized = tenantId
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120);
  if (normalized !== tenantId) {
    throw new TenantCapabilityRolloutError(
      "scope_mismatch",
      "Capability rollout tenant ID is incompatible with database scope.",
    );
  }
  return tenantId;
}

function rolloutFromRow(row: RolloutRow): TenantCapabilityRollout {
  const result = tenantCapabilityRolloutSchema.safeParse({
    schemaVersion: storedPositiveSafeInteger(
      row.schema_version,
      "schema_version",
    ),
    tenantId: storedText(row.tenant_id, "tenant_id"),
    capabilityId: storedText(row.capability_id, "capability_id"),
    rolloutGeneration: storedPositiveSafeInteger(
      row.rollout_generation,
      "rollout_generation",
    ),
    engineVersion: storedText(row.engine_version, "engine_version"),
    contractVersionId: storedText(
      row.contract_version_id,
      "contract_version_id",
    ),
    configurationSha256: storedText(
      row.configuration_sha256,
      "configuration_sha256",
    ),
    mode: storedText(row.mode, "mode"),
    status: storedText(row.status, "status"),
    lifecycleRevision: storedNonnegativeSafeInteger(
      row.lifecycle_revision,
      "lifecycle_revision",
    ),
    createdByActorId: storedText(
      row.created_by_actor_id,
      "created_by_actor_id",
    ),
    activatedByActorId: optionalStoredText(
      row.activated_by_actor_id,
      "activated_by_actor_id",
    ),
    activatedAt: optionalStoredTimestamp(row.activated_at, "activated_at"),
    supersededAt: optionalStoredTimestamp(
      row.superseded_at,
      "superseded_at",
    ),
    createdAt: storedTimestamp(row.created_at, "created_at"),
    updatedAt: storedTimestamp(row.updated_at, "updated_at"),
  });
  if (!result.success) {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      "Stored capability rollout violates its versioned contract.",
    );
  }
  return Object.freeze(result.data);
}

function storedPositiveSafeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      `Stored capability rollout ${field} is invalid.`,
    );
  }
  return parsed;
}

function storedNonnegativeSafeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      `Stored capability rollout ${field} is invalid.`,
    );
  }
  return parsed;
}

function storedText(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      `Stored capability rollout ${field} is invalid.`,
    );
  }
  return value;
}

function optionalStoredText(value: unknown, field: string) {
  if (value === null || value === undefined) return undefined;
  return storedText(value, field);
}

function storedTimestamp(value: unknown, field: string) {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new TenantCapabilityRolloutError(
      "storage_invariant",
      `Stored capability rollout ${field} is invalid.`,
    );
  }
  return date.toISOString();
}

function optionalStoredTimestamp(value: unknown, field: string) {
  if (value === null || value === undefined) return undefined;
  return storedTimestamp(value, field);
}
