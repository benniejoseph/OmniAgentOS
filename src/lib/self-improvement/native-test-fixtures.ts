import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeSourceChangeSchema, nativeValidationReceiptSchema, nativeValidationRequestSchema } from "./native-contracts";

/** Shared with the independently installed Python controller's focused tests. */
export function nativeValidationFixture() {
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/self-improvement/fixtures/native-validation-v2.json"), "utf8"));
  return {
    request: nativeValidationRequestSchema.parse(fixture.request),
    receipt: nativeValidationReceiptSchema.parse(fixture.receipt),
    files: (fixture.files as unknown[]).map(file => nativeSourceChangeSchema.parse(file)),
    baseFiles: fixture.baseFiles as Record<string, string>,
  };
}
