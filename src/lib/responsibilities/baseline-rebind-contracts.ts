import { z } from "zod";
import { digestSchema, instantSchema } from "./contracts";
import { responsibilityBaselineSchema } from "./observation-contracts";

export const baselineRebindReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^responsibility-baseline-rebind:[a-f0-9]{64}$/),
  runtimeReceiptId: z.string().regex(/^responsibility-runtime-receipt:[a-f0-9]{64}$/), runtimeReceiptSha256: digestSchema,
  previous: responsibilityBaselineSchema, next: responsibilityBaselineSchema,
  savedAt: instantSchema, receiptSha256: digestSchema,
}).strict();
export type BaselineRebindReceipt = z.infer<typeof baselineRebindReceiptSchema>;
