import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { ap2AuthorizationChallenge, buildAp2HumanPresentReview, type Ap2HumanPresentTerms } from "@/lib/payments/ap2-mandates";
import { publicTrustPolicy, verifyAp2MandateAuthorization, type Ap2PaymentSigningCredential, type Ap2WebAuthnTrustPolicy } from "@/lib/payments/ap2-webauthn";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  authorizationOptions, authorizationReceipt, createPaymentsGate, paymentChallenge, paymentFailure,
  paymentIdentity, paymentJsonSha256, paymentPolicy, paymentReview, paymentReviews, paymentReviewState, paymentAmount,
  paymentScopeKey, paymentSigner, paymentSigners, policyReason, reconcilePaymentConsent,
  registrationOptions, registrationReceipt, reviewConsentIdentity, revocationReceipt, validatePaymentClientData,
} from "./payments-workspace-state";

const owner = { tenantId: "synthetic-tenant", actorId: "synthetic-actor" };
const now = new Date("2026-10-04T10:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixturePolicy(): Ap2WebAuthnTrustPolicy {
  const body = { version: "p9.16-ap2-webauthn-trust-policy:1" as const, policyId: "policy:synthetic", rpId: "asael.example", expectedOrigin: "https://asael.example", allowedAaguids: ["11111111-1111-4111-8111-111111111111"], acceptedAttestationFormats: ["apple" as const], assurance: { hardwareBacked: true as const, privateKeyNonExportable: true as const, singleDeviceRequired: true as const, backupEligible: false as const, userVerificationRequired: true as const }, reviewerPrincipalSha256: "a".repeat(64), reviewedAt: "2026-01-01T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z" };
  return { ...body, policySha256: canonicalJsonSha256(body) };
}
function fixtureSigner(): Ap2PaymentSigningCredential {
  const body = { version: "p9.16-ap2-webauthn-credential:1" as const, credentialId: "synthetic_credential_1", tenantId: owner.tenantId, ownerActorId: owner.actorId, publicKey: Buffer.from("synthetic public key").toString("base64url"), counter: 7, transports: ["internal"], aaguid: fixturePolicy().allowedAaguids[0], attestationFormat: "apple" as const, deviceType: "singleDevice" as const, backedUp: false as const, signerProfile: "direct_hardware_webauthn_key:1" as const, trustPolicyId: fixturePolicy().policyId, trustPolicySha256: fixturePolicy().policySha256, state: "active" as const, lifecycleRevision: 1, createdAt: now.toISOString(), lastUsedAt: null, revokedAt: null };
  return { ...body, credentialSha256: canonicalJsonSha256(body) };
}
function fixtureReview() {
  const terms: Ap2HumanPresentTerms = { merchant: { id: "merchant:synthetic", name: "Synthetic merchant <script>untrusted</script>", website: "https://merchant.example" }, merchantOrderId: "order:synthetic", items: [{ id: "item:synthetic", title: "Synthetic item", quantity: 2, unitAmountMinor: 5000, totalAmountMinor: 10000 }], totals: { currency: "USD", subtotalAmountMinor: 10000, taxAmountMinor: 800, shippingAmountMinor: 500, discountAmountMinor: 0, totalAmountMinor: 11300 }, shipping: { recipientName: "Synthetic Person", addressLines: ["Synthetic street", "Synthetic suite"], city: "Synthetic City", region: "CA", postalCode: "00000", country: "US", serviceLevel: "Standard" }, paymentInstrument: { id: "instrument:synthetic", type: "card", description: "Synthetic card" }, paymentConstraints: { credentialProviderId: "provider:synthetic", merchantPaymentProcessorId: "processor:synthetic", allowedInstrumentTypes: ["card"], maximumAmountMinor: 11300, currency: "USD", immediateExecutionOnly: true }, expiresAt: "2099-01-01T00:00:00.000Z" };
  const merchantCheckoutJwt = "synthetic.signed.checkout";
  const verification = { version: "p9.16-merchant-checkout-verification:1" as const, adapterContractId: "adapter:synthetic", adapterRelease: "1", adapterArtifactSha256: "b".repeat(64), merchantKeyId: "key:synthetic", checkoutJwtSha256: sha(merchantCheckoutJwt), verifiedTermsSha256: canonicalJsonSha256(terms), verifiedAt: now.toISOString() };
  return buildAp2HumanPresentReview({ reviewId: "ap2_review:11111111-1111-4111-8111-111111111111", tenantId: owner.tenantId, ownerActorId: owner.actorId, shoppingAgentPrincipalId: "agent:synthetic", intentSha256: "c".repeat(64), merchantCheckoutJwt, merchantCheckoutVerification: { ...verification, verificationSha256: canonicalJsonSha256(verification) }, terms, now });
}
function clientData(type: "webauthn.get" | "webauthn.create", challenge: string, origin = fixturePolicy().expectedOrigin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString("base64url"); }
function assertion(): AuthenticationResponseJSON { return { id: fixtureSigner().credentialId, rawId: fixtureSigner().credentialId, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: clientData("webauthn.get", ap2AuthorizationChallenge(fixtureReview())), authenticatorData: Buffer.from("synthetic auth data").toString("base64url"), signature: Buffer.from("synthetic signature").toString("base64url") } }; }
function registration(): RegistrationResponseJSON { return { id: fixtureSigner().credentialId, rawId: fixtureSigner().credentialId, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: clientData("webauthn.create", "synthetic_challenge"), attestationObject: Buffer.from("synthetic attestation").toString("base64url"), transports: ["internal"] } }; }
function options() { const review = fixtureReview(); return { reviewId: review.reviewId, reviewSha256: review.reviewSha256, authorizationDigest: review.authorizationDigest, expiresAt: review.terms.expiresAt, options: { challenge: ap2AuthorizationChallenge(review), rpId: fixturePolicy().rpId, userVerification: "required", allowCredentials: [{ id: fixtureSigner().credentialId, type: "public-key" }] } }; }
function registrationStart() { return { trustPolicy: publicTrustPolicy(fixturePolicy()), challengeToken: { version: 1, algorithm: "aes-256-gcm", iv: "synthetic_iv", ciphertext: "synthetic_ciphertext", tag: "synthetic_tag" }, options: { challenge: "synthetic_challenge", rp: { id: fixturePolicy().rpId, name: "Synthetic" }, user: { id: createHash("sha256").update(`${owner.tenantId}\0${owner.actorId}`).digest("base64url"), name: "Synthetic", displayName: "Synthetic" }, attestation: "direct", pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" } } }; }
async function signedReceipt() {
  // The verifier is a synthetic unit fixture; this test does not assert physical signature verification.
  const review = fixtureReview(), credential = fixtureSigner();
  const authorization = await verifyAp2MandateAuthorization({ authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222", review, credential, policy: fixturePolicy(), response: assertion(), now, verify: vi.fn().mockResolvedValue({ verified: true, authenticationInfo: { credentialID: credential.credentialId, newCounter: 8, userVerified: true, credentialDeviceType: "singleDevice", credentialBackedUp: false, origin: fixturePolicy().expectedOrigin, rpID: fixturePolicy().rpId } }) });
  const { reviewSha256: _priorDigest, ...before } = review;
  const body = { ...before, state: "authorized" as const, lifecycleRevision: 2, authorizedAt: authorization.verifiedAt, updatedAt: authorization.verifiedAt };
  return { review: { ...body, reviewSha256: canonicalJsonSha256(body) }, authorization, created: true, checkoutOrPaymentExecuted: false };
}
function readyGate() { const gate = createPaymentsGate(); gate.mount(); gate.availability(true); return gate; }

describe("Payment scope and local lifecycle", () => {
  it("keeps same-owner session refresh outside the key and separates authority", () => {
    const scope = { ...owner, role: "operator", authenticated: true, authEnabled: true };
    expect(paymentScopeKey(scope)).not.toBe(paymentScopeKey({ ...scope, actorId: "other" }));
    expect(paymentScopeKey(scope)).not.toBe(paymentScopeKey({ ...scope, role: "viewer" }));
    expect(paymentScopeKey({ ...scope, ...{ status: "loading" } })).toBe(paymentScopeKey({ ...scope, ...{ status: "ready" } }));
    expect(paymentScopeKey(scope)).toBe(paymentScopeKey({ role: "operator", authEnabled: true, authenticated: true, actorId: owner.actorId, tenantId: owner.tenantId }));
  });
  it("fences reads independently and aborts a replaced source", () => {
    const gate = readyGate(), first = gate.read("reviews")!, signers = gate.read("signers")!, latest = gate.read("reviews")!;
    expect(first.signal.aborted).toBe(true); expect(first.current()).toBe(false); expect(signers.current()).toBe(true); expect(latest.current()).toBe(true);
  });
  it("takes one synchronous slot across registration, signing and revocation", () => {
    const gate = readyGate(), read = gate.read("reviews")!, token = gate.begin("Register")!;
    expect(read.current()).toBe(false); expect(read.signal.aborted).toBe(true);
    expect(gate.begin("Sign")).toBeUndefined(); expect(gate.begin("Revoke")).toBeUndefined(); expect(gate.read("reviews")).toBeUndefined();
    gate.finish(token); expect(gate.read("reviews")?.current()).toBe(true); expect(gate.begin("Sign")).toBeDefined();
  });
  it("cancels only its live authenticator phase, not a submitted server write", () => {
    const gate = readyGate(), token = gate.begin("Sign")!, cancel = vi.fn();
    expect(gate.cancel(token)).toBe(false); gate.ceremony(token, cancel); expect(gate.cancel(token)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce(); expect(token.signal.aborted).toBe(true); expect(gate.current(token)).toBe(false);
    const submitted = gate.begin("Store signed receipt")!; gate.ceremony(submitted, cancel); gate.ceremony(submitted);
    expect(gate.cancel(submitted)).toBe(false); expect(gate.current(submitted)).toBe(true);
  });
  it("disposes pending ceremonies and prevents late completion clearing a newer slot", () => {
    const gate = readyGate(), old = gate.begin("Sign")!, cancel = vi.fn(); gate.ceremony(old, cancel); gate.dispose();
    expect(cancel).toHaveBeenCalledOnce(); expect(gate.current(old)).toBe(false);
    gate.mount(); gate.availability(true); const current = gate.begin("Register")!;
    expect(gate.finish(old)).toBe(false); expect(gate.current(current)).toBe(true);
  });
  it("suspends continuation while session permission is unknown", () => {
    const gate = readyGate(), token = gate.begin("Sign")!; expect(gate.availability(false)).toBe(true);
    expect(token.signal.aborted).toBe(true); expect(gate.begin("Revoke")).toBeUndefined(); expect(gate.read("reviews")).toBeUndefined();
    gate.availability(true); expect(gate.current(token)).toBe(false); expect(gate.read("reviews")).toBeDefined();
  });
});

describe("Exact bounded payment reads", () => {
  it("keeps exact minor units when the old hundredths convention does not match the currency", () => {
    expect(paymentAmount(11300, "USD", "en-US")).toBe("$113.00");
    expect(paymentAmount(11300, "JPY", "en-US")).toBe("11,300 minor units · JPY");
    expect(paymentAmount(11300, "KWD", "en-US")).toBe("11,300 minor units · KWD");
  });
  it("matches server canonical hashes and its domain-bound authorization challenge", async () => {
    const review = fixtureReview(); expect(await paymentJsonSha256({ z: 1, a: [2, 3] })).toBe(canonicalJsonSha256({ a: [2, 3], z: 1 }));
    expect(await paymentChallenge(review)).toBe(ap2AuthorizationChallenge(review)); expect(await paymentReview(review, owner)).toEqual(review);
  });
  it("distinguishes empty, unavailable and unexpected transaction permission", async () => {
    const empty = { trustedSurface: "deterministic_non_agentic", transactionsPermitted: false, trustPolicy: null, reviews: [] };
    expect((await paymentReviews(empty, owner)).reviews).toEqual([]);
    await expect(paymentReviews({}, owner)).rejects.toThrow(); await expect(paymentReviews({ ...empty, transactionsPermitted: true }, owner)).rejects.toThrow();
    expect(paymentSigners({ credentials: [] })).toEqual([]); expect(() => paymentSigners({})).toThrow();
  });
  it("rejects wrong owners, duplicates, over-limit lists and unsafe merchant links", async () => {
    const review = fixtureReview(), envelope = { trustedSurface: "deterministic_non_agentic", transactionsPermitted: false, trustPolicy: null, reviews: [review] };
    await expect(paymentReview(review, { ...owner, actorId: "other" })).rejects.toThrow();
    await expect(paymentReviews({ ...envelope, reviews: [review, review] }, owner)).rejects.toThrow();
    await expect(paymentReviews({ ...envelope, reviews: Array(101).fill(review) }, owner)).rejects.toThrow();
    const unsafe = structuredClone(review); unsafe.terms.merchant.website = "javascript:alert(1)"; await expect(paymentReview(unsafe, owner)).rejects.toThrow();
    expect(() => paymentSigners({ credentials: [fixtureSigner(), fixtureSigner()] })).toThrow(); expect(() => paymentSigners({ credentials: Array(51).fill(fixtureSigner()) })).toThrow();
  });
  it("rejects changed terms, arithmetic, mandate content and authority even with a recomputed outer digest", async () => {
    for (const change of [
      (r: ReturnType<typeof fixtureReview>) => { r.terms.items[0].quantity = 3; },
      (r: ReturnType<typeof fixtureReview>) => { r.terms.paymentConstraints.maximumAmountMinor = 12000; },
      (r: ReturnType<typeof fixtureReview>) => { r.paymentMandateContent.payment_amount.amount = 12000; },
      (r: ReturnType<typeof fixtureReview>) => { r.merchantCheckoutVerification.verifiedTermsSha256 = "d".repeat(64); },
    ]) { const changed = fixtureReview(); change(changed); const { reviewSha256: _oldDigest, ...body } = changed; changed.reviewSha256 = canonicalJsonSha256(body); await expect(paymentReview(changed, owner)).rejects.toThrow(); }
  });
  it("invalidates consent for changed review, signer revision or trust policy without losing an unchanged refresh", () => {
    const review = fixtureReview(), policy = publicTrustPolicy(fixturePolicy()), signers = [paymentSigner(fixtureSigner())];
    const consent = { [review.reviewId]: reviewConsentIdentity(review, policy, signers) }, data = { reviews: [review], trustPolicy: policy, transactionsPermitted: false as const };
    expect(reconcilePaymentConsent(consent, structuredClone(data), structuredClone(signers))).toEqual(consent);
    expect(reconcilePaymentConsent(consent, { ...data, reviews: [{ ...review, reviewSha256: "d".repeat(64) }] }, signers)).toEqual({});
    expect(reconcilePaymentConsent(consent, data, [{ ...signers[0], lifecycleRevision: 2 }])).toEqual({});
    expect(reconcilePaymentConsent(consent, { ...data, trustPolicy: { ...policy, policySha256: "d".repeat(64) } }, signers)).toEqual({});
  });
  it("distinguishes absent and expired policy, pending expiry and authorized history", () => {
    expect(paymentPolicy(null)).toBeNull(); expect(() => paymentPolicy(undefined)).toThrow();
    expect(policyReason(undefined)).toContain("not been checked"); expect(policyReason(null)).toContain("No operator-reviewed");
    expect(policyReason(publicTrustPolicy(fixturePolicy()), Date.parse("2100-01-01"))).toContain("validity period");
    const review = fixtureReview(); expect(paymentReviewState(review, Date.parse("2100-01-01"))).toBe("expired"); expect(paymentReviewState({ ...review, state: "authorized" }, Date.parse("2100-01-01"))).toBe("authorized");
  });
});

describe("Challenge and signed receipt binding", () => {
  it("checks exact registration policy, owner binding and hardware requirements before ceremony", async () => {
    const policy = publicTrustPolicy(fixturePolicy()), start = registrationStart();
    expect((await registrationOptions(start, policy, owner)).options.challenge).toBe(start.options.challenge);
    await expect(registrationOptions(start, policy, { ...owner, actorId: "other" })).rejects.toThrow();
    await expect(registrationOptions({ ...start, options: { ...start.options, attestation: "none" } }, policy, owner)).rejects.toThrow();
    await expect(registrationOptions({ ...start, trustPolicy: { ...policy, policySha256: "e".repeat(64) } }, policy, owner)).rejects.toThrow();
  });
  it("rejects substituted review challenges, optional user verification and an unrelated signer", async () => {
    const policy = publicTrustPolicy(fixturePolicy()), signers = [paymentSigner(fixtureSigner())], review = fixtureReview();
    expect((await authorizationOptions(options(), review, policy, signers)).challenge).toBe(ap2AuthorizationChallenge(review));
    await expect(authorizationOptions({ ...options(), reviewSha256: "f".repeat(64) }, review, policy, signers)).rejects.toThrow();
    await expect(authorizationOptions({ ...options(), options: { ...options().options, challenge: "wrong" } }, review, policy, signers)).rejects.toThrow();
    await expect(authorizationOptions({ ...options(), options: { ...options().options, userVerification: "preferred" } }, review, policy, signers)).rejects.toThrow();
    await expect(authorizationOptions(options(), review, policy, [{ ...signers[0], credentialId: "other" }])).rejects.toThrow();
  });
  it("binds returned browser client data to challenge, ceremony and exact origin", () => {
    const policy = publicTrustPolicy(fixturePolicy()), response = assertion(), challenge = ap2AuthorizationChallenge(fixtureReview());
    expect(() => validatePaymentClientData(response, challenge, policy, "webauthn.get")).not.toThrow();
    expect(() => validatePaymentClientData(response, "different", policy, "webauthn.get")).toThrow();
    expect(() => validatePaymentClientData(response, challenge, policy, "webauthn.create")).toThrow();
    expect(() => validatePaymentClientData({ ...response, response: { ...response.response, clientDataJSON: clientData("webauthn.get", challenge, "https://other.example") } }, challenge, policy, "webauthn.get")).toThrow();
  });
  it("accepts only a matching owner, credential, policy and digest for registration or revocation", async () => {
    const signer = fixtureSigner(), policy = publicTrustPolicy(fixturePolicy());
    expect((await registrationReceipt({ credential: signer, created: true }, registration(), policy, owner)).credentialId).toBe(signer.credentialId);
    await expect(registrationReceipt({ credential: { ...signer, credentialId: "other" }, created: true }, registration(), policy, owner)).rejects.toThrow();
    await expect(registrationReceipt({ credential: signer, created: true }, registration(), policy, { ...owner, actorId: "other" })).rejects.toThrow();
    const { credentialSha256: _priorDigest, ...before } = signer;
    const revokedBody = { ...before, state: "revoked" as const, lifecycleRevision: 2, revokedAt: now.toISOString() };
    const revoked = { ...revokedBody, credentialSha256: canonicalJsonSha256(revokedBody) };
    expect((await revocationReceipt({ credential: revoked }, signer, owner)).state).toBe("revoked");
    await expect(revocationReceipt({ credential: signer }, signer, owner)).rejects.toThrow();
    await expect(revocationReceipt({ credential: revoked }, { ...signer, credentialId: "other" }, owner)).rejects.toThrow();
  });
  it("accepts a fully matched authorization receipt without implying payment execution", async () => {
    const result = await signedReceipt();
    const accepted = await authorizationReceipt(result, fixtureReview(), assertion(), publicTrustPolicy(fixturePolicy()), owner);
    expect(accepted.authorization.externalEffectAuthority).toBe("none"); expect(accepted.review.state).toBe("authorized");
    await expect(authorizationReceipt({ ...result, checkoutOrPaymentExecuted: true }, fixtureReview(), assertion(), publicTrustPolicy(fixturePolicy()), owner)).rejects.toThrow();
  });
  it("rejects wrong review, signer, signature or bound mandate content in a reported success", async () => {
    const result = await signedReceipt();
    for (const patch of [{ reviewSha256: "f".repeat(64) }, { credentialId: "different" }, { paymentMandateContentSha256: "f".repeat(64) }, { userVerified: false }, { externalEffectAuthority: "payment" }]) {
      const { authorizationSha256: _oldDigest, ...body } = { ...result.authorization, ...patch };
      await expect(authorizationReceipt({ ...result, authorization: { ...body, authorizationSha256: canonicalJsonSha256(body) } }, fixtureReview(), assertion(), publicTrustPolicy(fixturePolicy()), owner)).rejects.toThrow();
    }
  });
  it("distinguishes exact existing authorization replay from this attempt's new signature", async () => {
    const result = await signedReceipt(), second = assertion(); second.response.signature = "another_synthetic_signature";
    expect((await authorizationReceipt({ ...result, created: false }, fixtureReview(), second, publicTrustPolicy(fixturePolicy()), owner)).created).toBe(false);
    await expect(authorizationReceipt(result, fixtureReview(), second, publicTrustPolicy(fixturePolicy()), owner)).rejects.toThrow();
  });
  it("explains canceled and unsupported authenticator outcomes without reporting success", () => {
    expect(paymentFailure(new DOMException("Canceled", "NotAllowedError"))).toContain("canceled or timed out");
    expect(paymentFailure(new DOMException("Unsupported", "NotSupportedError"))).toContain("does not support");
    expect(paymentFailure(new Error("Synthetic server error"))).toBe("Synthetic server error");
    expect(paymentIdentity({ b: 2, a: 1 })).toBe(paymentIdentity({ a: 1, b: 2 }));
  });
});
