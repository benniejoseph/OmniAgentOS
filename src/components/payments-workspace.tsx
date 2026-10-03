"use client";

import { startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import {
  authorizationOptions, authorizationReceipt, createPaymentsGate, paymentFailure, paymentIdentity,
  paymentJson, paymentAmount, paymentReviews, paymentReviewState, paymentScopeKey, paymentSigners, policyReason,
  reconcilePaymentConsent, registrationOptions, registrationReceipt, reviewConsentIdentity,
  revocationReceipt, validatePaymentClientData,
  type PaymentAction, type PaymentPolicy, type PaymentRead, type PaymentReview, type PaymentReviews, type PaymentSigner,
} from "./payments-workspace-state";
import styles from "./payments-workspace.module.css";

const reviewsPath = "/api/payments/ap2/reviews";
const signersPath = "/api/payments/ap2/authenticators";
const registrationPath = `${signersPath}/registration`;
type Pending = { token: PaymentAction; phase: "options" | "authenticator" | "submit"; message: string };
type Confirmed = { title: string; message: string; details: Record<string, unknown> };

export function PaymentsWorkspace() {
  const { session, role, status, refresh } = useWorkspaceSession();
  const reason = permissionMessage(session, status, "read");
  if (!session || (session.authEnabled && !session.authenticated) || !session.context?.tenantId || !session.context?.actorId) {
    return <div className={styles.workspace}><header className={styles.header}><h1>Payments</h1><p>Review purchase mandates and manage hardware signers.</p></header><p role="status">{reason || "The payment owner could not be verified."}</p><button type="button" disabled={status === "loading"} onClick={() => void refresh()}>Check workspace access</button></div>;
  }
  return <ScopedPaymentsWorkspace key={paymentScopeKey({ tenantId: session.context.tenantId, actorId: session.context.actorId, role, authEnabled: session.authEnabled, authenticated: session.authenticated })} tenantId={session.context.tenantId} actorId={session.context.actorId} />;
}

function ScopedPaymentsWorkspace({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const { session, status } = useWorkspaceSession();
  const readReason = permissionMessage(session, status, "read"), writeReason = permissionMessage(session, status, "run.agent");
  const [gate] = useState(createPaymentsGate);
  const [reviews, setReviews] = useState<PaymentRead<PaymentReviews>>({ loading: true });
  const [signers, setSigners] = useState<PaymentRead<PaymentSigner[]>>({ loading: true });
  const snapshots = useRef<{ reviews?: PaymentReviews; signers?: PaymentSigner[] }>({});
  const [consent, setConsent] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending>();
  const [receipt, setReceipt] = useState<Confirmed>();
  const [error, setError] = useState<string>();
  const [revocation, setRevocation] = useState<PaymentSigner>();
  const [supported, setSupported] = useState<boolean>();
  const [now, setNow] = useState(0);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const revokeCancel = useRef<HTMLButtonElement | null>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const receiptElement = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => { gate.mount(); return () => gate.dispose(); }, [gate]);
  const loadReviews = useCallback(async () => {
    const request = gate.read("reviews"); if (!request) return;
    setReviews((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const raw = await paymentJson(reviewsPath, { signal: request.signal }); if (!request.current()) return;
      const data = await paymentReviews(raw, { tenantId, actorId }); if (!request.current()) return;
      snapshots.current.reviews = data;
      setNow(Date.now());
      setConsent((current) => reconcilePaymentConsent(current, data, snapshots.current.signers));
      setReviews({ data, loading: false });
    } catch (caught) { if (request.current()) setReviews((current) => ({ ...current, loading: false, error: paymentFailure(caught) })); }
  }, [actorId, gate, tenantId]);
  const loadSigners = useCallback(async () => {
    const request = gate.read("signers"); if (!request) return;
    setSigners((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const raw = await paymentJson(signersPath, { signal: request.signal }); if (!request.current()) return;
      const data = paymentSigners(raw);
      snapshots.current.signers = data;
      setConsent((current) => reconcilePaymentConsent(current, snapshots.current.reviews, data));
      setSigners({ data, loading: false });
    } catch (caught) { if (request.current()) setSigners((current) => ({ ...current, loading: false, error: paymentFailure(caught) })); }
  }, [gate]);
  useLayoutEffect(() => {
    const interrupted = gate.availability(!readReason);
    const timer = window.setTimeout(() => {
      if (interrupted) { setPending(undefined); setError("Workspace access changed while a request was pending. Any request already sent may still finish. Refresh to check its result before trying again."); }
      if (!readReason) { void loadReviews(); void loadSigners(); }
      else {
        setReviews((current) => ({ ...current, loading: false }));
        setSigners((current) => ({ ...current, loading: false }));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [gate, loadReviews, loadSigners, readReason]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSupported(window.isSecureContext && typeof window.PublicKeyCredential !== "undefined" && typeof navigator.credentials?.create === "function" && typeof navigator.credentials?.get === "function"); setNow(Date.now()); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const currentTime = Date.now();
    const policy = reviews.data?.trustPolicy;
    const deadlines = [...(reviews.data?.reviews.filter((review) => review.state === "pending").map((review) => Date.parse(review.terms.expiresAt)) || []), ...(policy ? [Date.parse(policy.validFrom), Date.parse(policy.validUntil)] : [])].filter((deadline) => deadline > currentTime);
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.min(...deadlines) - currentTime + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [now, reviews.data]);
  useEffect(() => { if (revocation) revokeCancel.current?.focus(); }, [revocation]);
  useEffect(() => { if (receipt) receiptElement.current?.focus(); }, [receipt]);

  const policy = reviews.data?.trustPolicy;
  const reviewsCurrent = reviews.data !== undefined && !reviews.loading && !reviews.error && !readReason;
  const signersCurrent = signers.data !== undefined && !signers.loading && !signers.error && !readReason;
  const hardwareReason = supported === undefined ? "Checking browser authenticator support." : !supported ? "This browser cannot start WebAuthn here. Use a supported browser in a secure context with an approved hardware-backed authenticator." : undefined;
  const livePolicyReason = now ? policyReason(policy, now) : "Checking the signing policy validity period.";
  const registrationReason = writeReason || hardwareReason || (!reviewsCurrent ? "Refresh purchase reviews to verify the signing policy." : livePolicyReason) || (!signersCurrent ? "Refresh registered signers before enrolling another key." : undefined);
  const activeSigners = signers.data?.filter((signer) => signer.state === "active") || [];
  const eligibleSigners = activeSigners.filter((signer) => signer.trustPolicyId === policy?.policyId && signer.trustPolicySha256 === policy?.policySha256);

  function begin(label: string, phase: Pending["phase"], message: string) {
    if (writeReason) { setError(writeReason); return; }
    const token = gate.begin(label); if (!token) return;
    actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(undefined); setPending({ token, phase, message });
    setReviews((current) => current.loading ? { ...current, loading: false, error: "The refresh was interrupted by the current action. Refresh to check this source." } : current);
    setSigners((current) => current.loading ? { ...current, loading: false, error: "The refresh was interrupted by the current action. Refresh to check this source." } : current);
    return token;
  }
  function finish(token: PaymentAction) { if (gate.finish(token)) setPending(undefined); }
  function accepted(token: PaymentAction, next: Confirmed) {
    if (!gate.current(token)) return;
    setReceipt(next); finish(token);
    // The accepted receipt remains visible even if either follow-up GET fails.
    void loadReviews(); void loadSigners();
  }
  async function registerSigner() {
    if (registrationReason || !policy || policyReason(policy)) return;
    const token = begin("Register hardware signer", "options", "Requesting a signer registration challenge…"); if (!token) return;
    const submittedPolicy = structuredClone(policy);
    try {
      const raw = await paymentJson(registrationPath, { method: "POST", signal: token.signal }); if (!gate.current(token)) return;
      const prepared = await registrationOptions(raw, submittedPolicy, { tenantId, actorId }); if (!gate.current(token)) return;
      setPending({ token, phase: "authenticator", message: "Waiting for your authenticator. Registration requires an approved, non-exportable, single-device hardware key." });
      gate.ceremony(token, () => WebAuthnAbortService.cancelCeremony());
      const response = await startRegistration({ optionsJSON: prepared.options });
      if (!gate.current(token)) return; gate.ceremony(token);
      validatePaymentClientData(response, prepared.options.challenge, submittedPolicy, "webauthn.create");
      if (policyReason(submittedPolicy)) throw new Error("The signing trust policy expired during registration. Refresh before trying again.");
      setPending({ token, phase: "submit", message: "Confirming the hardware signer registration…" });
      const result = await paymentJson(registrationPath, { method: "PUT", signal: token.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: prepared.challengeToken, response }) });
      if (!gate.current(token)) return;
      const signer = await registrationReceipt(result, response, submittedPolicy, { tenantId, actorId }); if (!gate.current(token)) return;
      accepted(token, { title: "Signer registration confirmed", message: "This signer can authorize mandates under its reviewed trust policy. No checkout or payment was submitted.", details: { ...result, credentialId: signer.credentialId } });
    } catch (caught) { if (gate.current(token)) setError(paymentFailure(caught)); }
    finally { gate.ceremony(token); finish(token); }
  }
  function signingReason(review: PaymentReview) {
    return registrationReason || (paymentReviewState(review, now) !== "pending" ? "Only a current pending review can be signed. Refresh to check its state." : undefined) || (eligibleSigners.length === 0 ? "An active signer bound to the current trust policy is required." : undefined);
  }
  async function authorize(review: PaymentReview) {
    if (!policy || !signers.data || signingReason(review) || consent[review.reviewId] !== reviewConsentIdentity(review, policy, signers.data) || paymentReviewState(review) !== "pending") return;
    const token = begin(`Sign mandates for ${review.terms.merchant.name}`, "options", "Checking the exact reviewed mandate challenge…"); if (!token) return;
    const frozen = structuredClone(review), submittedPolicy = structuredClone(policy), submittedSigners = structuredClone(signers.data);
    const endpoint = `${reviewsPath}/${encodeURIComponent(frozen.reviewId)}/authorization`;
    try {
      const raw = await paymentJson(endpoint, { method: "POST", signal: token.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "options" }) }); if (!gate.current(token)) return;
      const options = await authorizationOptions(raw, frozen, submittedPolicy, submittedSigners); if (!gate.current(token)) return;
      setPending({ token, phase: "authenticator", message: `Waiting for your authenticator to sign the exact mandates for ${frozen.terms.merchant.name}.` });
      gate.ceremony(token, () => WebAuthnAbortService.cancelCeremony());
      const assertion = await startAuthentication({ optionsJSON: options });
      if (!gate.current(token)) return; gate.ceremony(token);
      validatePaymentClientData(assertion, options.challenge, submittedPolicy, "webauthn.get");
      if (!options.allowCredentials?.some((item) => item.id === assertion.id)) throw new Error("The authenticator returned a different signer. No authorization request was sent.");
      if (paymentReviewState(frozen) !== "pending" || policyReason(submittedPolicy)) throw new Error("The reviewed terms or signing policy expired during the challenge. Refresh and review the current terms.");
      setPending({ token, phase: "submit", message: "Verifying and storing the signed mandate receipt…" });
      const result = await paymentJson(endpoint, { method: "POST", signal: token.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "authorize", response: assertion }) }); if (!gate.current(token)) return;
      const confirmed = await authorizationReceipt(result, frozen, assertion, submittedPolicy, { tenantId, actorId }); if (!gate.current(token)) return;
      setConsent((current) => { const next = { ...current }; delete next[frozen.reviewId]; return next; });
      accepted(token, { title: confirmed.created ? "Mandate authorization confirmed" : "Existing mandate authorization confirmed", message: "Checkout and Payment Mandates are signed. No checkout or payment was submitted.", details: { reviewId: confirmed.review.reviewId, authorization: confirmed.authorization, checkoutOrPaymentExecuted: false, created: confirmed.created } });
    } catch (caught) { if (gate.current(token)) setError(paymentFailure(caught)); }
    finally { gate.ceremony(token); finish(token); }
  }
  function closeRevocation() { setRevocation(undefined); requestAnimationFrame(() => revokeTrigger.current?.focus()); }
  async function revoke() {
    if (!revocation || !signersCurrent || !signers.data?.some((signer) => paymentIdentity(signer) === paymentIdentity(revocation)) || writeReason) return;
    const frozen = structuredClone(revocation), token = begin("Revoke hardware signer", "submit", "Confirming signer revocation…"); if (!token) return;
    try {
      const result = await paymentJson(signersPath, { method: "DELETE", signal: token.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialId: frozen.credentialId }) }); if (!gate.current(token)) return;
      const signer = await revocationReceipt(result, frozen, { tenantId, actorId }); if (!gate.current(token)) return;
      setRevocation(undefined);
      accepted(token, { title: "Signer revocation confirmed", message: "This signer cannot authorize another mandate. Revocation does not undo earlier authorizations or submit a payment.", details: { ...result, credentialId: signer.credentialId } });
    } catch (caught) { if (gate.current(token)) setError(paymentFailure(caught)); }
    finally { finish(token); }
  }

  return <div className={styles.workspace} data-testid="payments-workspace">
    <header className={styles.header}><h1>Payments</h1><p>Review exact purchase terms and sign mandates with a registered hardware key.</p></header>
    <p className={styles.boundary}>Signing authorizes the displayed mandates. It does not submit checkout or payment. This review surface does not permit transactions.</p>
    {readReason ? <p role="status">{readReason}</p> : null}
    {writeReason && !readReason ? <p className={styles.warning}>{writeReason}</p> : null}
    <div role="status" aria-live="polite" aria-atomic="true" className={pending ? styles.progress : undefined}>{pending ? <><p>{pending.message}</p><p>Leaving this page stops later local steps. A request already sent may still finish on the server.</p>{pending.phase === "authenticator" ? <button type="button" onClick={() => { if (gate.cancel(pending.token)) { setPending(undefined); setError("The authenticator challenge was canceled. No completion request was sent. Review the current terms before trying again."); requestAnimationFrame(() => { if (actionTrigger.current?.isConnected) actionTrigger.current.focus(); }); } }}>Cancel authenticator challenge</button> : null}</> : null}</div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {receipt ? <section ref={receiptElement} tabIndex={-1} className={styles.receipt} aria-labelledby="payment-receipt-title"><div role="status"><h2 id="payment-receipt-title">{receipt.title}</h2><p>{receipt.message}</p></div><details><summary>Exact confirmed receipt</summary><pre>{JSON.stringify(receipt.details, null, 2)}</pre></details></section> : null}

    <section className={styles.section} aria-labelledby="signers-heading">
      <header className={styles.sectionHeading}><div><h2 id="signers-heading">Registered signers</h2><p>{signers.data ? `${activeSigners.length} active in the ${signers.data.length}-signer window${!signersCurrent ? " · Last loaded" : ""}` : signers.loading ? "Loading signer count…" : "Signer count unavailable"}</p></div><button type="button" onClick={() => void loadSigners()} disabled={Boolean(pending) || Boolean(readReason) || signers.loading}>Refresh registered signers</button></header>
      <ReadStatus label="Signer registry" read={signers} />
      <p className={styles.support}>Shows up to 50 recent signers for your workspace identity. Counts apply to this bounded window.</p>
      <div className={styles.actions}><button type="button" className={styles.primary} aria-describedby="signer-registration-reason" onClick={() => void registerSigner()} disabled={Boolean(registrationReason) || Boolean(pending)}>{pending?.token.label === "Register hardware signer" ? "Registering hardware signer…" : "Register hardware signer"}</button></div>
      <p id="signer-registration-reason" className={styles.support}>{pending ? "Complete or cancel the current request before starting another change." : registrationReason || "Requires an approved hardware-backed, non-exportable, single-device key with user verification. Synced passkeys do not meet this profile."}</p>
      {signers.data?.length === 0 ? <p className={styles.empty}>{signersCurrent ? "No payment signers were returned." : "The last successful registry read contained no payment signers."}</p> : null}
      <ul className={styles.signerList}>{signers.data?.map((signer, index) => <li key={signer.credentialId}>
        <article aria-labelledby={`signer-${index}`}><header className={styles.rowHeading}><h3 id={`signer-${index}`}>{signer.attestationFormat} signer</h3><span className={styles.status} data-state={signer.state}>{signer.state === "active" ? "Active" : "Revoked"}</span></header>
          <dl className={styles.bindings}><Field label="Credential ID" value={signer.credentialId} exact /><Field label="AAGUID" value={signer.aaguid} exact /><Field label="Signing profile" value={signer.signerProfile} exact /><Field label="Trust policy" value={signer.trustPolicyId} exact /><Field label="Trust policy digest" value={signer.trustPolicySha256} exact /><Field label="Lifecycle revision" value={signer.lifecycleRevision} /><Field label="Registered" value={timestamp(signer.createdAt)} /><Field label="Last used" value={signer.lastUsedAt ? timestamp(signer.lastUsedAt) : "No recorded use"} />{signer.revokedAt ? <Field label="Revoked" value={timestamp(signer.revokedAt)} /> : null}</dl>
          {signer.state === "active" ? <><button type="button" disabled={Boolean(pending) || !signersCurrent || Boolean(writeReason)} aria-label={`Review removal of signer ${signer.credentialId}`} onClick={(event) => { revokeTrigger.current = event.currentTarget; setRevocation(structuredClone(signer)); }}>Review signer removal</button>{!signersCurrent ? <p className={styles.support}>Refresh the signer registry before removing this signer.</p> : null}</> : null}
        </article>
      </li>)}</ul>
      {revocation ? <section className={styles.confirmation} aria-labelledby="signer-removal-title"><h3 id="signer-removal-title">Revoke this signer?</h3><p>This prevents new mandate authorization by this exact credential. Earlier authorizations remain recorded.</p><p><code>{revocation.credentialId}</code></p>{!signersCurrent || !signers.data?.some((signer) => paymentIdentity(signer) === paymentIdentity(revocation)) ? <p className={styles.warning}>The reviewed signer is no longer current. Cancel and refresh the registry before reviewing its removal again.</p> : null}<div className={styles.actions}><button ref={revokeCancel} type="button" disabled={Boolean(pending)} onClick={closeRevocation}>Keep signer</button><button type="button" className={styles.destructive} disabled={Boolean(pending) || Boolean(writeReason) || !signersCurrent || !signers.data?.some((signer) => paymentIdentity(signer) === paymentIdentity(revocation))} onClick={() => void revoke()}>Confirm revoke signer</button></div></section> : null}
    </section>

    <section className={styles.section} aria-labelledby="reviews-heading">
      <header className={styles.sectionHeading}><div><h2 id="reviews-heading">Purchase reviews</h2><p>{reviews.data ? `${reviews.data.reviews.filter((review) => paymentReviewState(review, now) === "pending").length} pending in the ${reviews.data.reviews.length}-review window${!reviewsCurrent ? " · Last loaded" : ""}` : reviews.loading ? "Loading review count…" : "Review count unavailable"}</p></div><button type="button" onClick={() => void loadReviews()} disabled={Boolean(pending) || Boolean(readReason) || reviews.loading}>Refresh purchase reviews</button></header>
      <ReadStatus label="Purchase reviews" read={reviews} />
      <p className={styles.support}>Shows up to 100 recent reviews. Every amount below uses the server contract’s minor units; exact integers are shown alongside formatted amounts.</p>
      <PolicyDetails policy={policy} current={Boolean(reviewsCurrent)} now={now} />
      {reviews.data?.reviews.length === 0 ? <p className={styles.empty}>{reviewsCurrent ? "No AP2 checkout review was returned. Reviews require a verified merchant adapter." : "The last successful read contained no purchase reviews."}</p> : null}
      <div className={styles.reviewList}>{reviews.data?.reviews.map((review, index) => {
        const state = paymentReviewState(review, now), reason = signingReason(review);
        const checked = Boolean(signers.data && consent[review.reviewId] === reviewConsentIdentity(review, policy || null, signers.data));
        return <article className={styles.review} aria-labelledby={`review-${index}`} key={review.reviewId}>
          <header className={styles.reviewHeader}><div><span className={styles.status} data-state={state}>{state === "pending" ? "Awaiting signature" : state === "authorized" ? "Authorized · not a payment receipt" : state === "superseded" ? "Superseded" : "Expired"}</span><h3 id={`review-${index}`}>{review.terms.merchant.name}</h3><a href={review.terms.merchant.website} target="_blank" rel="noopener noreferrer">{review.terms.merchant.website}</a></div><div className={styles.total}><span>Exact total</span><strong>{money(review.terms.totals.totalAmountMinor, review.terms.totals.currency)}</strong><span>{review.terms.totals.totalAmountMinor} minor units · {review.terms.totals.currency}</span></div></header>
          <div className={styles.detailsGrid}><section aria-label={`Items for review ${review.reviewId}`}><h4>Items and totals</h4><ol className={styles.items}>{review.terms.items.map((item, itemIndex) => <li key={`${item.id}:${itemIndex}`}><strong>{item.quantity} × {item.title}</strong><p>Item ID: <code>{item.id}</code></p><p>Unit amount: {money(item.unitAmountMinor, review.terms.totals.currency)} ({item.unitAmountMinor} minor units)</p><p>Line total: {money(item.totalAmountMinor, review.terms.totals.currency)} ({item.totalAmountMinor} minor units)</p></li>)}</ol><dl className={styles.bindings}>{([['Subtotal', 'subtotalAmountMinor'], ['Tax', 'taxAmountMinor'], ['Shipping', 'shippingAmountMinor'], ['Discount', 'discountAmountMinor'], ['Total', 'totalAmountMinor']] as const).map(([label, key]) => <Field key={key} label={label} value={`${money(review.terms.totals[key], review.terms.totals.currency)} · ${review.terms.totals[key]} minor units${key === "discountAmountMinor" ? " deducted" : ""}`} />)}</dl></section>
            <section aria-label={`Shipping for review ${review.reviewId}`}><h4>Shipping</h4><p>{review.terms.shipping.recipientName}</p>{review.terms.shipping.addressLines.map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}<dl className={styles.bindings}><Field label="City" value={review.terms.shipping.city} /><Field label="Region" value={review.terms.shipping.region} /><Field label="Postal code" value={review.terms.shipping.postalCode} /><Field label="Country" value={review.terms.shipping.country} /><Field label="Service" value={review.terms.shipping.serviceLevel} /></dl></section>
            <section aria-label={`Payment constraints for review ${review.reviewId}`}><h4>Payment constraints</h4><p>{review.terms.paymentInstrument.description}</p><dl className={styles.bindings}><Field label="Instrument ID" value={review.terms.paymentInstrument.id} exact /><Field label="Instrument type" value={review.terms.paymentInstrument.type} /><Field label="Credential provider" value={review.terms.paymentConstraints.credentialProviderId} exact /><Field label="Merchant processor" value={review.terms.paymentConstraints.merchantPaymentProcessorId} exact /><Field label="Allowed instruments" value={review.terms.paymentConstraints.allowedInstrumentTypes.join(", ")} /><Field label="Exact maximum" value={`${review.terms.paymentConstraints.maximumAmountMinor} minor units · ${review.terms.paymentConstraints.currency}`} /><Field label="Execution restriction" value="Immediate execution only" /><Field label="Expires" value={timestamp(review.terms.expiresAt)} /></dl></section></div>
          <dl className={styles.bindings}><Field label="Review ID" value={review.reviewId} exact /><Field label="Merchant ID" value={review.terms.merchant.id} exact /><Field label="Order ID" value={review.terms.merchantOrderId} exact /><Field label="Shopping Agent" value={review.shoppingAgentPrincipalId} exact /><Field label="Owner tenant" value={review.tenantId} exact /><Field label="Owner actor" value={review.ownerActorId} exact /><Field label="Intent digest" value={review.intentSha256} exact /><Field label="Terms digest" value={review.exactTermsSha256} exact /><Field label="Authorization digest" value={review.authorizationDigest} exact /><Field label="Review digest" value={review.reviewSha256} exact /><Field label="Lifecycle revision" value={review.lifecycleRevision} /><Field label="Last updated" value={timestamp(review.updatedAt)} /></dl>
          <details className={styles.exact} open><summary>Exact mandate contents and verification evidence</summary><p>Merchant content is untrusted data. Review all bound fields; the server verifies the signature and authority.</p><pre>{JSON.stringify({ merchantCheckoutJwt: review.merchantCheckoutJwt, merchantCheckoutVerification: review.merchantCheckoutVerification, checkoutMandateContent: review.checkoutMandateContent, paymentMandateContent: review.paymentMandateContent, outcomeContract: review.outcomeContract, trustedSurface: review.trustedSurface, authorizedAt: review.authorizedAt, supersededAt: review.supersededAt }, null, 2)}</pre></details>
          {state === "pending" ? <div className={styles.consent}><label><input type="checkbox" disabled={Boolean(pending) || Boolean(reason)} checked={checked} aria-describedby={`review-reason-${index}`} onChange={(event) => { const selected = event.currentTarget.checked; setConsent((current) => { const next = { ...current }; if (selected && signers.data) next[review.reviewId] = reviewConsentIdentity(review, policy || null, signers.data); else delete next[review.reviewId]; return next; }); }} /><span>I reviewed the merchant, every item and quantity, all amounts, shipping, instrument and constraints, expiry, Agent, exact mandate contents and digests.</span></label><p id={`review-reason-${index}`} className={styles.support}>{pending ? "Complete or cancel the current request before signing another review." : reason || "Confirmation applies only to these exact terms, signer records and trust policy. Any change requires review again."}</p><button type="button" className={styles.primary} aria-label={`Sign both mandates for review ${review.reviewId}`} aria-describedby={`review-reason-${index}`} disabled={!checked || Boolean(reason) || Boolean(pending)} onClick={() => void authorize(review)}>Sign both mandates</button></div> : <p className={styles.support}>{state === "authorized" ? "Mandate authorization is recorded. This is not evidence of checkout, settlement or payment execution." : "This review cannot be signed. Refresh to check for a current review; earlier confirmation does not carry over."}</p>}
        </article>;
      })}</div>
    </section>
  </div>;
}

function ReadStatus<T>({ label, read }: { label: string; read: PaymentRead<T> }) {
  return <div className={styles.readStatus}><p role="status">{read.loading ? read.data ? `${label}: refreshing; last-loaded details remain visible.` : `${label}: loading…` : read.error ? read.data ? `${label}: refresh unavailable; last-loaded details are shown.` : `${label}: unavailable.` : read.data ? `${label}: loaded.` : `${label}: not checked.`}</p>{read.error ? <p className={styles.error}>{read.error}</p> : null}</div>;
}
function Field({ label, value, exact = false }: { label: string; value: string | number; exact?: boolean }) { return <div><dt>{label}</dt><dd>{exact ? <code>{value}</code> : value}</dd></div>; }
function PolicyDetails({ policy, current, now }: { policy?: PaymentPolicy | null; current: boolean; now: number }) {
  return <section className={styles.policy} aria-labelledby="payment-policy-title"><h3 id="payment-policy-title">Hardware signing policy</h3><p className={styles.support}>{!current ? "Policy availability is unconfirmed until purchase reviews load successfully." : policy === null ? "No operator-reviewed policy is configured. Registration and signing are unavailable." : now ? policyReason(policy, now) || "A reviewed policy is available. Each authenticator must meet its hardware and attestation requirements." : "Checking policy validity…"}</p>{policy ? <details><summary>Exact signing policy{!current ? " · Last loaded" : ""}</summary><pre>{JSON.stringify(policy, null, 2)}</pre></details> : null}</section>;
}
function timestamp(value: string) { return `${new Date(value).toLocaleString()} · ${value}`; }
function money(amountMinor: number, currency: string) {
  return paymentAmount(amountMinor, currency);
}
