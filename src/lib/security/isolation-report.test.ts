import { describe, expect, it } from "vitest";
import {
  migrationScopedTenantTables,
  tenantIsolationExemptTables,
  tenantPolicyTables,
} from "@/lib/db/client";
import {
  expectedTenantIsolationPolicyName,
  hasExpectedTenantIsolationPolicy,
  unclassifiedTenantIsolationTables,
} from "@/lib/security/isolation-report";

type Policy = Parameters<typeof hasExpectedTenantIsolationPolicy>[1][number];

function policy(
  tableName: string,
  policyName: string,
  { permissive = true, command = "*" }: { permissive?: boolean; command?: string } = {},
): Policy {
  return { tableName, policyName, permissive, command };
}

describe("tenant isolation policy evidence", () => {
  it("recognizes the policy contracts used by tenant and actor-scoped tables", () => {
    expect(expectedTenantIsolationPolicyName("omni_memories"))
      .toBe("omni_tenant_isolation");
    expect(expectedTenantIsolationPolicyName("omni_browser_profiles"))
      .toBe("omni_tenant_isolation");
    expect(expectedTenantIsolationPolicyName("omni_mobile_push_deliveries"))
      .toBe("omni_mobile_push_deliveries_actor");
    expect(expectedTenantIsolationPolicyName("omni_ap2_reconciliation_jobs"))
      .toBe("omni_ap2_reconciliation_jobs_actor");
    expect(expectedTenantIsolationPolicyName("omni_personal_context_consents"))
      .toBe("omni_personal_context_consents_actor_scope");
    expect(expectedTenantIsolationPolicyName("omni_app_builder_sessions"))
      .toBe("omni_app_builder_sessions_actor_scope");
    expect(expectedTenantIsolationPolicyName("omni_market_backtest_events"))
      .toBe("omni_market_backtest_events_actor_scope");
    expect(expectedTenantIsolationPolicyName("omni_local_computer_devices"))
      .toBe("omni_local_computer_devices_actor_scope");
    expect(expectedTenantIsolationPolicyName("omni_market_forward_forecasts"))
      .toBe("omni_market_forward_forecasts_actor_scope");
    expect(expectedTenantIsolationPolicyName("omni_notification_dispositions"))
      .toBe("omni_tenant_isolation");
  });

  it("requires the expected policy to be the only permissive one, covering all operations", () => {
    const tableName = "omni_mobile_push_deliveries";
    const actor = "omni_mobile_push_deliveries_actor";

    expect(hasExpectedTenantIsolationPolicy(tableName, [policy(tableName, actor)])).toBe(true);
    // A restrictive policy only narrows what the permissive one admits, and
    // another table's policies do not count.
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, actor),
      policy(tableName, "omni_mobile_push_deliveries_state", { permissive: false }),
      policy("omni_memories", "omni_tenant_isolation"),
    ])).toBe(true);

    // A tenant-wide policy beside the actor policy admits every actor's rows.
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, actor),
      policy(tableName, "omni_tenant_isolation"),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, actor),
      policy(tableName, "omni_mobile_push_deliveries_reader", { command: "r" }),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_tenant_isolation"),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, actor, { permissive: false }),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, actor, { command: "r" }),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy("omni_mobile_push_registrations", actor),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [])).toBe(false);
  });

  it("requires an actor-scope policy alone on the actor-scope tables", () => {
    const tableName = "omni_app_builder_sessions";

    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_app_builder_sessions_actor_scope"),
    ])).toBe(true);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_app_builder_sessions_actor_scope"),
      policy(tableName, "omni_tenant_isolation"),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_app_builder_sessions_actor"),
    ])).toBe(false);
  });

  it("requires the restrictive actor policy on tables where it narrows the tenant policy", () => {
    const tableName = "omni_browser_profiles";
    const tenant = policy(tableName, "omni_tenant_isolation");
    const actor = policy(tableName, "omni_browser_profiles_actor", { permissive: false });

    expect(hasExpectedTenantIsolationPolicy(tableName, [tenant, actor])).toBe(true);

    expect(hasExpectedTenantIsolationPolicy(tableName, [tenant])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      tenant,
      policy(tableName, "omni_browser_profiles_actor", { permissive: false, command: "r" }),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      tenant,
      policy(tableName, "omni_browser_profiles_owner", { permissive: false }),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      tenant,
      policy("omni_browser_takeovers", "omni_browser_profiles_actor", { permissive: false }),
    ])).toBe(false);
    // As a permissive policy it would widen the tenant policy, not narrow it.
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      tenant,
      policy(tableName, "omni_browser_profiles_actor"),
    ])).toBe(false);
    expect(hasExpectedTenantIsolationPolicy(tableName, [actor])).toBe(false);

    const cycles = "omni_moltbook_autonomy_cycles";
    expect(hasExpectedTenantIsolationPolicy(cycles, [
      policy(cycles, "omni_tenant_isolation"),
      policy(cycles, "omni_moltbook_autonomy_cycles_actor", { permissive: false }),
    ])).toBe(true);
    expect(hasExpectedTenantIsolationPolicy(cycles, [
      policy(cycles, "omni_tenant_isolation"),
    ])).toBe(false);

    // Some tables name their restrictive policy differently.
    const triggers = "omni_workflow_triggers";
    expect(hasExpectedTenantIsolationPolicy(triggers, [
      policy(triggers, "omni_tenant_isolation"),
      policy(triggers, "omni_workflow_triggers_schedule_actor", { permissive: false }),
    ])).toBe(true);
    expect(hasExpectedTenantIsolationPolicy(triggers, [
      policy(triggers, "omni_tenant_isolation"),
      policy(triggers, "omni_workflow_triggers_actor", { permissive: false }),
    ])).toBe(false);
  });

  it("accepts the tenant policy alone, or narrowed by restrictive policies, on tenant tables", () => {
    const tableName = "omni_memories";

    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_tenant_isolation"),
    ])).toBe(true);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_tenant_isolation"),
      policy(tableName, "omni_memories_private_scope", { permissive: false }),
    ])).toBe(true);
    expect(hasExpectedTenantIsolationPolicy(tableName, [
      policy(tableName, "omni_tenant_isolation", { command: "w" }),
    ])).toBe(false);
  });
});

describe("tenant isolation table classes", () => {
  it("puts each table in one class and gives each exemption its reason", () => {
    const tenant = new Set<string>(tenantPolicyTables);
    const scoped = new Set<string>(migrationScopedTenantTables);
    const exempt = Object.keys(tenantIsolationExemptTables);

    expect(tenant.size).toBe(tenantPolicyTables.length);
    expect(scoped.size).toBe(migrationScopedTenantTables.length);
    expect([...scoped].filter((tableName) => tenant.has(tableName))).toEqual([]);
    expect(exempt.filter((tableName) => tenant.has(tableName) || scoped.has(tableName)))
      .toEqual([]);
    expect(Object.values(tenantIsolationExemptTables).every((reason) => reason.trim()))
      .toBe(true);
  });

  it("names the tables that no class covers", () => {
    expect(unclassifiedTenantIsolationTables([
      "omni_memories",
      "omni_project_tasks",
      "omni_local_computer_sessions",
      "omni_moltbook_autonomy_events",
      "omni_schema_version",
      "omni_rate_limits",
      "omni_unclassified_notes",
      "omni_another_new_table",
      "omni_unclassified_notes",
    ])).toEqual(["omni_another_new_table", "omni_unclassified_notes"]);
    expect(unclassifiedTenantIsolationTables([])).toEqual([]);
  });
});
