import { describe, expect, it } from "vitest";
import {
  canPerform,
  permissionMessage,
  type WorkspaceSession,
} from "@/components/app-shell/session-context";

describe("workspace permission presentation", () => {
  it("keeps viewers away from mutation controls", () => {
    expect(canPerform("viewer", "read")).toBe(true);
    expect(canPerform("viewer", "run.agent")).toBe(false);
    expect(canPerform("viewer", "manage.workflow")).toBe(false);
  });

  it("does not ask users to sign in when auth is disabled", () => {
    const session: WorkspaceSession = {
      authEnabled: false,
      authenticated: false,
      context: { role: "operator" },
    };

    expect(permissionMessage(session, "ready", "run.agent")).toBeUndefined();
  });

  it("explains signed-out and role-limited controls", () => {
    expect(
      permissionMessage(
        { authEnabled: true, authenticated: false },
        "ready",
        "run.agent",
      ),
    ).toContain("Sign in");
    expect(
      permissionMessage(
        {
          authEnabled: true,
          authenticated: true,
          membership: { role: "viewer" },
        },
        "ready",
        "run.agent",
      ),
    ).toContain("viewer role");
  });
});
