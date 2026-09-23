import { createHash } from "node:crypto";

/**
 * Returns the durable identity used for one governed, idempotent tool call.
 *
 * Keep this derivation shared by the tool executor and any in-process
 * authority bridge that must survive the executor's intent-persistence
 * boundary. Callers must still validate tenant and request scope separately.
 */
export function governedToolExecutionId(
  tenantId: string,
  idempotencyKey: string,
) {
  return `idem_${createHash("sha256")
    .update(`${tenantId}\u0000${idempotencyKey}`)
    .digest("hex")}`;
}
