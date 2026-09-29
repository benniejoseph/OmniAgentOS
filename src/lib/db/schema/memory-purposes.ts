import "server-only";

import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for memory purposes: the catalog, entitlements,
// consents, access grants, operation policies and data-right requests.

export async function ensureMemoryPurposeCatalog(sql: SqlClient) {
  // Ordered security migrations must run as the stable schema owner. Failing
  // before CREATE OR REPLACE avoids transferring trust to a rotated role.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory purpose migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_purpose_catalog_row_is_valid(
      candidate_purpose_id TEXT,
      candidate_contract_version SMALLINT,
      candidate_operation_class TEXT,
      candidate_description TEXT
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_purpose_catalog (
      purpose_id TEXT PRIMARY KEY,
      contract_version SMALLINT NOT NULL,
      operation_class TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_purpose_catalog_operation_version_key
        UNIQUE (operation_class, contract_version),
      CONSTRAINT omni_memory_purpose_catalog_contract_check CHECK (
        omni_memory_purpose_catalog_row_is_valid(
          purpose_id,
          contract_version,
          operation_class,
          description
        )
      )
    )
  `;

  await sql`
    INSERT INTO omni_memory_purpose_catalog (
      purpose_id,
      contract_version,
      operation_class,
      description
    )
    VALUES
      (
        'memory.read.v1', 1, 'read',
        'Inspect authorized memory records without selecting them for model context.'
      ),
      (
        'memory.retrieve.v1', 1, 'retrieve',
        'Search and select authorized memory content for a bounded context or RAG operation.'
      ),
      (
        'memory.write.v1', 1, 'write',
        'Create or import an explicit authorized memory record.'
      ),
      (
        'memory.correct.v1', 1, 'correct',
        'Supersede, contradict, or revise an authorized memory claim.'
      ),
      (
        'memory.forget.v1', 1, 'forget',
        'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'
      ),
      (
        'memory.formation.v1', 1, 'formation',
        'Derive a candidate episode, claim, or summary from authorized evidence.'
      ),
      (
        'memory.maintenance.v1', 1, 'maintenance',
        'Run authorized retention, rebuild, reindex, or repair work.'
      ),
      (
        'memory.export.v1', 1, 'export',
        'Export an authorized memory set through portable or bulk egress.'
      )
    ON CONFLICT (purpose_id) DO NOTHING
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_purpose_catalog_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_catalog_immutable
        BEFORE UPDATE OR DELETE ON omni_memory_purpose_catalog
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_memory_purpose_catalog_change();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_catalog_no_truncate
        BEFORE TRUNCATE ON omni_memory_purpose_catalog
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_memory_purpose_catalog_change();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_memory_purpose_catalog
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_purpose_catalog_row_is_valid(
      TEXT,
      SMALLINT,
      TEXT,
      TEXT
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_memory_purpose_catalog_change()
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
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_memory_purpose_catalog FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_purpose_catalog'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %I.omni_memory_purpose_catalog FROM %s',
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
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_purpose_catalog_row_is_valid(' ||
          'TEXT, SMALLINT, TEXT, TEXT) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_memory_purpose_catalog_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  // The catalog defines vocabulary only. It grants no tenant, actor, agent,
  // workflow, or maintenance process permission to use a purpose.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_memory_purpose_catalog'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog relation is invalid'
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
          WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names::TEXT[] = ARRAY[
            'purpose_id', 'contract_version', 'operation_class',
            'description', 'created_at'
          ]
          AND columns.all_not_null
          AND columns.none_generated
          AND columns.column_count = 5
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'purpose_id'
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'contract_version'
          AND atttypid = 'smallint'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname IN ('operation_class', 'description')
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
        GROUP BY attrelid
        HAVING count(*) = 2
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attribute.attname = 'created_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_pkey'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'purpose_id'
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
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_operation_version_key'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'operation_class'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'contract_version'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND NOT index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memory_purpose_catalog_contract_check'
          AND conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_memory_purpose_catalog_row_is_valid(purpose_id, contract_version, operation_class, description)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog constraints are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (SELECT count(*) FROM omni_memory_purpose_catalog) <> 8
        OR EXISTS (
          SELECT 1
          FROM omni_memory_purpose_catalog actual
          LEFT JOIN (
            VALUES
              ('memory.read.v1', 1::SMALLINT, 'read',
                'Inspect authorized memory records without selecting them for model context.'),
              ('memory.retrieve.v1', 1::SMALLINT, 'retrieve',
                'Search and select authorized memory content for a bounded context or RAG operation.'),
              ('memory.write.v1', 1::SMALLINT, 'write',
                'Create or import an explicit authorized memory record.'),
              ('memory.correct.v1', 1::SMALLINT, 'correct',
                'Supersede, contradict, or revise an authorized memory claim.'),
              ('memory.forget.v1', 1::SMALLINT, 'forget',
                'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'),
              ('memory.formation.v1', 1::SMALLINT, 'formation',
                'Derive a candidate episode, claim, or summary from authorized evidence.'),
              ('memory.maintenance.v1', 1::SMALLINT, 'maintenance',
                'Run authorized retention, rebuild, reindex, or repair work.'),
              ('memory.export.v1', 1::SMALLINT, 'export',
                'Export an authorized memory set through portable or bulk egress.')
          ) expected(purpose_id, contract_version, operation_class, description)
            ON expected.purpose_id = actual.purpose_id
            AND expected.contract_version = actual.contract_version
            AND expected.operation_class = actual.operation_class
            AND expected.description = actual.description
          WHERE expected.purpose_id IS NULL
        )
      THEN
        RAISE EXCEPTION 'Memory purpose catalog seed contracts are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
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
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_catalog_row_is_valid(text,smallint,text,text)'
        )
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
          AND procedure.prosrc = $expected$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_memory_purpose_catalog_change()'
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
          AND procedure.prosrc =
            $expected$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$expected$
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
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
        RAISE EXCEPTION 'Memory purpose catalog is exposed to a serving role'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:purpose_catalog_check',
        'initiatingActorId', 'actor:purpose_catalog_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:purpose_catalog_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Memory purpose catalog self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope - 'purposeId'
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory access validator changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND procedure.prorettype = 'jsonb'::regtype
          AND procedure.provolatile = 's'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory access functions changed'
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
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook changed'
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
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'smallint'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = ''
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
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
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability boundary changed'
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
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity checks changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity uniqueness changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity mapping changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity triggers changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_auth_users'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity owner changed'
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
    END
    $migration$
  `;
}

export async function ensureTenantMemoryPurposeEntitlements(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory entitlement migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_purpose_entitlement_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_purpose_id TEXT,
      candidate_entitlement_generation BIGINT,
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
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_entitlement_generation BETWEEN 1 AND 9007199254740991
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
    CREATE TABLE IF NOT EXISTS omni_tenant_memory_purpose_entitlements (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      purpose_id TEXT NOT NULL,
      entitlement_generation BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_memory_purpose_entitlements_pkey
        PRIMARY KEY (tenant_id, purpose_id, entitlement_generation),
      CONSTRAINT omni_memory_purpose_entitlements_row_check CHECK (
        omni_memory_purpose_entitlement_row_is_valid(
          schema_version,
          tenant_id,
          purpose_id,
          entitlement_generation,
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
      CONSTRAINT omni_memory_purpose_entitlements_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_memory_purpose_entitlements_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_memory_purpose_entitlements_purpose_fkey
        FOREIGN KEY (purpose_id)
        REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_memory_purpose_entitlements_created_actor_fkey
        FOREIGN KEY (created_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_memory_purpose_entitlements_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_memory_purpose_entitlements_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_memory_purpose_entitlements_current_idx
    ON omni_tenant_memory_purpose_entitlements (tenant_id, purpose_id)
    WHERE state <> 'revoked'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_purpose_entitlement_insert()
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
        hashtext(NEW.purpose_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory purpose entitlements must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(entitlement.entitlement_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_purpose_entitlements entitlement
      WHERE entitlement.tenant_id = NEW.tenant_id
        AND entitlement.purpose_id = NEW.purpose_id;

      IF NEW.entitlement_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory purpose entitlement generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_memory_purpose_entitlements entitlement
        WHERE entitlement.tenant_id = NEW.tenant_id
          AND entitlement.purpose_id = NEW.purpose_id
          AND entitlement.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory purpose already has a current entitlement'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_memory_purpose_entitlement()
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
        RAISE EXCEPTION 'Memory purpose entitlement rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.purpose_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked memory purpose entitlements are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.purpose_id IS DISTINCT FROM OLD.purpose_id
        OR NEW.entitlement_generation IS DISTINCT FROM
          OLD.entitlement_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Memory purpose entitlement identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Memory purpose entitlement revision must increase once'
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
        RAISE EXCEPTION 'Memory purpose entitlement activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Memory purpose activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory purpose activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Memory purpose revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Memory purpose revocation metadata is unexpected'
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND tgname =
            'omni_memory_purpose_entitlement_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_entitlement_validate_insert
        BEFORE INSERT ON omni_tenant_memory_purpose_entitlements
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_memory_purpose_entitlement_insert();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND tgname = 'omni_memory_purpose_entitlement_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_entitlement_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_memory_purpose_entitlements
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_memory_purpose_entitlement();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND tgname = 'omni_memory_purpose_entitlement_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_purpose_entitlement_no_truncate
        BEFORE TRUNCATE ON omni_tenant_memory_purpose_entitlements
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_memory_purpose_entitlement();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_tenant_memory_purpose_entitlements
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_purpose_entitlement_row_is_valid(
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
    ON FUNCTION omni_validate_memory_purpose_entitlement_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_memory_purpose_entitlement()
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
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE ' ||
          '%I.omni_tenant_memory_purpose_entitlements FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_purpose_entitlements'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE ' ||
          '%I.omni_tenant_memory_purpose_entitlements FROM %s',
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
            'omni_memory_purpose_entitlement_row_is_valid',
            'omni_validate_memory_purpose_entitlement_insert',
            'omni_protect_memory_purpose_entitlement'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_memory_purpose_entitlement_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_memory_purpose_entitlement_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_memory_purpose_entitlement() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND polname = 'omni_memory_purpose_entitlement_holdback'
      ) THEN
        CREATE POLICY omni_memory_purpose_entitlement_holdback
        ON omni_tenant_memory_purpose_entitlements
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement relation is invalid'
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 5 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND attribute.attname IN ('created_at', 'updated_at')
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) <> 2 THEN
        RAISE EXCEPTION 'Memory purpose entitlement defaults are invalid'
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
          'omni_tenant_memory_purpose_entitlements'::regclass
          AND contype <> 'n'
      ) <> 8 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_tenant_memory_purpose_entitlements_pkey'
          AND constraint_record.conrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'entitlement_generation' AND NOT attisdropped
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
            'omni_memory_purpose_entitlements_row_check'
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
          ) =
            'omni_memory_purpose_entitlement_row_is_valid(schema_version, tenant_id, purpose_id, entitlement_generation, state, lifecycle_revision, created_by_actor_id, activated_by_actor_id, revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at)'
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
          ) =
            '(state <> ''active''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_memory_purpose_entitlements_tenant_fkey',
              'tenant_id',
              'omni_auth_tenants'::REGCLASS,
              'id'
            ),
            (
              'omni_memory_purpose_entitlements_purpose_fkey',
              'purpose_id',
              'omni_memory_purpose_catalog'::REGCLASS,
              'purpose_id'
            ),
            (
              'omni_memory_purpose_entitlements_created_actor_fkey',
              'created_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_memory_purpose_entitlements_activated_actor_fkey',
              'activated_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_memory_purpose_entitlements_revoked_actor_fkey',
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
              'omni_tenant_memory_purpose_entitlements'::regclass
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
                    'omni_tenant_memory_purpose_entitlements'::regclass
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
        RAISE EXCEPTION 'Memory purpose entitlement references are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_record.indexrelid =
            'omni_memory_purpose_entitlements_current_idx'::regclass
          AND index_record.indrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id'
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
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND pg_get_expr(index_record.indpred, index_record.indrelid) =
            '(state <> ''revoked''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement current index is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF public.omni_memory_purpose_entitlement_row_is_valid(
        1::SMALLINT,
        'tenant:entitlement_check',
        'memory.read.v1',
        1::BIGINT,
        'held',
        0::BIGINT,
        'actor:entitlement_check',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'active',
          1::BIGINT,
          'actor:entitlement_check',
          'actor:entitlement_check',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'active',
          0::BIGINT,
          'actor:entitlement_check',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'unknown',
          0::BIGINT,
          'actor:entitlement_check',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Memory purpose entitlement validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_entitlement_row_is_valid(smallint,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
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
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_entitlement_generation BETWEEN 1 AND 9007199254740991
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
          'public.omni_validate_memory_purpose_entitlement_insert()'
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
        hashtext(NEW.purpose_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory purpose entitlements must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(entitlement.entitlement_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_purpose_entitlements entitlement
      WHERE entitlement.tenant_id = NEW.tenant_id
        AND entitlement.purpose_id = NEW.purpose_id;

      IF NEW.entitlement_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory purpose entitlement generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_memory_purpose_entitlements entitlement
        WHERE entitlement.tenant_id = NEW.tenant_id
          AND entitlement.purpose_id = NEW.purpose_id
          AND entitlement.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory purpose already has a current entitlement'
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
          'public.omni_protect_memory_purpose_entitlement()'
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
        RAISE EXCEPTION 'Memory purpose entitlement rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.purpose_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked memory purpose entitlements are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.purpose_id IS DISTINCT FROM OLD.purpose_id
        OR NEW.entitlement_generation IS DISTINCT FROM
          OLD.entitlement_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Memory purpose entitlement identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Memory purpose entitlement revision must increase once'
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
        RAISE EXCEPTION 'Memory purpose entitlement activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Memory purpose activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory purpose activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Memory purpose revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Memory purpose revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND NOT tgisinternal
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_validate_insert'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_validate_memory_purpose_entitlement_insert()'
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_protect'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_memory_purpose_entitlement()'
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_memory_purpose_entitlement()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_memory_purpose_entitlements
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement shadow is not empty'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  // The catalog defines vocabulary only. It grants no tenant, actor, agent,
  // workflow, or maintenance process permission to use a purpose.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_memory_purpose_catalog'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog relation is invalid'
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
          WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names::TEXT[] = ARRAY[
            'purpose_id', 'contract_version', 'operation_class',
            'description', 'created_at'
          ]
          AND columns.all_not_null
          AND columns.none_generated
          AND columns.column_count = 5
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'purpose_id'
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'contract_version'
          AND atttypid = 'smallint'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname IN ('operation_class', 'description')
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
        GROUP BY attrelid
        HAVING count(*) = 2
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attribute.attname = 'created_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_pkey'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'purpose_id'
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
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_operation_version_key'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'operation_class'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'contract_version'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND NOT index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memory_purpose_catalog_contract_check'
          AND conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_memory_purpose_catalog_row_is_valid(purpose_id, contract_version, operation_class, description)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog constraints are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (SELECT count(*) FROM omni_memory_purpose_catalog) <> 8
        OR EXISTS (
          SELECT 1
          FROM omni_memory_purpose_catalog actual
          LEFT JOIN (
            VALUES
              ('memory.read.v1', 1::SMALLINT, 'read',
                'Inspect authorized memory records without selecting them for model context.'),
              ('memory.retrieve.v1', 1::SMALLINT, 'retrieve',
                'Search and select authorized memory content for a bounded context or RAG operation.'),
              ('memory.write.v1', 1::SMALLINT, 'write',
                'Create or import an explicit authorized memory record.'),
              ('memory.correct.v1', 1::SMALLINT, 'correct',
                'Supersede, contradict, or revise an authorized memory claim.'),
              ('memory.forget.v1', 1::SMALLINT, 'forget',
                'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'),
              ('memory.formation.v1', 1::SMALLINT, 'formation',
                'Derive a candidate episode, claim, or summary from authorized evidence.'),
              ('memory.maintenance.v1', 1::SMALLINT, 'maintenance',
                'Run authorized retention, rebuild, reindex, or repair work.'),
              ('memory.export.v1', 1::SMALLINT, 'export',
                'Export an authorized memory set through portable or bulk egress.')
          ) expected(purpose_id, contract_version, operation_class, description)
            ON expected.purpose_id = actual.purpose_id
            AND expected.contract_version = actual.contract_version
            AND expected.operation_class = actual.operation_class
            AND expected.description = actual.description
          WHERE expected.purpose_id IS NULL
        )
      THEN
        RAISE EXCEPTION 'Memory purpose catalog seed contracts are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
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
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_catalog_row_is_valid(text,smallint,text,text)'
        )
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
          AND procedure.prosrc = $expected$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_memory_purpose_catalog_change()'
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
          AND procedure.prosrc =
            $expected$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$expected$
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
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
        RAISE EXCEPTION 'Memory purpose catalog is exposed to a serving role'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:purpose_catalog_check',
        'initiatingActorId', 'actor:purpose_catalog_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:purpose_catalog_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Memory purpose catalog self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope - 'purposeId'
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory access validator changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND procedure.prorettype = 'jsonb'::regtype
          AND procedure.provolatile = 's'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory access functions changed'
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
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook changed'
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
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'smallint'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = ''
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
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
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability boundary changed'
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
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity checks changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity uniqueness changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity mapping changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity triggers changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_auth_users'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity owner changed'
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
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype <> 'n'
      ) <> 3 OR (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid = 'omni_memory_purpose_catalog'::regclass
      ) <> 2 OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND NOT tgisinternal
      ) <> 2 OR EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memory_purpose_catalog'::regclass
      ) OR EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE (
          constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          OR (
            constraint_record.conrelid = 'omni_memories'::regclass
            AND constraint_record.conname =
              'omni_memories_access_enrollment_hold_check'
          )
          OR (
            constraint_record.conrelid = 'omni_auth_users'::regclass
            AND constraint_record.conname IN (
              'omni_auth_users_id_uuid_check',
              'omni_auth_users_actor_id_contract_check'
            )
          )
        )
          AND NOT COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog object set changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantActorMemoryPurposeConsents(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory consent migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_memory_purpose_consent_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_subject_actor_id TEXT,
      candidate_purpose_id TEXT,
      candidate_consent_generation BIGINT,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_granted_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_granted_at TIMESTAMPTZ,
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
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'granted', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_granted_by_actor_id IS NULL
          OR (
            public.omni_source_contract_id_is_valid(
              candidate_granted_by_actor_id
            )
            AND candidate_granted_by_actor_id = candidate_subject_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR (
            public.omni_source_contract_id_is_valid(
              candidate_revoked_by_actor_id
            )
            AND candidate_revoked_by_actor_id = candidate_subject_actor_id
          )
        )
        AND (candidate_granted_by_actor_id IS NULL) =
          (candidate_granted_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_granted_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'granted'
            AND candidate_lifecycle_revision = 1
            AND candidate_granted_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_granted_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_granted_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_granted_at IS NULL
          OR candidate_created_at <= candidate_granted_at
        )
        AND (
          candidate_granted_at IS NULL
          OR candidate_granted_at <= candidate_updated_at
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
          candidate_granted_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_granted_at <= candidate_revoked_at
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_actor_memory_purpose_consents (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      subject_actor_id TEXT NOT NULL,
      purpose_id TEXT NOT NULL,
      consent_generation BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      granted_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      granted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_actor_memory_purpose_consents_pkey
        PRIMARY KEY (
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation
        ),
      CONSTRAINT omni_actor_memory_purpose_consents_row_check CHECK (
        omni_actor_memory_purpose_consent_row_is_valid(
          schema_version,
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          state,
          lifecycle_revision,
          created_by_actor_id,
          granted_by_actor_id,
          revoked_by_actor_id,
          created_at,
          granted_at,
          revoked_at,
          updated_at
        )
      ),
      CONSTRAINT omni_actor_memory_purpose_consents_grant_hold_check
        CHECK (state <> 'granted'),
      CONSTRAINT omni_actor_memory_purpose_consents_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_purpose_consents_purpose_fkey
        FOREIGN KEY (purpose_id)
        REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_purpose_consents_subject_actor_fkey
        FOREIGN KEY (subject_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_purpose_consents_created_actor_fkey
        FOREIGN KEY (created_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_purpose_consents_granted_actor_fkey
        FOREIGN KEY (granted_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_purpose_consents_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS
      omni_actor_memory_purpose_consents_current_idx
    ON omni_tenant_actor_memory_purpose_consents (
      tenant_id,
      subject_actor_id,
      purpose_id
    )
    WHERE state <> 'revoked'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_actor_memory_purpose_consent_insert()
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
        hashtext(NEW.subject_actor_id || chr(31) || NEW.purpose_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.granted_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.granted_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Actor memory purpose consents must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(consent.consent_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_actor_memory_purpose_consents consent
      WHERE consent.tenant_id = NEW.tenant_id
        AND consent.subject_actor_id = NEW.subject_actor_id
        AND consent.purpose_id = NEW.purpose_id;

      IF NEW.consent_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Actor memory purpose consent generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_memory_purpose_consents consent
        WHERE consent.tenant_id = NEW.tenant_id
          AND consent.subject_actor_id = NEW.subject_actor_id
          AND consent.purpose_id = NEW.purpose_id
          AND consent.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Actor already has a current purpose consent'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_protect_actor_memory_purpose_consent()
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
        RAISE EXCEPTION 'Actor memory purpose consent rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.subject_actor_id || chr(31) || OLD.purpose_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked actor memory purpose consents are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.purpose_id IS DISTINCT FROM OLD.purpose_id
        OR NEW.consent_generation IS DISTINCT FROM
          OLD.consent_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Actor memory purpose consent identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('granted', 'revoked'))
        OR (OLD.state = 'granted' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Actor memory purpose consent revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.granted_at IS NOT NULL AND (
        NEW.granted_at IS DISTINCT FROM OLD.granted_at
        OR NEW.granted_by_actor_id IS DISTINCT FROM
          OLD.granted_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent grant is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.granted_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'granted' THEN
          IF NEW.granted_by_actor_id IS DISTINCT FROM NEW.subject_actor_id THEN
            RAISE EXCEPTION 'Memory purpose grant attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.granted_at := transition_at;
        ELSIF NEW.granted_by_actor_id IS NOT NULL
          OR NEW.granted_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory purpose grant metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS DISTINCT FROM NEW.subject_actor_id THEN
          RAISE EXCEPTION 'Memory purpose revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Memory purpose revocation metadata is unexpected'
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND tgname =
            'omni_actor_memory_purpose_consent_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_purpose_consent_validate_insert
        BEFORE INSERT ON omni_tenant_actor_memory_purpose_consents
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_actor_memory_purpose_consent_insert();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND tgname = 'omni_actor_memory_purpose_consent_protect'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_purpose_consent_protect
        BEFORE UPDATE OR DELETE ON omni_tenant_actor_memory_purpose_consents
        FOR EACH ROW
        EXECUTE FUNCTION omni_protect_actor_memory_purpose_consent();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND tgname = 'omni_actor_memory_purpose_consent_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_purpose_consent_no_truncate
        BEFORE TRUNCATE ON omni_tenant_actor_memory_purpose_consents
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_protect_actor_memory_purpose_consent();
      END IF;
    END
    $migration$
  `;

  await sql.query(`
    REVOKE ALL
    ON TABLE omni_tenant_actor_memory_purpose_consents
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_actor_memory_purpose_consent_row_is_valid(
      SMALLINT,
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
    ON FUNCTION omni_validate_actor_memory_purpose_consent_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_protect_actor_memory_purpose_consent()
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
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE ' ||
          '%I.omni_tenant_actor_memory_purpose_consents FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;

      FOR grant_record IN
        SELECT DISTINCT grantee, privilege_type, column_name
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_purpose_consents'
          AND grantee <> current_user
      LOOP
        EXECUTE format(
          'REVOKE %s (%I) ON TABLE ' ||
          '%I.omni_tenant_actor_memory_purpose_consents FROM %s',
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
            'omni_actor_memory_purpose_consent_row_is_valid',
            'omni_validate_actor_memory_purpose_consent_insert',
            'omni_protect_actor_memory_purpose_consent'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_actor_memory_purpose_consent_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, ' ||
          'TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_actor_memory_purpose_consent_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_protect_actor_memory_purpose_consent() FROM %I',
          current_schema(),
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `);

  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND polname = 'omni_actor_memory_purpose_consent_holdback'
      ) THEN
        CREATE POLICY omni_actor_memory_purpose_consent_holdback
        ON omni_tenant_actor_memory_purpose_consents
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent relation is invalid'
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_tenant_actor_memory_purpose_consents'::regclass
      ) <> 5 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND attribute.attname IN ('created_at', 'updated_at')
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) <> 2 THEN
        RAISE EXCEPTION 'Actor memory purpose consent defaults are invalid'
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
          'omni_tenant_actor_memory_purpose_consents'::regclass
          AND contype <> 'n'
      ) <> 9 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_tenant_actor_memory_purpose_consents_pkey'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
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
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'subject_actor_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'consent_generation' AND NOT attisdropped
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
            'omni_actor_memory_purpose_consents_row_check'
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
          ) =
            'omni_actor_memory_purpose_consent_row_is_valid(schema_version, tenant_id, subject_actor_id, purpose_id, consent_generation, state, lifecycle_revision, created_by_actor_id, granted_by_actor_id, revoked_by_actor_id, created_at, granted_at, revoked_at, updated_at)'
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
          ) =
            '(state <> ''granted''::text)'
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_memory_purpose_consents_tenant_fkey',
              'tenant_id',
              'omni_auth_tenants'::REGCLASS,
              'id'
            ),
            (
              'omni_actor_memory_purpose_consents_purpose_fkey',
              'purpose_id',
              'omni_memory_purpose_catalog'::REGCLASS,
              'purpose_id'
            ),
            (
              'omni_actor_memory_purpose_consents_subject_actor_fkey',
              'subject_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_memory_purpose_consents_created_actor_fkey',
              'created_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_memory_purpose_consents_granted_actor_fkey',
              'granted_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_actor_memory_purpose_consents_revoked_actor_fkey',
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
              'omni_tenant_actor_memory_purpose_consents'::regclass
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
                    'omni_tenant_actor_memory_purpose_consents'::regclass
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
        RAISE EXCEPTION 'Actor memory purpose consent references are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_tenant_actor_memory_purpose_consents'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_record.indexrelid =
            'omni_actor_memory_purpose_consents_current_idx'::regclass
          AND index_record.indrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
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
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'subject_actor_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'purpose_id'
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
          ) = ARRAY[0, 0, 0]::SMALLINT[]
          AND (
            SELECT array_agg(key_attribute ORDER BY ordinal_position)
            FROM unnest(index_record.indkey)
              WITH ORDINALITY AS key_columns(
                key_attribute,
                ordinal_position
              )
          ) = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'subject_actor_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_purpose_consents'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND pg_get_expr(index_record.indpred, index_record.indrelid) =
            '(state <> ''revoked''::text)'
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent current index is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF public.omni_actor_memory_purpose_consent_row_is_valid(
        1::SMALLINT,
        'tenant:consent_check',
        'actor:consent_subject',
        'memory.read.v1',
        1::BIGINT,
        'held',
        0::BIGINT,
        'actor:consent_creator',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_check',
          'actor:consent_subject',
          'memory.read.v1',
          1::BIGINT,
          'granted',
          1::BIGINT,
          'actor:consent_creator',
          'actor:consent_subject',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_check',
          'actor:consent_subject',
          'memory.read.v1',
          1::BIGINT,
          'granted',
          0::BIGINT,
          'actor:consent_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_check',
          'actor:consent_subject',
          'memory.read.v1',
          1::BIGINT,
          'unknown',
          0::BIGINT,
          'actor:consent_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_check',
          'actor:consent_subject',
          'memory.export.v1',
          1::BIGINT,
          'held',
          0::BIGINT,
          'actor:consent_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_check',
          'actor:consent_subject',
          'memory.read.v1',
          1::BIGINT,
          'granted',
          1::BIGINT,
          'actor:consent_creator',
          'actor:other',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Actor memory purpose consent validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
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
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_state IN ('held', 'granted', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_created_by_actor_id
        )
        AND (
          candidate_granted_by_actor_id IS NULL
          OR (
            public.omni_source_contract_id_is_valid(
              candidate_granted_by_actor_id
            )
            AND candidate_granted_by_actor_id = candidate_subject_actor_id
          )
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR (
            public.omni_source_contract_id_is_valid(
              candidate_revoked_by_actor_id
            )
            AND candidate_revoked_by_actor_id = candidate_subject_actor_id
          )
        )
        AND (candidate_granted_by_actor_id IS NULL) =
          (candidate_granted_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held'
            AND candidate_lifecycle_revision = 0
            AND candidate_granted_at IS NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'granted'
            AND candidate_lifecycle_revision = 1
            AND candidate_granted_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          )
          OR (
            candidate_state = 'revoked'
            AND candidate_revoked_at IS NOT NULL
            AND (
              (
                candidate_granted_at IS NULL
                AND candidate_lifecycle_revision = 1
              )
              OR (
                candidate_granted_at IS NOT NULL
                AND candidate_lifecycle_revision = 2
              )
            )
          )
        )
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_granted_at IS NULL
          OR candidate_created_at <= candidate_granted_at
        )
        AND (
          candidate_granted_at IS NULL
          OR candidate_granted_at <= candidate_updated_at
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
          candidate_granted_at IS NULL
          OR candidate_revoked_at IS NULL
          OR candidate_granted_at <= candidate_revoked_at
        ),
        FALSE
      )
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_validate_actor_memory_purpose_consent_insert()'
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
        hashtext(NEW.subject_actor_id || chr(31) || NEW.purpose_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.granted_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.granted_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Actor memory purpose consents must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(consent.consent_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_actor_memory_purpose_consents consent
      WHERE consent.tenant_id = NEW.tenant_id
        AND consent.subject_actor_id = NEW.subject_actor_id
        AND consent.purpose_id = NEW.purpose_id;

      IF NEW.consent_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Actor memory purpose consent generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_actor_memory_purpose_consents consent
        WHERE consent.tenant_id = NEW.tenant_id
          AND consent.subject_actor_id = NEW.subject_actor_id
          AND consent.purpose_id = NEW.purpose_id
          AND consent.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Actor already has a current purpose consent'
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
          'public.omni_protect_actor_memory_purpose_consent()'
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
        RAISE EXCEPTION 'Actor memory purpose consent rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.subject_actor_id || chr(31) || OLD.purpose_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked actor memory purpose consents are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.subject_actor_id IS DISTINCT FROM OLD.subject_actor_id
        OR NEW.purpose_id IS DISTINCT FROM OLD.purpose_id
        OR NEW.consent_generation IS DISTINCT FROM
          OLD.consent_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Actor memory purpose consent identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('granted', 'revoked'))
        OR (OLD.state = 'granted' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Actor memory purpose consent revision must increase once'
          USING ERRCODE = '23514';
      END IF;

      transition_at := GREATEST(
        statement_timestamp(),
        OLD.updated_at + INTERVAL '1 microsecond'
      );
      NEW.updated_at := transition_at;

      IF OLD.granted_at IS NOT NULL AND (
        NEW.granted_at IS DISTINCT FROM OLD.granted_at
        OR NEW.granted_by_actor_id IS DISTINCT FROM
          OLD.granted_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent grant is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.granted_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'granted' THEN
          IF NEW.granted_by_actor_id IS DISTINCT FROM NEW.subject_actor_id THEN
            RAISE EXCEPTION 'Memory purpose grant attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.granted_at := transition_at;
        ELSIF NEW.granted_by_actor_id IS NOT NULL
          OR NEW.granted_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory purpose grant metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS DISTINCT FROM NEW.subject_actor_id THEN
          RAISE EXCEPTION 'Memory purpose revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Memory purpose revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND NOT tgisinternal
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND trigger_record.tgname =
            'omni_actor_memory_purpose_consent_validate_insert'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_validate_actor_memory_purpose_consent_insert()'
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND trigger_record.tgname =
            'omni_actor_memory_purpose_consent_protect'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_actor_memory_purpose_consent()'
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND trigger_record.tgname =
            'omni_actor_memory_purpose_consent_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_actor_memory_purpose_consent()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent shadow is not empty'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  // The catalog defines vocabulary only. It grants no tenant, actor, agent,
  // workflow, or maintenance process permission to use a purpose.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_memory_purpose_catalog'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog relation is invalid'
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
          WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names::TEXT[] = ARRAY[
            'purpose_id', 'contract_version', 'operation_class',
            'description', 'created_at'
          ]
          AND columns.all_not_null
          AND columns.none_generated
          AND columns.column_count = 5
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'purpose_id'
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname = 'contract_version'
          AND atttypid = 'smallint'::regtype
          AND NOT attisdropped
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attname IN ('operation_class', 'description')
          AND atttypid = 'text'::regtype
          AND NOT attisdropped
        GROUP BY attrelid
        HAVING count(*) = 2
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memory_purpose_catalog'::regclass
          AND attribute.attname = 'created_at'
          AND attribute.atttypid = 'timestamp with time zone'::regtype
          AND NOT attribute.attisdropped
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_pkey'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'p'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'purpose_id'
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
        WHERE constraint_record.conname =
            'omni_memory_purpose_catalog_operation_version_key'
          AND constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.contype = 'u'
          AND constraint_record.convalidated
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'operation_class'
                AND NOT attisdropped
            ),
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'contract_version'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND NOT index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_memory_purpose_catalog_contract_check'
          AND conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_memory_purpose_catalog_row_is_valid(purpose_id, contract_version, operation_class, description)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog constraints are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (SELECT count(*) FROM omni_memory_purpose_catalog) <> 8
        OR EXISTS (
          SELECT 1
          FROM omni_memory_purpose_catalog actual
          LEFT JOIN (
            VALUES
              ('memory.read.v1', 1::SMALLINT, 'read',
                'Inspect authorized memory records without selecting them for model context.'),
              ('memory.retrieve.v1', 1::SMALLINT, 'retrieve',
                'Search and select authorized memory content for a bounded context or RAG operation.'),
              ('memory.write.v1', 1::SMALLINT, 'write',
                'Create or import an explicit authorized memory record.'),
              ('memory.correct.v1', 1::SMALLINT, 'correct',
                'Supersede, contradict, or revise an authorized memory claim.'),
              ('memory.forget.v1', 1::SMALLINT, 'forget',
                'Explicitly and irreversibly delete or scrub authorized memory and its descendants.'),
              ('memory.formation.v1', 1::SMALLINT, 'formation',
                'Derive a candidate episode, claim, or summary from authorized evidence.'),
              ('memory.maintenance.v1', 1::SMALLINT, 'maintenance',
                'Run authorized retention, rebuild, reindex, or repair work.'),
              ('memory.export.v1', 1::SMALLINT, 'export',
                'Export an authorized memory set through portable or bulk egress.')
          ) expected(purpose_id, contract_version, operation_class, description)
            ON expected.purpose_id = actual.purpose_id
            AND expected.contract_version = actual.contract_version
            AND expected.operation_class = actual.operation_class
            AND expected.description = actual.description
          WHERE expected.purpose_id IS NULL
        )
      THEN
        RAISE EXCEPTION 'Memory purpose catalog seed contracts are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_immutable'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
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
            'omni_memory_purpose_catalog'::regclass
          AND trigger_record.tgname = 'omni_memory_purpose_catalog_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_reject_memory_purpose_catalog_change()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_catalog_row_is_valid(text,smallint,text,text)'
        )
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
          AND procedure.prosrc = $expected$SELECT public.omni_source_contract_id_is_valid(candidate_purpose_id) AND candidate_contract_version BETWEEN 1 AND 32767 AND candidate_operation_class IN ('read', 'retrieve', 'write', 'correct', 'forget', 'formation', 'maintenance', 'export') AND candidate_purpose_id = 'memory.' || candidate_operation_class || '.v' || candidate_contract_version::TEXT AND candidate_description = btrim(candidate_description) AND char_length(candidate_description) BETWEEN 1 AND 500$expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_memory_purpose_catalog_change()'
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
          AND procedure.prosrc =
            $expected$BEGIN RAISE EXCEPTION 'Memory purpose contracts are append-only' USING ERRCODE = '55000'; END$expected$
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_purpose_catalog_row_is_valid',
            'omni_reject_memory_purpose_catalog_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
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
        RAISE EXCEPTION 'Memory purpose catalog is exposed to a serving role'
          USING ERRCODE = '55000';
      END IF;

      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:purpose_catalog_check',
        'initiatingActorId', 'actor:purpose_catalog_check',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:purpose_catalog_check',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Memory purpose catalog self-check'
      );
      IF public.omni_memory_access_scope_v1_is_valid(valid_scope)
        IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_authorized(valid_scope)
          IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory authorization boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF public.omni_memory_access_scope_v1_is_valid(
        jsonb_set(
          valid_scope,
          '{executingPrincipalType}',
          '"system"'::JSONB
        )
      ) IS DISTINCT FROM TRUE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope - 'purposeId'
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          valid_scope || jsonb_build_object('extra', TRUE)
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid('[]'::JSONB)
          IS DISTINCT FROM FALSE
        OR public.omni_memory_access_scope_v1_is_valid(
          jsonb_set(
            valid_scope,
            '{executingPrincipalId}',
            '"actor:other"'::JSONB
          )
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:a', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
        OR public.omni_memory_access_grant_ids_v1_are_canonical(
          jsonb_build_array('grant:b', 'grant:a'),
          256
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Dormant memory access validator changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_current_memory_access_scope_v1%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_scope_v1_is_valid%'
          OR COALESCE(pg_get_expr(polqual, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
          OR COALESCE(pg_get_expr(polwithcheck, polrelid), '') LIKE
            '%omni_memory_access_grant_ids_v1_are_canonical%'
      ) THEN
        RAISE EXCEPTION 'A row policy uses the dormant access contract'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_grant_ids_v1_are_canonical(jsonb,integer)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_access_scope_v1_is_valid(jsonb)'
        )
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
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_current_memory_access_scope_v1()'
        )
          AND procedure.prorettype = 'jsonb'::regtype
          AND procedure.provolatile = 's'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_ids_v1_are_canonical',
            'omni_memory_access_scope_v1_is_valid',
            'omni_current_memory_access_scope_v1'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory access functions changed'
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
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_memory_access_scope_v1_is_authorized'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Dormant memory authorization hook changed'
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
          AND pg_get_expr(conbin, conrelid) =
            '(access_contract_version = 0)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid = 'omni_memories'::regclass
          AND attribute.attname = 'access_contract_version'
          AND NOT attribute.attisdropped
          AND attribute.atttypid = 'smallint'::regtype
          AND attribute.attnotnull
          AND attribute.attgenerated = ''
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('0', '0::smallint', '(0)::smallint')
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
        RAISE EXCEPTION 'Memory access enrollment boundary changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memories'::regclass
          AND tgname = 'omni_memories_access_scope_immutable'
          AND NOT tgisinternal
          AND tgenabled = 'O'
          AND pg_get_triggerdef(oid, TRUE) =
            'CREATE TRIGGER omni_memories_access_scope_immutable BEFORE UPDATE OF tenant_id, access_contract_version, access_state, owner_actor_id, owner_agent_id, workspace_id, project_id, mission_id, visibility, sensitivity, origin_purpose, allowed_purpose_ids, access_scope_sha256, access_bound_at ON omni_memories FOR EACH ROW EXECUTE FUNCTION omni_reject_bound_memory_access_change()'
      ) THEN
        RAISE EXCEPTION 'Memory access immutability boundary changed'
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
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user actor identity changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_id_uuid_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'omni_auth_users_actor_id_contract_check'
          AND conrelid = 'omni_auth_users'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_source_contract_id_is_valid(actor_id)'
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity checks changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity uniqueness changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity mapping changed'
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
        RAISE EXCEPTION 'Canonical auth-user identity triggers changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_auth_user_identity_change()'
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
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_reject_auth_user_identity_change'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity function changed'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'omni_auth_users'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Canonical auth-user identity owner changed'
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
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid = 'omni_memory_purpose_catalog'::regclass
          AND contype <> 'n'
      ) <> 3 OR (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid = 'omni_memory_purpose_catalog'::regclass
      ) <> 2 OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_purpose_catalog'::regclass
          AND NOT tgisinternal
      ) <> 2 OR EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'omni_memory_purpose_catalog'::regclass
      ) OR EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE (
          constraint_record.conrelid =
            'omni_memory_purpose_catalog'::regclass
          OR (
            constraint_record.conrelid = 'omni_memories'::regclass
            AND constraint_record.conname =
              'omni_memories_access_enrollment_hold_check'
          )
          OR (
            constraint_record.conrelid = 'omni_auth_users'::regclass
            AND constraint_record.conname IN (
              'omni_auth_users_id_uuid_check',
              'omni_auth_users_actor_id_contract_check'
            )
          )
        )
          AND NOT COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
      ) THEN
        RAISE EXCEPTION 'Memory purpose catalog object set changed'
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement relation is invalid'
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement columns are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 5 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND attribute.attname IN ('created_at', 'updated_at')
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) <> 2 THEN
        RAISE EXCEPTION 'Memory purpose entitlement defaults are invalid'
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
          'omni_tenant_memory_purpose_entitlements'::regclass
          AND contype <> 'n'
      ) <> 8 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        WHERE constraint_record.conname =
            'omni_tenant_memory_purpose_entitlements_pkey'
          AND constraint_record.conrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'entitlement_generation' AND NOT attisdropped
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
            'omni_memory_purpose_entitlements_row_check'
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
          ) =
            'omni_memory_purpose_entitlement_row_is_valid(schema_version, tenant_id, purpose_id, entitlement_generation, state, lifecycle_revision, created_by_actor_id, activated_by_actor_id, revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at)'
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
          ) =
            '(state <> ''active''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_memory_purpose_entitlements_tenant_fkey',
              'tenant_id',
              'omni_auth_tenants'::REGCLASS,
              'id'
            ),
            (
              'omni_memory_purpose_entitlements_purpose_fkey',
              'purpose_id',
              'omni_memory_purpose_catalog'::REGCLASS,
              'purpose_id'
            ),
            (
              'omni_memory_purpose_entitlements_created_actor_fkey',
              'created_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_memory_purpose_entitlements_activated_actor_fkey',
              'activated_by_actor_id',
              'omni_auth_users'::REGCLASS,
              'actor_id'
            ),
            (
              'omni_memory_purpose_entitlements_revoked_actor_fkey',
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
              'omni_tenant_memory_purpose_entitlements'::regclass
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
                    'omni_tenant_memory_purpose_entitlements'::regclass
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
        RAISE EXCEPTION 'Memory purpose entitlement references are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_tenant_memory_purpose_entitlements'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_index index_record
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_record.indexrelid =
            'omni_memory_purpose_entitlements_current_idx'::regclass
          AND index_record.indrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
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
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attcollation
              FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id'
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
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_memory_purpose_entitlements'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND pg_get_expr(index_record.indpred, index_record.indrelid) =
            '(state <> ''revoked''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement current index is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF public.omni_memory_purpose_entitlement_row_is_valid(
        1::SMALLINT,
        'tenant:entitlement_check',
        'memory.read.v1',
        1::BIGINT,
        'held',
        0::BIGINT,
        'actor:entitlement_check',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'active',
          1::BIGINT,
          'actor:entitlement_check',
          'actor:entitlement_check',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'active',
          0::BIGINT,
          'actor:entitlement_check',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_memory_purpose_entitlement_row_is_valid(
          1::SMALLINT,
          'tenant:entitlement_check',
          'memory.read.v1',
          1::BIGINT,
          'unknown',
          0::BIGINT,
          'actor:entitlement_check',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Memory purpose entitlement validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_memory_purpose_entitlement_row_is_valid(smallint,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
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
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_entitlement_generation BETWEEN 1 AND 9007199254740991
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
          'public.omni_validate_memory_purpose_entitlement_insert()'
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
        hashtext(NEW.purpose_id)
      );

      IF NEW.state <> 'held'
        OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory purpose entitlements must start held'
          USING ERRCODE = '23514';
      END IF;

      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;

      SELECT COALESCE(MAX(entitlement.entitlement_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_purpose_entitlements entitlement
      WHERE entitlement.tenant_id = NEW.tenant_id
        AND entitlement.purpose_id = NEW.purpose_id;

      IF NEW.entitlement_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory purpose entitlement generation is not next'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_tenant_memory_purpose_entitlements entitlement
        WHERE entitlement.tenant_id = NEW.tenant_id
          AND entitlement.purpose_id = NEW.purpose_id
          AND entitlement.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory purpose already has a current entitlement'
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
          'public.omni_protect_memory_purpose_entitlement()'
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
        RAISE EXCEPTION 'Memory purpose entitlement rows cannot be removed'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext(OLD.tenant_id),
        hashtext(OLD.purpose_id)
      );

      IF OLD.state = 'revoked' THEN
        RAISE EXCEPTION 'Revoked memory purpose entitlements are immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.purpose_id IS DISTINCT FROM OLD.purpose_id
        OR NEW.entitlement_generation IS DISTINCT FROM
          OLD.entitlement_generation
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'Memory purpose entitlement identity is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF NOT (
        (OLD.state = 'held' AND NEW.state IN ('active', 'revoked'))
        OR (OLD.state = 'active' AND NEW.state = 'revoked')
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement transition is invalid'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.lifecycle_revision <> OLD.lifecycle_revision + 1 THEN
        RAISE EXCEPTION 'Memory purpose entitlement revision must increase once'
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
        RAISE EXCEPTION 'Memory purpose entitlement activation is immutable'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.activated_at IS NULL THEN
        IF OLD.state = 'held' AND NEW.state = 'active' THEN
          IF NEW.activated_by_actor_id IS NULL THEN
            RAISE EXCEPTION 'Memory purpose activation attribution is invalid'
              USING ERRCODE = '23514';
          END IF;
          NEW.activated_at := transition_at;
        ELSIF NEW.activated_by_actor_id IS NOT NULL
          OR NEW.activated_at IS NOT NULL
        THEN
          RAISE EXCEPTION 'Memory purpose activation metadata is unexpected'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.state = 'revoked' THEN
        IF NEW.revoked_by_actor_id IS NULL THEN
          RAISE EXCEPTION 'Memory purpose revocation attribution is invalid'
            USING ERRCODE = '23514';
        END IF;
        NEW.revoked_at := transition_at;
      ELSIF NEW.revoked_by_actor_id IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Memory purpose revocation metadata is unexpected'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND NOT tgisinternal
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_record
        WHERE trigger_record.tgrelid =
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_validate_insert'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_validate_memory_purpose_entitlement_insert()'
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_protect'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_memory_purpose_entitlement()'
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
            'omni_tenant_memory_purpose_entitlements'::regclass
          AND trigger_record.tgname =
            'omni_memory_purpose_entitlement_no_truncate'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgfoid = to_regprocedure(
            'public.omni_protect_memory_purpose_entitlement()'
          )
          AND trigger_record.tgtype = 34
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND trigger_record.tgconstraint = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgattr::TEXT = ''
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
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
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM omni_tenant_memory_purpose_entitlements
      ) THEN
        RAISE EXCEPTION 'Memory purpose entitlement shadow is not empty'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantMemoryAccessGrantsShadow(sql: SqlClient) {
  // v62 reserves exact context and capability grants. It does not translate
  // OAuth, rollout, tenant role, prior access, or persona configuration into
  // authority, and it cannot activate a grant.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory grant migration requires the schema owner'
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
      omni_memory_purpose_catalog,
      omni_tenant_execution_principals,
      omni_tenant_workspaces,
      omni_memories
    IN SHARE MODE
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*) FROM omni_schema_version
        WHERE version = 61
          AND name = 'tenant_workspace_membership_authority_shadow'
          AND checksum =
            '8b33c54d950086f02770907218712576bb64fbad2a685f317a8b1df3f42eb243'
      ) <> 1 THEN
        RAISE EXCEPTION 'Memory grant v61 predecessor marker is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF to_regprocedure(
        'public.omni_actor_has_active_tenant_membership(text,text)'
      ) IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_access_enrollment_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory grant authorization predecessors changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_grant_binding_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_grant_kind TEXT,
      candidate_grant_id TEXT,
      candidate_grant_generation BIGINT,
      candidate_grantee_kind TEXT,
      candidate_grantee_key TEXT,
      candidate_grantee_actor_id TEXT,
      candidate_grantee_principal_id TEXT,
      candidate_grantee_principal_generation BIGINT,
      candidate_purpose_id TEXT,
      candidate_visibility TEXT,
      candidate_owner_actor_id TEXT,
      candidate_owner_agent_id TEXT,
      candidate_owner_agent_generation BIGINT,
      candidate_workspace_id TEXT,
      candidate_project_id TEXT,
      candidate_mission_id TEXT,
      candidate_resource_ids TEXT[],
      candidate_operation_ids TEXT[],
      candidate_max_items BIGINT,
      candidate_max_bytes BIGINT,
      candidate_max_invocations BIGINT,
      candidate_max_cost_microusd BIGINT,
      candidate_max_duration_ms BIGINT
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
        AND candidate_grant_kind IN ('context', 'capability')
        AND (
          (candidate_grant_kind = 'context' AND candidate_grant_id ~
            '^context:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
          OR
          (candidate_grant_kind = 'capability' AND candidate_grant_id ~
            '^capability:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
        )
        AND candidate_grant_generation BETWEEN 1 AND 9007199254740991
        AND candidate_grantee_kind IN ('user', 'agent', 'system')
        AND candidate_grantee_key = COALESCE(
          candidate_grantee_actor_id,
          candidate_grantee_principal_id
        )
        AND (
          (
            candidate_grantee_kind = 'user'
            AND candidate_grantee_actor_id ~
              '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND candidate_grantee_principal_id IS NULL
            AND candidate_grantee_principal_generation IS NULL
          ) OR (
            candidate_grantee_kind = 'agent'
            AND candidate_grantee_actor_id IS NULL
            AND candidate_grantee_principal_id ~
              '^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_grantee_principal_generation
              BETWEEN 1 AND 9007199254740991
          ) OR (
            candidate_grantee_kind = 'system'
            AND candidate_grantee_actor_id IS NULL
            AND candidate_grantee_principal_id ~
              '^service:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_grantee_principal_generation
              BETWEEN 1 AND 9007199254740991
          )
        )
        AND candidate_purpose_id IN (
          'memory.read.v1', 'memory.retrieve.v1', 'memory.write.v1',
          'memory.correct.v1', 'memory.forget.v1', 'memory.formation.v1',
          'memory.maintenance.v1', 'memory.export.v1'
        )
        AND (
          candidate_grant_kind <> 'context'
          OR candidate_purpose_id IN ('memory.read.v1', 'memory.retrieve.v1')
        )
        AND candidate_visibility IN (
          'agent_private', 'user_private', 'mission_shared',
          'project_shared', 'workspace_shared'
        )
        AND candidate_owner_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          (
            candidate_visibility = 'agent_private'
            AND candidate_owner_agent_id ~
              '^agent:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_owner_agent_generation
              BETWEEN 1 AND 9007199254740991
            AND candidate_workspace_id IS NULL
            AND candidate_project_id IS NULL
            AND candidate_mission_id IS NULL
          ) OR (
            candidate_visibility = 'user_private'
            AND candidate_owner_agent_id IS NULL
            AND candidate_owner_agent_generation IS NULL
            AND candidate_workspace_id IS NULL
            AND candidate_project_id IS NULL
            AND candidate_mission_id IS NULL
          ) OR (
            candidate_visibility = 'mission_shared'
            AND candidate_owner_agent_id IS NULL
            AND candidate_owner_agent_generation IS NULL
            AND candidate_workspace_id IS NULL
            AND candidate_project_id IS NULL
            AND public.omni_source_contract_id_is_valid(candidate_mission_id)
          ) OR (
            candidate_visibility = 'project_shared'
            AND candidate_owner_agent_id IS NULL
            AND candidate_owner_agent_generation IS NULL
            AND candidate_workspace_id ~
              '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND public.omni_source_contract_id_is_valid(candidate_project_id)
            AND candidate_mission_id IS NULL
          ) OR (
            candidate_visibility = 'workspace_shared'
            AND candidate_owner_agent_id IS NULL
            AND candidate_owner_agent_generation IS NULL
            AND candidate_workspace_id ~
              '^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
            AND candidate_project_id IS NULL
            AND candidate_mission_id IS NULL
          )
        )
        AND public.omni_source_id_array_is_canonical(
          candidate_resource_ids, 128
        )
        AND (
          (
            candidate_grant_kind = 'context'
            AND candidate_operation_ids IS NULL
            AND candidate_max_items BETWEEN 1 AND 9007199254740991
            AND candidate_max_bytes BETWEEN 1 AND 9007199254740991
            AND candidate_max_invocations IS NULL
            AND candidate_max_cost_microusd IS NULL
            AND candidate_max_duration_ms IS NULL
          ) OR (
            candidate_grant_kind = 'capability'
            AND public.omni_source_id_array_is_canonical(
              candidate_operation_ids, 64
            )
            AND candidate_max_items IS NULL
            AND candidate_max_bytes IS NULL
            AND candidate_max_invocations BETWEEN 1 AND 9007199254740991
            AND candidate_max_cost_microusd BETWEEN 1 AND 9007199254740991
            AND candidate_max_duration_ms BETWEEN 1 AND 9007199254740991
          )
        ),
        FALSE
      )
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_access_grant_lifecycle_is_valid(
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_not_before TIMESTAMPTZ,
      candidate_expires_at TIMESTAMPTZ,
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
        candidate_state IN ('held', 'active', 'revoked')
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
            candidate_state = 'held' AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'active' AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'revoked' AND candidate_revoked_at IS NOT NULL
            AND (
              (candidate_activated_at IS NULL AND candidate_lifecycle_revision = 1)
              OR
              (candidate_activated_at IS NOT NULL AND candidate_lifecycle_revision = 2)
            )
          )
        )
        AND candidate_created_at <= candidate_not_before
        AND candidate_not_before < candidate_expires_at
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
    CREATE TABLE IF NOT EXISTS omni_tenant_memory_access_grants (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      grant_kind TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      grant_generation BIGINT NOT NULL,
      grantee_kind TEXT NOT NULL,
      grantee_key TEXT NOT NULL,
      grantee_actor_id TEXT,
      grantee_execution_principal_id TEXT,
      grantee_execution_principal_generation BIGINT,
      purpose_id TEXT NOT NULL,
      target_visibility TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      owner_agent_id TEXT,
      owner_agent_principal_generation BIGINT,
      workspace_id TEXT,
      project_id TEXT,
      mission_id TEXT,
      resource_ids TEXT[] NOT NULL,
      operation_ids TEXT[],
      max_items BIGINT,
      max_bytes BIGINT,
      max_invocations BIGINT,
      max_cost_microusd BIGINT,
      max_duration_ms BIGINT,
      not_before TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_access_grants_pkey PRIMARY KEY (
        tenant_id, grant_kind, grant_id, grant_generation
      ),
      CONSTRAINT omni_memory_access_grant_binding_check CHECK (
        omni_memory_access_grant_binding_is_valid(
          schema_version, tenant_id, grant_kind, grant_id, grant_generation,
          grantee_kind, grantee_key, grantee_actor_id,
          grantee_execution_principal_id,
          grantee_execution_principal_generation, purpose_id,
          target_visibility, owner_actor_id, owner_agent_id,
          owner_agent_principal_generation, workspace_id, project_id,
          mission_id, resource_ids, operation_ids, max_items, max_bytes,
          max_invocations, max_cost_microusd, max_duration_ms
        )
      ),
      CONSTRAINT omni_memory_access_grant_lifecycle_check CHECK (
        omni_memory_access_grant_lifecycle_is_valid(
          state, lifecycle_revision, created_by_actor_id,
          activated_by_actor_id, revoked_by_actor_id, not_before, expires_at,
          created_at, activated_at, revoked_at, updated_at
        )
      ),
      CONSTRAINT omni_memory_access_grant_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_memory_access_grant_tenant_fkey FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_purpose_fkey FOREIGN KEY (purpose_id)
        REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_grantee_actor_fkey
        FOREIGN KEY (grantee_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_grantee_principal_fkey
        FOREIGN KEY (
          tenant_id, grantee_execution_principal_id,
          grantee_execution_principal_generation
        ) REFERENCES omni_tenant_execution_principals (
          tenant_id, principal_id, principal_generation
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_owner_actor_fkey
        FOREIGN KEY (owner_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_owner_agent_fkey
        FOREIGN KEY (
          tenant_id, owner_agent_id, owner_agent_principal_generation
        ) REFERENCES omni_tenant_execution_principals (
          tenant_id, principal_id, principal_generation
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_workspace_fkey
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES omni_tenant_workspaces (tenant_id, workspace_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_created_actor_fkey
        FOREIGN KEY (created_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_access_grant_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_access_grants_current_idx
    ON omni_tenant_memory_access_grants (tenant_id, grant_kind, grant_id)
    WHERE state <> 'revoked'
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_access_grants_grantee_idx
    ON omni_tenant_memory_access_grants (
      tenant_id, grantee_kind, grantee_key, grant_kind, purpose_id, state
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_access_grants_expiry_idx
    ON omni_tenant_memory_access_grants (state, expires_at)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_access_grant_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_generation BIGINT;
      insertion_time TIMESTAMPTZ;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id || ':' || NEW.grant_kind),
        hashtext(NEW.grant_id)
      );
      IF NEW.state <> 'held' OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory access grants must start held'
          USING ERRCODE = '23514';
      END IF;
      IF NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.created_by_actor_id
      ) OR NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.owner_actor_id
      ) THEN
        RAISE EXCEPTION 'Memory access grant actors lack active tenant membership'
          USING ERRCODE = '23503';
      END IF;
      IF NEW.grantee_kind = 'user' AND NOT
        public.omni_actor_has_active_tenant_membership(
          NEW.tenant_id, NEW.grantee_actor_id
        )
      THEN
        RAISE EXCEPTION 'Memory access grant user lacks active tenant membership'
          USING ERRCODE = '23503';
      END IF;
      IF NEW.grantee_kind IN ('agent', 'system') AND NOT EXISTS (
        SELECT 1 FROM public.omni_tenant_execution_principals principal
        WHERE principal.tenant_id = NEW.tenant_id
          AND principal.principal_id = NEW.grantee_execution_principal_id
          AND principal.principal_generation =
            NEW.grantee_execution_principal_generation
          AND principal.principal_kind = NEW.grantee_kind
          AND principal.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory access grant principal is unavailable'
          USING ERRCODE = '23503';
      END IF;
      IF NEW.owner_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.omni_tenant_execution_principals principal
        WHERE principal.tenant_id = NEW.tenant_id
          AND principal.principal_id = NEW.owner_agent_id
          AND principal.principal_generation = NEW.owner_agent_principal_generation
          AND principal.principal_kind = 'agent'
          AND principal.controller_actor_id = NEW.owner_actor_id
          AND principal.state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory access grant owner agent is unavailable'
          USING ERRCODE = '23503';
      END IF;
      insertion_time := statement_timestamp();
      IF NEW.expires_at <= insertion_time OR NEW.not_before >= NEW.expires_at THEN
        RAISE EXCEPTION 'Memory access grant validity window is invalid'
          USING ERRCODE = '23514';
      END IF;
      NEW.not_before := GREATEST(NEW.not_before, insertion_time);
      SELECT COALESCE(MAX(grant_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_access_grants
      WHERE tenant_id = NEW.tenant_id
        AND grant_kind = NEW.grant_kind
        AND grant_id = NEW.grant_id;
      IF NEW.grant_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory access grant generation is not next'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.omni_tenant_memory_access_grants
        WHERE tenant_id = NEW.tenant_id
          AND grant_kind = NEW.grant_kind
          AND grant_id = NEW.grant_id
          AND state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory access grant already has a current generation'
          USING ERRCODE = '23514';
      END IF;
      NEW.created_at := insertion_time;
      NEW.updated_at := insertion_time;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_access_grant_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory access grant lifecycle is held'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE TRIGGER omni_memory_access_grant_validate_insert
    BEFORE INSERT ON omni_tenant_memory_access_grants
    FOR EACH ROW EXECUTE FUNCTION omni_validate_memory_access_grant_insert()
  `;
  await sql`
    CREATE TRIGGER omni_memory_access_grant_mutation_hold
    BEFORE UPDATE OR DELETE ON omni_tenant_memory_access_grants
    FOR EACH ROW EXECUTE FUNCTION omni_reject_memory_access_grant_mutation()
  `;
  await sql`
    CREATE TRIGGER omni_memory_access_grant_no_truncate
    BEFORE TRUNCATE ON omni_tenant_memory_access_grants
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_memory_access_grant_mutation()
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_tenant_memory_access_grants FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_memory_access_grant_binding_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT,
      TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], TEXT[],
      BIGINT, BIGINT, BIGINT, BIGINT, BIGINT
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_memory_access_grant_lifecycle_is_valid(
      TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ,
      TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_validate_memory_access_grant_insert()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_memory_access_grant_mutation()
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
          AND table_name = 'omni_tenant_memory_access_grants'
          AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_memory_access_grants FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_binding_is_valid',
            'omni_memory_access_grant_lifecycle_is_valid',
            'omni_validate_memory_access_grant_insert',
            'omni_reject_memory_access_grant_mutation'
          ) AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_memory_access_grant_binding_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, ' ||
          'TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], TEXT[], ' ||
          'BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_memory_access_grant_lifecycle_is_valid(' ||
          'TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
          current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_validate_memory_access_grant_insert() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_reject_memory_access_grant_mutation() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_memory_access_grants ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_memory_access_grants FORCE ROW LEVEL SECURITY
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation ON omni_tenant_memory_access_grants
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_memory_access_grant_holdback
    ON omni_tenant_memory_access_grants
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM omni_tenant_memory_access_grants) THEN
        RAISE EXCEPTION 'Memory access grant shadow must start empty'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_tenant_memory_access_grants'::regclass
          AND relkind = 'r' AND relpersistence = 'p'
          AND relrowsecurity AND relforcerowsecurity
          AND relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_tenant_memory_access_grants'::regclass
      ) <> 2 THEN
        RAISE EXCEPTION 'Memory access grant isolation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
          AND conname = 'omni_memory_access_grant_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
          AND conname IN (
            'omni_memory_access_grant_binding_check',
            'omni_memory_access_grant_lifecycle_check'
          ) AND contype = 'c' AND convalidated
        GROUP BY conrelid HAVING count(*) = 2
      ) THEN
        RAISE EXCEPTION 'Memory access grant row holds are invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_access_grants'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_access_grants'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_access_grant_binding_is_valid',
            'omni_memory_access_grant_lifecycle_is_valid',
            'omni_validate_memory_access_grant_insert',
            'omni_reject_memory_access_grant_mutation'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory access grant shadow grants non-owner access'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_memory_access_grants'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'omni_memory_access_grant_validate_insert',
            'omni_memory_access_grant_mutation_hold',
            'omni_memory_access_grant_no_truncate'
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Memory access grant hold triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantMemoryOperationPoliciesShadow(sql: SqlClient) {
  // v63 supplies a versioned, tenant-bound operation policy input. It seeds
  // no policy and cannot waive grants, request binding, or approval.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory operation policy migration requires schema owner'
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
      omni_memory_purpose_catalog,
      omni_tenant_memory_access_grants,
      omni_memories
    IN SHARE MODE
  `;
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*) FROM omni_schema_version
        WHERE version = 62
          AND name = 'tenant_memory_access_grants_shadow'
          AND checksum =
            '78dfb9eacf44e6365cb36f4c03d5bd5549fa6796a0ee58f85afd45701b7cd771'
      ) <> 1 OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_access_grants'::regclass
          AND conname = 'omni_memory_access_grant_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_access_enrollment_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory operation policy predecessors changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_operation_policy_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_policy_id TEXT,
      candidate_policy_generation BIGINT,
      candidate_purpose_id TEXT,
      candidate_operation_class TEXT,
      candidate_risk_class TEXT,
      candidate_principal_kinds TEXT[],
      candidate_visibilities TEXT[],
      candidate_sensitivities TEXT[],
      candidate_requires_context_grant BOOLEAN,
      candidate_requires_capability_grant BOOLEAN,
      candidate_requires_request_binding BOOLEAN,
      candidate_requires_human_approval BOOLEAN,
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
        AND candidate_policy_id ~
          '^memory-policy:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
        AND candidate_policy_generation BETWEEN 1 AND 9007199254740991
        AND candidate_operation_class IN (
          'read', 'retrieve', 'write', 'correct', 'forget', 'formation',
          'maintenance', 'export'
        )
        AND candidate_purpose_id =
          'memory.' || candidate_operation_class || '.v1'
        AND candidate_risk_class = CASE
          WHEN candidate_operation_class IN ('read', 'retrieve') THEN 'low'
          WHEN candidate_operation_class IN ('write', 'formation') THEN 'medium'
          WHEN candidate_operation_class IN ('forget', 'export') THEN 'critical'
          ELSE 'high'
        END
        AND public.omni_source_id_array_is_canonical(
          candidate_principal_kinds, 3
        )
        AND candidate_principal_kinds <@ ARRAY['agent', 'system', 'user']::TEXT[]
        AND public.omni_source_id_array_is_canonical(
          candidate_visibilities, 5
        )
        AND candidate_visibilities <@ ARRAY[
          'agent_private', 'mission_shared', 'project_shared',
          'user_private', 'workspace_shared'
        ]::TEXT[]
        AND public.omni_source_id_array_is_canonical(
          candidate_sensitivities, 4
        )
        AND candidate_sensitivities <@ ARRAY[
          'confidential', 'internal', 'public', 'restricted'
        ]::TEXT[]
        AND candidate_requires_capability_grant
        AND candidate_requires_context_grant =
          (candidate_operation_class IN ('read', 'retrieve', 'formation'))
        AND candidate_requires_request_binding =
          (candidate_operation_class IN ('forget', 'export'))
        AND candidate_requires_human_approval =
          (candidate_operation_class IN ('forget', 'export'))
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
            candidate_state = 'held' AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'active' AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'revoked' AND candidate_revoked_at IS NOT NULL
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
    CREATE TABLE IF NOT EXISTS omni_tenant_memory_operation_policies (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      policy_generation BIGINT NOT NULL,
      purpose_id TEXT NOT NULL,
      operation_class TEXT NOT NULL,
      risk_class TEXT NOT NULL,
      allowed_principal_kinds TEXT[] NOT NULL,
      allowed_visibilities TEXT[] NOT NULL,
      allowed_sensitivities TEXT[] NOT NULL,
      requires_context_grant BOOLEAN NOT NULL,
      requires_capability_grant BOOLEAN NOT NULL DEFAULT TRUE,
      requires_request_binding BOOLEAN NOT NULL,
      requires_human_approval BOOLEAN NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_operation_policies_pkey PRIMARY KEY (
        tenant_id, policy_id, policy_generation
      ),
      CONSTRAINT omni_memory_operation_policy_row_check CHECK (
        omni_memory_operation_policy_row_is_valid(
          schema_version, tenant_id, policy_id, policy_generation, purpose_id,
          operation_class, risk_class, allowed_principal_kinds,
          allowed_visibilities, allowed_sensitivities,
          requires_context_grant, requires_capability_grant,
          requires_request_binding, requires_human_approval, state,
          lifecycle_revision, created_by_actor_id, activated_by_actor_id,
          revoked_by_actor_id, created_at, activated_at, revoked_at, updated_at
        )
      ),
      CONSTRAINT omni_memory_operation_policy_activation_hold_check
        CHECK (state <> 'active'),
      CONSTRAINT omni_memory_operation_policy_tenant_fkey FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_operation_policy_purpose_fkey FOREIGN KEY (purpose_id)
        REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_operation_policy_created_actor_fkey
        FOREIGN KEY (created_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_operation_policy_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_operation_policy_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_operation_policies_current_idx
    ON omni_tenant_memory_operation_policies (tenant_id, policy_id)
    WHERE state <> 'revoked'
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_operation_policies_purpose_idx
    ON omni_tenant_memory_operation_policies (tenant_id, purpose_id)
    WHERE state <> 'revoked'
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_operation_policy_insert()
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
        hashtext(NEW.tenant_id), hashtext(NEW.policy_id)
      );
      IF NEW.state <> 'held' OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory operation policies must start held'
          USING ERRCODE = '23514';
      END IF;
      IF NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.created_by_actor_id
      ) THEN
        RAISE EXCEPTION 'Memory operation policy actor lacks tenant membership'
          USING ERRCODE = '23503';
      END IF;
      SELECT COALESCE(MAX(policy_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_operation_policies
      WHERE tenant_id = NEW.tenant_id AND policy_id = NEW.policy_id;
      IF NEW.policy_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory operation policy generation is not next'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.omni_tenant_memory_operation_policies
        WHERE tenant_id = NEW.tenant_id
          AND (policy_id = NEW.policy_id OR purpose_id = NEW.purpose_id)
          AND state <> 'revoked'
      ) THEN
        RAISE EXCEPTION 'Memory operation policy already has current authority'
          USING ERRCODE = '23514';
      END IF;
      NEW.created_at := statement_timestamp();
      NEW.updated_at := NEW.created_at;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_operation_policy_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory operation policy lifecycle is held'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE TRIGGER omni_memory_operation_policy_validate_insert
    BEFORE INSERT ON omni_tenant_memory_operation_policies
    FOR EACH ROW EXECUTE FUNCTION omni_validate_memory_operation_policy_insert()
  `;
  await sql`
    CREATE TRIGGER omni_memory_operation_policy_mutation_hold
    BEFORE UPDATE OR DELETE ON omni_tenant_memory_operation_policies
    FOR EACH ROW EXECUTE FUNCTION omni_reject_memory_operation_policy_mutation()
  `;
  await sql`
    CREATE TRIGGER omni_memory_operation_policy_no_truncate
    BEFORE TRUNCATE ON omni_tenant_memory_operation_policies
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_memory_operation_policy_mutation()
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_tenant_memory_operation_policies FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_memory_operation_policy_row_is_valid(
      SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT[],
      BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BIGINT, TEXT, TEXT, TEXT,
      TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_validate_memory_operation_policy_insert()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_memory_operation_policy_mutation()
      FROM PUBLIC
  `);
  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_operation_policies'
          AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_memory_operation_policies FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
      FOR grant_record IN
        SELECT DISTINCT grantee FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_operation_policy_row_is_valid',
            'omni_validate_memory_operation_policy_insert',
            'omni_reject_memory_operation_policy_mutation'
          ) AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_memory_operation_policy_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], TEXT[], ' ||
          'TEXT[], BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BIGINT, TEXT, ' ||
          'TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_validate_memory_operation_policy_insert() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_reject_memory_operation_policy_mutation() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_memory_operation_policies ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_memory_operation_policies FORCE ROW LEVEL SECURITY
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation
    ON omni_tenant_memory_operation_policies
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_memory_operation_policy_holdback
    ON omni_tenant_memory_operation_policies
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM omni_tenant_memory_operation_policies) THEN
        RAISE EXCEPTION 'Memory operation policy shadow must start empty'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_tenant_memory_operation_policies'::regclass
          AND relkind = 'r' AND relpersistence = 'p'
          AND relrowsecurity AND relforcerowsecurity
          AND relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_tenant_memory_operation_policies'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_operation_policies'::regclass
          AND conname = 'omni_memory_operation_policy_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory operation policy boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_operation_policies'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_operation_policies'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_operation_policy_row_is_valid',
            'omni_validate_memory_operation_policy_insert',
            'omni_reject_memory_operation_policy_mutation'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory operation policy grants non-owner access'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_memory_operation_policies'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'omni_memory_operation_policy_validate_insert',
            'omni_memory_operation_policy_mutation_hold',
            'omni_memory_operation_policy_no_truncate'
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Memory operation policy hold triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureTenantMemoryDataRightRequestsShadow(sql: SqlClient) {
  // v64 supplies a one-time human request authority for export and forget.
  // It starts empty and held; standing consent, tenant roles, and generic tool
  // approval cannot be translated into this authority.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory data-right request migration requires schema owner'
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
      omni_memory_purpose_catalog,
      omni_tenant_memory_operation_policies,
      omni_tenant_memory_access_grants,
      omni_memories
    IN SHARE MODE
  `;
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*) FROM omni_schema_version
        WHERE version = 63
          AND name = 'tenant_memory_operation_policies_shadow'
          AND checksum =
            '6af56428280d777c2fffa9360543cb879542531a7463ce83e836dd6e88e4e207'
      ) <> 1 OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_operation_policies'::regclass
          AND conname = 'omni_memory_operation_policy_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(state <> ''active''::text)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_memories'::regclass
          AND conname = 'omni_memories_access_enrollment_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = '(access_contract_version = 0)'
      ) THEN
        RAISE EXCEPTION 'Memory data-right request predecessors changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_data_right_request_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_request_id TEXT,
      candidate_request_generation BIGINT,
      candidate_purpose_id TEXT,
      candidate_subject_actor_id TEXT,
      candidate_executing_principal_type TEXT,
      candidate_executing_principal_id TEXT,
      candidate_confirmation_kind TEXT,
      candidate_request_binding_sha256 TEXT,
      candidate_resource_ids TEXT[],
      candidate_not_before TIMESTAMPTZ,
      candidate_expires_at TIMESTAMPTZ,
      candidate_state TEXT,
      candidate_lifecycle_revision BIGINT,
      candidate_created_by_actor_id TEXT,
      candidate_activated_by_actor_id TEXT,
      candidate_consumed_by_actor_id TEXT,
      candidate_revoked_by_actor_id TEXT,
      candidate_created_at TIMESTAMPTZ,
      candidate_activated_at TIMESTAMPTZ,
      candidate_consumed_at TIMESTAMPTZ,
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
        AND candidate_request_id ~
          '^memory-data-right-request:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
        AND candidate_request_generation BETWEEN 1 AND 9007199254740991
        AND candidate_purpose_id IN ('memory.export.v1', 'memory.forget.v1')
        AND candidate_subject_actor_id ~
          '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND candidate_executing_principal_type = 'user'
        AND candidate_executing_principal_id = candidate_subject_actor_id
        AND candidate_created_by_actor_id = candidate_subject_actor_id
        AND candidate_confirmation_kind = CASE candidate_purpose_id
          WHEN 'memory.forget.v1' THEN 'reviewed_deletion_preview'
          ELSE 'explicit_export_request'
        END
        AND candidate_request_binding_sha256 ~ '^[0-9a-f]{64}$'
        AND public.omni_source_id_array_is_canonical(
          candidate_resource_ids, 256
        )
        AND COALESCE(array_length(candidate_resource_ids, 1), 0) >= 1
        AND candidate_state IN ('held', 'active', 'consumed', 'revoked')
        AND candidate_lifecycle_revision BETWEEN 0 AND 9007199254740991
        AND (
          candidate_activated_by_actor_id IS NULL
          OR candidate_activated_by_actor_id = candidate_subject_actor_id
        )
        AND (
          candidate_consumed_by_actor_id IS NULL
          OR candidate_consumed_by_actor_id = candidate_subject_actor_id
        )
        AND (
          candidate_revoked_by_actor_id IS NULL
          OR candidate_revoked_by_actor_id = candidate_subject_actor_id
        )
        AND (candidate_activated_by_actor_id IS NULL) =
          (candidate_activated_at IS NULL)
        AND (candidate_consumed_by_actor_id IS NULL) =
          (candidate_consumed_at IS NULL)
        AND (candidate_revoked_by_actor_id IS NULL) =
          (candidate_revoked_at IS NULL)
        AND (
          (
            candidate_state = 'held' AND candidate_lifecycle_revision = 0
            AND candidate_activated_at IS NULL
            AND candidate_consumed_at IS NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'active' AND candidate_lifecycle_revision = 1
            AND candidate_activated_at IS NOT NULL
            AND candidate_consumed_at IS NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'consumed' AND candidate_lifecycle_revision = 2
            AND candidate_activated_at IS NOT NULL
            AND candidate_consumed_at IS NOT NULL
            AND candidate_revoked_at IS NULL
          ) OR (
            candidate_state = 'revoked'
            AND candidate_consumed_at IS NULL
            AND candidate_revoked_at IS NOT NULL
            AND (
              (candidate_activated_at IS NULL AND candidate_lifecycle_revision = 1)
              OR
              (candidate_activated_at IS NOT NULL AND candidate_lifecycle_revision = 2)
            )
          )
        )
        AND candidate_created_at <= candidate_not_before
        AND candidate_not_before < candidate_expires_at
        AND candidate_expires_at <=
          candidate_not_before + INTERVAL '1 hour'
        AND candidate_created_at <= candidate_updated_at
        AND (
          candidate_activated_at IS NULL
          OR candidate_activated_at BETWEEN candidate_not_before
            AND candidate_expires_at
          AND candidate_activated_at < candidate_expires_at
          AND candidate_activated_at <= candidate_updated_at
        )
        AND (
          candidate_consumed_at IS NULL
          OR candidate_consumed_at BETWEEN candidate_activated_at
            AND candidate_updated_at
        )
        AND (
          candidate_revoked_at IS NULL
          OR candidate_revoked_at BETWEEN candidate_created_at
            AND candidate_updated_at
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
    CREATE TABLE IF NOT EXISTS omni_tenant_memory_data_right_requests (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_generation BIGINT NOT NULL,
      purpose_id TEXT NOT NULL,
      subject_actor_id TEXT NOT NULL,
      executing_principal_type TEXT NOT NULL DEFAULT 'user',
      executing_principal_id TEXT NOT NULL,
      confirmation_kind TEXT NOT NULL,
      request_binding_sha256 TEXT NOT NULL,
      resource_ids TEXT[] NOT NULL,
      not_before TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      lifecycle_revision BIGINT NOT NULL DEFAULT 0,
      created_by_actor_id TEXT NOT NULL,
      activated_by_actor_id TEXT,
      consumed_by_actor_id TEXT,
      revoked_by_actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_data_right_requests_pkey PRIMARY KEY (
        tenant_id, request_id, request_generation
      ),
      CONSTRAINT omni_memory_data_right_request_row_check CHECK (
        omni_memory_data_right_request_row_is_valid(
          schema_version, tenant_id, request_id, request_generation,
          purpose_id, subject_actor_id, executing_principal_type,
          executing_principal_id, confirmation_kind, request_binding_sha256,
          resource_ids, not_before, expires_at, state, lifecycle_revision,
          created_by_actor_id, activated_by_actor_id, consumed_by_actor_id,
          revoked_by_actor_id, created_at, activated_at, consumed_at,
          revoked_at, updated_at
        )
      ),
      CONSTRAINT omni_memory_data_right_request_activation_hold_check
        CHECK (state NOT IN ('active', 'consumed')),
      CONSTRAINT omni_memory_data_right_request_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_purpose_fkey
        FOREIGN KEY (purpose_id) REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_subject_fkey
        FOREIGN KEY (subject_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_created_actor_fkey
        FOREIGN KEY (created_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_activated_actor_fkey
        FOREIGN KEY (activated_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_consumed_actor_fkey
        FOREIGN KEY (consumed_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_memory_data_right_request_revoked_actor_fkey
        FOREIGN KEY (revoked_by_actor_id) REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_memory_data_right_requests_current_idx
    ON omni_tenant_memory_data_right_requests (tenant_id, request_id)
    WHERE state NOT IN ('consumed', 'revoked')
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_memory_data_right_requests_subject_idx
    ON omni_tenant_memory_data_right_requests (
      tenant_id, subject_actor_id, purpose_id, state, expires_at
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_memory_data_right_request_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      expected_generation BIGINT;
      insertion_time TIMESTAMPTZ;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id), hashtext(NEW.request_id)
      );
      IF NEW.state <> 'held' OR NEW.lifecycle_revision <> 0
        OR NEW.activated_by_actor_id IS NOT NULL
        OR NEW.consumed_by_actor_id IS NOT NULL
        OR NEW.revoked_by_actor_id IS NOT NULL
        OR NEW.activated_at IS NOT NULL
        OR NEW.consumed_at IS NOT NULL
        OR NEW.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory data-right requests must start held'
          USING ERRCODE = '23514';
      END IF;
      IF NOT public.omni_actor_has_active_tenant_membership(
        NEW.tenant_id, NEW.subject_actor_id
      ) THEN
        RAISE EXCEPTION 'Memory data-right request subject lacks tenant membership'
          USING ERRCODE = '23503';
      END IF;
      insertion_time := statement_timestamp();
      IF NEW.expires_at <= insertion_time OR NEW.not_before >= NEW.expires_at THEN
        RAISE EXCEPTION 'Memory data-right request validity window is invalid'
          USING ERRCODE = '23514';
      END IF;
      NEW.not_before := GREATEST(NEW.not_before, insertion_time);
      SELECT COALESCE(MAX(request_generation), 0) + 1
      INTO expected_generation
      FROM public.omni_tenant_memory_data_right_requests
      WHERE tenant_id = NEW.tenant_id AND request_id = NEW.request_id;
      IF NEW.request_generation IS DISTINCT FROM expected_generation THEN
        RAISE EXCEPTION 'Memory data-right request generation is not next'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.omni_tenant_memory_data_right_requests
        WHERE tenant_id = NEW.tenant_id AND request_id = NEW.request_id
          AND state NOT IN ('consumed', 'revoked')
      ) THEN
        RAISE EXCEPTION 'Memory data-right request already has current authority'
          USING ERRCODE = '23514';
      END IF;
      NEW.created_at := insertion_time;
      NEW.updated_at := insertion_time;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_data_right_request_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory data-right request lifecycle is held'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE TRIGGER omni_memory_data_right_request_validate_insert
    BEFORE INSERT ON omni_tenant_memory_data_right_requests
    FOR EACH ROW EXECUTE FUNCTION omni_validate_memory_data_right_request_insert()
  `;
  await sql`
    CREATE TRIGGER omni_memory_data_right_request_mutation_hold
    BEFORE UPDATE OR DELETE ON omni_tenant_memory_data_right_requests
    FOR EACH ROW EXECUTE FUNCTION omni_reject_memory_data_right_request_mutation()
  `;
  await sql`
    CREATE TRIGGER omni_memory_data_right_request_no_truncate
    BEFORE TRUNCATE ON omni_tenant_memory_data_right_requests
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_memory_data_right_request_mutation()
  `;

  await sql.query(`
    REVOKE ALL ON TABLE omni_tenant_memory_data_right_requests FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_memory_data_right_request_row_is_valid(
      SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
      TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT,
      TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_validate_memory_data_right_request_insert()
      FROM PUBLIC;
    REVOKE ALL ON FUNCTION omni_reject_memory_data_right_request_mutation()
      FROM PUBLIC
  `);
  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
    BEGIN
      FOR grant_record IN
        SELECT DISTINCT grantee FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_data_right_requests'
          AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON TABLE %I.omni_tenant_memory_data_right_requests FROM %I',
          current_schema(), grant_record.grantee
        );
      END LOOP;
      FOR grant_record IN
        SELECT DISTINCT grantee FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_data_right_request_row_is_valid',
            'omni_validate_memory_data_right_request_insert',
            'omni_reject_memory_data_right_request_mutation'
          ) AND grantee <> current_user AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_memory_data_right_request_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, ' ||
          'TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, ' ||
          'TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ) FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_validate_memory_data_right_request_insert() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %I.omni_reject_memory_data_right_request_mutation() ' ||
          'FROM %I', current_schema(), grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    ALTER TABLE omni_tenant_memory_data_right_requests ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_memory_data_right_requests FORCE ROW LEVEL SECURITY
  `;
  await sql`
    CREATE POLICY omni_tenant_isolation
    ON omni_tenant_memory_data_right_requests
    FOR ALL TO PUBLIC
    USING (omni_tenant_visible(tenant_id))
    WITH CHECK (omni_tenant_visible(tenant_id))
  `;
  await sql`
    CREATE POLICY omni_memory_data_right_request_holdback
    ON omni_tenant_memory_data_right_requests
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (omni_system_scope_enabled())
    WITH CHECK (omni_system_scope_enabled())
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM omni_tenant_memory_data_right_requests) THEN
        RAISE EXCEPTION 'Memory data-right request shadow must start empty'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_tenant_memory_data_right_requests'::regclass
          AND relkind = 'r' AND relpersistence = 'p'
          AND relrowsecurity AND relforcerowsecurity
          AND relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_tenant_memory_data_right_requests'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'omni_tenant_memory_data_right_requests'::regclass
          AND conname = 'omni_memory_data_right_request_activation_hold_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            '(state <> ALL (ARRAY[''active''::text, ''consumed''::text]))'
      ) THEN
        RAISE EXCEPTION 'Memory data-right request boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_data_right_requests'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_memory_data_right_requests'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_data_right_request_row_is_valid',
            'omni_validate_memory_data_right_request_insert',
            'omni_reject_memory_data_right_request_mutation'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Memory data-right request grants non-owner access'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_memory_data_right_requests'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'omni_memory_data_right_request_validate_insert',
            'omni_memory_data_right_request_mutation_hold',
            'omni_memory_data_right_request_no_truncate'
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Memory data-right request hold triggers are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
