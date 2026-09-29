import "server-only";

import { ensureTenantIsolationPolicies } from "@/lib/db/schema/tenant-isolation";
import type { SqlClient } from "@/lib/db/sql-types";

// TypeScript migration steps for the entity graph: bitemporal relations, the
// registry, graph query telemetry and lineage barriers.

export async function ensureEntityBitemporalRelationsV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_relation_claims (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      previous_revision_id TEXT,
      owner_actor_id TEXT NOT NULL,
      ontology_version_id TEXT NOT NULL,
      relation_type_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      source_entity_type_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      target_entity_type_id TEXT NOT NULL,
      epistemic_kind TEXT NOT NULL,
      claim_state TEXT NOT NULL,
      confidence_basis_points INTEGER NOT NULL,
      access_scope_sha256 TEXT NOT NULL,
      lineage_memory_ids TEXT[] NOT NULL DEFAULT '{}',
      lineage_evidence_unit_ids TEXT[] NOT NULL DEFAULT '{}',
      valid_from TIMESTAMPTZ NOT NULL,
      valid_to TIMESTAMPTZ,
      recorded_at TIMESTAMPTZ NOT NULL,
      superseded_at TIMESTAMPTZ,
      contract JSONB NOT NULL,
      claim_sha256 TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, previous_revision_id)
        REFERENCES omni_entity_relation_claims(tenant_id, id),
      FOREIGN KEY (tenant_id, source_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      FOREIGN KEY (tenant_id, target_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      CHECK (char_length(id) BETWEEN 1 AND 240),
      CHECK (char_length(claim_id) BETWEEN 1 AND 240),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (ontology_version_id = 'asael-ontology:1'),
      CHECK (relation_type_id IN (
        'affiliated_with', 'belongs_to', 'assigned_to', 'attends',
        'located_at', 'references', 'decides', 'commits_to', 'prefers',
        'introduces_risk_to', 'targets', 'produces', 'related_to'
      )),
      CHECK (source_entity_type_id IN (
        'person', 'organization', 'account', 'project', 'work_item',
        'event', 'meeting', 'place', 'asset', 'decision', 'commitment',
        'preference', 'risk', 'goal', 'product', 'case', 'opportunity'
      )),
      CHECK (target_entity_type_id IN (
        'person', 'organization', 'account', 'project', 'work_item',
        'event', 'meeting', 'place', 'asset', 'decision', 'commitment',
        'preference', 'risk', 'goal', 'product', 'case', 'opportunity'
      )),
      CHECK (source_entity_id <> target_entity_id),
      CHECK (epistemic_kind IN (
        'asserted', 'observed', 'inferred', 'computed'
      )),
      CHECK (claim_state IN ('active', 'retracted')),
      CHECK (confidence_basis_points BETWEEN 0 AND 10000),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (claim_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (valid_to IS NULL OR valid_to > valid_from),
      CHECK (superseded_at IS NULL OR superseded_at > recorded_at),
      CHECK (contract ->> 'claimId' = claim_id),
      CHECK (contract ->> 'revisionId' = id),
      CHECK (
        contract ->> 'previousRevisionId' IS NOT DISTINCT FROM previous_revision_id
      ),
      CHECK (contract ->> 'ontologyVersionId' = ontology_version_id),
      CHECK (contract ->> 'relationTypeId' = relation_type_id),
      CHECK (contract #>> '{source,entityId}' = source_entity_id),
      CHECK (contract #>> '{source,entityTypeId}' = source_entity_type_id),
      CHECK (contract #>> '{target,entityId}' = target_entity_id),
      CHECK (contract #>> '{target,entityTypeId}' = target_entity_type_id),
      CHECK (contract ->> 'epistemicKind' = epistemic_kind),
      CHECK (contract ->> 'claimState' = claim_state),
      CHECK (
        (contract ->> 'confidenceBasisPoints')::INTEGER =
          confidence_basis_points
      ),
      CHECK (
        contract #>> '{accessBinding,tenantId}' = tenant_id
      ),
      CHECK (
        contract #>> '{accessBinding,ownerActorId}' = owner_actor_id
      ),
      CHECK (
        contract #>> '{accessBinding,accessScopeSha256}' = access_scope_sha256
      ),
      CHECK ((contract ->> 'validFrom')::TIMESTAMPTZ = valid_from),
      CHECK (
        (contract ->> 'validTo' IS NULL AND valid_to IS NULL)
        OR (contract ->> 'validTo')::TIMESTAMPTZ = valid_to
      ),
      CHECK ((contract ->> 'recordedAt')::TIMESTAMPTZ = recorded_at),
      CHECK (contract ->> 'claimSha256' = claim_sha256)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_entity_relation_claims_current_idx
    ON omni_entity_relation_claims (tenant_id, claim_id)
    WHERE superseded_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_claims_source_time_idx
    ON omni_entity_relation_claims (
      tenant_id, owner_actor_id, source_entity_id, relation_type_id,
      valid_from, recorded_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_claims_target_time_idx
    ON omni_entity_relation_claims (
      tenant_id, owner_actor_id, target_entity_id, relation_type_id,
      valid_from, recorded_at DESC
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_claims_system_time_idx
    ON omni_entity_relation_claims (
      tenant_id, owner_actor_id, access_scope_sha256, recorded_at DESC,
      superseded_at
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_claims_memory_lineage_idx
    ON omni_entity_relation_claims USING GIN (lineage_memory_ids)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_claims_evidence_lineage_idx
    ON omni_entity_relation_claims USING GIN (lineage_evidence_unit_ids)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_entity_relation_claim_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      contract_memory_ids TEXT[];
      contract_evidence_ids TEXT[];
      source_record omni_entity_records%ROWTYPE;
      target_record omni_entity_records%ROWTYPE;
      previous_record omni_entity_relation_claims%ROWTYPE;
      relation_types_are_valid BOOLEAN;
    BEGIN
      SELECT COALESCE(array_agg(
        DISTINCT reference ->> 'referenceId'
        ORDER BY reference ->> 'referenceId'
      ), '{}'::TEXT[])
      INTO contract_memory_ids
      FROM jsonb_array_elements(NEW.contract -> 'lineage') reference
      WHERE reference ->> 'kind' = 'memory';

      SELECT COALESCE(array_agg(
        DISTINCT reference ->> 'referenceId'
        ORDER BY reference ->> 'referenceId'
      ), '{}'::TEXT[])
      INTO contract_evidence_ids
      FROM jsonb_array_elements(NEW.contract -> 'lineage') reference
      WHERE reference ->> 'kind' = 'evidence_unit';

      IF NEW.lineage_memory_ids IS DISTINCT FROM contract_memory_ids
        OR NEW.lineage_evidence_unit_ids IS DISTINCT FROM contract_evidence_ids
      THEN
        RAISE EXCEPTION 'Entity relation lineage indexes do not match the contract'
          USING ERRCODE = '23514';
      END IF;
      IF cardinality(NEW.lineage_memory_ids) > 0
        AND NOT omni_active_memory_lineage_owned_by(
          NEW.tenant_id, NEW.owner_actor_id, NEW.lineage_memory_ids
        )
      THEN
        RAISE EXCEPTION 'Entity relation references inactive memory evidence'
          USING ERRCODE = '55000';
      END IF;
      IF cardinality(NEW.lineage_evidence_unit_ids) > 0
        AND NOT omni_active_evidence_lineage_owned_by(
          NEW.tenant_id, NEW.owner_actor_id,
          NEW.lineage_evidence_unit_ids
        )
      THEN
        RAISE EXCEPTION 'Entity relation references inactive canonical evidence'
          USING ERRCODE = '55000';
      END IF;

      SELECT * INTO source_record
      FROM omni_entity_records
      WHERE tenant_id = NEW.tenant_id AND id = NEW.source_entity_id;
      SELECT * INTO target_record
      FROM omni_entity_records
      WHERE tenant_id = NEW.tenant_id AND id = NEW.target_entity_id;
      IF source_record.id IS NULL OR target_record.id IS NULL
        OR source_record.state <> 'active' OR target_record.state <> 'active'
        OR source_record.owner_actor_id <> NEW.owner_actor_id
        OR target_record.owner_actor_id <> NEW.owner_actor_id
        OR source_record.access_scope_sha256 <> NEW.access_scope_sha256
        OR target_record.access_scope_sha256 <> NEW.access_scope_sha256
        OR source_record.entity_type_id <> NEW.source_entity_type_id
        OR target_record.entity_type_id <> NEW.target_entity_type_id
      THEN
        RAISE EXCEPTION 'Entity relation endpoints are not active in one scope'
          USING ERRCODE = '23514';
      END IF;

      relation_types_are_valid := CASE NEW.relation_type_id
        WHEN 'affiliated_with' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('organization', 'account')
        WHEN 'belongs_to' THEN
          NEW.source_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          ) AND NEW.target_entity_type_id IN (
            'organization', 'account', 'project'
          )
        WHEN 'assigned_to' THEN
          NEW.source_entity_type_id IN (
            'work_item', 'case', 'opportunity', 'commitment'
          ) AND NEW.target_entity_type_id IN ('person', 'organization')
        WHEN 'attends' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('meeting', 'event')
        WHEN 'located_at' THEN
          NEW.source_entity_type_id IN (
            'person', 'organization', 'event', 'meeting', 'asset'
          ) AND NEW.target_entity_type_id = 'place'
        WHEN 'references' THEN
          NEW.target_entity_type_id IN ('asset', 'decision', 'commitment')
        WHEN 'decides' THEN
          NEW.source_entity_type_id IN ('person', 'organization', 'meeting')
          AND NEW.target_entity_type_id = 'decision'
        WHEN 'commits_to' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('commitment', 'goal', 'work_item')
        WHEN 'prefers' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('preference', 'product', 'place')
        WHEN 'introduces_risk_to' THEN
          NEW.source_entity_type_id = 'risk'
          AND NEW.target_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          )
        WHEN 'targets' THEN
          NEW.source_entity_type_id IN ('goal', 'opportunity', 'work_item')
          AND NEW.target_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          )
        WHEN 'produces' THEN
          NEW.source_entity_type_id IN (
            'person', 'organization', 'project', 'work_item', 'event', 'meeting'
          ) AND NEW.target_entity_type_id IN (
            'asset', 'decision', 'commitment'
          )
        WHEN 'related_to' THEN NEW.source_entity_id < NEW.target_entity_id
        ELSE FALSE
      END;
      IF NOT COALESCE(relation_types_are_valid, FALSE) THEN
        RAISE EXCEPTION 'Entity relation endpoint types violate the ontology'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.previous_revision_id IS NULL THEN
        IF EXISTS (
          SELECT 1 FROM omni_entity_relation_claims
          WHERE tenant_id = NEW.tenant_id AND claim_id = NEW.claim_id
        ) THEN
          RAISE EXCEPTION 'Entity relation claim must append to its prior revision'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        SELECT * INTO previous_record
        FROM omni_entity_relation_claims
        WHERE tenant_id = NEW.tenant_id AND id = NEW.previous_revision_id;
        IF previous_record.id IS NULL
          OR previous_record.claim_id <> NEW.claim_id
          OR previous_record.ontology_version_id <> NEW.ontology_version_id
          OR previous_record.relation_type_id <> NEW.relation_type_id
          OR previous_record.source_entity_id <> NEW.source_entity_id
          OR previous_record.source_entity_type_id <> NEW.source_entity_type_id
          OR previous_record.target_entity_id <> NEW.target_entity_id
          OR previous_record.target_entity_type_id <> NEW.target_entity_type_id
          OR previous_record.owner_actor_id <> NEW.owner_actor_id
          OR previous_record.access_scope_sha256 <> NEW.access_scope_sha256
          OR previous_record.superseded_at IS DISTINCT FROM NEW.recorded_at
          OR NEW.recorded_at <= previous_record.recorded_at
        THEN
          RAISE EXCEPTION 'Entity relation revision chain is invalid'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_entity_relation_claim_mutation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.superseded_at IS NULL
        AND NEW.superseded_at > OLD.recorded_at
        AND ROW(
          OLD.tenant_id, OLD.id, OLD.claim_id, OLD.previous_revision_id,
          OLD.owner_actor_id, OLD.ontology_version_id, OLD.relation_type_id,
          OLD.source_entity_id, OLD.source_entity_type_id,
          OLD.target_entity_id, OLD.target_entity_type_id,
          OLD.epistemic_kind, OLD.claim_state, OLD.confidence_basis_points,
          OLD.access_scope_sha256, OLD.lineage_memory_ids,
          OLD.lineage_evidence_unit_ids, OLD.valid_from, OLD.valid_to,
          OLD.recorded_at, OLD.contract, OLD.claim_sha256
        ) IS NOT DISTINCT FROM ROW(
          NEW.tenant_id, NEW.id, NEW.claim_id, NEW.previous_revision_id,
          NEW.owner_actor_id, NEW.ontology_version_id, NEW.relation_type_id,
          NEW.source_entity_id, NEW.source_entity_type_id,
          NEW.target_entity_id, NEW.target_entity_type_id,
          NEW.epistemic_kind, NEW.claim_state, NEW.confidence_basis_points,
          NEW.access_scope_sha256, NEW.lineage_memory_ids,
          NEW.lineage_evidence_unit_ids, NEW.valid_from, NEW.valid_to,
          NEW.recorded_at, NEW.contract, NEW.claim_sha256
        )
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Entity relation claims are append-only'
        USING ERRCODE = '55000';
    END
    $function$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_require_entity_relation_successor()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM omni_entity_relation_claims successor
        WHERE successor.tenant_id = NEW.tenant_id
          AND successor.previous_revision_id = NEW.id
          AND successor.claim_id = NEW.claim_id
          AND successor.recorded_at = NEW.superseded_at
      ) THEN
        RAISE EXCEPTION 'Superseded entity relation requires an appended successor'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_relation_claim_validate_insert
    ON omni_entity_relation_claims
  `;
  await sql`
    CREATE TRIGGER omni_entity_relation_claim_validate_insert
    BEFORE INSERT ON omni_entity_relation_claims
    FOR EACH ROW EXECUTE FUNCTION omni_validate_entity_relation_claim_insert()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_relation_claim_append_only
    ON omni_entity_relation_claims
  `;
  await sql`
    CREATE TRIGGER omni_entity_relation_claim_append_only
    BEFORE UPDATE OR DELETE ON omni_entity_relation_claims
    FOR EACH ROW EXECUTE FUNCTION omni_reject_entity_relation_claim_mutation()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_relation_claim_no_truncate
    ON omni_entity_relation_claims
  `;
  await sql`
    CREATE TRIGGER omni_entity_relation_claim_no_truncate
    BEFORE TRUNCATE ON omni_entity_relation_claims
    FOR EACH STATEMENT EXECUTE FUNCTION omni_reject_entity_relation_claim_mutation()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_relation_claim_requires_successor
    ON omni_entity_relation_claims
  `;
  await sql`
    CREATE CONSTRAINT TRIGGER omni_entity_relation_claim_requires_successor
    AFTER UPDATE ON omni_entity_relation_claims
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION omni_require_entity_relation_successor()
  `;

  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    DECLARE
      policy_name TEXT;
    BEGIN
      ALTER TABLE omni_entity_relation_claims ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_entity_relation_claims FORCE ROW LEVEL SECURITY;
      FOREACH policy_name IN ARRAY ARRAY[
        'omni_entity_relation_claims_actor_select',
        'omni_entity_relation_claims_actor_insert',
        'omni_entity_relation_claims_actor_update',
        'omni_entity_relation_claims_memory_barrier',
        'omni_entity_relation_claims_evidence_barrier'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON omni_entity_relation_claims',
          policy_name
        );
      END LOOP;
      CREATE POLICY omni_entity_relation_claims_actor_select
      ON omni_entity_relation_claims AS RESTRICTIVE FOR SELECT
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_claims_actor_insert
      ON omni_entity_relation_claims AS RESTRICTIVE FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_claims_actor_update
      ON omni_entity_relation_claims AS RESTRICTIVE FOR UPDATE
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_claims_memory_barrier
      ON omni_entity_relation_claims AS RESTRICTIVE FOR SELECT
      USING (
        cardinality(lineage_memory_ids) = 0
        OR omni_system_scope_enabled()
        OR omni_active_memory_lineage_owned_by(
          tenant_id, owner_actor_id, lineage_memory_ids
        )
      );
      CREATE POLICY omni_entity_relation_claims_evidence_barrier
      ON omni_entity_relation_claims AS RESTRICTIVE FOR SELECT
      USING (
        cardinality(lineage_evidence_unit_ids) = 0
        OR omni_system_scope_enabled()
        OR omni_active_evidence_lineage_owned_by(
          tenant_id, owner_actor_id, lineage_evidence_unit_ids
        )
      );
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_entity_relation_claims FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON omni_entity_relation_claims
        TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE ON omni_entity_relation_claims
        TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_entity_relation_claims'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_entity_relation_claims'::regclass
          AND NOT polpermissive
      ) <> 5 OR (
        SELECT count(*) FROM pg_trigger
        WHERE tgrelid = 'omni_entity_relation_claims'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'omni_entity_relation_claim_validate_insert',
            'omni_entity_relation_claim_append_only',
            'omni_entity_relation_claim_no_truncate',
            'omni_entity_relation_claim_requires_successor'
          )
      ) <> 4 THEN
        RAISE EXCEPTION 'Entity bitemporal relation boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityRelationProjectionV1(sql: SqlClient) {
  // Re-assert the v105 boundary before adding its projection outbox and the
  // narrowly relaxed retraction path used when canonical lineage is removed.
  await ensureEntityBitemporalRelationsV1(sql);

  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_relation_projection_queue (
      tenant_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      generation BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, owner_actor_id),
      CHECK (char_length(tenant_id) BETWEEN 1 AND 240),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (attempts BETWEEN 0 AND 1000000),
      CHECK (generation BETWEEN 1 AND 9007199254740991),
      CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
      CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
      CHECK (requested_at <= updated_at)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_relation_projection_queue_lease_idx
    ON omni_entity_relation_projection_queue (
      lease_expires_at, attempts, requested_at, tenant_id, owner_actor_id
    )
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_entity_relation_claim_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      contract_memory_ids TEXT[];
      contract_evidence_ids TEXT[];
      source_record omni_entity_records%ROWTYPE;
      target_record omni_entity_records%ROWTYPE;
      previous_record omni_entity_relation_claims%ROWTYPE;
      relation_types_are_valid BOOLEAN;
    BEGIN
      SELECT COALESCE(array_agg(
        DISTINCT reference ->> 'referenceId'
        ORDER BY reference ->> 'referenceId'
      ), '{}'::TEXT[])
      INTO contract_memory_ids
      FROM jsonb_array_elements(NEW.contract -> 'lineage') reference
      WHERE reference ->> 'kind' = 'memory';

      SELECT COALESCE(array_agg(
        DISTINCT reference ->> 'referenceId'
        ORDER BY reference ->> 'referenceId'
      ), '{}'::TEXT[])
      INTO contract_evidence_ids
      FROM jsonb_array_elements(NEW.contract -> 'lineage') reference
      WHERE reference ->> 'kind' = 'evidence_unit';

      IF NEW.lineage_memory_ids IS DISTINCT FROM contract_memory_ids
        OR NEW.lineage_evidence_unit_ids IS DISTINCT FROM contract_evidence_ids
      THEN
        RAISE EXCEPTION 'Entity relation lineage indexes do not match the contract'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.claim_state <> 'retracted'
        AND cardinality(NEW.lineage_memory_ids) > 0
        AND NOT omni_active_memory_lineage_owned_by(
          NEW.tenant_id, NEW.owner_actor_id, NEW.lineage_memory_ids
        )
      THEN
        RAISE EXCEPTION 'Entity relation references inactive memory evidence'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.claim_state <> 'retracted'
        AND cardinality(NEW.lineage_evidence_unit_ids) > 0
        AND NOT omni_active_evidence_lineage_owned_by(
          NEW.tenant_id, NEW.owner_actor_id,
          NEW.lineage_evidence_unit_ids
        )
      THEN
        RAISE EXCEPTION 'Entity relation references inactive canonical evidence'
          USING ERRCODE = '55000';
      END IF;

      SELECT * INTO source_record
      FROM omni_entity_records
      WHERE tenant_id = NEW.tenant_id AND id = NEW.source_entity_id;
      SELECT * INTO target_record
      FROM omni_entity_records
      WHERE tenant_id = NEW.tenant_id AND id = NEW.target_entity_id;
      IF source_record.id IS NULL OR target_record.id IS NULL
        OR source_record.owner_actor_id <> NEW.owner_actor_id
        OR target_record.owner_actor_id <> NEW.owner_actor_id
        OR source_record.access_scope_sha256 <> NEW.access_scope_sha256
        OR target_record.access_scope_sha256 <> NEW.access_scope_sha256
        OR source_record.entity_type_id <> NEW.source_entity_type_id
        OR target_record.entity_type_id <> NEW.target_entity_type_id
        OR (
          NEW.claim_state <> 'retracted'
          AND (
            source_record.state <> 'active'
            OR target_record.state <> 'active'
            OR NEW.contract #>> '{source,entitySha256}' <>
              source_record.entity_sha256
            OR NEW.contract #>> '{target,entitySha256}' <>
              target_record.entity_sha256
          )
        )
      THEN
        RAISE EXCEPTION 'Entity relation endpoints are not valid in one scope'
          USING ERRCODE = '23514';
      END IF;

      relation_types_are_valid := CASE NEW.relation_type_id
        WHEN 'affiliated_with' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('organization', 'account')
        WHEN 'belongs_to' THEN
          NEW.source_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          ) AND NEW.target_entity_type_id IN (
            'organization', 'account', 'project'
          )
        WHEN 'assigned_to' THEN
          NEW.source_entity_type_id IN (
            'work_item', 'case', 'opportunity', 'commitment'
          ) AND NEW.target_entity_type_id IN ('person', 'organization')
        WHEN 'attends' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('meeting', 'event')
        WHEN 'located_at' THEN
          NEW.source_entity_type_id IN (
            'person', 'organization', 'event', 'meeting', 'asset'
          ) AND NEW.target_entity_type_id = 'place'
        WHEN 'references' THEN
          NEW.target_entity_type_id IN ('asset', 'decision', 'commitment')
        WHEN 'decides' THEN
          NEW.source_entity_type_id IN ('person', 'organization', 'meeting')
          AND NEW.target_entity_type_id = 'decision'
        WHEN 'commits_to' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('commitment', 'goal', 'work_item')
        WHEN 'prefers' THEN
          NEW.source_entity_type_id IN ('person', 'organization')
          AND NEW.target_entity_type_id IN ('preference', 'product', 'place')
        WHEN 'introduces_risk_to' THEN
          NEW.source_entity_type_id = 'risk'
          AND NEW.target_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          )
        WHEN 'targets' THEN
          NEW.source_entity_type_id IN ('goal', 'opportunity', 'work_item')
          AND NEW.target_entity_type_id IN (
            'account', 'project', 'work_item', 'event', 'meeting', 'asset',
            'decision', 'commitment', 'risk', 'goal', 'product', 'case',
            'opportunity'
          )
        WHEN 'produces' THEN
          NEW.source_entity_type_id IN (
            'person', 'organization', 'project', 'work_item', 'event', 'meeting'
          ) AND NEW.target_entity_type_id IN (
            'asset', 'decision', 'commitment'
          )
        WHEN 'related_to' THEN NEW.source_entity_id < NEW.target_entity_id
        ELSE FALSE
      END;
      IF NOT COALESCE(relation_types_are_valid, FALSE) THEN
        RAISE EXCEPTION 'Entity relation endpoint types violate the ontology'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.previous_revision_id IS NULL THEN
        IF NEW.claim_state = 'retracted' THEN
          RAISE EXCEPTION 'Entity relation retraction requires a prior revision'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM omni_entity_relation_claims
          WHERE tenant_id = NEW.tenant_id AND claim_id = NEW.claim_id
        ) THEN
          RAISE EXCEPTION 'Entity relation claim must append to its prior revision'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        SELECT * INTO previous_record
        FROM omni_entity_relation_claims
        WHERE tenant_id = NEW.tenant_id AND id = NEW.previous_revision_id;
        IF previous_record.id IS NULL
          OR previous_record.claim_id <> NEW.claim_id
          OR previous_record.ontology_version_id <> NEW.ontology_version_id
          OR previous_record.relation_type_id <> NEW.relation_type_id
          OR previous_record.source_entity_id <> NEW.source_entity_id
          OR previous_record.source_entity_type_id <> NEW.source_entity_type_id
          OR previous_record.target_entity_id <> NEW.target_entity_id
          OR previous_record.target_entity_type_id <> NEW.target_entity_type_id
          OR previous_record.owner_actor_id <> NEW.owner_actor_id
          OR previous_record.access_scope_sha256 <> NEW.access_scope_sha256
          OR previous_record.superseded_at IS DISTINCT FROM NEW.recorded_at
          OR NEW.recorded_at <= previous_record.recorded_at
          OR (
            NEW.claim_state = 'retracted'
            AND (
              previous_record.lineage_memory_ids IS DISTINCT FROM
                NEW.lineage_memory_ids
              OR previous_record.lineage_evidence_unit_ids IS DISTINCT FROM
                NEW.lineage_evidence_unit_ids
            )
          )
        THEN
          RAISE EXCEPTION 'Entity relation revision chain is invalid'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DO $migration$
    DECLARE
      policy_name TEXT;
    BEGIN
      ALTER TABLE omni_entity_relation_projection_queue ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_entity_relation_projection_queue FORCE ROW LEVEL SECURITY;
      FOREACH policy_name IN ARRAY ARRAY[
        'omni_entity_relation_projection_queue_actor_select',
        'omni_entity_relation_projection_queue_actor_insert',
        'omni_entity_relation_projection_queue_actor_update',
        'omni_entity_relation_projection_queue_system_delete'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON omni_entity_relation_projection_queue',
          policy_name
        );
      END LOOP;
      CREATE POLICY omni_entity_relation_projection_queue_actor_select
      ON omni_entity_relation_projection_queue AS RESTRICTIVE FOR SELECT
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_projection_queue_actor_insert
      ON omni_entity_relation_projection_queue AS RESTRICTIVE FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_projection_queue_actor_update
      ON omni_entity_relation_projection_queue AS RESTRICTIVE FOR UPDATE
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      )
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_entity_relation_projection_queue_system_delete
      ON omni_entity_relation_projection_queue AS RESTRICTIVE FOR DELETE
      USING (omni_system_scope_enabled());
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_entity_relation_projection_queue FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE
        ON omni_entity_relation_projection_queue TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON omni_entity_relation_projection_queue TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_entity_relation_projection_queue'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_entity_relation_projection_queue'::regclass
          AND NOT polpermissive
      ) <> 4 OR to_regprocedure(
        'public.omni_validate_entity_relation_claim_insert()'
      ) IS NULL THEN
        RAISE EXCEPTION 'Entity relation projection boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureGraphQueryTelemetryV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_graph_query_telemetry (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      access_scope_sha256 TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      query_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      primary_adapter_id TEXT NOT NULL,
      shadow_adapter_id TEXT,
      shadow_state TEXT NOT NULL,
      max_hops SMALLINT NOT NULL,
      requested_limit SMALLINT NOT NULL,
      entity_count INTEGER NOT NULL,
      alias_count INTEGER NOT NULL,
      relation_candidate_count INTEGER NOT NULL,
      relation_limit_saturated BOOLEAN NOT NULL,
      authorized_relation_count INTEGER NOT NULL,
      rejected_relation_count INTEGER NOT NULL,
      path_count INTEGER NOT NULL,
      total_duration_ms DOUBLE PRECISION NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL,
      contract JSONB NOT NULL,
      telemetry_sha256 TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id),
      CHECK (char_length(id) BETWEEN 1 AND 240),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (char_length(correlation_id) BETWEEN 1 AND 240),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (telemetry_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (query_kind = 'relationship_paths'),
      CHECK (status IN ('succeeded', 'failed')),
      CHECK (primary_adapter_id ~ '^[a-z][a-z0-9._-]{1,79}:[1-9][0-9]{0,8}$'),
      CHECK (
        shadow_adapter_id IS NULL
        OR shadow_adapter_id ~ '^[a-z][a-z0-9._-]{1,79}:[1-9][0-9]{0,8}$'
      ),
      CHECK (shadow_state IN (
        'not_configured', 'matched', 'mismatched', 'failed'
      )),
      CHECK ((shadow_adapter_id IS NULL) = (shadow_state = 'not_configured')),
      CHECK (max_hops BETWEEN 1 AND 3),
      CHECK (requested_limit BETWEEN 1 AND 24),
      CHECK (entity_count >= 0),
      CHECK (alias_count >= 0),
      CHECK (relation_candidate_count >= 0),
      CHECK (authorized_relation_count >= 0),
      CHECK (rejected_relation_count >= 0),
      CHECK (path_count >= 0),
      CHECK (total_duration_ms >= 0 AND total_duration_ms <= 3600000),
      CHECK (contract ->> 'version' = 'p5.6-graph-query-telemetry:1'),
      CHECK (contract ->> 'telemetryId' = id),
      CHECK (contract ->> 'tenantId' = tenant_id),
      CHECK (contract ->> 'ownerActorId' = owner_actor_id),
      CHECK (contract ->> 'accessScopeSha256' = access_scope_sha256),
      CHECK (contract ->> 'correlationId' = correlation_id),
      CHECK (contract ->> 'queryKind' = query_kind),
      CHECK (contract ->> 'status' = status),
      CHECK (contract ->> 'primaryAdapterId' = primary_adapter_id),
      CHECK (contract ->> 'shadowAdapterId' IS NOT DISTINCT FROM shadow_adapter_id),
      CHECK (contract ->> 'shadowState' = shadow_state),
      CHECK ((contract ->> 'maxHops')::SMALLINT = max_hops),
      CHECK ((contract ->> 'requestedLimit')::SMALLINT = requested_limit),
      CHECK ((contract ->> 'entityCount')::INTEGER = entity_count),
      CHECK ((contract ->> 'aliasCount')::INTEGER = alias_count),
      CHECK (
        (contract ->> 'relationCandidateCount')::INTEGER =
          relation_candidate_count
      ),
      CHECK (
        (contract ->> 'relationLimitSaturated')::BOOLEAN =
          relation_limit_saturated
      ),
      CHECK (
        (contract ->> 'authorizedRelationCount')::INTEGER =
          authorized_relation_count
      ),
      CHECK (
        (contract ->> 'rejectedRelationCount')::INTEGER =
          rejected_relation_count
      ),
      CHECK ((contract ->> 'pathCount')::INTEGER = path_count),
      CHECK (
        (contract ->> 'totalDurationMs')::DOUBLE PRECISION =
          total_duration_ms
      ),
      CHECK ((contract ->> 'recordedAt')::TIMESTAMPTZ = recorded_at),
      CHECK (contract ->> 'telemetrySha256' = telemetry_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_graph_query_telemetry_actor_time_idx
    ON omni_graph_query_telemetry (
      tenant_id, owner_actor_id, access_scope_sha256, recorded_at DESC,
      id COLLATE "C"
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_graph_query_telemetry_adapter_time_idx
    ON omni_graph_query_telemetry (
      tenant_id, primary_adapter_id, recorded_at DESC
    )
  `;
  await sql`
    DO $migration$
    DECLARE
      policy_name TEXT;
    BEGIN
      ALTER TABLE omni_graph_query_telemetry ENABLE ROW LEVEL SECURITY;
      ALTER TABLE omni_graph_query_telemetry FORCE ROW LEVEL SECURITY;
      FOREACH policy_name IN ARRAY ARRAY[
        'omni_graph_query_telemetry_actor_select',
        'omni_graph_query_telemetry_actor_insert',
        'omni_graph_query_telemetry_system_delete'
      ] LOOP
        EXECUTE format(
          'DROP POLICY IF EXISTS %I ON omni_graph_query_telemetry',
          policy_name
        );
      END LOOP;
      CREATE POLICY omni_graph_query_telemetry_actor_select
      ON omni_graph_query_telemetry AS RESTRICTIVE FOR SELECT
      USING (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_graph_query_telemetry_actor_insert
      ON omni_graph_query_telemetry AS RESTRICTIVE FOR INSERT
      WITH CHECK (
        omni_system_scope_enabled()
        OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id)
      );
      CREATE POLICY omni_graph_query_telemetry_system_delete
      ON omni_graph_query_telemetry AS RESTRICTIVE FOR DELETE
      USING (omni_system_scope_enabled());
    END
    $migration$
  `;
  await sql`REVOKE ALL ON TABLE omni_graph_query_telemetry FROM PUBLIC`;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_graph_query_telemetry FROM omni_runtime';
        GRANT SELECT, INSERT ON omni_graph_query_telemetry TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        EXECUTE 'REVOKE ALL ON TABLE omni_graph_query_telemetry FROM omni_maintenance';
        GRANT SELECT, INSERT, DELETE
        ON omni_graph_query_telemetry TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'omni_graph_query_telemetry'::regclass
          AND relrowsecurity AND relforcerowsecurity
      ) OR (
        SELECT count(*) FROM pg_policy
        WHERE polrelid = 'omni_graph_query_telemetry'::regclass
          AND NOT polpermissive
      ) <> 3 OR EXISTS (
        SELECT 1
        FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = 'omni_graph_query_telemetry'
          AND grantee = 'omni_runtime'
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
      ) THEN
        RAISE EXCEPTION 'Graph query telemetry boundary is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityRegistryV1(sql: SqlClient) {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_records (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      ontology_version_id TEXT NOT NULL,
      entity_type_id TEXT NOT NULL,
      canonical_label TEXT NOT NULL,
      normalized_label_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      merged_into_entity_id TEXT,
      access_scope_sha256 TEXT NOT NULL,
      contract JSONB NOT NULL,
      entity_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, merged_into_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (ontology_version_id = 'asael-ontology:1'),
      CHECK (entity_type_id IN (
        'person', 'organization', 'account', 'project', 'work_item',
        'event', 'meeting', 'place', 'asset', 'decision', 'commitment',
        'preference', 'risk', 'goal', 'product', 'case', 'opportunity'
      )),
      CHECK (state IN ('active', 'merged', 'retired')),
      CHECK ((state = 'merged') = (merged_into_entity_id IS NOT NULL)),
      CHECK (normalized_label_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (entity_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (contract ->> 'entityId' = id),
      CHECK (contract ->> 'ontologyVersionId' = ontology_version_id),
      CHECK (contract ->> 'entityTypeId' = entity_type_id),
      CHECK (contract ->> 'state' = state),
      CHECK (contract ->> 'entitySha256' = entity_sha256),
      CHECK (contract #>> '{accessBinding,tenantId}' = tenant_id),
      CHECK (contract #>> '{accessBinding,ownerActorId}' = owner_actor_id),
      CHECK (
        contract #>> '{accessBinding,accessScopeSha256}' = access_scope_sha256
      )
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_records_resolution_idx
    ON omni_entity_records (
      tenant_id, owner_actor_id, entity_type_id, access_scope_sha256,
      normalized_label_sha256
    )
    WHERE state = 'active'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_aliases (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      normalized_alias_sha256 TEXT NOT NULL,
      access_scope_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      contract JSONB NOT NULL,
      alias_sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (state IN ('active', 'retired')),
      CHECK (normalized_alias_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (alias_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (contract ->> 'aliasId' = id),
      CHECK (contract ->> 'entityId' = entity_id),
      CHECK (contract ->> 'state' = state),
      CHECK (contract ->> 'accessScopeSha256' = access_scope_sha256),
      CHECK (contract ->> 'aliasSha256' = alias_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_aliases_resolution_idx
    ON omni_entity_aliases (
      tenant_id, owner_actor_id, access_scope_sha256,
      normalized_alias_sha256
    )
    WHERE state = 'active'
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_resolutions (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      entity_type_id TEXT NOT NULL,
      access_scope_sha256 TEXT NOT NULL,
      decision TEXT NOT NULL,
      selected_entity_id TEXT,
      contract JSONB NOT NULL,
      decision_sha256 TEXT NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, selected_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (decision IN ('auto_link', 'review_required', 'create_new')),
      CHECK ((decision = 'auto_link') = (selected_entity_id IS NOT NULL)),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (decision_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (contract ->> 'resolutionId' = id),
      CHECK (contract ->> 'tenantId' = tenant_id),
      CHECK (contract ->> 'ownerActorId' = owner_actor_id),
      CHECK (contract ->> 'entityTypeId' = entity_type_id),
      CHECK (contract ->> 'decision' = decision),
      CHECK (contract ->> 'accessScopeSha256' = access_scope_sha256),
      CHECK (contract ->> 'decisionSha256' = decision_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_resolutions_actor_at_idx
    ON omni_entity_resolutions (tenant_id, owner_actor_id, decided_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS omni_entity_merge_reviews (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      resolution_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      access_scope_sha256 TEXT NOT NULL,
      decision TEXT NOT NULL,
      previous_review_id TEXT,
      reviewer_actor_id TEXT NOT NULL,
      contract JSONB NOT NULL,
      review_sha256 TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, resolution_id)
        REFERENCES omni_entity_resolutions(tenant_id, id),
      FOREIGN KEY (tenant_id, source_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      FOREIGN KEY (tenant_id, target_entity_id)
        REFERENCES omni_entity_records(tenant_id, id),
      FOREIGN KEY (tenant_id, previous_review_id)
        REFERENCES omni_entity_merge_reviews(tenant_id, id),
      CHECK (char_length(owner_actor_id) BETWEEN 1 AND 320),
      CHECK (reviewer_actor_id = owner_actor_id),
      CHECK (decision IN ('approved', 'rejected', 'reversed')),
      CHECK ((decision = 'reversed') = (previous_review_id IS NOT NULL)),
      CHECK (access_scope_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (contract ->> 'reviewId' = id),
      CHECK (contract ->> 'resolutionId' = resolution_id),
      CHECK (contract ->> 'tenantId' = tenant_id),
      CHECK (contract ->> 'ownerActorId' = owner_actor_id),
      CHECK (contract ->> 'decision' = decision),
      CHECK (contract ->> 'accessScopeSha256' = access_scope_sha256),
      CHECK (contract ->> 'reviewSha256' = review_sha256)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_merge_reviews_actor_at_idx
    ON omni_entity_merge_reviews (tenant_id, owner_actor_id, reviewed_at DESC)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS omni_entity_merge_reviews_one_reversal_idx
    ON omni_entity_merge_reviews (tenant_id, previous_review_id)
    WHERE decision = 'reversed'
  `;
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_entity_registry_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_TABLE_NAME = 'omni_entity_records' AND ROW(
        OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.ontology_version_id,
        OLD.entity_type_id, OLD.canonical_label, OLD.normalized_label_sha256,
        OLD.access_scope_sha256, OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.ontology_version_id,
        NEW.entity_type_id, NEW.canonical_label, NEW.normalized_label_sha256,
        NEW.access_scope_sha256, NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Entity identity and access scope are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF TG_TABLE_NAME = 'omni_entity_aliases' AND ROW(
        OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.entity_id,
        OLD.normalized_alias_sha256, OLD.access_scope_sha256, OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.entity_id,
        NEW.normalized_alias_sha256, NEW.access_scope_sha256, NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Entity alias identity and access scope are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_records_identity_immutable
    ON omni_entity_records
  `;
  await sql`
    CREATE TRIGGER omni_entity_records_identity_immutable
    BEFORE UPDATE ON omni_entity_records
    FOR EACH ROW EXECUTE FUNCTION omni_reject_entity_registry_identity_change()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_aliases_identity_immutable
    ON omni_entity_aliases
  `;
  await sql`
    CREATE TRIGGER omni_entity_aliases_identity_immutable
    BEFORE UPDATE ON omni_entity_aliases
    FOR EACH ROW EXECUTE FUNCTION omni_reject_entity_registry_identity_change()
  `;
  await ensureTenantIsolationPolicies(sql);
  await sql`
    DO $migration$
    DECLARE
      relation_name TEXT;
      policy_name TEXT;
    BEGIN
      FOREACH relation_name IN ARRAY ARRAY[
        'omni_entity_records',
        'omni_entity_aliases',
        'omni_entity_resolutions',
        'omni_entity_merge_reviews'
      ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation_name);
        policy_name := relation_name || '_actor_select';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, relation_name);
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING '
          || '(omni_system_scope_enabled() OR '
          || 'omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
          policy_name,
          relation_name
        );
        policy_name := relation_name || '_actor_insert';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, relation_name);
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK '
          || '(omni_system_scope_enabled() OR '
          || 'omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
          policy_name,
          relation_name
        );
      END LOOP;
      FOREACH relation_name IN ARRAY ARRAY[
        'omni_entity_records',
        'omni_entity_aliases'
      ] LOOP
        policy_name := relation_name || '_actor_update';
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, relation_name);
        EXECUTE format(
          'CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE USING '
          || '(omni_system_scope_enabled() OR '
          || 'omni_actor_scope_v1_allows(tenant_id, owner_actor_id)) '
          || 'WITH CHECK (omni_system_scope_enabled() OR '
          || 'omni_actor_scope_v1_allows(tenant_id, owner_actor_id))',
          policy_name,
          relation_name
        );
      END LOOP;
    END
    $migration$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON
          omni_entity_records,
          omni_entity_aliases
        TO omni_runtime;
        GRANT SELECT, INSERT ON
          omni_entity_resolutions,
          omni_entity_merge_reviews
        TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT SELECT, INSERT, UPDATE ON
          omni_entity_records,
          omni_entity_aliases
        TO omni_maintenance;
        GRANT SELECT, INSERT ON
          omni_entity_resolutions,
          omni_entity_merge_reviews
        TO omni_maintenance;
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityMemoryDeletionBarrier(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_entity_records
    ADD COLUMN IF NOT EXISTS lineage_memory_ids TEXT[] NOT NULL DEFAULT '{}'
  `;
  await sql`
    ALTER TABLE omni_entity_aliases
    ADD COLUMN IF NOT EXISTS lineage_memory_ids TEXT[] NOT NULL DEFAULT '{}'
  `;
  await sql`
    UPDATE omni_entity_records record
    SET lineage_memory_ids = COALESCE((
      SELECT array_agg(reference ->> 'referenceId' ORDER BY reference ->> 'referenceId')
      FROM jsonb_array_elements(record.contract -> 'lineage') reference
      WHERE reference ->> 'kind' = 'memory'
    ), '{}'::TEXT[])
  `;
  await sql`
    UPDATE omni_entity_aliases alias
    SET lineage_memory_ids = CASE
      WHEN alias.contract #>> '{lineage,kind}' = 'memory'
      THEN ARRAY[alias.contract #>> '{lineage,referenceId}']
      ELSE '{}'::TEXT[]
    END
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_records_memory_lineage_idx
    ON omni_entity_records USING GIN (lineage_memory_ids)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_aliases_memory_lineage_idx
    ON omni_entity_aliases USING GIN (lineage_memory_ids)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_entity_deleted_memory_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF omni_memory_ids_have_deletion_barrier(
        NEW.tenant_id,
        NEW.lineage_memory_ids
      ) THEN
        RAISE EXCEPTION 'Entity lineage references permanently forgotten memory'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_records_memory_deletion_barrier
    ON omni_entity_records
  `;
  await sql`
    CREATE TRIGGER omni_entity_records_memory_deletion_barrier
    BEFORE INSERT OR UPDATE OF lineage_memory_ids ON omni_entity_records
    FOR EACH ROW EXECUTE FUNCTION omni_reject_entity_deleted_memory_lineage()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_aliases_memory_deletion_barrier
    ON omni_entity_aliases
  `;
  await sql`
    CREATE TRIGGER omni_entity_aliases_memory_deletion_barrier
    BEFORE INSERT OR UPDATE OF lineage_memory_ids ON omni_entity_aliases
    FOR EACH ROW EXECUTE FUNCTION omni_reject_entity_deleted_memory_lineage()
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_entity_registry_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_TABLE_NAME = 'omni_entity_records' THEN
        IF ROW(
          OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.ontology_version_id,
          OLD.entity_type_id, OLD.normalized_label_sha256,
          OLD.access_scope_sha256, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.ontology_version_id,
          NEW.entity_type_id, NEW.normalized_label_sha256,
          NEW.access_scope_sha256, NEW.created_at
        ) THEN
          RAISE EXCEPTION 'Entity identity and access scope are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.canonical_label IS DISTINCT FROM NEW.canonical_label
          AND NOT (
            OLD.state <> 'retired'
            AND NEW.state = 'retired'
            AND NEW.canonical_label = '[forgotten]'
          )
        THEN
          RAISE EXCEPTION 'Entity labels may only be scrubbed on retirement'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF TG_TABLE_NAME = 'omni_entity_aliases' AND ROW(
        OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.entity_id,
        OLD.normalized_alias_sha256, OLD.access_scope_sha256, OLD.created_at
      ) IS DISTINCT FROM ROW(
        NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.entity_id,
        NEW.normalized_alias_sha256, NEW.access_scope_sha256, NEW.created_at
      ) THEN
        RAISE EXCEPTION 'Entity alias identity and access scope are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;

  await sql`
    DROP POLICY IF EXISTS omni_entity_memory_deletion_barrier
    ON omni_entity_records
  `;
  await sql`
    CREATE POLICY omni_entity_memory_deletion_barrier
    ON omni_entity_records
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(
        tenant_id,
        lineage_memory_ids
      )
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_entity_memory_deletion_barrier
    ON omni_entity_aliases
  `;
  await sql`
    CREATE POLICY omni_entity_memory_deletion_barrier
    ON omni_entity_aliases
    AS RESTRICTIVE
    FOR SELECT
    USING (
      NOT omni_memory_ids_have_deletion_barrier(
        tenant_id,
        lineage_memory_ids
      )
    )
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_entity_records record
        WHERE record.lineage_memory_ids IS DISTINCT FROM COALESCE((
          SELECT array_agg(reference ->> 'referenceId' ORDER BY reference ->> 'referenceId')
          FROM jsonb_array_elements(record.contract -> 'lineage') reference
          WHERE reference ->> 'kind' = 'memory'
        ), '{}'::TEXT[])
      ) OR EXISTS (
        SELECT 1
        FROM omni_entity_aliases alias
        WHERE alias.lineage_memory_ids IS DISTINCT FROM CASE
          WHEN alias.contract #>> '{lineage,kind}' = 'memory'
          THEN ARRAY[alias.contract #>> '{lineage,referenceId}']
          ELSE '{}'::TEXT[]
        END
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polname = 'omni_entity_memory_deletion_barrier'
          AND polrelid IN (
            'omni_entity_records'::regclass,
            'omni_entity_aliases'::regclass
          )
          AND NOT polpermissive
          AND polcmd = 'r'
      ) <> 2 OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgname IN (
          'omni_entity_records_memory_deletion_barrier',
          'omni_entity_aliases_memory_deletion_barrier'
        )
          AND NOT tgisinternal
      ) <> 2 THEN
        RAISE EXCEPTION 'Entity memory deletion barrier is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityMemoryLineageOwnerProbe(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_active_memory_lineage_owned_by(
      row_tenant_id TEXT,
      row_owner_actor_id TEXT,
      row_memory_ids TEXT[]
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        public.omni_current_tenant() = row_tenant_id
        AND public.omni_actor_scope_v1_allows(
          row_tenant_id,
          row_owner_actor_id
        )
        AND cardinality(row_memory_ids) BETWEEN 1 AND 64
        AND cardinality(ARRAY(
          SELECT DISTINCT memory_id COLLATE "C"
          FROM unnest(row_memory_ids) memory_id
          ORDER BY memory_id COLLATE "C"
        )) = cardinality(row_memory_ids)
        AND NOT public.omni_memory_ids_have_deletion_barrier(
          row_tenant_id,
          row_memory_ids
        )
        AND (
          SELECT count(*)
          FROM public.omni_memories memory
          WHERE memory.tenant_id = row_tenant_id
            AND memory.owner_actor_id = row_owner_actor_id
            AND memory.id = ANY(row_memory_ids)
            AND memory.access_contract_version = 1
            AND memory.access_state = 'scope_bound'
            AND memory.visibility = 'user_private'
            AND memory.claim_status = 'active'
        ) = cardinality(row_memory_ids),
        FALSE
      )
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_active_memory_lineage_owned_by(
      TEXT,
      TEXT,
      TEXT[]
    ) FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT EXECUTE ON FUNCTION omni_active_memory_lineage_owned_by(
          TEXT,
          TEXT,
          TEXT[]
        ) TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT EXECUTE ON FUNCTION omni_active_memory_lineage_owned_by(
          TEXT,
          TEXT,
          TEXT[]
        ) TO omni_maintenance;
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
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE procedure.proname = 'omni_active_memory_lineage_owned_by'
          AND namespace.nspname = current_schema()
          AND procedure.prosecdef
          AND procedure.provolatile = 's'
          AND pg_get_function_identity_arguments(procedure.oid) =
            'row_tenant_id text, row_owner_actor_id text, row_memory_ids text[]'
      ) THEN
        RAISE EXCEPTION 'Entity memory lineage owner probe is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityRegistryIdentityTriggerDispatch(sql: SqlClient) {
  await sql`
    CREATE OR REPLACE FUNCTION omni_reject_entity_registry_identity_change()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_TABLE_NAME = 'omni_entity_records' THEN
        IF ROW(
          OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.ontology_version_id,
          OLD.entity_type_id, OLD.normalized_label_sha256,
          OLD.access_scope_sha256, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.ontology_version_id,
          NEW.entity_type_id, NEW.normalized_label_sha256,
          NEW.access_scope_sha256, NEW.created_at
        ) THEN
          RAISE EXCEPTION 'Entity identity and access scope are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.canonical_label IS DISTINCT FROM NEW.canonical_label
          AND NOT (
            OLD.state <> 'retired'
            AND NEW.state = 'retired'
            AND NEW.canonical_label = '[forgotten]'
          )
        THEN
          RAISE EXCEPTION 'Entity labels may only be scrubbed on retirement'
            USING ERRCODE = '55000';
        END IF;
      ELSIF TG_TABLE_NAME = 'omni_entity_aliases' THEN
        IF ROW(
          OLD.tenant_id, OLD.id, OLD.owner_actor_id, OLD.entity_id,
          OLD.normalized_alias_sha256, OLD.access_scope_sha256, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.tenant_id, NEW.id, NEW.owner_actor_id, NEW.entity_id,
          NEW.normalized_alias_sha256, NEW.access_scope_sha256, NEW.created_at
        ) THEN
          RAISE EXCEPTION 'Entity alias identity and access scope are immutable'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        RAISE EXCEPTION 'Entity identity trigger is attached to an invalid relation'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DO $migration$
    BEGIN
      IF (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgname IN (
          'omni_entity_records_identity_immutable',
          'omni_entity_aliases_identity_immutable'
        )
          AND tgrelid IN (
            'omni_entity_records'::regclass,
            'omni_entity_aliases'::regclass
          )
          AND NOT tgisinternal
          AND tgenabled = 'O'
      ) <> 2 THEN
        RAISE EXCEPTION 'Entity identity trigger dispatch is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}

export async function ensureEntityEvidenceLineageBarrier(sql: SqlClient) {
  await sql`
    ALTER TABLE omni_entity_records
    ADD COLUMN IF NOT EXISTS lineage_evidence_unit_ids TEXT[] NOT NULL DEFAULT '{}'
  `;
  await sql`
    ALTER TABLE omni_entity_aliases
    ADD COLUMN IF NOT EXISTS lineage_evidence_unit_ids TEXT[] NOT NULL DEFAULT '{}'
  `;
  await sql`
    UPDATE omni_entity_records record
    SET lineage_evidence_unit_ids = CASE
      WHEN record.state = 'retired' THEN '{}'::TEXT[]
      ELSE COALESCE((
        SELECT array_agg(
          DISTINCT reference ->> 'referenceId'
          ORDER BY reference ->> 'referenceId'
        )
        FROM jsonb_array_elements(record.contract -> 'lineage') reference
        WHERE reference ->> 'kind' = 'evidence_unit'
      ), '{}'::TEXT[])
    END
  `;
  await sql`
    UPDATE omni_entity_aliases alias
    SET lineage_evidence_unit_ids = CASE
      WHEN alias.state = 'active'
        AND alias.contract #>> '{lineage,kind}' = 'evidence_unit'
      THEN ARRAY[alias.contract #>> '{lineage,referenceId}']
      ELSE '{}'::TEXT[]
    END
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_records_evidence_lineage_idx
    ON omni_entity_records USING GIN (lineage_evidence_unit_ids)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS omni_entity_aliases_evidence_lineage_idx
    ON omni_entity_aliases USING GIN (lineage_evidence_unit_ids)
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_active_evidence_lineage_owned_by(
      row_tenant_id TEXT,
      row_owner_actor_id TEXT,
      row_evidence_unit_ids TEXT[]
    )
    RETURNS BOOLEAN
    LANGUAGE SQL
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT COALESCE(
        public.omni_current_tenant() = row_tenant_id
        AND public.omni_actor_scope_v1_allows(
          row_tenant_id,
          row_owner_actor_id
        )
        AND cardinality(row_evidence_unit_ids) BETWEEN 1 AND 64
        AND cardinality(ARRAY(
          SELECT DISTINCT evidence_unit_id COLLATE "C"
          FROM unnest(row_evidence_unit_ids) evidence_unit_id
          ORDER BY evidence_unit_id COLLATE "C"
        )) = cardinality(row_evidence_unit_ids)
        AND (
          SELECT count(*)
          FROM public.omni_evidence_units evidence
          JOIN public.omni_source_items source_item
            ON source_item.tenant_id = evidence.tenant_id
           AND source_item.id = evidence.source_item_id
           AND source_item.current_revision_id = evidence.source_revision_id
          LEFT JOIN public.omni_source_sync_heads source_head
            ON source_head.tenant_id = evidence.tenant_id
           AND source_head.source_item_id = evidence.source_item_id
          WHERE evidence.tenant_id = row_tenant_id
            AND evidence.owner_actor_id = row_owner_actor_id
            AND evidence.id = ANY(row_evidence_unit_ids)
            AND evidence.visibility = 'user_private'
            AND evidence.workspace_id IS NULL
            AND evidence.project_id IS NULL
            AND evidence.mission_id IS NULL
            AND evidence.allowed_purpose_ids @> ARRAY[
              'agent.answer.claim-evidence-verification'
            ]::TEXT[]
            AND (
              evidence.retention_expires_at IS NULL
              OR evidence.retention_expires_at > CURRENT_TIMESTAMP
            )
            AND source_item.owner_actor_id = row_owner_actor_id
            AND source_item.visibility = 'user_private'
            AND source_item.workspace_id IS NULL
            AND source_item.project_id IS NULL
            AND source_item.mission_id IS NULL
            AND (
              source_item.retention_expires_at IS NULL
              OR source_item.retention_expires_at > CURRENT_TIMESTAMP
            )
            AND (
              source_head.source_item_id IS NULL
              OR (
                source_head.operation = 'upsert'
                AND NOT source_head.absence_observed
                AND source_head.source_revision_id = evidence.source_revision_id
                AND source_head.source_tombstone_id IS NULL
              )
            )
        ) = cardinality(row_evidence_unit_ids),
        FALSE
      )
    $function$
  `;
  await sql`
    REVOKE ALL ON FUNCTION omni_active_evidence_lineage_owned_by(
      TEXT,
      TEXT,
      TEXT[]
    ) FROM PUBLIC
  `;
  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_runtime') THEN
        GRANT EXECUTE ON FUNCTION omni_active_evidence_lineage_owned_by(
          TEXT,
          TEXT,
          TEXT[]
        ) TO omni_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omni_maintenance') THEN
        GRANT EXECUTE ON FUNCTION omni_active_evidence_lineage_owned_by(
          TEXT,
          TEXT,
          TEXT[]
        ) TO omni_maintenance;
      END IF;
    END
    $migration$
  `;

  await sql`
    CREATE OR REPLACE FUNCTION omni_validate_entity_evidence_lineage()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      contract_evidence_ids TEXT[];
    BEGIN
      IF TG_TABLE_NAME = 'omni_entity_records' THEN
        contract_evidence_ids := CASE
          WHEN NEW.state = 'retired' THEN '{}'::TEXT[]
          ELSE COALESCE((
            SELECT array_agg(
              DISTINCT reference ->> 'referenceId'
              ORDER BY reference ->> 'referenceId'
            )
            FROM jsonb_array_elements(NEW.contract -> 'lineage') reference
            WHERE reference ->> 'kind' = 'evidence_unit'
          ), '{}'::TEXT[])
        END;
      ELSIF TG_TABLE_NAME = 'omni_entity_aliases' THEN
        contract_evidence_ids := CASE
          WHEN NEW.state = 'active'
            AND NEW.contract #>> '{lineage,kind}' = 'evidence_unit'
          THEN ARRAY[NEW.contract #>> '{lineage,referenceId}']
          ELSE '{}'::TEXT[]
        END;
      ELSE
        RAISE EXCEPTION 'Entity evidence trigger is attached to an invalid relation'
          USING ERRCODE = '55000';
      END IF;

      IF NEW.lineage_evidence_unit_ids IS DISTINCT FROM contract_evidence_ids THEN
        RAISE EXCEPTION 'Entity evidence lineage index does not match its contract'
          USING ERRCODE = '23514';
      END IF;
      IF cardinality(contract_evidence_ids) > 0
        AND NOT omni_active_evidence_lineage_owned_by(
          NEW.tenant_id,
          NEW.owner_actor_id,
          contract_evidence_ids
        )
      THEN
        RAISE EXCEPTION 'Entity lineage references inactive or inaccessible evidence'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_records_evidence_lineage_barrier
    ON omni_entity_records
  `;
  await sql`
    CREATE TRIGGER omni_entity_records_evidence_lineage_barrier
    BEFORE INSERT OR UPDATE OF state, lineage_evidence_unit_ids, contract
    ON omni_entity_records
    FOR EACH ROW EXECUTE FUNCTION omni_validate_entity_evidence_lineage()
  `;
  await sql`
    DROP TRIGGER IF EXISTS omni_entity_aliases_evidence_lineage_barrier
    ON omni_entity_aliases
  `;
  await sql`
    CREATE TRIGGER omni_entity_aliases_evidence_lineage_barrier
    BEFORE INSERT OR UPDATE OF state, lineage_evidence_unit_ids, contract
    ON omni_entity_aliases
    FOR EACH ROW EXECUTE FUNCTION omni_validate_entity_evidence_lineage()
  `;

  await sql`
    DROP POLICY IF EXISTS omni_entity_evidence_lineage_barrier
    ON omni_entity_records
  `;
  await sql`
    CREATE POLICY omni_entity_evidence_lineage_barrier
    ON omni_entity_records
    AS RESTRICTIVE
    FOR SELECT
    USING (
      cardinality(lineage_evidence_unit_ids) = 0
      OR omni_system_scope_enabled()
      OR omni_active_evidence_lineage_owned_by(
        tenant_id,
        owner_actor_id,
        lineage_evidence_unit_ids
      )
    )
  `;
  await sql`
    DROP POLICY IF EXISTS omni_entity_evidence_lineage_barrier
    ON omni_entity_aliases
  `;
  await sql`
    CREATE POLICY omni_entity_evidence_lineage_barrier
    ON omni_entity_aliases
    AS RESTRICTIVE
    FOR SELECT
    USING (
      cardinality(lineage_evidence_unit_ids) = 0
      OR omni_system_scope_enabled()
      OR omni_active_evidence_lineage_owned_by(
        tenant_id,
        owner_actor_id,
        lineage_evidence_unit_ids
      )
    )
  `;

  await sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM omni_entity_records record
        WHERE record.lineage_evidence_unit_ids IS DISTINCT FROM CASE
          WHEN record.state = 'retired' THEN '{}'::TEXT[]
          ELSE COALESCE((
            SELECT array_agg(
              DISTINCT reference ->> 'referenceId'
              ORDER BY reference ->> 'referenceId'
            )
            FROM jsonb_array_elements(record.contract -> 'lineage') reference
            WHERE reference ->> 'kind' = 'evidence_unit'
          ), '{}'::TEXT[])
        END
      ) OR EXISTS (
        SELECT 1
        FROM omni_entity_aliases alias
        WHERE alias.lineage_evidence_unit_ids IS DISTINCT FROM CASE
          WHEN alias.state = 'active'
            AND alias.contract #>> '{lineage,kind}' = 'evidence_unit'
          THEN ARRAY[alias.contract #>> '{lineage,referenceId}']
          ELSE '{}'::TEXT[]
        END
      ) OR (
        SELECT count(*)
        FROM pg_policy
        WHERE polname = 'omni_entity_evidence_lineage_barrier'
          AND polrelid IN (
            'omni_entity_records'::regclass,
            'omni_entity_aliases'::regclass
          )
          AND NOT polpermissive
          AND polcmd = 'r'
      ) <> 2 OR (
        SELECT count(*)
        FROM pg_trigger
        WHERE tgname IN (
          'omni_entity_records_evidence_lineage_barrier',
          'omni_entity_aliases_evidence_lineage_barrier'
        )
          AND NOT tgisinternal
      ) <> 2 THEN
        RAISE EXCEPTION 'Entity evidence lineage barrier is invalid'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `;
}
