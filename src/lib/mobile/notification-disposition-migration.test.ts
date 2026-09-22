import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("notification disposition migration v200", () => {
  it("installs forced actor RLS and content-free immutable disposition ledgers", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260922163000_notification_disposition_runtime.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("VALUES (\n  200,\n  'notification_disposition_runtime_v1'");
    expect(migration).toContain("name = 'scheduled_workflow_policy_lease_v1'");
    expect(migration).toContain("checksum = '56d69404165e70123c590cf1637985db06de55889e4de64e28523b92885ca093'");
    expect(migration).not.toContain("__V199_");
    expect(migration).toContain("CREATE TABLE public.omni_notification_dispositions");
    expect(migration).toContain("CREATE TABLE public.omni_notification_digest_deliveries");
    expect(migration).toContain("CREATE TABLE public.omni_notification_digest_watermarks");
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(migration.match(/AS RESTRICTIVE FOR ALL TO PUBLIC/g)).toHaveLength(3);
    expect(migration).toContain("public.omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("Notification dispositions cannot be removed");
    expect(migration).toContain("Notification digest deliveries are immutable");
    expect(migration).toContain("Retryable notification cannot be reconsidered before it is due");
    expect(migration).toContain("outcome = 'send' AND state = 'pending'");
    expect(migration).toContain("CHECK (NOT content_included)");
    expect(migration).toContain("CHECK (NOT decision_grants_authority)");
    expect(migration).toContain("omni_mobile_push_deliveries_cause_kind_check_v3");
    expect(migration).toContain("'notification', 'canary'");

    const dispositionTable = migration.slice(
      migration.indexOf("CREATE TABLE public.omni_notification_dispositions"),
      migration.indexOf("CREATE TABLE public.omni_notification_digest_watermarks"),
    );
    expect(dispositionTable).not.toMatch(/\b(title|message|body|payload|model_output)\b\s+/i);
  });
});
