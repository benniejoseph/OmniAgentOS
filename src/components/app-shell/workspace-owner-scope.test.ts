import { describe, expect, it } from "vitest";
import type { WorkspaceSession } from "@/components/app-shell/session-context";
import { workspaceOwnerScope } from "./workspace-owner-scope";

const session: WorkspaceSession = {
  authEnabled: true, authenticated: true,
  context: { tenantId: "tenant-a", actorId: "owner@example.test", role: "operator" },
  user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" },
};
describe("Builder presentation ownership", () => {
  it("isolates re-created accounts even when the request email is reused", () => {
    const oldOwner = workspaceOwnerScope(session, "operator", "deployment-a");
    expect(oldOwner).not.toBe("");
    expect(workspaceOwnerScope({ ...session, user: { ...session.user, id: "22222222-2222-4222-8222-222222222222" } }, "operator", "deployment-a")).not.toBe(oldOwner);
  });
  it("isolates tenant, role and deployment changes", () => {
    const initial = workspaceOwnerScope(session, "operator", "deployment-a");
    expect(workspaceOwnerScope(session, "viewer", "deployment-a")).not.toBe(initial);
    expect(workspaceOwnerScope(session, "operator", "deployment-b")).not.toBe(initial);
    expect(workspaceOwnerScope({ ...session, context: { ...session.context, tenantId: "tenant-b" } }, "operator", "deployment-a")).not.toBe(initial);
  });
  it("does not derive ownership from anonymous, missing or mismatched session identity", () => {
    for (const value of [undefined, { ...session, authenticated: false }, { ...session, user: undefined },
      { ...session, context: { ...session.context, actorId: "other@example.test" } },
      { ...session, user: { ...session.user, id: "not-a-canonical-user" } }]) {
      expect(workspaceOwnerScope(value, "operator", "deployment-a")).toBe("");
    }
  });
  it("preserves the same identity across an equivalent refreshed session", () => {
    expect(workspaceOwnerScope(structuredClone(session), "operator", "deployment-a"))
      .toBe(workspaceOwnerScope(session, "operator", "deployment-a"));
  });
});
