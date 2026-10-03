"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { explicitCompanionReturn, readCompanionEntryDestination } from "@/lib/companion/navigation";
import styles from "./login-form.module.css";

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
  const [explicitDestination, setExplicitDestination] = useState<string>();
  const [localDestination, setLocalDestination] = useState("/app");
  const entryControllerRef = useRef<AbortController | undefined>(undefined);
  const sessionControllerRef = useRef<AbortController | undefined>(undefined);
  const submitControllerRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      entryControllerRef.current?.abort();
      sessionControllerRef.current?.abort();
      submitControllerRef.current?.abort();
    };
  }, []);

  const openEntry = useCallback(async () => {
    entryControllerRef.current?.abort();
    const controller = new AbortController();
    entryControllerRef.current = controller;
    const href = await readCompanionEntryDestination(window.location.search, controller.signal);
    if (mountedRef.current && !controller.signal.aborted && entryControllerRef.current === controller) router.replace(href);
  }, [router]);

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    sessionControllerRef.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 15_000);
    const current = () => !canceled && mountedRef.current && sessionControllerRef.current === controller;

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session", { signal: controller.signal, cache: "no-store" });
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
        if (!current()) return;
        setExplicitDestination(explicitCompanionReturn(window.location.search));
        setGoogleLoginConfigured(validSession.googleLoginConfigured === true);
        const googleResult = new URLSearchParams(window.location.search).get("google");
        if (googleResult === "failed") {
          setError("Google sign-in could not be verified. Choose an approved Personal or Work account and try again.");
        } else if (googleResult === "denied") {
          setError("Google sign-in was canceled.");
        }
        if (current()) {
          if (!validSession.authEnabled) {
            const href = await readCompanionEntryDestination(window.location.search, controller.signal);
            if (!current()) return;
            setLocalDestination(href);
            setSessionState("local");
          } else if (validSession.authenticated) {
            setSessionState("authenticated");
            await openEntry();
          } else {
            setSessionState("anonymous");
          }
        }
      } catch {
        if (current()) {
          setSessionState("error");
        }
      } finally {
        window.clearTimeout(deadline);
      }
    }

    void checkSession();
    return () => {
      canceled = true;
      window.clearTimeout(deadline);
      controller.abort();
      entryControllerRef.current?.abort();
    };
  }, [openEntry, sessionCheckAttempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitControllerRef.current || !email || !password) return;
    const controller = new AbortController();
    submitControllerRef.current = controller;
    const current = () => mountedRef.current && submitControllerRef.current === controller;
    const deadline = window.setTimeout(() => controller.abort(), 30_000);
    sessionControllerRef.current?.abort();
    sessionControllerRef.current = undefined;
    setSessionState("anonymous");
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!current()) return;

      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many sign-in attempts. Try again shortly."
            : body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.length <= 500
              ? body.message
              : response.status >= 500 ? "Sign-in is unavailable. Try again shortly." : "Email or password is incorrect.",
        );
        return;
      }

      if (!body || typeof body !== "object" || !("authenticated" in body) || body.authenticated !== true) {
        setError("Sign-in could not be confirmed. Check your session before trying again.");
        return;
      }

      await openEntry();
    } catch {
      if (current()) setError(controller.signal.aborted
        ? "Sign-in could not be confirmed in time. Check your session before trying again."
        : "Sign in failed. Check your connection and try again.");
    } finally {
      window.clearTimeout(deadline);
      if (current()) {
        submitControllerRef.current = undefined;
        setSubmitting(false);
      }
    }
  }

  if (sessionState === "authenticated") {
    return <div className={styles.form}>
      <h1>Opening your workspace</h1>
      <p className={styles.support} role="status">Your session is authenticated. Resolving your saved destination.</p>
    </div>;
  }

  if (sessionState === "local") {
    return <div className={styles.form}>
      <ShieldCheck size={24} aria-hidden="true" className={styles.icon} />
      <h1>Local development mode</h1>
      <p className={styles.support}>Open the workspace directly. Controls follow the local role configured for this environment.</p>
      <Link href={localDestination} className={styles.primary}>Open workspace</Link>
    </div>;
  }

  return (
    <form data-testid="login-form" aria-busy={submitting} onSubmit={submit} className={styles.form} noValidate>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>Private account access</p>
        <h1>Welcome back</h1>
        <p className={styles.support}>Choose your Personal or Work Google account. Each opens its own isolated Asael workspace.</p>
      </header>
      {sessionState === "checking" ? <p className={styles.notice} role="status">Checking existing session.</p> : null}
      {sessionState === "error" ? <div className={styles.notice} role="status">
        <span>Session status is unavailable. You can still try signing in.</span>
        <button type="button" className={styles.secondary} onClick={() => {
          setSessionState("checking"); setSessionCheckAttempt((attempt) => attempt + 1);
        }}>Retry</button>
      </div> : null}
      {error ? <p id="login-error" className={styles.error} role="alert">{error}</p> : null}
      {googleLoginConfigured ? <>
        <a href={explicitDestination ? `/api/auth/google/authorize?next=${encodeURIComponent(explicitDestination)}` : "/api/auth/google/authorize"} className={styles.secondary}>Continue with Google</a>
        <p className={styles.divider}>Password access</p>
      </> : null}
      <div className={styles.field}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          value={email} onChange={(event) => setEmail(event.target.value)} required aria-describedby={error ? "login-error" : undefined} />
      </div>
      <div className={styles.field}>
        <label htmlFor="password">Password</label>
        <div className={styles.password}>
          <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password"
            value={password} onChange={(event) => setPassword(event.target.value)} required aria-describedby={error ? "login-error" : undefined} />
          <button type="button" onClick={() => setShowPassword((current) => !current)} className={styles.reveal}
            aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}>
            {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <button type="submit" disabled={submitting || !email || !password} className={styles.primary}>
        <LogIn size={18} aria-hidden="true" />{submitting ? "Signing in" : "Sign in"}
      </button>
      <p className={styles.support} role="status">{submitting ? "Verifying your credentials." : "Private app · Approved accounts only · No public registration"}</p>
    </form>
  );
}
