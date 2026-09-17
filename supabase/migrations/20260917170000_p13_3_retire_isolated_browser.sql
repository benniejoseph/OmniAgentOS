BEGIN;

SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('statement_timeout', '600000', true);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);

DO $migration$
DECLARE latest_version INTEGER;
BEGIN
  SELECT MAX(version) INTO latest_version
  FROM public.omni_schema_version
  WHERE version IS NOT NULL;

  IF latest_version IS DISTINCT FROM 180 OR (
    SELECT count(*)
    FROM public.omni_schema_version
    WHERE version = 180
      AND name = 'p13_3_local_computer_run_binding_v1'
      AND checksum = 'ff0d067e14965b75e45532f9ee534480fd237ef514c735282652d36a779000b4'
  ) <> 1 THEN
    RAISE EXCEPTION 'Isolated browser retirement predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

-- Retain profile and takeover rows as read-only audit history. Do not delete
-- user browsing records or silently transfer their authority to This Mac.
UPDATE public.omni_browser_takeovers
SET state = 'revoked',
    released_at = clock_timestamp()
WHERE state = 'active';

UPDATE public.omni_browser_profiles
SET state = 'revoked',
    lifecycle_revision = lifecycle_revision + 1,
    revoked_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE state = 'active';

-- Disable installed remote-browser connectors before scrubbing their sealed
-- credentials. Keep redacted connector/tool rows so historical executions can
-- still name the integration that produced them.
WITH retired_connectors AS (
  SELECT id, tenant_id
  FROM public.omni_mcp_connectors
  WHERE regexp_replace(lower(btrim(endpoint)), '/+$', '') IN (
      'https://asael.bennierichard.com/api/integrations/playwright/mcp',
      'https://omniagent-os-browser.fly.dev/mcp',
      'https://api.browser-use.com/v3/mcp',
      'https://api.browser-use.com/mcp'
    )
    OR lower(btrim(endpoint)) LIKE 'https://api.browser-use.com/%'
)
UPDATE public.omni_mcp_tools tool
SET status = 'disabled',
    updated_at = clock_timestamp()
FROM retired_connectors connector
WHERE tool.connector_id = connector.id
  AND tool.tenant_id = connector.tenant_id;

UPDATE public.omni_mcp_connectors
SET status = 'disabled',
    auth_token_env = NULL,
    credential_version = NULL,
    credential_key_id = NULL,
    credential_fingerprint = NULL,
    credential_origin = NULL,
    sealed_credential = NULL,
    credential_created_by = NULL,
    credential_rotated_by = NULL,
    credential_created_at = NULL,
    credential_rotated_at = NULL,
    last_error = 'Remote browser automation was retired in schema version 181.',
    updated_at = clock_timestamp()
WHERE regexp_replace(lower(btrim(endpoint)), '/+$', '') IN (
    'https://asael.bennierichard.com/api/integrations/playwright/mcp',
    'https://omniagent-os-browser.fly.dev/mcp',
    'https://api.browser-use.com/v3/mcp',
    'https://api.browser-use.com/mcp'
  )
  OR lower(btrim(endpoint)) LIKE 'https://api.browser-use.com/%';

COMMENT ON TABLE public.omni_browser_profiles IS
  'Historical audit records for the retired isolated-browser runtime. New runtime mutations are disabled.';
COMMENT ON TABLE public.omni_browser_profile_bindings IS
  'Historical append-only bindings for the retired isolated-browser runtime.';
COMMENT ON TABLE public.omni_browser_takeovers IS
  'Historical takeover records for the retired isolated-browser runtime. New runtime mutations are disabled.';

REVOKE ALL ON TABLE public.omni_browser_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.omni_browser_profile_bindings FROM PUBLIC;
REVOKE ALL ON TABLE public.omni_browser_takeovers FROM PUBLIC;

DO $retirement$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
    REVOKE ALL ON TABLE public.omni_browser_profiles FROM omni_runtime;
    REVOKE ALL ON TABLE public.omni_browser_profile_bindings FROM omni_runtime;
    REVOKE ALL ON TABLE public.omni_browser_takeovers FROM omni_runtime;
    GRANT SELECT ON TABLE public.omni_browser_profiles TO omni_runtime;
    GRANT SELECT ON TABLE public.omni_browser_profile_bindings TO omni_runtime;
    GRANT SELECT ON TABLE public.omni_browser_takeovers TO omni_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
    REVOKE ALL ON TABLE public.omni_browser_profiles FROM omni_maintenance;
    REVOKE ALL ON TABLE public.omni_browser_profile_bindings FROM omni_maintenance;
    REVOKE ALL ON TABLE public.omni_browser_takeovers FROM omni_maintenance;
    GRANT SELECT ON TABLE public.omni_browser_profiles TO omni_maintenance;
    GRANT SELECT ON TABLE public.omni_browser_profile_bindings TO omni_maintenance;
    GRANT SELECT ON TABLE public.omni_browser_takeovers TO omni_maintenance;
  END IF;
END
$retirement$;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM public.omni_browser_profiles WHERE state = 'active')
    OR EXISTS (SELECT 1 FROM public.omni_browser_takeovers WHERE state = 'active')
  THEN
    RAISE EXCEPTION 'Isolated browser retirement left active authority'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') AND (
    has_table_privilege('omni_runtime', 'public.omni_browser_profiles', 'INSERT')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_profiles', 'UPDATE')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_profiles', 'DELETE')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_profile_bindings', 'INSERT')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_profile_bindings', 'UPDATE')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_profile_bindings', 'DELETE')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_takeovers', 'INSERT')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_takeovers', 'UPDATE')
    OR has_table_privilege('omni_runtime', 'public.omni_browser_takeovers', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'Isolated browser runtime authority is still granted'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.omni_mcp_connectors
    WHERE (
      regexp_replace(lower(btrim(endpoint)), '/+$', '') IN (
        'https://asael.bennierichard.com/api/integrations/playwright/mcp',
        'https://omniagent-os-browser.fly.dev/mcp',
        'https://api.browser-use.com/v3/mcp',
        'https://api.browser-use.com/mcp'
      )
      OR lower(btrim(endpoint)) LIKE 'https://api.browser-use.com/%'
    ) AND (
      status <> 'disabled'
      OR sealed_credential IS NOT NULL
      OR credential_key_id IS NOT NULL
      OR credential_fingerprint IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Retired browser connector authority or credential remains'
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (
  181,
  'isolated_browser_runtime_retirement_v1',
  '2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d',
  clock_timestamp()
);

COMMIT;
