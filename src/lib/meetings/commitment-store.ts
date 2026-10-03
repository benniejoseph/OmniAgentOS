import type {
  CaptureMediaActionItem,
  CaptureMediaOutput,
} from "@/lib/capture/media-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  meetingCommitmentProposalId,
  meetingCommitmentProposalSchema,
  meetingCommitmentResolutionSchema,
  meetingCommitmentViewSchema,
  withMeetingCommitmentProposalDigest,
  type MeetingCommitmentProposal,
  type MeetingCommitmentResolution,
  type MeetingCommitmentView,
} from "@/lib/meetings/commitment-contracts";
import type { MeetingRevision } from "@/lib/meetings/contracts";
import {
  MeetingConflictError,
  MeetingUnavailableError,
  type MeetingMutationAuthority,
  type MeetingReadAuthority,
} from "@/lib/meetings/store";
import {
  assertMeetingResolutionPhaseOrder, meetingResolutionIntentBody,
  meetingResolutionIntentSchema, meetingResolutionPhaseSchema, meetingResolutionReconciliation,
  type MeetingResolutionDecision, type MeetingResolutionIntent, type MeetingResolutionPhase,
  type MeetingResolutionReconciliation,
} from "@/lib/meetings/commitment-resolution-intent";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type MeetingSql = ReturnType<typeof getSql>;

export async function createMeetingCommitmentProposal(input: {
  authority: MeetingMutationAuthority;
  meeting: MeetingRevision;
  media: CaptureMediaOutput;
  actionItem: CaptureMediaActionItem;
}): Promise<MeetingCommitmentView> {
  requireDatabase();
  await ensureDatabaseSchema();
  const { authority, meeting, media, actionItem } = input;
  assertAuthority(authority, meeting);
  if (!meeting.projectId) {
    throw new MeetingConflictError(
      "Link this meeting to a project before proposing canonical work.",
    );
  }
  const projectId = meeting.projectId;
  if (media.tenantId !== authority.tenantId || media.meetingId !== meeting.meetingId) {
    throw new MeetingConflictError("The cited media does not belong to this meeting.");
  }
  const sourceLink = meeting.sourceLinks.find((link) =>
    link.kind === "capture_recording" && link.sourceId === media.recordingId
  );
  if (!sourceLink) {
    throw new MeetingConflictError("The cited recording is not linked to this meeting.");
  }
  const exactAction = media.actionItems.find((item) =>
    item.actionItemId === actionItem.actionItemId
  );
  if (!exactAction || canonicalJsonSha256(exactAction) !== canonicalJsonSha256(actionItem)) {
    throw new MeetingConflictError("The cited action item changed. Refresh and try again.");
  }
  const ownerParticipant = actionItem.ownerParticipantId
    ? meeting.participants.find((participant) =>
        participant.participantId === actionItem.ownerParticipantId
      )
    : undefined;
  if (actionItem.ownerParticipantId && !ownerParticipant) {
    throw new MeetingConflictError("The evidenced owner is no longer a meeting participant.");
  }
  const proposalId = meetingCommitmentProposalId({
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    meetingId: meeting.meetingId,
    mediaRevisionId: media.mediaRevisionId,
    actionItemId: actionItem.actionItemId,
  });

  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: MeetingSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${proposalId}`}, 0
        ))
      `;
      const existing = await readProposalView(sql, authority, proposalId);
      if (existing) {
        assertSameProposalSource(existing.proposal, media, actionItem);
        return existing;
      }
      const clock = await sql`SELECT clock_timestamp() AS proposed_at`;
      const proposal = withMeetingCommitmentProposalDigest({
        schemaVersion: 1,
        contractVersion: "p10.8-meeting-commitment-conversion:1",
        proposalId,
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
        meetingId: meeting.meetingId,
        meetingRevisionId: meeting.meetingRevisionId,
        meetingSha256: meeting.meetingSha256,
        projectId,
        sourceLinkId: sourceLink.linkId,
        recordingId: media.recordingId,
        mediaRevisionId: media.mediaRevisionId,
        mediaOutputSha256: media.outputSha256,
        actionItemId: actionItem.actionItemId,
        actionItemSha256: canonicalJsonSha256(actionItem),
        title: actionItem.text,
        citations: actionItem.citations,
        ownership: ownerParticipant ? {
          participantId: ownerParticipant.participantId,
          displayName: ownerParticipant.displayName,
          authority: "explicit_transcript",
        } : {
          participantId: null,
          displayName: null,
          authority: "confirmation_required",
        },
        dueDate: actionItem.dueAt ? {
          dueAt: new Date(actionItem.dueAt).toISOString(),
          authority: "explicit_transcript",
        } : {
          dueAt: null,
          authority: "confirmation_required",
        },
        proposedByActorId: authority.canonicalActorId,
        proposedAt: timestamp(clock[0]?.proposed_at),
      });
      await sql`
        INSERT INTO omni_meeting_commitment_proposals (
          tenant_id, workspace_id, meeting_id, proposal_id, owner_actor_id,
          project_id, effective_access_class, meeting_revision_id,
          media_revision_id, action_item_id, proposal_sha256,
          proposal_snapshot, proposed_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${meeting.meetingId},
          ${proposal.proposalId}, ${meeting.ownerActorId}, ${projectId},
          ${meeting.effectiveAccessClass}, ${meeting.meetingRevisionId},
          ${media.mediaRevisionId}, ${actionItem.actionItemId},
          ${proposal.proposalSha256}, ${proposal}::JSONB, ${proposal.proposedAt}
        )
      `;
      await appendScopedDomainEvent({
        id: `meeting-commitment-proposed:${proposal.proposalSha256}`,
        streamId: meeting.meetingId,
        type: "meeting.commitment.proposed",
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          meetingId: meeting.meetingId,
          meetingRevisionId: meeting.meetingRevisionId,
          proposalId: proposal.proposalId,
          projectId: proposal.projectId,
          mediaRevisionId: proposal.mediaRevisionId,
          actionItemId: proposal.actionItemId,
          actionItemSha256: proposal.actionItemSha256,
          proposalSha256: proposal.proposalSha256,
          ownershipAuthority: proposal.ownership.authority,
          dueDateAuthority: proposal.dueDate.authority,
          citationCount: proposal.citations.length,
        },
      }, { sql });
      return meetingCommitmentViewSchema.parse({ proposal, resolution: null });
    }) as Promise<MeetingCommitmentView>,
  );
}

export async function listMeetingCommitmentViews(
  authority: MeetingReadAuthority,
  meetingId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT proposal.proposal_snapshot, resolution.resolution_snapshot,
          intent.intent_snapshot,
          (SELECT jsonb_agg(progress.phase_snapshot ORDER BY progress.phase_order)
           FROM omni_meeting_commitment_resolution_progress progress
           WHERE progress.tenant_id = intent.tenant_id
             AND progress.workspace_id = intent.workspace_id
             AND progress.proposal_id = intent.proposal_id) AS resolution_phases
        FROM omni_meeting_commitment_proposals proposal
        LEFT JOIN omni_meeting_commitment_resolutions resolution
          ON resolution.tenant_id = proposal.tenant_id
         AND resolution.workspace_id = proposal.workspace_id
         AND resolution.proposal_id = proposal.proposal_id
        LEFT JOIN omni_meeting_commitment_resolution_intents intent
          ON intent.tenant_id = proposal.tenant_id
         AND intent.workspace_id = proposal.workspace_id
         AND intent.proposal_id = proposal.proposal_id
         AND intent.owner_actor_id = ${authority.canonicalActorId}
        WHERE proposal.tenant_id = ${authority.tenantId}
          AND proposal.workspace_id = ${authority.workspaceId}
          AND proposal.meeting_id = ${meetingId}
        ORDER BY proposal.proposed_at ASC, proposal.proposal_id ASC
        LIMIT 500
      `;
      return Object.freeze(rows.map(viewFromRow));
    },
  );
}

export async function getMeetingCommitmentView(
  authority: MeetingReadAuthority,
  meetingId: string,
  proposalId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => readProposalView(getSql(), authority, proposalId, meetingId),
  );
}

export async function recordMeetingCommitmentResolution(input: {
  authority: MeetingMutationAuthority;
  proposal: MeetingCommitmentProposal;
  resolution: MeetingCommitmentResolution;
  intent: MeetingResolutionIntent;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const { authority, proposal } = input;
  const resolution = meetingCommitmentResolutionSchema.parse(input.resolution);
  if (
    proposal.tenantId !== authority.tenantId ||
    proposal.workspaceId !== authority.workspaceId ||
    resolution.proposalId !== proposal.proposalId ||
    resolution.proposalSha256 !== proposal.proposalSha256
  ) {
    throw new MeetingConflictError("Commitment resolution scope is invalid.");
  }
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    () => getSql().transaction(async (sql: MeetingSql) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${authority.tenantId}:${authority.workspaceId}:${proposal.proposalId}:resolution`},
          0
        ))
      `;
      const existing = await readProposalView(
        sql,
        authority,
        proposal.proposalId,
        proposal.meetingId,
      );
      if (!existing) throw new MeetingConflictError("Commitment proposal was not found.");
      if (existing.proposal.proposalSha256 !== proposal.proposalSha256) {
        throw new MeetingConflictError("Commitment proposal evidence changed.");
      }
      const claimed = await readResolutionIntent(sql, authority, proposal.proposalId);
      if (!claimed || claimed.requestSha256 !== input.intent.requestSha256 ||
        claimed.proposalSha256 !== proposal.proposalSha256 || claimed.request.decision !== resolution.decision ||
        claimed.ownerActorId !== resolution.resolvedByActorId) {
        throw new MeetingConflictError("The exact resolution decision was not claimed.");
      }
      if (claimed.request.decision === "confirmed" && (
        claimed.request.ownerParticipantId !== resolution.ownerParticipantId ||
        claimed.request.dueAt !== resolution.dueAt ||
        (claimed.request.communication?.policyId || null) !== resolution.communicationPolicyId ||
        Boolean(claimed.request.communication) !== Boolean(resolution.draftId)
      )) throw new MeetingConflictError("The resolution differs from its immutable decision.");
      if (existing.resolution) {
        if (existing.resolution.resolutionSha256 !== resolution.resolutionSha256) {
          throw new MeetingConflictError("This commitment proposal is already resolved.");
        }
        return existing;
      }
      const phases = await readResolutionPhases(sql, authority, proposal.proposalId);
      if (phases.at(-1)?.phase !== "resolution_started") {
        throw new MeetingConflictError("The exact child effects have not reached final resolution.");
      }
      const completed = (phase: MeetingResolutionPhase["phase"]) => phases.find((value) => value.phase === phase)?.resourceId;
      if (resolution.decision === "confirmed" && (
        completed("work_completed") !== resolution.workItemId ||
        (completed("draft_completed") || null) !== resolution.draftId ||
        completed("meeting_completed") !== resolution.meetingRevisionId
      )) throw new MeetingConflictError("The resolution does not match the persisted child receipts.");
      const effectiveAccessClass = await meetingAccessClassForProposal(
        existing.proposal,
        sql,
      );
      await sql`
        INSERT INTO omni_meeting_commitment_resolutions (
          tenant_id, workspace_id, meeting_id, proposal_id, resolution_id,
          owner_actor_id, project_id, effective_access_class,
          proposal_sha256, decision, work_item_id, draft_id,
          resolution_sha256, resolution_snapshot, resolved_at
        ) VALUES (
          ${authority.tenantId}, ${authority.workspaceId}, ${proposal.meetingId},
          ${proposal.proposalId}, ${resolution.resolutionId},
          ${resolution.resolvedByActorId}, ${proposal.projectId},
          ${effectiveAccessClass},
          ${proposal.proposalSha256}, ${resolution.decision},
          ${resolution.workItemId}, ${resolution.draftId},
          ${resolution.resolutionSha256}, ${resolution}::JSONB,
          ${resolution.resolvedAt}
        )
      `;
      await appendScopedDomainEvent({
        id: `meeting-commitment-resolved:${resolution.resolutionSha256}`,
        streamId: proposal.meetingId,
        type: resolution.decision === "confirmed"
          ? "meeting.commitment.confirmed"
          : "meeting.commitment.dismissed",
        executionScope: authority.executionScope,
        payload: {
          schemaVersion: 1,
          meetingId: proposal.meetingId,
          proposalId: proposal.proposalId,
          proposalSha256: proposal.proposalSha256,
          resolutionId: resolution.resolutionId,
          resolutionSha256: resolution.resolutionSha256,
          decision: resolution.decision,
          workItemId: resolution.workItemId,
          draftId: resolution.draftId,
          ownershipAuthority: resolution.ownershipAuthority,
          dueDateAuthority: resolution.dueDateAuthority,
        },
      }, { sql });
      return meetingCommitmentViewSchema.parse({ proposal, resolution,
        reconciliation: meetingResolutionReconciliation(claimed, phases, true),
      });
    }) as Promise<MeetingCommitmentView>,
  );
}

async function readProposalView(
  sql: MeetingSql,
  authority: MeetingReadAuthority,
  proposalId: string,
  meetingId?: string,
) {
  const rows = await sql`
    SELECT proposal.proposal_snapshot, resolution.resolution_snapshot,
          intent.intent_snapshot,
          (SELECT jsonb_agg(progress.phase_snapshot ORDER BY progress.phase_order)
           FROM omni_meeting_commitment_resolution_progress progress
           WHERE progress.tenant_id = intent.tenant_id
             AND progress.workspace_id = intent.workspace_id
             AND progress.proposal_id = intent.proposal_id) AS resolution_phases
    FROM omni_meeting_commitment_proposals proposal
    LEFT JOIN omni_meeting_commitment_resolutions resolution
      ON resolution.tenant_id = proposal.tenant_id
     AND resolution.workspace_id = proposal.workspace_id
     AND resolution.proposal_id = proposal.proposal_id
    LEFT JOIN omni_meeting_commitment_resolution_intents intent
      ON intent.tenant_id = proposal.tenant_id
     AND intent.workspace_id = proposal.workspace_id
     AND intent.proposal_id = proposal.proposal_id
     AND intent.owner_actor_id = ${authority.canonicalActorId}
    WHERE proposal.tenant_id = ${authority.tenantId}
      AND proposal.workspace_id = ${authority.workspaceId}
      AND proposal.proposal_id = ${proposalId}
      AND (${meetingId || null}::TEXT IS NULL OR proposal.meeting_id = ${meetingId || null})
    LIMIT 1
  `;
  return rows[0] ? viewFromRow(rows[0]) : undefined;
}

function viewFromRow(row: Record<string, unknown>) {
  return meetingCommitmentViewSchema.parse({
    proposal: meetingCommitmentProposalSchema.parse(row.proposal_snapshot),
    resolution: row.resolution_snapshot
      ? meetingCommitmentResolutionSchema.parse(row.resolution_snapshot)
      : null,
    ...(row.intent_snapshot ? {
      reconciliation: meetingResolutionReconciliation(
        meetingResolutionIntentSchema.parse(row.intent_snapshot),
        parseResolutionPhases(row.resolution_phases), Boolean(row.resolution_snapshot),
      ),
    } : {}),
  });
}

async function meetingAccessClassForProposal(
  proposal: MeetingCommitmentProposal,
  sql: MeetingSql,
) {
  const rows = await sql`
    SELECT effective_access_class
    FROM omni_meeting_commitment_proposals
    WHERE tenant_id = ${proposal.tenantId}
      AND workspace_id = ${proposal.workspaceId}
      AND proposal_id = ${proposal.proposalId}
    LIMIT 1
  `;
  const value = String(rows[0]?.effective_access_class || "");
  if (!(["owner_private", "project_members", "workspace_members"] as const).includes(
    value as "owner_private" | "project_members" | "workspace_members",
  )) {
    throw new MeetingConflictError("Commitment proposal access authority is invalid.");
  }
  return value;
}

function assertAuthority(authority: MeetingReadAuthority, meeting: MeetingRevision) {
  if (
    meeting.tenantId !== authority.tenantId ||
    meeting.workspaceId !== authority.workspaceId ||
    meeting.ownerActorId !== authority.canonicalActorId
  ) {
    throw new MeetingConflictError("Meeting commitment authority is invalid.");
  }
}

function assertSameProposalSource(
  proposal: MeetingCommitmentProposal,
  media: CaptureMediaOutput,
  actionItem: CaptureMediaActionItem,
) {
  if (
    proposal.mediaRevisionId !== media.mediaRevisionId ||
    proposal.mediaOutputSha256 !== media.outputSha256 ||
    proposal.actionItemId !== actionItem.actionItemId ||
    proposal.actionItemSha256 !== canonicalJsonSha256(actionItem)
  ) {
    throw new MeetingConflictError("Existing proposal is bound to different evidence.");
  }
}

function timestamp(value: unknown) {
  const parsed = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(parsed.getTime())) {
    throw new MeetingConflictError("Database did not provide a proposal timestamp.");
  }
  return parsed.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new MeetingUnavailableError();
}

export type MeetingResolutionClaimResult =
  | { state: "claimed" | "resolved" | "incomplete"; intent: MeetingResolutionIntent; view: MeetingCommitmentView }
  | { state: "legacy"; view: MeetingCommitmentView };

/** Commits the reviewed decision before entering any child store. It holds no
 * connection while children execute and never grants takeover of an old claim. */
export async function claimMeetingCommitmentResolution(input: {
  authority: MeetingMutationAuthority;
  proposal: MeetingCommitmentProposal;
  request: MeetingResolutionDecision;
}): Promise<MeetingResolutionClaimResult> {
  requireDatabase();
  await ensureDatabaseSchema();
  const { authority, proposal } = input;
  if (proposal.tenantId !== authority.tenantId || proposal.workspaceId !== authority.workspaceId ||
    proposal.proposedByActorId !== authority.canonicalActorId) {
    throw new MeetingConflictError("Resolution claim requires the exact proposal owner.");
  }
  const candidate = meetingResolutionIntentBody({
    tenantId: authority.tenantId, workspaceId: authority.workspaceId,
    meetingId: proposal.meetingId, proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256, ownerActorId: authority.canonicalActorId,
    request: input.request,
  });
  return runWithDatabaseActorScope(authority.tenantId, authority.readableActorIds,
    () => getSql().transaction(async (sql: MeetingSql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${`${authority.tenantId}:${authority.workspaceId}:${proposal.proposalId}:resolution`}, 0
      ))`;
      const view = await readProposalView(sql, authority, proposal.proposalId, proposal.meetingId);
      if (!view || view.proposal.proposalSha256 !== proposal.proposalSha256) {
        throw new MeetingConflictError("The exact commitment proposal was not found.");
      }
      const existing = await readResolutionIntent(sql, authority, proposal.proposalId);
      if (existing) {
        if (existing.requestSha256 !== candidate.requestSha256) {
          throw new MeetingConflictError("This proposal is bound to a different immutable resolution request.");
        }
        return { state: view.resolution ? "resolved" as const : "incomplete" as const, intent: existing, view };
      }
      // Old accepted evidence is never relabeled as proof of an unrecorded
      // recipient choice. Its read projection remains unchanged.
      if (view.resolution) return { state: "legacy" as const, view };
      const clock = await sql`SELECT clock_timestamp() AS created_at`;
      const intent = meetingResolutionIntentSchema.parse({ ...candidate, createdAt: timestamp(clock[0]?.created_at) });
      const accessClass = await meetingAccessClassForProposal(proposal, sql);
      await sql`INSERT INTO omni_meeting_commitment_resolution_intents (
        tenant_id, workspace_id, meeting_id, proposal_id, owner_actor_id,
        project_id, effective_access_class, proposal_sha256, request_sha256,
        intent_snapshot, created_at
      ) VALUES (
        ${authority.tenantId}, ${authority.workspaceId}, ${proposal.meetingId},
        ${proposal.proposalId}, ${authority.canonicalActorId}, ${proposal.projectId},
        ${accessClass}, ${proposal.proposalSha256}, ${intent.requestSha256},
        ${intent}::JSONB, ${intent.createdAt}
      )`;
      await appendScopedDomainEvent({
        id: `meeting-commitment-resolution-claimed:${intent.requestSha256}`,
        streamId: proposal.meetingId, type: "meeting.commitment.resolution.claimed",
        executionScope: authority.executionScope,
        payload: { schemaVersion: 1, meetingId: proposal.meetingId, proposalId: proposal.proposalId,
          proposalSha256: proposal.proposalSha256, requestSha256: intent.requestSha256,
          decision: intent.request.decision, automaticRetryAllowed: false },
      }, { sql });
      return { state: "claimed" as const, intent,
        view: meetingCommitmentViewSchema.parse({ ...view, reconciliation: meetingResolutionReconciliation(intent, [], false) }),
      };
    }) as Promise<MeetingResolutionClaimResult>,
  );
}

export async function recordMeetingCommitmentResolutionPhase(input: {
  authority: MeetingMutationAuthority;
  intent: MeetingResolutionIntent;
  phase: MeetingResolutionPhase["phase"];
  resourceId?: string;
  evidenceSha256?: string;
}): Promise<MeetingResolutionReconciliation | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  const { authority } = input;
  const intent = meetingResolutionIntentSchema.parse(input.intent);
  if (intent.tenantId !== authority.tenantId || intent.workspaceId !== authority.workspaceId ||
    intent.ownerActorId !== authority.canonicalActorId) throw new MeetingConflictError("Resolution phase scope is invalid.");
  return runWithDatabaseActorScope(authority.tenantId, authority.readableActorIds,
    () => getSql().transaction(async (sql: MeetingSql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${`${authority.tenantId}:${authority.workspaceId}:${intent.proposalId}:resolution`}, 0
      ))`;
      const stored = await readResolutionIntent(sql, authority, intent.proposalId);
      if (!stored || stored.requestSha256 !== intent.requestSha256) throw new MeetingConflictError("The exact resolution request is unavailable.");
      const view = await readProposalView(sql, authority, intent.proposalId, intent.meetingId);
      if (!view) throw new MeetingConflictError("The exact proposal is unavailable.");
      if (view.resolution) return view.reconciliation;
      const phases = await readResolutionPhases(sql, authority, intent.proposalId);
      const existing = phases.find((phase) => phase.phase === input.phase);
      if (existing) {
        if (existing.resourceId !== (input.resourceId || null) || existing.evidenceSha256 !== (input.evidenceSha256 || null)) throw new MeetingConflictError("The phase is already bound to different evidence.");
        return meetingResolutionReconciliation(stored, phases, false);
      }
      try { assertMeetingResolutionPhaseOrder(stored, phases, input.phase); }
      catch { throw new MeetingConflictError("Resolution phases do not permit this transition."); }
      const clock = await sql`SELECT clock_timestamp() AS recorded_at`;
      const phase = meetingResolutionPhaseSchema.parse({
        phase: input.phase, at: timestamp(clock[0]?.recorded_at),
        resourceId: input.resourceId || null, evidenceSha256: input.evidenceSha256 || null,
      });
      await sql`INSERT INTO omni_meeting_commitment_resolution_progress (
        tenant_id, workspace_id, meeting_id, proposal_id, owner_actor_id,
        request_sha256, phase, phase_order, phase_snapshot, recorded_at
      ) VALUES (
        ${authority.tenantId}, ${authority.workspaceId}, ${intent.meetingId}, ${intent.proposalId},
        ${authority.canonicalActorId}, ${intent.requestSha256}, ${phase.phase}, ${phases.length + 1},
        ${phase}::JSONB, ${phase.at}
      )`;
      await appendScopedDomainEvent({
        id: `meeting-commitment-resolution-phase:${intent.requestSha256}:${phase.phase}`,
        streamId: intent.meetingId, type: "meeting.commitment.resolution.progress",
        executionScope: authority.executionScope,
        payload: { schemaVersion: 1, meetingId: intent.meetingId, proposalId: intent.proposalId,
          requestSha256: intent.requestSha256, phase: phase.phase,
          resourceId: phase.resourceId, evidenceSha256: phase.evidenceSha256, automaticRetryAllowed: false },
      }, { sql });
      return meetingResolutionReconciliation(stored, [...phases, phase], false);
    }) as Promise<MeetingResolutionReconciliation | undefined>,
  );
}

async function readResolutionIntent(sql: MeetingSql, authority: MeetingReadAuthority, proposalId: string) {
  const rows = await sql`SELECT intent_snapshot
    FROM omni_meeting_commitment_resolution_intents
    WHERE tenant_id = ${authority.tenantId} AND workspace_id = ${authority.workspaceId}
      AND proposal_id = ${proposalId} AND owner_actor_id = ${authority.canonicalActorId}
    LIMIT 1`;
  return rows[0] ? meetingResolutionIntentSchema.parse(rows[0].intent_snapshot) : undefined;
}
function parseResolutionPhases(value: unknown): MeetingResolutionPhase[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new MeetingConflictError("Resolution progress is invalid.");
  const phases = value.map((phase) => meetingResolutionPhaseSchema.parse(phase));
  if (new Set(phases.map((phase) => phase.phase)).size !== phases.length) throw new MeetingConflictError("Resolution progress is duplicated.");
  return phases;
}
async function readResolutionPhases(sql: MeetingSql, authority: MeetingReadAuthority, proposalId: string) {
  const rows = await sql`SELECT phase_snapshot
    FROM omni_meeting_commitment_resolution_progress
    WHERE tenant_id = ${authority.tenantId} AND workspace_id = ${authority.workspaceId}
      AND proposal_id = ${proposalId} AND owner_actor_id = ${authority.canonicalActorId}
    ORDER BY phase_order ASC LIMIT 8`;
  return parseResolutionPhases(rows.map((row) => row.phase_snapshot));
}
