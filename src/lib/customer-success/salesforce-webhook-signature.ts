import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySalesforceWebhookSignature(input: {
  secret: string;
  body: string;
  signature: string;
  timestamp: string;
  nowMs?: number;
}) {
  if (!/^(0|[1-9][0-9]{9,12})$/.test(input.timestamp) ||
      !/^sha256=[a-f0-9]{64}$/.test(input.signature)) return false;
  const timestampMs = Number(input.timestamp) * 1_000;
  const now = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > 5 * 60_000) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
}
