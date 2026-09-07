import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  deliverGmailDraft,
  GmailDeliveryOutcomeUnknownError,
} from "@/lib/communications/gmail-delivery";
import {
  beginMessageDelivery,
  completeMessageDelivery,
  createMessageDraft,
  failMessageDelivery,
  getMessageDraft,
  listMessageDrafts,
  listPersonContactPolicies,
  upsertPersonContactPolicy,
} from "@/lib/communications/store";
import { getOwnedThread } from "@/lib/threads/store";

const emptySchema = z.object({}).strict();
const policyUpsertSchema = z.object({
  personRef: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  channel: z.enum(["email", "message", "voice"]),
  address: z.string().trim().min(3).max(500),
  relationship: z.enum(["personal", "colleague", "customer", "vendor", "other"]),
  allowedPurposes: z.array(z.enum([
    "informational", "coordination", "follow_up", "support", "commercial",
  ])).min(1).max(5),
  allowedDisclosure: z.enum(["public_only", "relationship_context", "confidential"]),
  consent: z.enum(["explicit", "relationship_basis", "unknown"]),
  maxDeliveriesPerDay: z.number().int().min(1).max(50),
  quietHours: z.object({
    enabled: z.boolean(),
    timeZone: z.string().trim().min(1).max(120),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).strict(),
  status: z.enum(["active", "paused", "opted_out"]),
  optOutReason: z.string().trim().min(1).max(500).optional(),
}).strict();

const draftCreateSchema = z.object({
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  purpose: z.enum(["informational", "coordination", "follow_up", "support", "commercial"]),
  disclosure: z.enum(["public_only", "relationship_context", "confidential"]),
  subject: z.string().trim().min(1).max(998).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(50_000),
  canonicalThreadId: z.string().trim().min(1).max(240).optional(),
}).strict();

const draftDeliverySchema = z.object({
  draftId: z.string().regex(/^message_draft:[0-9a-f-]{36}$/),
  expectedDraftSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedRecipient: z.string().trim().min(3).max(500),
  reviewedSubject: z.string().trim().min(1).max(998),
  reviewedBody: z.string().trim().min(1).max(50_000),
}).strict();

export async function listCommunicationPoliciesService(
  caller: AppServiceCaller,
  input: z.input<typeof emptySchema>,
) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.communications.policies.list"),
  );
  const policies = await listPersonContactPolicies(owner(caller));
  return completeAppServiceCall(authorized, { policies }, { resourceCount: policies.length });
}

export async function upsertCommunicationPolicyService(
  caller: AppServiceCaller,
  input: z.input<typeof policyUpsertSchema>,
) {
  const value = policyUpsertSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.communications.policies.upsert"),
  );
  const policy = await upsertPersonContactPolicy(value, mutationOwner(caller));
  return completeAppServiceCall(authorized, { policy });
}

export async function listCommunicationDraftsService(
  caller: AppServiceCaller,
  input: z.input<typeof emptySchema>,
) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.communications.drafts.list"),
  );
  const drafts = await listMessageDrafts(owner(caller));
  return completeAppServiceCall(authorized, { drafts }, { resourceCount: drafts.length });
}

export async function createCommunicationDraftService(
  caller: AppServiceCaller,
  input: z.input<typeof draftCreateSchema>,
) {
  const value = draftCreateSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.communications.drafts.create"),
  );
  if (value.canonicalThreadId) {
    const thread = await getOwnedThread(value.canonicalThreadId, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
    });
    if (!thread) throw new Error("Communication conversation is not owned by this actor.");
  }
  const executionScope = caller.executionScope!;
  const draft = await createMessageDraft({
    ...value,
    executingAgentId: executionScope.executingPrincipalId ||
      `${executionScope.executingPrincipalType}:${caller.context.actorId}`,
    projectId: executionScope.projectId || undefined,
    missionId: executionScope.missionId || undefined,
    runId: executionScope.correlationId,
    idempotencyKey: caller.idempotencyKey!,
  }, mutationOwner(caller));
  return completeAppServiceCall(authorized, { draft });
}

export async function deliverCommunicationDraftService(
  caller: AppServiceCaller,
  input: z.input<typeof draftDeliverySchema>,
) {
  const value = draftDeliverySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.communications.deliver"),
  );
  const claimed = await beginMessageDelivery(value, mutationOwner(caller));
  if (claimed.state === "delivered") {
    const draft = await getMessageDraft(value.draftId, owner(caller));
    return completeAppServiceCall(authorized, {
      draft,
      deliveryReceipt: claimed.receipt,
      reconciled: true,
    });
  }
  try {
    const effect = await deliverGmailDraft(claimed.draft, {
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      mode: claimed.state,
    });
    const deliveryReceipt = await completeMessageDelivery({
      draft: claimed.draft,
      providerMessageId: effect.providerMessageId,
      externalThreadId: effect.externalThreadId,
      providerAcknowledgementSha256: effect.providerAcknowledgementSha256,
      observedTargetStateSha256: effect.observedTargetStateSha256,
    }, mutationOwner(caller));
    const draft = await getMessageDraft(value.draftId, owner(caller));
    return completeAppServiceCall(authorized, {
      draft,
      deliveryReceipt,
      reconciled: effect.providerAcknowledgement === "provider_idempotency_reconciliation",
    });
  } catch (error) {
    if (!(error instanceof GmailDeliveryOutcomeUnknownError)) {
      await failMessageDelivery(value.draftId, mutationOwner(caller));
    }
    throw error;
  }
}

function owner(caller: AppServiceCaller) {
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  };
}

function mutationOwner(caller: AppServiceCaller) {
  return {
    ...owner(caller),
    executionScope: caller.executionScope!,
  };
}
