import "server-only";

import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for memory informed notices, their receipts and
// governance evidence.

export async function ensureMemoryInformedNoticeReceiptsAndConsentV2Shadow(
  sql: SqlClient,
) {
  // v55 installs only dormant evidence contracts. It does not invent notice
  // text, derive a receipt, upgrade a historical consent, or grant a serving
  // role access to any of the new authority surfaces.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory informed notice migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;

  // Keep every referenced authority stable while the empty v49 table is
  // upgraded. In particular, no membership epoch or consent is inferred from
  // live auth data.
  await sql`
    LOCK TABLE
      omni_auth_tenants,
      omni_auth_users,
      omni_auth_memberships,
      omni_memory_purpose_catalog,
      omni_tenant_memory_purpose_entitlements,
      omni_tenant_actor_membership_epochs
    IN SHARE MODE
  `;
  await sql`
    LOCK TABLE omni_tenant_actor_memory_purpose_consents
    IN ACCESS EXCLUSIVE MODE
  `;

  // Re-prove the complete v54 foundation before using it as an FK target or
  // trusting an empty-table observation. Normal row security remains enabled;
  // an explicit system-scope gate below proves that FORCE-RLS scans are whole.
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
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Notice receipt v54 relation preflight is invalid'
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
              'tenant_id', 'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'subject_actor_id', 'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('membership_epoch', 'bigint'::REGTYPE, 0::OID),
            (
              'state', 'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('lifecycle_revision', 'bigint'::REGTYPE, 0::OID),
            (
              'created_by_actor_id', 'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'activated_by_actor_id', 'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'revoked_by_actor_id', 'text'::REGTYPE,
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
        RAISE EXCEPTION 'Notice receipt v54 columns preflight is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*) FROM pg_attrdef
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
        RAISE EXCEPTION 'Notice receipt v54 defaults preflight is invalid'
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
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'subject_actor_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_membership_epochs'::regclass
                AND attname = 'membership_epoch' AND NOT attisdropped
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
        WHERE constraint_record.conname = 'omni_actor_membership_epochs_row_check'
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
        RAISE EXCEPTION 'Notice receipt v54 constraints preflight is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_membership_epochs_tenant_fkey',
              'tenant_id', 'omni_auth_tenants'::REGCLASS, 'id'
            ),
            (
              'omni_actor_membership_epochs_subject_actor_fkey',
              'subject_actor_id', 'omni_auth_users'::REGCLASS, 'actor_id'
            ),
            (
              'omni_actor_membership_epochs_created_actor_fkey',
              'created_by_actor_id', 'omni_auth_users'::REGCLASS, 'actor_id'
            ),
            (
              'omni_actor_membership_epochs_activated_actor_fkey',
              'activated_by_actor_id', 'omni_auth_users'::REGCLASS, 'actor_id'
            ),
            (
              'omni_actor_membership_epochs_revoked_actor_fkey',
              'revoked_by_actor_id', 'omni_auth_users'::REGCLASS, 'actor_id'
            )
        ) expected(
          constraint_name, local_column, foreign_relation, foreign_column
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
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_epochs'::regclass
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
        RAISE EXCEPTION 'Notice receipt v54 references preflight is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*) FROM pg_index
        WHERE indrelid = 'omni_tenant_actor_membership_epochs'::regclass
      ) <> 2 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_tenant_actor_membership_epochs_pkey'::REGCLASS,
              TRUE,
              ARRAY[
                'tenant_id', 'subject_actor_id', 'membership_epoch'
              ]::TEXT[],
              ARRAY[
                'pg_catalog.text_ops', 'pg_catalog.text_ops',
                'pg_catalog.int8_ops'
              ]::TEXT[],
              ARRAY[
                'pg_catalog.default'::REGCOLLATION::OID,
                'pg_catalog.default'::REGCOLLATION::OID,
                0::OID
              ]::OID[],
              NULL::TEXT
            ),
            (
              'omni_actor_membership_epochs_current_idx'::REGCLASS,
              FALSE,
              ARRAY['tenant_id', 'subject_actor_id']::TEXT[],
              ARRAY[
                'pg_catalog.text_ops', 'pg_catalog.text_ops'
              ]::TEXT[],
              ARRAY[
                'pg_catalog.default'::REGCOLLATION::OID,
                'pg_catalog.default'::REGCOLLATION::OID
              ]::OID[],
              '(state <> ''revoked''::text)'::TEXT
            )
        ) expected(
          index_oid,
          is_primary,
          key_columns,
          operator_classes,
          collations,
          predicate_expression
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_index index_record
          JOIN pg_class index_relation
            ON index_relation.oid = index_record.indexrelid
          JOIN pg_am access_method
            ON access_method.oid = index_relation.relam
          WHERE index_record.indexrelid = expected.index_oid
            AND index_record.indrelid =
              'omni_tenant_actor_membership_epochs'::regclass
            AND index_record.indisprimary = expected.is_primary
            AND index_record.indisunique
            AND index_record.indisvalid
            AND index_record.indisready
            AND index_record.indislive
            AND index_record.indimmediate
            AND NOT index_record.indisclustered
            AND NOT index_record.indisreplident
            AND NOT index_record.indisexclusion
            AND index_record.indnatts = cardinality(expected.key_columns)
            AND index_record.indnkeyatts = cardinality(expected.key_columns)
            AND index_record.indexprs IS NULL
            AND pg_get_expr(index_record.indpred, index_record.indrelid)
              IS NOT DISTINCT FROM expected.predicate_expression
            AND index_relation.relkind = 'i'
            AND access_method.amname = 'btree'
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
            ) = expected.key_columns
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
            ) = expected.operator_classes
            AND (
              SELECT array_agg(collation_oid ORDER BY ordinality)
              FROM unnest(index_record.indcollation)
                WITH ORDINALITY AS key(collation_oid, ordinality)
            ) = expected.collations
            AND (
              SELECT bool_and(index_option = 0)
              FROM unnest(index_record.indoption) AS option(index_option)
            )
        )
      ) THEN
        RAISE EXCEPTION 'Notice receipt v54 indexes preflight is invalid'
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
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND NOT tgisinternal
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_membership_epoch_validate_insert',
              to_regprocedure(
                'public.omni_validate_actor_membership_epoch_insert()'
              ),
              7
            ),
            (
              'omni_actor_membership_epoch_protect',
              to_regprocedure(
                'public.omni_protect_actor_membership_epoch()'
              ),
              27
            ),
            (
              'omni_actor_membership_epoch_no_truncate',
              to_regprocedure(
                'public.omni_protect_actor_membership_epoch()'
              ),
              34
            )
        ) expected(trigger_name, procedure_oid, trigger_type)
        WHERE expected.procedure_oid IS NULL OR NOT EXISTS (
          SELECT 1
          FROM pg_trigger trigger_record
          WHERE trigger_record.tgrelid =
              'omni_tenant_actor_membership_epochs'::regclass
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
        RAISE EXCEPTION 'Notice receipt v54 triggers preflight is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1 FROM pg_policy
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
        SELECT 1 FROM pg_policy
        WHERE polrelid = 'omni_tenant_actor_membership_epochs'::regclass
          AND polname = 'omni_actor_membership_epoch_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_membership_epochs'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_membership_epoch_row_is_valid',
            'omni_validate_actor_membership_epoch_insert',
            'omni_protect_actor_membership_epoch'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Notice receipt v54 policy or ACL preflight is invalid'
          USING ERRCODE = '55000';
      END IF;

    END
    $migration$
  `;

  // FORCE-RLS observations below are complete only while the ordered migration
  // system scope is active. Also pin the v49 relation and its policy boundary
  // before classifying or mutating either supported consent shape.
  await sql`
    DO $migration$
    BEGIN
      IF public.omni_system_scope_enabled() IS DISTINCT FROM TRUE
        OR public.omni_tenant_visible(
          'tenant:v55_system_scope_preflight'
        ) IS DISTINCT FROM TRUE
      THEN
        RAISE EXCEPTION 'Memory informed notice system scope is unavailable'
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
      ) THEN
        RAISE EXCEPTION 'Notice receipt v49 relation preflight is invalid'
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
        RAISE EXCEPTION 'Notice receipt v49 policy preflight is invalid'
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

  await sql`
    DO $migration$
    DECLARE
      consent_is_exact_v1 BOOLEAN;
      consent_is_exact_v2 BOOLEAN;
    BEGIN
      SELECT
        EXISTS (
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
        )
        AND EXISTS (
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
        )
        AND EXISTS (
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid =
              'omni_tenant_actor_memory_purpose_consents'::regclass
            AND conname IN (
              'omni_actor_memory_purpose_consents_epoch_fkey',
              'omni_actor_memory_purpose_consents_receipt_fkey'
            )
        )
        AND to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NOT NULL
        AND to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,bigint,text,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NULL
      INTO consent_is_exact_v1;

      SELECT
        EXISTS (
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
              'revoked_at', 'updated_at', 'membership_epoch',
              'notice_receipt_id'
            ]::TEXT[]
            AND columns.not_null_names = ARRAY[
              'schema_version', 'tenant_id', 'subject_actor_id', 'purpose_id',
              'consent_generation', 'state', 'lifecycle_revision',
              'created_by_actor_id', 'created_at', 'updated_at',
              'membership_epoch', 'notice_receipt_id'
            ]::TEXT[]
            AND columns.none_generated
            AND columns.column_count = 16
        )
        AND EXISTS (
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
            ) IN ('2', '2::smallint', '(2)::smallint')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          JOIN pg_attrdef attribute_default
            ON attribute_default.adrelid = attribute.attrelid
            AND attribute_default.adnum = attribute.attnum
          WHERE attribute.attrelid =
              'omni_tenant_actor_memory_purpose_consents'::regclass
            AND attribute.attname IN (
              'membership_epoch', 'notice_receipt_id'
            )
        )
        AND EXISTS (
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
              'omni_actor_memory_purpose_consent_row_is_valid(schema_version, tenant_id, subject_actor_id, purpose_id, consent_generation, membership_epoch, notice_receipt_id, state, lifecycle_revision, created_by_actor_id, granted_by_actor_id, revoked_by_actor_id, created_at, granted_at, revoked_at, updated_at)'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_actor_memory_purpose_consents_epoch_fkey'
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
            AND constraint_record.confrelid =
              'omni_tenant_actor_membership_epochs'::regclass
            AND constraint_record.confupdtype = 'r'
            AND constraint_record.confdeltype = 'r'
            AND constraint_record.confmatchtype = 's'
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
                  AND attname = 'membership_epoch' AND NOT attisdropped
              )
            ]::SMALLINT[]
            AND constraint_record.confkey = ARRAY[
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_epochs'::regclass
                  AND attname = 'tenant_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_epochs'::regclass
                  AND attname = 'subject_actor_id' AND NOT attisdropped
              ),
              (
                SELECT attnum FROM pg_attribute
                WHERE attrelid =
                    'omni_tenant_actor_membership_epochs'::regclass
                  AND attname = 'membership_epoch' AND NOT attisdropped
              )
            ]::SMALLINT[]
        )
        AND EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname =
              'omni_actor_memory_purpose_consents_receipt_fkey'
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
            AND constraint_record.confrelid =
              to_regclass('public.omni_tenant_actor_memory_notice_receipts')
            AND constraint_record.confupdtype = 'r'
            AND constraint_record.confdeltype = 'r'
            AND constraint_record.confmatchtype = 's'
            AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.conkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'subject_actor_id', 'purpose_id',
              'consent_generation', 'membership_epoch', 'notice_receipt_id'
            ]::TEXT[]
            AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.confkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.confrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = ARRAY[
              'tenant_id', 'subject_actor_id', 'purpose_id',
              'consent_generation', 'membership_epoch', 'notice_receipt_id'
            ]::TEXT[]
        )
        AND to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NULL
        AND to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,bigint,text,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
        ) IS NOT NULL
      INTO consent_is_exact_v2;

      IF consent_is_exact_v1 = consent_is_exact_v2
        OR NOT (consent_is_exact_v1 OR consent_is_exact_v2)
      THEN
        RAISE EXCEPTION 'Consent shadow is neither exact v1 nor exact v2'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;


  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'Consent v2 upgrade requires an empty consent shadow'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM omni_tenant_actor_membership_epochs
      ) THEN
        RAISE EXCEPTION 'Notice receipt installation requires an empty epoch shadow'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_memory_informed_notice_contract_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_purpose_id TEXT,
      candidate_notice_contract_id TEXT,
      candidate_notice_contract_version SMALLINT,
      candidate_locale_id TEXT,
      candidate_notice_text TEXT,
      candidate_notice_sha256 TEXT,
      candidate_created_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_contract_id
        )
        AND candidate_notice_contract_version BETWEEN 1 AND 32767
        AND candidate_locale_id = btrim(candidate_locale_id)
        AND char_length(candidate_locale_id) BETWEEN 2 AND 35
        AND candidate_locale_id ~
          '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
        AND candidate_notice_text = btrim(candidate_notice_text)
        AND char_length(candidate_notice_text) BETWEEN 1 AND 20000
        AND candidate_notice_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_created_at IS NOT NULL
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_memory_informed_notice_contracts (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      purpose_id TEXT NOT NULL,
      notice_contract_id TEXT NOT NULL,
      notice_contract_version SMALLINT NOT NULL,
      locale_id TEXT NOT NULL,
      notice_text TEXT NOT NULL,
      notice_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_memory_informed_notice_contracts_pkey
        PRIMARY KEY (
          purpose_id,
          notice_contract_id,
          notice_contract_version
        ),
      CONSTRAINT omni_memory_informed_notice_contracts_row_check CHECK (
        omni_memory_informed_notice_contract_row_is_valid(
          schema_version,
          purpose_id,
          notice_contract_id,
          notice_contract_version,
          locale_id,
          notice_text,
          notice_sha256,
          created_at
        )
      ),
      CONSTRAINT omni_memory_informed_notice_contracts_seed_hold_check
        CHECK (FALSE),
      CONSTRAINT omni_memory_informed_notice_contracts_purpose_fkey
        FOREIGN KEY (purpose_id)
        REFERENCES omni_memory_purpose_catalog (purpose_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_memory_informed_notice_contract_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Memory informed notice contracts are append-only'
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
        WHERE tgrelid = 'omni_memory_informed_notice_contracts'::regclass
          AND tgname = 'omni_memory_informed_notice_contract_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_informed_notice_contract_immutable
        BEFORE UPDATE OR DELETE ON omni_memory_informed_notice_contracts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_memory_informed_notice_contract_change();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'omni_memory_informed_notice_contracts'::regclass
          AND tgname = 'omni_memory_informed_notice_contract_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_memory_informed_notice_contract_no_truncate
        BEFORE TRUNCATE ON omni_memory_informed_notice_contracts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_memory_informed_notice_contract_change();
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_memory_notice_receipt_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_subject_actor_id TEXT,
      candidate_purpose_id TEXT,
      candidate_consent_generation BIGINT,
      candidate_membership_epoch BIGINT,
      candidate_notice_receipt_id TEXT,
      candidate_notice_contract_id TEXT,
      candidate_notice_contract_version SMALLINT,
      candidate_presented_at TIMESTAMPTZ,
      candidate_acknowledged_by_actor_id TEXT,
      candidate_acknowledged_at TIMESTAMPTZ
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    IMMUTABLE
    STRICT
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_receipt_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_contract_id
        )
        AND candidate_notice_contract_version BETWEEN 1 AND 32767
        AND public.omni_source_contract_id_is_valid(
          candidate_acknowledged_by_actor_id
        )
        AND candidate_acknowledged_by_actor_id = candidate_subject_actor_id
        AND candidate_presented_at <= candidate_acknowledged_at
    $function$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS omni_tenant_actor_memory_notice_receipts (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      tenant_id TEXT NOT NULL,
      subject_actor_id TEXT NOT NULL,
      purpose_id TEXT NOT NULL,
      consent_generation BIGINT NOT NULL,
      membership_epoch BIGINT NOT NULL,
      notice_receipt_id TEXT NOT NULL,
      notice_contract_id TEXT NOT NULL,
      notice_contract_version SMALLINT NOT NULL,
      presented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_by_actor_id TEXT NOT NULL,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tenant_actor_memory_notice_receipts_pkey
        PRIMARY KEY (
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          membership_epoch,
          notice_receipt_id
        ),
      CONSTRAINT omni_actor_memory_notice_receipts_row_check CHECK (
        omni_actor_memory_notice_receipt_row_is_valid(
          schema_version,
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          membership_epoch,
          notice_receipt_id,
          notice_contract_id,
          notice_contract_version,
          presented_at,
          acknowledged_by_actor_id,
          acknowledged_at
        )
      ),
      CONSTRAINT omni_actor_memory_notice_receipts_issuance_hold_check
        CHECK (FALSE),
      CONSTRAINT omni_actor_memory_notice_receipts_tenant_fkey
        FOREIGN KEY (tenant_id)
        REFERENCES omni_auth_tenants (id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_notice_receipts_subject_actor_fkey
        FOREIGN KEY (subject_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_notice_receipts_ack_actor_fkey
        FOREIGN KEY (acknowledged_by_actor_id)
        REFERENCES omni_auth_users (actor_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_notice_receipts_epoch_fkey
        FOREIGN KEY (tenant_id, subject_actor_id, membership_epoch)
        REFERENCES omni_tenant_actor_membership_epochs (
          tenant_id,
          subject_actor_id,
          membership_epoch
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      CONSTRAINT omni_actor_memory_notice_receipts_contract_fkey
        FOREIGN KEY (
          purpose_id,
          notice_contract_id,
          notice_contract_version
        )
        REFERENCES omni_memory_informed_notice_contracts (
          purpose_id,
          notice_contract_id,
          notice_contract_version
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_actor_memory_notice_receipt_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.subject_actor_id || chr(31) || NEW.purpose_id)
      );

      IF NEW.acknowledged_by_actor_id IS DISTINCT FROM
        NEW.subject_actor_id
      THEN
        RAISE EXCEPTION 'Memory notice acknowledgment attribution is invalid'
          USING ERRCODE = '23514';
      END IF;

      NEW.presented_at := statement_timestamp();
      NEW.acknowledged_at := NEW.presented_at;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_actor_memory_notice_receipt_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Actor memory notice receipts are immutable'
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
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND tgname = 'omni_actor_memory_notice_receipt_validate_insert'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_notice_receipt_validate_insert
        BEFORE INSERT ON omni_tenant_actor_memory_notice_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_validate_actor_memory_notice_receipt_insert();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND tgname = 'omni_actor_memory_notice_receipt_immutable'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_notice_receipt_immutable
        BEFORE UPDATE OR DELETE ON omni_tenant_actor_memory_notice_receipts
        FOR EACH ROW
        EXECUTE FUNCTION omni_reject_actor_memory_notice_receipt_change();
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND tgname = 'omni_actor_memory_notice_receipt_no_truncate'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER omni_actor_memory_notice_receipt_no_truncate
        BEFORE TRUNCATE ON omni_tenant_actor_memory_notice_receipts
        FOR EACH STATEMENT
        EXECUTE FUNCTION omni_reject_actor_memory_notice_receipt_change();
      END IF;
    END
    $migration$
  `;

  // The v49 table is provably empty under ACCESS EXCLUSIVE lock. Add the two
  // evidence coordinates without defaults or inferred values, then replace
  // the obsolete validator overload with the v2 contract.
  await sql`
    ALTER TABLE omni_tenant_actor_memory_purpose_consents
      DROP CONSTRAINT IF EXISTS
        omni_actor_memory_purpose_consents_row_check,
      DROP CONSTRAINT IF EXISTS
        omni_actor_memory_purpose_consents_epoch_fkey,
      DROP CONSTRAINT IF EXISTS
        omni_actor_memory_purpose_consents_receipt_fkey
  `;
  await sql`
    DROP FUNCTION IF EXISTS omni_actor_memory_purpose_consent_row_is_valid(
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
  `;
  await sql`
    ALTER TABLE omni_tenant_actor_memory_purpose_consents
      ADD COLUMN IF NOT EXISTS membership_epoch BIGINT NOT NULL,
      ADD COLUMN IF NOT EXISTS notice_receipt_id TEXT NOT NULL
  `;
  await sql`
    ALTER TABLE omni_tenant_actor_memory_purpose_consents
      ALTER COLUMN schema_version SET DEFAULT 2
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_actor_memory_purpose_consent_row_is_valid(
      candidate_schema_version SMALLINT,
      candidate_tenant_id TEXT,
      candidate_subject_actor_id TEXT,
      candidate_purpose_id TEXT,
      candidate_consent_generation BIGINT,
      candidate_membership_epoch BIGINT,
      candidate_notice_receipt_id TEXT,
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
        candidate_schema_version = 2
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_receipt_id
        )
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
    ALTER TABLE omni_tenant_actor_memory_purpose_consents
      ADD CONSTRAINT omni_actor_memory_purpose_consents_row_check CHECK (
        omni_actor_memory_purpose_consent_row_is_valid(
          schema_version,
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          membership_epoch,
          notice_receipt_id,
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
      ADD CONSTRAINT omni_actor_memory_purpose_consents_epoch_fkey
        FOREIGN KEY (tenant_id, subject_actor_id, membership_epoch)
        REFERENCES omni_tenant_actor_membership_epochs (
          tenant_id,
          subject_actor_id,
          membership_epoch
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
      ADD CONSTRAINT omni_actor_memory_purpose_consents_receipt_fkey
        FOREIGN KEY (
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          membership_epoch,
          notice_receipt_id
        )
        REFERENCES omni_tenant_actor_memory_notice_receipts (
          tenant_id,
          subject_actor_id,
          purpose_id,
          consent_generation,
          membership_epoch,
          notice_receipt_id
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
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
        OR NEW.membership_epoch IS DISTINCT FROM OLD.membership_epoch
        OR NEW.notice_receipt_id IS DISTINCT FROM OLD.notice_receipt_id
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

  // Revoke the default function EXECUTE privilege and any pre-existing table,
  // column, or routine grants before exposing even catalog metadata.
  await sql.query(`
    REVOKE ALL
    ON TABLE omni_memory_informed_notice_contracts,
      omni_tenant_actor_memory_notice_receipts,
      omni_tenant_actor_memory_purpose_consents
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_memory_informed_notice_contract_row_is_valid(
      SMALLINT, TEXT, TEXT, SMALLINT, TEXT, TEXT, TEXT, TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_memory_informed_notice_contract_change()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_actor_memory_notice_receipt_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT,
      SMALLINT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ
    )
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_validate_actor_memory_notice_receipt_insert()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_reject_actor_memory_notice_receipt_change()
    FROM PUBLIC
  `);
  await sql.query(`
    REVOKE ALL
    ON FUNCTION omni_actor_memory_purpose_consent_row_is_valid(
      SMALLINT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, BIGINT,
      TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
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
        SELECT DISTINCT table_name, grantee
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_memory_informed_notice_contracts',
            'omni_tenant_actor_memory_notice_receipts',
            'omni_tenant_actor_memory_purpose_consents'
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
            'omni_memory_informed_notice_contracts',
            'omni_tenant_actor_memory_notice_receipts',
            'omni_tenant_actor_memory_purpose_consents'
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
            'omni_memory_informed_notice_contract_row_is_valid',
            'omni_reject_memory_informed_notice_contract_change',
            'omni_actor_memory_notice_receipt_row_is_valid',
            'omni_validate_actor_memory_notice_receipt_insert',
            'omni_reject_actor_memory_notice_receipt_change',
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
          '%I.omni_memory_informed_notice_contract_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, SMALLINT, TEXT, TEXT, TEXT, ' ||
          'TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_memory_informed_notice_contract_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_actor_memory_notice_receipt_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, ' ||
          'SMALLINT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ) FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_validate_actor_memory_notice_receipt_insert() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_reject_actor_memory_notice_receipt_change() FROM %I',
          current_schema(),
          grant_record.grantee
        );
        EXECUTE format(
          'REVOKE ALL ON FUNCTION ' ||
          '%I.omni_actor_memory_purpose_consent_row_is_valid(' ||
          'SMALLINT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, ' ||
          'BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, ' ||
          'TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
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

  // Apply isolation only to the new tenant receipt relation. The global
  // notice contract remains owner-only without RLS.
  await sql`
    ALTER TABLE omni_tenant_actor_memory_notice_receipts
      ENABLE ROW LEVEL SECURITY
  `;
  await sql`
    ALTER TABLE omni_tenant_actor_memory_notice_receipts
      FORCE ROW LEVEL SECURITY
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND polname = 'omni_tenant_isolation'
      ) THEN
        ALTER POLICY omni_tenant_isolation
        ON omni_tenant_actor_memory_notice_receipts
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      ELSE
        CREATE POLICY omni_tenant_isolation
        ON omni_tenant_actor_memory_notice_receipts
        FOR ALL
        TO PUBLIC
        USING (omni_tenant_visible(tenant_id))
        WITH CHECK (omni_tenant_visible(tenant_id));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND polname = 'omni_memory_notice_receipt_holdback'
      ) THEN
        CREATE POLICY omni_memory_notice_receipt_holdback
        ON omni_tenant_actor_memory_notice_receipts
        AS RESTRICTIVE
        FOR ALL
        TO PUBLIC
        USING (omni_system_scope_enabled())
        WITH CHECK (omni_system_scope_enabled());
      END IF;
    END
    $migration$
  `;

  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
}

/**
 * Re-proves the exact dormant v55 notice, receipt, and consent boundary.
 *
 * This verifier performs no durable write, grants no privilege, and does not
 * make an authority available to runtime code. The locks keep every catalog
 * and zero-row observation stable for the rest of the migration transaction.
 */
async function verifyMemoryInformedNoticeAuthorityBoundary(sql: SqlClient) {
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Memory informed notice boundary verification requires the schema owner'
          USING ERRCODE = '42501';
      END IF;

      IF NOT omni_system_scope_enabled() THEN
        RAISE EXCEPTION 'Memory informed notice boundary verification requires system scope'
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
      omni_tenant_memory_purpose_entitlements,
      omni_tenant_actor_membership_epochs,
      omni_memory_informed_notice_contracts,
      omni_tenant_actor_memory_notice_receipts,
      omni_tenant_actor_memory_purpose_consents
    IN SHARE MODE
  `;

  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid =
            'omni_memory_informed_notice_contracts'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Memory informed notice contract relation is invalid'
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
              'omni_memory_informed_notice_contracts'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'schema_version', 'purpose_id', 'notice_contract_id',
            'notice_contract_version', 'locale_id', 'notice_text',
            'notice_sha256', 'created_at'
          ]::TEXT[]
          AND columns.not_null_names = columns.names
          AND columns.none_generated
          AND columns.column_count = 8
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('schema_version', 'smallint'::REGTYPE, 0::OID),
            (
              'purpose_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'notice_contract_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('notice_contract_version', 'smallint'::REGTYPE, 0::OID),
            (
              'locale_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'notice_text',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'notice_sha256',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('created_at', 'timestamp with time zone'::REGTYPE, 0::OID)
        ) expected(column_name, type_oid, collation_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_memory_informed_notice_contracts'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attcollation <> expected.collation_oid
      ) THEN
        RAISE EXCEPTION 'Memory informed notice contract columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_memory_informed_notice_contracts'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_memory_informed_notice_contracts'::regclass
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
            'omni_memory_informed_notice_contracts'::regclass
          AND attribute.attname = 'created_at'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) THEN
        RAISE EXCEPTION 'Memory informed notice contract defaults are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_contracts'::regclass
          AND contype <> 'n'
      ) <> 4 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE constraint_record.conname =
            'omni_memory_informed_notice_contracts_pkey'
          AND constraint_record.conrelid =
            'omni_memory_informed_notice_contracts'::regclass
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
                  'omni_memory_informed_notice_contracts'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_memory_informed_notice_contracts'::regclass
                AND attname = 'notice_contract_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_memory_informed_notice_contracts'::regclass
                AND attname = 'notice_contract_version' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indislive
          AND index_record.indimmediate
          AND index_record.indnkeyatts = 3
          AND index_record.indnatts = 3
          AND index_record.indexprs IS NULL
          AND index_record.indpred IS NULL
          AND index_relation.relkind = 'i'
          AND index_relation.relam = (
            SELECT oid FROM pg_am WHERE amname = 'btree'
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
            'pg_catalog.int2_ops'
          ]::TEXT[]
          AND (
            SELECT array_agg(collation_oid ORDER BY ordinal_position)
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
            SELECT array_agg(key_option ORDER BY ordinal_position)
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
            'omni_memory_informed_notice_contracts_row_check'
          AND constraint_record.conrelid =
            'omni_memory_informed_notice_contracts'::regclass
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
            'omni_memory_informed_notice_contract_row_is_valid(schema_version, purpose_id, notice_contract_id, notice_contract_version, locale_id, notice_text, notice_sha256, created_at)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memory_informed_notice_contracts_seed_hold_check'
          AND constraint_record.conrelid =
            'omni_memory_informed_notice_contracts'::regclass
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
          ) = 'false'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memory_informed_notice_contracts_purpose_fkey'
          AND constraint_record.conrelid =
            'omni_memory_informed_notice_contracts'::regclass
          AND constraint_record.contype = 'f'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND constraint_record.confrelid =
            'omni_memory_purpose_catalog'::regclass
          AND constraint_record.confupdtype = 'r'
          AND constraint_record.confdeltype = 'r'
          AND constraint_record.confmatchtype = 's'
          AND constraint_record.conkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_memory_informed_notice_contracts'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND constraint_record.confkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid = 'omni_memory_purpose_catalog'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) OR (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_memory_informed_notice_contracts'::regclass
      ) <> 1 THEN
        RAISE EXCEPTION 'Memory informed notice contract constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF public.omni_memory_informed_notice_contract_row_is_valid(
        1::SMALLINT,
        'memory.read.v1',
        'notice:memory_read',
        1::SMALLINT,
        'en-US',
        'Memory informed notice contract check.',
        repeat('a', 64),
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_memory_informed_notice_contract_row_is_valid(
          2::SMALLINT,
          'memory.read.v1',
          'notice:memory_read',
          1::SMALLINT,
          'en-US',
          'Memory informed notice contract check.',
          repeat('a', 64),
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_memory_informed_notice_contract_row_is_valid(
          1::SMALLINT,
          'memory.read.v1',
          'notice:memory_read',
          1::SMALLINT,
          'en-US',
          ' Memory informed notice contract check.',
          repeat('a', 64),
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_memory_informed_notice_contract_row_is_valid(
          1::SMALLINT,
          'memory.read.v1',
          'notice:memory_read',
          1::SMALLINT,
          'en-US',
          'Memory informed notice contract check.',
          repeat('A', 64),
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_memory_informed_notice_contract_row_is_valid(
          1::SMALLINT,
          'memory.read.v1',
          'notice:memory_read',
          1::SMALLINT,
          'en-US',
          'Memory informed notice contract check.',
          repeat('a', 64),
          NULL
        ) IS NOT NULL
      THEN
        RAISE EXCEPTION 'Memory informed notice contract validator is invalid'
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
          'public.omni_memory_informed_notice_contract_row_is_valid(smallint,text,text,smallint,text,text,text,timestamptz)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
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
          AND procedure.prosrc = $expected$
      SELECT candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_contract_id
        )
        AND candidate_notice_contract_version BETWEEN 1 AND 32767
        AND candidate_locale_id = btrim(candidate_locale_id)
        AND char_length(candidate_locale_id) BETWEEN 2 AND 35
        AND candidate_locale_id ~
          '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
        AND candidate_notice_text = btrim(candidate_notice_text)
        AND char_length(candidate_notice_text) BETWEEN 1 AND 20000
        AND candidate_notice_sha256 ~ '^[0-9a-f]{64}$'
        AND candidate_created_at IS NOT NULL
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_memory_informed_notice_contract_change()'
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
      RAISE EXCEPTION 'Memory informed notice contracts are append-only'
        USING ERRCODE = '55000';
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Memory informed notice contract functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_memory_informed_notice_contracts'::regclass
          AND NOT tgisinternal
      ) <> 2 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_memory_informed_notice_contract_immutable',
              to_regprocedure(
                'public.omni_reject_memory_informed_notice_contract_change()'
              ),
              27
            ),
            (
              'omni_memory_informed_notice_contract_no_truncate',
              to_regprocedure(
                'public.omni_reject_memory_informed_notice_contract_change()'
              ),
              34
            )
        ) expected(trigger_name, procedure_oid, trigger_type)
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger trigger_record
            WHERE trigger_record.tgrelid =
                'omni_memory_informed_notice_contracts'::regclass
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
        FROM pg_policy
        WHERE polrelid =
          'omni_memory_informed_notice_contracts'::regclass
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_informed_notice_contracts'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memory_informed_notice_contracts'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_memory_informed_notice_contract_row_is_valid',
            'omni_reject_memory_informed_notice_contract_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_contracts
      ) THEN
        RAISE EXCEPTION 'Memory informed notice contract boundary is invalid'
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
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt relation is invalid'
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
              'omni_tenant_actor_memory_notice_receipts'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) columns
        WHERE columns.names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id', 'purpose_id',
            'consent_generation', 'membership_epoch', 'notice_receipt_id',
            'notice_contract_id', 'notice_contract_version', 'presented_at',
            'acknowledged_by_actor_id', 'acknowledged_at'
          ]::TEXT[]
          AND columns.not_null_names = columns.names
          AND columns.none_generated
          AND columns.column_count = 12
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
              'purpose_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('consent_generation', 'bigint'::REGTYPE, 0::OID),
            ('membership_epoch', 'bigint'::REGTYPE, 0::OID),
            (
              'notice_receipt_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'notice_contract_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('notice_contract_version', 'smallint'::REGTYPE, 0::OID),
            ('presented_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            (
              'acknowledged_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('acknowledged_at', 'timestamp with time zone'::REGTYPE, 0::OID)
        ) expected(column_name, type_oid, collation_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attcollation <> expected.collation_oid
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_attrdef
        WHERE adrelid =
          'omni_tenant_actor_memory_notice_receipts'::regclass
      ) <> 3 OR NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND attribute.attname = 'schema_version'
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) IN ('1', '1::smallint', '(1)::smallint')
      ) OR (
        SELECT count(*)
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND attribute.attname IN ('presented_at', 'acknowledged_at')
          AND pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid
          ) = 'now()'
      ) <> 2 THEN
        RAISE EXCEPTION 'Actor memory notice receipt defaults are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND contype <> 'n'
      ) <> 8 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
        WHERE constraint_record.conname =
            'omni_tenant_actor_memory_notice_receipts_pkey'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
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
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'subject_actor_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'purpose_id' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'consent_generation' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'membership_epoch' AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_tenant_actor_memory_notice_receipts'::regclass
                AND attname = 'notice_receipt_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisprimary
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
          AND index_record.indislive
          AND index_record.indimmediate
          AND index_record.indnkeyatts = 6
          AND index_record.indnatts = 6
          AND index_record.indexprs IS NULL
          AND index_record.indpred IS NULL
          AND index_relation.relkind = 'i'
          AND index_relation.relam = (
            SELECT oid FROM pg_am WHERE amname = 'btree'
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
            'pg_catalog.text_ops',
            'pg_catalog.int8_ops',
            'pg_catalog.int8_ops',
            'pg_catalog.text_ops'
          ]::TEXT[]
          AND (
            SELECT array_agg(collation_oid ORDER BY ordinal_position)
            FROM unnest(index_record.indcollation)
              WITH ORDINALITY AS key_collation(
                collation_oid,
                ordinal_position
              )
          ) = ARRAY[
            'pg_catalog.default'::REGCOLLATION::OID,
            'pg_catalog.default'::REGCOLLATION::OID,
            'pg_catalog.default'::REGCOLLATION::OID,
            0::OID,
            0::OID,
            'pg_catalog.default'::REGCOLLATION::OID
          ]::OID[]
          AND (
            SELECT array_agg(key_option ORDER BY ordinal_position)
            FROM unnest(index_record.indoption)
              WITH ORDINALITY AS key_options(
                key_option,
                ordinal_position
              )
          ) = ARRAY[0, 0, 0, 0, 0, 0]::SMALLINT[]
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_memory_notice_receipts_row_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
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
            'omni_actor_memory_notice_receipt_row_is_valid(schema_version, tenant_id, subject_actor_id, purpose_id, consent_generation, membership_epoch, notice_receipt_id, notice_contract_id, notice_contract_version, presented_at, acknowledged_by_actor_id, acknowledged_at)'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_memory_notice_receipts_issuance_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
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
          ) = 'false'
      ) OR (
        SELECT count(*)
        FROM pg_index
        WHERE indrelid =
          'omni_tenant_actor_memory_notice_receipts'::regclass
      ) <> 1 THEN
        RAISE EXCEPTION 'Actor memory notice receipt constraints are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_memory_notice_receipts_tenant_fkey',
              ARRAY['tenant_id']::TEXT[],
              'omni_auth_tenants'::REGCLASS,
              ARRAY['id']::TEXT[]
            ),
            (
              'omni_actor_memory_notice_receipts_subject_actor_fkey',
              ARRAY['subject_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_notice_receipts_ack_actor_fkey',
              ARRAY['acknowledged_by_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_notice_receipts_epoch_fkey',
              ARRAY[
                'tenant_id', 'subject_actor_id', 'membership_epoch'
              ]::TEXT[],
              'omni_tenant_actor_membership_epochs'::REGCLASS,
              ARRAY[
                'tenant_id', 'subject_actor_id', 'membership_epoch'
              ]::TEXT[]
            ),
            (
              'omni_actor_memory_notice_receipts_contract_fkey',
              ARRAY[
                'purpose_id', 'notice_contract_id',
                'notice_contract_version'
              ]::TEXT[],
              'omni_memory_informed_notice_contracts'::REGCLASS,
              ARRAY[
                'purpose_id', 'notice_contract_id',
                'notice_contract_version'
              ]::TEXT[]
            )
        ) expected(
          constraint_name,
          local_columns,
          foreign_relation,
          foreign_columns
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          WHERE constraint_record.conname = expected.constraint_name
            AND constraint_record.conrelid =
              'omni_tenant_actor_memory_notice_receipts'::regclass
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
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.conkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = expected.local_columns
            AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.confkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.confrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = expected.foreign_columns
        )
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt references are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF public.omni_actor_memory_notice_receipt_row_is_valid(
        1::SMALLINT,
        'tenant:notice_receipt_check',
        'actor:notice_receipt_subject',
        'memory.read.v1',
        1::BIGINT,
        1::BIGINT,
        'receipt:notice_check',
        'notice:memory_read',
        1::SMALLINT,
        CURRENT_TIMESTAMP,
        'actor:notice_receipt_subject',
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_actor_memory_notice_receipt_row_is_valid(
          1::SMALLINT,
          'tenant:notice_receipt_check',
          'actor:notice_receipt_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:notice_check',
          'notice:memory_read',
          1::SMALLINT,
          CURRENT_TIMESTAMP,
          'actor:other',
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_notice_receipt_row_is_valid(
          1::SMALLINT,
          'tenant:notice_receipt_check',
          'actor:notice_receipt_subject',
          'memory.read.v1',
          1::BIGINT,
          0::BIGINT,
          'receipt:notice_check',
          'notice:memory_read',
          1::SMALLINT,
          CURRENT_TIMESTAMP,
          'actor:notice_receipt_subject',
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_notice_receipt_row_is_valid(
          1::SMALLINT,
          'tenant:notice_receipt_check',
          'actor:notice_receipt_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:notice_check',
          'notice:memory_read',
          1::SMALLINT,
          CURRENT_TIMESTAMP,
          'actor:notice_receipt_subject',
          CURRENT_TIMESTAMP - INTERVAL '1 second'
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_notice_receipt_row_is_valid(
          1::SMALLINT,
          'tenant:notice_receipt_check',
          NULL,
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:notice_check',
          'notice:memory_read',
          1::SMALLINT,
          CURRENT_TIMESTAMP,
          'actor:notice_receipt_subject',
          CURRENT_TIMESTAMP
        ) IS NOT NULL
      THEN
        RAISE EXCEPTION 'Actor memory notice receipt validator is invalid'
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
          'public.omni_actor_memory_notice_receipt_row_is_valid(smallint,text,text,text,bigint,bigint,text,text,smallint,timestamptz,text,timestamptz)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
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
          AND procedure.prosrc = $expected$
      SELECT candidate_schema_version = 1
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_receipt_id
        )
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_contract_id
        )
        AND candidate_notice_contract_version BETWEEN 1 AND 32767
        AND public.omni_source_contract_id_is_valid(
          candidate_acknowledged_by_actor_id
        )
        AND candidate_acknowledged_by_actor_id = candidate_subject_actor_id
        AND candidate_presented_at <= candidate_acknowledged_at
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_validate_actor_memory_notice_receipt_insert()'
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
      PERFORM pg_advisory_xact_lock(
        hashtext(NEW.tenant_id),
        hashtext(NEW.subject_actor_id || chr(31) || NEW.purpose_id)
      );

      IF NEW.acknowledged_by_actor_id IS DISTINCT FROM
        NEW.subject_actor_id
      THEN
        RAISE EXCEPTION 'Memory notice acknowledgment attribution is invalid'
          USING ERRCODE = '23514';
      END IF;

      NEW.presented_at := statement_timestamp();
      NEW.acknowledged_at := NEW.presented_at;
      RETURN NEW;
    END
    $expected$
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_reject_actor_memory_notice_receipt_change()'
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
      RAISE EXCEPTION 'Actor memory notice receipts are immutable'
        USING ERRCODE = '55000';
    END
    $expected$
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND NOT tgisinternal
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_memory_notice_receipt_validate_insert',
              to_regprocedure(
                'public.omni_validate_actor_memory_notice_receipt_insert()'
              ),
              7
            ),
            (
              'omni_actor_memory_notice_receipt_immutable',
              to_regprocedure(
                'public.omni_reject_actor_memory_notice_receipt_change()'
              ),
              27
            ),
            (
              'omni_actor_memory_notice_receipt_no_truncate',
              to_regprocedure(
                'public.omni_reject_actor_memory_notice_receipt_change()'
              ),
              34
            )
        ) expected(trigger_name, procedure_oid, trigger_type)
        WHERE expected.procedure_oid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM pg_trigger trigger_record
            WHERE trigger_record.tgrelid =
                'omni_tenant_actor_memory_notice_receipts'::regclass
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
        RAISE EXCEPTION 'Actor memory notice receipt triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
        FROM pg_policy
        WHERE polrelid =
          'omni_tenant_actor_memory_notice_receipts'::regclass
      ) <> 2 OR NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
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
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND polname = 'omni_memory_notice_receipt_holdback'
          AND NOT polpermissive
          AND polcmd = '*'
          AND polroles = ARRAY[0::OID]
          AND pg_get_expr(polqual, polrelid) =
            'omni_system_scope_enabled()'
          AND pg_get_expr(polwithcheck, polrelid) =
            'omni_system_scope_enabled()'
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_notice_receipts'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.column_privileges
        WHERE table_schema = current_schema()
          AND table_name = 'omni_tenant_actor_memory_notice_receipts'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_actor_memory_notice_receipt_row_is_valid',
            'omni_validate_actor_memory_notice_receipt_insert',
            'omni_reject_actor_memory_notice_receipt_change'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM omni_tenant_actor_memory_notice_receipts
      ) THEN
        RAISE EXCEPTION 'Actor memory notice receipt boundary is exposed'
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
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
          AND relation.relowner = (
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 relation is invalid'
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
            'revoked_at', 'updated_at', 'membership_epoch',
            'notice_receipt_id'
          ]::TEXT[]
          AND columns.not_null_names = ARRAY[
            'schema_version', 'tenant_id', 'subject_actor_id', 'purpose_id',
            'consent_generation', 'state', 'lifecycle_revision',
            'created_by_actor_id', 'created_at', 'updated_at',
            'membership_epoch', 'notice_receipt_id'
          ]::TEXT[]
          AND columns.none_generated
          AND columns.column_count = 16
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
              'purpose_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('consent_generation', 'bigint'::REGTYPE, 0::OID),
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
              'granted_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'revoked_by_actor_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('created_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('granted_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('revoked_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('updated_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('membership_epoch', 'bigint'::REGTYPE, 0::OID),
            (
              'notice_receipt_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            )
        ) expected(column_name, type_oid, collation_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attcollation <> expected.collation_oid
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 columns are invalid'
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
          ) IN ('2', '2::smallint', '(2)::smallint')
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
      ) <> 2 OR EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_attrdef attribute_default
          ON attribute_default.adrelid = attribute.attrelid
          AND attribute_default.adnum = attribute.attnum
        WHERE attribute.attrelid =
            'omni_tenant_actor_memory_purpose_consents'::regclass
          AND attribute.attname IN ('membership_epoch', 'notice_receipt_id')
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 defaults are invalid'
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
      ) <> 11 OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_index index_record
          ON index_record.indexrelid = constraint_record.conindid
        JOIN pg_class index_relation
          ON index_relation.oid = index_record.indexrelid
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
          AND index_record.indislive
          AND index_record.indimmediate
          AND index_record.indnkeyatts = 4
          AND index_record.indnatts = 4
          AND index_record.indexprs IS NULL
          AND index_record.indpred IS NULL
          AND index_relation.relkind = 'i'
          AND index_relation.relam = (
            SELECT oid FROM pg_am WHERE amname = 'btree'
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
            'pg_catalog.text_ops',
            'pg_catalog.int8_ops'
          ]::TEXT[]
          AND (
            SELECT array_agg(collation_oid ORDER BY ordinal_position)
            FROM unnest(index_record.indcollation)
              WITH ORDINALITY AS key_collation(
                collation_oid,
                ordinal_position
              )
          ) = ARRAY[
            'pg_catalog.default'::REGCOLLATION::OID,
            'pg_catalog.default'::REGCOLLATION::OID,
            'pg_catalog.default'::REGCOLLATION::OID,
            0::OID
          ]::OID[]
          AND (
            SELECT array_agg(key_option ORDER BY ordinal_position)
            FROM unnest(index_record.indoption)
              WITH ORDINALITY AS key_options(
                key_option,
                ordinal_position
              )
          ) = ARRAY[0, 0, 0, 0]::SMALLINT[]
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
            'omni_actor_memory_purpose_consent_row_is_valid(schema_version, tenant_id, subject_actor_id, purpose_id, consent_generation, membership_epoch, notice_receipt_id, state, lifecycle_revision, created_by_actor_id, granted_by_actor_id, revoked_by_actor_id, created_at, granted_at, revoked_at, updated_at)'
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            (
              'omni_actor_memory_purpose_consents_tenant_fkey',
              ARRAY['tenant_id']::TEXT[],
              'omni_auth_tenants'::REGCLASS,
              ARRAY['id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_purpose_fkey',
              ARRAY['purpose_id']::TEXT[],
              'omni_memory_purpose_catalog'::REGCLASS,
              ARRAY['purpose_id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_subject_actor_fkey',
              ARRAY['subject_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_created_actor_fkey',
              ARRAY['created_by_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_granted_actor_fkey',
              ARRAY['granted_by_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_revoked_actor_fkey',
              ARRAY['revoked_by_actor_id']::TEXT[],
              'omni_auth_users'::REGCLASS,
              ARRAY['actor_id']::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_epoch_fkey',
              ARRAY[
                'tenant_id', 'subject_actor_id', 'membership_epoch'
              ]::TEXT[],
              'omni_tenant_actor_membership_epochs'::REGCLASS,
              ARRAY[
                'tenant_id', 'subject_actor_id', 'membership_epoch'
              ]::TEXT[]
            ),
            (
              'omni_actor_memory_purpose_consents_receipt_fkey',
              ARRAY[
                'tenant_id', 'subject_actor_id', 'purpose_id',
                'consent_generation', 'membership_epoch',
                'notice_receipt_id'
              ]::TEXT[],
              'omni_tenant_actor_memory_notice_receipts'::REGCLASS,
              ARRAY[
                'tenant_id', 'subject_actor_id', 'purpose_id',
                'consent_generation', 'membership_epoch',
                'notice_receipt_id'
              ]::TEXT[]
            )
        ) expected(
          constraint_name,
          local_columns,
          foreign_relation,
          foreign_columns
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
            AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.conkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = expected.local_columns
            AND (
              SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
              FROM unnest(constraint_record.confkey)
                WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_record.confrelid
                AND attribute.attnum = key.attnum
                AND NOT attribute.attisdropped
            ) = expected.foreign_columns
        )
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 references are invalid'
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
        RAISE EXCEPTION 'Actor memory purpose consent v2 indexes are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    BEGIN
      IF public.omni_actor_memory_purpose_consent_row_is_valid(
        2::SMALLINT,
        'tenant:consent_v2_check',
        'actor:consent_v2_subject',
        'memory.read.v1',
        1::BIGINT,
        1::BIGINT,
        'receipt:consent_v2_check',
        'held',
        0::BIGINT,
        'actor:consent_v2_creator',
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        NULL,
        NULL,
        CURRENT_TIMESTAMP
      ) IS DISTINCT FROM TRUE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          2::SMALLINT,
          'tenant:consent_v2_check',
          'actor:consent_v2_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:consent_v2_check',
          'granted',
          1::BIGINT,
          'actor:consent_v2_creator',
          'actor:consent_v2_subject',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM TRUE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          1::SMALLINT,
          'tenant:consent_v2_check',
          'actor:consent_v2_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:consent_v2_check',
          'held',
          0::BIGINT,
          'actor:consent_v2_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          2::SMALLINT,
          'tenant:consent_v2_check',
          'actor:consent_v2_subject',
          'memory.read.v1',
          1::BIGINT,
          0::BIGINT,
          'receipt:consent_v2_check',
          'held',
          0::BIGINT,
          'actor:consent_v2_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          2::SMALLINT,
          'tenant:consent_v2_check',
          'actor:consent_v2_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          ' receipt:consent_v2_check',
          'held',
          0::BIGINT,
          'actor:consent_v2_creator',
          NULL,
          NULL,
          CURRENT_TIMESTAMP,
          NULL,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE OR
        public.omni_actor_memory_purpose_consent_row_is_valid(
          2::SMALLINT,
          'tenant:consent_v2_check',
          'actor:consent_v2_subject',
          'memory.read.v1',
          1::BIGINT,
          1::BIGINT,
          'receipt:consent_v2_check',
          'granted',
          1::BIGINT,
          'actor:consent_v2_creator',
          'actor:other',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          NULL,
          CURRENT_TIMESTAMP
        ) IS DISTINCT FROM FALSE
      THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 validator is invalid'
          USING ERRCODE = '55000';
      END IF;

      IF to_regprocedure(
        'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
      ) IS NOT NULL THEN
        RAISE EXCEPTION 'Obsolete consent v1 validator overload remains'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_actor_memory_purpose_consent_row_is_valid(smallint,text,text,text,bigint,bigint,text,text,bigint,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz)'
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
        candidate_schema_version = 2
        AND public.omni_source_contract_id_is_valid(candidate_tenant_id)
        AND public.omni_source_contract_id_is_valid(
          candidate_subject_actor_id
        )
        AND public.omni_source_contract_id_is_valid(candidate_purpose_id)
        AND candidate_purpose_id NOT LIKE 'memory.export.v%'
        AND candidate_purpose_id NOT LIKE 'memory.forget.v%'
        AND candidate_consent_generation BETWEEN 1 AND 9007199254740991
        AND candidate_membership_epoch BETWEEN 1 AND 9007199254740991
        AND public.omni_source_contract_id_is_valid(
          candidate_notice_receipt_id
        )
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
        OR NEW.membership_epoch IS DISTINCT FROM OLD.membership_epoch
        OR NEW.notice_receipt_id IS DISTINCT FROM OLD.notice_receipt_id
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
        RAISE EXCEPTION 'Actor memory purpose consent v2 functions are invalid'
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
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 triggers are invalid'
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
        RAISE EXCEPTION 'Actor memory purpose consent v2 policies are invalid'
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
      ) OR EXISTS (
        SELECT 1 FROM omni_tenant_actor_memory_purpose_consents
      ) THEN
        RAISE EXCEPTION 'Actor memory purpose consent v2 boundary is exposed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  // Re-prove every preceding authorization hold and the unchanged live auth
  // boundary without adding a reader, writer, runtime grant, row, or event.
  await sql`
    DO $migration$
    DECLARE
      valid_scope JSONB;
    BEGIN
      valid_scope := jsonb_build_object(
        'version', 1,
        'tenantId', 'tenant:notice_receipt_check',
        'initiatingActorId', 'actor:notice_receipt_subject',
        'executingPrincipalType', 'user',
        'executingPrincipalId', 'actor:notice_receipt_subject',
        'workspaceId', NULL,
        'projectId', NULL,
        'missionId', NULL,
        'contextGrantIds', '[]'::JSONB,
        'capabilityGrantIds', '[]'::JSONB,
        'purposeId', 'memory.read.v1',
        'purpose', 'Informed notice receipt shadow self-check'
      );

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
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_memory_informed_notice_contracts_seed_hold_check'
          AND constraint_record.conrelid =
            'omni_memory_informed_notice_contracts'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = 'false'
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        WHERE constraint_record.conname =
            'omni_actor_memory_notice_receipts_issuance_hold_check'
          AND constraint_record.conrelid =
            'omni_tenant_actor_memory_notice_receipts'::regclass
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
            (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
            TRUE
          )
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = 'false'
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
          ) = '(state <> ''active''::text)'
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
          AND pg_get_expr(
            constraint_record.conbin,
            constraint_record.conrelid
          ) = '(state <> ''active''::text)'
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
          ) = '(state <> ''granted''::text)'
      ) THEN
        RAISE EXCEPTION 'Memory informed notice issuance holds changed'
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
        RAISE EXCEPTION 'Memory informed notice authority shadows are not empty'
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
        ) OR NOT EXISTS (
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
        RAISE EXCEPTION 'Memory informed notice tenant holdbacks changed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  // Exact live-auth catalog checks follow.
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
            SELECT relowner FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
      ) <> 3 THEN
        RAISE EXCEPTION 'Memory notice live auth relations changed'
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
              SELECT attnum FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND index_record.indisunique
          AND index_record.indisvalid
          AND index_record.indisready
      ) THEN
        RAISE EXCEPTION 'Memory notice auth-user actor identity changed'
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
            (
              'id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'tenant_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'user_id',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'role',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            (
              'status',
              'text'::REGTYPE,
              'pg_catalog.default'::REGCOLLATION::OID
            ),
            ('created_at', 'timestamp with time zone'::REGTYPE, 0::OID),
            ('updated_at', 'timestamp with time zone'::REGTYPE, 0::OID)
        ) expected(column_name, type_oid, collation_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = 'omni_auth_memberships'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attcollation <> expected.collation_oid
      ) THEN
        RAISE EXCEPTION 'Memory notice auth membership columns changed'
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
      ) THEN
        RAISE EXCEPTION 'Memory notice auth membership constraints changed'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
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
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'tenant_id'
                AND NOT attisdropped
            ),
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid = 'omni_auth_memberships'::regclass
                AND attname = 'user_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) THEN
        RAISE EXCEPTION 'Memory notice auth membership index changed'
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
        RAISE EXCEPTION 'Memory notice live auth visibility changed'
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
        RAISE EXCEPTION 'Memory notice live auth data changed'
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
        RAISE EXCEPTION 'Memory informed notice boundary has a runtime grant'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureMemoryInformedNoticeAuthorityBoundaryVerification(
  sql: SqlClient,
) {
  // Existing databases already recorded v55, so the reusable verifier must be
  // anchored to that exact immutable migration identity before a later writer
  // migration is allowed to depend on it.
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM omni_schema_version
        WHERE version = 55
          AND name = 'memory_informed_notice_receipts_and_consent_v2_shadow'
          AND checksum =
            'a48279b78e473f2c452748aa09b87a874672d57a1d257392741159f1d9d4af55'
      ) THEN
        RAISE EXCEPTION 'Memory informed notice boundary requires exact migration v55'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
}

export async function ensureMemoryInformedNoticeGovernanceEvidenceShadow(
  sql: SqlClient,
) {
  // v66 only installs a closed persistence shape for a future, externally
  // verified legal/privacy review ceremony. It does not seed notice wording,
  // trust a database role, remove a v55 hold, or expose a runtime reader.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM omni_schema_version
        WHERE version = 65
          AND name =
            'memory_informed_notice_authority_boundary_verification'
          AND checksum =
            '6dacefc682e876fe123701a039428a11ba160a225025da0a86ef27045bcad476'
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence requires exact migration v65'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;

  // Re-prove and stabilize every v55 authority surface before installing a
  // schema that a later writer migration may consume.
  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
  await sql`
    LOCK TABLE
      omni_auth_users,
      omni_memory_purpose_catalog
    IN SHARE MODE
  `;

  const targetRelationState = await sql`
    SELECT
      to_regclass(
        'public.omni_memory_informed_notice_approval_batches'
      ) IS NOT NULL AS batches_exist,
      to_regclass(
        'public.omni_memory_informed_notice_approval_contracts'
      ) IS NOT NULL AS contracts_exist,
      to_regclass(
        'public.omni_memory_informed_notice_review_attestations'
      ) IS NOT NULL AS attestations_exist
  `;
  const batchesExist = targetRelationState[0]?.batches_exist;
  const contractsExist = targetRelationState[0]?.contracts_exist;
  const attestationsExist = targetRelationState[0]?.attestations_exist;
  if (
    typeof batchesExist !== "boolean" ||
    typeof contractsExist !== "boolean" ||
    typeof attestationsExist !== "boolean"
  ) {
    throw new Error("Informed notice governance evidence retry state is invalid.");
  }
  const existingCount = [batchesExist, contractsExist, attestationsExist].filter(Boolean).length;
  if (existingCount !== 0 && existingCount !== 3) {
    throw new Error("Informed notice governance evidence install is partial.");
  }

  if (existingCount === 0) {
    await sql`
      CREATE FUNCTION omni_notice_approval_batch_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_approval_batch_id TEXT,
        candidate_batch_sha256 TEXT,
        candidate_governance_policy_id TEXT,
        candidate_governance_policy_version BIGINT,
        candidate_decision_nonce_sha256 TEXT,
        candidate_evidence_sha256 TEXT,
        candidate_notice_count SMALLINT,
        candidate_verification_kind TEXT,
        candidate_trust_manifest_id TEXT,
        candidate_trust_manifest_revision BIGINT,
        candidate_trust_manifest_sha256 TEXT,
        candidate_trust_manifest_issued_at TIMESTAMPTZ,
        candidate_observed_at TIMESTAMPTZ,
        candidate_recorded_by_actor_id TEXT,
        candidate_recorded_at TIMESTAMPTZ
      )
      RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $function$
        SELECT COALESCE(
          candidate_schema_version = 1
          AND candidate_approval_batch_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_batch_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_governance_policy_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_governance_policy_version BETWEEN 1 AND 32767
          AND candidate_decision_nonce_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_evidence_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_notice_count BETWEEN 1 AND 64
          AND candidate_verification_kind =
            'offline_external_trust_manifest_v1'
          AND candidate_trust_manifest_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_trust_manifest_revision
            BETWEEN 1 AND 9007199254740991
          AND candidate_trust_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_trust_manifest_issued_at <= candidate_observed_at
          AND candidate_observed_at <= candidate_recorded_at
          AND candidate_recorded_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          FALSE
        )
      $function$
    `;

    await sql`
      CREATE FUNCTION omni_notice_approval_contract_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_approval_batch_id TEXT,
        candidate_batch_sha256 TEXT,
        candidate_notice_ordinal SMALLINT,
        candidate_record_schema_version SMALLINT,
        candidate_purpose_id TEXT,
        candidate_notice_contract_id TEXT,
        candidate_notice_contract_version SMALLINT,
        candidate_locale_id TEXT,
        candidate_notice_text TEXT,
        candidate_notice_sha256 TEXT
      )
      RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $function$
        SELECT COALESCE(
          candidate_schema_version = 1
          AND candidate_approval_batch_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_batch_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_notice_ordinal BETWEEN 0 AND 63
          AND candidate_record_schema_version = 1
          AND candidate_purpose_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_purpose_id !~ '^memory\\.(export|forget)\\.v'
          AND candidate_notice_contract_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_notice_contract_version BETWEEN 1 AND 32767
          AND candidate_locale_id ~
            '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
          AND char_length(candidate_locale_id) BETWEEN 2 AND 35
          AND char_length(candidate_notice_text) BETWEEN 1 AND 20000
          AND candidate_notice_text = btrim(candidate_notice_text)
          AND candidate_notice_sha256 ~ '^[0-9a-f]{64}$',
          FALSE
        )
      $function$
    `;

    await sql`
      CREATE FUNCTION omni_notice_review_attestation_row_is_valid(
        candidate_schema_version SMALLINT,
        candidate_approval_batch_id TEXT,
        candidate_batch_sha256 TEXT,
        candidate_governance_policy_id TEXT,
        candidate_governance_policy_version BIGINT,
        candidate_trust_manifest_sha256 TEXT,
        candidate_trust_manifest_issued_at TIMESTAMPTZ,
        candidate_observed_at TIMESTAMPTZ,
        candidate_review_slot TEXT,
        candidate_review_id TEXT,
        candidate_reviewer_actor_id TEXT,
        candidate_reviewed_at TIMESTAMPTZ,
        candidate_attester_key_id TEXT,
        candidate_public_key_sha256 TEXT,
        candidate_signature_algorithm TEXT,
        candidate_signature_base64url TEXT
      )
      RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $function$
        SELECT COALESCE(
          candidate_schema_version = 1
          AND candidate_approval_batch_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_batch_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_governance_policy_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_governance_policy_version BETWEEN 1 AND 32767
          AND candidate_trust_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_trust_manifest_issued_at <= candidate_reviewed_at
          AND candidate_review_slot IN ('legal_reviewer', 'privacy_reviewer')
          AND candidate_review_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_reviewer_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND candidate_reviewed_at <= candidate_observed_at
          AND candidate_attester_key_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_public_key_sha256 ~ '^[0-9a-f]{64}$'
          AND candidate_signature_algorithm = 'ed25519'
          AND candidate_signature_base64url ~
            '^[A-Za-z0-9_-]{85}[AQgw]$',
          FALSE
        )
      $function$
    `;

    await sql`
      CREATE FUNCTION omni_protect_notice_governance_evidence()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      VOLATILE
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $function$
      BEGIN
        RAISE EXCEPTION 'Informed notice governance evidence is immutable and held'
          USING ERRCODE = '55000';
      END
      $function$
    `;

    await sql`
      CREATE TABLE omni_memory_informed_notice_approval_batches (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        approval_batch_id TEXT NOT NULL,
        batch_sha256 TEXT NOT NULL,
        governance_policy_id TEXT NOT NULL,
        governance_policy_version BIGINT NOT NULL,
        decision_nonce_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        notice_count SMALLINT NOT NULL,
        verification_kind TEXT NOT NULL
          DEFAULT 'offline_external_trust_manifest_v1',
        trust_manifest_id TEXT NOT NULL,
        trust_manifest_revision BIGINT NOT NULL,
        trust_manifest_sha256 TEXT NOT NULL,
        trust_manifest_issued_at TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        recorded_by_actor_id TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT omni_notice_approval_batches_pkey
          PRIMARY KEY (approval_batch_id),
        CONSTRAINT omni_notice_approval_batches_digest_key
          UNIQUE (batch_sha256),
        CONSTRAINT omni_notice_approval_batches_id_digest_key
          UNIQUE (approval_batch_id, batch_sha256),
        CONSTRAINT omni_notice_approval_batches_binding_key UNIQUE (
          approval_batch_id, batch_sha256, governance_policy_id,
          governance_policy_version, trust_manifest_sha256,
          trust_manifest_issued_at, observed_at
        ),
        CONSTRAINT omni_notice_approval_batch_row_check CHECK (
          omni_notice_approval_batch_row_is_valid(
            schema_version, approval_batch_id, batch_sha256,
            governance_policy_id, governance_policy_version,
            decision_nonce_sha256, evidence_sha256, notice_count,
            verification_kind, trust_manifest_id, trust_manifest_revision,
            trust_manifest_sha256, trust_manifest_issued_at, observed_at,
            recorded_by_actor_id, recorded_at
          )
        ),
        CONSTRAINT omni_notice_approval_batches_persistence_hold_check
          CHECK (FALSE),
        CONSTRAINT omni_notice_approval_batches_recorded_actor_fkey
          FOREIGN KEY (recorded_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `;

    await sql`
      CREATE TABLE omni_memory_informed_notice_approval_contracts (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        approval_batch_id TEXT NOT NULL,
        batch_sha256 TEXT NOT NULL,
        notice_ordinal SMALLINT NOT NULL,
        record_schema_version SMALLINT NOT NULL DEFAULT 1,
        purpose_id TEXT NOT NULL,
        notice_contract_id TEXT NOT NULL,
        notice_contract_version SMALLINT NOT NULL,
        locale_id TEXT NOT NULL,
        notice_text TEXT NOT NULL,
        notice_sha256 TEXT NOT NULL,
        CONSTRAINT omni_notice_approval_contracts_pkey
          PRIMARY KEY (approval_batch_id, notice_ordinal),
        CONSTRAINT omni_notice_approval_contracts_identity_key UNIQUE (
          approval_batch_id, purpose_id, notice_contract_id,
          notice_contract_version
        ),
        CONSTRAINT omni_notice_approval_contract_row_check CHECK (
          omni_notice_approval_contract_row_is_valid(
            schema_version, approval_batch_id, batch_sha256, notice_ordinal,
            record_schema_version, purpose_id, notice_contract_id,
            notice_contract_version, locale_id, notice_text, notice_sha256
          )
        ),
        CONSTRAINT omni_notice_approval_contracts_persistence_hold_check
          CHECK (FALSE),
        CONSTRAINT omni_notice_approval_contracts_batch_fkey
          FOREIGN KEY (approval_batch_id, batch_sha256)
          REFERENCES omni_memory_informed_notice_approval_batches (
            approval_batch_id, batch_sha256
          ) ON UPDATE RESTRICT ON DELETE RESTRICT,
        CONSTRAINT omni_notice_approval_contracts_purpose_fkey
          FOREIGN KEY (purpose_id)
          REFERENCES omni_memory_purpose_catalog (purpose_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `;

    await sql`
      CREATE TABLE omni_memory_informed_notice_review_attestations (
        schema_version SMALLINT NOT NULL DEFAULT 1,
        approval_batch_id TEXT NOT NULL,
        batch_sha256 TEXT NOT NULL,
        governance_policy_id TEXT NOT NULL,
        governance_policy_version BIGINT NOT NULL,
        trust_manifest_sha256 TEXT NOT NULL,
        trust_manifest_issued_at TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        review_slot TEXT NOT NULL,
        review_id TEXT NOT NULL,
        reviewer_actor_id TEXT NOT NULL,
        reviewed_at TIMESTAMPTZ NOT NULL,
        attester_key_id TEXT NOT NULL,
        public_key_sha256 TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL DEFAULT 'ed25519',
        signature_base64url TEXT NOT NULL,
        CONSTRAINT omni_notice_review_attestations_pkey
          PRIMARY KEY (approval_batch_id, review_slot),
        CONSTRAINT omni_notice_review_attestations_review_key
          UNIQUE (approval_batch_id, review_id),
        CONSTRAINT omni_notice_review_attestations_actor_key
          UNIQUE (approval_batch_id, reviewer_actor_id),
        CONSTRAINT omni_notice_review_attestations_signer_key
          UNIQUE (approval_batch_id, attester_key_id),
        CONSTRAINT omni_notice_review_attestation_row_check CHECK (
          omni_notice_review_attestation_row_is_valid(
            schema_version, approval_batch_id, batch_sha256,
            governance_policy_id, governance_policy_version,
            trust_manifest_sha256, trust_manifest_issued_at, observed_at,
            review_slot, review_id, reviewer_actor_id, reviewed_at,
            attester_key_id, public_key_sha256, signature_algorithm,
            signature_base64url
          )
        ),
        CONSTRAINT omni_notice_review_attestations_persistence_hold_check
          CHECK (FALSE),
        CONSTRAINT omni_notice_review_attestations_batch_fkey FOREIGN KEY (
          approval_batch_id, batch_sha256, governance_policy_id,
          governance_policy_version, trust_manifest_sha256,
          trust_manifest_issued_at, observed_at
        ) REFERENCES omni_memory_informed_notice_approval_batches (
          approval_batch_id, batch_sha256, governance_policy_id,
          governance_policy_version, trust_manifest_sha256,
          trust_manifest_issued_at, observed_at
        ) ON UPDATE RESTRICT ON DELETE RESTRICT,
        CONSTRAINT omni_notice_review_attestations_actor_fkey
          FOREIGN KEY (reviewer_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `;

    await sql.query(`
      ALTER TABLE omni_memory_informed_notice_approval_batches
        ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_memory_informed_notice_approval_batches
        FORCE ROW LEVEL SECURITY;
      ALTER TABLE omni_memory_informed_notice_approval_contracts
        ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_memory_informed_notice_approval_contracts
        FORCE ROW LEVEL SECURITY;
      ALTER TABLE omni_memory_informed_notice_review_attestations
        ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_memory_informed_notice_review_attestations
        FORCE ROW LEVEL SECURITY
    `);

    await sql`
      CREATE POLICY omni_notice_approval_batches_holdback
      ON omni_memory_informed_notice_approval_batches
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled())
      WITH CHECK (omni_system_scope_enabled())
    `;
    await sql`
      CREATE POLICY omni_notice_approval_contracts_holdback
      ON omni_memory_informed_notice_approval_contracts
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled())
      WITH CHECK (omni_system_scope_enabled())
    `;
    await sql`
      CREATE POLICY omni_notice_review_attestations_holdback
      ON omni_memory_informed_notice_review_attestations
      AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (omni_system_scope_enabled())
      WITH CHECK (omni_system_scope_enabled())
    `;

    await sql`
      CREATE TRIGGER omni_notice_approval_batches_protect
      BEFORE UPDATE OR DELETE
      ON omni_memory_informed_notice_approval_batches
      FOR EACH ROW EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;
    await sql`
      CREATE TRIGGER omni_notice_approval_batches_no_truncate
      BEFORE TRUNCATE
      ON omni_memory_informed_notice_approval_batches
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;
    await sql`
      CREATE TRIGGER omni_notice_approval_contracts_protect
      BEFORE UPDATE OR DELETE
      ON omni_memory_informed_notice_approval_contracts
      FOR EACH ROW EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;
    await sql`
      CREATE TRIGGER omni_notice_approval_contracts_no_truncate
      BEFORE TRUNCATE
      ON omni_memory_informed_notice_approval_contracts
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;
    await sql`
      CREATE TRIGGER omni_notice_review_attestations_protect
      BEFORE UPDATE OR DELETE
      ON omni_memory_informed_notice_review_attestations
      FOR EACH ROW EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;
    await sql`
      CREATE TRIGGER omni_notice_review_attestations_no_truncate
      BEFORE TRUNCATE
      ON omni_memory_informed_notice_review_attestations
      FOR EACH STATEMENT EXECUTE FUNCTION omni_protect_notice_governance_evidence()
    `;

    await sql.query(`
      REVOKE ALL ON TABLE
        omni_memory_informed_notice_approval_batches,
        omni_memory_informed_notice_approval_contracts,
        omni_memory_informed_notice_review_attestations
      FROM PUBLIC;
      REVOKE ALL ON FUNCTION omni_notice_approval_batch_row_is_valid(
        SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, SMALLINT, TEXT,
        TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TIMESTAMPTZ
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION omni_notice_approval_contract_row_is_valid(
        SMALLINT, TEXT, TEXT, SMALLINT, SMALLINT, TEXT, TEXT, SMALLINT,
        TEXT, TEXT, TEXT
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION omni_notice_review_attestation_row_is_valid(
        SMALLINT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ,
        TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION omni_protect_notice_governance_evidence()
      FROM PUBLIC
    `);
  }

  // Remove any inherited or manually introduced privilege before the exact
  // postflight. A database-owner session remains the only installed reader.
  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
      relation_name TEXT;
      procedure_record RECORD;
    BEGIN
      FOR relation_name IN SELECT unnest(ARRAY[
        'omni_memory_informed_notice_approval_batches',
        'omni_memory_informed_notice_approval_contracts',
        'omni_memory_informed_notice_review_attestations'
      ]) LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee
          FROM information_schema.table_privileges
          WHERE table_schema = current_schema()
            AND table_name = relation_name
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'REVOKE ALL ON TABLE %I.%I FROM %I',
            current_schema(), relation_name, grant_record.grantee
          );
        END LOOP;
      END LOOP;

      FOR procedure_record IN
        SELECT procedure.oid::regprocedure::TEXT AS procedure_identity,
               procedure.proname
        FROM pg_proc procedure
        WHERE procedure.oid IN (
          to_regprocedure(
            'public.omni_notice_approval_batch_row_is_valid(smallint,text,text,text,bigint,text,text,smallint,text,text,bigint,text,timestamptz,timestamptz,text,timestamptz)'
          ),
          to_regprocedure(
            'public.omni_notice_approval_contract_row_is_valid(smallint,text,text,smallint,smallint,text,text,smallint,text,text,text)'
          ),
          to_regprocedure(
            'public.omni_notice_review_attestation_row_is_valid(smallint,text,text,text,bigint,text,timestamptz,timestamptz,text,text,text,timestamptz,text,text,text,text)'
          ),
          to_regprocedure(
            'public.omni_protect_notice_governance_evidence()'
          )
        )
      LOOP
        FOR grant_record IN
          SELECT DISTINCT grantee
          FROM information_schema.routine_privileges
          WHERE routine_schema = current_schema()
            AND routine_name = procedure_record.proname
            AND privilege_type = 'EXECUTE'
            AND grantee <> current_user
            AND grantee <> 'PUBLIC'
        LOOP
          EXECUTE format(
            'REVOKE ALL ON FUNCTION %s FROM %I',
            procedure_record.procedure_identity,
            grant_record.grantee
          );
        END LOOP;
      END LOOP;

    END
    $migration$
  `;

  await sql`
    LOCK TABLE
      omni_memory_informed_notice_approval_batches,
      omni_memory_informed_notice_approval_contracts,
      omni_memory_informed_notice_review_attestations
    IN SHARE MODE
  `;

  await sql`
    DO $migration$
    DECLARE
      owner_oid OID;
    BEGIN
      SELECT relowner INTO owner_oid
      FROM pg_class
      WHERE oid = 'omni_schema_version'::regclass;

      IF (
        SELECT count(*)
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid IN (
          'omni_memory_informed_notice_approval_batches'::regclass,
          'omni_memory_informed_notice_approval_contracts'::regclass,
          'omni_memory_informed_notice_review_attestations'::regclass
        )
          AND namespace.nspname = current_schema()
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = owner_oid
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
      ) <> 3 THEN
        RAISE EXCEPTION 'Informed notice governance evidence relations are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 16),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 11),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 16)
        ) expected(relation_oid, column_count)
        WHERE (
          SELECT count(*) FROM pg_attribute attribute
          WHERE attribute.attrelid = expected.relation_oid
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ) <> expected.column_count
      ) OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'schema_version', 'smallint'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'approval_batch_id', 'text'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'batch_sha256', 'text'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'notice_count', 'smallint'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'observed_at', 'timestamptz'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'recorded_at', 'timestamptz'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'notice_ordinal', 'smallint'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'notice_text', 'text'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'notice_sha256', 'text'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'review_slot', 'text'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'trust_manifest_issued_at', 'timestamptz'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'reviewed_at', 'timestamptz'::REGTYPE, TRUE),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'signature_base64url', 'text'::REGTYPE, TRUE)
        ) expected(relation_oid, column_name, type_oid, not_null)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = expected.relation_oid
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR attribute.attnotnull IS DISTINCT FROM expected.not_null
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'omni_notice_approval_batches_persistence_hold_check'),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'omni_notice_approval_contracts_persistence_hold_check'),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'omni_notice_review_attestations_persistence_hold_check')
        ) expected(relation_oid, constraint_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid = expected.relation_oid
            AND constraint_record.conname = expected.constraint_name
            AND constraint_record.contype = 'c'
            AND constraint_record.convalidated
            AND COALESCE(
              (to_jsonb(constraint_record) ->> 'conenforced')::BOOLEAN,
              TRUE
            )
            AND pg_get_expr(
              constraint_record.conbin, constraint_record.conrelid
            ) = 'false'
        )
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND conname = 'omni_notice_approval_batches_pkey'
          AND contype = 'p' AND convalidated
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_approval_contracts'::regclass
          AND conname = 'omni_notice_approval_contracts_pkey'
          AND contype = 'p' AND convalidated
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_review_attestations'::regclass
          AND conname = 'omni_notice_review_attestations_pkey'
          AND contype = 'p' AND convalidated
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*) FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure.proname IN (
            'omni_notice_approval_batch_row_is_valid',
            'omni_notice_approval_contract_row_is_valid',
            'omni_notice_review_attestation_row_is_valid',
            'omni_protect_notice_governance_evidence'
          )
          AND procedure.proowner = owner_oid
          AND NOT procedure.prosecdef
      ) <> 4 THEN
        RAISE EXCEPTION 'Informed notice governance evidence functions are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid IN (
          'omni_memory_informed_notice_approval_batches'::regclass,
          'omni_memory_informed_notice_approval_contracts'::regclass,
          'omni_memory_informed_notice_review_attestations'::regclass
        ) AND NOT tgisinternal
      ) <> 6 OR EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'omni_notice_approval_batches_protect'),
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'omni_notice_approval_batches_no_truncate'),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'omni_notice_approval_contracts_protect'),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'omni_notice_approval_contracts_no_truncate'),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'omni_notice_review_attestations_protect'),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'omni_notice_review_attestations_no_truncate')
        ) expected(relation_oid, trigger_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_trigger trigger_record
          WHERE trigger_record.tgrelid = expected.relation_oid
            AND trigger_record.tgname = expected.trigger_name
            AND NOT trigger_record.tgisinternal
            AND trigger_record.tgenabled = 'O'
            AND trigger_record.tgfoid = to_regprocedure(
              'public.omni_protect_notice_governance_evidence()'
            )
        )
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence triggers are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS, 'omni_notice_approval_batches_holdback'),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS, 'omni_notice_approval_contracts_holdback'),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS, 'omni_notice_review_attestations_holdback')
        ) expected(relation_oid, policy_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_policy policy_record
          WHERE policy_record.polrelid = expected.relation_oid
            AND policy_record.polname = expected.policy_name
            AND NOT policy_record.polpermissive
            AND policy_record.polcmd = '*'
            AND policy_record.polroles = ARRAY[0::OID]
            AND pg_get_expr(
              policy_record.polqual, policy_record.polrelid
            ) = 'omni_system_scope_enabled()'
            AND pg_get_expr(
              policy_record.polwithcheck, policy_record.polrelid
            ) = 'omni_system_scope_enabled()'
        )
      ) OR EXISTS (
        SELECT 1 FROM (
          VALUES
            ('omni_memory_informed_notice_approval_batches'::REGCLASS),
            ('omni_memory_informed_notice_approval_contracts'::REGCLASS),
            ('omni_memory_informed_notice_review_attestations'::REGCLASS)
        ) expected(relation_oid)
        WHERE (
          SELECT count(*) FROM pg_policy
          WHERE polrelid = expected.relation_oid
        ) <> 1
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence policies are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_memory_informed_notice_approval_batches',
            'omni_memory_informed_notice_approval_contracts',
            'omni_memory_informed_notice_review_attestations'
          )
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name IN (
            'omni_notice_approval_batch_row_is_valid',
            'omni_notice_approval_contract_row_is_valid',
            'omni_notice_review_attestation_row_is_valid',
            'omni_protect_notice_governance_evidence'
          )
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_batches
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_contracts
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_review_attestations
      ) THEN
        RAISE EXCEPTION 'Informed notice governance evidence shadows are not empty'
          USING ERRCODE = '55000';
      END IF;

      IF public.omni_notice_approval_contract_row_is_valid(
        1::smallint, 'notice-batch:v66'::text, repeat('a', 64)::text,
        0::smallint, 1::smallint, 'memory.export.v1'::text,
        'notice-contract:v66'::text, 1::smallint, 'en-US'::text,
        'Exact notice'::text, repeat('b', 64)::text
      ) IS DISTINCT FROM FALSE OR public.omni_notice_review_attestation_row_is_valid(
        1::smallint, 'notice-batch:v66'::text, repeat('a', 64)::text,
        'notice-policy:v1'::text, 1::bigint, repeat('c', 64)::text,
        statement_timestamp(), statement_timestamp(), 'legal_reviewer'::text,
        'review:v66'::text,
        'actor:00000000-0000-4000-8000-000000000001'::text,
        statement_timestamp() + INTERVAL '1 second',
        'notice-key:v66'::text, repeat('d', 64)::text, 'ed25519'::text,
        repeat('A', 86)::text
      ) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Informed notice governance evidence validators are invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  // A future writer migration must call this same verifier again immediately
  // before it changes any v55 hold. V66 itself changes none of those surfaces.
  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
}

export async function ensureMemoryInformedNoticeAnchorReviewEvidenceShadow(
  sql: SqlClient,
) {
  // V67 preserves the external human-independence review that authorizes use
  // of a trust-manifest anchor. It keeps every v55/v66 persistence and runtime
  // hold closed and cannot manufacture a review row on an empty table.
  await sql`
    DO $migration$
    BEGIN
      IF current_user IS DISTINCT FROM (
        SELECT pg_get_userbyid(relowner)
        FROM pg_class
        WHERE oid = 'omni_schema_version'::regclass
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review migration requires the schema owner'
          USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM omni_schema_version
        WHERE version = 66
          AND name = 'memory_informed_notice_governance_evidence_shadow'
          AND checksum =
            '8e845ac8182b025d6dea8014ec3877c141e55ad2dc551054b1a885e4bb680f6e'
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review requires exact migration v66'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
  await sql`SET LOCAL row_security = on`;
  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
  await sql`
    LOCK TABLE
      omni_auth_users,
      omni_memory_informed_notice_approval_batches,
      omni_memory_informed_notice_approval_contracts,
      omni_memory_informed_notice_review_attestations
    IN ACCESS EXCLUSIVE MODE
  `;

  const stateRows = await sql`
    SELECT
      count(*) FILTER (WHERE attribute.attname IN (
        'independence_review_id',
        'independence_reviewed_by_actor_id',
        'independence_reviewed_at',
        'human_independence_reviewed'
      ))::int AS installed_columns,
      to_regprocedure(
        'public.omni_notice_anchor_review_row_is_valid(text,text,timestamptz,timestamptz,timestamptz,boolean)'
      ) IS NOT NULL AS validator_exists
    FROM pg_attribute attribute
    WHERE attribute.attrelid =
        'omni_memory_informed_notice_approval_batches'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `;
  const state = stateRows[0];
  const installedColumns = Number(state?.installed_columns);
  const validatorExists = state?.validator_exists;
  if (
    !Number.isInteger(installedColumns) ||
    typeof validatorExists !== "boolean" ||
    ![0, 4].includes(installedColumns) ||
    validatorExists !== (installedColumns === 4)
  ) {
    throw new Error("Informed notice anchor review install is partial.");
  }

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_batches
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_contracts
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_review_attestations
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review upgrade requires empty v66 shadows'
          USING ERRCODE = '55000';
      END IF;
      IF (
        SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'omni_notice_approval_batches_persistence_hold_check',
          'omni_notice_approval_contracts_persistence_hold_check',
          'omni_notice_review_attestations_persistence_hold_check'
        ) AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) = 'false'
      ) <> 3 THEN
        RAISE EXCEPTION 'Informed notice anchor review v66 holds changed'
          USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_memory_informed_notice_approval_batches',
            'omni_memory_informed_notice_approval_contracts',
            'omni_memory_informed_notice_review_attestations'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review v66 boundary is exposed'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  if (installedColumns === 0) {
    await sql`
      CREATE FUNCTION omni_notice_anchor_review_row_is_valid(
        candidate_independence_review_id TEXT,
        candidate_independence_reviewed_by_actor_id TEXT,
        candidate_independence_reviewed_at TIMESTAMPTZ,
        candidate_trust_manifest_issued_at TIMESTAMPTZ,
        candidate_observed_at TIMESTAMPTZ,
        candidate_human_independence_reviewed BOOLEAN
      )
      RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $function$
        SELECT COALESCE(
          candidate_independence_review_id ~
            '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$'
          AND candidate_independence_reviewed_by_actor_id ~
            '^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND candidate_trust_manifest_issued_at <=
            candidate_independence_reviewed_at
          AND candidate_independence_reviewed_at <= candidate_observed_at
          AND candidate_human_independence_reviewed IS TRUE,
          FALSE
        )
      $function$
    `;
    await sql`
      ALTER TABLE omni_memory_informed_notice_approval_batches
        ADD COLUMN independence_review_id TEXT NOT NULL,
        ADD COLUMN independence_reviewed_by_actor_id TEXT NOT NULL,
        ADD COLUMN independence_reviewed_at TIMESTAMPTZ NOT NULL,
        ADD COLUMN human_independence_reviewed BOOLEAN NOT NULL,
        ADD CONSTRAINT omni_notice_approval_batches_independence_review_key
          UNIQUE (independence_review_id),
        ADD CONSTRAINT omni_notice_approval_batch_anchor_review_check CHECK (
          omni_notice_anchor_review_row_is_valid(
            independence_review_id,
            independence_reviewed_by_actor_id,
            independence_reviewed_at,
            trust_manifest_issued_at,
            observed_at,
            human_independence_reviewed
          )
        ),
        ADD CONSTRAINT omni_notice_approval_batch_independence_actor_fkey
          FOREIGN KEY (independence_reviewed_by_actor_id)
          REFERENCES omni_auth_users (actor_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
    `;
    await sql.query(`
      REVOKE ALL ON FUNCTION omni_notice_anchor_review_row_is_valid(
        TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
      ) FROM PUBLIC
    `);
  }

  await sql`
    DO $migration$
    DECLARE
      grant_record RECORD;
      procedure_identity TEXT;
    BEGIN
      SELECT procedure.oid::regprocedure::TEXT
      INTO procedure_identity
      FROM pg_proc procedure
      WHERE procedure.oid = to_regprocedure(
        'public.omni_notice_anchor_review_row_is_valid(text,text,timestamptz,timestamptz,timestamptz,boolean)'
      );

      FOR grant_record IN
        SELECT DISTINCT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_notice_anchor_review_row_is_valid'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
          AND grantee <> 'PUBLIC'
      LOOP
        EXECUTE format(
          'REVOKE ALL ON FUNCTION %s FROM %I',
          procedure_identity,
          grant_record.grantee
        );
      END LOOP;
    END
    $migration$
  `;

  await sql`
    DO $migration$
    DECLARE
      owner_oid OID;
    BEGIN
      SELECT relowner INTO owner_oid
      FROM pg_class
      WHERE oid = 'omni_schema_version'::regclass;

      IF NOT EXISTS (
        SELECT 1 FROM pg_class relation
        WHERE relation.oid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND relation.relowner = owner_oid
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity
      ) OR (
        SELECT count(*) FROM pg_attribute attribute
        WHERE attribute.attrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ) <> 20 OR EXISTS (
        SELECT 1 FROM (
          VALUES
            ('independence_review_id', 'text'::REGTYPE),
            ('independence_reviewed_by_actor_id', 'text'::REGTYPE),
            ('independence_reviewed_at', 'timestamptz'::REGTYPE),
            ('human_independence_reviewed', 'boolean'::REGTYPE)
        ) expected(column_name, type_oid)
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND attribute.attname = expected.column_name
          AND NOT attribute.attisdropped
        WHERE attribute.attname IS NULL
          OR attribute.atttypid <> expected.type_oid
          OR NOT attribute.attnotnull
          OR attribute.atthasdef
          OR attribute.attgenerated <> ''
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review columns are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_proc procedure
        JOIN pg_language language ON language.oid = procedure.prolang
        WHERE procedure.oid = to_regprocedure(
          'public.omni_notice_anchor_review_row_is_valid(text,text,timestamptz,timestamptz,timestamptz,boolean)'
        )
          AND procedure.prorettype = 'boolean'::regtype
          AND procedure.provolatile = 'i'
          AND NOT procedure.proisstrict
          AND NOT procedure.prosecdef
          AND procedure.proowner = owner_oid
          AND language.lanname = 'sql'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND conname = 'omni_notice_approval_batch_anchor_review_check'
          AND contype = 'c' AND convalidated
          AND pg_get_expr(conbin, conrelid) =
            'omni_notice_anchor_review_row_is_valid(independence_review_id, independence_reviewed_by_actor_id, independence_reviewed_at, trust_manifest_issued_at, observed_at, human_independence_reviewed)'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND conname =
            'omni_notice_approval_batches_independence_review_key'
          AND contype = 'u' AND convalidated
          AND conkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_memory_informed_notice_approval_batches'::regclass
                AND attname = 'independence_review_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid =
            'omni_memory_informed_notice_approval_batches'::regclass
          AND conname =
            'omni_notice_approval_batch_independence_actor_fkey'
          AND contype = 'f' AND convalidated
          AND confrelid = 'omni_auth_users'::regclass
          AND confupdtype = 'r' AND confdeltype = 'r'
          AND NOT condeferrable AND NOT condeferred
          AND conkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid =
                  'omni_memory_informed_notice_approval_batches'::regclass
                AND attname = 'independence_reviewed_by_actor_id'
                AND NOT attisdropped
            )
          ]::SMALLINT[]
          AND confkey = ARRAY[
            (
              SELECT attnum FROM pg_attribute
              WHERE attrelid = 'omni_auth_users'::regclass
                AND attname = 'actor_id' AND NOT attisdropped
            )
          ]::SMALLINT[]
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review constraints are invalid'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = current_schema()
          AND routine_name = 'omni_notice_anchor_review_row_is_valid'
          AND privilege_type = 'EXECUTE'
          AND grantee <> current_user
      ) OR EXISTS (
        SELECT 1 FROM information_schema.table_privileges
        WHERE table_schema = current_schema()
          AND table_name IN (
            'omni_memory_informed_notice_approval_batches',
            'omni_memory_informed_notice_approval_contracts',
            'omni_memory_informed_notice_review_attestations'
          ) AND grantee <> current_user
      ) THEN
        RAISE EXCEPTION 'Informed notice anchor review boundary is exposed'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_batches
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_approval_contracts
      ) OR EXISTS (
        SELECT 1 FROM omni_memory_informed_notice_review_attestations
      ) OR public.omni_notice_anchor_review_row_is_valid(
        'review:v67'::text,
        'actor:00000000-0000-4000-8000-000000000001'::text,
        statement_timestamp() + INTERVAL '1 second',
        statement_timestamp(), statement_timestamp(), TRUE
      ) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Informed notice anchor review hold is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;

  await verifyMemoryInformedNoticeAuthorityBoundary(sql);
}
