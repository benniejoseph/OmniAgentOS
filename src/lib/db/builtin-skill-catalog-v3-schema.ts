import {
  BUILTIN_SKILL_ASSIGNMENT_LIMIT_V2,
  BUILTIN_SKILL_CATALOG_V2_IDS,
} from "@/lib/db/builtin-skill-catalog-schema";

type MigrationSql = Readonly<{
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
}>;

/** Immutable catalog snapshot owned by ordered migration v188. */
export const BUILTIN_SKILL_CATALOG_V3_IDS = Object.freeze([
  ...BUILTIN_SKILL_CATALOG_V2_IDS,
  "creation.document-studio",
] as const);

export const BUILTIN_SKILL_ASSIGNMENT_LIMIT_V3 =
  BUILTIN_SKILL_ASSIGNMENT_LIMIT_V2;

const previousSkillSqlArray = BUILTIN_SKILL_CATALOG_V2_IDS
  .map((id) => `      '${id}'`)
  .join(",\n");
const builtInSkillSqlArray = BUILTIN_SKILL_CATALOG_V3_IDS
  .map((id) => `      '${id}'`)
  .join(",\n");

/**
 * Advance the database reference guard without mutating the immutable v187
 * migration. The existing, exactly verified trigger bodies are transformed by
 * replacing their one frozen v2 allowlist literal, then verified again under
 * the same ownership, RLS, trigger, and eight-Skill boundaries.
 */
export const BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL = String.raw`
  LOCK TABLE omni_custom_agents, omni_custom_skills
  IN SHARE ROW EXCLUSIVE MODE;

  DO $migration$
  DECLARE
    previous_skill_ids CONSTANT TEXT[] := ARRAY[
${previousSkillSqlArray}
    ];
    built_in_skill_ids CONSTANT TEXT[] := ARRAY[
${builtInSkillSqlArray}
    ];
    old_literal TEXT;
    new_literal TEXT;
    validator_body TEXT;
    protector_body TEXT;
  BEGIN
    IF current_user IS DISTINCT FROM (
      SELECT pg_get_userbyid(relowner)
      FROM pg_class
      WHERE oid = 'omni_schema_version'::regclass
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog migration requires the schema owner'
        USING ERRCODE = '42501';
    END IF;

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
        OR cardinality(agent.skill_ids) > ${BUILTIN_SKILL_ASSIGNMENT_LIMIT_V3}
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

    SELECT procedure.prosrc INTO STRICT validator_body
    FROM pg_proc procedure
    WHERE procedure.oid =
      'public.omni_validate_custom_agent_skill_references()'::regprocedure;
    SELECT procedure.prosrc INTO STRICT protector_body
    FROM pg_proc procedure
    WHERE procedure.oid =
      'public.omni_protect_custom_skill_reference_identity()'::regprocedure;

    old_literal := quote_literal(previous_skill_ids::TEXT) || '::TEXT[]';
    new_literal := quote_literal(built_in_skill_ids::TEXT) || '::TEXT[]';
    IF (
      length(validator_body) - length(replace(validator_body, old_literal, ''))
    ) / length(old_literal) <> 1 OR (
      length(protector_body) - length(replace(protector_body, old_literal, ''))
    ) / length(old_literal) <> 1 THEN
      RAISE EXCEPTION 'Built-in Skill catalog v2 guard body changed before v3'
        USING ERRCODE = '55000';
    END IF;

    validator_body := replace(validator_body, old_literal, new_literal);
    protector_body := replace(protector_body, old_literal, new_literal);

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

    REVOKE ALL ON FUNCTION
      public.omni_validate_custom_agent_skill_references() FROM PUBLIC;
    REVOKE ALL ON FUNCTION
      public.omni_protect_custom_skill_reference_identity() FROM PUBLIC;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc procedure
      WHERE procedure.oid =
          'public.omni_validate_custom_agent_skill_references()'::regprocedure
        AND procedure.prosrc = validator_body
        AND procedure.prorettype = 'trigger'::regtype
        AND procedure.provolatile = 'v'
        AND procedure.proisstrict
        AND NOT procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_proc procedure
      WHERE procedure.oid =
          'public.omni_protect_custom_skill_reference_identity()'::regprocedure
        AND procedure.prosrc = protector_body
        AND procedure.prorettype = 'trigger'::regtype
        AND procedure.provolatile = 'v'
        AND procedure.proisstrict
        AND NOT procedure.prosecdef
        AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']
    ) OR (
      SELECT count(*)
      FROM pg_trigger trigger_record
      WHERE NOT trigger_record.tgisinternal
        AND (
          (
            trigger_record.tgrelid = 'omni_custom_agents'::regclass
            AND trigger_record.tgname =
              'omni_custom_agents_validate_skill_references'
            AND trigger_record.tgtype = 23
            AND trigger_record.tgfoid =
              'public.omni_validate_custom_agent_skill_references()'::regprocedure
          ) OR (
            trigger_record.tgrelid = 'omni_custom_skills'::regclass
            AND trigger_record.tgname =
              'omni_custom_skills_protect_reference_identity'
            AND trigger_record.tgtype = 31
            AND trigger_record.tgfoid =
              'public.omni_protect_custom_skill_reference_identity()'::regprocedure
          ) OR (
            trigger_record.tgrelid = 'omni_custom_skills'::regclass
            AND trigger_record.tgname = 'omni_custom_skills_no_truncate'
            AND trigger_record.tgtype = 34
            AND trigger_record.tgfoid =
              'public.omni_reject_custom_skills_truncate()'::regprocedure
          )
        )
    ) <> 3 OR EXISTS (
      SELECT 1
      FROM pg_proc procedure
      CROSS JOIN LATERAL aclexplode(COALESCE(
        procedure.proacl,
        acldefault('f', procedure.proowner)
      )) privilege
      WHERE procedure.oid IN (
        'public.omni_validate_custom_agent_skill_references()'::regprocedure,
        'public.omni_protect_custom_skill_reference_identity()'::regprocedure
      )
        AND privilege.grantee <> procedure.proowner
        AND privilege.privilege_type = 'EXECUTE'
    ) OR EXISTS (
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
        )
    ) THEN
      RAISE EXCEPTION 'Built-in Skill catalog v3 guard verification failed'
        USING ERRCODE = '55000';
    END IF;
  END
  $migration$;
`;

export async function ensureBuiltinSkillCatalogV3(sql: MigrationSql) {
  await sql.query(BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL);
}
