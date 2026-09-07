BEGIN;

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 123
      AND name = 'actor_rls_policy_repair_v1'
      AND checksum = 'd5dfb0fb60b28c8d8c317ae8c13d9e9000cfa408ae2124dd7d62e7af538bebcd'
  ) <> 1 THEN
    RAISE EXCEPTION 'Governed communications predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS omni_person_contact_policies (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  address_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, policy_id),
  UNIQUE (tenant_id, owner_actor_id, channel, address_sha256),
  CHECK (policy_id ~ '^contact_policy:[0-9a-f-]{36}$'),
  CHECK (channel IN ('email', 'message', 'voice')),
  CHECK (address_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (status IN ('active', 'paused', 'opted_out')),
  CHECK (lifecycle_revision >= 1),
  CHECK (policy ->> 'id' = policy_id),
  CHECK (policy ->> 'tenantId' = tenant_id),
  CHECK (policy ->> 'ownerActorId' = owner_actor_id),
  CHECK (policy ->> 'channel' = channel),
  CHECK (policy ->> 'status' = status),
  CHECK ((policy ->> 'lifecycleRevision')::INTEGER = lifecycle_revision)
);

CREATE TABLE IF NOT EXISTS omni_communication_intents (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  intent JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, intent_id),
  UNIQUE (tenant_id, owner_actor_id, intent_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, policy_id)
    REFERENCES omni_person_contact_policies (tenant_id, owner_actor_id, policy_id),
  CHECK (intent_id ~ '^communication_intent:[0-9a-f-]{36}$'),
  CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (intent ->> 'id' = intent_id),
  CHECK (intent ->> 'policyId' = policy_id)
);

CREATE TABLE IF NOT EXISTS omni_message_drafts (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_sha256 TEXT NOT NULL,
  draft_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  draft JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, draft_id),
  UNIQUE (tenant_id, owner_actor_id, draft_sha256),
  FOREIGN KEY (tenant_id, owner_actor_id, intent_id)
    REFERENCES omni_communication_intents (tenant_id, owner_actor_id, intent_id),
  FOREIGN KEY (tenant_id, owner_actor_id, policy_id)
    REFERENCES omni_person_contact_policies (tenant_id, owner_actor_id, policy_id),
  CHECK (draft_id ~ '^message_draft:[0-9a-f-]{36}$'),
  CHECK (channel IN ('email', 'message', 'voice')),
  CHECK (recipient_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (draft_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state IN ('ready', 'delivering', 'delivered', 'failed', 'canceled')),
  CHECK (lifecycle_revision >= 1),
  CHECK (draft ->> 'id' = draft_id),
  CHECK (draft ->> 'intentId' = intent_id),
  CHECK (draft ->> 'policyId' = policy_id),
  CHECK (draft ->> 'channel' = channel),
  CHECK (draft ->> 'state' = state),
  CHECK ((draft ->> 'lifecycleRevision')::INTEGER = lifecycle_revision),
  CHECK (draft ->> 'draftSha256' = draft_sha256)
);

CREATE TABLE IF NOT EXISTS omni_delivery_receipts (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  receipt JSONB NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, owner_actor_id, receipt_id),
  UNIQUE (tenant_id, owner_actor_id, draft_id),
  UNIQUE (tenant_id, owner_actor_id, provider, provider_message_id),
  FOREIGN KEY (tenant_id, owner_actor_id, draft_id)
    REFERENCES omni_message_drafts (tenant_id, owner_actor_id, draft_id),
  CHECK (receipt_id ~ '^delivery_receipt:[0-9a-f-]{36}$'),
  CHECK (provider = 'gmail'),
  CHECK (char_length(provider_message_id) BETWEEN 1 AND 500),
  CHECK (char_length(external_thread_id) BETWEEN 1 AND 500),
  CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (receipt ->> 'id' = receipt_id),
  CHECK (receipt ->> 'draftId' = draft_id),
  CHECK (receipt ->> 'provider' = provider),
  CHECK (receipt ->> 'receiptSha256' = receipt_sha256)
);

CREATE TABLE IF NOT EXISTS omni_conversation_links (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  canonical_thread_id TEXT,
  project_id TEXT,
  mission_id TEXT,
  run_id TEXT,
  link JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, link_id),
  UNIQUE (tenant_id, owner_actor_id, channel, external_thread_id),
  CHECK (link_id ~ '^conversation_link:[0-9a-f-]{36}$'),
  CHECK (channel IN ('email', 'message', 'voice')),
  CHECK (char_length(external_thread_id) BETWEEN 1 AND 500),
  CHECK (link ->> 'id' = link_id),
  CHECK (link ->> 'channel' = channel),
  CHECK (link ->> 'externalThreadId' = external_thread_id)
);

CREATE TABLE IF NOT EXISTS omni_inbound_communications (
  tenant_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  envelope JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, owner_actor_id, inbound_id),
  UNIQUE (tenant_id, owner_actor_id, provider, provider_message_id),
  FOREIGN KEY (tenant_id, owner_actor_id, link_id)
    REFERENCES omni_conversation_links (tenant_id, owner_actor_id, link_id),
  CHECK (inbound_id ~ '^inbound_communication:[0-9a-f-]{36}$'),
  CHECK (provider = 'gmail'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (envelope ->> 'id' = inbound_id),
  CHECK (envelope ->> 'provider' = provider),
  CHECK (envelope ->> 'linkId' = link_id),
  CHECK (envelope ->> 'contentSha256' = content_sha256)
);

CREATE INDEX IF NOT EXISTS omni_contact_policies_owner_status_idx
  ON omni_person_contact_policies (tenant_id, owner_actor_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS omni_message_drafts_owner_state_idx
  ON omni_message_drafts (tenant_id, owner_actor_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS omni_delivery_receipts_thread_idx
  ON omni_delivery_receipts (tenant_id, owner_actor_id, external_thread_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS omni_inbound_communications_thread_idx
  ON omni_inbound_communications (tenant_id, owner_actor_id, external_thread_id, received_at DESC);

CREATE OR REPLACE FUNCTION omni_protect_governed_communications_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Governed communication records are lifecycle controlled'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME IN (
      'omni_communication_intents', 'omni_delivery_receipts',
      'omni_conversation_links', 'omni_inbound_communications'
    ) THEN
      RAISE EXCEPTION 'Governed communication record is append-only'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR
       NEW.owner_actor_id <> OLD.owner_actor_id THEN
      RAISE EXCEPTION 'Governed communication owner is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_person_contact_policies' AND (
      NEW.policy_id <> OLD.policy_id OR NEW.channel <> OLD.channel OR
      NEW.address_sha256 <> OLD.address_sha256 OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    ) THEN
      RAISE EXCEPTION 'Contact policy lifecycle update is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'omni_message_drafts' AND (
      NEW.draft_id <> OLD.draft_id OR NEW.intent_id <> OLD.intent_id OR
      NEW.policy_id <> OLD.policy_id OR NEW.channel <> OLD.channel OR
      NEW.recipient_sha256 <> OLD.recipient_sha256 OR
      NEW.draft_sha256 <> OLD.draft_sha256 OR
      NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 OR
      NOT (
        (OLD.state = 'ready' AND NEW.state = 'delivering') OR
        (OLD.state = 'delivering' AND NEW.state IN ('delivered', 'failed')) OR
        (OLD.state = 'failed' AND NEW.state = 'delivering')
      )
    ) THEN
      RAISE EXCEPTION 'Message draft lifecycle update is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DO $migration$
DECLARE
  table_name TEXT;
  policy_name TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'omni_person_contact_policies', 'omni_communication_intents',
    'omni_message_drafts', 'omni_delivery_receipts',
    'omni_conversation_links', 'omni_inbound_communications'
  ];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_protect', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION omni_protect_governed_communications_v1()',
      table_name || '_protect', table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_governed_communications_v1()',
      table_name || '_no_truncate', table_name
    );
    FOR policy_name IN
      SELECT policy.polname FROM pg_policy policy
      WHERE policy.polrelid = to_regclass(table_name)
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, table_name);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) WITH CHECK (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
      table_name || '_actor', table_name
    );
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE omni_person_contact_policies FROM PUBLIC;
REVOKE ALL ON TABLE omni_communication_intents FROM PUBLIC;
REVOKE ALL ON TABLE omni_message_drafts FROM PUBLIC;
REVOKE ALL ON TABLE omni_delivery_receipts FROM PUBLIC;
REVOKE ALL ON TABLE omni_conversation_links FROM PUBLIC;
REVOKE ALL ON TABLE omni_inbound_communications FROM PUBLIC;
REVOKE ALL ON FUNCTION omni_protect_governed_communications_v1() FROM PUBLIC;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE omni_person_contact_policies, omni_communication_intents,
      omni_message_drafts, omni_delivery_receipts, omni_conversation_links,
      omni_inbound_communications FROM omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_person_contact_policies TO omni_runtime;
    GRANT SELECT, INSERT, UPDATE ON omni_message_drafts TO omni_runtime;
    GRANT SELECT, INSERT ON omni_communication_intents, omni_delivery_receipts,
      omni_conversation_links, omni_inbound_communications TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE omni_person_contact_policies, omni_communication_intents,
      omni_message_drafts, omni_delivery_receipts, omni_conversation_links,
      omni_inbound_communications FROM omni_maintenance;
    GRANT SELECT ON TABLE omni_person_contact_policies, omni_communication_intents,
      omni_message_drafts, omni_delivery_receipts, omni_conversation_links,
      omni_inbound_communications TO omni_maintenance;
  END IF;
END
$migration$;

DO $migration$
DECLARE expected_tables CONSTANT TEXT[] := ARRAY[
  'omni_person_contact_policies', 'omni_communication_intents',
  'omni_message_drafts', 'omni_delivery_receipts',
  'omni_conversation_links', 'omni_inbound_communications'
];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
      AND policy.polname = relation.relname || '_actor'
      AND policy.polpermissive
      AND policy.polcmd = '*'
  ) <> cardinality(expected_tables) OR (
    SELECT count(*)
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ANY(expected_tables)
  ) <> cardinality(expected_tables) THEN
    RAISE EXCEPTION 'Communication actor policy boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  124,
  'governed_communications_v1',
  'b0199382bc9ed5a5fe99357b3deec7b0b3ed9de8921e89ed6705062b8e2b862f',
  NOW()
);

COMMIT;
