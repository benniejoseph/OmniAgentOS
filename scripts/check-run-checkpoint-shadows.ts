import {
  closeDatabaseClient,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "../src/lib/db/client";
import { reconcileStoredApprovalCheckpointShadows } from "../src/lib/runs/checkpoint-shadow-reconciliation";

const tenantId = process.argv[2]?.trim();
const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
const mode = process.argv[4]?.trim() || "approval";

async function main() {
  if (!tenantId) {
    throw new Error(
      "Usage: npx tsx scripts/check-run-checkpoint-shadows.ts <tenant-id> [limit] [approval|expanded]",
    );
  }
  if (mode !== "approval" && mode !== "expanded") {
    throw new Error("Checkpoint reconciliation mode must be approval or expanded.");
  }
  if (!hasDatabaseUrl()) {
    throw new Error("DATABASE_URL is required for checkpoint reconciliation.");
  }

  const report = await runWithDatabaseTenantScope(tenantId, () =>
    reconcileStoredApprovalCheckpointShadows(
      { tenantId, limit, mode },
      getSql(),
    )
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "matched") process.exitCode = 1;
}

void main().finally(closeDatabaseClient);
