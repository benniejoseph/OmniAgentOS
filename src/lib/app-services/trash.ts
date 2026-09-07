import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { requirePermission } from "@/lib/security/context";
import {
  commitTrashLifecycle,
  createTrashLifecyclePreview,
  getTrashItem,
  listTrashEffectReceipts,
  listTrashItems,
} from "@/lib/trash/store";
import { restoreTrashResource } from "@/lib/trash/resources";
import {
  trashActionPreviewV1Schema,
  trashItemStateSchema,
  type TrashItemV1,
} from "@/lib/trash/contracts";

const listSchema = z.object({
  state: trashItemStateSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
const idSchema = z.object({
  trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/),
}).strict();
const receiptsSchema = idSchema.extend({
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
const lifecycleSchema = z.object({
  preview: trashActionPreviewV1Schema,
}).strict();

export async function listTrashService(
  caller: AppServiceCaller,
  input: z.input<typeof listSchema>,
) {
  const value = listSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.trash.list"),
  );
  const items = await listTrashItems({
    executionScope: requiredScope(caller),
    ...value,
  });
  return completeAppServiceCall(authorized, { items }, {
    resourceCount: items.length,
  });
}

export async function showTrashService(
  caller: AppServiceCaller,
  input: z.input<typeof idSchema>,
) {
  const value = idSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.trash.show"),
  );
  const item = await getTrashItem(value.trashId, {
    executionScope: requiredScope(caller),
  });
  return completeAppServiceCall(authorized, { item: item || null }, {
    resourceCount: item ? 1 : 0,
  });
}

export async function listTrashReceiptsService(
  caller: AppServiceCaller,
  input: z.input<typeof receiptsSchema>,
) {
  const value = receiptsSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.trash.receipts.list"),
  );
  const receipts = await listTrashEffectReceipts({
    executionScope: requiredScope(caller),
    trashId: value.trashId,
    limit: value.limit,
  });
  return completeAppServiceCall(authorized, { receipts }, {
    resourceCount: receipts.length,
  });
}

export async function previewTrashRestoreService(
  caller: AppServiceCaller,
  input: z.input<typeof idSchema>,
) {
  return previewLifecycle(caller, input, "restore");
}

export async function previewTrashPurgeService(
  caller: AppServiceCaller,
  input: z.input<typeof idSchema>,
) {
  return previewLifecycle(caller, input, "purge");
}

export async function restoreTrashService(
  caller: AppServiceCaller,
  input: z.input<typeof lifecycleSchema>,
) {
  const value = lifecycleSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.trash.restore"),
  );
  if (value.preview.action !== "restore") {
    throw new Error("Trash restoration requires a restore preview.");
  }
  const item = await requireLifecycleItem(caller, value.preview.trashId);
  requireResourceMutationPermission(caller, item);
  const restored = await restoreTrashResource({
    preview: value.preview,
    executionScope: requiredScope(caller),
  });
  return completeAppServiceCall(authorized, {
    trash: restored.result.item,
    effectReceipt: restored.result.receipt,
    restoredResourceIds: restored.restoredResourceIds,
    limitation: restored.limitation,
  });
}

export async function purgeTrashService(
  caller: AppServiceCaller,
  input: z.input<typeof lifecycleSchema>,
) {
  const value = lifecycleSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.trash.purge"),
  );
  if (value.preview.action !== "purge") {
    throw new Error("Permanent trash deletion requires a purge preview.");
  }
  const item = await requireLifecycleItem(caller, value.preview.trashId);
  requireResourceMutationPermission(caller, item);
  const purged = await commitTrashLifecycle(value.preview, {
    executionScope: requiredScope(caller),
  });
  return completeAppServiceCall(authorized, {
    trash: purged.item,
    finalDeletionReceipt: purged.receipt,
  });
}

async function previewLifecycle(
  caller: AppServiceCaller,
  input: z.input<typeof idSchema>,
  action: "restore" | "purge",
) {
  const value = idSchema.parse(input);
  const operation = action === "restore"
    ? "app.trash.restore.preview" as const
    : "app.trash.purge.preview" as const;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract(operation),
  );
  const item = await getTrashItem(value.trashId, {
    executionScope: requiredScope(caller),
  });
  if (item) requireResourceMutationPermission(caller, item);
  const preview = item
    ? await createTrashLifecyclePreview(value.trashId, action, {
        executionScope: requiredScope(caller),
      })
    : undefined;
  return completeAppServiceCall(authorized, {
    item: item || null,
    preview: preview || null,
    permanent: action === "purge",
  }, { resourceCount: item ? 1 : 0 });
}

async function requireLifecycleItem(
  caller: AppServiceCaller,
  trashId: string | null,
) {
  if (!trashId) throw new Error("Trash lifecycle preview requires a trash ID.");
  const item = await getTrashItem(trashId, {
    executionScope: requiredScope(caller),
  });
  if (!item) throw new Error("Trash item not found.");
  return item;
}

function requireResourceMutationPermission(
  caller: AppServiceCaller,
  item: TrashItemV1,
) {
  requirePermission(
    caller.context,
    item.resourceType === "mcp_connector" ||
        item.resourceType === "openapi_connector"
      ? "manage.connector"
      : "manage.workflow",
  );
}

function requiredScope(caller: AppServiceCaller) {
  if (!caller.executionScope?.initiatingActorId) {
    throw new Error("Trash services require an actor-bound execution scope.");
  }
  return caller.executionScope;
}
