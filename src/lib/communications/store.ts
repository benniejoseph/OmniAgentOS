import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  communicationIntentSchema,
  conversationLinkSchema,
  deliveryReceiptSchema,
  GOVERNED_COMMUNICATION_VERSION,
  inboundCommunicationEnvelopeSchema,
  messageDraftSchema,
  personContactPolicySchema,
  type CommunicationIntent,
  type DeliveryReceipt,
  type InboundCommunicationEnvelope,
  type MessageDraft,
  type PersonContactPolicy,
} from "@/lib/communications/contracts";

type OwnerScope = Readonly<{
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
}>;

export class CommunicationPolicyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "not_found"
      | "policy_blocked"
      | "draft_changed"
      | "quiet_hours"
      | "frequency_limit"
      | "delivery_conflict",
  ) {
    super(message);
    this.name = "CommunicationPolicyError";
  }
}

export async function upsertPersonContactPolicy(input: {
  personRef: string;
  displayName: string;
  channel: "email" | "message" | "voice";
  address: string;
  relationship: PersonContactPolicy["relationship"];
  allowedPurposes: PersonContactPolicy["allowedPurposes"];
  allowedDisclosure: PersonContactPolicy["allowedDisclosure"];
  consent: PersonContactPolicy["consent"];
  maxDeliveriesPerDay: number;
  quietHours: PersonContactPolicy["quietHours"];
  status: PersonContactPolicy["status"];
  optOutReason?: string;
}, owner: OwnerScope) {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  const address = normalizeAddress(input.channel, input.address);
  const addressSha256 = sha256(address);
  const sql = getSql();
  return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const existingRows = await transaction`
      SELECT policy FROM omni_person_contact_policies
      WHERE tenant_id = ${scope.tenantId}
        AND owner_actor_id = ${scope.actorId}
        AND channel = ${input.channel}
        AND address_sha256 = ${addressSha256}
      LIMIT 1
      FOR UPDATE
    `;
    const existing = existingRows[0]
      ? personContactPolicySchema.parse(existingRows[0].policy)
      : undefined;
    const now = new Date().toISOString();
    const body = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: existing?.id || `contact_policy:${randomUUID()}`,
      tenantId: scope.tenantId,
      ownerActorId: scope.actorId,
      personRef: requiredText(input.personRef, 240),
      displayName: requiredText(input.displayName, 240),
      channel: input.channel,
      address,
      relationship: input.relationship,
      allowedPurposes: [...new Set(input.allowedPurposes)],
      allowedDisclosure: input.allowedDisclosure,
      consent: input.consent,
      approvalMode: "always" as const,
      senderIdentity: "connected_account" as const,
      maxDeliveriesPerDay: input.maxDeliveriesPerDay,
      quietHours: input.quietHours,
      status: input.status,
      optOutReason: input.status === "opted_out"
        ? requiredText(input.optOutReason || "Contact opted out.", 500)
        : null,
      lifecycleRevision: (existing?.lifecycleRevision || 0) + 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const policy = personContactPolicySchema.parse({
      ...body,
      policySha256: canonicalJsonSha256(body),
    });
    if (existing) {
      await transaction`
        UPDATE omni_person_contact_policies
        SET status = ${policy.status}, lifecycle_revision = ${policy.lifecycleRevision},
            policy = ${policy}::jsonb, updated_at = ${policy.updatedAt}
        WHERE tenant_id = ${scope.tenantId}
          AND owner_actor_id = ${scope.actorId}
          AND policy_id = ${policy.id}
      `;
    } else {
      await transaction`
        INSERT INTO omni_person_contact_policies (
          tenant_id, owner_actor_id, policy_id, channel, address_sha256,
          status, lifecycle_revision, policy, created_at, updated_at
        ) VALUES (
          ${scope.tenantId}, ${scope.actorId}, ${policy.id}, ${policy.channel},
          ${addressSha256}, ${policy.status}, ${policy.lifecycleRevision},
          ${policy}::jsonb, ${policy.createdAt}, ${policy.updatedAt}
        )
      `;
    }
    await appendCommunicationEvent({
      id: `communication-event:v1:${policy.policySha256}`,
      streamId: `contact-policy:${policy.id}`,
      type: existing ? "communication.contact_policy.updated" : "communication.contact_policy.created",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        policyId: policy.id,
        channel: policy.channel,
        relationship: policy.relationship,
        status: policy.status,
        consent: policy.consent,
        allowedPurposes: policy.allowedPurposes,
        allowedDisclosure: policy.allowedDisclosure,
        lifecycleRevision: policy.lifecycleRevision,
        policySha256: policy.policySha256,
      },
      sql: transaction,
    });
    return policy;
  }) as Promise<PersonContactPolicy>;
}

export async function listPersonContactPolicies(owner: Omit<OwnerScope, "executionScope">) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT policy FROM omni_person_contact_policies
    WHERE tenant_id = ${requiredText(owner.tenantId, 160)}
      AND owner_actor_id = ${requiredText(owner.actorId, 500)}
    ORDER BY updated_at DESC LIMIT 200
  `;
  return rows.map((row) => personContactPolicySchema.parse(row.policy));
}

export async function createMessageDraft(input: {
  policyId: string;
  purpose: CommunicationIntent["purpose"];
  disclosure: CommunicationIntent["disclosure"];
  subject: string;
  body: string;
  executingAgentId: string;
  canonicalThreadId?: string;
  projectId?: string;
  missionId?: string;
  runId?: string;
  idempotencyKey: string;
}, owner: OwnerScope) {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  const draftId = `message_draft:${deterministicUuid(
    `${scope.tenantId}\0${scope.actorId}\0${input.idempotencyKey}\0draft`,
  )}`;
  const intentId = `communication_intent:${deterministicUuid(
    `${scope.tenantId}\0${scope.actorId}\0${input.idempotencyKey}\0intent`,
  )}`;
  const sql = getSql();
  return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const priorRows = await transaction`
      SELECT draft FROM omni_message_drafts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${draftId} LIMIT 1
    `;
    if (priorRows[0]) {
      return messageDraftSchema.parse(priorRows[0].draft);
    }
    const policy = await getPolicyForUpdate(input.policyId, scope, transaction);
    assertPolicyAllowsDraft(policy, input.purpose, input.disclosure);
    const now = new Date().toISOString();
    const intentBody = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: intentId,
      policyId: policy.id,
      purpose: input.purpose,
      disclosure: input.disclosure,
      requestedByActorId: scope.actorId,
      executingAgentId: requiredText(input.executingAgentId, 240),
      canonicalThreadId: optionalText(input.canonicalThreadId, 240),
      projectId: optionalText(input.projectId, 240),
      missionId: optionalText(input.missionId, 240),
      runId: optionalText(input.runId, 240),
      createdAt: now,
    };
    const intent = communicationIntentSchema.parse({
      ...intentBody,
      intentSha256: canonicalJsonSha256(intentBody),
    });
    const draftBody = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: draftId,
      intentId: intent.id,
      policyId: policy.id,
      channel: policy.channel,
      recipient: policy.address,
      subject: requiredText(input.subject, 998),
      body: requiredText(input.body, 50_000),
      senderIdentity: "connected_account" as const,
      state: "ready" as const,
      lifecycleRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const draft = messageDraftSchema.parse({
      ...draftBody,
      draftSha256: draftContentSha256(draftBody),
    });
    await transaction`
      INSERT INTO omni_communication_intents (
        tenant_id, owner_actor_id, intent_id, policy_id, intent_sha256,
        intent, created_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${intent.id}, ${intent.policyId},
        ${intent.intentSha256}, ${intent}::jsonb, ${intent.createdAt}
      )
    `;
    await transaction`
      INSERT INTO omni_message_drafts (
        tenant_id, owner_actor_id, draft_id, intent_id, policy_id, channel,
        recipient_sha256, draft_sha256, state, lifecycle_revision, draft,
        created_at, updated_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${draft.id}, ${draft.intentId},
        ${draft.policyId}, ${draft.channel}, ${sha256(draft.recipient)},
        ${draft.draftSha256}, ${draft.state}, ${draft.lifecycleRevision},
        ${draft}::jsonb, ${draft.createdAt}, ${draft.updatedAt}
      )
    `;
    await appendCommunicationEvent({
      id: `communication-event:v1:${draft.draftSha256}`,
      streamId: `communication:${draft.id}`,
      type: "communication.draft.created",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        draftId: draft.id,
        intentId: intent.id,
        policyId: policy.id,
        channel: draft.channel,
        purpose: intent.purpose,
        disclosure: intent.disclosure,
        recipientSha256: sha256(draft.recipient),
        subjectSha256: sha256(draft.subject),
        bodySha256: sha256(draft.body),
        draftSha256: draft.draftSha256,
        lifecycleRevision: draft.lifecycleRevision,
      },
      sql: transaction,
    });
    return draft;
  }) as Promise<MessageDraft>;
}

export async function listMessageDrafts(owner: Omit<OwnerScope, "executionScope">) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT draft FROM omni_message_drafts
    WHERE tenant_id = ${requiredText(owner.tenantId, 160)}
      AND owner_actor_id = ${requiredText(owner.actorId, 500)}
    ORDER BY updated_at DESC LIMIT 200
  `;
  return rows.map((row) => messageDraftSchema.parse(row.draft));
}

export async function getMessageDraft(
  draftId: string,
  owner: Omit<OwnerScope, "executionScope">,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT draft FROM omni_message_drafts
    WHERE tenant_id = ${requiredText(owner.tenantId, 160)}
      AND owner_actor_id = ${requiredText(owner.actorId, 500)}
      AND draft_id = ${requiredText(draftId, 240)} LIMIT 1
  `;
  return rows[0] ? messageDraftSchema.parse(rows[0].draft) : undefined;
}

export async function beginMessageDelivery(input: {
  draftId: string;
  expectedDraftSha256: string;
  reviewedRecipient: string;
  reviewedSubject: string;
  reviewedBody: string;
}, owner: OwnerScope) {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  const sql = getSql();
  return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const receiptRows = await transaction`
      SELECT receipt FROM omni_delivery_receipts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${requiredText(input.draftId, 240)} LIMIT 1
    `;
    if (receiptRows[0]) {
      return {
        state: "delivered" as const,
        receipt: deliveryReceiptSchema.parse(receiptRows[0].receipt),
      };
    }
    const draftRows = await transaction`
      SELECT draft FROM omni_message_drafts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${requiredText(input.draftId, 240)} LIMIT 1 FOR UPDATE
    `;
    if (!draftRows[0]) throw new CommunicationPolicyError("Message draft was not found.", "not_found");
    const draft = messageDraftSchema.parse(draftRows[0].draft);
    if (
      draft.draftSha256 !== input.expectedDraftSha256 ||
      draft.recipient !== normalizeAddress(draft.channel, input.reviewedRecipient) ||
      draft.subject !== input.reviewedSubject.trim() ||
      draft.body !== input.reviewedBody.trim()
    ) {
      throw new CommunicationPolicyError("Message draft changed after visible review.", "draft_changed");
    }
    if (draft.channel !== "email") {
      throw new CommunicationPolicyError("This communication channel is not enabled for delivery.", "policy_blocked");
    }
    const policy = await getPolicyForUpdate(draft.policyId, scope, transaction);
    const intentRows = await transaction`
      SELECT intent FROM omni_communication_intents
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND intent_id = ${draft.intentId} LIMIT 1
    `;
    const intent = communicationIntentSchema.parse(intentRows[0]?.intent);
    assertPolicyAllowsDraft(policy, intent.purpose, intent.disclosure);
    if (draft.state === "delivering") {
      return { state: "reconcile" as const, draft, intent, policy };
    }
    assertOutsideQuietHours(policy, new Date());
    const frequencyRows = await transaction`
      SELECT count(*)::INTEGER AS count
      FROM omni_delivery_receipts receipt
      JOIN omni_message_drafts draft
        ON draft.tenant_id = receipt.tenant_id
       AND draft.owner_actor_id = receipt.owner_actor_id
       AND draft.draft_id = receipt.draft_id
      WHERE receipt.tenant_id = ${scope.tenantId}
        AND receipt.owner_actor_id = ${scope.actorId}
        AND draft.policy_id = ${policy.id}
        AND receipt.delivered_at >= clock_timestamp() - INTERVAL '24 hours'
    `;
    if (Number(frequencyRows[0]?.count || 0) >= policy.maxDeliveriesPerDay) {
      throw new CommunicationPolicyError("Contact frequency limit reached.", "frequency_limit");
    }
    if (!["ready", "failed", "delivering"].includes(draft.state)) {
      throw new CommunicationPolicyError("Message draft is not deliverable.", "delivery_conflict");
    }
    const next = messageDraftSchema.parse({
      ...draft,
      state: "delivering",
      lifecycleRevision: draft.lifecycleRevision + 1,
      updatedAt: new Date().toISOString(),
    });
    await transaction`
      UPDATE omni_message_drafts
      SET state = ${next.state}, lifecycle_revision = ${next.lifecycleRevision},
          draft = ${next}::jsonb, updated_at = ${next.updatedAt}
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${next.id}
    `;
    await appendCommunicationEvent({
      id: `communication-event:v1:${sha256(`${next.id}\0${next.lifecycleRevision}`)}`,
      streamId: `communication:${next.id}`,
      type: "communication.delivery.started",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        draftId: next.id,
        draftSha256: next.draftSha256,
        intentId: next.intentId,
        policyId: next.policyId,
        lifecycleRevision: next.lifecycleRevision,
      },
      sql: transaction,
    });
    return { state: "deliver" as const, draft: next, intent, policy };
  }) as Promise<
    | { state: "delivered"; receipt: DeliveryReceipt }
    | { state: "deliver" | "reconcile"; draft: MessageDraft; intent: CommunicationIntent; policy: PersonContactPolicy }
  >;
}

export async function completeMessageDelivery(input: {
  draft: MessageDraft;
  providerMessageId: string;
  externalThreadId: string;
  providerAcknowledgementSha256: string;
  observedTargetStateSha256: string;
}, owner: OwnerScope) {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  const now = new Date().toISOString();
  const receiptBody = {
    version: GOVERNED_COMMUNICATION_VERSION,
    id: `delivery_receipt:${randomUUID()}`,
    draftId: input.draft.id,
    draftSha256: input.draft.draftSha256,
    provider: "gmail" as const,
    providerMessageId: requiredText(input.providerMessageId, 500),
    externalThreadId: requiredText(input.externalThreadId, 500),
    providerAcknowledgementSha256: requiredSha256(input.providerAcknowledgementSha256),
    observedTargetStateSha256: requiredSha256(input.observedTargetStateSha256),
    outcome: "delivered_verified" as const,
    deliveredAt: now,
  };
  const receipt = deliveryReceiptSchema.parse({
    ...receiptBody,
    receiptSha256: canonicalJsonSha256(receiptBody),
  });
  const sql = getSql();
  return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const existingRows = await transaction`
      SELECT receipt FROM omni_delivery_receipts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${input.draft.id} LIMIT 1
    `;
    if (existingRows[0]) return deliveryReceiptSchema.parse(existingRows[0].receipt);
    const intentRows = await transaction`
      SELECT intent FROM omni_communication_intents
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND intent_id = ${input.draft.intentId} LIMIT 1
    `;
    const intent = communicationIntentSchema.parse(intentRows[0]?.intent);
    const linkBody = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: `conversation_link:${randomUUID()}`,
      channel: input.draft.channel,
      externalThreadId: receipt.externalThreadId,
      canonicalThreadId: intent.canonicalThreadId,
      projectId: intent.projectId,
      missionId: intent.missionId,
      runId: intent.runId,
      draftId: input.draft.id,
      createdAt: now,
    };
    const proposedLink = conversationLinkSchema.parse({
      ...linkBody,
      linkSha256: canonicalJsonSha256(linkBody),
    });
    await transaction`
      INSERT INTO omni_delivery_receipts (
        tenant_id, owner_actor_id, receipt_id, draft_id, provider,
        provider_message_id, external_thread_id, receipt_sha256, receipt,
        delivered_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${receipt.id}, ${receipt.draftId},
        ${receipt.provider}, ${receipt.providerMessageId}, ${receipt.externalThreadId},
        ${receipt.receiptSha256}, ${receipt}::jsonb, ${receipt.deliveredAt}
      )
    `;
    await transaction`
      INSERT INTO omni_conversation_links (
        tenant_id, owner_actor_id, link_id, channel, external_thread_id,
        canonical_thread_id, project_id, mission_id, run_id, link, created_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${proposedLink.id}, ${proposedLink.channel},
        ${proposedLink.externalThreadId}, ${proposedLink.canonicalThreadId}, ${proposedLink.projectId},
        ${proposedLink.missionId}, ${proposedLink.runId}, ${proposedLink}::jsonb, ${proposedLink.createdAt}
      ) ON CONFLICT (tenant_id, owner_actor_id, channel, external_thread_id)
        DO NOTHING
    `;
    const linkRows = await transaction`
      SELECT link FROM omni_conversation_links
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND channel = ${proposedLink.channel}
        AND external_thread_id = ${proposedLink.externalThreadId}
      LIMIT 1
    `;
    const link = conversationLinkSchema.parse(linkRows[0]?.link);
    const currentRows = await transaction`
      SELECT draft FROM omni_message_drafts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${input.draft.id} LIMIT 1 FOR UPDATE
    `;
    const current = messageDraftSchema.parse(currentRows[0]?.draft);
    const delivered = messageDraftSchema.parse({
      ...current,
      state: "delivered",
      lifecycleRevision: current.lifecycleRevision + 1,
      updatedAt: now,
    });
    await transaction`
      UPDATE omni_message_drafts
      SET state = ${delivered.state}, lifecycle_revision = ${delivered.lifecycleRevision},
          draft = ${delivered}::jsonb, updated_at = ${delivered.updatedAt}
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${delivered.id}
    `;
    await appendCommunicationEvent({
      id: `communication-event:v1:${receipt.receiptSha256}`,
      streamId: `communication:${input.draft.id}`,
      type: "communication.delivery.verified",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        draftId: input.draft.id,
        draftSha256: input.draft.draftSha256,
        receiptId: receipt.id,
        receiptSha256: receipt.receiptSha256,
        provider: receipt.provider,
        providerMessageIdSha256: sha256(receipt.providerMessageId),
        externalThreadIdSha256: sha256(receipt.externalThreadId),
        linkSha256: link.linkSha256,
        outcome: receipt.outcome,
      },
      sql: transaction,
    });
    return receipt;
  }) as Promise<DeliveryReceipt>;
}

export async function failMessageDelivery(
  draftId: string,
  owner: OwnerScope,
) {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  return getSql().transaction(async (transaction: ReturnType<typeof getSql>) => {
    const rows = await transaction`
      SELECT draft FROM omni_message_drafts
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${requiredText(draftId, 240)} LIMIT 1 FOR UPDATE
    `;
    if (!rows[0]) return undefined;
    const current = messageDraftSchema.parse(rows[0].draft);
    if (current.state !== "delivering") return current;
    const failed = messageDraftSchema.parse({
      ...current,
      state: "failed",
      lifecycleRevision: current.lifecycleRevision + 1,
      updatedAt: new Date().toISOString(),
    });
    await transaction`
      UPDATE omni_message_drafts
      SET state = ${failed.state}, lifecycle_revision = ${failed.lifecycleRevision},
          draft = ${failed}::jsonb, updated_at = ${failed.updatedAt}
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND draft_id = ${failed.id}
    `;
    return failed;
  });
}

export async function mapInboundCommunication(input: {
  provider: "gmail";
  providerMessageId: string;
  externalThreadId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  content: string;
  receivedAt: string;
}, owner: OwnerScope): Promise<InboundCommunicationEnvelope | undefined> {
  requireDatabase();
  const scope = exactOwner(owner);
  await ensureDatabaseSchema();
  const sql = getSql();
  return sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const linkRows = await transaction`
      SELECT link FROM omni_conversation_links
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND channel = 'email'
        AND external_thread_id = ${requiredText(input.externalThreadId, 500)}
      LIMIT 1
    `;
    if (!linkRows[0]) return undefined;
    const link = conversationLinkSchema.parse(linkRows[0].link);
    const inboundId = `inbound_communication:${deterministicUuid(
      `${scope.tenantId}\0${scope.actorId}\0${input.provider}\0${input.providerMessageId}`,
    )}`;
    const priorRows = await transaction`
      SELECT envelope FROM omni_inbound_communications
      WHERE tenant_id = ${scope.tenantId} AND owner_actor_id = ${scope.actorId}
        AND inbound_id = ${inboundId} LIMIT 1
    `;
    if (priorRows[0]) return inboundCommunicationEnvelopeSchema.parse(priorRows[0].envelope);
    const body = {
      version: GOVERNED_COMMUNICATION_VERSION,
      id: inboundId,
      provider: input.provider,
      providerMessageId: requiredText(input.providerMessageId, 500),
      externalThreadId: requiredText(input.externalThreadId, 500),
      linkId: link.id,
      fromAddressSha256: sha256(canonicalAddressHeader(input.fromAddress)),
      toAddressSha256: sha256(canonicalAddressHeader(input.toAddress)),
      subjectSha256: sha256(input.subject.trim()),
      contentSha256: sha256(input.content),
      receivedAt: new Date(input.receivedAt).toISOString(),
      untrusted: true as const,
    };
    const envelope = inboundCommunicationEnvelopeSchema.parse({
      ...body,
      envelopeSha256: canonicalJsonSha256(body),
    });
    await transaction`
      INSERT INTO omni_inbound_communications (
        tenant_id, owner_actor_id, inbound_id, provider, provider_message_id,
        external_thread_id, link_id, content_sha256, envelope, received_at
      ) VALUES (
        ${scope.tenantId}, ${scope.actorId}, ${envelope.id}, ${envelope.provider},
        ${envelope.providerMessageId}, ${envelope.externalThreadId}, ${envelope.linkId},
        ${envelope.contentSha256}, ${envelope}::jsonb, ${envelope.receivedAt}
      )
    `;
    await appendCommunicationEvent({
      id: `communication-event:v1:${envelope.envelopeSha256}`,
      streamId: `communication-link:${link.id}`,
      type: "communication.inbound.mapped",
      scope: scope.executionScope,
      payload: {
        schemaVersion: 1,
        inboundId: envelope.id,
        linkId: link.id,
        provider: envelope.provider,
        providerMessageIdSha256: sha256(envelope.providerMessageId),
        externalThreadIdSha256: sha256(envelope.externalThreadId),
        contentSha256: envelope.contentSha256,
        canonicalThreadId: link.canonicalThreadId,
        projectId: link.projectId,
        missionId: link.missionId,
        runId: link.runId,
        untrusted: true,
      },
      sql: transaction,
    });
    return envelope;
  }) as Promise<InboundCommunicationEnvelope | undefined>;
}

async function getPolicyForUpdate(
  policyId: string,
  owner: ReturnType<typeof exactOwner>,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    SELECT policy FROM omni_person_contact_policies
    WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.actorId}
      AND policy_id = ${requiredText(policyId, 240)} LIMIT 1 FOR UPDATE
  `;
  if (!rows[0]) throw new CommunicationPolicyError("Contact policy was not found.", "not_found");
  return personContactPolicySchema.parse(rows[0].policy);
}

function assertPolicyAllowsDraft(
  policy: PersonContactPolicy,
  purpose: CommunicationIntent["purpose"],
  disclosure: CommunicationIntent["disclosure"],
) {
  if (policy.status !== "active" || policy.consent === "unknown") {
    throw new CommunicationPolicyError("Contact policy does not permit delivery.", "policy_blocked");
  }
  if (!policy.allowedPurposes.includes(purpose)) {
    throw new CommunicationPolicyError("Communication purpose is outside the contact policy.", "policy_blocked");
  }
  if (disclosureRank(disclosure) > disclosureRank(policy.allowedDisclosure)) {
    throw new CommunicationPolicyError("Communication disclosure exceeds the contact policy.", "policy_blocked");
  }
}

function assertOutsideQuietHours(policy: PersonContactPolicy, now: Date) {
  if (!policy.quietHours.enabled) return;
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-GB", {
      timeZone: policy.quietHours.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
  } catch {
    throw new CommunicationPolicyError("Contact quiet-hours timezone is invalid.", "policy_blocked");
  }
  const start = policy.quietHours.start;
  const end = policy.quietHours.end;
  const blocked = start < end
    ? local >= start && local < end
    : local >= start || local < end;
  if (blocked) {
    throw new CommunicationPolicyError("Delivery is deferred by contact quiet hours.", "quiet_hours");
  }
}

function exactOwner(owner: OwnerScope) {
  const tenantId = requiredText(owner.tenantId, 160);
  const actorId = requiredText(owner.actorId, 500);
  assertExecutionScopeTenant(owner.executionScope, tenantId);
  if (owner.executionScope.initiatingActorId !== actorId) {
    throw new Error("Communication execution actor does not match its owner.");
  }
  return { tenantId, actorId, executionScope: owner.executionScope };
}

async function appendCommunicationEvent(input: {
  id: string;
  streamId: string;
  type: string;
  scope: ExecutionScope;
  payload: Record<string, unknown>;
  sql: ReturnType<typeof getSql>;
}) {
  await appendScopedDomainEvent({
    id: input.id,
    streamId: input.streamId,
    type: input.type,
    executionScope: input.scope,
    payload: input.payload,
  }, { sql: input.sql });
}

function draftContentSha256(value: {
  version: string;
  id: string;
  intentId: string;
  policyId: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  senderIdentity: string;
  createdAt: string;
}) {
  return canonicalJsonSha256({
    version: value.version,
    id: value.id,
    intentId: value.intentId,
    policyId: value.policyId,
    channel: value.channel,
    recipient: value.recipient,
    subject: value.subject,
    body: value.body,
    senderIdentity: value.senderIdentity,
    createdAt: value.createdAt,
  });
}

function normalizeAddress(channel: string, value: string) {
  const address = requiredText(value, 500);
  if (channel !== "email") return address;
  const match = address.match(/<([^<>]+)>/);
  const email = (match?.[1] || address).trim().toLowerCase();
  if (!zEmail(email)) throw new Error("Contact email address is invalid.");
  return email;
}

function canonicalAddressHeader(value: string) {
  return requiredText(value, 500).toLowerCase().replace(/\s+/g, " ");
}

function zEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function disclosureRank(value: PersonContactPolicy["allowedDisclosure"]) {
  return ["public_only", "relationship_context", "confidential"].indexOf(value);
}

function deterministicUuid(value: string) {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Communication digest is invalid.");
  return value;
}

function requiredText(value: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) throw new Error("Communication field is invalid.");
  return text;
}

function optionalText(value: string | undefined, maxLength: number) {
  return value ? requiredText(value, maxLength) : null;
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new CommunicationPolicyError(
      "Governed communications require durable database storage.",
      "database_required",
    );
  }
}
