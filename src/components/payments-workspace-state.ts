import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import type { Ap2HumanPresentReview } from "@/lib/payments/ap2-mandates";
import type { Ap2MandateAuthorization, Ap2PaymentSigningCredential } from "@/lib/payments/ap2-webauthn";

export type PaymentOwner = { tenantId: string; actorId: string };
export type PaymentReview = Ap2HumanPresentReview;
export type PaymentSigner = Pick<Ap2PaymentSigningCredential, "credentialId" | "aaguid" | "attestationFormat" | "signerProfile" | "trustPolicyId" | "trustPolicySha256" | "state" | "lifecycleRevision" | "createdAt" | "lastUsedAt" | "revokedAt">;
export type PaymentPolicy = { version: "p9.16-ap2-webauthn-trust-policy:1"; policyId: string; policySha256: string; rpId: string; expectedOrigin: string; acceptedAttestationFormats: string[]; allowedAaguidCount: number; assurance: { hardwareBacked: true; privateKeyNonExportable: true; singleDeviceRequired: true; backupEligible: false; userVerificationRequired: true }; reviewedAt: string; validFrom: string; validUntil: string };
export type PaymentReviews = { reviews: PaymentReview[]; trustPolicy: PaymentPolicy | null; transactionsPermitted: false };
export type PaymentRead<T> = { data?: T; loading: boolean; error?: string };
const profile = "direct_hardware_webauthn_key:1";
const formats = ["fido-u2f", "packed", "android-key", "tpm", "apple"];
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 240): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const base64 = (v: unknown, max = 200_000): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0;
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
const member = (v: unknown, choices: readonly string[]) => typeof v === "string" && choices.includes(v);
const list = (v: unknown, check: (item: unknown) => boolean, max: number): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(check);
function requireValue(v: unknown, message = "The payment response did not match the exact owner, reviewed terms or expected receipt. Refresh before trying again."): asserts v { if (!v) throw new Error(message); }
function unique<T>(items: T[], key: (item: T) => string) { requireValue(new Set(items.map(key)).size === items.length); return items; }
function https(v: unknown) { if (!text(v, 4096)) return false; try { return new URL(v).protocol === "https:"; } catch { return false; } }
function canonical(v: unknown): unknown { return Array.isArray(v) ? v.map(canonical) : record(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v; }
export const paymentIdentity = (v: unknown) => JSON.stringify(canonical(v));
export function paymentScopeKey(v: { tenantId?: string; actorId?: string; role: string; authEnabled?: boolean; authenticated?: boolean }) { return paymentIdentity([v.tenantId, v.actorId, v.role, v.authEnabled, v.authenticated]); }
async function digest(value: string | Uint8Array) { return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value))); }
function hex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function url64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
export async function paymentJsonSha256(value: unknown) { return hex(await digest(paymentIdentity(value))); }
async function checkDigest(value: Record<string, unknown>, key: string) { const { [key]: actual, ...body } = value; requireValue(hash(actual) && actual === await paymentJsonSha256(body)); }
export async function paymentChallenge(review: PaymentReview) { return url64(await digest(await digest(paymentIdentity({ domain: "asael:ap2:human-present:authorize:v1", reviewId: review.reviewId, authorizationDigest: review.authorizationDigest })))); }

export function paymentPolicy(value: unknown): PaymentPolicy | null {
  if (value === null) return null;
  requireValue(record(value) && value.version === "p9.16-ap2-webauthn-trust-policy:1" && text(value.policyId) && hash(value.policySha256) && text(value.rpId, 253) && https(value.expectedOrigin) && positive(value.allowedAaguidCount) && value.allowedAaguidCount <= 200 && list(value.acceptedAttestationFormats, (item) => member(item, formats), 5) && value.acceptedAttestationFormats.length > 0 && [value.reviewedAt, value.validFrom, value.validUntil].every(date));
  const assurance = value.assurance;
  requireValue(record(assurance) && assurance.hardwareBacked === true && assurance.privateKeyNonExportable === true && assurance.singleDeviceRequired === true && assurance.backupEligible === false && assurance.userVerificationRequired === true && Date.parse(value.validFrom as string) < Date.parse(value.validUntil as string));
  return value as unknown as PaymentPolicy;
}
export function policyReason(policy: PaymentPolicy | null | undefined, now = Date.now()) {
  if (policy === undefined) return "The signing trust policy has not been checked.";
  if (policy === null) return "No operator-reviewed hardware signer trust policy is configured.";
  if (Date.parse(policy.validFrom) > now || Date.parse(policy.validUntil) <= now) return "The signing trust policy is outside its validity period. Refresh to check for a current policy.";
}
export function paymentSigner(value: unknown): PaymentSigner {
  requireValue(record(value) && base64(value.credentialId, 16_384) && typeof value.aaguid === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.aaguid) && member(value.attestationFormat, formats) && value.signerProfile === profile && text(value.trustPolicyId) && hash(value.trustPolicySha256) && member(value.state, ["active", "revoked"]) && positive(value.lifecycleRevision) && date(value.createdAt) && nullableDate(value.lastUsedAt) && (value.state === "revoked" ? date(value.revokedAt) : value.revokedAt === null));
  const keys = ["credentialId", "aaguid", "attestationFormat", "signerProfile", "trustPolicyId", "trustPolicySha256", "state", "lifecycleRevision", "createdAt", "lastUsedAt", "revokedAt"];
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as PaymentSigner;
}
export function paymentSigners(value: unknown) {
  requireValue(record(value) && Array.isArray(value.credentials) && value.credentials.length <= 50);
  return unique(value.credentials.map(paymentSigner), (item) => item.credentialId);
}
export async function paymentReview(value: unknown, owner: PaymentOwner): Promise<PaymentReview> {
  requireValue(record(value) && value.version === "p9.16-ap2-human-present:1" && typeof value.reviewId === "string" && /^ap2_review:[0-9a-f-]{36}$/.test(value.reviewId) && value.tenantId === owner.tenantId && value.ownerActorId === owner.actorId && text(value.shoppingAgentPrincipalId) && [value.intentSha256, value.exactTermsSha256, value.authorizationDigest, value.reviewSha256].every(hash) && member(value.state, ["pending", "authorized", "expired", "superseded"]) && positive(value.lifecycleRevision) && date(value.createdAt) && date(value.updatedAt) && nullableDate(value.authorizedAt) && nullableDate(value.supersededAt));
  requireValue(value.state !== "authorized" || date(value.authorizedAt));
  requireValue(value.state !== "superseded" || date(value.supersededAt));
  const t = value.terms;
  requireValue(record(t) && record(t.merchant) && text(t.merchant.id) && text(t.merchant.name) && https(t.merchant.website) && text(t.merchantOrderId) && date(t.expiresAt));
  requireValue(Array.isArray(t.items) && t.items.length > 0 && t.items.length <= 500 && t.items.every((item) => record(item) && text(item.id) && text(item.title, 500) && positive(item.quantity) && item.quantity <= 10_000 && integer(item.unitAmountMinor) && integer(item.totalAmountMinor) && item.quantity * item.unitAmountMinor === item.totalAmountMinor));
  const totals = t.totals, shipping = t.shipping, instrument = t.paymentInstrument, constraint = t.paymentConstraints;
  requireValue(record(totals) && typeof totals.currency === "string" && /^[A-Z]{3}$/.test(totals.currency) && ["subtotalAmountMinor", "taxAmountMinor", "shippingAmountMinor", "discountAmountMinor", "totalAmountMinor"].every((key) => integer(totals[key])));
  requireValue(record(shipping) && ["recipientName", "city", "region", "postalCode", "country", "serviceLevel"].every((key) => text(shipping[key])) && list(shipping.addressLines, (line) => text(line), 4) && shipping.addressLines.length > 0);
  requireValue(record(instrument) && ["id", "type", "description"].every((key) => text(instrument[key])) && record(constraint) && text(constraint.credentialProviderId) && text(constraint.merchantPaymentProcessorId) && list(constraint.allowedInstrumentTypes, (item) => text(item, 80), 20) && constraint.allowedInstrumentTypes.includes(instrument.type) && constraint.immediateExecutionOnly === true && constraint.currency === totals.currency && constraint.maximumAmountMinor === totals.totalAmountMinor);
  const review = value as unknown as PaymentReview;
  const amounts = review.terms.totals;
  requireValue(review.terms.items.reduce((sum, item) => sum + item.totalAmountMinor, 0) === amounts.subtotalAmountMinor && amounts.subtotalAmountMinor + amounts.taxAmountMinor + amounts.shippingAmountMinor - amounts.discountAmountMinor === amounts.totalAmountMinor);
  requireValue(record(value.trustedSurface) && value.trustedSurface.surface === "asael_web" && value.trustedSurface.processingMode === "deterministic_non_agentic" && value.trustedSurface.signerProfile === profile && value.trustedSurface.displaysEveryBoundField === true);
  const verification = value.merchantCheckoutVerification, outcome = value.outcomeContract, checkout = value.checkoutMandateContent, payment = value.paymentMandateContent;
  requireValue(text(value.merchantCheckoutJwt, 200_000) && record(verification) && verification.version === "p9.16-merchant-checkout-verification:1" && ["adapterContractId", "adapterRelease", "merchantKeyId"].every((key) => text(verification[key])) && ["adapterArtifactSha256", "checkoutJwtSha256", "verifiedTermsSha256", "verificationSha256"].every((key) => hash(verification[key])) && date(verification.verifiedAt));
  requireValue(record(outcome) && outcome.version === "p9.16-mandate-outcome-contract:1" && outcome.expectedTerminalState === "signed_mandates_verified" && outcome.externalEffectLimit === "no_checkout_or_payment_effect" && paymentIdentity(outcome.acceptanceConditions) === paymentIdentity(["displayed_terms_digest_matches", "merchant_checkout_signature_verified", "hardware_user_assertion_verified", "checkout_mandate_content_matches", "payment_mandate_content_matches", "mandate_not_expired_or_superseded"]));
  requireValue(record(checkout) && checkout.vct === "mandate.checkout.1" && checkout.checkout_jwt === value.merchantCheckoutJwt && positive(checkout.iat) && positive(checkout.exp) && record(payment) && payment.vct === "mandate.payment.1" && record(payment.risk_data) && date(payment.execution_date));
  const jwtDigest = await digest(value.merchantCheckoutJwt);
  requireValue(checkout.checkout_hash === url64(jwtDigest) && payment.transaction_id === checkout.checkout_hash && verification.checkoutJwtSha256 === hex(jwtDigest) && verification.verifiedTermsSha256 === value.exactTermsSha256 && await paymentJsonSha256(t) === value.exactTermsSha256);
  requireValue(paymentIdentity(payment.payee) === paymentIdentity(t.merchant) && paymentIdentity(payment.payment_instrument) === paymentIdentity(instrument) && paymentIdentity(payment.payment_amount) === paymentIdentity({ amount: amounts.totalAmountMinor, currency: amounts.currency }) && payment.iat === checkout.iat && payment.exp === checkout.exp && checkout.exp === Math.floor(Date.parse(t.expiresAt) / 1000));
  requireValue(payment.risk_data.asael_human_present_version === review.version && payment.risk_data.intent_sha256 === review.intentSha256 && payment.risk_data.exact_terms_sha256 === review.exactTermsSha256 && payment.risk_data.owner_actor_sha256 === hex(await digest(owner.actorId)) && payment.risk_data.shopping_agent_sha256 === hex(await digest(review.shoppingAgentPrincipalId)));
  await checkDigest(verification, "verificationSha256"); await checkDigest(outcome, "contractSha256"); await checkDigest(value, "reviewSha256");
  requireValue(value.authorizationDigest === await paymentJsonSha256({ version: review.version, reviewId: review.reviewId, tenantId: review.tenantId, ownerActorId: review.ownerActorId, shoppingAgentPrincipalId: review.shoppingAgentPrincipalId, intentSha256: review.intentSha256, exactTermsSha256: review.exactTermsSha256, merchantCheckoutVerificationSha256: review.merchantCheckoutVerification.verificationSha256, checkoutMandateContent: review.checkoutMandateContent, paymentMandateContent: review.paymentMandateContent, outcomeContractSha256: review.outcomeContract.contractSha256, trustedSurface: review.trustedSurface }));
  return review;
}
export async function paymentReviews(value: unknown, owner: PaymentOwner): Promise<PaymentReviews> {
  requireValue(record(value) && value.trustedSurface === "deterministic_non_agentic" && value.transactionsPermitted === false && Array.isArray(value.reviews) && value.reviews.length <= 100);
  return { reviews: unique(await Promise.all(value.reviews.map((item) => paymentReview(item, owner))), (item) => item.reviewId), trustPolicy: paymentPolicy(value.trustPolicy), transactionsPermitted: false };
}
export function reviewConsentIdentity(review: PaymentReview, policy: PaymentPolicy | null, signers: PaymentSigner[]) { return paymentIdentity([review, policy, signers]); }
export function reconcilePaymentConsent(consent: Record<string, string>, reviews?: PaymentReviews, signers?: PaymentSigner[]) { return reviews && signers ? Object.fromEntries(reviews.reviews.filter((review) => consent[review.reviewId] === reviewConsentIdentity(review, reviews.trustPolicy, signers)).map((review) => [review.reviewId, consent[review.reviewId]])) : {}; }
export function paymentReviewState(review: PaymentReview, now = Date.now()) { return review.state === "pending" && Date.parse(review.terms.expiresAt) <= now ? "expired" : review.state; }
export function paymentAmount(amountMinor: number, currency: string, locale?: string) {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  // The existing UI divides by 100. Do not imply that conversion for a currency
  // with a different minor-unit exponent; the exact wire integer stays visible.
  return formatter.resolvedOptions().maximumFractionDigits === 2 ? formatter.format(amountMinor / 100) : `${amountMinor.toLocaleString(locale)} minor units · ${currency}`;
}

export async function registrationOptions(value: unknown, policy: PaymentPolicy, owner: PaymentOwner) {
  requireValue(record(value) && paymentIdentity(paymentPolicy(value.trustPolicy)) === paymentIdentity(policy) && !policyReason(policy) && record(value.options) && record(value.challengeToken));
  const o = value.options, token = value.challengeToken;
  requireValue(token.version === 1 && token.algorithm === "aes-256-gcm" && base64(token.iv) && base64(token.ciphertext) && base64(token.tag));
  requireValue(base64(o.challenge) && record(o.rp) && o.rp.id === policy.rpId && text(o.rp.name) && record(o.user) && text(o.user.name) && text(o.user.displayName) && o.user.id === url64(await digest(`${owner.tenantId}\0${owner.actorId}`)) && o.attestation === "direct" && record(o.authenticatorSelection) && o.authenticatorSelection.authenticatorAttachment === "platform" && o.authenticatorSelection.residentKey === "required" && o.authenticatorSelection.requireResidentKey === true && o.authenticatorSelection.userVerification === "required" && Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.length === 1 && record(o.pubKeyCredParams[0]) && o.pubKeyCredParams[0].alg === -7 && o.pubKeyCredParams[0].type === "public-key");
  return { options: o as unknown as PublicKeyCredentialCreationOptionsJSON, challengeToken: token };
}
export async function authorizationOptions(value: unknown, review: PaymentReview, policy: PaymentPolicy, signers: PaymentSigner[]) {
  requireValue(record(value) && value.reviewId === review.reviewId && value.reviewSha256 === review.reviewSha256 && value.authorizationDigest === review.authorizationDigest && value.expiresAt === review.terms.expiresAt && paymentReviewState(review) === "pending" && !policyReason(policy) && record(value.options));
  const o = value.options;
  requireValue(o.challenge === await paymentChallenge(review) && o.rpId === policy.rpId && o.userVerification === "required" && Array.isArray(o.allowCredentials) && o.allowCredentials.length > 0 && o.allowCredentials.length <= 50);
  const allowed = signers.filter((signer) => signer.state === "active" && signer.trustPolicySha256 === policy.policySha256 && signer.trustPolicyId === policy.policyId).map((signer) => signer.credentialId);
  requireValue(o.allowCredentials.every((item) => record(item) && item.type === "public-key" && typeof item.id === "string" && allowed.includes(item.id)));
  return o as unknown as PublicKeyCredentialRequestOptionsJSON;
}
export function validatePaymentClientData(response: RegistrationResponseJSON | AuthenticationResponseJSON, challenge: string, policy: PaymentPolicy, kind: "webauthn.create" | "webauthn.get") {
  requireValue(record(response) && record(response.response) && response.type === "public-key" && base64(response.id, 16_384) && response.rawId === response.id && base64(response.response.clientDataJSON) && record(response.clientExtensionResults));
  const payload: Record<string, unknown> = response.response;
  requireValue(kind === "webauthn.create" ? base64(payload.attestationObject) : base64(payload.authenticatorData) && base64(payload.signature));
  let data: unknown;
  try { const binary = atob(response.response.clientDataJSON.replaceAll("-", "+").replaceAll("_", "/")); data = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))); } catch { throw new Error("The authenticator returned unreadable challenge data. No completion request was sent."); }
  requireValue(record(data) && data.type === kind && data.challenge === challenge && data.origin === policy.expectedOrigin && data.crossOrigin !== true);
}
async function fullSigner(value: unknown, owner: PaymentOwner) {
  const signer = paymentSigner(value);
  requireValue(record(value) && value.version === "p9.16-ap2-webauthn-credential:1" && value.tenantId === owner.tenantId && value.ownerActorId === owner.actorId && base64(value.publicKey) && integer(value.counter) && list(value.transports, (item) => text(item, 80), 20) && value.deviceType === "singleDevice" && value.backedUp === false);
  await checkDigest(value, "credentialSha256"); return signer;
}
export async function registrationReceipt(value: unknown, response: RegistrationResponseJSON, policy: PaymentPolicy, owner: PaymentOwner) {
  requireValue(record(value) && typeof value.created === "boolean");
  const signer = await fullSigner(value.credential, owner);
  requireValue(signer.credentialId === response.id && signer.state === "active" && signer.trustPolicyId === policy.policyId && signer.trustPolicySha256 === policy.policySha256 && policy.acceptedAttestationFormats.includes(signer.attestationFormat)); return signer;
}
export async function revocationReceipt(value: unknown, previous: PaymentSigner, owner: PaymentOwner) {
  requireValue(record(value)); const signer = await fullSigner(value.credential, owner);
  requireValue(signer.credentialId === previous.credentialId && signer.state === "revoked" && signer.lifecycleRevision > previous.lifecycleRevision && ["aaguid", "attestationFormat", "signerProfile", "trustPolicyId", "trustPolicySha256", "createdAt"].every((key) => signer[key as keyof PaymentSigner] === previous[key as keyof PaymentSigner])); return signer;
}
export async function authorizationReceipt(value: unknown, before: PaymentReview, assertion: AuthenticationResponseJSON, policy: PaymentPolicy, owner: PaymentOwner) {
  requireValue(record(value) && typeof value.created === "boolean" && value.checkoutOrPaymentExecuted === false);
  const review = await paymentReview(value.review, owner), a = value.authorization;
  requireValue(review.reviewId === before.reviewId && review.state === "authorized" && review.lifecycleRevision === before.lifecycleRevision + 1 && paymentIdentity(review) === paymentIdentity({ ...before, state: "authorized", lifecycleRevision: before.lifecycleRevision + 1, authorizedAt: review.authorizedAt, updatedAt: review.updatedAt, reviewSha256: review.reviewSha256 }));
  requireValue(record(a) && a.version === "p9.16-ap2-webauthn-authorization:1" && typeof a.authorizationId === "string" && /^ap2_authorization:[0-9a-f-]{36}$/.test(a.authorizationId) && a.tenantId === owner.tenantId && a.ownerActorId === owner.actorId && a.reviewId === before.reviewId && a.reviewSha256 === before.reviewSha256 && a.authorizationDigest === before.authorizationDigest && a.challenge === await paymentChallenge(before) && a.trustPolicyId === policy.policyId && a.trustPolicySha256 === policy.policySha256 && hash(a.credentialSha256) && a.userPresent === true && a.userVerified === true && a.deviceType === "singleDevice" && a.backedUp === false && a.externalEffectAuthority === "none" && date(a.verifiedAt) && a.verifiedAt === review.authorizedAt && integer(a.previousCounter) && integer(a.newCounter) && (a.newCounter > a.previousCounter || (a.newCounter === 0 && a.previousCounter === 0)));
  requireValue(review.updatedAt === a.verifiedAt && Date.parse(a.verifiedAt) >= Date.parse(before.createdAt) && Date.parse(a.verifiedAt) < Date.parse(before.terms.expiresAt) && Date.parse(a.verifiedAt) >= Date.parse(policy.validFrom) && Date.parse(a.verifiedAt) < Date.parse(policy.validUntil));
  // A replay may return the already stored assertion, not this attempt's signature.
  requireValue(record(a.assertion) && a.assertion.id === a.credentialId && a.assertion.rawId === a.credentialId);
  if (value.created) requireValue(a.credentialId === assertion.id && paymentIdentity(a.assertion) === paymentIdentity(assertion));
  requireValue(a.assertionSha256 === await paymentJsonSha256(a.assertion) && a.checkoutMandateContentSha256 === await paymentJsonSha256(before.checkoutMandateContent) && a.paymentMandateContentSha256 === await paymentJsonSha256(before.paymentMandateContent));
  validatePaymentClientData(a.assertion as unknown as AuthenticationResponseJSON, a.challenge as string, policy, "webauthn.get");
  await checkDigest(a, "authorizationSha256");
  return { review, authorization: a as unknown as Ap2MandateAuthorization, created: value.created };
}
export function paymentFailure(error: unknown) {
  if (error instanceof Error && ["NotAllowedError", "AbortError"].includes(error.name)) return "The authenticator challenge was canceled or timed out. No completion was confirmed. You can try again after reviewing the current terms.";
  if (error instanceof Error && error.name === "NotSupportedError") return "This authenticator does not support the required hardware-backed, single-device payment signing profile.";
  return error instanceof Error ? error.message : "The payment request was not confirmed. Refresh to check its current state.";
}
export async function paymentJson(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, cache: "no-store" }); const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(record(value) && text(value.message, 4000) ? value.message : record(value) && text(value.error, 4000) ? value.error : `The payment service could not complete the request (${response.status}).`);
  requireValue(record(value)); return value;
}
export type PaymentAction = Readonly<{ label: string; signal: AbortSignal }>;
/** In-memory exclusivity only; the unchanged server owns registration/review replay. */
export function createPaymentsGate() {
  let mounted = false, available = false, active: { token: PaymentAction; controller: AbortController; cancel?: () => void } | undefined;
  const reads = new Map<string, AbortController>();
  const invalidate = () => { reads.forEach((controller) => controller.abort()); reads.clear(); };
  const stop = () => { invalidate(); const current = active; active = undefined; current?.controller.abort(); current?.cancel?.(); return Boolean(current); };
  return {
    mount() { mounted = true; }, dispose() { mounted = false; available = false; stop(); },
    availability(value: boolean) { available = value; return !value && stop(); },
    read(source: string) { if (!mounted || !available || active) return; reads.get(source)?.abort(); const controller = new AbortController(); reads.set(source, controller); return { signal: controller.signal, current: () => mounted && available && !controller.signal.aborted && reads.get(source) === controller }; },
    begin(label: string) { if (!mounted || !available || active) return; invalidate(); const controller = new AbortController(); const token = Object.freeze({ label, signal: controller.signal }); active = { token, controller }; return token; },
    current(token: PaymentAction) { return mounted && available && active?.token === token && !token.signal.aborted; },
    ceremony(token: PaymentAction, cancel?: () => void) { if (active?.token === token) active.cancel = cancel; },
    finish(token: PaymentAction) { if (active?.token !== token) return false; active = undefined; return true; },
    cancel(token: PaymentAction) { if (active?.token !== token || !active.cancel) return false; return stop(); },
  };
}
