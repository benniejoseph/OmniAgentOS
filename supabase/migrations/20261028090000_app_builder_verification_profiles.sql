BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version FROM public.omni_schema_version WHERE version IS NOT NULL;
  IF latest_version IS DISTINCT FROM 265 OR (
    SELECT count(*) FROM public.omni_schema_version
    WHERE version = 265 AND name = 'self_improvement_cycle_budget_v1'
      AND checksum = '19c27ea1a0b1b1151502c16fc83537e4a904bf29acd0a098b5a811812f62d752'
  ) <> 1 THEN
    RAISE EXCEPTION 'App Builder verification profiles predecessor is invalid' USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Keep historical verification rows unchanged. The replacement enforces only
-- the two new ordered profiles emitted by the maintained service on new writes.
-- The existing two-check branch retains its original length-only semantics.
-- All identity, evidence-size and time predicates remain in the same check;
-- foreign keys, indexes, triggers, RLS policies and grants are untouched.
ALTER TABLE public.omni_app_builder_verifications
  DROP CONSTRAINT omni_app_builder_verifications_row_check;
ALTER TABLE public.omni_app_builder_verifications
  ADD CONSTRAINT omni_app_builder_verifications_row_check CHECK (COALESCE(
    schema_version = 1
    AND id ~ '^app_build_verification_[a-f0-9]{48}$'
    AND btrim(tenant_id) <> '' AND btrim(owner_actor_id) <> ''
    AND char_length(project_id) BETWEEN 1 AND 200
    AND session_id ~ '^app_build_[a-f0-9]{48}$'
    AND checkpoint_id ~ '^app_build_checkpoint_[a-f0-9]{48}$'
    AND contract_version = 'app-builder-verification:1'
    AND workspace_sha256 ~ '^[a-f0-9]{64}$'
    AND status IN ('passed', 'failed', 'incomplete')
    AND CASE WHEN jsonb_typeof(checks) = 'array' THEN (
      (
        jsonb_array_length(checks) = 2
      ) OR (
        jsonb_array_length(checks) = 4
        AND checks->0->>'command' = 'lint_focused' AND NOT (checks->0 ? 'purpose')
        AND checks->1->>'command' = 'typecheck_direct' AND NOT (checks->1 ? 'purpose')
        AND checks->2->>'command' = 'test_focused' AND checks->2->>'purpose' = 'regression'
        AND checks->3->>'command' = 'test_focused' AND checks->3->>'purpose' = 'adjacent'
      ) OR (
        jsonb_array_length(checks) = 4
        AND checks->0->>'command' = 'macos_analyze' AND NOT (checks->0 ? 'purpose')
        AND checks->1->>'command' = 'macos_test_focused' AND checks->1->>'purpose' = 'regression'
        AND checks->2->>'command' = 'macos_test_focused' AND checks->2->>'purpose' = 'adjacent'
        AND checks->3->>'command' = 'macos_build' AND NOT (checks->3 ? 'purpose')
      )
    ) ELSE FALSE END
    AND pg_column_size(checks) <= 16384
    AND jsonb_typeof(browser_evidence) = 'object' AND pg_column_size(browser_evidence) <= 16384
    AND created_at <= NOW() + INTERVAL '30 seconds'
  , FALSE));

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (266, 'app_builder_verification_profiles_v1', '8ca15ecea9c2292360b110e3f484025a8021a64c1c61890237969b4b7175c313', clock_timestamp());

COMMIT;
