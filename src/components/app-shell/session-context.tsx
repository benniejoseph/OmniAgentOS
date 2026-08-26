"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type WorkspaceRole = "viewer" | "operator" | "admin" | "system";

export type WorkspaceSession = {
  authEnabled: boolean;
  authenticated: boolean;
  context?: {
    actorId?: string;
    role?: WorkspaceRole;
    tenantId?: string;
  };
  user?: {
    email?: string;
    name?: string | null;
  };
  tenant?: {
    name?: string;
    slug?: string;
  };
  membership?: {
    role?: WorkspaceRole;
  };
};

export type WorkspacePermission =
  | "read"
  | "write.memory"
  | "execute.tool"
  | "manage.connector"
  | "run.agent"
  | "manage.workflow"
  | "run.evaluation"
  | "read.security"
  | "manage.identity";

type SessionStatus = "loading" | "ready" | "error";

type SessionContextValue = {
  session?: WorkspaceSession;
  status: SessionStatus;
  error?: string;
  role: WorkspaceRole;
  refresh: () => Promise<WorkspaceSession | undefined>;
  signOut: () => Promise<void>;
};

const permissionRoles: Record<WorkspacePermission, WorkspaceRole[]> = {
  read: ["viewer", "operator", "admin", "system"],
  "write.memory": ["operator", "admin", "system"],
  "execute.tool": ["operator", "admin", "system"],
  "manage.connector": ["admin", "system"],
  "run.agent": ["operator", "admin", "system"],
  "manage.workflow": ["operator", "admin", "system"],
  "run.evaluation": ["operator", "admin", "system"],
  "read.security": ["admin", "system"],
  "manage.identity": ["admin", "system"],
};

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function WorkspaceSessionProvider({
  children,
  initialSession,
}: {
  children: React.ReactNode;
  initialSession?: WorkspaceSession;
}) {
  const [session, setSession] = useState<WorkspaceSession | undefined>(initialSession);
  const [status, setStatus] = useState<SessionStatus>(initialSession ? "ready" : "loading");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(undefined);
    try {
      const response = await fetch("/api/auth/session", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as WorkspaceSession & {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(body.message || body.error || `Session returned ${response.status}.`);
      }
      setSession(body);
      setStatus("ready");
      return body;
    } catch (refreshError) {
      setStatus("error");
      setError(refreshError instanceof Error ? refreshError.message : "Session status is unavailable.");
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (initialSession) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [initialSession, refresh]);

  const signOut = useCallback(async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(body.message || body.error || "Sign out failed.");
    }
    setSession((current) => ({
      authEnabled: current?.authEnabled ?? true,
      authenticated: false,
    }));
    setStatus("ready");
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      status,
      error,
      role: sessionRole(session),
      refresh,
      signOut,
    }),
    [error, refresh, session, signOut, status],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useWorkspaceSession() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider.");
  }
  return context;
}

export function sessionRole(session?: WorkspaceSession): WorkspaceRole {
  return session?.membership?.role || session?.context?.role || "viewer";
}

export function canPerform(role: WorkspaceRole, permission: WorkspacePermission) {
  return permissionRoles[permission].includes(role);
}

export function permissionMessage(
  session: WorkspaceSession | undefined,
  status: SessionStatus,
  permission: WorkspacePermission,
) {
  if (status === "loading") {
    return "Checking your workspace permissions.";
  }
  if (status === "error" || !session) {
    return "Permissions could not be verified. Refresh the page and try again.";
  }
  if (session.authEnabled && !session.authenticated) {
    return "Sign in to use this control.";
  }
  const role = sessionRole(session);
  if (canPerform(role, permission)) {
    return undefined;
  }
  const required =
    permission === "manage.connector" ||
    permission === "read.security" ||
    permission === "manage.identity"
      ? "admin"
      : permission === "read"
        ? "viewer"
        : "operator";
  return `Your ${role} role is read-only here. A ${required} role is required.`;
}
