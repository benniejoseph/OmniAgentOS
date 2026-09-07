import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySalesforceWebhookSignature } from "@/app/api/webhooks/salesforce/route";

describe("Salesforce webhook verification", () => {
  it("accepts only a fresh exact-body HMAC", () => {
    const body = JSON.stringify({ recordId: "001000000000001AAA" });
    const timestamp = "1788784200";
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")}`;
    const nowMs = Number(timestamp) * 1_000;

    expect(verifySalesforceWebhookSignature({
      secret, body, timestamp, signature, nowMs,
    })).toBe(true);
    expect(verifySalesforceWebhookSignature({
      secret, body: `${body} `, timestamp, signature, nowMs,
    })).toBe(false);
    expect(verifySalesforceWebhookSignature({
      secret, body, timestamp, signature, nowMs: nowMs + 5 * 60_000 + 1,
    })).toBe(false);
  });
});
