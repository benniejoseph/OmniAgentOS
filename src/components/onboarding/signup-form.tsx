"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Loader2, Send } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type AccessResponse = {
  id: string;
  status: string;
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
  const [result, setResult] = useState<AccessResponse | null>(null);

  const remaining = useMemo(() => Math.max(0, 800 - useCase.length), [useCase]);
  const ready = name.length >= 2 && email.includes("@") && company.length >= 2 && useCase.length >= 12;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/onboarding/request-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, company, role, timeline, useCase }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.error || "Access request could not be submitted.");
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
      <div>
        <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
          <CheckCircle2 size={22} aria-hidden="true" />
        </div>
        <p className="mt-8 text-sm font-semibold uppercase tracking-[0.22em] text-primary">Request queued</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-normal">Workspace access is ready for review.</h2>
        <p className="mt-4 text-sm leading-6 text-muted">
          Reference <span className="font-mono text-foreground">{result.id.slice(0, 8)}</span>. Use the sample workspace now, then sign in when an administrator activates your account.
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
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-primary">Request access</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-normal">Start with an enterprise workspace.</h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          Tell us what you want OmniAgentOS to operate. Setup details stay minimal until there is a real account.
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
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
      </div>

      <div>
        <label htmlFor="signup-email" className="text-sm font-medium">
          Work email
        </label>
        <input
          id="signup-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
      </div>

      <div>
        <label htmlFor="signup-company" className="text-sm font-medium">
          Company
        </label>
        <input
          id="signup-company"
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          autoComplete="organization"
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="signup-role" className="text-sm font-medium">
            Role
          </label>
          <select
            id="signup-role"
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
        <p className="mt-1 text-xs leading-5 text-muted">
          Example: agent that ingests customer tickets, retrieves policy, opens approvals, and drafts responses.
        </p>
        <textarea
          id="signup-use-case"
          value={useCase}
          onChange={(event) => setUseCase(event.target.value.slice(0, 800))}
          rows={5}
          className="mt-2 w-full resize-y rounded-md border border-line bg-background px-3 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
        <p className="mt-2 text-xs text-muted">{remaining} characters remaining</p>
      </div>

      <button
        type="submit"
        disabled={submitting || !ready}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {submitting ? "Submitting request" : "Request workspace"}
      </button>

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
