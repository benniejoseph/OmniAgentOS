import { createHash } from "node:crypto";
import { describe,expect,it } from "vitest";
import { buildGooglePersonalNativeAcceptance,buildGooglePersonalNativeIntent,googlePersonalNativeAcceptanceSchema,googlePersonalNativeActionSchema,
  googlePersonalNativeRequestSchema,sealGooglePersonalNativeReview } from "./google-personal-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
const scope = { tenantId: "google-test",ownerActorId: "owner@example.test",canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" };
const at = "2026-10-04T00:00:00.123Z";
const review = sealGooglePersonalNativeReview({ connectionId: "google-connection",accountEmail: scope.ownerActorId,authorizationGeneration: 3,
  status: "active",sourceScopeSha256: canonicalJsonSha256(["calendar","mail"]),permittedSources: ["mail","calendar"] });
const request = { contract: "asael-google-personal-action:1" as const,action: "sync" as const,review };
describe("native Google exact action evidence",() => {
  it("binds the whole source set, owner, generation and tenant-namespaced key",() => {
    const intent = buildGooglePersonalNativeIntent({ scope,request,idempotencyKey: "one" }),acceptance = buildGooglePersonalNativeAcceptance(intent,at);
    expect(intent.idempotencyKeySha256).toBe(createHash("sha256").update(`${scope.tenantId}\0one`).digest("hex"));
    expect(googlePersonalNativeAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(googlePersonalNativeRequestSchema.safeParse({ ...request,review: { ...review,permittedSources: ["calendar"] } }).success).toBe(false);
    const reviewBody = { connectionId: review.connectionId,accountEmail: review.accountEmail,authorizationGeneration: review.authorizationGeneration,
      status: review.status,sourceScopeSha256: review.sourceScopeSha256,permittedSources: review.permittedSources };
    expect(googlePersonalNativeAcceptanceSchema.safeParse({ ...acceptance,review: sealGooglePersonalNativeReview({ ...reviewBody,authorizationGeneration: 4 }) }).success).toBe(false);
    expect(googlePersonalNativeRequestSchema.safeParse({ ...request,unreviewedSource: "drive" }).success).toBe(false);
  });
  it("cannot turn unknown work into an incomplete or inconsistent settlement",() => {
    const acceptance = buildGooglePersonalNativeAcceptance(buildGooglePersonalNativeIntent({ scope,request,idempotencyKey: "one" }),at);
    const sources = review.permittedSources.map((source) => ({ source,status: "healthy" as const,backfillState: "complete" as const,
      imported: 1,removed: 0,lastAttemptedAt: at,lastSuccessfulAt: at }));
    const settlement = { action: "sync" as const,status: "healthy" as const,imported: 2,removed: 0,cursorAdvanced: true,sources,settledAt: at };
    expect(googlePersonalNativeActionSchema.parse({ acceptance,state: "settled",settlement }).settlement).toEqual(settlement);
    for (const bad of [{ ...settlement,sources: sources.slice(1) },{ ...settlement,imported: 3 },{ ...settlement,status: "partial" }])
      expect(googlePersonalNativeActionSchema.safeParse({ acceptance,state: "settled",settlement: bad }).success).toBe(false);
    expect(googlePersonalNativeActionSchema.safeParse({ acceptance,state: "settled",settlement: null }).success).toBe(false);
  });
});
