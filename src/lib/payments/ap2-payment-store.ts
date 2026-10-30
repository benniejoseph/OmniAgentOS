import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { ap2PaymentProjectionSchema } from "@/lib/payments/ap2-receipts";

type Owner = Readonly<{ tenantId: string; actorId: string }>;
type Sql = ReturnType<typeof getSql>;

// AP2 currently exposes reviewed terms and historical payment projections.
// No provider payment execution or reconciliation worker is connected.
export class Ap2PaymentStoreError extends Error {
  readonly code = "database_required";

  constructor(message: string) {
    super(message);
    this.name = "Ap2PaymentStoreError";
  }
}

export async function listAp2PaymentTransactions(owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT projection FROM omni_ap2_payment_transactions
    WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
    ORDER BY updated_at DESC, transaction_id ASC LIMIT 100
  `;
  return rows.map((row) => ap2PaymentProjectionSchema.parse(row.projection));
}

export async function getAp2PaymentTransaction(transactionId: string, owner: Owner) {
  const scope = exactOwner(owner);
  requireDatabase();
  await ensureDatabaseSchema();
  return readProjection(transactionId, scope, getSql());
}

async function readProjection(
  transactionId: string,
  owner: Owner,
  sql: Sql,
) {
  const rows = await sql.unsafe(
    `SELECT projection FROM omni_ap2_payment_transactions
     WHERE tenant_id = $1 AND owner_actor_id = $2 AND transaction_id = $3
     LIMIT 1`,
    [owner.tenantId, owner.actorId, required(transactionId, 240, "transaction id")],
  );
  return rows[0] ? ap2PaymentProjectionSchema.parse(rows[0].projection) : undefined;
}

function exactOwner(owner: Owner) {
  return {
    tenantId: required(owner.tenantId, 240, "tenant"),
    actorId: required(owner.actorId, 240, "actor"),
  };
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Ap2PaymentStoreError(
      "AP2 payment evidence requires durable database storage.",
    );
  }
}

function required(value: string, maxLength: number, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`AP2 payment ${label} is invalid.`);
  }
  return normalized;
}
