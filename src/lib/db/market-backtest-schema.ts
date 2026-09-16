type SqlRow = Record<string, unknown>;

export type MarketBacktestSchemaSqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
};

export async function ensureMarketDeterministicBacktestsV1(
  sql: MarketBacktestSchemaSqlClient,
) {
  await sql.query(`
    CREATE TABLE omni_market_backtests (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      backtest_version TEXT NOT NULL,
      instrument_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      snapshot_as_of TIMESTAMPTZ NOT NULL,
      strategy_id TEXT NOT NULL,
      engine_rules_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      backtest JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_market_backtests_pkey PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_market_backtests_actor_key UNIQUE (
        tenant_id, id, owner_actor_id
      ),
      CONSTRAINT omni_market_backtests_manifest_key UNIQUE (
        tenant_id, owner_actor_id, snapshot_id, manifest_sha256
      ),
      CONSTRAINT omni_market_backtests_snapshot_fkey FOREIGN KEY (
        tenant_id, snapshot_id, owner_actor_id
      ) REFERENCES omni_market_price_snapshots (
        tenant_id, id, owner_actor_id
      ) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_market_backtests_row_check CHECK (COALESCE(
        schema_version = 1
        AND id ~ '^market_backtest_[0-9a-f]{48}$'
        AND btrim(tenant_id) <> ''
        AND btrim(owner_actor_id) <> ''
        AND contract_version = 'market-research-foundation:6'
        AND backtest_version = 'market-deterministic-backtest:1'
        AND instrument_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
        AND provider = 'twelve_data'
        AND char_length(provider_symbol) BETWEEN 1 AND 80
        AND interval IN ('5min', '15min', '1h')
        AND snapshot_id ~ '^market_snapshot_[0-9a-f]{48}$'
        AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
        AND strategy_id = 'foundation.liquidity_sweep_reversal.v1'
        AND engine_rules_sha256 ~ '^[0-9a-f]{64}$'
        AND manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND result_sha256 ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(backtest) = 'object'
        AND pg_column_size(backtest) <= 2097152
        AND snapshot_as_of <= created_at + INTERVAL '5 minutes'
        AND created_at <= NOW() + INTERVAL '30 seconds'
      , FALSE))
    );
    CREATE INDEX omni_market_backtests_owner_time_idx
      ON omni_market_backtests (
        tenant_id, owner_actor_id, instrument_id, created_at DESC, id
      );
    CREATE TABLE omni_market_backtest_events (
      schema_version SMALLINT NOT NULL DEFAULT 1,
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      backtest_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      operation_job_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT omni_market_backtest_events_pkey PRIMARY KEY (tenant_id, id),
      CONSTRAINT omni_market_backtest_events_parent_fkey FOREIGN KEY (
        tenant_id, backtest_id, owner_actor_id
      ) REFERENCES omni_market_backtests (tenant_id, id, owner_actor_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT omni_market_backtest_events_row_check CHECK (COALESCE(
        schema_version = 1
        AND id ~ '^market_backtest_event_[0-9a-f]{48}$'
        AND btrim(tenant_id) <> ''
        AND btrim(owner_actor_id) <> ''
        AND backtest_id ~ '^market_backtest_[0-9a-f]{48}$'
        AND event_type = 'market.backtest.completed'
        AND char_length(btrim(operation_job_id)) BETWEEN 1 AND 200
        AND payload_sha256 ~ '^[0-9a-f]{64}$'
        AND occurred_at <= NOW() + INTERVAL '30 seconds'
      , FALSE))
    );
    CREATE INDEX omni_market_backtest_events_owner_time_idx
      ON omni_market_backtest_events (
        tenant_id, owner_actor_id, occurred_at DESC, id
      );
    ALTER TABLE omni_market_backtests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_market_backtests FORCE ROW LEVEL SECURITY;
    ALTER TABLE omni_market_backtest_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE omni_market_backtest_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY omni_market_backtests_actor_scope
      ON omni_market_backtests FOR ALL TO PUBLIC
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );
    CREATE POLICY omni_market_backtest_events_actor_scope
      ON omni_market_backtest_events FOR ALL TO PUBLIC
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
        OR omni_actor_scope_v1_allows_canonical(tenant_id, owner_actor_id)
      );
    REVOKE ALL ON omni_market_backtests FROM PUBLIC;
    REVOKE ALL ON omni_market_backtest_events FROM PUBLIC;
  `);
  await sql`
    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT ON omni_market_backtests TO omni_runtime;
        GRANT SELECT, INSERT ON omni_market_backtest_events TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT ON omni_market_backtests TO omni_maintenance;
        GRANT SELECT, INSERT ON omni_market_backtest_events TO omni_maintenance;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_backup') THEN
        GRANT SELECT ON omni_market_backtests TO omni_backup;
        GRANT SELECT ON omni_market_backtest_events TO omni_backup;
      END IF;
    END
    $grants$
  `;
  await sql`
    DO $verify$
    BEGIN
      IF (
        SELECT count(*) FROM pg_class
        WHERE oid IN (
          'omni_market_backtests'::regclass,
          'omni_market_backtest_events'::regclass
        ) AND relrowsecurity AND relforcerowsecurity
      ) <> 2 OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid IN (
          'omni_market_backtests'::regclass,
          'omni_market_backtest_events'::regclass
        )
      ) <> 2 THEN
        RAISE EXCEPTION 'Market backtest isolation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $verify$
  `;
}
