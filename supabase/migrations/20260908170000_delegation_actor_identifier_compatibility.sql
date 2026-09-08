BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
BEGIN
  IF (
    SELECT count(*) FROM omni_schema_version
    WHERE version = 148
      AND name = 'personal_context_consent_v1'
      AND checksum =
        'e41c0aa8ef3d49aa2b29da415d2ca37d4d1eeef3d36fe338cb1fffa2a6a48e0d'
  ) <> 1 THEN
    RAISE EXCEPTION 'Delegation actor compatibility predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM omni_schema_version WHERE version = 149) THEN
    RAISE EXCEPTION 'Migration 149 is already recorded'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM omni_delegation_tasks task
    LEFT JOIN omni_auth_user_actor_identifiers identifier
      ON identifier.actor_identifier = task.owner_actor_id
    WHERE identifier.actor_identifier IS NULL
  ) THEN
    RAISE EXCEPTION 'A delegation task owner is not a registered auth-user actor identifier'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE omni_delegation_tasks
DROP CONSTRAINT IF EXISTS omni_delegation_tasks_owner_actor_id_fkey;

ALTER TABLE omni_delegation_tasks
ADD CONSTRAINT omni_delegation_tasks_owner_actor_identifier_fkey
FOREIGN KEY (owner_actor_id)
REFERENCES omni_auth_user_actor_identifiers (actor_identifier)
ON UPDATE RESTRICT ON DELETE RESTRICT;

DO $migration$
DECLARE
  owner_column SMALLINT;
BEGIN
  SELECT attnum
  INTO STRICT owner_column
  FROM pg_attribute
  WHERE attrelid = 'omni_delegation_tasks'::regclass
    AND attname = 'owner_actor_id'
    AND NOT attisdropped;

  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'omni_delegation_tasks'::regclass
      AND conname = 'omni_delegation_tasks_owner_actor_identifier_fkey'
      AND contype = 'f'
      AND confrelid = 'omni_auth_user_actor_identifiers'::regclass
      AND conkey = ARRAY[owner_column]
      AND confkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'omni_auth_user_actor_identifiers'::regclass
            AND attname = 'actor_identifier'
            AND NOT attisdropped
        )::SMALLINT
      ]
      AND convalidated
  ) <> 1 THEN
    RAISE EXCEPTION 'Delegation actor identifier foreign key is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

INSERT INTO omni_schema_version (version, name, checksum, applied_at)
VALUES (
  149,
  'delegation_actor_identifier_compatibility_v1',
  'e23652ba4ff4fb4598d3671175e36d8a4a2974af839031477033d9924bc03810',
  clock_timestamp()
);

COMMIT;
