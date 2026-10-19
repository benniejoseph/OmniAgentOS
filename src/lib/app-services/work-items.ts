import { appServiceActorBinding } from "@/lib/app-services/contracts";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "./contracts";
import { getAppServiceOperationContract } from "./registry";
import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/sql-types";
import { responsibilityWorkSchema } from "@/lib/responsibilities/contracts";
import { readOwnedWorkItemWithSql } from "@/lib/responsibilities/work-item-source";

export const workItemShowServiceInputSchema = responsibilityWorkSchema;
export async function showWorkItemService(caller: AppServiceCaller, input: unknown) {
  const work = workItemShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.work_items.show"));
  const binding = appServiceActorBinding(caller);
  if (!binding) throw new Error("An authenticated work item owner is required.");
  const owner = { tenantId: caller.context.tenantId, actorId: binding.canonicalActorId };
  const result = await runWithDatabaseActorScope(owner.tenantId, binding.readableOwnerActorIds, async () => {
    const sql = getSql();
    const read = async (transaction: SqlClient) => {
      const clock = await transaction`SELECT clock_timestamp() AS checked_at`;
      if (clock.length !== 1 || !(clock[0].checked_at instanceof Date)) throw new Error("Current work item read time is unavailable.");
      return readOwnedWorkItemWithSql(transaction, owner, work, clock[0].checked_at.toISOString());
    };
    return sql.transactionScoped ? read(sql) : sql.transaction(read) as Promise<Awaited<ReturnType<typeof readOwnedWorkItemWithSql>>>;
  });
  return completeAppServiceCall(authorized, result, { resourceCount: 1 });
}
