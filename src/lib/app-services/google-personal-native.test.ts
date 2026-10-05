import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks = vi.hoisted(() => ({ admit: vi.fn(),read: vi.fn(),review: vi.fn(),settle: vi.fn(),sync: vi.fn(),execution: vi.fn(),mayRevoke: vi.fn(),revoke: vi.fn() }));
vi.mock("@/lib/connectors/google-personal-native-store",() => ({ admitGooglePersonalNativeAction: mocks.admit,readGooglePersonalNativeAction: mocks.read,
  reviewGooglePersonalNativeActions: mocks.review,settleGooglePersonalNativeAction: mocks.settle,googlePersonalNativeSyncExecution: mocks.execution,mayRevokeGooglePersonalNativeToken: mocks.mayRevoke }));
vi.mock("@/lib/connectors/personal-sync",() => ({ syncPersonalProvider: mocks.sync }));
vi.mock("@/lib/connectors/oauth-providers",() => ({ googleConnectorAccountPolicyForIdentity: () => ({ email: "owner@example.test",purpose: "personal" }),revokeOAuthAccess: mocks.revoke }));
import { createAppServiceCaller,createRequestMutationAppServiceCaller } from "./contracts";
import { readGooglePersonalNativeService,submitGooglePersonalNativeService } from "./google-personal-native";
import { buildGooglePersonalNativeAcceptance,buildGooglePersonalNativeIntent,sealGooglePersonalNativeReview,type GooglePersonalNativeAction } from "@/lib/connectors/google-personal-native-contracts";
import { nativeGooglePersonalSchemas } from "@/lib/mobile/google-personal-native-contracts";
import type { SecurityContext } from "@/lib/security/types";
const context: SecurityContext = { tenantId: "google-service",actorId: "owner@example.test",role: "operator",source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111",email: "owner@example.test",sessionId: "google-session",tenantName: "Private" } };
const scope = { tenantId: context.tenantId,ownerActorId: context.actorId,canonicalActorId: `actor:${context.auth!.userId}` };
const review = sealGooglePersonalNativeReview({ connectionId: "google-one",accountEmail: context.actorId,authorizationGeneration: 3,status: "active",
  sourceScopeSha256: "a".repeat(64),permittedSources: ["mail","calendar","drive"] });
const request = { contract: "asael-google-personal-action:1" as const,action: "sync" as const,review },key = "google-once",at = "2026-10-04T00:00:00.000Z";
const intent = buildGooglePersonalNativeIntent({ scope,request,idempotencyKey: key });
let durable: GooglePersonalNativeAction;
function caller(role = context.role) { return createRequestMutationAppServiceCaller(new Request("https://asael.test/api/oauth/google/actions",{
  method: "POST",headers: { "Idempotency-Key": key } }),{ ...context,role },{ purpose: "api.google.personal.action",causationId: review.connectionId }); }
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  durable = { acceptance: buildGooglePersonalNativeAcceptance(intent,at),state: "accepted",settlement: null };
  mocks.admit.mockImplementation(async () => ({ intent,action: durable,newlyAccepted: true,lease: { ownerId: "lease-one",generation: 1,expiresAt: at },providerToken: null }));
  mocks.read.mockImplementation(async () => ({ current: { connection: review,availableActions: [],busy: false,blockedAction: durable.state === "accepted" ? durable : null },action: durable }));
  mocks.execution.mockReturnValue({ fixture: "only-first-dispatch" });
  mocks.settle.mockImplementation(async (_authority,_intent,settlement) => (durable = { ...durable,state: "settled",settlement }));
  mocks.sync.mockResolvedValue({ provider: "google",status: "healthy",imported: 3,removed: 0,cursorAdvanced: true,
    grant: { id: review.connectionId,tenantId: scope.tenantId,actorId: scope.ownerActorId,accountEmail: context.actorId,authorizationGeneration: 3 },
    sources: review.permittedSources.map((source) => ({ source,status: "healthy",backfillState: "complete",imported: 1,removed: 0,lastAttemptedAt: at,lastSuccessfulAt: at })) });
});
describe("native Google acceptance before external work",() => {
  it("dispatches once with the exact complete reviewed source set and binds the receipt",async () => {
    const result = await submitGooglePersonalNativeService(caller(),request);
    expect(mocks.admit.mock.invocationCallOrder[0]).toBeLessThan(mocks.sync.mock.invocationCallOrder[0]);
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connectionId: review.connectionId,sources: ["mail","calendar","drive"],expectedAuthorizationGeneration: 3 }));
    expect(result.data.action.state).toBe("settled");
    expect(nativeGooglePersonalSchemas.NativeGooglePersonalSubmitResponse.parse({ ...result.data,serviceReceipt: result.receipt })).toBeTruthy();
    expect(result.receipt.idempotencyKeySha256).toBe(durable.acceptance.idempotencyKeySha256);
  });
  it("leaves failed work held and replay/read never dispatch or settle again",async () => {
    mocks.sync.mockRejectedValue(new Error("private provider information"));
    const first = await submitGooglePersonalNativeService(caller(),request);
    expect(first.data.action.state).toBe("accepted"); expect(JSON.stringify(first)).not.toContain("private provider information");
    mocks.admit.mockResolvedValue({ intent,action: durable,newlyAccepted: false,lease: null,providerToken: null });
    const replay = await submitGooglePersonalNativeService(caller(),request);
    expect(replay.data.replayed).toBe(true);
    const recovered = await readGooglePersonalNativeService(createAppServiceCaller({ context: { ...context,role: "viewer" } }),intent.idempotencyKeySha256);
    expect(recovered.data.action).toEqual(durable);
    expect(mocks.sync).toHaveBeenCalledTimes(1); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("uses only the captured old token after local revocation and records uncertainty",async () => {
    const disconnect = { ...request,action: "disconnect" as const },acceptedIntent = buildGooglePersonalNativeIntent({ scope,request: disconnect,idempotencyKey: key });
    durable = { acceptance: buildGooglePersonalNativeAcceptance(acceptedIntent,at),state: "accepted",settlement: null };
    mocks.admit.mockResolvedValue({ intent: acceptedIntent,action: durable,newlyAccepted: true,lease: null,providerToken: "synthetic-old-token" });
    mocks.mayRevoke.mockResolvedValue(true); mocks.revoke.mockRejectedValue(new Error("network uncertain"));
    const result = await submitGooglePersonalNativeService(caller(),disconnect);
    expect(result.data.action.acceptance.localRevoked).toBe(true);
    expect(result.data.action.settlement).toMatchObject({ action: "disconnect",providerRevocation: "unconfirmed" });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("google","synthetic-old-token"); expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("denies a viewer before durable admission",async () => {
    await expect(submitGooglePersonalNativeService(caller("viewer"),request)).rejects.toThrow();
    expect(mocks.admit).not.toHaveBeenCalled(); expect(mocks.sync).not.toHaveBeenCalled();
  });
});
