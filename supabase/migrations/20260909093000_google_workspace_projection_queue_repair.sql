BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 149
      AND name = 'delegation_actor_identifier_compatibility_v1'
      AND checksum =
        'e23652ba4ff4fb4598d3671175e36d8a4a2974af839031477033d9924bc03810'
  ) <> 1 THEN
    RAISE EXCEPTION 'Relation projection queue policy repair predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM omni_schema_version WHERE version = 150) THEN
    RAISE EXCEPTION 'Migration 150 is already recorded'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_entity_relation_projection_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE omni_entity_relation_projection_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS omni_entity_relation_projection_queue_actor
  ON omni_entity_relation_projection_queue;
CREATE POLICY omni_entity_relation_projection_queue_actor
ON omni_entity_relation_projection_queue AS PERMISSIVE FOR ALL
USING (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
)
WITH CHECK (
  omni_system_scope_enabled()
  OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'omni_entity_relation_projection_queue'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'omni_entity_relation_projection_queue'::regclass
  ) <> 5 OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'omni_entity_relation_projection_queue'::regclass
      AND polname = 'omni_entity_relation_projection_queue_actor'
      AND polpermissive
      AND polcmd = '*'
  ) OR (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'omni_entity_relation_projection_queue'::regclass
      AND NOT polpermissive
  ) <> 4 THEN
    RAISE EXCEPTION 'Relation projection queue actor policy boundary is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  150,
  'entity_relation_projection_queue_actor_policy_repair_v1',
  '0635323de69b0bd7b2c1c520dd27f7271a4833abd6ce7263e120bb1d69984122',
  clock_timestamp()
);

COMMIT;
