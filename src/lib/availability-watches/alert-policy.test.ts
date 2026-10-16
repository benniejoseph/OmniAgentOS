import { describe,it,expect } from "vitest";
import { availabilityWatchNotificationCandidate,decideServerNotification } from "@/lib/mobile/notification-delivery-policy";
import { notificationDecisionV1Schema } from "@/lib/mobile/notification-decision";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("time-sensitive booking openings",()=>{
  const candidate=availabilityWatchNotificationCandidate({tenantId:"test",actorId:"owner",sourceKind:"availability_watch",sourceId:"watch-one",occurrenceKey:"opening-one"});
  it("delivers during the morning quiet-hour overlap without labeling a booking critical",()=>{
    const decision=decideServerNotification({candidate,policy:{evaluatedAt:"2026-10-19T04:30:00.000Z",quietHoursActive:true,cooldownActive:false,digestEnabled:false}});
    expect(decision).toMatchObject({outcome:"send",reason:"availability_opened",critical:false,quietHoursActive:true,bypassedQuietHours:true});
    expect(notificationDecisionV1Schema.safeParse(decision).success).toBe(true);
  });
  it("still validates earlier saved deferred receipts without rewriting history",()=>{
    const fresh=decideServerNotification({candidate,policy:{evaluatedAt:"2026-10-16T04:30:00.000Z",quietHoursActive:true,cooldownActive:false,digestEnabled:false}});
    const {receiptSha256: _digest,...old}= {...fresh,outcome:"defer",reason:"quiet_hours",bypassedQuietHours:false};
    expect(notificationDecisionV1Schema.safeParse({...old,receiptSha256:canonicalJsonSha256(old)}).success).toBe(true);
  });
});
