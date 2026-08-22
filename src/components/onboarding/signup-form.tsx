"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Loader2, Send } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type AccessResponse = {
  id: string;
  status: string;
  persistedAt: string;
  next: string[];
};

const timelineOptions = [
  { value: "now", label: "Now" },
  { value: "30_days", label: "Within 30 days" },
  { value: "quarter", label: "This quarter" },
  { value: "research", label: "Researching" },
];

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("engineering");
  const [timeline, setTimeline] = useState("30_days");
  const [useCase, setUseCase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AccessResponse | null>(null);

  const remaining = useMemo(() => Math.max(0, 800 - useCase.length), [useCase]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFieldErrors: Record<string, string> = {};
    if (name.trim().length < 2) nextFieldErrors.name = "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) nextFieldErrors.email = "Enter a valid work email.";
    if (company.trim().length < 2) nextFieldErrors.company = "Enter your company or team name.";
    if (useCase.trim().length < 12) nextFieldErrors.useCase = "Describe the workflow in at least 12 characters.";
    if (Object.keys(nextFieldErrors).length) {
      setFieldErrors(nextFieldErrors);
      setError("Review the highlighted fields and submit again.");
      const firstKey = Object.keys(nextFieldErrors)[0];
      const firstInvalidId = firstKey === "useCase" ? "signup-use-case" : `signup-${firstKey}`;
      window.requestAnimationFrame(() => document.getElementById(firstInvalidId)?.focus());
      return;
    }

    setSubmitting(true);
    setError("");
    setFieldErrors({});

    try {
      const response = await fetch("/api/onboarding/request-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, company, role, timeline, useCase }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.message || body.error || "Access request could not be saved.");
        return;
      }

      setResult(body);
    } catch {
      setError("Access request failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div role="status" aria-live="polite">
        <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
          <CheckCircle2 size={22} aria-hidden="true" />
        </div>
        <p className="mt-8 text-sm font-semibold text-primary">Request saved</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-normal">Your request is pending review.</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Reference <span className="font-mono text-foreground">{result.id.slice(0, 8)}</span>. This confirms the complete request was stored. It does not confirm access or a review date.
        </p>
        <div className="mt-8 space-y-3">
          {result.next.map((item) => (
            <div key={item} className="flex items-start gap-3 border-b border-line pb-3 text-sm">
              <span className="mt-2 size-1.5 rounded-full bg-primary" aria-hidden="true" />
              <span className="leading-6">{item}</span>
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/demo"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105"
          >
            Open demo
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-md border border-line bg-background px-4 text-sm font-semibold transition hover:bg-surface-raised"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate data-testid="access-request-form">
      <div>
        <p className="text-sm font-semibold text-primary">Request access</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-normal">Tell us what your team needs.</h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          The request is stored for administrator review. Access, timing, and commercial terms are not guaranteed.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-foreground" role="alert">
          {error}
        </div>
      ) : null}

      <div>
        <label htmlFor="signup-name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="signup-name"
          name="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setFieldErrors((current) => ({ ...current, name: "" }));
          }}
          autoComplete="name"
          maxLength={120}
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={fieldErrors.name ? "signup-name-error" : undefined}
          required
        />
        {fieldErrors.name ? <p id="signup-name-error" className="mt-2 text-sm text-danger">{fieldErrors.name}</p> : null}
      </div>

      <div>
        <label htmlFor="signup-email" className="text-sm font-medium">
          Work email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setFieldErrors((current) => ({ ...current, email: "" }));
          }}
          autoComplete="email"
          maxLength={254}
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
          required
        />
        {fieldErrors.email ? <p id="signup-email-error" className="mt-2 text-sm text-danger">{fieldErrors.email}</p> : null}
      </div>

      <div>
        <label htmlFor="signup-company" className="text-sm font-medium">
          Company
        </label>
        <input
          id="signup-company"
          name="company"
          value={company}
          onChange={(event) => {
            setCompany(event.target.value);
            setFieldErrors((current) => ({ ...current, company: "" }));
          }}
          autoComplete="organization"
          maxLength={160}
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          aria-invalid={Boolean(fieldErrors.company)}
          aria-describedby={fieldErrors.company ? "signup-company-error" : undefined}
          required
        />
        {fieldErrors.company ? <p id="signup-company-error" className="mt-2 text-sm text-danger">{fieldErrors.company}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="signup-role" className="text-sm font-medium">
            Role
          </label>
          <select
            id="signup-role"
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="founder">Founder</option>
            <option value="engineering">Engineering</option>
            <option value="product">Product</option>
            <option value="operations">Operations</option>
            <option value="security">Security</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label htmlFor="signup-timeline" className="text-sm font-medium">
            Timeline
          </label>
          <select
            id="signup-timeline"
            name="timeline"
            value={timeline}
            onChange={(event) => setTimeline(event.target.value)}
            className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            {timelineOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="signup-use-case" className="text-sm font-medium">
          First workflow to automate
        </label>
        <p id="signup-use-case-help" className="mt-1 text-xs leading-5 text-muted">
          Example: agent that ingests customer tickets, retrieves policy, opens approvals, and drafts responses.
        </p>
        <textarea
          id="signup-use-case"
          name="useCase"
          value={useCase}
          onChange={(event) => {
            setUseCase(event.target.value.slice(0, 800));
            setFieldErrors((current) => ({ ...current, useCase: "" }));
          }}
          rows={5}
          maxLength={800}
          className="mt-2 w-full resize-y rounded-md border border-line bg-background px-3 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          aria-invalid={Boolean(fieldErrors.useCase)}
          aria-describedby={`signup-use-case-help signup-use-case-count${fieldErrors.useCase ? " signup-use-case-error" : ""}`}
          required
        />
        {fieldErrors.useCase ? <p id="signup-use-case-error" className="mt-2 text-sm text-danger">{fieldErrors.useCase}</p> : null}
        <p id="signup-use-case-count" className="mt-2 text-xs text-muted">{remaining} characters remaining</p>
      </div>

      <button
        type="submit"
        disabled={submitting}
        aria-describedby="access-request-privacy"
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {submitting ? "Submitting request" : "Request workspace"}
      </button>
      <p id="access-request-privacy" className="text-xs leading-5 text-muted">
        Your name, work email, company, role, timeline, and workflow description are stored with the request. Sensitive values are not copied into telemetry.
      </p>

      <p className="text-sm text-muted">
        Already invited?{" "}
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Sign in
        </Link>
        .
      </p>
    </form>
  );
}
