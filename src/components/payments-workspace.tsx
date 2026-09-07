"use client";

import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { AlertTriangle, CheckCircle2, CreditCard, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import styles from "./payments-workspace.module.css";

type TrustPolicy = {
  policyId: string;
  policySha256: string;
  allowedAaguidCount: number;
  validUntil: string;
};

type PaymentCredential = {
  credentialId: string;
  aaguid: string;
  attestationFormat: string;
  signerProfile: string;
  trustPolicyId: string;
  state: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

type Review = {
  reviewId: string;
  shoppingAgentPrincipalId: string;
  intentSha256: string;
  exactTermsSha256: string;
  authorizationDigest: string;
  state: "pending" | "authorized" | "expired" | "superseded";
  terms: {
    merchant: { id: string; name: string; website: string };
    merchantOrderId: string;
    items: Array<{
      id: string;
      title: string;
      quantity: number;
      unitAmountMinor: number;
      totalAmountMinor: number;
    }>;
    totals: {
      currency: string;
      subtotalAmountMinor: number;
      taxAmountMinor: number;
      shippingAmountMinor: number;
      discountAmountMinor: number;
      totalAmountMinor: number;
    };
    shipping: {
      recipientName: string;
      addressLines: string[];
      city: string;
      region: string;
      postalCode: string;
      country: string;
      serviceLevel: string;
    };
    paymentInstrument: { id: string; type: string; description: string };
    paymentConstraints: {
      credentialProviderId: string;
      merchantPaymentProcessorId: string;
      allowedInstrumentTypes: string[];
      maximumAmountMinor: number;
      currency: string;
      immediateExecutionOnly: true;
    };
    expiresAt: string;
  };
};

type ReviewsResponse = {
  trustPolicy: TrustPolicy | null;
  reviews: Review[];
  transactionsPermitted: false;
};

export function PaymentsWorkspace() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [credentials, setCredentials] = useState<PaymentCredential[]>([]);
  const [trustPolicy, setTrustPolicy] = useState<TrustPolicy | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setState("loading");
    setError(undefined);
    try {
      const [reviewsResponse, credentialsResponse] = await Promise.all([
        fetch("/api/payments/ap2/reviews", { cache: "no-store" }),
        fetch("/api/payments/ap2/authenticators", { cache: "no-store" }),
      ]);
      const reviewsBody = await readJson(reviewsResponse);
      const credentialsBody = await readJson(credentialsResponse);
      if (!reviewsResponse.ok) throw new Error(message(reviewsBody, reviewsResponse.status));
      if (!credentialsResponse.ok) throw new Error(message(credentialsBody, credentialsResponse.status));
      const typedReviews = reviewsBody as unknown as ReviewsResponse;
      setReviews(typedReviews.reviews || []);
      setTrustPolicy(typedReviews.trustPolicy || null);
      setCredentials((credentialsBody.credentials || []) as PaymentCredential[]);
      setState("ready");
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "Payment review is unavailable.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function registerSigner() {
    setBusy("register");
    setError(undefined);
    setNotice(undefined);
    try {
      const begin = await fetch("/api/payments/ap2/authenticators/registration", { method: "POST" });
      const beginBody = await readJson(begin);
      if (!begin.ok) throw new Error(message(beginBody, begin.status));
      const response = await startRegistration({
        optionsJSON: beginBody.options as PublicKeyCredentialCreationOptionsJSON,
      });
      const complete = await fetch("/api/payments/ap2/authenticators/registration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeToken: beginBody.challengeToken,
          response,
        }),
      });
      const completeBody = await readJson(complete);
      if (!complete.ok) throw new Error(message(completeBody, complete.status));
      setNotice("Hardware-backed payment signer registered.");
      await load();
    } catch (registrationError) {
      setError(registrationError instanceof Error ? registrationError.message : "Signer registration failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function authorize(review: Review) {
    if (!reviewed[review.reviewId]) {
      setError("Review every displayed term and confirm the checkbox before signing.");
      return;
    }
    setBusy(review.reviewId);
    setError(undefined);
    setNotice(undefined);
    try {
      const endpoint = `/api/payments/ap2/reviews/${encodeURIComponent(review.reviewId)}/authorization`;
      const optionsResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "options" }),
      });
      const optionsBody = await readJson(optionsResponse);
      if (!optionsResponse.ok) throw new Error(message(optionsBody, optionsResponse.status));
      const assertion = await startAuthentication({
        optionsJSON: optionsBody.options as PublicKeyCredentialRequestOptionsJSON,
      });
      const authorizationResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "authorize", response: assertion }),
      });
      const authorizationBody = await readJson(authorizationResponse);
      if (!authorizationResponse.ok) {
        throw new Error(message(authorizationBody, authorizationResponse.status));
      }
      setNotice("Checkout and Payment Mandates signed. No checkout or payment was submitted.");
      setReviewed((current) => ({ ...current, [review.reviewId]: false }));
      await load();
    } catch (authorizationError) {
      setError(authorizationError instanceof Error ? authorizationError.message : "Mandate signing failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function revoke(credential: PaymentCredential) {
    setBusy(`revoke:${credential.credentialId}`);
    setError(undefined);
    try {
      const response = await fetch("/api/payments/ap2/authenticators", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentialId: credential.credentialId }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(message(body, response.status));
      setNotice("Payment signer revoked. It cannot authorize another mandate.");
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Signer revocation failed.");
    } finally {
      setBusy(undefined);
    }
  }

  const activeCredentials = credentials.filter((credential) => credential.state === "active");

  return (
    <main className={styles.workspace}>
      <header className={styles.hero}>
        <div className={styles.eyebrow}><ShieldCheck size={16} /> Trusted Surface</div>
        <h1>Payment mandates</h1>
        <p>Review exact purchase terms and sign them with your registered hardware key. Signing alone never submits checkout or payment.</p>
        <div className={styles.gate}><AlertTriangle size={17} /> Live transactions remain disabled until credential isolation and receipt reconciliation are complete.</div>
      </header>

      <div className={styles.toolbar}>
        <button className="action-button" type="button" onClick={() => void load()} disabled={state === "loading" || Boolean(busy)}>
          <RefreshCw size={16} /> Refresh
        </button>
        <button className="primary-button" type="button" onClick={() => void registerSigner()} disabled={!trustPolicy || Boolean(busy)}>
          {busy === "register" ? <Loader2 className={styles.spin} size={16} /> : <KeyRound size={16} />}
          Register hardware signer
        </button>
      </div>

      {notice ? <div className={styles.notice}><CheckCircle2 size={17} /> {notice}</div> : null}
      {error ? <div className={styles.error}><AlertTriangle size={17} /> {error}</div> : null}
      {!trustPolicy ? (
        <div className={styles.blocked}>
          <strong>Signing is fail-closed.</strong>
          <span>No operator-reviewed AAGUID and attestation trust policy is configured for this deployment.</span>
        </div>
      ) : null}

      <section className={styles.section} aria-labelledby="signers-heading">
        <div className={styles.sectionHeading}>
          <div><span>Authorization keys</span><h2 id="signers-heading">Registered signers</h2></div>
          <strong>{activeCredentials.length} active</strong>
        </div>
        <div className={styles.signerGrid}>
          {credentials.length === 0 ? <p className={styles.empty}>No payment signer is registered.</p> : credentials.map((credential) => (
            <article className={styles.signer} key={credential.credentialId}>
              <KeyRound size={20} />
              <div>
                <strong>{credential.attestationFormat} · {credential.state}</strong>
                <code>{short(credential.credentialId)}</code>
                <span>AAGUID {credential.aaguid}</span>
              </div>
              {credential.state === "active" ? (
                <button type="button" onClick={() => void revoke(credential)} disabled={Boolean(busy)}>
                  {busy === `revoke:${credential.credentialId}` ? "Revoking…" : "Revoke"}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="reviews-heading">
        <div className={styles.sectionHeading}>
          <div><span>Exact consent</span><h2 id="reviews-heading">Purchase reviews</h2></div>
          <strong>{reviews.filter((review) => review.state === "pending").length} pending</strong>
        </div>
        {state === "loading" ? <p className={styles.empty}><Loader2 className={styles.spin} size={18} /> Loading exact terms…</p> : null}
        {state === "ready" && reviews.length === 0 ? <p className={styles.empty}>No AP2 checkout has been prepared by a verified merchant adapter.</p> : null}
        <div className={styles.reviewList}>
          {reviews.map((review) => (
            <article className={styles.review} key={review.reviewId}>
              <div className={styles.reviewHeader}>
                <div>
                  <span className={styles.status} data-state={review.state}>{review.state}</span>
                  <h3>{review.terms.merchant.name}</h3>
                  <a href={review.terms.merchant.website} target="_blank" rel="noreferrer">{review.terms.merchant.website}</a>
                </div>
                <div className={styles.total}>
                  <span>Total</span>
                  <strong>{money(review.terms.totals.totalAmountMinor, review.terms.totals.currency)}</strong>
                </div>
              </div>

              <div className={styles.detailGrid}>
                <div>
                  <h4>Items</h4>
                  {review.terms.items.map((item) => (
                    <p key={item.id}>{item.quantity} × {item.title} <strong>{money(item.totalAmountMinor, review.terms.totals.currency)}</strong></p>
                  ))}
                  <p>Tax <strong>{money(review.terms.totals.taxAmountMinor, review.terms.totals.currency)}</strong></p>
                  <p>Shipping <strong>{money(review.terms.totals.shippingAmountMinor, review.terms.totals.currency)}</strong></p>
                  <p>Discount <strong>−{money(review.terms.totals.discountAmountMinor, review.terms.totals.currency)}</strong></p>
                </div>
                <div>
                  <h4>Shipping</h4>
                  <p>{review.terms.shipping.recipientName}</p>
                  <p>{review.terms.shipping.addressLines.join(", ")}</p>
                  <p>{review.terms.shipping.city}, {review.terms.shipping.region} {review.terms.shipping.postalCode}</p>
                  <p>{review.terms.shipping.country} · {review.terms.shipping.serviceLevel}</p>
                </div>
                <div>
                  <h4>Payment constraint</h4>
                  <p>{review.terms.paymentInstrument.description}</p>
                  <p>Type: {review.terms.paymentInstrument.type}</p>
                  <p>Immediate execution only</p>
                  <p>Expires {new Date(review.terms.expiresAt).toLocaleString()}</p>
                </div>
              </div>

              <dl className={styles.bindings}>
                <div><dt>Order</dt><dd>{review.terms.merchantOrderId}</dd></div>
                <div><dt>Agent</dt><dd>{review.shoppingAgentPrincipalId}</dd></div>
                <div><dt>Intent</dt><dd><code>{review.intentSha256}</code></dd></div>
                <div><dt>Terms digest</dt><dd><code>{review.exactTermsSha256}</code></dd></div>
                <div><dt>Authorization digest</dt><dd><code>{review.authorizationDigest}</code></dd></div>
              </dl>

              {review.state === "pending" ? (
                <div className={styles.consent}>
                  <label>
                    <input type="checkbox" checked={Boolean(reviewed[review.reviewId])} onChange={(event) => setReviewed((current) => ({ ...current, [review.reviewId]: event.target.checked }))} />
                    I reviewed the merchant, every item and quantity, price, tax, shipping, payment constraint, expiry, agent, and intent digest shown above.
                  </label>
                  <button className="primary-button" type="button" disabled={!reviewed[review.reviewId] || !trustPolicy || activeCredentials.length === 0 || Boolean(busy)} onClick={() => void authorize(review)}>
                    {busy === review.reviewId ? <Loader2 className={styles.spin} size={17} /> : <CreditCard size={17} />}
                    Sign both mandates
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

async function readJson(response: Response) {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function message(body: Record<string, unknown>, status: number) {
  return String(body.message || body.error || `Payment service returned ${status}.`);
}

function short(value: string) {
  return value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value;
}

function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}
