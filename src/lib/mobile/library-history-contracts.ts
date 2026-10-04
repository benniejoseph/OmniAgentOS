import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  libraryHistoryListQuerySchema, libraryHistoryListResponseSchema,
  libraryHistoryReadQuerySchema, libraryHistoryReadResponseSchema,
} from "@/lib/library/history-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

function receipt(operation: "app.library.versions.list" | "app.library.versions.show") {
  const expected = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.action !== expected.action ||
        value.resourceType !== expected.resourceType || value.accessMode !== "read" ||
        value.eventContract !== expected.eventContract || value.idempotencyKeySha256 !== null) {
      context.addIssue({ code: "custom", message: "History receipt belongs to another operation." });
    }
  });
}
const list = libraryHistoryListResponseSchema.safeExtend({
  serviceReceipt: receipt("app.library.versions.list"),
}).superRefine((value, context) => {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) ||
      serviceReceipt.resourceCount !== value.versions.length) {
    context.addIssue({ code: "custom", message: "History receipt does not describe this exact page." });
  }
});
const read = libraryHistoryReadResponseSchema.safeExtend({
  serviceReceipt: receipt("app.library.versions.show"),
}).superRefine((value, context) => {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== 1) {
    context.addIssue({ code: "custom", message: "History receipt does not describe this exact version." });
  }
});
export const nativeLibraryHistoryContractSchemas = Object.freeze({
  NativeLibraryHistoryListQuery: libraryHistoryListQuerySchema,
  NativeLibraryHistoryReadQuery: libraryHistoryReadQuerySchema,
  NativeLibraryHistoryListResponse: list,
  NativeLibraryHistoryReadResponse: read,
});
