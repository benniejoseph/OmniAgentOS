BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 186 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 186
      AND name = 'declarative_plugins_v1'
      AND checksum = '0cb2bc195736819e3fd5c3a6ab44a8c48ca3dcc55b63d097a69aaf9824b06825'
  ) <> 1 THEN
    RAISE EXCEPTION 'Built-in Skill catalog predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

  DO $migration$
  BEGIN
    IF current_user IS DISTINCT FROM (
      SELECT pg_get_userbyid(relowner)
      FROM pg_class
      WHERE oid = 'omni_schema_version'::regclass
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog migration requires the schema owner'
        USING ERRCODE = '42501';
    END IF;
  END
  $migration$;

  LOCK TABLE omni_custom_agents, omni_custom_skills
  IN SHARE ROW EXCLUSIVE MODE;

  DO $migration$
  DECLARE
    built_in_skill_ids CONSTANT TEXT[] := ARRAY[
      'core.research',
      'core.builder',
      'core.critic',
      'core.memory',
      'productivity.daily-focus',
      'productivity.project-planning',
      'productivity.meeting-steward',
      'productivity.decision-memo',
      'design.product-ux',
      'design.systems-accessibility',
      'design.visual-critique',
      'engineering.implementation',
      'engineering.debugging',
      'engineering.review-security',
      'engineering.quality-performance',
      'communication.clear-writing',
      'automation.workflow-design',
      'learning.knowledge-synthesis'
    ];
    validator_body TEXT;
    protector_body TEXT;
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM omni_custom_skills custom_skill
      WHERE custom_skill.id IS NULL
        OR custom_skill.id IS DISTINCT FROM btrim(custom_skill.id)
        OR char_length(custom_skill.id) NOT BETWEEN 1 AND 120
        OR custom_skill.id COLLATE "C" = ANY (built_in_skill_ids)
    ) THEN
      RAISE EXCEPTION 'Existing custom Skill identifiers are malformed or reserved by the built-in catalog'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM omni_custom_agents agent
      WHERE agent.skill_ids IS NULL
        OR cardinality(agent.skill_ids) > 8
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          WHERE NOT (
            referenced.skill_id COLLATE "C" = ANY (built_in_skill_ids)
          )
            AND NOT EXISTS (
              SELECT 1
              FROM omni_custom_skills custom_skill
              WHERE custom_skill.id COLLATE "C" =
                  referenced.skill_id COLLATE "C"
                AND custom_skill.tenant_id COLLATE "C" =
                  agent.tenant_id COLLATE "C"
                AND custom_skill.actor_id COLLATE "C" =
                  agent.actor_id COLLATE "C"
            )
        )
    ) THEN
      RAISE EXCEPTION 'Existing custom Agent Skill references are invalid for the built-in catalog or eight-Skill limit'
        USING ERRCODE = '55000';
    END IF;

    IF (
      SELECT count(*)
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid IN (
          'omni_custom_agents'::regclass,
          'omni_custom_skills'::regclass
        )
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgname IN (
          'omni_custom_agents_validate_skill_references',
          'omni_custom_skills_protect_reference_identity',
          'omni_custom_skills_no_truncate'
        )
    ) <> 3 OR EXISTS (
      SELECT 1
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid IN (
          'omni_custom_agents'::regclass,
          'omni_custom_skills'::regclass
        )
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgname NOT IN (
          'omni_custom_agents_validate_skill_references',
          'omni_custom_skills_protect_reference_identity',
          'omni_custom_skills_no_truncate'
        )
    ) THEN
      RAISE EXCEPTION 'Custom Agent or Skill trigger boundary changed before catalog installation'
        USING ERRCODE = '55000';
    END IF;

    validator_body := format($body$
    DECLARE
      referenced_skill_id TEXT;
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_agents'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Agent Skill validator has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.skill_ids IS NULL
        OR cardinality(NEW.skill_ids) > 8
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
      THEN
        RAISE EXCEPTION 'Custom agent skill references are invalid'
          USING ERRCODE = '23514',
            SCHEMA = 'public',
            TABLE = 'omni_custom_agents',
            COLUMN = 'skill_ids',
            CONSTRAINT = 'omni_custom_agents_skill_references_valid';
      END IF;

      FOR referenced_skill_id IN
        SELECT referenced.skill_id COLLATE "C"
        FROM unnest(NEW.skill_ids) referenced(skill_id)
        WHERE NOT (
          referenced.skill_id COLLATE "C" = ANY (%L::TEXT[])
        )
        GROUP BY referenced.skill_id COLLATE "C"
        ORDER BY referenced.skill_id COLLATE "C"
      LOOP
        PERFORM 1
        FROM public.omni_custom_skills custom_skill
        WHERE custom_skill.id COLLATE "C" =
            referenced_skill_id COLLATE "C"
          AND custom_skill.tenant_id COLLATE "C" =
            NEW.tenant_id COLLATE "C"
          AND custom_skill.actor_id COLLATE "C" =
            NEW.actor_id COLLATE "C"
        FOR KEY SHARE OF custom_skill;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Custom agent skill references are invalid'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_agents',
              COLUMN = 'skill_ids',
              CONSTRAINT = 'omni_custom_agents_skill_references_valid';
        END IF;
      END LOOP;

      RETURN NEW;
    END
    $body$, built_in_skill_ids);

    protector_body := format($body$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill reference guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.id IS NULL
          OR NEW.id IS DISTINCT FROM btrim(NEW.id)
          OR char_length(NEW.id) NOT BETWEEN 1 AND 120
          OR NEW.id COLLATE "C" = ANY (%L::TEXT[])
        THEN
          RAISE EXCEPTION 'Custom skill identifier is invalid or reserved'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              COLUMN = 'id',
              CONSTRAINT = 'omni_custom_skills_id_valid';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id COLLATE "C" IS DISTINCT FROM OLD.id COLLATE "C"
          OR NEW.tenant_id COLLATE "C" IS DISTINCT FROM
            OLD.tenant_id COLLATE "C"
          OR NEW.actor_id COLLATE "C" IS DISTINCT FROM
            OLD.actor_id COLLATE "C"
        THEN
          RAISE EXCEPTION 'Custom skill reference identity is immutable'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              CONSTRAINT = 'omni_custom_skills_reference_identity_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF current_setting('transaction_isolation') IS DISTINCT FROM
          'read committed'
      THEN
        RAISE EXCEPTION 'Custom skill deletion requires read committed isolation'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_custom_agents agent
        WHERE agent.tenant_id COLLATE "C" = OLD.tenant_id COLLATE "C"
          AND agent.actor_id COLLATE "C" = OLD.actor_id COLLATE "C"
          AND EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id COLLATE "C" = OLD.id COLLATE "C"
          )
      ) THEN
        RAISE EXCEPTION 'Custom skill is still referenced by an agent'
          USING ERRCODE = '23503',
            SCHEMA = 'public',
            TABLE = 'omni_custom_skills',
            CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
      END IF;

      RETURN OLD;
    END
    $body$, built_in_skill_ids);

    EXECUTE format($ddl$
      CREATE OR REPLACE FUNCTION public.omni_validate_custom_agent_skill_references()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      VOLATILE
      STRICT
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS %L
    $ddl$, validator_body);
    EXECUTE format($ddl$
      CREATE OR REPLACE FUNCTION public.omni_protect_custom_skill_reference_identity()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      VOLATILE
      STRICT
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS %L
    $ddl$, protector_body);

    DROP TRIGGER omni_custom_agents_validate_skill_references
      ON omni_custom_agents;
    CREATE TRIGGER omni_custom_agents_validate_skill_references
      BEFORE INSERT OR UPDATE OF tenant_id, actor_id, skill_ids
      ON omni_custom_agents
      FOR EACH ROW
      EXECUTE FUNCTION omni_validate_custom_agent_skill_references();

    DROP TRIGGER omni_custom_skills_protect_reference_identity
      ON omni_custom_skills;
    CREATE TRIGGER omni_custom_skills_protect_reference_identity
      BEFORE INSERT OR UPDATE OF id, tenant_id, actor_id OR DELETE
      ON omni_custom_skills
      FOR EACH ROW
      EXECUTE FUNCTION omni_protect_custom_skill_reference_identity();
  END
  $migration$;

  REVOKE ALL ON FUNCTION omni_validate_custom_agent_skill_references()
    FROM PUBLIC;
  REVOKE ALL ON FUNCTION omni_protect_custom_skill_reference_identity()
    FROM PUBLIC;
  REVOKE TRIGGER ON TABLE omni_custom_agents FROM PUBLIC;
  REVOKE TRIGGER, TRUNCATE ON TABLE omni_custom_skills FROM PUBLIC;

  DO $migration$
  DECLARE
    grant_record RECORD;
  BEGIN
    FOR grant_record IN
      SELECT DISTINCT grantee
      FROM information_schema.routine_privileges
      WHERE routine_schema = current_schema()
        AND routine_name IN (
          'omni_validate_custom_agent_skill_references',
          'omni_protect_custom_skill_reference_identity'
        )
        AND privilege_type = 'EXECUTE'
        AND grantee <> current_user
        AND grantee <> 'PUBLIC'
    LOOP
      EXECUTE format(
        'REVOKE ALL ON FUNCTION ' ||
        '%I.omni_validate_custom_agent_skill_references() FROM %I',
        current_schema(),
        grant_record.grantee
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION ' ||
        '%I.omni_protect_custom_skill_reference_identity() FROM %I',
        current_schema(),
        grant_record.grantee
      );
    END LOOP;

    FOR grant_record IN
      SELECT DISTINCT grantee
      FROM information_schema.table_privileges
      WHERE table_schema = current_schema()
        AND (
          (table_name = 'omni_custom_agents' AND privilege_type = 'TRIGGER')
          OR (
            table_name = 'omni_custom_skills'
            AND privilege_type IN ('TRIGGER', 'TRUNCATE')
          )
        )
        AND grantee <> current_user
        AND grantee <> 'PUBLIC'
    LOOP
      EXECUTE format(
        'REVOKE TRIGGER ON TABLE %I.omni_custom_agents FROM %I',
        current_schema(),
        grant_record.grantee
      );
      EXECUTE format(
        'REVOKE TRIGGER, TRUNCATE ON TABLE %I.omni_custom_skills FROM %I',
        current_schema(),
        grant_record.grantee
      );
    END LOOP;
  END
  $migration$;

  DO $verify$
  DECLARE
    built_in_skill_ids CONSTANT TEXT[] := ARRAY[
      'core.research',
      'core.builder',
      'core.critic',
      'core.memory',
      'productivity.daily-focus',
      'productivity.project-planning',
      'productivity.meeting-steward',
      'productivity.decision-memo',
      'design.product-ux',
      'design.systems-accessibility',
      'design.visual-critique',
      'engineering.implementation',
      'engineering.debugging',
      'engineering.review-security',
      'engineering.quality-performance',
      'communication.clear-writing',
      'automation.workflow-design',
      'learning.knowledge-synthesis'
    ];
    expected_validator_body TEXT;
    expected_protector_body TEXT;
  BEGIN
    expected_validator_body := format($body$
    DECLARE
      referenced_skill_id TEXT;
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_agents'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Agent Skill validator has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.skill_ids IS NULL
        OR cardinality(NEW.skill_ids) > 8
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(NEW.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
      THEN
        RAISE EXCEPTION 'Custom agent skill references are invalid'
          USING ERRCODE = '23514',
            SCHEMA = 'public',
            TABLE = 'omni_custom_agents',
            COLUMN = 'skill_ids',
            CONSTRAINT = 'omni_custom_agents_skill_references_valid';
      END IF;

      FOR referenced_skill_id IN
        SELECT referenced.skill_id COLLATE "C"
        FROM unnest(NEW.skill_ids) referenced(skill_id)
        WHERE NOT (
          referenced.skill_id COLLATE "C" = ANY (%L::TEXT[])
        )
        GROUP BY referenced.skill_id COLLATE "C"
        ORDER BY referenced.skill_id COLLATE "C"
      LOOP
        PERFORM 1
        FROM public.omni_custom_skills custom_skill
        WHERE custom_skill.id COLLATE "C" =
            referenced_skill_id COLLATE "C"
          AND custom_skill.tenant_id COLLATE "C" =
            NEW.tenant_id COLLATE "C"
          AND custom_skill.actor_id COLLATE "C" =
            NEW.actor_id COLLATE "C"
        FOR KEY SHARE OF custom_skill;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Custom agent skill references are invalid'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_agents',
              COLUMN = 'skill_ids',
              CONSTRAINT = 'omni_custom_agents_skill_references_valid';
        END IF;
      END LOOP;

      RETURN NEW;
    END
    $body$, built_in_skill_ids);

    expected_protector_body := format($body$
    BEGIN
      IF TG_RELID IS DISTINCT FROM 'public.omni_custom_skills'::regclass
        OR TG_WHEN IS DISTINCT FROM 'BEFORE'
        OR TG_LEVEL IS DISTINCT FROM 'ROW'
        OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
        OR TG_NARGS <> 0
      THEN
        RAISE EXCEPTION 'Custom Skill reference guard has an invalid trigger context'
          USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.id IS NULL
          OR NEW.id IS DISTINCT FROM btrim(NEW.id)
          OR char_length(NEW.id) NOT BETWEEN 1 AND 120
          OR NEW.id COLLATE "C" = ANY (%L::TEXT[])
        THEN
          RAISE EXCEPTION 'Custom skill identifier is invalid or reserved'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              COLUMN = 'id',
              CONSTRAINT = 'omni_custom_skills_id_valid';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id COLLATE "C" IS DISTINCT FROM OLD.id COLLATE "C"
          OR NEW.tenant_id COLLATE "C" IS DISTINCT FROM
            OLD.tenant_id COLLATE "C"
          OR NEW.actor_id COLLATE "C" IS DISTINCT FROM
            OLD.actor_id COLLATE "C"
        THEN
          RAISE EXCEPTION 'Custom skill reference identity is immutable'
            USING ERRCODE = '23514',
              SCHEMA = 'public',
              TABLE = 'omni_custom_skills',
              CONSTRAINT = 'omni_custom_skills_reference_identity_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF current_setting('transaction_isolation') IS DISTINCT FROM
          'read committed'
      THEN
        RAISE EXCEPTION 'Custom skill deletion requires read committed isolation'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.omni_custom_agents agent
        WHERE agent.tenant_id COLLATE "C" = OLD.tenant_id COLLATE "C"
          AND agent.actor_id COLLATE "C" = OLD.actor_id COLLATE "C"
          AND EXISTS (
            SELECT 1
            FROM unnest(agent.skill_ids) referenced(skill_id)
            WHERE referenced.skill_id COLLATE "C" = OLD.id COLLATE "C"
          )
      ) THEN
        RAISE EXCEPTION 'Custom skill is still referenced by an agent'
          USING ERRCODE = '23503',
            SCHEMA = 'public',
            TABLE = 'omni_custom_skills',
            CONSTRAINT = 'omni_custom_agents_skill_references_fkey';
      END IF;

      RETURN OLD;
    END
    $body$, built_in_skill_ids);

    IF EXISTS (
      SELECT 1
      FROM omni_custom_skills custom_skill
      WHERE custom_skill.id IS NULL
        OR custom_skill.id IS DISTINCT FROM btrim(custom_skill.id)
        OR char_length(custom_skill.id) NOT BETWEEN 1 AND 120
        OR custom_skill.id COLLATE "C" = ANY (built_in_skill_ids)
    ) OR EXISTS (
      SELECT 1
      FROM omni_custom_agents agent
      WHERE agent.skill_ids IS NULL
        OR cardinality(agent.skill_ids) > 8
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          WHERE referenced.skill_id IS NULL
            OR referenced.skill_id IS DISTINCT FROM btrim(referenced.skill_id)
            OR char_length(referenced.skill_id) NOT BETWEEN 1 AND 120
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          GROUP BY referenced.skill_id COLLATE "C"
          HAVING count(*) > 1
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(agent.skill_ids) referenced(skill_id)
          WHERE NOT (
            referenced.skill_id COLLATE "C" = ANY (built_in_skill_ids)
          )
            AND NOT EXISTS (
              SELECT 1
              FROM omni_custom_skills custom_skill
              WHERE custom_skill.id COLLATE "C" =
                  referenced.skill_id COLLATE "C"
                AND custom_skill.tenant_id COLLATE "C" =
                  agent.tenant_id COLLATE "C"
                AND custom_skill.actor_id COLLATE "C" =
                  agent.actor_id COLLATE "C"
            )
        )
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog row integrity changed during migration'
        USING ERRCODE = '55000';
    END IF;

    IF (
      SELECT count(*)
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema()
        AND procedure.proname IN (
          'omni_validate_custom_agent_skill_references',
          'omni_protect_custom_skill_reference_identity'
        )
    ) <> 2 OR EXISTS (
      SELECT 1
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema()
        AND procedure.proname IN (
          'omni_validate_custom_agent_skill_references',
          'omni_protect_custom_skill_reference_identity'
        )
        AND procedure.oid NOT IN (
          to_regprocedure('public.omni_validate_custom_agent_skill_references()'),
          to_regprocedure('public.omni_protect_custom_skill_reference_identity()')
        )
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog trigger functions are overloaded'
        USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc procedure
      JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = to_regprocedure(
          'public.omni_validate_custom_agent_skill_references()'
        )
        AND procedure.prokind = 'f'
        AND NOT procedure.proretset
        AND procedure.proparallel = 'u'
        AND procedure.pronargdefaults = 0
        AND procedure.provariadic = 0::OID
        AND procedure.prorettype = 'trigger'::regtype
        AND procedure.provolatile = 'v'
        AND procedure.proisstrict
        AND NOT procedure.prosecdef
        AND NOT procedure.proleakproof
        AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']
        AND procedure.proowner = (
          SELECT relowner
          FROM pg_class
          WHERE oid = 'omni_schema_version'::regclass
        )
        AND language.lanname = 'plpgsql'
        AND procedure.prosrc = expected_validator_body
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_proc procedure
      JOIN pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid = to_regprocedure(
          'public.omni_protect_custom_skill_reference_identity()'
        )
        AND procedure.prokind = 'f'
        AND NOT procedure.proretset
        AND procedure.proparallel = 'u'
        AND procedure.pronargdefaults = 0
        AND procedure.provariadic = 0::OID
        AND procedure.prorettype = 'trigger'::regtype
        AND procedure.provolatile = 'v'
        AND procedure.proisstrict
        AND NOT procedure.prosecdef
        AND NOT procedure.proleakproof
        AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']
        AND procedure.proowner = (
          SELECT relowner
          FROM pg_class
          WHERE oid = 'omni_schema_version'::regclass
        )
        AND language.lanname = 'plpgsql'
        AND procedure.prosrc = expected_protector_body
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog trigger functions are invalid'
        USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid = 'omni_custom_agents'::regclass
        AND trigger_record.tgname =
          'omni_custom_agents_validate_skill_references'
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgenabled = 'O'
        AND trigger_record.tgfoid = to_regprocedure(
          'public.omni_validate_custom_agent_skill_references()'
        )
        AND trigger_record.tgtype = 23
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
          SELECT string_agg(attribute.attnum::TEXT, ' ' ORDER BY attribute.attnum)
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'omni_custom_agents'::regclass
            AND attribute.attname IN ('tenant_id', 'actor_id', 'skill_ids')
            AND NOT attribute.attisdropped
        )
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid = 'omni_custom_skills'::regclass
        AND trigger_record.tgname =
          'omni_custom_skills_protect_reference_identity'
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgenabled = 'O'
        AND trigger_record.tgfoid = to_regprocedure(
          'public.omni_protect_custom_skill_reference_identity()'
        )
        AND trigger_record.tgtype = 31
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
          SELECT string_agg(attribute.attnum::TEXT, ' ' ORDER BY attribute.attnum)
          FROM pg_attribute attribute
          WHERE attribute.attrelid = 'omni_custom_skills'::regclass
            AND attribute.attname IN ('id', 'tenant_id', 'actor_id')
            AND NOT attribute.attisdropped
        )
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid = 'omni_custom_skills'::regclass
        AND trigger_record.tgname = 'omni_custom_skills_no_truncate'
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgenabled = 'O'
        AND trigger_record.tgfoid = to_regprocedure(
          'public.omni_reject_custom_skills_truncate()'
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
    ) OR (
      SELECT count(*)
      FROM pg_trigger trigger_record
      WHERE trigger_record.tgrelid IN (
          'omni_custom_agents'::regclass,
          'omni_custom_skills'::regclass
        )
        AND NOT trigger_record.tgisinternal
    ) <> 3 THEN
      RAISE EXCEPTION 'Built-in Skill catalog triggers are invalid'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM (
        VALUES
          (to_regprocedure(
            'public.omni_validate_custom_agent_skill_references()'
          )),
          (to_regprocedure(
            'public.omni_protect_custom_skill_reference_identity()'
          )),
          (to_regprocedure('public.omni_reject_custom_skills_truncate()'))
      ) expected(procedure_oid)
      JOIN pg_proc procedure ON procedure.oid = expected.procedure_oid
      CROSS JOIN LATERAL aclexplode(
        COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) privilege
      WHERE privilege.grantee <> procedure.proowner
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog functions have serving grants'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.table_privileges
      WHERE table_schema = current_schema()
        AND (
          (table_name = 'omni_custom_agents' AND privilege_type = 'TRIGGER')
          OR (
            table_name = 'omni_custom_skills'
            AND privilege_type IN ('TRIGGER', 'TRUNCATE')
          )
        )
        AND grantee <> current_user
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog tables retain unsafe serving grants'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_class relation
      WHERE relation.oid IN (
          'omni_custom_agents'::regclass,
          'omni_custom_skills'::regclass
        )
        AND (
          relation.relkind IS DISTINCT FROM 'r'
          OR relation.relpersistence IS DISTINCT FROM 'p'
          OR NOT relation.relrowsecurity
          OR NOT relation.relforcerowsecurity
          OR relation.relowner IS DISTINCT FROM (
            SELECT relowner
            FROM pg_class
            WHERE oid = 'omni_schema_version'::regclass
          )
        )
    ) OR (
      SELECT count(*)
      FROM pg_policy policy
      WHERE policy.polrelid IN (
          'omni_custom_agents'::regclass,
          'omni_custom_skills'::regclass
        )
        AND policy.polname = 'omni_tenant_isolation'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[0::OID]
        AND pg_get_expr(policy.polqual, policy.polrelid) =
          'omni_tenant_visible(tenant_id)'
        AND pg_get_expr(policy.polwithcheck, policy.polrelid) =
          'omni_tenant_visible(tenant_id)'
    ) <> 2 THEN
      RAISE EXCEPTION 'Built-in Skill catalog actor and RLS boundary is invalid'
        USING ERRCODE = '55000';
    END IF;
  END
  $verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  187,
  'builtin_skill_catalog_v2',
  'fe690251c625bd3a55932b5a58c26509df6bc283cb24a1dd7c6373a1ce0a3a9c',
  clock_timestamp()
);

COMMIT;

