"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

type SessionState = "checking" | "authenticated" | "anonymous" | "local" | "error";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [googleLoginConfigured, setGoogleLoginConfigured] = useState(false);

  useEffect(() => {
    let canceled = false;

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session");
        const session: unknown = await response.json().catch(() => undefined);
        if (
          !response.ok ||
          !session ||
          typeof session !== "object" ||
          typeof (session as Record<string, unknown>).authEnabled !== "boolean" ||
          typeof (session as Record<string, unknown>).authenticated !== "boolean"
        ) {
          throw new Error("Session status is unavailable.");
        }
        const validSession = session as {
          authEnabled: boolean;
          authenticated: boolean;
          googleLoginConfigured?: boolean;
        };
        setGoogleLoginConfigured(Boolean(validSession.googleLoginConfigured));
        const googleResult = new URLSearchParams(window.location.search).get("google");
        if (googleResult === "failed") {
          setError("Google sign-in could not be verified. Use the configured owner account and try again.");
        } else if (googleResult === "denied") {
          setError("Google sign-in was canceled.");
        }
        if (!canceled) {
          if (!validSession.authEnabled) {
            setSessionState("local");
          } else if (validSession.authenticated) {
            setSessionState("authenticated");
            router.replace("/app");
          } else {
            setSessionState("anonymous");
          }
        }
      } catch {
        if (!canceled) {
          setSessionState("error");
        }
      }
    }

    void checkSession();
    return () => {
      canceled = true;
    };
  }, [router, sessionCheckAttempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many sign-in attempts. Try again shortly."
            : body.message || "Email or password is incorrect.",
        );
        return;
      }

      router.replace("/app");
    } catch {
      setError("Sign in failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionState === "authenticated") {
    return (
      <div className="flex items-center gap-3 text-sm text-muted" role="status">
        <Loader2 size={17} className="animate-spin" aria-hidden="true" />
        Opening your workspace.
      </div>
    );
  }

  if (sessionState === "local") {
    return (
      <div role="status">
        <div className="grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
          <ShieldCheck size={22} aria-hidden="true" />
        </div>
        <h1 className="mt-8 text-3xl font-semibold tracking-normal">
          Local development mode
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted">
          Open the workspace directly. Controls follow the local role configured for this environment.
        </p>
        <Link href="/app" className="primary-button mt-8">
          Open workspace
        </Link>
      </div>
    );
  }

  return (
    <form
      data-testid="login-form"
      aria-busy={submitting}
      onSubmit={submit}
      className="space-y-6"
      noValidate
    >
      <div className="text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-md bg-primary/12 text-primary">
          <LogIn size={21} aria-hidden="true" />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
          Private owner access
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">
          Welcome back
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Sign in to your Asael workspace.
        </p>
      </div>

      {sessionState === "checking" ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-background px-4 py-3 text-sm text-muted" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Checking existing session.
        </div>
      ) : null}

      {sessionState === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground" role="status">
          <span>Session status is unavailable. You can still try signing in.</span>
          <button
            type="button"
            className="action-button min-h-9 shrink-0"
            onClick={() => {
              setSessionState("checking");
              setSessionCheckAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-foreground" role="alert">
          {error}
        </div>
      ) : null}

      {googleLoginConfigured ? (
        <>
          <a
            href="/api/auth/google/authorize"
            className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-md border border-line bg-background px-4 text-sm font-semibold transition hover:border-primary/45 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="grid size-6 place-items-center rounded-full bg-white font-semibold text-[#4285f4]" aria-hidden="true">G</span>
            Continue with Google
          </a>
          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            Password fallback
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      ) : null}

      <div>
        <label htmlFor="email" className="text-sm font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-2 h-12 w-full rounded-md border border-line bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          required
        />
      </div>

      <div>
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <div className="mt-2 flex h-12 rounded-md border border-line bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            className="grid w-12 place-items-center text-muted transition hover:text-foreground"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting || !email || !password}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-55"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
        {submitting ? "Signing in" : "Sign in"}
      </button>

      <p className="text-center text-xs leading-5 text-muted">
        Private workspace · No public registration
      </p>
    </form>
  );
}
