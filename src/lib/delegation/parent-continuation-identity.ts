import { createHash } from "node:crypto";

export function parentContinuationRunId(parentRunId: string) {
  const hash = createHash("sha256").update(`delegation-parent:${parentRunId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
