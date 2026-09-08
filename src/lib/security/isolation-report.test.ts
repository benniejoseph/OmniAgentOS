import { describe, expect, it } from "vitest";
import {
  expectedTenantIsolationPolicyName,
  hasExpectedTenantIsolationPolicy,
} from "@/lib/security/isolation-report";

describe("tenant isolation policy evidence", () => {
  it("recognizes the policy contracts used by tenant and actor-scoped tables", () => {
    expect(expectedTenantIsolationPolicyName("omni_memories"))
      .toBe("omni_tenant_isolation");
    expect(expectedTenantIsolationPolicyName("omni_browser_profiles"))
      .toBe("omni_browser_profiles_actor");
    expect(expectedTenantIsolationPolicyName("omni_mobile_push_deliveries"))
      .toBe("omni_mobile_push_deliveries_actor");
    expect(expectedTenantIsolationPolicyName("omni_personal_context_consents"))
      .toBe("omni_personal_context_consents_actor_scope");
  });

  it("requires the exact permissive policy covering all operations", () => {
    const tableName = "omni_browser_profiles";

    expect(hasExpectedTenantIsolationPolicy(tableName, [{
      tableName,
      policyName: "omni_browser_profiles_actor",
      permissive: true,
      command: "*",
    }])).toBe(true);

    expect(hasExpectedTenantIsolationPolicy(tableName, [{
      tableName,
      policyName: "omni_tenant_isolation",
      permissive: true,
      command: "*",
    }])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [{
      tableName,
      policyName: "omni_browser_profiles_actor",
      permissive: false,
      command: "*",
    }])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [{
      tableName,
      policyName: "omni_browser_profiles_actor",
      permissive: true,
      command: "r",
    }])).toBe(false);
  });
});
