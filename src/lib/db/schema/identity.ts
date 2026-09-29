import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for identity: canonical actor ids, membership
// epochs and authorities, execution principals and workspace membership.

export async function ensureCanonicalAuthUserActorIdsShadow(sql: SqlClient) {
  // A browser/mobile actor is still the historical email-shaped owner key.
  // Add a stable, non-email pseudonymous identity without changing any served
  // context, ownership query, ciphertext AAD, durable scope, or receipt.
  await sql`
    DO $migration$
    DECLARE
      actor_attribute RECORD;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE id !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR NOT public.omni_source_contract_id_is_valid('actor:' || id)
      ) THEN
        RAISE EXCEPTION 'An auth-user ID is not an opaque canonical UUID'
          USING ERRCODE = '55000';
      END IF;

      SELECT
        attribute.atttypid,
        attribute.attgenerated,
        pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
          AS generation_expression
      INTO actor_attribute
      FROM pg_attribute attribute
      LEFT JOIN pg_attrdef attribute_default
        ON attribute_default.adrelid = attribute.attrelid
        AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = 'omni_auth_users'::regclass
        AND attribute.attname = 'actor_id'
        AND NOT attribute.attisdropped;

      IF FOUND AND (
        actor_attribute.atttypid <> 'text'::regtype
        OR actor_attribute.attgenerated <> 's'
        OR actor_attribute.generation_expression
          IS DISTINCT FROM '(''actor:''::text || id)'
      ) THEN
        RAISE EXCEPTION 'Existing auth-user actor identity column is incompatible'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    ADD COLUMN IF NOT EXISTS actor_id TEXT
      GENERATED ALWAYS AS ('actor:'::TEXT || id) STORED
  `;
  await sql`
    ALTER TABLE omni_auth_users
    ALTER COLUMN actor_id SET NOT NULL
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_id_uuid_check CHECK (
          id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    VALIDATE CONSTRAINT omni_auth_users_id_uuid_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user UUID check is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_actor_id_contract_check CHECK (
          omni_source_contract_id_is_valid(actor_id)
        ) NOT VALID;
      END IF;
    END
    $migration$
  `;
  await sql`
    ALTER TABLE omni_auth_users
    VALIDATE CONSTRAINT omni_auth_users_actor_id_contract_check
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_key'
          AND conrelid = 'omni_auth_users'::regclass
      ) THEN
        ALTER TABLE omni_auth_users
        ADD CONSTRAINT omni_auth_users_actor_id_key UNIQUE (actor_id);
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_auth_user_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Canonical auth-user identity is immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND tgname = 'omni_auth_users_actor_identity_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_users_actor_identity_immutable
        BEFORE UPDATE OF id OR DELETE ON omni_auth_users
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_auth_user_identity_change();
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND tgname = 'omni_auth_users_actor_identity_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_users_actor_identity_no_truncate
        BEFORE TRUNCATE ON omni_auth_users
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_auth_user_identity_change();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_auth_user_identity_change()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE DELETE, TRUNCATE
    ON TABLE omni_auth_users
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_auth_user_identity_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE DELETE, TRUNCATE ON TABLE %I.omni_auth_users FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // v46 must create identity only. It neither maps a legacy owner nor makes
  // the still-denying memory authorization hook reachable.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity column is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity check is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname = 'omni_auth_users_actor_id_key'
          AND constraint_record.conrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity uniqueness is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
          OR NOT public.omni_source_contract_id_is_valid(actor_id)
      ) OR (
        SELECT count(*) FROM omni_auth_users
      ) IS DISTINCT FROM (
        SELECT count(DISTINCT actor_id) FROM omni_auth_users
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity mapping is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = (
            SELECT attnum::TEXT
            FROM pg_attribute
            WHERE attrelid = 'omni_auth_users'::regclass
              AND attname = 'id'
              AND NOT attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
        )
          AND prorettype = 'trigger'::regtype
          AND provolatile = 'v'
          AND NOT prosecdef
          AND proconfig @> ARRAY['search_path=pg_catalog, public']
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function is exposed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identities remain removable'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_auth_memberships membership
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = membership.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_sessions session_record
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = session_record.user_id
        WHERE auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_mobile_sessions mobile_session
        LEFT JOIN omni_auth_users auth_user ON auth_user.id = mobile_session.user_id
        WHERE auth_user.id IS NULL
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity has orphaned references'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_auth_users'::regclass
          AND (relrowsecurity OR relforcerowsecurity)
      ) THEN
        RAISE EXCEPTION 'Auth users cannot require tenant scope before login'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:actor_identity_check',
        'initiatingActorId', 'actor:actor_identity_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:actor_identity_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory:actor_identity_check',
        'purpose', 'Canonical actor identity self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig @> ARRAY['search_path=pg_catalog, public']
          AND language.lanname = 'sql'
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook metadata changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook has serving grants'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant authorization hook'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid)
            = '(access_contract_version = 0)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory access forced RLS boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND polqual IS NOT NULL
          AND polwithcheck IS NOT NULL
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access restrictive holdback changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantActorMembershipEpochsShadow(sql: SqlClient) {
  // v54 is an empty authorization foundation. Existing memberships remain
  // authoritative; this migration neither derives epochs from them nor gives
  // a runtime role a reader or writer for the shadow contract.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Membership epoch migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  // Hold the current auth identity and membership data stable across both
  // audits. No row is copied into the epoch shadow and no live auth relation
  // is altered, granted, revoked, or given a trigger by this migration.
  await sql`
    LOCK TABLE
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships
    IN SHARE MODE
  `;

  const verifyCurrentAuthMembershipBoundary = async () => {
    await sql`
      DO $migration$
      BEGIN
      IF (
        SELECT count(*)
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid IN (
            'omni_auth_tenants'::regclass,
            'omni_auth_users'::regclass,
            'omni_auth_memberships'::regclass
          )
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Membership epoch auth relations are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_auth_users_actor_id_contract_check'
          AND constraint_record.conrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname = 'omni_auth_users_actor_id_key'
          AND constraint_record.conrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) THEN
        RAISE EXCEPTION 'Membership epoch actor identity contract is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              AS names,
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              FILTER (WHERE attribute.attnotnull) AS not_null_names,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'omni_auth_memberships'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'id', 'tenant_id', 'user_id', 'role', 'status',
            'created_at', 'updated_at'
          ]::TEXT[]
          AND columns.not_null_names = columns.names
          AND columns.none_generated
          AND columns.column_count = 7
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('id', 'text'::REGTYPE),
            ('tenant_id', 'text'::REGTYPE),
            ('user_id', 'text'::REGTYPE),
            ('role', 'text'::REGTYPE),
            ('status', 'text'::REGTYPE),
            ('created_at', 'timestamp with time zone'::REGTYPE),
            ('updated_at', 'timestamp with time zone'::REGTYPE)
        ) expected(column_name, type_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = 'omni_auth_memberships'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
      ) THEN
        RAISE EXCEPTION 'Membership epoch auth membership columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname = 'omni_auth_memberships_pkey'
          AND constraint_record.conrelid =
            'omni_auth_memberships'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_auth_memberships_tenant_id_fkey',
              'tenant_id',
              'omni_auth_tenants'::REGCLASS,
              'id'
            ),
            (
              'omni_auth_memberships_user_id_fkey',
              'user_id',
              'omni_auth_users'::REGCLASS,
              'id'
            )
        ) expected(
          constraint_name,
          local_column,
          foreign_relation,
          foreign_column
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname = expected.constraint_name
            AND constraint_record.conrelid =
              'omni_auth_memberships'::regclass
            AND constraint_record.contype = 'f'
            AND constraint_record.convalidated
            AND constraint_record.confrelid = expected.foreign_relation
            AND constraint_record.confupdtype = 'a'
            AND constraint_record.confdeltype = 'c'
            AND constraint_record.confmatchtype = 's'
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum
                FROM pg_attribute
                WHERE attrelid = 'omni_auth_memberships'::regclass
                  AND attname = expected.local_column
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND constraint_record.confkey = ARRAY[
              (
                SELECT attnum
                FROM pg_attribute
                WHERE attrelid = expected.foreign_relation
                  AND attname = expected.foreign_column
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
        )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_record.indexrelid =
            'omni_auth_memberships_tenant_user_idx'::regclass
          AND index_record.indrelid = 'omni_auth_memberships'::regclass
          AND index_record.indisunique
          AND NOT index_record.indisprimary
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indislive
          AND index_record.indimmediate
          AND NOT index_record.indisclustered
          AND NOT index_record.indisreplident
          AND NOT index_record.indisexclusion
          AND index_record.indnatts = 2
          AND index_record.indnkeyatts = 2
          AND index_record.indexprs IS NULL
          AND index_record.indpred IS NULL
          AND index_relation.relkind = 'i'
          AND access_method.amname = 'btree'
          AND (
            SELECT array_agg(operator_class ORDER BY ordinal_position)
            FROM unnest(index_record.indclass)
              WITH ORDINALITY AS operator_classes(
                operator_class,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT operator_class.oid
              FROM pg_opclass operator_class
              WHERE operator_class.opcname = 'text_ops'
                AND operator_class.opcnamespace =
                  'pg_catalog'::REGNAMESPACE
                AND operator_class.opcmethod = access_method.oid
            ),
            (
              SELECT operator_class.oid
              FROM pg_opclass operator_class
              WHERE operator_class.opcname = 'text_ops'
                AND operator_class.opcnamespace =
                  'pg_catalog'::REGNAMESPACE
                AND operator_class.opcmethod = access_method.oid
            )
          ]::OID[]
          AND (
            SELECT array_agg(collation_oid ORDER BY ordinal_position)
            FROM unnest(index_record.indcollation)
              WITH ORDINALITY AS collations(
                collation_oid,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'user_id'
                AND NOT attisdropped
            )
          ]::OID[]
          AND (
            SELECT array_agg(index_option ORDER BY ordinal_position)
            FROM unnest(index_record.indoption)
              WITH ORDINALITY AS index_options(
                index_option,
                ordinal_position
              )
          ) = ARRAY[0, 0]::SMALLINT[]
          AND (
            SELECT array_agg(key_attribute ORDER BY ordinal_position)
            FROM unnest(index_record.indkey)
              WITH ORDINALITY AS key_columns(
                key_attribute,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'user_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) THEN
        RAISE EXCEPTION 'Membership epoch auth membership keys are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid = 'omni_auth_memberships'::regclass
      ) <> 1 OR NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_auth_memberships'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_auth_memberships'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_auth_users'::regclass
          AND (relrowsecurity OR relforcerowsecurity)
      ) THEN
        RAISE EXCEPTION 'Membership epoch current auth visibility is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
          OR NOT public.omni_source_contract_id_is_valid(actor_id)
      ) OR (
        SELECT count(*) FROM omni_auth_users
      ) IS DISTINCT FROM (
        SELECT count(DISTINCT actor_id) FROM omni_auth_users
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_memberships membership
        LEFT JOIN omni_auth_tenants tenant
          ON tenant.id = membership.tenant_id
        LEFT JOIN omni_auth_users auth_user
          ON auth_user.id = membership.user_id
        WHERE tenant.id IS NULL OR auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_memberships
        GROUP BY tenant_id, user_id
        HAVING count(*) <> 1
      ) THEN
        RAISE EXCEPTION 'Membership epoch current auth data is invalid'
          USING ERRCODE = '55000';
      END IF;
      END
      $migration$
    `;
  };

  await verifyCurrentAuthMembershipBoundary();

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_membership_epoch_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_subject_actor_id TEXT,
      candidate_membership_epoch BIGINT,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_activated_at TIMESTAMPTZ,
      candidate_revoked_at TIMESTAMPTZ,
      candidate_updated_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_activated_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_activated_by_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_revoked_by_actor_id
          )
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_activated_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_activated_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_created_at <= candidate_activated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_created_at <= candidate_revoked_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at <= candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_actor_membership_epochs (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      subject_actor_id TEXT NOT NULL,
      membership_epoch BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_actor_membership_epochs_pkey
        PRIMARY KEY (tenant_id, subject_actor_id, membership_epoch),
      CONSTRAINT omni_actor_membership_epochs_row_check CHECK (
        omni_actor_membership_epoch_row_is_valid(
          schema_version,
          tenant_id,
          subject_actor_id,
          membership_epoch,
          state,
          lifecycle_revision,
          created_by_actor_id,
          activated_by_actor_id,
          revoked_by_actor_id,
          created_at,
          activated_at,
          revoked_at,
          updated_at
        )
      ),
      CONSTRAINT omni_actor_membership_epochs_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_actor_membership_epochs_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_membership_epochs_subject_actor_fkey
        FOREIGN KEY (subject_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_membership_epochs_created_actor_fkey
        FOREIGN KEY (created_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_membership_epochs_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_membership_epochs_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_actor_membership_epochs_current_idx
    ON omni_tenant_actor_membership_epochs (tenant_id, subject_actor_id)
    WHERE state <> 'revoked'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_actor_membership_epoch_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_epoch BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.subject_actor_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Actor membership epochs must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(epoch.membership_epoch), 0) + 1
      INTO expected_epoch
      FROM public.omni_tenant_actor_membership_epochs epoch
      WHERE epoch.tenant_id = NEW.tenant_id
        AND epoch.subject_actor_id = NEW.subject_actor_id;

      IF NEW.membership_epoch IS DISTINCT FROM expected_epoch THEN
        RAISE EXCEPTION 'Actor membership epoch is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_membership_epochs epoch
        WHERE epoch.tenant_id = NEW.tenant_id
          AND epoch.subject_actor_id = NEW.subject_actor_id
          AND epoch.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Actor already has a current membership epoch'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_actor_membership_epoch()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Actor membership epoch rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.subject_actor_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked actor membership epochs are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.membership_epoch IS DISTINCT FROM OLD.membership_epoch
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Actor membership epoch identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision IS DISTINCT FROM
        OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Actor membership epoch revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Membership epoch activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Membership epoch activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Membership epoch revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Membership epoch revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND tgname = 'omni_actor_membership_epoch_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_membership_epoch_validate_insert
        BEFORE INSERT ON omni_tenant_actor_membership_epochs
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_actor_membership_epoch_insert();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND tgname = 'omni_actor_membership_epoch_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_membership_epoch_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_actor_membership_epochs
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_actor_membership_epoch();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND tgname = 'omni_actor_membership_epoch_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_membership_epoch_no_truncate
        BEFORE TRUNCATE ON omni_tenant_actor_membership_epochs
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_actor_membership_epoch();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_tenant_actor_membership_epochs
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_actor_membership_epoch_row_is_valid(
      SMALLINT,
      TEXT,
      TEXT,
      BIGINT,
      TEXT,
      BIGINT,
      TEXT,
      TEXT,
      TEXT,
      TIMESTAMPTZ,
      TIMESTAMPTZ,
      TIMESTAMPTZ,
      TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_actor_membership_epoch_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_actor_membership_epoch()
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE ' ||
          '%I.omni_tenant_actor_membership_epochs FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE ' ||
          '%I.omni_tenant_actor_membership_epochs FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_membership_epoch_row_is_valid',
            'omni_validate_actor_membership_epoch_insert',
            'omni_protect_actor_membership_epoch'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_actor_membership_epoch_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_actor_membership_epoch_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_actor_membership_epoch() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // This shadow is intentionally owner-only. Apply tenant isolation only to
  // the new relation instead of reconciling every live tenant table.
  await sql`
    ALTER TABLE omni_tenant_actor_membership_epochs
      ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_actor_membership_epochs
      FORCE ROW LEVEL SECURITY
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND polname = 'omni_tenant_isolation'
      ) THEN
        ALTER POLICY omni_tenant_isolation
        ON omni_tenant_actor_membership_epochs
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      ELSE
        CREATE POLICY omni_tenant_isolation
        ON omni_tenant_actor_membership_epochs
        FOR ALL
        TO PUBLIC
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND polname = 'omni_actor_membership_epoch_holdback'
      ) THEN
        CREATE POLICY omni_actor_membership_epoch_holdback
        ON omni_tenant_actor_membership_epochs
        AS RESTRICTIVE
        FOR ALL
        TO PUBLIC
        USING (omni_system_scope_enabled())
        WITH CHECK (omni_system_scope_enabled());
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_tenant_actor_membership_epochs'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch relation is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              AS names,
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              FILTER (WHERE attribute.attnotnull) AS not_null_names,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid =
              'omni_tenant_actor_membership_epochs'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id',
            'membership_epoch', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'activated_by_actor_id',
            'revoked_by_actor_id', 'created_at', 'activated_at',
            'revoked_at', 'updated_at'
          ]::TEXT[]
          AND columns.not_null_names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id',
            'membership_epoch', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'created_at', 'updated_at'
          ]::TEXT[]
          AND columns.none_generated
          AND columns.column_count = 13
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('schema_version', 'smallint'::REGTYPE, 0::OID),
            (
              'tenant_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'subject_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('membership_epoch', 'bigint'::REGTYPE, 0::OID),
            (
              'state',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('lifecycle_revision', 'bigint'::REGTYPE, 0::OID),
            (
              'created_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'activated_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'revoked_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('created_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('activated_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('revoked_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('updated_at', 'timestamp with time zone'::REGTYPE, 0::OID)
        ) expected(column_name, type_oid, collation_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attcollation <> expected.collation_oid
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid = 'omni_tenant_actor_membership_epochs'::regclass
      ) <> 5 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND attribute.attname = 'schema_version'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('1', '1::smallint', '(1)::smallint')
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND attribute.attname = 'state'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '''held''::text'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND attribute.attname = 'lifecycle_revision'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::bigint', '(0)::bigint')
      ) OR (
        SELECT count(*)
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND attribute.attname IN ('created_at', 'updated_at')
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) <> 2 THEN
        RAISE EXCEPTION 'Actor membership epoch defaults are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND contype <> 'n'
      ) <> 8 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE constraint_record.conname =
            'omni_tenant_actor_membership_epochs_pkey'
          AND constraint_record.conrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'subject_actor_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'membership_epoch'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indimmediate
          AND index_record.indnkeyatts = 3
          AND index_record.indnatts = 3
          AND index_record.indexprs IS NULL
          AND index_record.indpred IS NULL
          AND index_relation.relam = (
            SELECT oid
            FROM pg_am
            WHERE amname = 'btree'
          )
          AND (
            SELECT array_agg(
              operator_namespace.nspname || '.' || operator_class.opcname
              ORDER BY key_column.ordinal_position
            )
            FROM unnest(index_record.indclass)
              WITH ORDINALITY AS key_column(
                operator_class_oid,
                ordinal_position
              )
            JOIN pg_opclass operator_class
              ON operator_class.oid = key_column.operator_class_oid
            JOIN pg_namespace operator_namespace
              ON operator_namespace.oid = operator_class.opcnamespace
          ) = ARRAY[
            'pg_catalog.text_ops',
            'pg_catalog.text_ops',
            'pg_catalog.int8_ops'
          ]::TEXT[]
          AND (
            SELECT array_agg(
              collation_oid
              ORDER BY ordinal_position
            )
            FROM unnest(index_record.indcollation)
              WITH ORDINALITY AS key_collation(
                collation_oid,
                ordinal_position
              )
          ) = ARRAY[
            'pg_catalog.default'::REGCOLLATION::OID,
            'pg_catalog.default'::REGCOLLATION::OID,
            0::OID
          ]::OID[]
          AND (
            SELECT array_agg(
              key_option
              ORDER BY ordinal_position
            )
            FROM unnest(index_record.indoption)
              WITH ORDINALITY AS key_options(
                key_option,
                ordinal_position
              )
          ) = ARRAY[0, 0, 0]::SMALLINT[]
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_membership_epochs_row_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.connoinherit
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            'omni_actor_membership_epoch_row_is_valid(schema_version, tenant_id, subject_actor_id, membership_epoch, state, lifecycle_revision, created_by_actor_id, activated_by_actor_id, revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_membership_epochs_activation_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.connoinherit
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = '(state <> ''active''::text)'
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_membership_epochs_tenant_fkey',
              'tenant_id',
              'omni_auth_tenants'::REGCLASS,
              'id'
            ),
            (
              'omni_actor_membership_epochs_subject_actor_fkey',
              'subject_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_membership_epochs_created_actor_fkey',
              'created_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_membership_epochs_activated_actor_fkey',
              'activated_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_membership_epochs_revoked_actor_fkey',
              'revoked_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            )
        ) expected(
          constraint_name,
          local_column,
          foreign_relation,
          foreign_column
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname = expected.constraint_name
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_epochs'::regclass
            AND constraint_record.contype = 'f'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.condeferrable
            AND NOT constraint_record.condeferred
            AND constraint_record.confrelid = expected.foreign_relation
            AND constraint_record.confupdtype = 'r'
            AND constraint_record.confdeltype = 'r'
            AND constraint_record.confmatchtype = 's'
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum
                FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_epochs'::regclass
                  AND attname = expected.local_column
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND constraint_record.confkey = ARRAY[
              (
                SELECT attnum
                FROM pg_attribute
                WHERE attrelid = expected.foreign_relation
                  AND attname = expected.foreign_column
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
        )
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch references are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid = 'omni_tenant_actor_membership_epochs'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_record.indexrelid =
            'omni_actor_membership_epochs_current_idx'::regclass
          AND index_record.indrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND index_record.indisunique
          AND NOT index_record.indisprimary
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indislive
          AND index_record.indimmediate
          AND NOT index_record.indisclustered
          AND NOT index_record.indisreplident
          AND NOT index_record.indisexclusion
          AND index_record.indnatts = 2
          AND index_record.indnkeyatts = 2
          AND index_record.indexprs IS NULL
          AND index_relation.relkind = 'i'
          AND access_method.amname = 'btree'
          AND (
            SELECT array_agg(operator_class ORDER BY ordinal_position)
            FROM unnest(index_record.indclass)
              WITH ORDINALITY AS operator_classes(
                operator_class,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT operator_class.oid
              FROM pg_opclass operator_class
              WHERE operator_class.opcname = 'text_ops'
                AND operator_class.opcnamespace =
                  'pg_catalog'::REGNAMESPACE
                AND operator_class.opcmethod = access_method.oid
            ),
            (
              SELECT operator_class.oid
              FROM pg_opclass operator_class
              WHERE operator_class.opcname = 'text_ops'
                AND operator_class.opcnamespace =
                  'pg_catalog'::REGNAMESPACE
                AND operator_class.opcmethod = access_method.oid
            )
          ]::OID[]
          AND (
            SELECT array_agg(collation_oid ORDER BY ordinal_position)
            FROM unnest(index_record.indcollation)
              WITH ORDINALITY AS collations(
                collation_oid,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'subject_actor_id'
                AND NOT attisdropped
            )
          ]::OID[]
          AND (
            SELECT array_agg(index_option ORDER BY ordinal_position)
            FROM unnest(index_record.indoption)
              WITH ORDINALITY AS index_options(
                index_option,
                ordinal_position
              )
          ) = ARRAY[0, 0]::SMALLINT[]
          AND (
            SELECT array_agg(key_attribute ORDER BY ordinal_position)
            FROM unnest(index_record.indkey)
              WITH ORDINALITY AS key_columns(
                key_attribute,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'subject_actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND pg_get_expr(index_record.indpred, index_record.indrelid) =
            '(state <> ''revoked''::text)'
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch current index is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF public.omni_actor_membership_epoch_row_is_valid(
        1::SMALLINT,
        'tenant:membership_epoch_check',
        'actor:membership_epoch_subject',
        1::BIGINT,
        'held',
        0::BIGINT,
        'actor:membership_epoch_creator',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_actor_membership_epoch_row_is_valid(
          1::SMALLINT,
          'tenant:membership_epoch_check',
          'actor:membership_epoch_subject',
          1::BIGINT,
          'active',
          1::BIGINT,
          'actor:membership_epoch_creator',
          'actor:membership_epoch_activator',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_actor_membership_epoch_row_is_valid(
          1::SMALLINT,
          'tenant:membership_epoch_check',
          'actor:membership_epoch_subject',
          1::BIGINT,
          'revoked',
          1::BIGINT,
          'actor:membership_epoch_creator',
          NULL,
          'actor:membership_epoch_revoker',
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_actor_membership_epoch_row_is_valid(
          1::SMALLINT,
          'tenant:membership_epoch_check',
          'actor:membership_epoch_subject',
          1::BIGINT,
          'active',
          0::BIGINT,
          'actor:membership_epoch_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_membership_epoch_row_is_valid(
          1::SMALLINT,
          'tenant:membership_epoch_check',
          NULL,
          1::BIGINT,
          'held',
          0::BIGINT,
          'actor:membership_epoch_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Actor membership epoch validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_actor_membership_epoch_row_is_valid(smallint,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
          AND procedure.prosrc = $expected$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_activated_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_activated_by_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_revoked_by_actor_id
          )
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_activated_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_activated_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_created_at <= candidate_activated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_created_at <= candidate_revoked_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at <= candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_validate_actor_membership_epoch_insert()'
        )
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    DECLARE
      expected_epoch BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.subject_actor_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Actor membership epochs must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(epoch.membership_epoch), 0) + 1
      INTO expected_epoch
      FROM public.omni_tenant_actor_membership_epochs epoch
      WHERE epoch.tenant_id = NEW.tenant_id
        AND epoch.subject_actor_id = NEW.subject_actor_id;

      IF NEW.membership_epoch IS DISTINCT FROM expected_epoch THEN
        RAISE EXCEPTION 'Actor membership epoch is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_membership_epochs epoch
        WHERE epoch.tenant_id = NEW.tenant_id
          AND epoch.subject_actor_id = NEW.subject_actor_id
          AND epoch.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Actor already has a current membership epoch'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_protect_actor_membership_epoch()'
        )
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Actor membership epoch rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.subject_actor_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked actor membership epochs are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.membership_epoch IS DISTINCT FROM OLD.membership_epoch
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Actor membership epoch identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision IS DISTINCT FROM
        OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Actor membership epoch revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Membership epoch activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Membership epoch activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Membership epoch revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Membership epoch revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND NOT tgisinternal
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND trigger_record.tgname =
            'omni_actor_membership_epoch_validate_insert'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_validate_actor_membership_epoch_insert()'
          )
          AND trigger_record.tgtype = 7
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND trigger_record.tgname = 'omni_actor_membership_epoch_protect'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_actor_membership_epoch()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_actor_membership_epochs'::regclass
          AND trigger_record.tgname =
            'omni_actor_membership_epoch_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_actor_membership_epoch()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND polname = 'omni_actor_membership_epoch_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_membership_epoch_row_is_valid',
            'omni_validate_actor_membership_epoch_insert',
            'omni_protect_actor_membership_epoch'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_actor_membership_epochs
      ) THEN
        RAISE EXCEPTION 'Actor membership epoch shadow is not empty'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  // Re-prove the preceding access, authorization, entitlement, and consent
  // holds without activating any of them.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:membership_epoch_check',
        'initiatingActorId', 'actor:membership_epoch_subject',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:membership_epoch_subject',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Membership epoch shadow self-check'
      );

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memories_access_enrollment_hold_check'
          AND constraint_record.conrelid = 'omni_memories'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            '(access_contract_version = 0)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version IS DISTINCT FROM 0
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment hold changed'
          USING ERRCODE = '55000';
      END IF;

      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
          IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
        OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
          )
            AND procedure.prorettype = 'boolean'::regtype
            AND procedure.provolatile = 'v'
            AND procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'sql'
            AND btrim(regexp_replace(
              procedure.prosrc,
              '[[:space:]]+',
              ' ',
              'g'
            )) = 'SELECT FALSE'
        )
        OR EXISTS (
          SELECT 1
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
        )
        OR EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
              '%omni_memory_access_scope_v1_is_authorized%'
            OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
              '%omni_memory_access_scope_v1_is_authorized%'
        )
      THEN
        RAISE EXCEPTION 'Dormant memory authorization hook changed'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              AS names,
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              FILTER (WHERE attribute.attnotnull) AS not_null_names,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid =
              'omni_tenant_memory_purpose_entitlements'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'schema_version', 'tenant_id', 'purpose_id',
            'entitlement_generation', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'activated_by_actor_id',
            'revoked_by_actor_id', 'created_at', 'activated_at',
            'revoked_at', 'updated_at'
          ]::TEXT[]
          AND columns.not_null_names = ARRAY[
            'schema_version', 'tenant_id', 'purpose_id',
            'entitlement_generation', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'created_at', 'updated_at'
          ]::TEXT[]
          AND columns.none_generated
          AND columns.column_count = 13
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('schema_version', 'smallint'::REGTYPE),
            ('tenant_id', 'text'::REGTYPE),
            ('purpose_id', 'text'::REGTYPE),
            ('entitlement_generation', 'bigint'::REGTYPE),
            ('state', 'text'::REGTYPE),
            ('lifecycle_revision', 'bigint'::REGTYPE),
            ('created_by_actor_id', 'text'::REGTYPE),
            ('activated_by_actor_id', 'text'::REGTYPE),
            ('revoked_by_actor_id', 'text'::REGTYPE),
            ('created_at', 'timestamp with time zone'::REGTYPE),
            ('activated_at', 'timestamp with time zone'::REGTYPE),
            ('revoked_at', 'timestamp with time zone'::REGTYPE),
            ('updated_at', 'timestamp with time zone'::REGTYPE)
        ) expected(column_name, type_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memory_purpose_entitlements_activation_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            '(state <> ''active''::text)'
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND polname = 'omni_memory_purpose_entitlement_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              to_regprocedure(
                'public.omni_memory_purpose_entitlement_row_is_valid(smallint,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
              ),
              'boolean'::REGTYPE,
              'i',
              'sql',
              'candidate_state IN (''held'', ''active'', ''revoked'')',
              'candidate_entitlement_generation BETWEEN 1 AND 9007199254740991',
              'candidate_lifecycle_revision = 2'
            ),
            (
              to_regprocedure(
                'public.omni_validate_memory_purpose_entitlement_insert()'
              ),
              'trigger'::REGTYPE,
              'v',
              'plpgsql',
              'pg_advisory_xact_lock(',
              'MAX(entitlement.entitlement_generation)',
              'entitlement.state <> ''revoked'''
            ),
            (
              to_regprocedure(
                'public.omni_protect_memory_purpose_entitlement()'
              ),
              'trigger'::REGTYPE,
              'v',
              'plpgsql',
              'TG_OP IN (''DELETE'', ''TRUNCATE'')',
              '(OLD.state = ''held'' AND NEW.state IN (''active'', ''revoked''))',
              'NEW.lifecycle_revision <> OLD.lifecycle_revision + 1'
            )
        ) expected(
          procedure_oid,
          return_type,
          volatility,
          language_name,
          required_source_1,
          required_source_2,
          required_source_3
        )
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_proc procedure
            JOIN pg_language language ON language.oid = procedure.prolang
            WHERE procedure.oid = expected.procedure_oid
              AND procedure.prorettype = expected.return_type
              AND procedure.provolatile::TEXT = expected.volatility
              AND NOT procedure.proisstrict
              AND NOT procedure.prosecdef
              AND NOT procedure.proleakproof
              AND procedure.proconfig =
                ARRAY['search_path=pg_catalog, public']
              AND procedure.proowner = (
                SELECT relowner
                FROM pg_class
                WHERE oid = 'omni_schema_version'::regclass
              )
              AND language.lanname = expected.language_name
              AND position(
                expected.required_source_1 IN procedure.prosrc
              ) > 0
              AND position(
                expected.required_source_2 IN procedure.prosrc
              ) > 0
              AND position(
                expected.required_source_3 IN procedure.prosrc
              ) > 0
          )
      ) OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND NOT tgisinternal
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_memory_purpose_entitlement_validate_insert',
              to_regprocedure(
                'public.omni_validate_memory_purpose_entitlement_insert()'
              ),
              7
            ),
            (
              'omni_memory_purpose_entitlement_protect',
              to_regprocedure(
                'public.omni_protect_memory_purpose_entitlement()'
              ),
              27
            ),
            (
              'omni_memory_purpose_entitlement_no_truncate',
              to_regprocedure(
                'public.omni_protect_memory_purpose_entitlement()'
              ),
              34
            )
        ) expected(trigger_name, procedure_oid, trigger_type)
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger trigger_record
            WHERE trigger_record.tgrelid =
                'omni_tenant_memory_purpose_entitlements'::regclass
              AND trigger_record.tgname = expected.trigger_name
              AND NOT trigger_record.tgisinternal
              AND trigger_record.tgenabled = 'O'
              AND trigger_record.tgfoid = expected.procedure_oid
              AND trigger_record.tgtype = expected.trigger_type
              AND trigger_record.tgqual IS NULL
              AND trigger_record.tgnargs = 0
              AND trigger_record.tgconstraint = 0
              AND NOT trigger_record.tgdeferrable
              AND NOT trigger_record.tginitdeferred
              AND trigger_record.tgattr::TEXT = ''
          )
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_entitlement_row_is_valid',
            'omni_validate_memory_purpose_entitlement_insert',
            'omni_protect_memory_purpose_entitlement'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_memory_purpose_entitlements
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement hold changed'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              AS names,
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              FILTER (WHERE attribute.attnotnull) AS not_null_names,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid =
              'omni_tenant_actor_memory_purpose_consents'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id', 'purpose_id',
            'consent_generation', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'granted_by_actor_id',
            'revoked_by_actor_id', 'created_at', 'granted_at',
            'revoked_at', 'updated_at'
          ]::TEXT[]
          AND columns.not_null_names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id', 'purpose_id',
            'consent_generation', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'created_at', 'updated_at'
          ]::TEXT[]
          AND columns.none_generated
          AND columns.column_count = 14
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('schema_version', 'smallint'::REGTYPE),
            ('tenant_id', 'text'::REGTYPE),
            ('subject_actor_id', 'text'::REGTYPE),
            ('purpose_id', 'text'::REGTYPE),
            ('consent_generation', 'bigint'::REGTYPE),
            ('state', 'text'::REGTYPE),
            ('lifecycle_revision', 'bigint'::REGTYPE),
            ('created_by_actor_id', 'text'::REGTYPE),
            ('granted_by_actor_id', 'text'::REGTYPE),
            ('revoked_by_actor_id', 'text'::REGTYPE),
            ('created_at', 'timestamp with time zone'::REGTYPE),
            ('granted_at', 'timestamp with time zone'::REGTYPE),
            ('revoked_at', 'timestamp with time zone'::REGTYPE),
            ('updated_at', 'timestamp with time zone'::REGTYPE)
        ) expected(column_name, type_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_memory_purpose_consents_grant_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            '(state <> ''granted''::text)'
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid =
          'omni_tenant_actor_memory_purpose_consents'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND polname = 'omni_actor_memory_purpose_consent_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              to_regprocedure(
                'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
              ),
              'boolean'::REGTYPE,
              'i',
              'sql',
              'candidate_state IN (''held'', ''granted'', ''revoked'')',
              'candidate_consent_generation BETWEEN 1 AND 9007199254740991',
              'candidate_lifecycle_revision = 2'
            ),
            (
              to_regprocedure(
                'public.omni_validate_actor_memory_purpose_consent_insert()'
              ),
              'trigger'::REGTYPE,
              'v',
              'plpgsql',
              'pg_advisory_xact_lock(',
              'MAX(consent.consent_generation)',
              'consent.state <> ''revoked'''
            ),
            (
              to_regprocedure(
                'public.omni_protect_actor_memory_purpose_consent()'
              ),
              'trigger'::REGTYPE,
              'v',
              'plpgsql',
              'TG_OP IN (''DELETE'', ''TRUNCATE'')',
              '(OLD.state = ''held'' AND NEW.state IN (''granted'', ''revoked''))',
              'NEW.lifecycle_revision <> OLD.lifecycle_revision + 1'
            )
        ) expected(
          procedure_oid,
          return_type,
          volatility,
          language_name,
          required_source_1,
          required_source_2,
          required_source_3
        )
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_proc procedure
            JOIN pg_language language ON language.oid = procedure.prolang
            WHERE procedure.oid = expected.procedure_oid
              AND procedure.prorettype = expected.return_type
              AND procedure.provolatile::TEXT = expected.volatility
              AND NOT procedure.proisstrict
              AND NOT procedure.prosecdef
              AND NOT procedure.proleakproof
              AND procedure.proconfig =
                ARRAY['search_path=pg_catalog, public']
              AND procedure.proowner = (
                SELECT relowner
                FROM pg_class
                WHERE oid = 'omni_schema_version'::regclass
              )
              AND language.lanname = expected.language_name
              AND position(
                expected.required_source_1 IN procedure.prosrc
              ) > 0
              AND position(
                expected.required_source_2 IN procedure.prosrc
              ) > 0
              AND position(
                expected.required_source_3 IN procedure.prosrc
              ) > 0
          )
      ) OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND NOT tgisinternal
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_memory_purpose_consent_validate_insert',
              to_regprocedure(
                'public.omni_validate_actor_memory_purpose_consent_insert()'
              ),
              7
            ),
            (
              'omni_actor_memory_purpose_consent_protect',
              to_regprocedure(
                'public.omni_protect_actor_memory_purpose_consent()'
              ),
              27
            ),
            (
              'omni_actor_memory_purpose_consent_no_truncate',
              to_regprocedure(
                'public.omni_protect_actor_memory_purpose_consent()'
              ),
              34
            )
        ) expected(trigger_name, procedure_oid, trigger_type)
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger trigger_record
            WHERE trigger_record.tgrelid =
                'omni_tenant_actor_memory_purpose_consents'::regclass
              AND trigger_record.tgname = expected.trigger_name
              AND NOT trigger_record.tgisinternal
              AND trigger_record.tgenabled = 'O'
              AND trigger_record.tgfoid = expected.procedure_oid
              AND trigger_record.tgtype = expected.trigger_type
              AND trigger_record.tgqual IS NULL
              AND trigger_record.tgnargs = 0
              AND trigger_record.tgconstraint = 0
              AND NOT trigger_record.tgdeferrable
              AND NOT trigger_record.tginitdeferred
              AND trigger_record.tgattr::TEXT = ''
          )
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_memory_purpose_consent_row_is_valid',
            'omni_validate_actor_memory_purpose_consent_insert',
            'omni_protect_actor_memory_purpose_consent'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent hold changed'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_auth_memberships'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              AS names,
            array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
              FILTER (WHERE attribute.attnotnull) AS not_null_names,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'omni_auth_memberships'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'id', 'tenant_id', 'user_id', 'role', 'status',
            'created_at', 'updated_at'
          ]::TEXT[]
          AND columns.not_null_names = columns.names
          AND columns.none_generated
          AND columns.column_count = 7
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid = 'omni_auth_memberships'::regclass
      ) <> 1 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_auth_memberships'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
          OR NOT public.omni_source_contract_id_is_valid(actor_id)
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_memberships membership
        LEFT JOIN omni_auth_tenants tenant
          ON tenant.id = membership.tenant_id
        LEFT JOIN omni_auth_users auth_user
          ON auth_user.id = membership.user_id
        WHERE tenant.id IS NULL OR auth_user.id IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_memberships'::regclass
          AND NOT tgisinternal
      ) THEN
        RAISE EXCEPTION 'Live auth membership boundary changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await verifyCurrentAuthMembershipBoundary();
}

export async function ensureTenantActorMembershipManagementAuthoritiesShadow(
  sql: SqlClient,
) {
  // v56 installs only a dormant, subject-bound authority ledger. It does not
  // infer an administrator from current auth, create an authority generation,
  // expose a serving reader or writer, or enable any memory authorization.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Membership management authority migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;

  // Stabilize the live identity boundary and every dormant memory-authority
  // predecessor. SHARE blocks ordinary DML for both audit passes without
  // changing any row, policy, privilege, or runtime authorization decision.
  await sql`
    LOCK TABLE
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships,
      omni_memories,
      omni_memory_informed_notice_contracts,
      omni_tenant_actor_memory_notice_receipts,
      omni_tenant_actor_memory_purpose_consents,
      omni_tenant_memory_purpose_entitlements,
      omni_tenant_actor_membership_epochs
    IN SHARE MODE
  `;

  const verifyPrecedingAuthorityBoundary = async () => {
    await sql`
      DO $migration$
      DECLARE
        valid_scope JSONB;
      BEGIN
        IF public.omni_system_scope_enabled() IS DISTINCT FROM TRUE
          OR public.omni_tenant_visible(
            'tenant:v56_system_scope_check'
          ) IS DISTINCT FROM TRUE
        THEN
          RAISE EXCEPTION 'Membership management system scope is unavailable'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_class relation
          JOIN pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          WHERE relation.oid IN (
              'omni_auth_tenants'::regclass,
              'omni_auth_users'::regclass,
              'omni_auth_memberships'::regclass,
              'omni_memories'::regclass,
              'omni_memory_informed_notice_contracts'::regclass,
              'omni_tenant_actor_memory_notice_receipts'::regclass,
              'omni_tenant_actor_memory_purpose_consents'::regclass,
              'omni_tenant_memory_purpose_entitlements'::regclass,
              'omni_tenant_actor_membership_epochs'::regclass
            )
            AND namespace.nspname = current_schema()
            AND relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND relation.relowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
        ) <> 9 THEN
          RAISE EXCEPTION 'Membership management predecessor relations changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid = 'omni_auth_users'::regclass
            AND attribute.attname = 'actor_id'
            AND NOT attribute.attisdropped
            AND attribute.atttypid = 'text'::regtype
            AND attribute.attnotnull
            AND attribute.attgenerated = 's'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '(''actor:''::text || id)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_auth_users_actor_id_contract_check'
            AND constraint_record.conrelid = 'omni_auth_users'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = 'omni_source_contract_id_is_valid(actor_id)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          WHERE constraint_record.conname = 'omni_auth_users_actor_id_key'
            AND constraint_record.conrelid = 'omni_auth_users'::regclass
            AND constraint_record.contype = 'u'
            AND constraint_record.convalidated
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum
                FROM pg_attribute
                WHERE attrelid = 'omni_auth_users'::regclass
                  AND attname = 'actor_id'
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
        ) THEN
          RAISE EXCEPTION 'Membership management actor identity changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
                AS names,
              array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
                FILTER (WHERE attribute.attnotnull) AS not_null_names,
              bool_and(attribute.attgenerated = '') AS none_generated,
              count(*) AS column_count
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'omni_auth_memberships'::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          ) columns
          WHERE columns.names = ARRAY[
              'id', 'tenant_id', 'user_id', 'role', 'status',
              'created_at', 'updated_at'
            ]::TEXT[]
            AND columns.not_null_names = columns.names
            AND columns.none_generated
            AND columns.column_count = 7
        ) OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('id', 'text'::REGTYPE),
              ('tenant_id', 'text'::REGTYPE),
              ('user_id', 'text'::REGTYPE),
              ('role', 'text'::REGTYPE),
              ('status', 'text'::REGTYPE),
              ('created_at', 'timestamp with time zone'::REGTYPE),
              ('updated_at', 'timestamp with time zone'::REGTYPE)
          ) expected(column_name, type_oid)
          LEFT JOIN pg_attribute attribute
            ON attribute.attrelid = 'omni_auth_memberships'::regclass
            AND attribute.attname = expected.column_name
            AND NOT attribute.attisdropped
          WHERE attribute.attname IS NULL
            OR attribute.atttypid <> expected.type_oid
        ) THEN
          RAISE EXCEPTION 'Membership management live membership columns changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          WHERE constraint_record.conname = 'omni_auth_memberships_pkey'
            AND constraint_record.conrelid =
              'omni_auth_memberships'::regclass
            AND constraint_record.contype = 'p'
            AND constraint_record.convalidated
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid = 'omni_auth_memberships'::regclass
                  AND attname = 'id' AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisprimary
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
        ) OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_auth_memberships_tenant_id_fkey',
                'tenant_id',
                'omni_auth_tenants'::REGCLASS,
                'id'
              ),
              (
                'omni_auth_memberships_user_id_fkey',
                'user_id',
                'omni_auth_users'::REGCLASS,
                'id'
              )
          ) expected(
            constraint_name,
            local_column,
            foreign_relation,
            foreign_column
          )
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            WHERE constraint_record.conname = expected.constraint_name
              AND constraint_record.conrelid =
                'omni_auth_memberships'::regclass
              AND constraint_record.contype = 'f'
              AND constraint_record.convalidated
              AND constraint_record.confrelid = expected.foreign_relation
              AND constraint_record.confupdtype = 'a'
              AND constraint_record.confdeltype = 'c'
              AND constraint_record.confmatchtype = 's'
              AND constraint_record.conkey = ARRAY[
                (
                  SELECT attnum FROM pg_attribute
                  WHERE attrelid = 'omni_auth_memberships'::regclass
                    AND attname = expected.local_column
                    AND NOT attisdropped
                )
              ]::SMALLINT[]
              AND constraint_record.confkey = ARRAY[
                (
                  SELECT attnum FROM pg_attribute
                  WHERE attrelid = expected.foreign_relation
                    AND attname = expected.foreign_column
                    AND NOT attisdropped
                )
              ]::SMALLINT[]
          )
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_index index_record
          WHERE index_record.indexrelid =
              'omni_auth_memberships_tenant_user_idx'::regclass
            AND index_record.indrelid = 'omni_auth_memberships'::regclass
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indnkeyatts = 2
            AND index_record.indnatts = 2
            AND index_record.indexprs IS NULL
            AND index_record.indpred IS NULL
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(index_record.indkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_record.indrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY['tenant_id', 'user_id']::TEXT[]
        ) THEN
          RAISE EXCEPTION 'Membership management live membership keys changed'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_policy
          WHERE polrelid = 'omni_auth_memberships'::regclass
        ) <> 1 OR NOT EXISTS (
          SELECT 1
          FROM pg_class
          WHERE oid = 'omni_auth_memberships'::regclass
            AND relrowsecurity
            AND relforcerowsecurity
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid = 'omni_auth_memberships'::regclass
            AND polname = 'omni_tenant_isolation'
            AND polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              'omni_tenant_visible(tenant_id)'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_tenant_visible(tenant_id)'
        ) OR EXISTS (
          SELECT 1
          FROM pg_class
          WHERE oid = 'omni_auth_users'::regclass
            AND (relrowsecurity OR relforcerowsecurity)
        ) OR EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'omni_auth_memberships'::regclass
            AND NOT tgisinternal
        ) THEN
          RAISE EXCEPTION 'Membership management live auth visibility changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM omni_auth_users
          WHERE actor_id IS DISTINCT FROM 'actor:' || id
            OR NOT public.omni_source_contract_id_is_valid(actor_id)
        ) OR (
          SELECT count(*) FROM omni_auth_users
        ) IS DISTINCT FROM (
          SELECT count(DISTINCT actor_id) FROM omni_auth_users
        ) OR EXISTS (
          SELECT 1
          FROM omni_auth_memberships membership
          LEFT JOIN omni_auth_tenants tenant
            ON tenant.id = membership.tenant_id
          LEFT JOIN omni_auth_users auth_user
            ON auth_user.id = membership.user_id
          WHERE tenant.id IS NULL OR auth_user.id IS NULL
        ) OR EXISTS (
          SELECT 1
          FROM omni_auth_memberships
          GROUP BY tenant_id, user_id
          HAVING count(*) <> 1
        ) THEN
          RAISE EXCEPTION 'Membership management live auth data changed'
            USING ERRCODE = '55000';
        END IF;

        valid_scope := jsonb_build_object(
          'version', 1,
          'tenantId', 'tenant:v56_authority_check',
          'initiatingActorId', 'actor:v56_authority_subject',
          'executingPrincipalType', 'user',
          'executingPrincipalId', 'actor:v56_authority_subject',
          'workspaceId', NULL,
          'projectId', NULL,
          'missionId', NULL,
          'contextGrantIds', '[]'::JSONB,
          'capabilityGrantIds', '[]'::JSONB,
          'purposeId', 'memory.read.v1',
          'purpose', 'Membership management authority self-check'
        );

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_memories_access_enrollment_hold_check'
            AND constraint_record.conrelid = 'omni_memories'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = '(access_contract_version = 0)'
        ) OR EXISTS (
          SELECT 1
          FROM omni_memories
          WHERE access_contract_version IS DISTINCT FROM 0
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_class
          WHERE oid = 'omni_memories'::regclass
            AND relrowsecurity
            AND relforcerowsecurity
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid = 'omni_memories'::regclass
            AND polname = 'omni_memory_access_scope_holdback'
            AND NOT polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              '((access_contract_version = 0) OR omni_system_scope_enabled())'
            AND pg_get_expr(polwithcheck, polrelid) =
              '((access_contract_version = 0) OR omni_system_scope_enabled())'
        ) THEN
          RAISE EXCEPTION 'Membership management memory enrollment hold changed'
            USING ERRCODE = '55000';
        END IF;

        IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
            IS DISTINCT FROM TRUE
          OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
            IS DISTINCT FROM FALSE
          OR NOT EXISTS (
            SELECT 1
            FROM pg_proc procedure
            JOIN pg_language language ON language.oid = procedure.prolang
            WHERE procedure.oid = to_regprocedure(
              'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
            )
              AND procedure.prorettype = 'boolean'::regtype
              AND procedure.provolatile = 'v'
              AND procedure.proisstrict
              AND NOT procedure.prosecdef
              AND NOT procedure.proleakproof
              AND procedure.proconfig =
                ARRAY['search_path=pg_catalog, public']
              AND procedure.proowner = (
                SELECT relowner FROM pg_class
                WHERE oid = 'omni_schema_version'::regclass
              )
              AND language.lanname = 'sql'
              AND btrim(regexp_replace(
                procedure.prosrc,
                '[[:space:]]+',
                ' ',
                'g'
              )) = 'SELECT FALSE'
          ) OR EXISTS (
            SELECT 1
            FROM information_schema.routine_privileges
            WHERE routine_schema = current_schema()
              AND routine_name =
                'omni_memory_access_scope_v1_is_authorized'
              AND privilege_type = 'EXECUTE'
              AND grantee <> current_user
          ) OR EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
                '%omni_memory_access_scope_v1_is_authorized%'
              OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
                '%omni_memory_access_scope_v1_is_authorized%'
          )
        THEN
          RAISE EXCEPTION 'Membership management dormant authorization hook changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_tenant_memory_purpose_entitlements'::REGCLASS,
                'omni_memory_purpose_entitlements_activation_hold_check',
                '(state <> ''active''::text)'
              ),
              (
                'omni_tenant_actor_memory_purpose_consents'::REGCLASS,
                'omni_actor_memory_purpose_consents_grant_hold_check',
                '(state <> ''granted''::text)'
              ),
              (
                'omni_tenant_actor_membership_epochs'::REGCLASS,
                'omni_actor_membership_epochs_activation_hold_check',
                '(state <> ''active''::text)'
              ),
              (
                'omni_memory_informed_notice_contracts'::REGCLASS,
                'omni_memory_informed_notice_contracts_seed_hold_check',
                'false'
              ),
              (
                'omni_tenant_actor_memory_notice_receipts'::REGCLASS,
                'omni_actor_memory_notice_receipts_issuance_hold_check',
                'false'
              )
          ) expected(relation_oid, constraint_name, expression)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid = expected.relation_oid
              AND constraint_record.conname = expected.constraint_name
              AND constraint_record.contype = 'c'
              AND constraint_record.convalidated
              AND COALESCE(
                (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
                TRUE
              )
              AND NOT constraint_record.connoinherit
              AND pg_get_expr(
                constraint_record.conbin,
                constraint_record.conrelid
              ) = expected.expression
          )
        ) THEN
          RAISE EXCEPTION 'Membership management authority holds changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_tenant_memory_purpose_entitlements'::REGCLASS,
                'omni_memory_purpose_entitlement_holdback'
              ),
              (
                'omni_tenant_actor_memory_purpose_consents'::REGCLASS,
                'omni_actor_memory_purpose_consent_holdback'
              ),
              (
                'omni_tenant_actor_membership_epochs'::REGCLASS,
                'omni_actor_membership_epoch_holdback'
              ),
              (
                'omni_tenant_actor_memory_notice_receipts'::REGCLASS,
                'omni_memory_notice_receipt_holdback'
              )
          ) expected(relation_oid, holdback_policy)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            WHERE relation.oid = expected.relation_oid
              AND relation.relrowsecurity
              AND relation.relforcerowsecurity
          ) OR (
            SELECT count(*)
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
          ) <> 2 OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = 'omni_tenant_isolation'
              AND polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_tenant_visible(tenant_id)'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_tenant_visible(tenant_id)'
          ) OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = expected.holdback_policy
              AND NOT polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_system_scope_enabled()'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_system_scope_enabled()'
          )
        ) THEN
          RAISE EXCEPTION 'Membership management predecessor policies changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
                AS names,
              count(*) AS column_count
            FROM pg_attribute attribute
            WHERE attribute.attrelid =
                'omni_tenant_actor_memory_purpose_consents'::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          ) columns
          WHERE columns.names = ARRAY[
              'schema_version', 'tenant_id', 'subject_actor_id',
              'purpose_id', 'consent_generation', 'state',
              'lifecycle_revision', 'created_by_actor_id',
              'granted_by_actor_id', 'revoked_by_actor_id', 'created_at',
              'granted_at', 'revoked_at', 'updated_at', 'membership_epoch',
              'notice_receipt_id'
            ]::TEXT[]
            AND columns.column_count = 16
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_memory_purpose_consents'::regclass
            AND attribute.attname = 'schema_version'
            AND attribute.attnotnull
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('2', '2::smallint', '(2)::smallint')
        ) OR to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NOT NULL OR to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,bigint,text,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NULL THEN
          RAISE EXCEPTION 'Membership management consent v2 binding changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1 FROM omni_memory_informed_notice_contracts
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_memory_notice_receipts
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_memory_purpose_consents
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_memory_purpose_entitlements
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_membership_epochs
        ) THEN
          RAISE EXCEPTION 'Membership management predecessor shadows are not empty'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_memory_informed_notice_contracts',
              'omni_tenant_actor_memory_notice_receipts',
              'omni_tenant_actor_memory_purpose_consents',
              'omni_tenant_memory_purpose_entitlements',
              'omni_tenant_actor_membership_epochs'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.column_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_memory_informed_notice_contracts',
              'omni_tenant_actor_memory_notice_receipts',
              'omni_tenant_actor_memory_purpose_consents',
              'omni_tenant_memory_purpose_entitlements',
              'omni_tenant_actor_membership_epochs'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name IN (
              'omni_memory_informed_notice_contract_row_is_valid',
              'omni_reject_memory_informed_notice_contract_change',
              'omni_actor_memory_notice_receipt_row_is_valid',
              'omni_validate_actor_memory_notice_receipt_insert',
              'omni_reject_actor_memory_notice_receipt_change',
              'omni_actor_memory_purpose_consent_row_is_valid',
              'omni_validate_actor_memory_purpose_consent_insert',
              'omni_protect_actor_memory_purpose_consent',
              'omni_memory_purpose_entitlement_row_is_valid',
              'omni_validate_memory_purpose_entitlement_insert',
              'omni_protect_memory_purpose_entitlement',
              'omni_actor_membership_epoch_row_is_valid',
              'omni_validate_actor_membership_epoch_insert',
              'omni_protect_actor_membership_epoch'
            )
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
        ) THEN
          RAISE EXCEPTION 'Membership management predecessor boundary is exposed'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  };

  const verifyMembershipManagementAuthoritySurface = async () => {
    await sql`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE relation.oid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND namespace.nspname = current_schema()
            AND relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND relation.relrowsecurity
            AND relation.relforcerowsecurity
            AND relation.relowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
        ) THEN
          RAISE EXCEPTION 'Membership management authority relation is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM (
            SELECT
              array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
                AS names,
              array_agg(attribute.attname::TEXT ORDER BY attribute.attnum)
                FILTER (WHERE attribute.attnotnull) AS not_null_names,
              bool_and(attribute.attgenerated = '') AS none_generated,
              count(*) AS column_count
            FROM pg_attribute attribute
            WHERE attribute.attrelid =
                'omni_tenant_actor_membership_management_authorities'::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          ) columns
          WHERE columns.names = ARRAY[
              'schema_version', 'tenant_id', 'subject_actor_id',
              'grantee_actor_id', 'management_authority_id',
              'authority_generation', 'state', 'lifecycle_revision',
              'created_by_actor_id', 'activated_by_actor_id',
              'revoked_by_actor_id', 'created_at', 'activated_at',
              'revoked_at', 'updated_at'
            ]::TEXT[]
            AND columns.not_null_names = ARRAY[
              'schema_version', 'tenant_id', 'subject_actor_id',
              'grantee_actor_id', 'management_authority_id',
              'authority_generation', 'state', 'lifecycle_revision',
              'created_by_actor_id', 'created_at', 'updated_at'
            ]::TEXT[]
            AND columns.none_generated
            AND columns.column_count = 15
        ) OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('schema_version', 'smallint'::REGTYPE, 0::OID),
              (
                'tenant_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              (
                'subject_actor_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              (
                'grantee_actor_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              (
                'management_authority_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              ('authority_generation', 'bigint'::REGTYPE, 0::OID),
              (
                'state',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              ('lifecycle_revision', 'bigint'::REGTYPE, 0::OID),
              (
                'created_by_actor_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              (
                'activated_by_actor_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              (
                'revoked_by_actor_id',
                'text'::REGTYPE,
                'pg_catalog.default'::REGCOLLATION::OID
              ),
              ('created_at', 'timestamp with time zone'::REGTYPE, 0::OID),
              ('activated_at', 'timestamp with time zone'::REGTYPE, 0::OID),
              ('revoked_at', 'timestamp with time zone'::REGTYPE, 0::OID),
              ('updated_at', 'timestamp with time zone'::REGTYPE, 0::OID)
          ) expected(column_name, type_oid, collation_oid)
          LEFT JOIN pg_attribute attribute
            ON attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname = expected.column_name
            AND NOT attribute.attisdropped
          WHERE attribute.attname IS NULL
            OR attribute.atttypid <> expected.type_oid
            OR attribute.attcollation <> expected.collation_oid
        ) THEN
          RAISE EXCEPTION 'Membership management authority columns are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_attrdef
          WHERE adrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
        ) <> 5 OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname = 'schema_version'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('1', '1::smallint', '(1)::smallint')
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname = 'state'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '''held''::text'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname = 'lifecycle_revision'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('0', '0::bigint', '(0)::bigint')
        ) OR (
          SELECT count(*)
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname IN ('created_at', 'updated_at')
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = 'now()'
        ) <> 2 THEN
          RAISE EXCEPTION 'Membership management authority defaults are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_constraint
          WHERE conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND contype <> 'n'
        ) <> 10 OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          JOIN pg_am access_method
            ON access_method.oid = index_relation.relam
          WHERE constraint_record.conname =
              'omni_membership_management_authorities_pkey'
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.contype = 'p'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.condeferrable
            AND NOT constraint_record.condeferred
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'tenant_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'subject_actor_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'grantee_actor_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'authority_generation' AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisprimary
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indislive
            AND index_record.indimmediate
            AND NOT index_record.indisclustered
            AND NOT index_record.indisreplident
            AND NOT index_record.indisexclusion
            AND index_record.indnkeyatts = 4
            AND index_record.indnatts = 4
            AND index_record.indexprs IS NULL
            AND index_record.indpred IS NULL
            AND index_relation.relkind = 'i'
            AND access_method.amname = 'btree'
            AND (
              SELECT array_agg(
                operator_namespace.nspname || '.' || operator_class.opcname
                ORDER BY key.ordinality
              )
              FROM unnest(index_record.indclass)
                WITH ORDINALITY AS key(operator_class_oid, ordinality)
              JOIN pg_opclass operator_class
                ON operator_class.oid = key.operator_class_oid
              JOIN pg_namespace operator_namespace
                ON operator_namespace.oid = operator_class.opcnamespace
            ) = ARRAY[
              'pg_catalog.text_ops',
              'pg_catalog.text_ops',
              'pg_catalog.text_ops',
              'pg_catalog.int8_ops'
            ]::TEXT[]
            AND (
              SELECT array_agg(collation_oid ORDER BY ordinality)
              FROM unnest(index_record.indcollation)
                WITH ORDINALITY AS collations(collation_oid, ordinality)
            ) = ARRAY[
              'pg_catalog.default'::REGCOLLATION::OID,
              'pg_catalog.default'::REGCOLLATION::OID,
              'pg_catalog.default'::REGCOLLATION::OID,
              0::OID
            ]::OID[]
            AND (
              SELECT array_agg(index_option ORDER BY ordinality)
              FROM unnest(index_record.indoption)
                WITH ORDINALITY AS options(index_option, ordinality)
            ) = ARRAY[0, 0, 0, 0]::SMALLINT[]
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(index_record.indkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_record.indrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'subject_actor_id', 'grantee_actor_id',
              'authority_generation'
            ]::TEXT[]
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          JOIN pg_am access_method
            ON access_method.oid = index_relation.relam
          WHERE constraint_record.conname =
              'omni_membership_management_authority_id_key'
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.contype = 'u'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.condeferrable
            AND NOT constraint_record.condeferred
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'tenant_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_management_authorities'::regclass
                  AND attname = 'management_authority_id'
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisunique
            AND NOT index_record.indisprimary
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indislive
            AND index_record.indimmediate
            AND NOT index_record.indisclustered
            AND NOT index_record.indisreplident
            AND NOT index_record.indisexclusion
            AND index_record.indnkeyatts = 2
            AND index_record.indnatts = 2
            AND index_record.indexprs IS NULL
            AND index_record.indpred IS NULL
            AND index_relation.relkind = 'i'
            AND access_method.amname = 'btree'
            AND (
              SELECT array_agg(
                operator_namespace.nspname || '.' || operator_class.opcname
                ORDER BY key.ordinality
              )
              FROM unnest(index_record.indclass)
                WITH ORDINALITY AS key(operator_class_oid, ordinality)
              JOIN pg_opclass operator_class
                ON operator_class.oid = key.operator_class_oid
              JOIN pg_namespace operator_namespace
                ON operator_namespace.oid = operator_class.opcnamespace
            ) = ARRAY[
              'pg_catalog.text_ops',
              'pg_catalog.text_ops'
            ]::TEXT[]
            AND (
              SELECT array_agg(collation_oid ORDER BY ordinality)
              FROM unnest(index_record.indcollation)
                WITH ORDINALITY AS collations(collation_oid, ordinality)
            ) = ARRAY[
              'pg_catalog.default'::REGCOLLATION::OID,
              'pg_catalog.default'::REGCOLLATION::OID
            ]::OID[]
            AND (
              SELECT array_agg(index_option ORDER BY ordinality)
              FROM unnest(index_record.indoption)
                WITH ORDINALITY AS options(index_option, ordinality)
            ) = ARRAY[0, 0]::SMALLINT[]
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(index_record.indkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_record.indrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'management_authority_id'
            ]::TEXT[]
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_membership_management_authority_row_check'
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) =
              'omni_membership_management_authority_row_is_valid(schema_version, tenant_id, subject_actor_id, grantee_actor_id, management_authority_id, authority_generation, state, lifecycle_revision, created_by_actor_id, activated_by_actor_id, revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_membership_management_authority_activation_hold_check'
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = '(state <> ''active''::text)'
        ) THEN
          RAISE EXCEPTION 'Membership management authority constraints are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_membership_management_authority_tenant_fkey',
                'tenant_id',
                'omni_auth_tenants'::REGCLASS,
                'id'
              ),
              (
                'omni_membership_management_authority_subject_fkey',
                'subject_actor_id',
                'omni_auth_users'::REGCLASS,
                'actor_id'
              ),
              (
                'omni_membership_management_authority_grantee_fkey',
                'grantee_actor_id',
                'omni_auth_users'::REGCLASS,
                'actor_id'
              ),
              (
                'omni_membership_management_authority_created_actor_fkey',
                'created_by_actor_id',
                'omni_auth_users'::REGCLASS,
                'actor_id'
              ),
              (
                'omni_membership_management_authority_activated_actor_fkey',
                'activated_by_actor_id',
                'omni_auth_users'::REGCLASS,
                'actor_id'
              ),
              (
                'omni_membership_management_authority_revoked_actor_fkey',
                'revoked_by_actor_id',
                'omni_auth_users'::REGCLASS,
                'actor_id'
              )
          ) expected(
            constraint_name,
            local_column,
            foreign_relation,
            foreign_column
          )
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            WHERE constraint_record.conname = expected.constraint_name
              AND constraint_record.conrelid =
                'omni_tenant_actor_membership_management_authorities'::regclass
              AND constraint_record.contype = 'f'
              AND constraint_record.convalidated
              AND COALESCE(
                (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
                TRUE
              )
              AND NOT constraint_record.condeferrable
              AND NOT constraint_record.condeferred
              AND constraint_record.confrelid = expected.foreign_relation
              AND constraint_record.confupdtype = 'r'
              AND constraint_record.confdeltype = 'r'
              AND constraint_record.confmatchtype = 's'
              AND constraint_record.conkey = ARRAY[
                (
                  SELECT attnum FROM pg_attribute
                  WHERE attrelid =
                      'omni_tenant_actor_membership_management_authorities'::regclass
                    AND attname = expected.local_column
                    AND NOT attisdropped
                )
              ]::SMALLINT[]
              AND constraint_record.confkey = ARRAY[
                (
                  SELECT attnum FROM pg_attribute
                  WHERE attrelid = expected.foreign_relation
                    AND attname = expected.foreign_column
                    AND NOT attisdropped
                )
              ]::SMALLINT[]
          )
        ) THEN
          RAISE EXCEPTION 'Membership management authority references are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_index
          WHERE indrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
        ) <> 3 OR NOT EXISTS (
          SELECT 1
          FROM pg_index index_record
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          JOIN pg_am access_method
            ON access_method.oid = index_relation.relam
          WHERE index_record.indexrelid =
              'omni_membership_management_authorities_current_idx'::regclass
            AND index_record.indrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND index_record.indisunique
            AND NOT index_record.indisprimary
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indislive
            AND index_record.indimmediate
            AND NOT index_record.indisclustered
            AND NOT index_record.indisreplident
            AND NOT index_record.indisexclusion
            AND index_record.indnatts = 3
            AND index_record.indnkeyatts = 3
            AND index_record.indexprs IS NULL
            AND index_relation.relkind = 'i'
            AND access_method.amname = 'btree'
            AND (
              SELECT array_agg(operator_class ORDER BY ordinal_position)
              FROM unnest(index_record.indclass)
                WITH ORDINALITY AS operator_classes(
                  operator_class,
                  ordinal_position
                )
            ) = ARRAY[
              (
                SELECT operator_class.oid
                FROM pg_opclass operator_class
                WHERE operator_class.opcname = 'text_ops'
                  AND operator_class.opcnamespace =
                    'pg_catalog'::REGNAMESPACE
                  AND operator_class.opcmethod = access_method.oid
              ),
              (
                SELECT operator_class.oid
                FROM pg_opclass operator_class
                WHERE operator_class.opcname = 'text_ops'
                  AND operator_class.opcnamespace =
                    'pg_catalog'::REGNAMESPACE
                  AND operator_class.opcmethod = access_method.oid
              ),
              (
                SELECT operator_class.oid
                FROM pg_opclass operator_class
                WHERE operator_class.opcname = 'text_ops'
                  AND operator_class.opcnamespace =
                    'pg_catalog'::REGNAMESPACE
                  AND operator_class.opcmethod = access_method.oid
              )
            ]::OID[]
            AND (
              SELECT array_agg(collation_oid ORDER BY ordinal_position)
              FROM unnest(index_record.indcollation)
                WITH ORDINALITY AS collations(
                  collation_oid,
                  ordinal_position
                )
            ) = ARRAY[
              'pg_catalog.default'::REGCOLLATION::OID,
              'pg_catalog.default'::REGCOLLATION::OID,
              'pg_catalog.default'::REGCOLLATION::OID
            ]::OID[]
            AND (
              SELECT array_agg(index_option ORDER BY ordinal_position)
              FROM unnest(index_record.indoption)
                WITH ORDINALITY AS index_options(
                  index_option,
                  ordinal_position
                )
            ) = ARRAY[0, 0, 0]::SMALLINT[]
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(index_record.indkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index_record.indrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'subject_actor_id', 'grantee_actor_id'
            ]::TEXT[]
            AND pg_get_expr(index_record.indpred, index_record.indrelid) =
              '(state <> ''revoked''::text)'
        ) THEN
          RAISE EXCEPTION 'Membership management authority indexes are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF public.omni_membership_management_authority_row_is_valid(
          1::SMALLINT,
          'tenant:v56_authority_check',
          'actor:v56_authority_subject',
          'actor:v56_authority_grantee',
          'membership_authority:v56_check',
          1::BIGINT,
          'held',
          0::BIGINT,
          'actor:v56_authority_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
          public.omni_membership_management_authority_row_is_valid(
            1::SMALLINT,
            'tenant:v56_authority_check',
            'actor:v56_authority_subject',
            'actor:v56_authority_grantee',
            'membership_authority:v56_check',
            1::BIGINT,
            'active',
            1::BIGINT,
            'actor:v56_authority_creator',
            'actor:v56_authority_activator',
            NULL,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            NULL,
            CURRENT_TIMESTAMP
          ) IS DISTINCT FROM TRUE OR
          public.omni_membership_management_authority_row_is_valid(
            1::SMALLINT,
            'tenant:v56_authority_check',
            'actor:v56_authority_subject',
            'actor:v56_authority_grantee',
            'membership_authority:v56_check',
            1::BIGINT,
            'revoked',
            1::BIGINT,
            'actor:v56_authority_creator',
            NULL,
            'actor:v56_authority_revoker',
            CURRENT_TIMESTAMP,
            NULL,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          ) IS DISTINCT FROM TRUE OR
          public.omni_membership_management_authority_row_is_valid(
            1::SMALLINT,
            'tenant:v56_authority_check',
            'actor:v56_authority_subject',
            'actor:v56_authority_grantee',
            'membership_authority:v56_check',
            1::BIGINT,
            'active',
            0::BIGINT,
            'actor:v56_authority_creator',
            NULL,
            NULL,
            CURRENT_TIMESTAMP,
            NULL,
            NULL,
            CURRENT_TIMESTAMP
          ) IS DISTINCT FROM FALSE OR
          public.omni_membership_management_authority_row_is_valid(
            1::SMALLINT,
            'tenant:v56_authority_check',
            'actor:v56_authority_subject',
            'actor:v56_authority_grantee',
            NULL,
            1::BIGINT,
            'held',
            0::BIGINT,
            'actor:v56_authority_creator',
            NULL,
            NULL,
            CURRENT_TIMESTAMP,
            NULL,
            NULL,
            CURRENT_TIMESTAMP
          ) IS DISTINCT FROM FALSE
        THEN
          RAISE EXCEPTION 'Membership management authority validator is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_proc procedure
          JOIN pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
            AND procedure.proname IN (
              'omni_membership_management_authority_row_is_valid',
              'omni_validate_membership_management_authority_insert',
              'omni_protect_membership_management_authority'
            )
        ) <> 3 OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_membership_management_authority_row_is_valid(smallint,text,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
          )
            AND procedure.prorettype = 'boolean'::regtype
            AND procedure.provolatile = 'i'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'sql'
            AND procedure.prosrc = $expected$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_grantee_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_management_authority_id
        )
        AND candidate_authority_generation BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_activated_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_activated_by_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_revoked_by_actor_id
          )
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_activated_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_activated_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_created_at <= candidate_activated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_created_at <= candidate_revoked_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at <= candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_validate_membership_management_authority_insert()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    DECLARE
      expected_generation BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(
          NEW.subject_actor_id || chr(31) || NEW.grantee_actor_id
        )
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Membership management authorities must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(authority.authority_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_actor_membership_management_authorities authority
      WHERE authority.tenant_id = NEW.tenant_id
        AND authority.subject_actor_id = NEW.subject_actor_id
        AND authority.grantee_actor_id = NEW.grantee_actor_id;

      IF NEW.authority_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Membership management authority generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_membership_management_authorities authority
        WHERE authority.tenant_id = NEW.tenant_id
          AND authority.subject_actor_id = NEW.subject_actor_id
          AND authority.grantee_actor_id = NEW.grantee_actor_id
          AND authority.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Membership management authority already has a current generation'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_protect_membership_management_authority()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Membership management authority rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(
          OLD.subject_actor_id || chr(31) || OLD.grantee_actor_id
        )
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked membership management authorities are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.grantee_actor_id IS DISTINCT FROM OLD.grantee_actor_id
        OR NEW.management_authority_id IS DISTINCT FROM
          OLD.management_authority_id
        OR NEW.authority_generation IS DISTINCT FROM
          OLD.authority_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM
          OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Membership management authority identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Membership management authority transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision IS DISTINCT FROM
        OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Membership management authority revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Membership management authority activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Membership management activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Membership management activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Membership management revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Membership management revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
        ) THEN
          RAISE EXCEPTION 'Membership management authority functions are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_trigger
          WHERE tgrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND NOT tgisinternal
        ) <> 3 OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_membership_management_authority_validate_insert',
                to_regprocedure(
                  'public.omni_validate_membership_management_authority_insert()'
                ),
                7
              ),
              (
                'omni_membership_management_authority_protect',
                to_regprocedure(
                  'public.omni_protect_membership_management_authority()'
                ),
                27
              ),
              (
                'omni_membership_management_authority_no_truncate',
                to_regprocedure(
                  'public.omni_protect_membership_management_authority()'
                ),
                34
              )
          ) expected(trigger_name, procedure_oid, trigger_type)
          WHERE expected.procedure_oid IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM pg_trigger trigger_record
              WHERE trigger_record.tgrelid =
                  'omni_tenant_actor_membership_management_authorities'::regclass
                AND trigger_record.tgname = expected.trigger_name
                AND NOT trigger_record.tgisinternal
                AND trigger_record.tgenabled = 'O'
                AND trigger_record.tgfoid = expected.procedure_oid
                AND trigger_record.tgtype = expected.trigger_type
                AND trigger_record.tgqual IS NULL
                AND trigger_record.tgnargs = 0
                AND trigger_record.tgconstraint = 0
                AND NOT trigger_record.tgdeferrable
                AND NOT trigger_record.tginitdeferred
                AND trigger_record.tgattr::TEXT = ''
            )
        ) THEN
          RAISE EXCEPTION 'Membership management authority triggers are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_policy
          WHERE polrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
        ) <> 2 OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND polname = 'omni_tenant_isolation'
            AND polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              'omni_tenant_visible(tenant_id)'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_tenant_visible(tenant_id)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND polname =
              'omni_membership_management_authority_holdback'
            AND NOT polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              'omni_system_scope_enabled()'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_system_scope_enabled()'
        ) THEN
          RAISE EXCEPTION 'Membership management authority policies are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name =
              'omni_tenant_actor_membership_management_authorities'
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.column_privileges
          WHERE table_schema = current_schema()
            AND table_name =
              'omni_tenant_actor_membership_management_authorities'
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name IN (
              'omni_membership_management_authority_row_is_valid',
              'omni_validate_membership_management_authority_insert',
              'omni_protect_membership_management_authority'
            )
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
        ) THEN
          RAISE EXCEPTION 'Membership management authority boundary is exposed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM omni_tenant_actor_membership_management_authorities
        ) THEN
          RAISE EXCEPTION 'Membership management authority shadow is not empty'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  };

  await verifyPrecedingAuthorityBoundary();

  const targetRelationState = await sql`
    SELECT to_regclass(
      'public.omni_tenant_actor_membership_management_authorities'
    ) IS NOT NULL AS relation_exists
  `;
  const targetRelationExists = targetRelationState[0]?.relation_exists;
  if (
    targetRelationState.length !== 1 ||
    typeof targetRelationExists !== "boolean"
  ) {
    throw new Error("Membership management authority retry state is invalid.");
  }

  if (targetRelationExists) {
    await sql`
      LOCK TABLE omni_tenant_actor_membership_management_authorities
      IN ACCESS EXCLUSIVE MODE
    `;
    await verifyMembershipManagementAuthoritySurface();
  } else {
    await sql`
      DO $migration$
      BEGIN
        IF to_regclass(
          'public.omni_membership_management_authorities_current_idx'
        ) IS NOT NULL OR to_regprocedure(
          'public.omni_membership_management_authority_row_is_valid(smallint,text,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NOT NULL OR to_regprocedure(
          'public.omni_validate_membership_management_authority_insert()'
        ) IS NOT NULL OR to_regprocedure(
          'public.omni_protect_membership_management_authority()'
        ) IS NOT NULL THEN
          RAISE EXCEPTION 'Membership management authority install is partial'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
            AND procedure.proname IN (
              'omni_membership_management_authority_row_is_valid',
              'omni_validate_membership_management_authority_insert',
              'omni_protect_membership_management_authority'
            )
        ) THEN
          RAISE EXCEPTION 'Membership management authority overload is unexpected'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  }

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_membership_management_authority_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_tenant_id TEXT,
        candidate_subject_actor_id TEXT,
        candidate_grantee_actor_id TEXT,
        candidate_management_authority_id TEXT,
        candidate_authority_generation BIGINT,
        candidate_state TEXT,
        candidate_lifecycle_revision BIGINT,
        candidate_created_by_actor_id TEXT,
        candidate_activated_by_actor_id TEXT,
        candidate_revoked_by_actor_id TEXT,
        candidate_created_at TIMESTAMPTZ,
        candidate_activated_at TIMESTAMPTZ,
        candidate_revoked_at TIMESTAMPTZ,
        candidate_updated_at TIMESTAMPTZ
      )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_grantee_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_management_authority_id
        )
        AND candidate_authority_generation BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_activated_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_activated_by_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR public.omni_source_contract_id_is_valid(
            candidate_revoked_by_actor_id
          )
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_activated_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_activated_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_created_at <= candidate_activated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_created_at <= candidate_revoked_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at <= candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS
      omni_tenant_actor_membership_management_authorities (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        tenant_id TEXT NOT NULL,
        subject_actor_id TEXT NOT NULL,
        grantee_actor_id TEXT NOT NULL,
        management_authority_id TEXT NOT NULL,
        authority_generation BIGINT NOT NULL,
        state TEXT NOT NULL DEFAULT 'held',
        lifecycle_revision BIGINT NOT NULL DEFAULT 0,
        created_by_actor_id TEXT NOT NULL,
        activated_by_actor_id TEXT,
        revoked_by_actor_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT omni_membership_management_authorities_pkey
          PRIMARY KEY (
            tenant_id,
            subject_actor_id,
            grantee_actor_id,
            authority_generation
          ),
        CONSTRAINT omni_membership_management_authority_id_key
          UNIQUE (tenant_id, management_authority_id),
        CONSTRAINT omni_membership_management_authority_row_check CHECK (
          omni_membership_management_authority_row_is_valid(
            schema_version,
            tenant_id,
            subject_actor_id,
            grantee_actor_id,
            management_authority_id,
            authority_generation,
            state,
            lifecycle_revision,
            created_by_actor_id,
            activated_by_actor_id,
            revoked_by_actor_id,
            created_at,
            activated_at,
            revoked_at,
            updated_at
          )
        ),
        CONSTRAINT
          omni_membership_management_authority_activation_hold_check
          CHECK (state <> 'active'),
        CONSTRAINT omni_membership_management_authority_tenant_fkey
          FOREIGN KEY (tenant_id)
          REFERENCES omni_auth_tenants (id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_membership_management_authority_subject_fkey
          FOREIGN KEY (subject_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_membership_management_authority_grantee_fkey
          FOREIGN KEY (grantee_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_membership_management_authority_created_actor_fkey
          FOREIGN KEY (created_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_membership_management_authority_activated_actor_fkey
          FOREIGN KEY (activated_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_membership_management_authority_revoked_actor_fkey
          FOREIGN KEY (revoked_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_membership_management_authorities_current_idx
    ON omni_tenant_actor_membership_management_authorities (
      tenant_id,
      subject_actor_id,
      grantee_actor_id
    )
    WHERE state <> 'revoked'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_validate_membership_management_authority_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_generation BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(
          NEW.subject_actor_id || chr(31) || NEW.grantee_actor_id
        )
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Membership management authorities must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(authority.authority_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_actor_membership_management_authorities authority
      WHERE authority.tenant_id = NEW.tenant_id
        AND authority.subject_actor_id = NEW.subject_actor_id
        AND authority.grantee_actor_id = NEW.grantee_actor_id;

      IF NEW.authority_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Membership management authority generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_membership_management_authorities authority
        WHERE authority.tenant_id = NEW.tenant_id
          AND authority.subject_actor_id = NEW.subject_actor_id
          AND authority.grantee_actor_id = NEW.grantee_actor_id
          AND authority.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Membership management authority already has a current generation'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_protect_membership_management_authority()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Membership management authority rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(
          OLD.subject_actor_id || chr(31) || OLD.grantee_actor_id
        )
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked membership management authorities are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.grantee_actor_id IS DISTINCT FROM OLD.grantee_actor_id
        OR NEW.management_authority_id IS DISTINCT FROM
          OLD.management_authority_id
        OR NEW.authority_generation IS DISTINCT FROM
          OLD.authority_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM
          OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Membership management authority identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Membership management authority transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision IS DISTINCT FROM
        OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Membership management authority revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.activated_at IS NOT NULL AND (
        NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_by_actor_id IS DISTINCT FROM
          OLD.activated_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Membership management authority activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Membership management activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Membership management activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Membership management revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Membership management revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
          AND tgname =
            'omni_membership_management_authority_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_membership_management_authority_validate_insert
        BEFORE INSERT
        ON omni_tenant_actor_membership_management_authorities
        FOR EACH ROW
        EXECUTE FUNCTION
          omni_validate_membership_management_authority_insert();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
          AND tgname = 'omni_membership_management_authority_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_membership_management_authority_protect
        BEFORE UPDATE OR DELETE
        ON omni_tenant_actor_membership_management_authorities
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_membership_management_authority();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
          AND tgname = 'omni_membership_management_authority_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_membership_management_authority_no_truncate
        BEFORE TRUNCATE
        ON omni_tenant_actor_membership_management_authorities
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_membership_management_authority();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_tenant_actor_membership_management_authorities
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_membership_management_authority_row_is_valid(
      SMALLINT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      BIGINT,
      TEXT,
      BIGINT,
      TEXT,
      TEXT,
      TEXT,
      TIMESTAMPTZ,
      TIMESTAMPTZ,
      TIMESTAMPTZ,
      TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_membership_management_authority_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_membership_management_authority()
    FROM PUBLIC
  `);

  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name =
            'omni_tenant_actor_membership_management_authorities'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE ' ||
          '%I.omni_tenant_actor_membership_management_authorities FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name =
            'omni_tenant_actor_membership_management_authorities'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE ' ||
          '%I.omni_tenant_actor_membership_management_authorities FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_membership_management_authority_row_is_valid',
            'omni_validate_membership_management_authority_insert',
            'omni_protect_membership_management_authority'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_membership_management_authority_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, ' ||
          'TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_membership_management_authority_insert() ' ||
          'FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_membership_management_authority() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_actor_membership_management_authorities
      ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_actor_membership_management_authorities
      FORCE ROW LEVEL SECURITY
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
          AND polname = 'omni_tenant_isolation'
      ) THEN
        ALTER POLICY omni_tenant_isolation
        ON omni_tenant_actor_membership_management_authorities
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      ELSE
        CREATE POLICY omni_tenant_isolation
        ON omni_tenant_actor_membership_management_authorities
        FOR ALL
        TO PUBLIC
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
          AND polname =
            'omni_membership_management_authority_holdback'
      ) THEN
        CREATE POLICY omni_membership_management_authority_holdback
        ON omni_tenant_actor_membership_management_authorities
        AS RESTRICTIVE
        FOR ALL
        TO PUBLIC
        USING (omni_system_scope_enabled())
        WITH CHECK (omni_system_scope_enabled());
      END IF;
    END
    $migration$
  `;

  await verifyMembershipManagementAuthoritySurface();
  await verifyPrecedingAuthorityBoundary();
}

export async function ensureMembershipManagementBootstrapEvidenceShadow(
  sql: SqlClient,
) {
  // v57 installs only immutable, held bootstrap-governance evidence shapes.
  // It creates no decision, attestation, trust root, key registry, authority,
  // writer, serving grant, or event and cannot activate the v56 ledger.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Membership bootstrap evidence migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;

  // Hold the canonical database, tenant, actor, mutable membership, and every
  // dormant memory-authority predecessor stable across both audit passes.
  await sql`
    LOCK TABLE
      omni_database_identity,
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships,
      omni_memories,
      omni_memory_informed_notice_contracts,
      omni_tenant_actor_memory_notice_receipts,
      omni_tenant_actor_memory_purpose_consents,
      omni_tenant_memory_purpose_entitlements,
      omni_tenant_actor_membership_epochs,
      omni_tenant_actor_membership_management_authorities
    IN SHARE MODE
  `;

  const verifyBootstrapEvidencePredecessors = async () => {
    await sql`
      DO $migration$
      DECLARE
        valid_scope JSONB;
      BEGIN
        IF public.omni_system_scope_enabled() IS DISTINCT FROM TRUE
          OR public.omni_tenant_visible(
            'tenant:v57_bootstrap_evidence_check'
          ) IS DISTINCT FROM TRUE
        THEN
          RAISE EXCEPTION 'Membership bootstrap evidence system scope is unavailable'
            USING ERRCODE = '55000';
        END IF;

        -- Ignore historical timestamp-only rows whose version remains NULL.
        IF (
          SELECT count(*)
          FROM omni_schema_version
          WHERE version IS NOT NULL
            AND version = 56
            AND name =
              'tenant_actor_membership_management_authorities_shadow'
            AND checksum =
              '8f60e058c5ed4f60ed70f8025d9ab472a0c6dcc0957673aa4319668526238c09'
        ) <> 1 THEN
          RAISE EXCEPTION 'Membership bootstrap evidence v56 marker is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_class relation
          JOIN pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          WHERE relation.oid IN (
              'omni_database_identity'::regclass,
              'omni_auth_tenants'::regclass,
              'omni_auth_users'::regclass,
              'omni_auth_memberships'::regclass,
              'omni_memories'::regclass,
              'omni_memory_informed_notice_contracts'::regclass,
              'omni_tenant_actor_memory_notice_receipts'::regclass,
              'omni_tenant_actor_memory_purpose_consents'::regclass,
              'omni_tenant_memory_purpose_entitlements'::regclass,
              'omni_tenant_actor_membership_epochs'::regclass,
              'omni_tenant_actor_membership_management_authorities'::regclass
            )
            AND namespace.nspname = current_schema()
            AND relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND relation.relowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
        ) <> 11 THEN
          RAISE EXCEPTION 'Membership bootstrap evidence predecessor relations changed'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM omni_database_identity
          WHERE singleton IS TRUE
            AND id ~ '^[0-9a-f]{32}$'
        ) <> 1 OR (
          SELECT count(*) FROM omni_database_identity
        ) <> 1 THEN
          RAISE EXCEPTION 'Membership bootstrap database identity is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          WHERE constraint_record.conrelid =
              'omni_database_identity'::regclass
            AND constraint_record.conname =
              'omni_database_identity_pkey'
            AND constraint_record.contype = 'p'
            AND constraint_record.convalidated
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid = 'omni_database_identity'::regclass
                  AND attname = 'singleton'
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisprimary
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          WHERE constraint_record.conrelid =
              'omni_database_identity'::regclass
            AND constraint_record.conname =
              'omni_database_identity_id_key'
            AND constraint_record.contype = 'u'
            AND constraint_record.convalidated
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid = 'omni_database_identity'::regclass
                  AND attname = 'id'
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_database_identity'::regclass
            AND constraint_record.conname =
              'omni_database_identity_singleton_check'
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = 'singleton'
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap database identity keys changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid = 'omni_auth_users'::regclass
            AND attribute.attname = 'actor_id'
            AND NOT attribute.attisdropped
            AND attribute.atttypid = 'text'::regtype
            AND attribute.attnotnull
            AND attribute.attgenerated = 's'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '(''actor:''::text || id)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_index index_record
            ON index_record.indexrelid = constraint_record.conindid
          WHERE constraint_record.conrelid = 'omni_auth_users'::regclass
            AND constraint_record.conname = 'omni_auth_users_actor_id_key'
            AND constraint_record.contype = 'u'
            AND constraint_record.convalidated
            AND constraint_record.conkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid = 'omni_auth_users'::regclass
                  AND attname = 'actor_id'
                  AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
        ) OR EXISTS (
          SELECT 1
          FROM omni_auth_users
          WHERE actor_id IS DISTINCT FROM 'actor:' || id
            OR NOT public.omni_source_contract_id_is_valid(actor_id)
        ) OR (
          SELECT count(*) FROM omni_auth_users
        ) IS DISTINCT FROM (
          SELECT count(DISTINCT actor_id) FROM omni_auth_users
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap canonical actor identity changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('tenant_id', 'text'::REGTYPE, TRUE),
              ('subject_actor_id', 'text'::REGTYPE, TRUE),
              ('grantee_actor_id', 'text'::REGTYPE, TRUE),
              ('management_authority_id', 'text'::REGTYPE, TRUE),
              ('authority_generation', 'bigint'::REGTYPE, TRUE)
          ) expected(column_name, type_oid, not_null)
          LEFT JOIN pg_attribute attribute
            ON attribute.attrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND attribute.attname = expected.column_name
            AND NOT attribute.attisdropped
          WHERE attribute.attname IS NULL
            OR attribute.atttypid <> expected.type_oid
            OR attribute.attnotnull IS DISTINCT FROM expected.not_null
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.conname =
              'omni_membership_management_authorities_pkey'
            AND constraint_record.contype = 'p'
            AND constraint_record.convalidated
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(constraint_record.conkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'subject_actor_id', 'grantee_actor_id',
              'authority_generation'
            ]::TEXT[]
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.conname =
              'omni_membership_management_authority_id_key'
            AND constraint_record.contype = 'u'
            AND constraint_record.convalidated
            AND (
              SELECT array_agg(
                attribute.attname::TEXT ORDER BY key.ordinality
              )
              FROM unnest(constraint_record.conkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY['tenant_id', 'management_authority_id']::TEXT[]
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.conname =
              'omni_membership_management_authority_row_check'
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) =
              'omni_membership_management_authority_row_is_valid(schema_version, tenant_id, subject_actor_id, grantee_actor_id, management_authority_id, authority_generation, state, lifecycle_revision, created_by_actor_id, activated_by_actor_id, revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_membership_management_authority_row_is_valid(smallint,text,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
          )
            AND procedure.prorettype = 'boolean'::regtype
            AND procedure.provolatile = 'i'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND language.lanname = 'sql'
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap v56 target identity changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_membership_management_authority_activation_hold_check'
            AND constraint_record.conrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = '(state <> ''active''::text)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_class relation
          WHERE relation.oid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND relation.relrowsecurity
            AND relation.relforcerowsecurity
        ) OR (
          SELECT count(*)
          FROM pg_policy
          WHERE polrelid =
            'omni_tenant_actor_membership_management_authorities'::regclass
        ) <> 2 OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND polname = 'omni_tenant_isolation'
            AND polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              'omni_tenant_visible(tenant_id)'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_tenant_visible(tenant_id)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid =
              'omni_tenant_actor_membership_management_authorities'::regclass
            AND polname =
              'omni_membership_management_authority_holdback'
            AND NOT polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              'omni_system_scope_enabled()'
            AND pg_get_expr(polwithcheck, polrelid) =
              'omni_system_scope_enabled()'
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap v56 activation hold changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_tenant_memory_purpose_entitlements'::REGCLASS,
                'omni_memory_purpose_entitlements_activation_hold_check',
                '(state <> ''active''::text)'
              ),
              (
                'omni_tenant_actor_memory_purpose_consents'::REGCLASS,
                'omni_actor_memory_purpose_consents_grant_hold_check',
                '(state <> ''granted''::text)'
              ),
              (
                'omni_tenant_actor_membership_epochs'::REGCLASS,
                'omni_actor_membership_epochs_activation_hold_check',
                '(state <> ''active''::text)'
              ),
              (
                'omni_memory_informed_notice_contracts'::REGCLASS,
                'omni_memory_informed_notice_contracts_seed_hold_check',
                'false'
              ),
              (
                'omni_tenant_actor_memory_notice_receipts'::REGCLASS,
                'omni_actor_memory_notice_receipts_issuance_hold_check',
                'false'
              )
          ) expected(relation_oid, constraint_name, expression)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid = expected.relation_oid
              AND constraint_record.conname = expected.constraint_name
              AND constraint_record.contype = 'c'
              AND constraint_record.convalidated
              AND COALESCE(
                (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
                TRUE
              )
              AND NOT constraint_record.connoinherit
              AND pg_get_expr(
                constraint_record.conbin,
                constraint_record.conrelid
              ) = expected.expression
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap predecessor constraints changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              (
                'omni_tenant_memory_purpose_entitlements'::REGCLASS,
                'omni_memory_purpose_entitlement_holdback'
              ),
              (
                'omni_tenant_actor_memory_purpose_consents'::REGCLASS,
                'omni_actor_memory_purpose_consent_holdback'
              ),
              (
                'omni_tenant_actor_membership_epochs'::REGCLASS,
                'omni_actor_membership_epoch_holdback'
              ),
              (
                'omni_tenant_actor_memory_notice_receipts'::REGCLASS,
                'omni_memory_notice_receipt_holdback'
              )
          ) expected(relation_oid, holdback_policy)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            WHERE relation.oid = expected.relation_oid
              AND relation.relrowsecurity
              AND relation.relforcerowsecurity
          ) OR (
            SELECT count(*)
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
          ) <> 2 OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = 'omni_tenant_isolation'
              AND polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_tenant_visible(tenant_id)'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_tenant_visible(tenant_id)'
          ) OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = expected.holdback_policy
              AND NOT polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_system_scope_enabled()'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_system_scope_enabled()'
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap predecessor policies changed'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_memories_access_enrollment_hold_check'
            AND constraint_record.conrelid = 'omni_memories'::regclass
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = '(access_contract_version = 0)'
        ) OR EXISTS (
          SELECT 1
          FROM omni_memories
          WHERE access_contract_version IS DISTINCT FROM 0
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_policy
          WHERE polrelid = 'omni_memories'::regclass
            AND polname = 'omni_memory_access_scope_holdback'
            AND NOT polpermissive
            AND polcmd = '*'
            AND polroles = ARRAY[0::OID]
            AND pg_get_expr(polqual, polrelid) =
              '((access_contract_version = 0) OR omni_system_scope_enabled())'
            AND pg_get_expr(polwithcheck, polrelid) =
              '((access_contract_version = 0) OR omni_system_scope_enabled())'
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap memory enrollment hold changed'
            USING ERRCODE = '55000';
        END IF;

        valid_scope := jsonb_build_object(
          'version', 1,
          'tenantId', 'tenant:v57_bootstrap_evidence_check',
          'initiatingActorId', 'actor:v57_bootstrap_recorder',
          'executingPrincipalType', 'user',
          'executingPrincipalId', 'actor:v57_bootstrap_recorder',
          'workspaceId', NULL,
          'projectId', NULL,
          'missionId', NULL,
          'contextGrantIds', '[]'::JSONB,
          'capabilityGrantIds', '[]'::JSONB,
          'purposeId', 'memory.read.v1',
          'purpose', 'Bootstrap evidence hold self-check'
        );

        IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
            IS DISTINCT FROM TRUE
          OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
            IS DISTINCT FROM FALSE
          OR EXISTS (
            SELECT 1
            FROM information_schema.routine_privileges
            WHERE routine_schema = current_schema()
              AND routine_name =
                'omni_memory_access_scope_v1_is_authorized'
              AND privilege_type = 'EXECUTE'
              AND grantee <> current_user
          )
        THEN
          RAISE EXCEPTION 'Membership bootstrap dormant authorization changed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1 FROM omni_memory_informed_notice_contracts
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_memory_notice_receipts
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_memory_purpose_consents
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_memory_purpose_entitlements
        ) OR EXISTS (
          SELECT 1 FROM omni_tenant_actor_membership_epochs
        ) OR EXISTS (
          SELECT 1
          FROM omni_tenant_actor_membership_management_authorities
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap predecessor shadows are not empty'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_memory_informed_notice_contracts',
              'omni_tenant_actor_memory_notice_receipts',
              'omni_tenant_actor_memory_purpose_consents',
              'omni_tenant_memory_purpose_entitlements',
              'omni_tenant_actor_membership_epochs',
              'omni_tenant_actor_membership_management_authorities'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.column_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_memory_informed_notice_contracts',
              'omni_tenant_actor_memory_notice_receipts',
              'omni_tenant_actor_memory_purpose_consents',
              'omni_tenant_memory_purpose_entitlements',
              'omni_tenant_actor_membership_epochs',
              'omni_tenant_actor_membership_management_authorities'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name IN (
              'omni_memory_informed_notice_contract_row_is_valid',
              'omni_reject_memory_informed_notice_contract_change',
              'omni_actor_memory_notice_receipt_row_is_valid',
              'omni_validate_actor_memory_notice_receipt_insert',
              'omni_reject_actor_memory_notice_receipt_change',
              'omni_actor_memory_purpose_consent_row_is_valid',
              'omni_validate_actor_memory_purpose_consent_insert',
              'omni_protect_actor_memory_purpose_consent',
              'omni_memory_purpose_entitlement_row_is_valid',
              'omni_validate_memory_purpose_entitlement_insert',
              'omni_protect_memory_purpose_entitlement',
              'omni_actor_membership_epoch_row_is_valid',
              'omni_validate_actor_membership_epoch_insert',
              'omni_protect_actor_membership_epoch',
              'omni_membership_management_authority_row_is_valid',
              'omni_validate_membership_management_authority_insert',
              'omni_protect_membership_management_authority'
            )
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap predecessor boundary is exposed'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  };

  const verifyBootstrapEvidenceSurface = async () => {
    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE relation.oid IN (
              'omni_membership_management_bootstrap_decisions'::regclass,
              'omni_membership_management_bootstrap_attestations'::regclass
            )
            AND namespace.nspname = current_schema()
            AND relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND relation.relrowsecurity
            AND relation.relforcerowsecurity
            AND relation.relowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
        ) <> 2 THEN
          RAISE EXCEPTION 'Membership bootstrap evidence relations are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'schema_version', 1, 'smallint'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'tenant_id', 2, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'governance_decision_id', 3, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'database_identity_id', 4, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'subject_actor_id', 5, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'grantee_actor_id', 6, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'management_authority_id', 7, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'authority_generation', 8, 'bigint'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'decision_action', 9, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'ceremony_policy_id', 10, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'ceremony_policy_version', 11, 'smallint'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'trust_manifest_sha256', 12, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'decision_nonce_sha256', 13, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'evidence_sha256', 14, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'decision_sha256', 15, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'not_before', 16, 'timestamp with time zone'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'expires_at', 17, 'timestamp with time zone'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'state', 18, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'lifecycle_revision', 19, 'bigint'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'recorded_by_actor_id', 20, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'recorded_at', 21, 'timestamp with time zone'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'verified_by_actor_id', 22, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, FALSE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'verified_at', 23, 'timestamp with time zone'::REGTYPE, 0::OID, FALSE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'consumed_by_actor_id', 24, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, FALSE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'consumed_at', 25, 'timestamp with time zone'::REGTYPE, 0::OID, FALSE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'revoked_by_actor_id', 26, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, FALSE),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'revoked_at', 27, 'timestamp with time zone'::REGTYPE, 0::OID, FALSE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'schema_version', 1, 'smallint'::REGTYPE, 0::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'tenant_id', 2, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'governance_decision_id', 3, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'decision_sha256', 4, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'attester_slot', 5, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'attester_key_id', 6, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'signature_algorithm', 7, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'signature_base64url', 8, 'text'::REGTYPE, 'pg_catalog.default'::REGCOLLATION::OID, TRUE),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'attested_at', 9, 'timestamp with time zone'::REGTYPE, 0::OID, TRUE)
          ) expected(
            relation_oid,
            column_name,
            ordinal_position,
            type_oid,
            collation_oid,
            not_null
          )
          LEFT JOIN pg_attribute attribute
            ON attribute.attrelid = expected.relation_oid
            AND attribute.attname = expected.column_name
            AND NOT attribute.attisdropped
          WHERE attribute.attname IS NULL
            OR attribute.attnum <> expected.ordinal_position
            OR attribute.atttypid <> expected.type_oid
            OR attribute.attcollation <> expected.collation_oid
            OR attribute.attnotnull IS DISTINCT FROM expected.not_null
            OR attribute.attgenerated <> ''
            OR attribute.attidentity <> ''
        ) OR (
          SELECT count(*)
          FROM pg_attribute
          WHERE attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attnum > 0
            AND NOT attisdropped
        ) <> 27 OR (
          SELECT count(*)
          FROM pg_attribute
          WHERE attrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND attnum > 0
            AND NOT attisdropped
        ) <> 9 THEN
          RAISE EXCEPTION 'Membership bootstrap evidence columns are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_attrdef
          WHERE adrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
        ) <> 5 OR (
          SELECT count(*)
          FROM pg_attrdef
          WHERE adrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
        ) <> 2 OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attribute.attname = 'schema_version'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('1', '1::smallint', '(1)::smallint')
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attribute.attname = 'decision_action'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '''create_held_membership_management_authority''::text'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attribute.attname = 'state'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '''held''::text'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attribute.attname = 'lifecycle_revision'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('0', '0::bigint', '(0)::bigint')
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND attribute.attname = 'recorded_at'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = 'now()'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND attribute.attname = 'schema_version'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) IN ('1', '1::smallint', '(1)::smallint')
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND attribute.attname = 'signature_algorithm'
            AND pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ) = '''ed25519''::text'
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence defaults are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_constraint
          WHERE conrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND contype <> 'n'
        ) <> 15 OR (
          SELECT count(*)
          FROM pg_constraint
          WHERE conrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND contype <> 'n'
        ) <> 5 OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decisions_pkey', 'p'::"char", ARRAY['tenant_id', 'governance_decision_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_identity_nonce_key', 'u'::"char", ARRAY['database_identity_id', 'decision_nonce_sha256']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_identity_digest_key', 'u'::"char", ARRAY['database_identity_id', 'decision_sha256']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_child_binding_key', 'u'::"char", ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_target_binding_key', 'u'::"char", ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256', 'subject_actor_id', 'grantee_actor_id', 'management_authority_id', 'authority_generation']::TEXT[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestations_pkey', 'p'::"char", ARRAY['tenant_id', 'governance_decision_id', 'attester_slot']::TEXT[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_key_key', 'u'::"char", ARRAY['tenant_id', 'governance_decision_id', 'attester_key_id']::TEXT[])
          ) expected(relation_oid, constraint_name, constraint_type, columns)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            JOIN pg_index index_record
              ON index_record.indexrelid = constraint_record.conindid
            JOIN pg_class index_relation
              ON index_relation.oid = index_record.indexrelid
            WHERE constraint_record.conrelid = expected.relation_oid
              AND constraint_record.conname = expected.constraint_name
              AND constraint_record.contype = expected.constraint_type
              AND constraint_record.convalidated
              AND COALESCE(
                (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
                TRUE
              )
              AND NOT constraint_record.condeferrable
              AND NOT constraint_record.condeferred
              AND index_relation.relname = expected.constraint_name
              AND (
                SELECT array_agg(
                  attribute.attname::TEXT ORDER BY key.ordinality
                )
                FROM unnest(constraint_record.conkey)
                  WITH ORDINALITY AS key(attnum, ordinality)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_record.conrelid
                  AND attribute.attnum = key.attnum
                  AND NOT attribute.attisdropped
              ) = expected.columns
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence key constraints are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND constraint_record.conname =
              'omni_mm_bootstrap_decision_row_check'
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) =
              'omni_mm_bootstrap_decision_row_is_valid(schema_version, tenant_id, governance_decision_id, database_identity_id, subject_actor_id, grantee_actor_id, management_authority_id, authority_generation, decision_action, ceremony_policy_id, ceremony_policy_version, trust_manifest_sha256, decision_nonce_sha256, evidence_sha256, decision_sha256, not_before, expires_at, state, lifecycle_revision, recorded_by_actor_id, recorded_at, verified_by_actor_id, verified_at, consumed_by_actor_id, consumed_at, revoked_by_actor_id, revoked_at)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND constraint_record.conname =
              'omni_mm_bootstrap_decision_state_hold_check'
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) = '(state = ''held''::text)'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND constraint_record.conname =
              'omni_mm_bootstrap_attestation_row_check'
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND NOT constraint_record.connoinherit
            AND pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid
            ) =
              'omni_mm_bootstrap_attestation_row_is_valid(schema_version, tenant_id, governance_decision_id, decision_sha256, attester_slot, attester_key_id, signature_algorithm, signature_base64url, attested_at)'
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence check constraints are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_tenant_fkey', ARRAY['tenant_id']::TEXT[], 'omni_auth_tenants'::REGCLASS, ARRAY['id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_database_fkey', ARRAY['database_identity_id']::TEXT[], 'omni_database_identity'::REGCLASS, ARRAY['id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_subject_fkey', ARRAY['subject_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_grantee_fkey', ARRAY['grantee_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_recorded_actor_fkey', ARRAY['recorded_by_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_verified_actor_fkey', ARRAY['verified_by_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_consumed_actor_fkey', ARRAY['consumed_by_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_revoked_actor_fkey', ARRAY['revoked_by_actor_id']::TEXT[], 'omni_auth_users'::REGCLASS, ARRAY['actor_id']::TEXT[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_tenant_fkey', ARRAY['tenant_id']::TEXT[], 'omni_auth_tenants'::REGCLASS, ARRAY['id']::TEXT[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_parent_fkey', ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256']::TEXT[], 'omni_membership_management_bootstrap_decisions'::REGCLASS, ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256']::TEXT[])
          ) expected(
            relation_oid,
            constraint_name,
            local_columns,
            foreign_relation,
            foreign_columns
          )
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_record
            WHERE constraint_record.conrelid = expected.relation_oid
              AND constraint_record.conname = expected.constraint_name
              AND constraint_record.contype = 'f'
              AND constraint_record.convalidated
              AND COALESCE(
                (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
                TRUE
              )
              AND NOT constraint_record.condeferrable
              AND NOT constraint_record.condeferred
              AND constraint_record.confrelid = expected.foreign_relation
              AND constraint_record.confupdtype = 'r'
              AND constraint_record.confdeltype = 'r'
              AND constraint_record.confmatchtype = 's'
              AND (
                SELECT array_agg(
                  attribute.attname::TEXT ORDER BY key.ordinality
                )
                FROM unnest(constraint_record.conkey)
                  WITH ORDINALITY AS key(attnum, ordinality)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_record.conrelid
                  AND attribute.attnum = key.attnum
                  AND NOT attribute.attisdropped
              ) = expected.local_columns
              AND (
                SELECT array_agg(
                  attribute.attname::TEXT ORDER BY key.ordinality
                )
                FROM unnest(constraint_record.confkey)
                  WITH ORDINALITY AS key(attnum, ordinality)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_record.confrelid
                  AND attribute.attnum = key.attnum
                  AND NOT attribute.attisdropped
              ) = expected.foreign_columns
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence references are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_index
          WHERE indrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
        ) <> 5 OR (
          SELECT count(*)
          FROM pg_index
          WHERE indrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
        ) <> 2 OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decisions_pkey', TRUE, ARRAY['tenant_id', 'governance_decision_id']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_identity_nonce_key', FALSE, ARRAY['database_identity_id', 'decision_nonce_sha256']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_identity_digest_key', FALSE, ARRAY['database_identity_id', 'decision_sha256']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_child_binding_key', FALSE, ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[]),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_target_binding_key', FALSE, ARRAY['tenant_id', 'governance_decision_id', 'decision_sha256', 'subject_actor_id', 'grantee_actor_id', 'management_authority_id', 'authority_generation']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.int8_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 0::OID]::OID[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestations_pkey', TRUE, ARRAY['tenant_id', 'governance_decision_id', 'attester_slot']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[]),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_key_key', FALSE, ARRAY['tenant_id', 'governance_decision_id', 'attester_key_id']::TEXT[], ARRAY['pg_catalog.text_ops', 'pg_catalog.text_ops', 'pg_catalog.text_ops']::TEXT[], ARRAY['pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID, 'pg_catalog.default'::REGCOLLATION::OID]::OID[])
          ) expected(
            relation_oid,
            index_name,
            is_primary,
            columns,
            operator_classes,
            collations
          )
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_index index_record
            JOIN pg_class index_relation
              ON index_relation.oid = index_record.indexrelid
            JOIN pg_namespace index_namespace
              ON index_namespace.oid = index_relation.relnamespace
            JOIN pg_am access_method
              ON access_method.oid = index_relation.relam
            WHERE index_record.indrelid = expected.relation_oid
              AND index_relation.relname = expected.index_name
              AND index_namespace.nspname = current_schema()
              AND index_relation.relkind = 'i'
              AND access_method.amname = 'btree'
              AND index_record.indisunique
              AND index_record.indisprimary IS NOT DISTINCT FROM
                expected.is_primary
              AND index_record.indisvalid
              AND index_record.indisready
              AND index_record.indislive
              AND index_record.indimmediate
              AND NOT index_record.indisclustered
              AND NOT index_record.indisreplident
              AND NOT index_record.indisexclusion
              AND index_record.indnkeyatts = cardinality(expected.columns)
              AND index_record.indnatts = cardinality(expected.columns)
              AND index_record.indexprs IS NULL
              AND index_record.indpred IS NULL
              AND (
                SELECT array_agg(
                  attribute.attname::TEXT ORDER BY key.ordinality
                )
                FROM unnest(index_record.indkey)
                  WITH ORDINALITY AS key(attnum, ordinality)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = index_record.indrelid
                  AND attribute.attnum = key.attnum
                  AND NOT attribute.attisdropped
              ) = expected.columns
              AND (
                SELECT array_agg(
                  operator_namespace.nspname || '.' ||
                    operator_class.opcname
                  ORDER BY key.ordinality
                )
                FROM unnest(index_record.indclass)
                  WITH ORDINALITY AS key(operator_class_oid, ordinality)
                JOIN pg_opclass operator_class
                  ON operator_class.oid = key.operator_class_oid
                JOIN pg_namespace operator_namespace
                  ON operator_namespace.oid = operator_class.opcnamespace
              ) = expected.operator_classes
              AND (
                SELECT array_agg(collation_oid ORDER BY key.ordinality)
                FROM unnest(index_record.indcollation)
                  WITH ORDINALITY AS key(collation_oid, ordinality)
              ) = expected.collations
              AND (
                SELECT count(*) = cardinality(expected.columns)
                  AND bool_and(index_option = 0)
                FROM unnest(index_record.indoption)
                  AS options(index_option)
              )
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence indexes are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      DECLARE
        observed_at TIMESTAMPTZ := statement_timestamp();
      BEGIN
        IF public.omni_mm_bootstrap_decision_row_is_valid(
          1::SMALLINT,
          'tenant:v57_check',
          'governance_decision:v57_check',
          '0123456789abcdef0123456789abcdef',
          'actor:v57_subject',
          'actor:v57_grantee',
          'membership_authority:v57_target',
          1::BIGINT,
          'create_held_membership_management_authority',
          'ceremony_policy:v57_check',
          1::SMALLINT,
          repeat('a', 64),
          repeat('b', 64),
          repeat('c', 64),
          repeat('d', 64),
          observed_at - INTERVAL '5 minutes',
          observed_at + INTERVAL '10 minutes',
          'held',
          0::BIGINT,
          'actor:v57_recorder',
          observed_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        ) IS DISTINCT FROM TRUE OR
          public.omni_mm_bootstrap_decision_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            '0123456789abcdef0123456789abcdef',
            'actor:v57_subject',
            'actor:v57_grantee',
            'membership_authority:v57_target',
            1::BIGINT,
            'create_held_membership_management_authority',
            'ceremony_policy:v57_check',
            1::SMALLINT,
            repeat('a', 64),
            repeat('b', 64),
            repeat('c', 64),
            repeat('d', 64),
            observed_at - INTERVAL '5 minutes',
            observed_at + INTERVAL '10 minutes 1 microsecond',
            'held',
            0::BIGINT,
            'actor:v57_recorder',
            observed_at,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL
          ) IS DISTINCT FROM FALSE OR
          public.omni_mm_bootstrap_decision_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            '0123456789abcdef0123456789abcdef',
            'actor:v57_subject',
            'actor:v57_grantee',
            'membership_authority:v57_target',
            1::BIGINT,
            'create_held_membership_management_authority',
            'ceremony_policy:v57_check',
            1::SMALLINT,
            repeat('A', 64),
            repeat('b', 64),
            repeat('c', 64),
            repeat('d', 64),
            observed_at - INTERVAL '5 minutes',
            observed_at + INTERVAL '10 minutes',
            'held',
            0::BIGINT,
            'actor:v57_recorder',
            observed_at,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL
          ) IS DISTINCT FROM FALSE OR
          public.omni_mm_bootstrap_decision_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            '0123456789abcdef0123456789abcdef',
            'actor:v57_subject',
            'actor:v57_grantee',
            'membership_authority:v57_target',
            1::BIGINT,
            'create_held_membership_management_authority',
            'ceremony_policy:v57_check',
            1::SMALLINT,
            repeat('a', 64),
            repeat('b', 64),
            repeat('c', 64),
            repeat('d', 64),
            observed_at - INTERVAL '5 minutes',
            observed_at + INTERVAL '10 minutes',
            'held',
            0::BIGINT,
            'actor:v57_recorder',
            observed_at,
            'actor:v57_verifier',
            observed_at,
            NULL,
            NULL,
            NULL,
            NULL
          ) IS DISTINCT FROM FALSE
        THEN
          RAISE EXCEPTION 'Membership bootstrap decision validator is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF public.omni_mm_bootstrap_attestation_row_is_valid(
          1::SMALLINT,
          'tenant:v57_check',
          'governance_decision:v57_check',
          repeat('d', 64),
          'organization_custodian',
          'attester_key:v57_custodian',
          'ed25519',
          repeat('A', 86),
          observed_at
        ) IS DISTINCT FROM TRUE OR
          public.omni_mm_bootstrap_attestation_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            repeat('d', 64),
            'independent_reviewer',
            'attester_key:v57_reviewer',
            'ed25519',
            repeat('A', 85) || 'w',
            observed_at
          ) IS DISTINCT FROM TRUE OR
          public.omni_mm_bootstrap_attestation_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            repeat('d', 64),
            'independent_reviewer',
            'attester_key:v57_reviewer',
            'ed25519',
            repeat('A', 85) || 'B',
            observed_at
          ) IS DISTINCT FROM FALSE OR
          public.omni_mm_bootstrap_attestation_row_is_valid(
            1::SMALLINT,
            'tenant:v57_check',
            'governance_decision:v57_check',
            repeat('d', 64),
            'tenant_administrator',
            'attester_key:v57_reviewer',
            'ed25519',
            repeat('A', 86),
            observed_at
          ) IS DISTINCT FROM FALSE
        THEN
          RAISE EXCEPTION 'Membership bootstrap attestation validator is invalid'
            USING ERRCODE = '55000';
        END IF;

        IF (
          SELECT count(*)
          FROM pg_proc procedure
          JOIN pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
            AND procedure.proname IN (
              'omni_mm_bootstrap_decision_row_is_valid',
              'omni_mm_bootstrap_attestation_row_is_valid',
              'omni_validate_mm_bootstrap_decision_insert',
              'omni_validate_mm_bootstrap_attestation_insert',
              'omni_protect_mm_bootstrap_decision',
              'omni_protect_mm_bootstrap_attestation'
            )
        ) <> 6 THEN
          RAISE EXCEPTION 'Membership bootstrap evidence function set is invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_mm_bootstrap_decision_row_is_valid(smallint,text,text,text,text,text,text,bigint,text,text,smallint,text,text,text,text,timestamptz,timestamptz,text,bigint,text,timestamptz,text,timestamptz,text,timestamptz,text,timestamptz)'
          )
            AND procedure.prorettype = 'boolean'::regtype
            AND procedure.provolatile = 'i'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'sql'
            AND procedure.prosrc = $expected$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_governance_decision_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_database_identity_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_grantee_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_management_authority_id
        )
        AND candidate_authority_generation BETWEEN 1 AND 9007199254740991
        AND candidate_decision_action =
          'create_held_membership_management_authority'
        AND public.omni_source_contract_id_is_valid(
          candidate_ceremony_policy_id
        )
        AND candidate_ceremony_policy_version BETWEEN 1 AND 32767
        AND candidate_trust_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_decision_nonce_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_evidence_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_decision_sha256 ~ '^[0-9a-f]{64}$'
        AND isfinite(candidate_not_before)
        AND isfinite(candidate_expires_at)
        AND isfinite(candidate_recorded_at)
        AND candidate_expires_at > candidate_not_before
        AND candidate_expires_at <=
          candidate_not_before + INTERVAL '15 minutes'
        AND candidate_recorded_at >= candidate_not_before
        AND candidate_recorded_at < candidate_expires_at
        AND candidate_state = 'held'
        AND candidate_lifecycle_revision = 0
        AND public.omni_source_contract_id_is_valid(
          candidate_recorded_by_actor_id
        )
        AND candidate_verified_by_actor_id IS NULL
        AND candidate_verified_at IS NULL
        AND candidate_consumed_by_actor_id IS NULL
        AND candidate_consumed_at IS NULL
        AND candidate_revoked_by_actor_id IS NULL
        AND candidate_revoked_at IS NULL,
        FALSE
      )
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_mm_bootstrap_attestation_row_is_valid(smallint,text,text,text,text,text,text,text,timestamptz)'
          )
            AND procedure.prorettype = 'boolean'::regtype
            AND procedure.provolatile = 'i'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'sql'
            AND procedure.prosrc = $expected$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_governance_decision_id
        )
        AND candidate_decision_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_attester_slot IN (
          'organization_custodian',
          'independent_reviewer'
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_attester_key_id
        )
        AND candidate_signature_algorithm = 'ed25519'
        AND candidate_signature_base64url ~
          '^[A-Za-z0-9_-]{85}[AQgw]$'
        AND isfinite(candidate_attested_at),
        FALSE
      )
    $expected$
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence row functions are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_validate_mm_bootstrap_decision_insert()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    BEGIN
      NEW.recorded_at := statement_timestamp();

      IF NOT public.omni_mm_bootstrap_decision_row_is_valid(
        NEW.schema_version,
        NEW.tenant_id,
        NEW.governance_decision_id,
        NEW.database_identity_id,
        NEW.subject_actor_id,
        NEW.grantee_actor_id,
        NEW.management_authority_id,
        NEW.authority_generation,
        NEW.decision_action,
        NEW.ceremony_policy_id,
        NEW.ceremony_policy_version,
        NEW.trust_manifest_sha256,
        NEW.decision_nonce_sha256,
        NEW.evidence_sha256,
        NEW.decision_sha256,
        NEW.not_before,
        NEW.expires_at,
        NEW.state,
        NEW.lifecycle_revision,
        NEW.recorded_by_actor_id,
        NEW.recorded_at,
        NEW.verified_by_actor_id,
        NEW.verified_at,
        NEW.consumed_by_actor_id,
        NEW.consumed_at,
        NEW.revoked_by_actor_id,
        NEW.revoked_at
      ) THEN
        RAISE EXCEPTION 'Membership bootstrap decision row is invalid'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_validate_mm_bootstrap_attestation_insert()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    DECLARE
      parent_not_before TIMESTAMPTZ;
      parent_expires_at TIMESTAMPTZ;
      parent_state TEXT;
      parent_lifecycle_revision BIGINT;
      observed_at TIMESTAMPTZ := statement_timestamp();
    BEGIN
      IF NOT public.omni_mm_bootstrap_attestation_row_is_valid(
        NEW.schema_version,
        NEW.tenant_id,
        NEW.governance_decision_id,
        NEW.decision_sha256,
        NEW.attester_slot,
        NEW.attester_key_id,
        NEW.signature_algorithm,
        NEW.signature_base64url,
        NEW.attested_at
      ) THEN
        RAISE EXCEPTION 'Membership bootstrap attestation row is invalid'
          USING ERRCODE = '23514';
      END IF;

      SELECT
        decision.not_before,
        decision.expires_at,
        decision.state,
        decision.lifecycle_revision
      INTO STRICT
        parent_not_before,
        parent_expires_at,
        parent_state,
        parent_lifecycle_revision
      FROM public.omni_membership_management_bootstrap_decisions decision
      WHERE decision.tenant_id = NEW.tenant_id
        AND decision.governance_decision_id = NEW.governance_decision_id
        AND decision.decision_sha256 = NEW.decision_sha256
      FOR KEY SHARE;

      IF parent_state <> 'held' OR parent_lifecycle_revision <> 0 THEN
        RAISE EXCEPTION 'Membership bootstrap decision is not held'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.attested_at < parent_not_before
        OR NEW.attested_at >= parent_expires_at
        OR observed_at < parent_not_before
        OR observed_at >= parent_expires_at
      THEN
        RAISE EXCEPTION 'Membership bootstrap attestation is outside the decision window'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE EXCEPTION 'Membership bootstrap decision does not exist'
          USING ERRCODE = '23503';
      WHEN TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'Membership bootstrap decision binding is ambiguous'
          USING ERRCODE = '23514';
    END
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_protect_mm_bootstrap_decision()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    BEGIN
      RAISE EXCEPTION 'Membership bootstrap decision rows are immutable'
        USING ERRCODE = '55000';
    END
    $expected$
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_language language ON language.oid = procedure.prolang
          WHERE procedure.oid = to_regprocedure(
            'public.omni_protect_mm_bootstrap_attestation()'
          )
            AND procedure.prorettype = 'trigger'::regtype
            AND procedure.provolatile = 'v'
            AND NOT procedure.proisstrict
            AND NOT procedure.prosecdef
            AND NOT procedure.proleakproof
            AND procedure.proconfig =
              ARRAY['search_path=pg_catalog, public']
            AND procedure.proowner = (
              SELECT relowner FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND language.lanname = 'plpgsql'
            AND procedure.prosrc = $expected$
    BEGIN
      RAISE EXCEPTION 'Membership bootstrap attestation rows are immutable'
        USING ERRCODE = '55000';
    END
    $expected$
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence trigger functions are invalid'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;

    await sql`
      DO $migration$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_trigger
          WHERE tgrelid =
              'omni_membership_management_bootstrap_decisions'::regclass
            AND NOT tgisinternal
        ) <> 3 OR (
          SELECT count(*)
          FROM pg_trigger
          WHERE tgrelid =
              'omni_membership_management_bootstrap_attestations'::regclass
            AND NOT tgisinternal
        ) <> 3 OR EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_validate_insert', to_regprocedure('public.omni_validate_mm_bootstrap_decision_insert()'), 7),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_protect', to_regprocedure('public.omni_protect_mm_bootstrap_decision()'), 27),
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_no_truncate', to_regprocedure('public.omni_protect_mm_bootstrap_decision()'), 34),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_validate_insert', to_regprocedure('public.omni_validate_mm_bootstrap_attestation_insert()'), 7),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_protect', to_regprocedure('public.omni_protect_mm_bootstrap_attestation()'), 27),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_no_truncate', to_regprocedure('public.omni_protect_mm_bootstrap_attestation()'), 34)
          ) expected(
            relation_oid,
            trigger_name,
            procedure_oid,
            trigger_type
          )
          WHERE expected.procedure_oid IS NULL OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger trigger_record
            WHERE trigger_record.tgrelid = expected.relation_oid
              AND trigger_record.tgname = expected.trigger_name
              AND NOT trigger_record.tgisinternal
              AND trigger_record.tgenabled = 'O'
              AND trigger_record.tgfoid = expected.procedure_oid
              AND trigger_record.tgtype = expected.trigger_type
              AND trigger_record.tgqual IS NULL
              AND trigger_record.tgnargs = 0
              AND trigger_record.tgconstraint = 0
              AND NOT trigger_record.tgdeferrable
              AND NOT trigger_record.tginitdeferred
              AND trigger_record.tgattr::TEXT = ''
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence triggers are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            VALUES
              ('omni_membership_management_bootstrap_decisions'::REGCLASS, 'omni_mm_bootstrap_decision_holdback'),
              ('omni_membership_management_bootstrap_attestations'::REGCLASS, 'omni_mm_bootstrap_attestation_holdback')
          ) expected(relation_oid, holdback_policy)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            WHERE relation.oid = expected.relation_oid
              AND relation.relrowsecurity
              AND relation.relforcerowsecurity
          ) OR (
            SELECT count(*)
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
          ) <> 2 OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = 'omni_tenant_isolation'
              AND polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_tenant_visible(tenant_id)'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_tenant_visible(tenant_id)'
          ) OR NOT EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = expected.relation_oid
              AND polname = expected.holdback_policy
              AND NOT polpermissive
              AND polcmd = '*'
              AND polroles = ARRAY[0::OID]
              AND pg_get_expr(polqual, polrelid) =
                'omni_system_scope_enabled()'
              AND pg_get_expr(polwithcheck, polrelid) =
                'omni_system_scope_enabled()'
          )
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence policies are invalid'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_membership_management_bootstrap_decisions',
              'omni_membership_management_bootstrap_attestations'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.column_privileges
          WHERE table_schema = current_schema()
            AND table_name IN (
              'omni_membership_management_bootstrap_decisions',
              'omni_membership_management_bootstrap_attestations'
            )
            AND grantee <> current_user
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name IN (
              'omni_mm_bootstrap_decision_row_is_valid',
              'omni_mm_bootstrap_attestation_row_is_valid',
              'omni_validate_mm_bootstrap_decision_insert',
              'omni_validate_mm_bootstrap_attestation_insert',
              'omni_protect_mm_bootstrap_decision',
              'omni_protect_mm_bootstrap_attestation'
            )
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence boundary is exposed'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1 FROM omni_membership_management_bootstrap_decisions
        ) OR EXISTS (
          SELECT 1 FROM omni_membership_management_bootstrap_attestations
        ) THEN
          RAISE EXCEPTION 'Membership bootstrap evidence shadows are not empty'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  };

  await verifyBootstrapEvidencePredecessors();

  const targetRelationState = await sql`
    SELECT
      to_regclass(
        'public.omni_membership_management_bootstrap_decisions'
      ) IS NOT NULL AS decisions_exist,
      to_regclass(
        'public.omni_membership_management_bootstrap_attestations'
      ) IS NOT NULL AS attestations_exist
  `;
  const decisionsExist = targetRelationState[0]?.decisions_exist;
  const attestationsExist = targetRelationState[0]?.attestations_exist;
  if (
    targetRelationState.length !== 1 ||
    typeof decisionsExist !== "boolean" ||
    typeof attestationsExist !== "boolean"
  ) {
    throw new Error("Membership bootstrap evidence retry state is invalid.");
  }

  if (decisionsExist || attestationsExist) {
    if (!decisionsExist || !attestationsExist) {
      throw new Error("Membership bootstrap evidence install is partial.");
    }
    await sql`
      LOCK TABLE
        omni_membership_management_bootstrap_decisions,
        omni_membership_management_bootstrap_attestations
      IN ACCESS EXCLUSIVE MODE
    `;
    await verifyBootstrapEvidenceSurface();
  } else {
    await sql`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_proc procedure
          JOIN pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = current_schema()
            AND procedure.proname IN (
              'omni_mm_bootstrap_decision_row_is_valid',
              'omni_mm_bootstrap_attestation_row_is_valid',
              'omni_validate_mm_bootstrap_decision_insert',
              'omni_validate_mm_bootstrap_attestation_insert',
              'omni_protect_mm_bootstrap_decision',
              'omni_protect_mm_bootstrap_attestation'
            )
        ) OR to_regclass(
          'public.omni_mm_bootstrap_decisions_pkey'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_decision_identity_nonce_key'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_decision_identity_digest_key'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_decision_child_binding_key'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_decision_target_binding_key'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_attestations_pkey'
        ) IS NOT NULL OR to_regclass(
          'public.omni_mm_bootstrap_attestation_key_key'
        ) IS NOT NULL THEN
          RAISE EXCEPTION 'Membership bootstrap evidence install is partial'
            USING ERRCODE = '55000';
        END IF;
      END
      $migration$
    `;
  }

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_mm_bootstrap_decision_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_tenant_id TEXT,
        candidate_governance_decision_id TEXT,
        candidate_database_identity_id TEXT,
        candidate_subject_actor_id TEXT,
        candidate_grantee_actor_id TEXT,
        candidate_management_authority_id TEXT,
        candidate_authority_generation BIGINT,
        candidate_decision_action TEXT,
        candidate_ceremony_policy_id TEXT,
        candidate_ceremony_policy_version SMALLINT,
        candidate_trust_manifest_sha256 TEXT,
        candidate_decision_nonce_sha256 TEXT,
        candidate_evidence_sha256 TEXT,
        candidate_decision_sha256 TEXT,
        candidate_not_before TIMESTAMPTZ,
        candidate_expires_at TIMESTAMPTZ,
        candidate_state TEXT,
        candidate_lifecycle_revision BIGINT,
        candidate_recorded_by_actor_id TEXT,
        candidate_recorded_at TIMESTAMPTZ,
        candidate_verified_by_actor_id TEXT,
        candidate_verified_at TIMESTAMPTZ,
        candidate_consumed_by_actor_id TEXT,
        candidate_consumed_at TIMESTAMPTZ,
        candidate_revoked_by_actor_id TEXT,
        candidate_revoked_at TIMESTAMPTZ
      )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_governance_decision_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_database_identity_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_grantee_actor_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_management_authority_id
        )
        AND candidate_authority_generation BETWEEN 1 AND 9007199254740991
        AND candidate_decision_action =
          'create_held_membership_management_authority'
        AND public.omni_source_contract_id_is_valid(
          candidate_ceremony_policy_id
        )
        AND candidate_ceremony_policy_version BETWEEN 1 AND 32767
        AND candidate_trust_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_decision_nonce_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_evidence_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_decision_sha256 ~ '^[0-9a-f]{64}$'
        AND isfinite(candidate_not_before)
        AND isfinite(candidate_expires_at)
        AND isfinite(candidate_recorded_at)
        AND candidate_expires_at > candidate_not_before
        AND candidate_expires_at <=
          candidate_not_before + INTERVAL '15 minutes'
        AND candidate_recorded_at >= candidate_not_before
        AND candidate_recorded_at < candidate_expires_at
        AND candidate_state = 'held'
        AND candidate_lifecycle_revision = 0
        AND public.omni_source_contract_id_is_valid(
          candidate_recorded_by_actor_id
        )
        AND candidate_verified_by_actor_id IS NULL
        AND candidate_verified_at IS NULL
        AND candidate_consumed_by_actor_id IS NULL
        AND candidate_consumed_at IS NULL
        AND candidate_revoked_by_actor_id IS NULL
        AND candidate_revoked_at IS NULL,
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_mm_bootstrap_attestation_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_tenant_id TEXT,
        candidate_governance_decision_id TEXT,
        candidate_decision_sha256 TEXT,
        candidate_attester_slot TEXT,
        candidate_attester_key_id TEXT,
        candidate_signature_algorithm TEXT,
        candidate_signature_base64url TEXT,
        candidate_attested_at TIMESTAMPTZ
      )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_governance_decision_id
        )
        AND candidate_decision_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_attester_slot IN (
          'organization_custodian',
          'independent_reviewer'
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_attester_key_id
        )
        AND candidate_signature_algorithm = 'ed25519'
        AND candidate_signature_base64url ~
          '^[A-Za-z0-9_-]{85}[AQgw]$'
        AND isfinite(candidate_attested_at),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS
      omni_membership_management_bootstrap_decisions (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        tenant_id TEXT NOT NULL,
        governance_decision_id TEXT NOT NULL,
        database_identity_id TEXT NOT NULL,
        subject_actor_id TEXT NOT NULL,
        grantee_actor_id TEXT NOT NULL,
        management_authority_id TEXT NOT NULL,
        authority_generation BIGINT NOT NULL,
        decision_action TEXT NOT NULL DEFAULT
          'create_held_membership_management_authority',
        ceremony_policy_id TEXT NOT NULL,
        ceremony_policy_version SMALLINT NOT NULL,
        trust_manifest_sha256 TEXT NOT NULL,
        decision_nonce_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        decision_sha256 TEXT NOT NULL,
        not_before TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        state TEXT NOT NULL DEFAULT 'held',
        lifecycle_revision BIGINT NOT NULL DEFAULT 0,
        recorded_by_actor_id TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_by_actor_id TEXT,
        verified_at TIMESTAMPTZ,
        consumed_by_actor_id TEXT,
        consumed_at TIMESTAMPTZ,
        revoked_by_actor_id TEXT,
        revoked_at TIMESTAMPTZ,
        CONSTRAINT omni_mm_bootstrap_decisions_pkey
          PRIMARY KEY (tenant_id, governance_decision_id),
        CONSTRAINT omni_mm_bootstrap_decision_identity_nonce_key
          UNIQUE (database_identity_id, decision_nonce_sha256),
        CONSTRAINT omni_mm_bootstrap_decision_identity_digest_key
          UNIQUE (database_identity_id, decision_sha256),
        CONSTRAINT omni_mm_bootstrap_decision_child_binding_key
          UNIQUE (
            tenant_id,
            governance_decision_id,
            decision_sha256
          ),
        CONSTRAINT omni_mm_bootstrap_decision_target_binding_key
          UNIQUE (
            tenant_id,
            governance_decision_id,
            decision_sha256,
            subject_actor_id,
            grantee_actor_id,
            management_authority_id,
            authority_generation
          ),
        CONSTRAINT omni_mm_bootstrap_decision_row_check CHECK (
          omni_mm_bootstrap_decision_row_is_valid(
            schema_version,
            tenant_id,
            governance_decision_id,
            database_identity_id,
            subject_actor_id,
            grantee_actor_id,
            management_authority_id,
            authority_generation,
            decision_action,
            ceremony_policy_id,
            ceremony_policy_version,
            trust_manifest_sha256,
            decision_nonce_sha256,
            evidence_sha256,
            decision_sha256,
            not_before,
            expires_at,
            state,
            lifecycle_revision,
            recorded_by_actor_id,
            recorded_at,
            verified_by_actor_id,
            verified_at,
            consumed_by_actor_id,
            consumed_at,
            revoked_by_actor_id,
            revoked_at
          )
        ),
        CONSTRAINT omni_mm_bootstrap_decision_state_hold_check
          CHECK (state = 'held'),
        CONSTRAINT omni_mm_bootstrap_decision_tenant_fkey
          FOREIGN KEY (tenant_id)
          REFERENCES omni_auth_tenants (id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_database_fkey
          FOREIGN KEY (database_identity_id)
          REFERENCES omni_database_identity (id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_subject_fkey
          FOREIGN KEY (subject_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_grantee_fkey
          FOREIGN KEY (grantee_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_recorded_actor_fkey
          FOREIGN KEY (recorded_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_verified_actor_fkey
          FOREIGN KEY (verified_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_consumed_actor_fkey
          FOREIGN KEY (consumed_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_decision_revoked_actor_fkey
          FOREIGN KEY (revoked_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS
      omni_membership_management_bootstrap_attestations (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        tenant_id TEXT NOT NULL,
        governance_decision_id TEXT NOT NULL,
        decision_sha256 TEXT NOT NULL,
        attester_slot TEXT NOT NULL,
        attester_key_id TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL DEFAULT 'ed25519',
        signature_base64url TEXT NOT NULL,
        attested_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT omni_mm_bootstrap_attestations_pkey
          PRIMARY KEY (
            tenant_id,
            governance_decision_id,
            attester_slot
          ),
        CONSTRAINT omni_mm_bootstrap_attestation_key_key
          UNIQUE (
            tenant_id,
            governance_decision_id,
            attester_key_id
          ),
        CONSTRAINT omni_mm_bootstrap_attestation_row_check CHECK (
          omni_mm_bootstrap_attestation_row_is_valid(
            schema_version,
            tenant_id,
            governance_decision_id,
            decision_sha256,
            attester_slot,
            attester_key_id,
            signature_algorithm,
            signature_base64url,
            attested_at
          )
        ),
        CONSTRAINT omni_mm_bootstrap_attestation_tenant_fkey
          FOREIGN KEY (tenant_id)
          REFERENCES omni_auth_tenants (id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT,
        CONSTRAINT omni_mm_bootstrap_attestation_parent_fkey
          FOREIGN KEY (
            tenant_id,
            governance_decision_id,
            decision_sha256
          )
          REFERENCES omni_membership_management_bootstrap_decisions (
            tenant_id,
            governance_decision_id,
            decision_sha256
          )
          ON UPDATE RESTRICT
          ON DELETE RESTRICT
      )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_validate_mm_bootstrap_decision_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      NEW.recorded_at := statement_timestamp();

      IF NOT public.omni_mm_bootstrap_decision_row_is_valid(
        NEW.schema_version,
        NEW.tenant_id,
        NEW.governance_decision_id,
        NEW.database_identity_id,
        NEW.subject_actor_id,
        NEW.grantee_actor_id,
        NEW.management_authority_id,
        NEW.authority_generation,
        NEW.decision_action,
        NEW.ceremony_policy_id,
        NEW.ceremony_policy_version,
        NEW.trust_manifest_sha256,
        NEW.decision_nonce_sha256,
        NEW.evidence_sha256,
        NEW.decision_sha256,
        NEW.not_before,
        NEW.expires_at,
        NEW.state,
        NEW.lifecycle_revision,
        NEW.recorded_by_actor_id,
        NEW.recorded_at,
        NEW.verified_by_actor_id,
        NEW.verified_at,
        NEW.consumed_by_actor_id,
        NEW.consumed_at,
        NEW.revoked_by_actor_id,
        NEW.revoked_at
      ) THEN
        RAISE EXCEPTION 'Membership bootstrap decision row is invalid'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION
      omni_validate_mm_bootstrap_attestation_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      parent_not_before TIMESTAMPTZ;
      parent_expires_at TIMESTAMPTZ;
      parent_state TEXT;
      parent_lifecycle_revision BIGINT;
      observed_at TIMESTAMPTZ := statement_timestamp();
    BEGIN
      IF NOT public.omni_mm_bootstrap_attestation_row_is_valid(
        NEW.schema_version,
        NEW.tenant_id,
        NEW.governance_decision_id,
        NEW.decision_sha256,
        NEW.attester_slot,
        NEW.attester_key_id,
        NEW.signature_algorithm,
        NEW.signature_base64url,
        NEW.attested_at
      ) THEN
        RAISE EXCEPTION 'Membership bootstrap attestation row is invalid'
          USING ERRCODE = '23514';
      END IF;

      SELECT
        decision.not_before,
        decision.expires_at,
        decision.state,
        decision.lifecycle_revision
      INTO STRICT
        parent_not_before,
        parent_expires_at,
        parent_state,
        parent_lifecycle_revision
      FROM public.omni_membership_management_bootstrap_decisions decision
      WHERE decision.tenant_id = NEW.tenant_id
        AND decision.governance_decision_id = NEW.governance_decision_id
        AND decision.decision_sha256 = NEW.decision_sha256
      FOR KEY SHARE;

      IF parent_state <> 'held' OR parent_lifecycle_revision <> 0 THEN
        RAISE EXCEPTION 'Membership bootstrap decision is not held'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.attested_at < parent_not_before
        OR NEW.attested_at >= parent_expires_at
        OR observed_at < parent_not_before
        OR observed_at >= parent_expires_at
      THEN
        RAISE EXCEPTION 'Membership bootstrap attestation is outside the decision window'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE EXCEPTION 'Membership bootstrap decision does not exist'
          USING ERRCODE = '23503';
      WHEN TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'Membership bootstrap decision binding is ambiguous'
          USING ERRCODE = '23514';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_mm_bootstrap_decision()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Membership bootstrap decision rows are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_mm_bootstrap_attestation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Membership bootstrap attestation rows are immutable'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
          AND tgname = 'omni_mm_bootstrap_decision_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_decision_validate_insert
        BEFORE INSERT
        ON omni_membership_management_bootstrap_decisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_mm_bootstrap_decision_insert();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
          AND tgname = 'omni_mm_bootstrap_decision_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_decision_protect
        BEFORE UPDATE OR DELETE
        ON omni_membership_management_bootstrap_decisions
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_mm_bootstrap_decision();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
          AND tgname = 'omni_mm_bootstrap_decision_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_decision_no_truncate
        BEFORE TRUNCATE
        ON omni_membership_management_bootstrap_decisions
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_mm_bootstrap_decision();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
          AND tgname = 'omni_mm_bootstrap_attestation_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_attestation_validate_insert
        BEFORE INSERT
        ON omni_membership_management_bootstrap_attestations
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_mm_bootstrap_attestation_insert();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
          AND tgname = 'omni_mm_bootstrap_attestation_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_attestation_protect
        BEFORE UPDATE OR DELETE
        ON omni_membership_management_bootstrap_attestations
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_mm_bootstrap_attestation();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
          AND tgname = 'omni_mm_bootstrap_attestation_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_mm_bootstrap_attestation_no_truncate
        BEFORE TRUNCATE
        ON omni_membership_management_bootstrap_attestations
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_mm_bootstrap_attestation();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE
      omni_membership_management_bootstrap_decisions,
      omni_membership_management_bootstrap_attestations
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_mm_bootstrap_decision_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
      SMALLINT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT,
      BIGINT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ,
      TEXT, TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_mm_bootstrap_attestation_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_mm_bootstrap_decision_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_mm_bootstrap_attestation_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_mm_bootstrap_decision()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_mm_bootstrap_attestation()
    FROM PUBLIC
  `);

  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT table_name, grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_membership_management_bootstrap_decisions',
            'omni_membership_management_bootstrap_attestations'
          )
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.%I FROM %I',
          current_schema(),
          grant_record.table_name,
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT table_name, grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_membership_management_bootstrap_decisions',
            'omni_membership_management_bootstrap_attestations'
          )
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %I.%I FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          grant_record.table_name,
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_mm_bootstrap_decision_row_is_valid',
            'omni_mm_bootstrap_attestation_row_is_valid',
            'omni_validate_mm_bootstrap_decision_insert',
            'omni_validate_mm_bootstrap_attestation_insert',
            'omni_protect_mm_bootstrap_decision',
            'omni_protect_mm_bootstrap_attestation'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_mm_bootstrap_decision_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, ' ||
          'TEXT, TEXT, SMALLINT, TEXT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, ' ||
          'TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, ' ||
          'TEXT, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_mm_bootstrap_attestation_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_mm_bootstrap_decision_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_mm_bootstrap_attestation_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_mm_bootstrap_decision() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_mm_bootstrap_attestation() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_membership_management_bootstrap_decisions
      ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_membership_management_bootstrap_decisions
      FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_membership_management_bootstrap_attestations
      ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_membership_management_bootstrap_attestations
      FORCE ROW LEVEL SECURITY
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
          AND polname = 'omni_tenant_isolation'
      ) THEN
        ALTER POLICY omni_tenant_isolation
        ON omni_membership_management_bootstrap_decisions
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      ELSE
        CREATE POLICY omni_tenant_isolation
        ON omni_membership_management_bootstrap_decisions
        FOR ALL
        TO PUBLIC
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
          AND polname = 'omni_tenant_isolation'
      ) THEN
        ALTER POLICY omni_tenant_isolation
        ON omni_membership_management_bootstrap_attestations
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      ELSE
        CREATE POLICY omni_tenant_isolation
        ON omni_membership_management_bootstrap_attestations
        FOR ALL
        TO PUBLIC
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_membership_management_bootstrap_decisions'::regclass
          AND polname = 'omni_mm_bootstrap_decision_holdback'
      ) THEN
        CREATE POLICY omni_mm_bootstrap_decision_holdback
        ON omni_membership_management_bootstrap_decisions
        AS RESTRICTIVE
        FOR ALL
        TO PUBLIC
        USING (omni_system_scope_enabled())
        WITH CHECK (omni_system_scope_enabled());
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_membership_management_bootstrap_attestations'::regclass
          AND polname = 'omni_mm_bootstrap_attestation_holdback'
      ) THEN
        CREATE POLICY omni_mm_bootstrap_attestation_holdback
        ON omni_membership_management_bootstrap_attestations
        AS RESTRICTIVE
        FOR ALL
        TO PUBLIC
        USING (omni_system_scope_enabled())
        WITH CHECK (omni_system_scope_enabled());
      END IF;
    END
    $migration$
  `;

  await verifyBootstrapEvidenceSurface();
  await verifyBootstrapEvidencePredecessors();
}

export async function ensureTenantExecutionPrincipalsShadow(sql: SqlClient) {
  // v60 reserves stable agent and actor-bound system security identities. It
  // enrolls nobody, grants no serving access, and leaves the memory resolver
  // and v43/v45 activation holds closed.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Execution principal migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;

  await sql`
    LOCK TABLE
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships,
      omni_auth_user_actor_identifiers,
      omni_custom_agents,
      omni_memories
    IN SHARE MODE
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version IS NOT NULL
          AND version = 59
          AND name = 'memory_deletion_scrub_lease_contract'
          AND checksum =
            'af5d06d4321e7e859f49c4edc7092f819954240b1d566fb79eadc22ef84874af'
      ) <> 1 THEN
        RAISE EXCEPTION 'Execution principal v59 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_access_enrollment_hold_check'
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR to_regprocedure(
        'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
      ) IS NULL THEN
        RAISE EXCEPTION 'Execution principal memory activation predecessor changed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Execution principal memory authorization hook is exposed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_custom_agents_tenant_id_id_key
    ON omni_custom_agents (tenant_id, id)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_execution_principal_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_principal_kind TEXT,
      candidate_principal_id TEXT,
      candidate_principal_generation BIGINT,
      candidate_controller_actor_id TEXT,
      candidate_agent_definition_id TEXT,
      candidate_system_principal_class TEXT,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_activated_at TIMESTAMPTZ,
      candidate_revoked_at TIMESTAMPTZ,
      candidate_updated_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND candidate_principal_kind IN ('agent', 'system')
        AND public.omni_source_contract_id_is_valid(candidate_principal_id)
        AND candidate_principal_generation BETWEEN 1 AND 9007199254740991
        AND candidate_controller_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          (
            candidate_principal_kind = 'agent'
            AND candidate_principal_id ~
              '^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND public.omni_source_contract_id_is_valid(
              candidate_agent_definition_id
            )
            AND candidate_system_principal_class IS NULL
          )
          OR (
            candidate_principal_kind = 'system'
            AND candidate_principal_id ~
              '^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_agent_definition_id IS NULL
            AND candidate_system_principal_class IN (
              'worker', 'scheduler', 'workflow', 'connector',
              'internal_service'
            )
          )
        )
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND candidate_created_by_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          candidate_activated_by_actor_id IS NULL
          OR candidate_activated_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR candidate_revoked_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_activated_at IS NULL
                AND candidate_lifecycle_revision = 1
              ) OR (
                candidate_activated_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_created_at <= candidate_activated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_created_at <= candidate_revoked_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at <= candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_execution_principals (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_generation BIGINT NOT NULL,
      controller_actor_id TEXT NOT NULL,
      agent_definition_id TEXT,
      system_principal_class TEXT,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_execution_principals_pkey
        PRIMARY KEY (tenant_id, principal_id, principal_generation),
      CONSTRAINT omni_execution_principal_row_check CHECK (
        omni_execution_principal_row_is_valid(
          schema_version, tenant_id, principal_kind, principal_id,
          principal_generation, controller_actor_id, agent_definition_id,
          system_principal_class, state, lifecycle_revision,
          created_by_actor_id, activated_by_actor_id, revoked_by_actor_id,
          created_at, activated_at, revoked_at, updated_at
        )
      ),
      CONSTRAINT omni_execution_principal_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_execution_principal_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_execution_principal_controller_fkey
        FOREIGN KEY (controller_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_execution_principal_created_actor_fkey
        FOREIGN KEY (created_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_execution_principal_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_execution_principal_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_execution_principal_agent_definition_fkey
        FOREIGN KEY (tenant_id, agent_definition_id)
        REFERENCES omni_custom_agents (tenant_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_execution_principals_current_idx
    ON omni_tenant_execution_principals (tenant_id, principal_id)
    WHERE state <> 'revoked'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_execution_principals_controller_idx
    ON omni_tenant_execution_principals (
      tenant_id, controller_actor_id, principal_kind, state, principal_id
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_execution_principal_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_generation BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.principal_id)
      );
      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Execution principals must start held'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.principal_kind = 'agent' AND NOT EXISTS (
        SELECT 1
        FROM public.omni_custom_agents definition
        JOIN public.omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier COLLATE "C" =
            definition.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = NEW.controller_actor_id
        WHERE definition.tenant_id = NEW.tenant_id
          AND definition.id = NEW.agent_definition_id
      ) THEN
        RAISE EXCEPTION 'Agent principal controller does not own its definition'
          USING ERRCODE = '23503';
      END IF;

      SELECT COALESCE(MAX(principal_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_execution_principals
      WHERE tenant_id = NEW.tenant_id
        AND principal_id = NEW.principal_id;
      IF NEW.principal_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Execution principal generation is not next'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_execution_principals
        WHERE tenant_id = NEW.tenant_id
          AND principal_id = NEW.principal_id
          AND state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Execution principal already has a current generation'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_execution_principal()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      transition_at TIMESTAMPTZ;
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Execution principal rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.principal_id)
      );
      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked execution principals are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF ROW(
        NEW.schema_version, NEW.tenant_id, NEW.principal_kind,
        NEW.principal_id, NEW.principal_generation,
        NEW.controller_actor_id, NEW.agent_definition_id,
        NEW.system_principal_class, NEW.created_by_actor_id, NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.schema_version, OLD.tenant_id, OLD.principal_kind,
        OLD.principal_id, OLD.principal_generation,
        OLD.controller_actor_id, OLD.agent_definition_id,
        OLD.system_principal_class, OLD.created_by_actor_id, OLD.created_at
      ) THEN
        RAISE EXCEPTION 'Execution principal identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) OR NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision + 1
      THEN
        RAISE EXCEPTION 'Execution principal transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;
      IF NEW.state = 'active' THEN
        IF NEW.activated_by_actor_id IS NULL
          OR NEW.revoked_by_actor_id IS NOT NULL
          OR NEW.revoked_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Execution principal activation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.activated_at := transition_at;
      ELSE
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Execution principal revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
        IF OLD.activated_at IS NULL THEN
          NEW.activated_by_actor_id := NULL;
          NEW.activated_at := NULL;
        ELSE
          NEW.activated_by_actor_id := OLD.activated_by_actor_id;
          NEW.activated_at := OLD.activated_at;
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_execution_principals'::regclass
          AND tgname = 'omni_execution_principal_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_execution_principal_validate_insert
        BEFORE INSERT ON omni_tenant_execution_principals
        FOR EACH ROW EXECUTE FUNCTION omni_validate_execution_principal_insert();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_execution_principals'::regclass
          AND tgname = 'omni_execution_principal_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_execution_principal_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_execution_principals
        FOR EACH ROW EXECUTE FUNCTION omni_protect_execution_principal();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_execution_principals'::regclass
          AND tgname = 'omni_execution_principal_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_execution_principal_no_truncate
        BEFORE TRUNCATE ON omni_tenant_execution_principals
        FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_execution_principal();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_tenant_execution_principals FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL ON FUNCTION omni_execution_principal_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT,
      TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL ON FUNCTION omni_validate_execution_principal_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL ON FUNCTION omni_protect_execution_principal() FROM PUBLIC
  `);

  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_execution_principals'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_execution_principals FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_execution_principal_row_is_valid',
            'omni_validate_execution_principal_insert',
            'omni_protect_execution_principal'
          )
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_execution_principal_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, ' ||
          'BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_execution_principal_insert() FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_execution_principal() FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_execution_principals ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_execution_principals FORCE ROW LEVEL SECURITY
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation
    ON omni_tenant_execution_principals
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_execution_principal_holdback
    ON omni_tenant_execution_principals
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM omni_tenant_execution_principals) THEN
        RAISE EXCEPTION 'Execution principal shadow must start empty'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_tenant_execution_principals'::regclass
          AND relkind = 'r'
          AND relpersistence = 'p'
          AND relrowsecurity
          AND relforcerowsecurity
          AND relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_tenant_execution_principals'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_tenant_execution_principals'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_tenant_execution_principals'::regclass
          AND polname = 'omni_execution_principal_holdback'
          AND NOT polpermissive
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
      ) THEN
        RAISE EXCEPTION 'Execution principal isolation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_execution_principals'::regclass
          AND conname = 'omni_execution_principal_activation_hold_check'
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_execution_principals'::regclass
          AND conname = 'omni_execution_principal_row_check'
          AND contype = 'c'
          AND convalidated
      ) THEN
        RAISE EXCEPTION 'Execution principal row holds are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_execution_principals'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_execution_principals'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_execution_principal_row_is_valid',
            'omni_validate_execution_principal_insert',
            'omni_protect_execution_principal'
          )
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Execution principal shadow grants non-owner access'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_execution_principals'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'omni_execution_principal_validate_insert',
            'omni_execution_principal_protect',
            'omni_execution_principal_no_truncate'
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Execution principal lifecycle triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_index
        WHERE indexrelid =
          'omni_custom_agents_tenant_id_id_key'::regclass
          AND indrelid = 'omni_custom_agents'::regclass
          AND indisunique AND indisvalid AND indisready
      ) THEN
        RAISE EXCEPTION 'Execution principal agent definition key is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantWorkspaceMembershipAuthorityShadow(sql: SqlClient) {
  // v61 creates the canonical workspace and membership authorization inputs
  // without creating a workspace, inferring tenant members, or enabling an
  // authorization decision. Both active states remain constraint-held.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Workspace authority migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;
  await sql`
    LOCK TABLE
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships,
      omni_tenant_execution_principals,
      omni_memories
    IN SHARE MODE
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM omni_schema_version
        WHERE version = 60
          AND name = 'tenant_execution_principals_shadow'
          AND checksum =
            '7dfb17572f071bed7a483156a531fb69234cad2ccf71422a26147e0c63137d8e'
      ) <> 1 THEN
        RAISE EXCEPTION 'Workspace authority v60 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_execution_principals'::regclass
          AND conname = 'omni_execution_principal_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_access_enrollment_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Workspace authority activation predecessors changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_workspace_authority_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_workspace_id TEXT,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_archived_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_activated_at TIMESTAMPTZ,
      candidate_archived_at TIMESTAMPTZ,
      candidate_updated_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND candidate_workspace_id ~
          '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
        AND candidate_state IN ('held', 'active', 'archived')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND candidate_created_by_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          candidate_activated_by_actor_id IS NULL
          OR candidate_activated_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (
          candidate_archived_by_actor_id IS NULL
          OR candidate_archived_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_archived_by_actor_id IS NULL) =
          (candidate_archived_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_archived_at IS NULL
          ) OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_archived_at IS NULL
          ) OR (
            candidate_state = 'archived'
            AND candidate_archived_at IS NOT NULL
            AND (
              (candidate_activated_at IS NULL AND candidate_lifecycle_revision = 1)
              OR
              (candidate_activated_at IS NOT NULL AND candidate_lifecycle_revision = 2)
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at BETWEEN candidate_created_at AND candidate_updated_at
        )
        AND (
          candidate_archived_at IS NULL
          OR candidate_archived_at BETWEEN candidate_created_at AND candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL OR candidate_archived_at IS NULL
          OR candidate_activated_at <= candidate_archived_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_workspace_membership_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_workspace_id TEXT,
      candidate_subject_kind TEXT,
      candidate_subject_key TEXT,
      candidate_subject_actor_id TEXT,
      candidate_subject_execution_principal_id TEXT,
      candidate_subject_execution_principal_generation BIGINT,
      candidate_membership_generation BIGINT,
      candidate_access_level TEXT,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_activated_at TIMESTAMPTZ,
      candidate_revoked_at TIMESTAMPTZ,
      candidate_updated_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND candidate_workspace_id ~
          '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
        AND candidate_subject_kind IN ('user', 'agent', 'system')
        AND public.omni_source_contract_id_is_valid(candidate_subject_key)
        AND (
          (
            candidate_subject_kind = 'user'
            AND candidate_subject_key = candidate_subject_actor_id
            AND candidate_subject_actor_id ~
              '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND candidate_subject_execution_principal_id IS NULL
            AND candidate_subject_execution_principal_generation IS NULL
          ) OR (
            candidate_subject_kind = 'agent'
            AND candidate_subject_actor_id IS NULL
            AND candidate_subject_key = candidate_subject_execution_principal_id
            AND candidate_subject_execution_principal_id ~
              '^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_subject_execution_principal_generation
              BETWEEN 1 AND 9007199254740991
          ) OR (
            candidate_subject_kind = 'system'
            AND candidate_subject_actor_id IS NULL
            AND candidate_subject_key = candidate_subject_execution_principal_id
            AND candidate_subject_execution_principal_id ~
              '^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_subject_execution_principal_generation
              BETWEEN 1 AND 9007199254740991
          )
        )
        AND candidate_membership_generation BETWEEN 1 AND 9007199254740991
        AND candidate_access_level IN ('reader', 'contributor', 'manager')
        AND candidate_state IN ('held', 'active', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND candidate_created_by_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          candidate_activated_by_actor_id IS NULL
          OR candidate_activated_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR candidate_revoked_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'active'
            AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (candidate_activated_at IS NULL AND candidate_lifecycle_revision = 1)
              OR
              (candidate_activated_at IS NOT NULL AND candidate_lifecycle_revision = 2)
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at BETWEEN candidate_created_at AND candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at BETWEEN candidate_created_at AND candidate_updated_at
        )
        AND (
          candidate_activated_at IS NULL OR candidate_revoked_at IS NULL
          OR candidate_activated_at <= candidate_revoked_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_workspaces (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      archived_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_workspaces_pkey PRIMARY KEY (tenant_id, workspace_id),
      CONSTRAINT omni_workspace_authority_row_check CHECK (
        omni_workspace_authority_row_is_valid(
          schema_version, tenant_id, workspace_id, state, lifecycle_revision,
          created_by_actor_id, activated_by_actor_id, archived_by_actor_id,
          created_at, activated_at, archived_at, updated_at
        )
      ),
      CONSTRAINT omni_workspace_activation_hold_check CHECK (state <> 'active'),
      CONSTRAINT omni_workspace_tenant_fkey FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_created_actor_fkey FOREIGN KEY (created_by_actor_id)
        REFERENCES omni_auth_users (actor_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_activated_actor_fkey FOREIGN KEY (activated_by_actor_id)
        REFERENCES omni_auth_users (actor_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_archived_actor_fkey FOREIGN KEY (archived_by_actor_id)
        REFERENCES omni_auth_users (actor_id) ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_workspace_memberships (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      subject_actor_id TEXT,
      subject_execution_principal_id TEXT,
      subject_execution_principal_generation BIGINT,
      membership_generation BIGINT NOT NULL,
      access_level TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_workspace_memberships_pkey PRIMARY KEY (
        tenant_id, workspace_id, subject_key, membership_generation
      ),
      CONSTRAINT omni_workspace_membership_row_check CHECK (
        omni_workspace_membership_row_is_valid(
          schema_version, tenant_id, workspace_id, subject_kind, subject_key,
          subject_actor_id, subject_execution_principal_id,
          subject_execution_principal_generation, membership_generation,
          access_level, state, lifecycle_revision, created_by_actor_id,
          activated_by_actor_id, revoked_by_actor_id, created_at, activated_at,
          revoked_at, updated_at
        )
      ),
      CONSTRAINT omni_workspace_membership_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_workspace_membership_workspace_fkey
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_membership_subject_actor_fkey
        FOREIGN KEY (subject_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_membership_subject_principal_fkey
        FOREIGN KEY (
          tenant_id, subject_execution_principal_id,
          subject_execution_principal_generation
        ) REFERENCES omni_tenant_execution_principals (
          tenant_id, principal_id, principal_generation
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_membership_created_actor_fkey
        FOREIGN KEY (created_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_membership_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_workspace_membership_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_workspace_memberships_current_idx
    ON omni_tenant_workspace_memberships (
      tenant_id, workspace_id, subject_key
    ) WHERE state <> 'revoked'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_workspace_memberships_subject_idx
    ON omni_tenant_workspace_memberships (
      tenant_id, subject_kind, subject_key, workspace_id, state
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_has_active_tenant_membership(
      candidate_tenant_id TEXT,
      candidate_actor_id TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM public.omni_auth_users auth_user
        JOIN public.omni_auth_memberships membership
          ON membership.user_id = auth_user.id
        WHERE auth_user.actor_id = candidate_actor_id
          AND auth_user.status = 'active'
          AND membership.tenant_id = candidate_tenant_id
          AND membership.status = 'active'
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_workspace_authority_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF NEW.state <> 'held' OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.archived_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL OR NEW.archived_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Workspace authorities must start held'
          USING ERRCODE = '23514';
      END IF;
      IF NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.created_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Workspace creator lacks active tenant membership'
          USING ERRCODE = '23503';
      END IF;
      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_workspace_membership_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_generation BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id || ':' || NEW.workspace_id),
        hashtext(NEW.subject_key)
      );
      IF NEW.state <> 'held' OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Workspace memberships must start held'
          USING ERRCODE = '23514';
      END IF;
      IF NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.created_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Workspace membership creator lacks active tenant membership'
          USING ERRCODE = '23503';
      END IF;
      IF NEW.subject_kind = 'user' AND NOT
        public.omni_actor_has_active_tenant_membership(
          NEW.tenant_id, NEW.subject_actor_id
        )
      THEN
        RAISE EXCEPTION 'Workspace user lacks active tenant membership'
          USING ERRCODE = '23503';
      END IF;
      IF NEW.subject_kind IN ('agent', 'system') AND NOT EXISTS (
        SELECT 1
        FROM public.omni_tenant_execution_principals principal
        WHERE principal.tenant_id = NEW.tenant_id
          AND principal.principal_id = NEW.subject_execution_principal_id
          AND principal.principal_generation =
            NEW.subject_execution_principal_generation
          AND principal.principal_kind = NEW.subject_kind
          AND principal.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Workspace execution principal is unavailable'
          USING ERRCODE = '23503';
      END IF;
      SELECT COALESCE(MAX(membership_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_workspace_memberships
      WHERE tenant_id = NEW.tenant_id
        AND workspace_id = NEW.workspace_id
        AND subject_key = NEW.subject_key;
      IF NEW.membership_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Workspace membership generation is not next'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.omni_tenant_workspace_memberships
        WHERE tenant_id = NEW.tenant_id
          AND workspace_id = NEW.workspace_id
          AND subject_key = NEW.subject_key
          AND state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Workspace subject already has a current membership'
          USING ERRCODE = '23514';
      END IF;
      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_workspace_authority_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Workspace authority lifecycle is held'
        USING ERRCODE = '55000';
    END
    $function$
  `;

  await sql`
    DO $migration$
    BEGIN
      CREATE TRIGGER omni_workspace_validate_insert
      BEFORE INSERT ON omni_tenant_workspaces
      FOR EACH ROW EXECUTE FUNCTION omni_validate_workspace_authority_insert();
      CREATE TRIGGER omni_workspace_mutation_hold
      BEFORE UPDATE OR DELETE ON omni_tenant_workspaces
      FOR EACH ROW EXECUTE FUNCTION omni_reject_workspace_authority_mutation();
      CREATE TRIGGER omni_workspace_no_truncate
      BEFORE TRUNCATE ON omni_tenant_workspaces
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_workspace_authority_mutation();
      CREATE TRIGGER omni_workspace_membership_validate_insert
      BEFORE INSERT ON omni_tenant_workspace_memberships
      FOR EACH ROW EXECUTE FUNCTION omni_validate_workspace_membership_insert();
      CREATE TRIGGER omni_workspace_membership_mutation_hold
      BEFORE UPDATE OR DELETE ON omni_tenant_workspace_memberships
      FOR EACH ROW EXECUTE FUNCTION omni_reject_workspace_authority_mutation();
      CREATE TRIGGER omni_workspace_membership_no_truncate
      BEFORE TRUNCATE ON omni_tenant_workspace_memberships
      FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_workspace_authority_mutation();
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_tenant_workspaces FROM PUBLIC;
    REVOKE ALL ON TABLE omni_tenant_workspace_memberships FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_workspace_authority_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
      TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_workspace_membership_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT,
      TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
      TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_actor_has_active_tenant_membership(TEXT, TEXT)
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_validate_workspace_authority_insert()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_validate_workspace_membership_insert()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_workspace_authority_mutation()
      FROM PUBLIC
  `);

  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_tenant_workspaces',
            'omni_tenant_workspace_memberships'
          )
          AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_workspaces FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_workspace_memberships FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_workspace_authority_row_is_valid',
            'omni_workspace_membership_row_is_valid',
            'omni_actor_has_active_tenant_membership',
            'omni_validate_workspace_authority_insert',
            'omni_validate_workspace_membership_insert',
            'omni_reject_workspace_authority_mutation'
          )
          AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_workspace_authority_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_workspace_membership_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, ' ||
          'TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_actor_has_active_tenant_membership(' ||
          'TEXT, TEXT) FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_validate_workspace_authority_insert() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_validate_workspace_membership_insert() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_reject_workspace_authority_mutation() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_workspaces ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_workspaces FORCE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_workspace_memberships ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_workspace_memberships FORCE ROW LEVEL SECURITY
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation ON omni_tenant_workspaces
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_workspace_authority_holdback ON omni_tenant_workspaces
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation ON omni_tenant_workspace_memberships
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_workspace_membership_holdback
    ON omni_tenant_workspace_memberships
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM omni_tenant_workspaces)
        OR EXISTS (SELECT 1 FROM omni_tenant_workspace_memberships)
      THEN
        RAISE EXCEPTION 'Workspace authority shadow must start empty'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_tenant_workspaces',
            'omni_tenant_workspace_memberships'
          ) AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_tenant_workspaces',
            'omni_tenant_workspace_memberships'
          ) AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_workspace_authority_row_is_valid',
            'omni_workspace_membership_row_is_valid',
            'omni_actor_has_active_tenant_membership',
            'omni_validate_workspace_authority_insert',
            'omni_validate_workspace_membership_insert',
            'omni_reject_workspace_authority_mutation'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Workspace authority shadow grants non-owner access'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_class
        WHERE oid IN (
          'omni_tenant_workspaces'::regclass,
          'omni_tenant_workspace_memberships'::regclass
        ) AND relkind = 'r' AND relpersistence = 'p'
          AND relrowsecurity AND relforcerowsecurity
          AND relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) <> 2 OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid IN (
          'omni_tenant_workspaces'::regclass,
          'omni_tenant_workspace_memberships'::regclass
        )
      ) <> 4 THEN
        RAISE EXCEPTION 'Workspace authority isolation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_workspaces'::regclass
          AND conname = 'omni_workspace_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_workspace_memberships'::regclass
          AND conname = 'omni_workspace_membership_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) THEN
        RAISE EXCEPTION 'Workspace authority active-state holds are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid IN (
          'omni_tenant_workspaces'::regclass,
          'omni_tenant_workspace_memberships'::regclass
        ) AND NOT tgisinternal
          AND tgname IN (
            'omni_workspace_validate_insert',
            'omni_workspace_mutation_hold',
            'omni_workspace_no_truncate',
            'omni_workspace_membership_validate_insert',
            'omni_workspace_membership_mutation_hold',
            'omni_workspace_membership_no_truncate'
          )
      ) <> 6 THEN
        RAISE EXCEPTION 'Workspace authority hold triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureCanonicalAuthUserActorIdentifiersShadow(sql: SqlClient) {
  // v50 records exact identity aliases only. It does not authorize a tenant,
  // change a served request actor, or translate any durable owner or receipt.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  // Freeze every identity, membership, scalar-owner, and JSON-owner surface
  // before the first audit. SHARE conflicts with ordinary writer locks and is
  // transaction-held, so both audit passes describe one stable data set.
  await sql`
    LOCK TABLE
      omni_access_requests,
      omni_agent_events,
      omni_agent_runs,
      omni_ai_usage,
      omni_auth_memberships,
      omni_auth_users,
      omni_capture_assets,
      omni_capture_recordings,
      omni_capture_segments,
      omni_custom_agents,
      omni_custom_skills,
      omni_daily_briefs,
      omni_eval_reports,
      omni_events,
      omni_evidence_units,
      omni_incident_events,
      omni_incidents,
      omni_mcp_connectors,
      omni_mcp_export_configurations,
      omni_memories,
      omni_memory_deletion_receipts,
      omni_memory_purpose_catalog,
      omni_mission_artifacts,
      omni_mission_attempts,
      omni_mission_tasks,
      omni_missions,
      omni_model_assignments,
      omni_model_catalog,
      omni_oauth_grants,
      omni_observability_events,
      omni_observability_slo_approval_policies,
      omni_observability_slo_approval_policy_versions,
      omni_observability_slo_policy_changes,
      omni_operation_jobs,
      omni_personal_notifications,
      omni_projects,
      omni_provider_connections,
      omni_security_audits,
      omni_service_api_keys,
      omni_source_items,
      omni_source_revisions,
      omni_source_sync_heads,
      omni_source_sync_page_checkpoints,
      omni_source_sync_page_items,
      omni_source_tombstones,
      omni_tenant_actor_memory_purpose_consents,
      omni_tenant_capability_rollouts,
      omni_tenant_memory_purpose_entitlements,
      omni_threads,
      omni_today_items,
      omni_today_preferences,
      omni_tool_executions,
      omni_workflow_events,
      omni_workflow_runs
    IN SHARE MODE
  `;

  // Every generated v46 actor is new to the served system. Finding one in a
  // durable actor position is ambiguous: it could have been supplied by a
  // header, service, or manual writer, so the migration must not claim it.
  await sql`
    DO $migration$
    DECLARE
      actor_surface RECORD;
      collision_found BOOLEAN;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE email IS DISTINCT FROM btrim(email)
          OR char_length(email) NOT BETWEEN 1 AND 320
          OR email COLLATE "C" = actor_id COLLATE "C"
      ) THEN
        RAISE EXCEPTION 'An auth-user email cannot be recorded as an exact legacy actor identifier'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        WITH identifier_candidates AS (
          SELECT actor_id AS canonical_actor_id,
            actor_id AS actor_identifier
          FROM omni_auth_users
          UNION ALL
          SELECT actor_id AS canonical_actor_id,
            email AS actor_identifier
          FROM omni_auth_users
        )
        SELECT 1
        FROM identifier_candidates
        GROUP BY actor_identifier COLLATE "C"
        HAVING count(DISTINCT canonical_actor_id COLLATE "C") <> 1
      ) THEN
        RAISE EXCEPTION 'An auth-user actor identifier maps to multiple canonical actors'
          USING ERRCODE = '55000';
      END IF;

      FOR actor_surface IN
        SELECT *
        FROM (VALUES
          ('omni_memories', 'asserted_by'),
          ('omni_memories', 'owner_actor_id'),
          ('omni_tool_executions', 'actor_id'),
          ('omni_tool_executions', 'approved_by'),
          ('omni_mcp_connectors', 'credential_created_by'),
          ('omni_mcp_connectors', 'credential_rotated_by'),
          ('omni_incidents', 'acknowledged_by'),
          ('omni_incidents', 'resolved_by'),
          ('omni_incident_events', 'actor_id'),
          ('omni_eval_reports', 'created_by'),
          ('omni_security_audits', 'actor_id'),
          ('omni_observability_events', 'actor_id'),
          ('omni_events', 'actor_id'),
          ('omni_observability_slo_policy_changes', 'requested_by'),
          ('omni_observability_slo_policy_changes', 'reviewed_by'),
          ('omni_observability_slo_approval_policies', 'updated_by'),
          ('omni_observability_slo_approval_policy_versions', 'changed_by'),
          ('omni_oauth_grants', 'actor_id'),
          ('omni_today_items', 'actor_id'),
          ('omni_today_preferences', 'actor_id'),
          ('omni_daily_briefs', 'actor_id'),
          ('omni_daily_briefs', 'generated_by'),
          ('omni_personal_notifications', 'actor_id'),
          ('omni_projects', 'actor_id'),
          ('omni_capture_assets', 'actor_id'),
          ('omni_capture_recordings', 'actor_id'),
          ('omni_capture_segments', 'actor_id'),
          ('omni_custom_skills', 'actor_id'),
          ('omni_custom_agents', 'actor_id'),
          ('omni_missions', 'actor_id'),
          ('omni_mission_tasks', 'actor_id'),
          ('omni_mission_attempts', 'actor_id'),
          ('omni_mission_artifacts', 'actor_id'),
          ('omni_provider_connections', 'actor_id'),
          ('omni_model_catalog', 'actor_id'),
          ('omni_model_assignments', 'actor_id'),
          ('omni_service_api_keys', 'actor_id'),
          ('omni_mcp_export_configurations', 'actor_id'),
          ('omni_source_items', 'owner_actor_id'),
          ('omni_source_revisions', 'owner_actor_id'),
          ('omni_evidence_units', 'owner_actor_id'),
          ('omni_source_sync_page_checkpoints', 'owner_actor_id'),
          ('omni_source_sync_page_items', 'owner_actor_id'),
          ('omni_source_tombstones', 'owner_actor_id'),
          ('omni_source_sync_heads', 'owner_actor_id'),
          ('omni_tenant_capability_rollouts', 'created_by_actor_id'),
          ('omni_tenant_capability_rollouts', 'activated_by_actor_id'),
          ('omni_ai_usage', 'actor_id'),
          ('omni_threads', 'actor_id'),
          ('omni_access_requests', 'reviewed_by'),
          ('omni_memory_deletion_receipts', 'initiating_actor_id'),
          ('omni_memory_deletion_receipts', 'executing_principal_id'),
          ('omni_tenant_memory_purpose_entitlements', 'created_by_actor_id'),
          ('omni_tenant_memory_purpose_entitlements', 'activated_by_actor_id'),
          ('omni_tenant_memory_purpose_entitlements', 'revoked_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'subject_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'created_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'granted_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'revoked_by_actor_id')
        ) AS surface(table_name, column_name)
      LOOP
        EXECUTE format(
          'SELECT EXISTS (' ||
          'SELECT 1 FROM %I.%I actor_surface ' ||
          'JOIN %I.omni_auth_users auth_user ' ||
          'ON auth_user.actor_id COLLATE "C" = ' ||
          'actor_surface.%I COLLATE "C" ' ||
          'WHERE actor_surface.%I IS NOT NULL)',
          current_schema(),
          actor_surface.table_name,
          current_schema(),
          actor_surface.column_name,
          actor_surface.column_name
        ) INTO collision_found;
        IF collision_found THEN
          RAISE EXCEPTION 'Canonical auth-user actor already appears in %.%',
            actor_surface.table_name,
            actor_surface.column_name
            USING ERRCODE = '55000';
        END IF;
      END LOOP;

      IF EXISTS (
        WITH persisted_json_actors(actor_identifier) AS (
          SELECT continuation #>> '{context,actorId}'
          FROM omni_agent_runs
          WHERE continuation IS NOT NULL
          UNION ALL
          SELECT payload ->> 'actorId'
          FROM omni_operation_jobs
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_operation_jobs
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_operation_jobs
          UNION ALL
          SELECT input #>> '{metadata,actorId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT input #>> '{metadata,executionScope,initiatingActorId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT input #>> '{metadata,executionScope,executingPrincipalId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT payload #>> '{_executionScope,initiatingActorId}'
          FROM omni_events
          UNION ALL
          SELECT payload #>> '{_executionScope,executingPrincipalId}'
          FROM omni_events
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_agent_events
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_agent_events
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_workflow_events
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_workflow_events
          UNION ALL
          SELECT execution_scope ->> 'initiatingActorId'
          FROM omni_ai_usage
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'executingPrincipalId'
          FROM omni_ai_usage
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'initiatingActorId'
          FROM omni_memory_deletion_receipts
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'executingPrincipalId'
          FROM omni_memory_deletion_receipts
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT effect_receipt ->> 'actorId'
          FROM omni_tool_executions
          WHERE effect_receipt IS NOT NULL
          UNION ALL
          SELECT effect_receipt #>> '{executionScope,initiatingActorId}'
          FROM omni_tool_executions
          WHERE effect_receipt IS NOT NULL
          UNION ALL
          SELECT approval ->> 'by'
          FROM omni_tool_executions execution_record
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(execution_record.approvals) = 'array'
              THEN execution_record.approvals
              ELSE '[]'::JSONB
            END
          ) approval
          UNION ALL
          SELECT approval ->> 'by'
          FROM omni_observability_slo_policy_changes policy_change
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(policy_change.approvals) = 'array'
              THEN policy_change.approvals
              ELSE '[]'::JSONB
            END
          ) approval
        )
        SELECT 1
        FROM persisted_json_actors persisted
        JOIN omni_auth_users auth_user
          ON auth_user.actor_id COLLATE "C" =
            persisted.actor_identifier COLLATE "C"
        WHERE persisted.actor_identifier IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor already appears in a durable JSON contract'
          USING ERRCODE = '55000';
      END IF;

      FOR actor_surface IN
        SELECT *
        FROM (VALUES
          ('omni_memories', 'owner_actor_id'),
          ('omni_oauth_grants', 'actor_id'),
          ('omni_today_items', 'actor_id'),
          ('omni_today_preferences', 'actor_id'),
          ('omni_daily_briefs', 'actor_id'),
          ('omni_personal_notifications', 'actor_id'),
          ('omni_projects', 'actor_id'),
          ('omni_capture_assets', 'actor_id'),
          ('omni_capture_recordings', 'actor_id'),
          ('omni_capture_segments', 'actor_id'),
          ('omni_custom_skills', 'actor_id'),
          ('omni_custom_agents', 'actor_id'),
          ('omni_missions', 'actor_id'),
          ('omni_mission_tasks', 'actor_id'),
          ('omni_mission_attempts', 'actor_id'),
          ('omni_mission_artifacts', 'actor_id'),
          ('omni_provider_connections', 'actor_id'),
          ('omni_model_catalog', 'actor_id'),
          ('omni_model_assignments', 'actor_id'),
          ('omni_service_api_keys', 'actor_id'),
          ('omni_mcp_export_configurations', 'actor_id'),
          ('omni_source_items', 'owner_actor_id'),
          ('omni_source_revisions', 'owner_actor_id'),
          ('omni_evidence_units', 'owner_actor_id'),
          ('omni_source_sync_page_checkpoints', 'owner_actor_id'),
          ('omni_source_sync_page_items', 'owner_actor_id'),
          ('omni_source_tombstones', 'owner_actor_id'),
          ('omni_source_sync_heads', 'owner_actor_id'),
          ('omni_threads', 'actor_id')
        ) AS surface(table_name, column_name)
      LOOP
        EXECUTE format(
          'SELECT EXISTS (' ||
          'SELECT 1 FROM %I.%I owned_record ' ||
          'JOIN %I.omni_auth_users auth_user ' ||
          'ON auth_user.email COLLATE "C" = ' ||
          'owned_record.%I COLLATE "C" ' ||
          'WHERE owned_record.%I IS NOT NULL ' ||
          'AND NOT EXISTS (' ||
          'SELECT 1 FROM %I.omni_auth_memberships membership ' ||
          'WHERE membership.tenant_id = owned_record.tenant_id ' ||
          'AND membership.user_id = auth_user.id))',
          current_schema(),
          actor_surface.table_name,
          current_schema(),
          actor_surface.column_name,
          actor_surface.column_name,
          current_schema()
        ) INTO collision_found;
        IF collision_found THEN
          RAISE EXCEPTION 'Legacy auth-user ownership lacks a tenant membership in %.%',
            actor_surface.table_name,
            actor_surface.column_name
            USING ERRCODE = '55000';
        END IF;
      END LOOP;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_auth_user_actor_identifier_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_actor_identifier TEXT,
      candidate_canonical_actor_id TEXT,
      candidate_identifier_kind TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$SELECT candidate_schema_version = 1 AND candidate_actor_identifier = btrim(candidate_actor_identifier) AND char_length(candidate_actor_identifier) BETWEEN 1 AND 320 AND public.omni_source_contract_id_is_valid(candidate_canonical_actor_id) AND ((candidate_identifier_kind = 'canonical' AND candidate_actor_identifier = candidate_canonical_actor_id) OR (candidate_identifier_kind = 'legacy_email' AND candidate_actor_identifier <> candidate_canonical_actor_id))$function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_auth_user_actor_identifiers (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      actor_identifier TEXT COLLATE "C" NOT NULL,
      canonical_actor_id TEXT COLLATE "C" NOT NULL,
      identifier_kind TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_auth_user_actor_identifiers_pkey
        PRIMARY KEY (actor_identifier),
      CONSTRAINT omni_auth_user_actor_identifiers_canonical_actor_fk
        FOREIGN KEY (canonical_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_auth_user_actor_identifiers_contract_check CHECK (
        omni_auth_user_actor_identifier_row_is_valid(
          schema_version,
          actor_identifier,
          canonical_actor_id,
          identifier_kind
        )
      )
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_auth_user_actor_identifiers_canonical_self_key
    ON omni_auth_user_actor_identifiers (canonical_actor_id)
    WHERE identifier_kind = 'canonical'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS
      omni_auth_user_actor_identifiers_canonical_lookup_idx
    ON omni_auth_user_actor_identifiers (
      canonical_actor_id,
      identifier_kind,
      actor_identifier
    )
  `;

  await sql`
    INSERT INTO omni_auth_user_actor_identifiers (
      schema_version,
      actor_identifier,
      canonical_actor_id,
      identifier_kind
    )
    SELECT 1, actor_id, actor_id, 'canonical'
    FROM omni_auth_users
    ON CONFLICT (actor_identifier) DO NOTHING
  `;
  await sql`
    INSERT INTO omni_auth_user_actor_identifiers (
      schema_version,
      actor_identifier,
      canonical_actor_id,
      identifier_kind
    )
    SELECT 1, email, actor_id, 'legacy_email'
    FROM omni_auth_users
    ON CONFLICT (actor_identifier) DO NOTHING
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_register_auth_user_actor_identifiers()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_auth_users'::regclass
        OR TG_WHEN IS DISTINCT FROM 'AFTER'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
      THEN
        RAISE EXCEPTION 'Canonical actor identifier registrar has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.omni_auth_user_actor_identifiers (
        schema_version,
        actor_identifier,
        canonical_actor_id,
        identifier_kind
      ) VALUES (1, NEW.actor_id, NEW.actor_id, 'canonical')
      ON CONFLICT (actor_identifier) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_auth_user_actor_identifiers identifier
        WHERE identifier.actor_identifier = NEW.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = NEW.actor_id COLLATE "C"
          AND identifier.identifier_kind = 'canonical'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier collides with another auth user'
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.omni_auth_user_actor_identifiers (
        schema_version,
        actor_identifier,
        canonical_actor_id,
        identifier_kind
      ) VALUES (1, NEW.email, NEW.actor_id, 'legacy_email')
      ON CONFLICT (actor_identifier) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_auth_user_actor_identifiers identifier
        WHERE identifier.actor_identifier = NEW.email COLLATE "C"
          AND identifier.canonical_actor_id = NEW.actor_id COLLATE "C"
          AND identifier.identifier_kind = 'legacy_email'
      ) THEN
        RAISE EXCEPTION 'Legacy actor identifier collides with another auth user'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_auth_user_actor_identifier_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$BEGIN RAISE EXCEPTION 'Canonical auth-user actor identifiers are append-only' USING ERRCODE = '55000'; END$function$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND tgname = 'omni_auth_users_register_actor_identifiers'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_users_register_actor_identifiers
        AFTER INSERT OR UPDATE OF email ON omni_auth_users
        FOR EACH ROW
        EXECUTE FUNCTION omni_register_auth_user_actor_identifiers();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_user_actor_identifiers'::regclass
          AND tgname = 'omni_auth_user_actor_identifiers_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_user_actor_identifiers_immutable
        BEFORE UPDATE OR DELETE ON omni_auth_user_actor_identifiers
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_auth_user_actor_identifier_change();
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_user_actor_identifiers'::regclass
          AND tgname = 'omni_auth_user_actor_identifiers_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_auth_user_actor_identifiers_no_truncate
        BEFORE TRUNCATE ON omni_auth_user_actor_identifiers
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_auth_user_actor_identifier_change();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_auth_user_actor_identifiers
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_auth_user_actor_identifier_row_is_valid(
      SMALLINT,
      TEXT,
      TEXT,
      TEXT
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_register_auth_user_actor_identifiers()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_auth_user_actor_identifier_change()
    FROM PUBLIC
  `);
  await sql.query(`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_user_actor_identifiers'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE ' ||
          '%I.omni_auth_user_actor_identifiers FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_user_actor_identifiers'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE ' ||
          '%I.omni_auth_user_actor_identifiers FROM %s',
          grant_record.privilege_type,
          grant_record.column_name,
          current_schema(),
          CASE
            WHEN grant_record.grantee = 'PUBLIC' THEN 'PUBLIC'
            ELSE quote_ident(grant_record.grantee)
          END
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_auth_user_actor_identifier_row_is_valid',
            'omni_register_auth_user_actor_identifiers',
            'omni_reject_auth_user_actor_identifier_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_auth_user_actor_identifier_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_register_auth_user_actor_identifiers() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_auth_user_actor_identifier_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  await sql`
    DO $migration$
    DECLARE
      actor_surface RECORD;
      collision_found BOOLEAN;
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid =
            'omni_auth_user_actor_identifiers'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND NOT relation.relispartition
          AND NOT EXISTS (
            SELECT 1
            FROM pg_inherits inheritance
            WHERE inheritance.inhrelid = relation.oid
              OR inheritance.inhparent = relation.oid
          )
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier relation is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM (
          SELECT
            array_agg(attribute.attname ORDER BY attribute.attnum) AS names,
            bool_and(attribute.attnotnull) AS all_not_null,
            bool_and(attribute.attgenerated = '') AS none_generated,
            count(*) AS column_count
          FROM pg_attribute attribute
          WHERE attribute.attrelid =
              'omni_auth_user_actor_identifiers'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names::TEXT[] = ARRAY[
            'schema_version', 'actor_identifier', 'canonical_actor_id',
            'identifier_kind', 'created_at'
          ]
          AND columns.all_not_null
          AND columns.none_generated
          AND columns.column_count = 5
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_auth_user_actor_identifiers'::regclass
          AND attname = 'schema_version'
          AND atttypid = 'smallint'::regtype
          AND atttypmod = -1
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_auth_user_actor_identifiers'::regclass
          AND attname IN ('actor_identifier', 'canonical_actor_id')
          AND atttypid = 'text'::regtype
          AND atttypmod = -1
          AND attcollation = '"C"'::regcollation
          AND NOT attisdropped
        GROUP BY attrelid
        HAVING count(*) = 2
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_auth_user_actor_identifiers'::regclass
          AND attname = 'identifier_kind'
          AND atttypid = 'text'::regtype
          AND atttypmod = -1
          AND attcollation = (
            SELECT typcollation
            FROM pg_type
            WHERE oid = 'text'::regtype
          )
          AND NOT attisdropped
      ) OR (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_auth_user_actor_identifiers'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND attribute.attname = 'schema_version'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('1', '1::smallint', '(1)::smallint')
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND attribute.attname = 'created_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND attribute.atttypmod = -1
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid =
          'omni_auth_user_actor_identifiers'::regclass
          AND contype <> 'n'
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_auth_user_actor_identifiers_pkey'
          AND constraint_record.conrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND constraint_record.connoinherit
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'actor_identifier'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indimmediate
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_auth_user_actor_identifiers_canonical_actor_fk'
          AND constraint_record.conrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND constraint_record.confrelid = 'omni_auth_users'::regclass
          AND constraint_record.contype = 'f'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND constraint_record.connoinherit
          AND constraint_record.confupdtype = 'r'
          AND constraint_record.confdeltype = 'r'
          AND constraint_record.confmatchtype = 's'
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'canonical_actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND constraint_record.confkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_auth_user_actor_identifiers_contract_check'
          AND constraint_record.conrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND NOT constraint_record.connoinherit
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'schema_version'
                AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'actor_identifier'
                AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'canonical_actor_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attname = 'identifier_kind'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) =
            'omni_auth_user_actor_identifier_row_is_valid(schema_version, actor_identifier, canonical_actor_id, identifier_kind)'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_auth_user_actor_identifiers'::regclass
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_auth_user_actor_identifiers_pkey',
              ARRAY['actor_identifier']::TEXT[],
              TRUE,
              TRUE,
              NULL::TEXT
            ),
            (
              'omni_auth_user_actor_identifiers_canonical_self_key',
              ARRAY['canonical_actor_id']::TEXT[],
              TRUE,
              FALSE,
              '(identifier_kind = ''canonical''::text)'
            ),
            (
              'omni_auth_user_actor_identifiers_canonical_lookup_idx',
              ARRAY[
                'canonical_actor_id',
                'identifier_kind',
                'actor_identifier'
              ]::TEXT[],
              FALSE,
              FALSE,
              NULL::TEXT
            )
        ) expected(
          index_name,
          column_names,
          is_unique,
          is_primary,
          predicate_expression
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_index index_record
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          JOIN pg_namespace index_namespace
            ON index_namespace.oid = index_relation.relnamespace
          JOIN pg_am access_method
            ON access_method.oid = index_relation.relam
          WHERE index_record.indexrelid = to_regclass(
              format('%I.%I', current_schema(), expected.index_name)
            )
            AND index_record.indrelid =
              'omni_auth_user_actor_identifiers'::regclass
            AND index_relation.relname = expected.index_name
            AND index_namespace.nspname = current_schema()
            AND index_relation.relkind = 'i'
            AND index_relation.relpersistence = 'p'
            AND index_relation.relowner = (
              SELECT relowner
              FROM pg_class
              WHERE oid = 'omni_schema_version'::regclass
            )
            AND access_method.amname = 'btree'
            AND index_record.indisunique = expected.is_unique
            AND index_record.indisprimary = expected.is_primary
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indislive
            AND index_record.indimmediate
            AND NOT index_record.indisclustered
            AND NOT index_record.indisreplident
            AND NOT index_record.indisexclusion
            AND NOT COALESCE(
              (to_jsonb(index_record) ->> 'indnullsnotdistinct')::BOOLEAN,
              FALSE
            )
            AND index_record.indnatts =
              cardinality(expected.column_names)
            AND index_record.indnkeyatts =
              cardinality(expected.column_names)
            AND index_record.indexprs IS NULL
            AND (
              SELECT array_agg(
                operator_class ORDER BY ordinal_position
              )
              FROM unnest(index_record.indclass)
                WITH ORDINALITY AS operator_classes(
                  operator_class,
                  ordinal_position
                )
            ) = array_fill(
              (
                SELECT operator_class.oid
                FROM pg_opclass operator_class
                WHERE operator_class.opcname = 'text_ops'
                  AND operator_class.opcnamespace =
                    'pg_catalog'::REGNAMESPACE
                  AND operator_class.opcmethod = access_method.oid
              ),
              ARRAY[cardinality(expected.column_names)]
            )
            AND (
              SELECT array_agg(
                collation_oid ORDER BY ordinal_position
              )
              FROM unnest(index_record.indcollation)
                WITH ORDINALITY AS collations(
                  collation_oid,
                  ordinal_position
                )
            ) = (
              SELECT array_agg(
                attribute.attcollation ORDER BY expected_column.ordinality
              )
              FROM unnest(expected.column_names)
                WITH ORDINALITY AS expected_column(
                  column_name,
                  ordinality
                )
              JOIN pg_attribute attribute
                ON attribute.attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attribute.attname = expected_column.column_name
                AND NOT attribute.attisdropped
            )
            AND (
              SELECT array_agg(
                index_option ORDER BY ordinal_position
              )
              FROM unnest(index_record.indoption)
                WITH ORDINALITY AS index_options(
                  index_option,
                  ordinal_position
                )
            ) = array_fill(
              0::SMALLINT,
              ARRAY[cardinality(expected.column_names)]
            )
            AND (
              SELECT array_agg(
                key_attribute ORDER BY ordinal_position
              )
              FROM unnest(index_record.indkey)
                WITH ORDINALITY AS key_columns(
                  key_attribute,
                  ordinal_position
                )
            ) = (
              SELECT array_agg(
                attribute.attnum ORDER BY expected_column.ordinality
              )
              FROM unnest(expected.column_names)
                WITH ORDINALITY AS expected_column(
                  column_name,
                  ordinality
                )
              JOIN pg_attribute attribute
                ON attribute.attrelid =
                  'omni_auth_user_actor_identifiers'::regclass
                AND attribute.attname = expected_column.column_name
                AND NOT attribute.attisdropped
            )
            AND (
              (
                expected.predicate_expression IS NULL
                AND index_record.indpred IS NULL
              )
              OR pg_get_expr(
                index_record.indpred,
                index_record.indrelid
              ) = expected.predicate_expression
            )
        )
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier indexes are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_auth_users auth_user
        LEFT JOIN omni_auth_user_actor_identifiers canonical_identifier
          ON canonical_identifier.actor_identifier =
            auth_user.actor_id COLLATE "C"
          AND canonical_identifier.canonical_actor_id =
            auth_user.actor_id COLLATE "C"
          AND canonical_identifier.identifier_kind = 'canonical'
        LEFT JOIN omni_auth_user_actor_identifiers legacy_identifier
          ON legacy_identifier.actor_identifier = auth_user.email COLLATE "C"
          AND legacy_identifier.canonical_actor_id =
            auth_user.actor_id COLLATE "C"
          AND legacy_identifier.identifier_kind = 'legacy_email'
        WHERE canonical_identifier.actor_identifier IS NULL
          OR legacy_identifier.actor_identifier IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_user_actor_identifiers identifier
        WHERE NOT omni_auth_user_actor_identifier_row_is_valid(
          identifier.schema_version,
          identifier.actor_identifier,
          identifier.canonical_actor_id,
          identifier.identifier_kind
        )
      ) OR (
        SELECT count(*)
        FROM omni_auth_users
      ) IS DISTINCT FROM (
        SELECT count(*)
        FROM omni_auth_user_actor_identifiers
        WHERE identifier_kind = 'canonical'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier mappings are incomplete or invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT public.omni_auth_user_actor_identifier_row_is_valid(
        1::SMALLINT,
        'actor:00000000-0000-4000-8000-000000000001',
        'actor:00000000-0000-4000-8000-000000000001',
        'canonical'
      ) OR NOT public.omni_auth_user_actor_identifier_row_is_valid(
        1::SMALLINT,
        'person+history@example.test',
        'actor:00000000-0000-4000-8000-000000000001',
        'legacy_email'
      ) OR public.omni_auth_user_actor_identifier_row_is_valid(
        1::SMALLINT,
        'person+history@example.test',
        'actor:00000000-0000-4000-8000-000000000001',
        'canonical'
      ) OR public.omni_auth_user_actor_identifier_row_is_valid(
        2::SMALLINT,
        'actor:00000000-0000-4000-8000-000000000001',
        'actor:00000000-0000-4000-8000-000000000001',
        'canonical'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_proc procedure
        JOIN pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure.proname IN (
            'omni_auth_user_actor_identifier_row_is_valid',
            'omni_register_auth_user_actor_identifiers',
            'omni_reject_auth_user_actor_identifier_change'
          )
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure.proname IN (
            'omni_auth_user_actor_identifier_row_is_valid',
            'omni_register_auth_user_actor_identifiers',
            'omni_reject_auth_user_actor_identifier_change'
          )
          AND procedure.oid NOT IN (
            to_regprocedure(
              'public.omni_auth_user_actor_identifier_row_is_valid(smallint,text,text,text)'
            ),
            to_regprocedure(
              'public.omni_register_auth_user_actor_identifiers()'
            ),
            to_regprocedure(
              'public.omni_reject_auth_user_actor_identifier_change()'
            )
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_auth_user_actor_identifier_row_is_valid(smallint,text,text,text)'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
          AND procedure.prosrc =
            $expected$SELECT candidate_schema_version = 1 AND candidate_actor_identifier = btrim(candidate_actor_identifier) AND char_length(candidate_actor_identifier) BETWEEN 1 AND 320 AND public.omni_source_contract_id_is_valid(candidate_canonical_actor_id) AND ((candidate_identifier_kind = 'canonical' AND candidate_actor_identifier = candidate_canonical_actor_id) OR (candidate_identifier_kind = 'legacy_email' AND candidate_actor_identifier <> candidate_canonical_actor_id))$expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_register_auth_user_actor_identifiers()'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc = $expected$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_auth_users'::regclass
        OR TG_WHEN IS DISTINCT FROM 'AFTER'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
      THEN
        RAISE EXCEPTION 'Canonical actor identifier registrar has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.omni_auth_user_actor_identifiers (
        schema_version,
        actor_identifier,
        canonical_actor_id,
        identifier_kind
      ) VALUES (1, NEW.actor_id, NEW.actor_id, 'canonical')
      ON CONFLICT (actor_identifier) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_auth_user_actor_identifiers identifier
        WHERE identifier.actor_identifier = NEW.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = NEW.actor_id COLLATE "C"
          AND identifier.identifier_kind = 'canonical'
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier collides with another auth user'
          USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.omni_auth_user_actor_identifiers (
        schema_version,
        actor_identifier,
        canonical_actor_id,
        identifier_kind
      ) VALUES (1, NEW.email, NEW.actor_id, 'legacy_email')
      ON CONFLICT (actor_identifier) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM public.omni_auth_user_actor_identifiers identifier
        WHERE identifier.actor_identifier = NEW.email COLLATE "C"
          AND identifier.canonical_actor_id = NEW.actor_id COLLATE "C"
          AND identifier.identifier_kind = 'legacy_email'
      ) THEN
        RAISE EXCEPTION 'Legacy actor identifier collides with another auth user'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_auth_user_actor_identifier_change()'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.prorettype = 'trigger'::regtype
          AND procedure.provolatile = 'v'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'plpgsql'
          AND procedure.prosrc =
            $expected$BEGIN RAISE EXCEPTION 'Canonical auth-user actor identifiers are append-only' USING ERRCODE = '55000'; END$expected$
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
          'omni_auth_user_actor_identifiers'::regclass
          AND NOT tgisinternal
      ) <> 2 OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid = 'omni_auth_users'::regclass
          AND NOT tgisinternal
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = (
            SELECT attnum::TEXT
            FROM pg_attribute
            WHERE attrelid = 'omni_auth_users'::regclass
              AND attname = 'id'
              AND NOT attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_actor_identity_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_identity_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = ''
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid = 'omni_auth_users'::regclass
          AND trigger_record.tgname =
            'omni_auth_users_register_actor_identifiers'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_register_auth_user_actor_identifiers()'
          )
          AND trigger_record.tgtype = 21
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = (
            SELECT attnum::TEXT
            FROM pg_attribute
            WHERE attrelid = 'omni_auth_users'::regclass
              AND attname = 'email'
              AND NOT attisdropped
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND trigger_record.tgname =
            'omni_auth_user_actor_identifiers_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_actor_identifier_change()'
          )
          AND trigger_record.tgtype = 27
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = ''
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND trigger_record.tgname =
            'omni_auth_user_actor_identifiers_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_auth_user_actor_identifier_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND COALESCE(
            (to_jsonb(trigger_record) ->> 'tgparentid')::OID,
            0::OID
          ) = 0::OID
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_class relation
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            relation.relacl,
            acldefault('r', relation.relowner)
          )
        ) privilege
        WHERE relation.oid =
            'omni_auth_user_actor_identifiers'::regclass
          AND privilege.grantee <> relation.relowner
      ) OR EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
        WHERE attribute.attrelid =
            'omni_auth_user_actor_identifiers'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND privilege.grantee <> relation.relowner
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (to_regprocedure(
              'public.omni_auth_user_actor_identifier_row_is_valid(smallint,text,text,text)'
            )),
            (to_regprocedure(
              'public.omni_register_auth_user_actor_identifiers()'
            )),
            (to_regprocedure(
              'public.omni_reject_auth_user_actor_identifier_change()'
            ))
        ) expected(procedure_oid)
        JOIN pg_proc procedure ON procedure.oid = expected.procedure_oid
        CROSS JOIN LATERAL aclexplode(
          COALESCE(
            procedure.proacl,
            acldefault('f', procedure.proowner)
          )
        ) privilege
        WHERE privilege.grantee <> procedure.proowner
      ) THEN
        RAISE EXCEPTION 'Canonical actor identifier shadow is exposed to a serving role'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE email IS DISTINCT FROM btrim(email)
          OR char_length(email) NOT BETWEEN 1 AND 320
          OR email COLLATE "C" = actor_id COLLATE "C"
      ) OR EXISTS (
        WITH identifier_candidates AS (
          SELECT actor_id AS canonical_actor_id,
            actor_id AS actor_identifier
          FROM omni_auth_users
          UNION ALL
          SELECT actor_id AS canonical_actor_id,
            email AS actor_identifier
          FROM omni_auth_users
        )
        SELECT 1
        FROM identifier_candidates
        GROUP BY actor_identifier COLLATE "C"
        HAVING count(DISTINCT canonical_actor_id COLLATE "C") <> 1
      ) THEN
        RAISE EXCEPTION 'Auth-user actor identifier collision audit changed during migration'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        WITH persisted_json_actors(actor_identifier) AS (
          SELECT continuation #>> '{context,actorId}'
          FROM omni_agent_runs
          WHERE continuation IS NOT NULL
          UNION ALL
          SELECT payload ->> 'actorId'
          FROM omni_operation_jobs
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_operation_jobs
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_operation_jobs
          UNION ALL
          SELECT input #>> '{metadata,actorId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT input #>> '{metadata,executionScope,initiatingActorId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT input #>> '{metadata,executionScope,executingPrincipalId}'
          FROM omni_workflow_runs
          UNION ALL
          SELECT payload #>> '{_executionScope,initiatingActorId}'
          FROM omni_events
          UNION ALL
          SELECT payload #>> '{_executionScope,executingPrincipalId}'
          FROM omni_events
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_agent_events
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_agent_events
          UNION ALL
          SELECT payload #>> '{executionScope,initiatingActorId}'
          FROM omni_workflow_events
          UNION ALL
          SELECT payload #>> '{executionScope,executingPrincipalId}'
          FROM omni_workflow_events
          UNION ALL
          SELECT execution_scope ->> 'initiatingActorId'
          FROM omni_ai_usage
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'executingPrincipalId'
          FROM omni_ai_usage
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'initiatingActorId'
          FROM omni_memory_deletion_receipts
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT execution_scope ->> 'executingPrincipalId'
          FROM omni_memory_deletion_receipts
          WHERE execution_scope IS NOT NULL
          UNION ALL
          SELECT effect_receipt ->> 'actorId'
          FROM omni_tool_executions
          WHERE effect_receipt IS NOT NULL
          UNION ALL
          SELECT effect_receipt #>> '{executionScope,initiatingActorId}'
          FROM omni_tool_executions
          WHERE effect_receipt IS NOT NULL
          UNION ALL
          SELECT approval ->> 'by'
          FROM omni_tool_executions execution_record
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(execution_record.approvals) = 'array'
              THEN execution_record.approvals
              ELSE '[]'::JSONB
            END
          ) approval
          UNION ALL
          SELECT approval ->> 'by'
          FROM omni_observability_slo_policy_changes policy_change
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(policy_change.approvals) = 'array'
              THEN policy_change.approvals
              ELSE '[]'::JSONB
            END
          ) approval
        )
        SELECT 1
        FROM persisted_json_actors persisted
        JOIN omni_auth_users auth_user
          ON auth_user.actor_id COLLATE "C" =
            persisted.actor_identifier COLLATE "C"
        WHERE persisted.actor_identifier IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor appeared in a durable JSON contract during migration'
          USING ERRCODE = '55000';
      END IF;

      FOR actor_surface IN
        SELECT *
        FROM (VALUES
          ('omni_memories', 'asserted_by'),
          ('omni_memories', 'owner_actor_id'),
          ('omni_tool_executions', 'actor_id'),
          ('omni_tool_executions', 'approved_by'),
          ('omni_mcp_connectors', 'credential_created_by'),
          ('omni_mcp_connectors', 'credential_rotated_by'),
          ('omni_incidents', 'acknowledged_by'),
          ('omni_incidents', 'resolved_by'),
          ('omni_incident_events', 'actor_id'),
          ('omni_eval_reports', 'created_by'),
          ('omni_security_audits', 'actor_id'),
          ('omni_observability_events', 'actor_id'),
          ('omni_events', 'actor_id'),
          ('omni_observability_slo_policy_changes', 'requested_by'),
          ('omni_observability_slo_policy_changes', 'reviewed_by'),
          ('omni_observability_slo_approval_policies', 'updated_by'),
          ('omni_observability_slo_approval_policy_versions', 'changed_by'),
          ('omni_oauth_grants', 'actor_id'),
          ('omni_today_items', 'actor_id'),
          ('omni_today_preferences', 'actor_id'),
          ('omni_daily_briefs', 'actor_id'),
          ('omni_daily_briefs', 'generated_by'),
          ('omni_personal_notifications', 'actor_id'),
          ('omni_projects', 'actor_id'),
          ('omni_capture_assets', 'actor_id'),
          ('omni_capture_recordings', 'actor_id'),
          ('omni_capture_segments', 'actor_id'),
          ('omni_custom_skills', 'actor_id'),
          ('omni_custom_agents', 'actor_id'),
          ('omni_missions', 'actor_id'),
          ('omni_mission_tasks', 'actor_id'),
          ('omni_mission_attempts', 'actor_id'),
          ('omni_mission_artifacts', 'actor_id'),
          ('omni_provider_connections', 'actor_id'),
          ('omni_model_catalog', 'actor_id'),
          ('omni_model_assignments', 'actor_id'),
          ('omni_service_api_keys', 'actor_id'),
          ('omni_mcp_export_configurations', 'actor_id'),
          ('omni_source_items', 'owner_actor_id'),
          ('omni_source_revisions', 'owner_actor_id'),
          ('omni_evidence_units', 'owner_actor_id'),
          ('omni_source_sync_page_checkpoints', 'owner_actor_id'),
          ('omni_source_sync_page_items', 'owner_actor_id'),
          ('omni_source_tombstones', 'owner_actor_id'),
          ('omni_source_sync_heads', 'owner_actor_id'),
          ('omni_tenant_capability_rollouts', 'created_by_actor_id'),
          ('omni_tenant_capability_rollouts', 'activated_by_actor_id'),
          ('omni_ai_usage', 'actor_id'),
          ('omni_threads', 'actor_id'),
          ('omni_access_requests', 'reviewed_by'),
          ('omni_memory_deletion_receipts', 'initiating_actor_id'),
          ('omni_memory_deletion_receipts', 'executing_principal_id'),
          ('omni_tenant_memory_purpose_entitlements', 'created_by_actor_id'),
          ('omni_tenant_memory_purpose_entitlements', 'activated_by_actor_id'),
          ('omni_tenant_memory_purpose_entitlements', 'revoked_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'subject_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'created_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'granted_by_actor_id'),
          ('omni_tenant_actor_memory_purpose_consents', 'revoked_by_actor_id')
        ) AS surface(table_name, column_name)
      LOOP
        EXECUTE format(
          'SELECT EXISTS (' ||
          'SELECT 1 FROM %I.%I actor_surface ' ||
          'JOIN %I.omni_auth_users auth_user ' ||
          'ON auth_user.actor_id COLLATE "C" = ' ||
          'actor_surface.%I COLLATE "C" ' ||
          'WHERE actor_surface.%I IS NOT NULL)',
          current_schema(),
          actor_surface.table_name,
          current_schema(),
          actor_surface.column_name,
          actor_surface.column_name
        ) INTO collision_found;
        IF collision_found THEN
          RAISE EXCEPTION 'Canonical auth-user actor appeared during migration in %.%',
            actor_surface.table_name,
            actor_surface.column_name
            USING ERRCODE = '55000';
        END IF;
      END LOOP;

      FOR actor_surface IN
        SELECT *
        FROM (VALUES
          ('omni_memories', 'owner_actor_id'),
          ('omni_oauth_grants', 'actor_id'),
          ('omni_today_items', 'actor_id'),
          ('omni_today_preferences', 'actor_id'),
          ('omni_daily_briefs', 'actor_id'),
          ('omni_personal_notifications', 'actor_id'),
          ('omni_projects', 'actor_id'),
          ('omni_capture_assets', 'actor_id'),
          ('omni_capture_recordings', 'actor_id'),
          ('omni_capture_segments', 'actor_id'),
          ('omni_custom_skills', 'actor_id'),
          ('omni_custom_agents', 'actor_id'),
          ('omni_missions', 'actor_id'),
          ('omni_mission_tasks', 'actor_id'),
          ('omni_mission_attempts', 'actor_id'),
          ('omni_mission_artifacts', 'actor_id'),
          ('omni_provider_connections', 'actor_id'),
          ('omni_model_catalog', 'actor_id'),
          ('omni_model_assignments', 'actor_id'),
          ('omni_service_api_keys', 'actor_id'),
          ('omni_mcp_export_configurations', 'actor_id'),
          ('omni_source_items', 'owner_actor_id'),
          ('omni_source_revisions', 'owner_actor_id'),
          ('omni_evidence_units', 'owner_actor_id'),
          ('omni_source_sync_page_checkpoints', 'owner_actor_id'),
          ('omni_source_sync_page_items', 'owner_actor_id'),
          ('omni_source_tombstones', 'owner_actor_id'),
          ('omni_source_sync_heads', 'owner_actor_id'),
          ('omni_threads', 'actor_id')
        ) AS surface(table_name, column_name)
      LOOP
        EXECUTE format(
          'SELECT EXISTS (' ||
          'SELECT 1 FROM %I.%I owned_record ' ||
          'JOIN %I.omni_auth_users auth_user ' ||
          'ON auth_user.email COLLATE "C" = ' ||
          'owned_record.%I COLLATE "C" ' ||
          'WHERE owned_record.%I IS NOT NULL ' ||
          'AND NOT EXISTS (' ||
          'SELECT 1 FROM %I.omni_auth_memberships membership ' ||
          'WHERE membership.tenant_id = owned_record.tenant_id ' ||
          'AND membership.user_id = auth_user.id))',
          current_schema(),
          actor_surface.table_name,
          current_schema(),
          actor_surface.column_name,
          actor_surface.column_name,
          current_schema()
        ) INTO collision_found;
        IF collision_found THEN
          RAISE EXCEPTION 'Legacy auth-user ownership lost its tenant membership during migration in %.%',
            actor_surface.table_name,
            actor_surface.column_name
            USING ERRCODE = '55000';
        END IF;
      END LOOP;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:actor_identifier_check',
        'initiatingActorId', 'actor:actor_identifier_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:actor_identifier_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Canonical actor identifier self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memories_access_enrollment_hold_check'
          AND conrelid = 'omni_memories'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_memories
        WHERE access_contract_version <> 0
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_memory_purpose_entitlements
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'A held memory authority changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_authorized(jsonb)'
        )
          AND procedure.prokind = 'f'
          AND NOT procedure.proretset
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'v'
          AND procedure.proisstrict
          AND NOT procedure.prosecdef
          AND NOT procedure.proleakproof
          AND procedure.proparallel = 'u'
          AND procedure.pronargdefaults = 0
          AND procedure.provariadic = 0::OID
          AND procedure.proconfig =
            ARRAY['search_path=pg_catalog, public']
          AND procedure.proowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND language.lanname = 'sql'
          AND btrim(regexp_replace(
            procedure.prosrc,
            '[[:space:]]+',
            ' ',
            'g'
          )) = 'SELECT FALSE'
      ) OR EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_authorized%'
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook is no longer closed'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid = 'omni_memories'::regclass
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memories_access_enrollment_hold_check'
          AND constraint_record.conrelid = 'omni_memories'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.connoinherit
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = '(access_contract_version = 0)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memories'::regclass
          AND polname = 'omni_memory_access_scope_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
          AND pg_get_expr(polwithcheck, polrelid) =
            '((access_contract_version = 0) OR omni_system_scope_enabled())'
      ) THEN
        RAISE EXCEPTION 'Memory access enrollment floor changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_auth_users'::regclass
          AND attribute.attname = 'actor_id'
          AND attribute.atttypid = 'text'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = 's'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = '(''actor:''::text || id)'
      ) OR EXISTS (
        SELECT 1
        FROM omni_auth_users
        WHERE actor_id IS DISTINCT FROM 'actor:' || id
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_auth_users'
          AND privilege_type IN ('DELETE', 'TRUNCATE')
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity floor changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM omni_memory_purpose_catalog
      ) <> 8 OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog floor changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memory_purpose_entitlements_activation_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.connoinherit
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = '(state <> ''active''::text)'
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND polname = 'omni_memory_purpose_entitlement_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_entitlement_row_is_valid',
            'omni_validate_memory_purpose_entitlement_insert',
            'omni_protect_memory_purpose_entitlement'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_memory_purpose_entitlements
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement floor changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE oid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND relrowsecurity
          AND relforcerowsecurity
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_memory_purpose_consents_grant_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.connoinherit
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = '(state <> ''granted''::text)'
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid =
          'omni_tenant_actor_memory_purpose_consents'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND polname = 'omni_tenant_isolation'
          AND polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_tenant_visible(tenant_id)'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_tenant_visible(tenant_id)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND polname = 'omni_actor_memory_purpose_consent_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_memory_purpose_consent_row_is_valid',
            'omni_validate_actor_memory_purpose_consent_insert',
            'omni_protect_actor_memory_purpose_consent'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent floor changed during actor alias installation'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
