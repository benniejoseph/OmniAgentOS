import "server-only";

import { privateAccountPolicyForEmail } from "@/lib/auth/private-account-policy";
import { getBuilderGithubStatus } from "@/lib/app-builder/github";
import type { AppBuilderGithubStatus } from "@/lib/app-builder/contracts";

/** The deployment's private GitHub App belongs to its owner's workspace.
 * Project/session stores separately enforce the requesting actor. Adding a
 * second private Asael account must never share this installation's grants. */
export function builderGithubWorkspaceAuthorized(tenantId: string) {
  const email = (process.env.OMNIAGENT_OWNER_EMAIL || process.env.OWNER_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL || "").trim();
  return Boolean(email && privateAccountPolicyForEmail(email)?.tenantId === tenantId);
}

export function getProjectGithubStatus(tenantId: string): AppBuilderGithubStatus {
  return builderGithubWorkspaceAuthorized(tenantId)
    ? getBuilderGithubStatus()
    : { configured: false, missing: ["A GitHub connection for this workspace"] };
}

export function requireBuilderGithubWorkspace(tenantId: string) {
  if (!builderGithubWorkspaceAuthorized(tenantId)) {
    throw new Error("This workspace does not have a GitHub connection. Repository access belongs to the connected workspace only.");
  }
}
