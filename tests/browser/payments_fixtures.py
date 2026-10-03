"""Bounded synthetic AP2 contracts. No real signer, signature or payment is created."""
from collections import defaultdict, deque
from datetime import datetime
import base64
import copy
import hashlib
import json
from urllib.parse import quote, urlsplit
from playwright.sync_api import Error as PlaywrightError
from fixtures import Fixtures, STAMP

REVIEWS = "/api/payments/ap2/reviews"
SIGNERS = "/api/payments/ap2/authenticators"
REGISTER = SIGNERS + "/registration"
REVIEW_A = "ap2_review:11111111-1111-4111-8111-111111111111"
REVIEW_B = "ap2_review:22222222-2222-4222-8222-222222222222"
REVIEW_C = "ap2_review:44444444-4444-4444-8444-444444444444"
REVIEW_D = "ap2_review:55555555-5555-4555-8555-555555555555"
LONG = "Synthetic exact identity " + "bound_" * 20
EXPIRY = "2099-01-01T00:00:00.000Z"
ORIGIN = "https://asael.example"


def b64(value): return base64.urlsafe_b64encode(value.encode() if isinstance(value, str) else value).decode().rstrip("=")
def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
def sha(value): return hashlib.sha256((value if isinstance(value, str) else canonical(value)).encode()).hexdigest()
def bound(value, key): return {**value, key: sha(value)}
def auth_path(identity=REVIEW_A): return REVIEWS + "/" + quote(identity, safe="") + "/authorization"


def policy():
    body = {"version": "p9.16-ap2-webauthn-trust-policy:1", "policyId": "policy:synthetic-exact-hardware", "rpId": "asael.example", "expectedOrigin": ORIGIN,
        "allowedAaguids": ["11111111-1111-4111-8111-111111111111"], "acceptedAttestationFormats": ["apple"],
        "assurance": {"hardwareBacked": True, "privateKeyNonExportable": True, "singleDeviceRequired": True, "backupEligible": False, "userVerificationRequired": True},
        "reviewerPrincipalSha256": "a" * 64, "reviewedAt": STAMP, "validFrom": "2026-01-01T00:00:00.000Z", "validUntil": EXPIRY}
    return bound(body, "policySha256")


def public_policy():
    p = policy()
    return {**{key: value for key, value in p.items() if key not in ("allowedAaguids", "reviewerPrincipalSha256")}, "allowedAaguidCount": len(p["allowedAaguids"])}


def signer(tenant, actor, name="a"):
    return bound({"version": "p9.16-ap2-webauthn-credential:1", "credentialId": b64("synthetic-payment-signer-" + name), "tenantId": tenant, "ownerActorId": actor,
        "publicKey": b64("synthetic-public-key-" + name), "counter": 7, "transports": ["internal"], "aaguid": policy()["allowedAaguids"][0], "attestationFormat": "apple",
        "deviceType": "singleDevice", "backedUp": False, "signerProfile": "direct_hardware_webauthn_key:1", "trustPolicyId": policy()["policyId"], "trustPolicySha256": policy()["policySha256"],
        "state": "active", "lifecycleRevision": 1, "createdAt": STAMP, "lastUsedAt": None, "revokedAt": None}, "credentialSha256")


def review(tenant, actor, identity=REVIEW_A, variant="original", expires_at=EXPIRY, state="pending"):
    merchant = {REVIEW_A: "Synthetic merchant A", REVIEW_B: "Synthetic merchant B", REVIEW_C: "Synthetic expired merchant", REVIEW_D: "Synthetic superseded merchant"}[identity]
    terms = {"merchant": {"id": "merchant:" + LONG, "name": merchant, "website": "https://merchant.example/exact-synthetic-terms"}, "merchantOrderId": "order:" + LONG,
        "items": [{"id": "item:" + LONG, "title": "Synthetic item <script>window.untrustedPaymentRan=true</script> " + LONG + " " + variant, "quantity": 2, "unitAmountMinor": 5000, "totalAmountMinor": 10000}],
        "totals": {"currency": "USD", "subtotalAmountMinor": 10000, "taxAmountMinor": 800, "shippingAmountMinor": 500, "discountAmountMinor": 0, "totalAmountMinor": 11300},
        "shipping": {"recipientName": "Synthetic Person", "addressLines": ["Synthetic street " + LONG, "Synthetic suite"], "city": "Synthetic City", "region": "CA", "postalCode": "00000", "country": "US", "serviceLevel": "Standard"},
        "paymentInstrument": {"id": "instrument:" + LONG, "type": "card", "description": "Synthetic card only"},
        "paymentConstraints": {"credentialProviderId": "provider:" + LONG, "merchantPaymentProcessorId": "processor:" + LONG, "allowedInstrumentTypes": ["card"], "maximumAmountMinor": 11300, "currency": "USD", "immediateExecutionOnly": True}, "expiresAt": expires_at}
    jwt = "synthetic.signed.checkout." + variant
    verified = bound({"version": "p9.16-merchant-checkout-verification:1", "adapterContractId": "adapter:synthetic", "adapterRelease": "1", "adapterArtifactSha256": "b" * 64, "merchantKeyId": "key:synthetic", "checkoutJwtSha256": sha(jwt), "verifiedTermsSha256": sha(terms), "verifiedAt": STAMP}, "verificationSha256")
    outcome = bound({"version": "p9.16-mandate-outcome-contract:1", "expectedTerminalState": "signed_mandates_verified", "externalEffectLimit": "no_checkout_or_payment_effect", "acceptanceConditions": ["displayed_terms_digest_matches", "merchant_checkout_signature_verified", "hardware_user_assertion_verified", "checkout_mandate_content_matches", "payment_mandate_content_matches", "mandate_not_expired_or_superseded"]}, "contractSha256")
    checkout_hash = b64(hashlib.sha256(jwt.encode()).digest())
    # Integer epoch seconds are fixed synthetic timestamps, with no clock-dependent receipt hashes.
    checkout = {"vct": "mandate.checkout.1", "checkout_jwt": jwt, "checkout_hash": checkout_hash, "iat": int(datetime.fromisoformat(STAMP.replace("Z", "+00:00")).timestamp()), "exp": int(datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp())}
    payment = {"vct": "mandate.payment.1", "transaction_id": checkout_hash, "payee": terms["merchant"], "payment_amount": {"amount": 11300, "currency": "USD"}, "payment_instrument": terms["paymentInstrument"], "execution_date": STAMP,
        "risk_data": {"asael_human_present_version": "p9.16-ap2-human-present:1", "owner_actor_sha256": sha(actor), "shopping_agent_sha256": sha("agent:synthetic-shopping"), "intent_sha256": "c" * 64, "exact_terms_sha256": sha(terms)}, "iat": checkout["iat"], "exp": checkout["exp"]}
    body = {"version": "p9.16-ap2-human-present:1", "reviewId": identity, "tenantId": tenant, "ownerActorId": actor, "shoppingAgentPrincipalId": "agent:synthetic-shopping", "intentSha256": "c" * 64,
        "merchantCheckoutJwt": jwt, "merchantCheckoutVerification": verified, "terms": terms, "exactTermsSha256": sha(terms), "checkoutMandateContent": checkout, "paymentMandateContent": payment,
        "outcomeContract": outcome, "trustedSurface": {"surface": "asael_web", "processingMode": "deterministic_non_agentic", "signerProfile": "direct_hardware_webauthn_key:1", "displaysEveryBoundField": True},
        "state": state, "lifecycleRevision": 1 if state == "pending" else 2, "authorizedAt": None, "supersededAt": STAMP if state == "superseded" else None, "createdAt": STAMP, "updatedAt": expires_at if state == "expired" else STAMP}
    digest_body = {key: body[key] for key in ("version", "reviewId", "tenantId", "ownerActorId", "shoppingAgentPrincipalId", "intentSha256", "exactTermsSha256", "checkoutMandateContent", "paymentMandateContent", "trustedSurface")}
    digest_body.update(merchantCheckoutVerificationSha256=verified["verificationSha256"], outcomeContractSha256=outcome["contractSha256"])
    return bound({**body, "authorizationDigest": sha(digest_body)}, "reviewSha256")


def challenge(value):
    body = {"domain": "asael:ap2:human-present:authorize:v1", "reviewId": value["reviewId"], "authorizationDigest": value["authorizationDigest"]}
    return b64(hashlib.sha256(hashlib.sha256(canonical(body).encode()).digest()).digest())


def assertion(value, credential):
    return {"id": credential["credentialId"], "rawId": credential["credentialId"], "type": "public-key", "authenticatorAttachment": "platform", "clientExtensionResults": {},
        "response": {"clientDataJSON": b64(canonical({"type": "webauthn.get", "challenge": challenge(value), "origin": ORIGIN, "crossOrigin": False})), "authenticatorData": b64("synthetic-authenticator-data"), "signature": b64("synthetic-signature")}}


def registration_response(credential, expected_challenge):
    return {"id": credential["credentialId"], "rawId": credential["credentialId"], "type": "public-key", "authenticatorAttachment": "platform", "clientExtensionResults": {},
        "response": {"clientDataJSON": b64(canonical({"type": "webauthn.create", "challenge": expected_challenge, "origin": ORIGIN, "crossOrigin": False})), "attestationObject": b64("synthetic-attestation"), "transports": ["internal"]}}


def signed(value, credential):
    response = assertion(value, credential)
    authorization = bound({"version": "p9.16-ap2-webauthn-authorization:1", "authorizationId": "ap2_authorization:33333333-3333-4333-8333-333333333333", "tenantId": value["tenantId"], "ownerActorId": value["ownerActorId"],
        "reviewId": value["reviewId"], "reviewSha256": value["reviewSha256"], "authorizationDigest": value["authorizationDigest"], "challenge": challenge(value), "credentialId": credential["credentialId"], "credentialSha256": credential["credentialSha256"],
        "trustPolicyId": policy()["policyId"], "trustPolicySha256": policy()["policySha256"], "previousCounter": credential["counter"], "newCounter": credential["counter"] + 1, "assertion": response, "assertionSha256": sha(response),
        "userPresent": True, "userVerified": True, "deviceType": "singleDevice", "backedUp": False, "checkoutMandateContentSha256": sha(value["checkoutMandateContent"]), "paymentMandateContentSha256": sha(value["paymentMandateContent"]), "externalEffectAuthority": "none", "verifiedAt": STAMP}, "authorizationSha256")
    updated = {key: item for key, item in value.items() if key != "reviewSha256"}
    updated.update(state="authorized", lifecycleRevision=value["lifecycleRevision"] + 1, authorizedAt=STAMP, updatedAt=STAMP)
    return {"review": bound(updated, "reviewSha256"), "authorization": authorization, "created": True, "checkoutOrPaymentExecuted": False}


class PaymentFixtures(Fixtures):
    def __init__(self, origin, session):
        super().__init__(origin)
        self.tenant, self.actor = session["context"]["tenantId"], session["context"]["actorId"]
        self.mode = "ready"
        self.signers = [signer(self.tenant, self.actor)]
        self.reviews = [review(self.tenant, self.actor), review(self.tenant, self.actor, REVIEW_B), review(self.tenant, self.actor, REVIEW_C, expires_at="2026-10-03T12:30:00.000Z", state="expired"), review(self.tenant, self.actor, REVIEW_D, state="superseded")]
        self.trust_policy = public_policy()
        self.plans, self.effects, self.held = defaultdict(deque), deque(), {}
        self.requests, self.releases, self.devices = [], [], []

    def body(self, path):
        if path == SIGNERS:
            fields = ("credentialId", "aaguid", "attestationFormat", "signerProfile", "trustPolicyId", "trustPolicySha256", "state", "lifecycleRevision", "createdAt", "lastUsedAt", "revokedAt")
            return {"credentials": [] if self.mode == "empty" else [{key: item[key] for key in fields} for item in self.signers]}
        return {"trustedSurface": "deterministic_non_agentic", "transactionsPermitted": False, "trustPolicy": None if self.mode == "empty" else self.trust_policy, "reviews": [] if self.mode == "empty" else self.reviews}

    def plan(self, path, **kwargs): self.plans[path].append(kwargs)
    def effect(self, method, path, expected, reply, **kwargs): self.effects.append({"method": method, "path": path, "expected": expected, "reply": reply, **kwargs})

    def options(self, value=None):
        value = value or self.reviews[0]
        return {"reviewId": value["reviewId"], "reviewSha256": value["reviewSha256"], "authorizationDigest": value["authorizationDigest"], "expiresAt": value["terms"]["expiresAt"],
            "options": {"challenge": challenge(value), "rpId": "asael.example", "timeout": 120000, "userVerification": "required", "allowCredentials": [{"id": row["credentialId"], "type": "public-key", "transports": ["internal"]} for row in self.signers if row["state"] == "active"]}}

    def registration(self):
        return {"trustPolicy": self.trust_policy, "challengeToken": {"version": 1, "algorithm": "aes-256-gcm", "iv": b64("synthetic-iv"), "ciphertext": b64("synthetic-sealed-challenge"), "tag": b64("synthetic-tag")},
            "options": {"challenge": b64("synthetic-registration-challenge"), "rp": {"id": "asael.example", "name": "Asael Trusted Surface"}, "user": {"id": b64(hashlib.sha256((self.tenant + "\0" + self.actor).encode()).digest()), "name": "synthetic-payment", "displayName": "Synthetic signer"},
                "timeout": 120000, "attestation": "direct", "pubKeyCredParams": [{"type": "public-key", "alg": -7}], "excludeCredentials": [{"id": row["credentialId"], "type": "public-key", "transports": ["internal"]} for row in self.signers if row["state"] == "active"],
                "authenticatorSelection": {"authenticatorAttachment": "platform", "residentKey": "required", "requireResidentKey": True, "userVerification": "required"}}}

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != self.origin: return super().route(route)
        if request.method != "GET" and parsed.path.startswith("/api/"):
            try: body = request.post_data_json
            except Exception: body = None
            plan = self.effects[0] if self.effects else None
            exact = plan and request.method == plan["method"] and parsed.path == plan["path"] and not parsed.query and body == plan["expected"] and len(self.writes) < 11
            exact = exact and not request.headers.get("idempotency-key") and not request.headers.get("x-idempotency-key")
            exact = exact and (request.post_data in (None, "") if body is None else request.headers.get("content-type", "").startswith("application/json"))
            if not exact:
                self.unexpected.append({"kind": "blocked_write", "method": request.method, "path": parsed.path, "body": body})
                return self.fulfill(route, {"error": "Unexpected synthetic payment write blocked"}, 503)
            self.effects.popleft()
            response = plan["reply"](body) if callable(plan["reply"]) else plan["reply"]
            self.writes.append({"method": request.method, "path": parsed.path, "body": body, "idempotencyHeader": "absent_as_existing_contract", "disposition": "wholly_intercepted_held" if plan.get("hold") else "wholly_intercepted_fulfilled"})
            if plan.get("hold"): self.held[plan["hold"]] = (route, copy.deepcopy(response), plan.get("status", 200)); return
            return self.fulfill(route, response, plan.get("status", 200))
        if parsed.path not in (REVIEWS, SIGNERS): return super().route(route)
        if parsed.query or len(self.requests) >= 200:
            self.unexpected.append({"kind": "read_shape_or_budget", "path": parsed.path}); return self.fulfill(route, {"error": "Read outside bounded plan"}, 400)
        self.requests.append({"path": parsed.path})
        plan = self.plans[parsed.path].popleft() if self.plans[parsed.path] else {}
        status = plan.get("status", 503 if self.mode == "error" else 200)
        body = plan.get("body", {"error": "Synthetic source unavailable. " + LONG} if self.mode == "error" else self.body(parsed.path))
        if plan.get("hold"): self.held[plan["hold"]] = (route, copy.deepcopy(body), status); return
        return self.fulfill(route, body, status)

    def mutation(self, route, path):
        self.unexpected.append({"kind": "non_api_write", "path": path, "method": route.request.method})
        return self.fulfill(route, {"error": "Mutation outside Payments fixture blocked"}, 503)

    def release(self, name):
        route, body, status = self.held.pop(name)
        try: self.fulfill(route, body, status); disposition = "fulfilled_or_client_canceled"
        except PlaywrightError: disposition = "client_canceled"
        self.releases.append({"name": name, "disposition": disposition})

    def abort_held(self):
        for name, (route, _, _) in list(self.held.items()):
            try: route.abort()
            except PlaywrightError: pass
            self.releases.append({"name": name, "disposition": "teardown_abort"})
        self.held.clear()
