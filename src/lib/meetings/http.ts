import {
  MeetingCommitmentReconciliationRequiredError,
  MeetingWriteDeniedError,
} from "@/lib/app-services/meetings";
import { meetingResolutionReconciliationSchema } from "@/lib/meetings/commitment-resolution-intent";
import {
  MeetingConflictError,
  MeetingUnavailableError,
} from "@/lib/meetings/store";
import { SharedContextAuthorityError } from "@/lib/memory/shared-context";

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

export function meetingFailureResponse(error: unknown, operation: string) {
  if (error instanceof SharedContextAuthorityError) {
    return Response.json(
      { error: error.code === "scope_not_found"
        ? "Workspace not found."
        : "Workspace authority is unavailable." },
      { status: error.code === "scope_not_found" ? 404 : 503, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof MeetingWriteDeniedError) {
    return Response.json({ error: error.message }, { status: 403, headers: privateNoStoreHeaders });
  }
  if (error instanceof MeetingCommitmentReconciliationRequiredError) {
    const reconciliation = error.reconciliation === undefined
      ? undefined
      : meetingResolutionReconciliationSchema.safeParse(error.reconciliation);
    if (reconciliation && !reconciliation.success) {
      return Response.json(
        { error: "Meeting resolution evidence is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    return Response.json({
      error: error.message,
      code: error.reconciliationCode,
      ...(reconciliation?.success ? { reconciliation: reconciliation.data } : {}),
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  if (error instanceof MeetingConflictError) {
    return Response.json({ error: error.message }, { status: 409, headers: privateNoStoreHeaders });
  }
  if (error instanceof MeetingUnavailableError) {
    return Response.json({ error: error.message }, { status: 503, headers: privateNoStoreHeaders });
  }
  console.error(`Meeting ${operation} failed.`, error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: `Meeting ${operation} is temporarily unavailable.` },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
