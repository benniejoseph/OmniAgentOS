import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  meetingDraftInputSchema,
  meetingRevisionSchema,
} from "@/lib/meetings/contracts";
import {
  getMeeting,
  listMeetings,
  saveMeeting,
  type MeetingMutationAuthority,
} from "@/lib/meetings/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  requestSharedMemoryAccessFromSecurityContext,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import { redactSensitive } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const meetingListServiceInputSchema = workspaceSelectionSchema.extend({
  status: meetingRevisionSchema.shape.status.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const meetingShowServiceInputSchema = workspaceSelectionSchema.extend({
  meetingId: z.string().trim().min(1).max(240),
}).strict();

export const meetingCreateServiceInputSchema = meetingDraftInputSchema.extend({
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const meetingUpdateServiceInputSchema = meetingDraftInputSchema.extend({
  workspaceId: z.string().trim().min(1).max(240).optional(),
  meetingId: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export class MeetingWriteDeniedError extends Error {
  constructor() {
    super("Meeting contributor access is required.");
    this.name = "MeetingWriteDeniedError";
  }
}

export async function listMeetingsService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingListServiceInputSchema>,
) {
  const value = meetingListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.list"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "read");
  const meetings = await listMeetings(readAuthority(caller, access), {
    limit: value.limit,
    status: value.status,
  });
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meetings,
  }, { resourceCount: meetings.length });
}

export async function showMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingShowServiceInputSchema>,
) {
  const value = meetingShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.show"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "read");
  const meeting = await getMeeting(readAuthority(caller, access), value.meetingId);
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting: meeting || null,
  }, { resourceCount: meeting ? 1 : 0 });
}

export async function createMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingCreateServiceInputSchema>,
) {
  const value = redactSensitive(
    meetingCreateServiceInputSchema.parse(input),
  ) as z.output<typeof meetingCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.create"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const { workspaceId: _workspaceId, ...draft } = value;
  void _workspaceId;
  const meeting = await saveMeeting({
    authority: mutationAuthority(caller, access),
    draft,
  });
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting,
  });
}

export async function updateMeetingService(
  caller: AppServiceCaller,
  input: z.input<typeof meetingUpdateServiceInputSchema>,
) {
  const value = redactSensitive(
    meetingUpdateServiceInputSchema.parse(input),
  ) as z.output<typeof meetingUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.meetings.update"),
  );
  const access = await meetingAccess(caller, value.workspaceId, "write");
  requireMeetingWrite(access);
  const {
    workspaceId: _workspaceId,
    meetingId,
    expectedRevision,
    ...draft
  } = value;
  void _workspaceId;
  const meeting = await saveMeeting({
    authority: mutationAuthority(caller, access),
    draft,
    meetingId,
    expectedRevision,
  });
  return completeAppServiceCall(authorized, {
    context: publicMeetingContext(access),
    meeting,
  });
}

async function meetingAccess(
  caller: AppServiceCaller,
  workspaceId: string | undefined,
  mode: "read" | "write",
) {
  return requestSharedMemoryAccessFromSecurityContext(caller.context, {
    scope: "workspace",
    workspaceId,
    correlationId:
      caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
    purposeId: mode === "write" ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `${mode === "write" ? "Manage" : "Read"} source-governed meetings.`,
  });
}

function requireMeetingWrite(access: RequestSharedMemoryAccessV1) {
  if (!access.authority.canWrite) throw new MeetingWriteDeniedError();
}

function readAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
) {
  return {
    tenantId: caller.context.tenantId,
    workspaceId: access.authority.workspaceId,
    canonicalActorId: access.actorBinding.canonicalActorId,
    readableActorIds: access.actorBinding.readableOwnerActorIds,
  };
}

function mutationAuthority(
  caller: AppServiceCaller,
  access: RequestSharedMemoryAccessV1,
): MeetingMutationAuthority {
  const source = caller.executionScope!;
  return {
    ...readAuthority(caller, access),
    idempotencyKey: caller.idempotencyKey!,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: access.actorBinding.canonicalActorId,
      executingPrincipalType: source.executingPrincipalType,
      executingPrincipalId: source.executingPrincipalType === "user"
        ? access.actorBinding.canonicalActorId
        : source.executingPrincipalId,
      workspaceId: access.authority.workspaceId,
      correlationId: source.correlationId,
      causationId: source.causationId,
      delegationId: source.delegationId,
      contextGrantIds: source.contextGrantIds,
      capabilityGrantIds: source.capabilityGrantIds,
      purpose: "meeting.write",
    }),
  };
}

function publicMeetingContext(access: RequestSharedMemoryAccessV1) {
  return Object.freeze({
    scope: "workspace" as const,
    workspaceId: access.authority.workspaceId,
    accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite,
    authoritySha256: access.authority.authoritySha256,
  });
}
