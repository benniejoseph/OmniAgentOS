import { afterEach, describe, expect, it, vi } from "vitest";
import { builderGithubWorkspaceAuthorized, getProjectGithubStatus, requireBuilderGithubWorkspace } from "./github-access";

afterEach(() => vi.unstubAllEnvs());

describe("Private Builder GitHub connection ownership", () => {
  it("binds the deployment installation to its owner workspace, not another signed-in account", () => {
    vi.stubEnv("OMNIAGENT_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv("OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON", JSON.stringify([
      { email: "owner@example.test", tenantId: "owner-space", tenantName: "Owner", tenantMode: "existing", label: "Owner", role: "admin" },
      { email: "second@example.test", tenantId: "second-space", tenantName: "Second", tenantMode: "new", label: "Second", role: "admin" },
    ]));
    expect(builderGithubWorkspaceAuthorized("owner-space")).toBe(true);
    expect(builderGithubWorkspaceAuthorized("second-space")).toBe(false);
    expect(() => requireBuilderGithubWorkspace("second-space")).toThrow(/connected workspace only/);
    expect(getProjectGithubStatus("second-space")).toEqual({ configured: false, missing: ["A GitHub connection for this workspace"] });
  });
  it("retains the existing single-owner tenant mapping", () => {
    vi.stubEnv("OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON", "");
    vi.stubEnv("OMNIAGENT_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv("OMNIAGENT_DEFAULT_TENANT", "default");
    expect(builderGithubWorkspaceAuthorized("default")).toBe(true);
    expect(builderGithubWorkspaceAuthorized("foreign")).toBe(false);
  });
});
