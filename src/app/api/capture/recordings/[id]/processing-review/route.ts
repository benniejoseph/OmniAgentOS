import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewMeetingRecordingService } from "@/lib/app-services/meeting-recordings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { nativeRecordingFailure, nativeRecordingHeaders, nativeRecordingQuery, privateRecordingResponse } from "../../native-processing-http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string }> }) => {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording", resourceId: id }); }
  catch (error) { return privateRecordingResponse(forbiddenResponse(error)); }
  try {
    const result = await reviewMeetingRecordingService(createAppServiceCaller({ context }), id, nativeRecordingQuery(request));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeRecordingHeaders });
  } catch (error) { return nativeRecordingFailure(error); }
});
