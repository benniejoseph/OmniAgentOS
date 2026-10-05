-- Read-only operator diagnostics. Uses pg_catalog and the Supabase extensions
-- schema explicitly; it does not depend on the operator's search_path.
-- Counters are cumulative since stats_reset, not a current error rate.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

SELECT now() AS captured_at,
       pg_catalog.pg_database_size(pg_catalog.current_database()) AS database_bytes,
       pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(pg_catalog.current_database())) AS database_size;

SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
       temp_files, temp_bytes, deadlocks, stats_reset
FROM pg_catalog.pg_stat_database
WHERE datname = pg_catalog.current_database();

SELECT * FROM extensions.pg_stat_statements_info;

-- No SQL text, parameters, tenant IDs, or row contents are returned.
SELECT queryid, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 3) AS mean_ms,
       rows, temp_blks_written,
       (SELECT rolname FROM pg_catalog.pg_roles WHERE oid = userid) AS role
FROM extensions.pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 15;

SELECT schemaname, relname,
       pg_catalog.pg_total_relation_size(relid) AS total_bytes,
       n_live_tup AS estimated_live_rows, n_dead_tup AS estimated_dead_rows,
       last_autovacuum, last_autoanalyze
FROM pg_catalog.pg_stat_user_tables
ORDER BY pg_catalog.pg_total_relation_size(relid) DESC
LIMIT 15;

COMMIT;
