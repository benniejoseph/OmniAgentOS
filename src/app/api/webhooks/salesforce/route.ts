import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { fetchSalesforceRecord } from "@/lib/customer-success/salesforce-adapter";
import {
  SALESFORCE_OBJECT_TYPES,
  normalizeSalesforceRecord,
  salesforceOrganizationIdSha256,
} from "@/lib/customer-success/salesforce-contracts";
import { projectSalesforceRecord } from "@/lib/customer-success/salesforce-projection";
import {
  findSalesforceConnectionByOrganization,
  markSalesforceHeadProjection,
  settleSalesforceWebhookObservation,
  type SalesforceMutationAuthority,
} from "@/lib/customer-success/salesforce-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const webhookSchema = z.object({
  organizationId: z.string().regex(/^[A-Za-z0-9]{15,18}$/),
  replayId: z.string().min(1).max(1_000),
  eventId: z.string().min(1).max(1_000),
  objectType: z.enum(SALESFORCE_OBJECT_TYPES),
  recordId: z.string().regex(/^[A-Za-z0-9]{15,18}$/),
  deleted: z.boolean().default(false),
  providerModifiedAt: z.string().datetime({ offset: true }).optional(),
  accountExternalId: z.string().regex(/^[A-Za-z0-9]{15,18}$/).optional(),
}).strict();

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  const secret = process.env.SALESFORCE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: "Salesforce webhook verification is not configured." }, { status: 503 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 1_000_000 || !verifySalesforceWebhookSignature({
    secret,
    body: raw,
    signature: request.headers.get("x-asael-salesforce-signature") || "",
    timestamp: request.headers.get("x-asael-salesforce-timestamp") || "",
  })) {
    return Response.json({ error: "Invalid Salesforce webhook signature." }, { status: 401 });
  }
  const parsed = webhookSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    return Response.json({ error: "Invalid Salesforce webhook payload." }, { status: 400 });
  }
  try {
    const organizationIdSha256 = salesforceOrganizationIdSha256(
      parsed.data.organizationId,
    );
    const connection = await findSalesforceConnectionByOrganization(
      organizationIdSha256,
    );
    if (!connection) return Response.json({ accepted: true, matched: false }, { status: 202 });
    const replayIdSha256 = canonicalJsonSha256(parsed.data.replayId);
    const eventKeySha256 = canonicalJsonSha256({
      organizationIdSha256,
      replayIdSha256,
      eventId: parsed.data.eventId,
      objectType: parsed.data.objectType,
      recordId: parsed.data.recordId,
    });
    const authority = webhookAuthority(connection, eventKeySha256);
    const remote = await fetchSalesforceRecord({
      connection,
      objectType: parsed.data.objectType,
      externalId: parsed.data.recordId,
      sourceKind: "webhook",
      replayIdSha256,
      abortSignal: request.signal,
    });
    const observation = remote || (parsed.data.deleted && parsed.data.providerModifiedAt
      ? normalizeSalesforceRecord({
          objectType: parsed.data.objectType,
          sourceKind: "webhook",
          observedAt: new Date().toISOString(),
          replayIdSha256,
          record: {
            Id: parsed.data.recordId,
            AccountId: parsed.data.accountExternalId,
            SystemModstamp: parsed.data.providerModifiedAt,
            IsDeleted: true,
          },
        })
      : undefined);
    if (!observation) {
      return Response.json({ accepted: true, matched: true, settled: false }, { status: 202 });
    }
    const settled = await settleSalesforceWebhookObservation({
      authority,
      connection,
      eventKeySha256,
      eventSha256: canonicalJsonSha256({
        ...parsed.data,
        organizationId: organizationIdSha256,
        replayId: replayIdSha256,
      }),
      replayIdSha256,
      observation,
    });
    if (settled.status === "settled" && settled.advancedRecord) {
      try {
        const status = await projectSalesforceRecord(
          authority,
          connection,
          settled.advancedRecord,
        );
        await markSalesforceHeadProjection({
          authority,
          record: settled.advancedRecord,
          status,
        });
      } catch {
        await markSalesforceHeadProjection({
          authority,
          record: settled.advancedRecord,
          status: "error",
          errorCode: "internal_error",
        }).catch(() => false);
      }
    }
    return Response.json({
      accepted: true,
      matched: true,
      settled: settled.status === "settled",
      duplicate: settled.status === "duplicate",
    }, { status: 202 });
  } catch {
    return Response.json({ error: "Salesforce webhook could not be settled safely." }, { status: 503 });
  }
}

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

function webhookAuthority(
  connection: Awaited<ReturnType<typeof findSalesforceConnectionByOrganization>> & {},
  correlationId: string,
): SalesforceMutationAuthority {
  return {
    tenantId: connection.tenantId,
    workspaceId: connection.workspaceId,
    canonicalActorId: connection.ownerActorId,
    readableActorIds: [connection.ownerActorId],
    executionScope: createExecutionScope({
      tenantId: connection.tenantId,
      initiatingActorId: connection.ownerActorId,
      executingPrincipalType: "system",
      executingPrincipalId: "salesforce:webhook",
      workspaceId: connection.workspaceId,
      correlationId,
      purpose: "customer.salesforce.webhook_sync",
    }),
  };
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
