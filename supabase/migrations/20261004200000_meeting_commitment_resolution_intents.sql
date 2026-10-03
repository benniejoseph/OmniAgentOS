BEGIN;
SELECT pg_advisory_xact_lock(271828182);
SELECT set_config('omni.system_scope', 'true', true);
SELECT set_config('omni.system_reason', 'ordered schema migration', true);
SELECT set_config('search_path', 'public, pg_catalog', true);
DO $migration$
BEGIN
  IF (SELECT MAX(version) FROM public.omni_schema_version) IS DISTINCT FROM 219 OR (
    SELECT count(*) FROM public.omni_schema_version WHERE version = 219
      AND name = 'responsibility_notifications_v1'
      AND checksum = 'b7781a7c49662c506457a340ef81b0f31ceb683587d8bff62391e246efbacaf2'
  ) <> 1 THEN RAISE EXCEPTION 'Meeting resolution intent predecessor is invalid' USING ERRCODE = '55000'; END IF;
END
$migration$;

-- Immutable decision admission and bounded append-only phase acknowledgements.
-- There is no claim expiry, lease takeover, automatic retry, or grant to send.
CREATE TABLE public.omni_meeting_commitment_resolution_intents (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
  effective_access_class TEXT NOT NULL CHECK (effective_access_class IN ('owner_private','project_members','workspace_members')),
  proposal_sha256 TEXT NOT NULL CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  intent_snapshot JSONB NOT NULL CHECK (jsonb_typeof(intent_snapshot) = 'object' AND pg_column_size(intent_snapshot) <= 262144),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,proposal_id),
  UNIQUE (tenant_id,workspace_id,proposal_id,owner_actor_id,request_sha256,meeting_id),
  FOREIGN KEY (tenant_id,workspace_id,proposal_id) REFERENCES public.omni_meeting_commitment_proposals(tenant_id,workspace_id,proposal_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (intent_snapshot ?& ARRAY['schemaVersion','contract','tenantId','workspaceId','meetingId','proposalId','proposalSha256','ownerActorId','request','requestSha256','createdAt']),
  CHECK (intent_snapshot - ARRAY['schemaVersion','contract','tenantId','workspaceId','meetingId','proposalId','proposalSha256','ownerActorId','request','requestSha256','createdAt'] = '{}'::JSONB),
  CHECK (COALESCE(intent_snapshot->'schemaVersion' = '1'::JSONB, FALSE)),
  CHECK (COALESCE(intent_snapshot->>'contract' = 'meeting-commitment-resolution-intent:1', FALSE)),
  CHECK (intent_snapshot->>'tenantId' IS NOT DISTINCT FROM tenant_id),
  CHECK (intent_snapshot->>'workspaceId' IS NOT DISTINCT FROM workspace_id),
  CHECK (intent_snapshot->>'meetingId' IS NOT DISTINCT FROM meeting_id),
  CHECK (intent_snapshot->>'proposalId' IS NOT DISTINCT FROM proposal_id),
  CHECK (intent_snapshot->>'ownerActorId' IS NOT DISTINCT FROM owner_actor_id),
  CHECK (intent_snapshot->>'proposalSha256' IS NOT DISTINCT FROM proposal_sha256),
  CHECK (intent_snapshot->>'requestSha256' IS NOT DISTINCT FROM request_sha256),
  CHECK (COALESCE(jsonb_typeof(intent_snapshot->'request') = 'object' AND intent_snapshot->'request'->>'decision' IN ('confirmed','dismissed'), FALSE)),
  CHECK (CASE intent_snapshot->'request'->>'decision'
    WHEN 'dismissed' THEN intent_snapshot->'request' = '{"decision":"dismissed"}'::JSONB
    WHEN 'confirmed' THEN COALESCE(
      intent_snapshot->'request' ?& ARRAY['decision','ownerParticipantId','dueAt','communication'] AND
      (intent_snapshot->'request') - ARRAY['decision','ownerParticipantId','dueAt','communication'] = '{}'::JSONB AND
      jsonb_typeof(intent_snapshot->'request'->'ownerParticipantId') = 'string' AND
      length(intent_snapshot->'request'->>'ownerParticipantId') BETWEEN 1 AND 240 AND
      jsonb_typeof(intent_snapshot->'request'->'dueAt') IN ('string','null') AND
      jsonb_typeof(intent_snapshot->'request'->'communication') IN ('object','null'), FALSE)
    ELSE FALSE END),
  CHECK (CASE WHEN intent_snapshot->'request'->>'decision' = 'dismissed' OR
    intent_snapshot->'request'->'communication' = 'null'::JSONB THEN TRUE ELSE COALESCE(
      intent_snapshot->'request'->'communication' ?& ARRAY['connectionId','policyId','recipientParticipantId','subject','body'] AND
      (intent_snapshot->'request'->'communication') - ARRAY['connectionId','policyId','recipientParticipantId','subject','body'] = '{}'::JSONB AND
      jsonb_typeof(intent_snapshot->'request'->'communication'->'connectionId') IN ('string','null') AND
      intent_snapshot->'request'->'communication'->>'policyId' ~ '^contact_policy:[0-9a-f-]{36}$' AND
      length(intent_snapshot->'request'->'communication'->>'recipientParticipantId') BETWEEN 1 AND 240 AND
      length(intent_snapshot->'request'->'communication'->>'subject') BETWEEN 1 AND 998 AND
      length(intent_snapshot->'request'->'communication'->>'body') BETWEEN 1 AND 50000, FALSE) END),
  CHECK ((intent_snapshot->>'createdAt')::TIMESTAMPTZ IS NOT DISTINCT FROM created_at)
);
CREATE TABLE public.omni_meeting_commitment_resolution_progress (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN (
    'work_started','work_completed','draft_started','draft_completed',
    'meeting_started','meeting_completed','resolution_started','interrupted'
  )),
  phase_order INTEGER NOT NULL CHECK (phase_order BETWEEN 1 AND 8),
  phase_snapshot JSONB NOT NULL CHECK (jsonb_typeof(phase_snapshot) = 'object' AND pg_column_size(phase_snapshot) <= 4096),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,proposal_id,phase),
  UNIQUE (tenant_id,workspace_id,proposal_id,phase_order),
  FOREIGN KEY (tenant_id,workspace_id,proposal_id,owner_actor_id,request_sha256,meeting_id)
    REFERENCES public.omni_meeting_commitment_resolution_intents(tenant_id,workspace_id,proposal_id,owner_actor_id,request_sha256,meeting_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (phase_snapshot ?& ARRAY['phase','at','resourceId','evidenceSha256']),
  CHECK (phase_snapshot - ARRAY['phase','at','resourceId','evidenceSha256'] = '{}'::JSONB),
  CHECK (phase_snapshot->>'phase' IS NOT DISTINCT FROM phase),
  CHECK ((phase_snapshot->>'at')::TIMESTAMPTZ IS NOT DISTINCT FROM recorded_at),
  CHECK (CASE WHEN phase LIKE '%_completed' THEN COALESCE(
    jsonb_typeof(phase_snapshot->'resourceId') = 'string' AND
    length(phase_snapshot->>'resourceId') BETWEEN 1 AND 240 AND
    jsonb_typeof(phase_snapshot->'evidenceSha256') = 'string', FALSE)
    ELSE phase_snapshot->'resourceId' = 'null'::JSONB AND phase_snapshot->'evidenceSha256' = 'null'::JSONB END),
  CHECK (phase_snapshot->>'evidenceSha256' IS NULL OR phase_snapshot->>'evidenceSha256' ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION public.omni_admit_meeting_resolution_intent_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog,public AS $function$
DECLARE
  proposal public.omni_meeting_commitment_proposals%ROWTYPE;
  intent public.omni_meeting_commitment_resolution_intents%ROWTYPE;
  phases TEXT[];
  plan TEXT[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || NEW.workspace_id || ':' || NEW.proposal_id || ':resolution',0));
  IF TG_TABLE_NAME = 'omni_meeting_commitment_resolution_intents' THEN
    SELECT * INTO proposal FROM public.omni_meeting_commitment_proposals
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND proposal_id = NEW.proposal_id;
    IF NOT FOUND OR proposal.meeting_id <> NEW.meeting_id OR proposal.owner_actor_id <> NEW.owner_actor_id
      OR proposal.project_id <> NEW.project_id OR proposal.effective_access_class <> NEW.effective_access_class
      OR proposal.proposal_sha256 <> NEW.proposal_sha256 THEN
      RAISE EXCEPTION 'Resolution intent requires the exact proposal owner and evidence' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.omni_meeting_commitment_resolutions
      WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND proposal_id = NEW.proposal_id) THEN
      RAISE EXCEPTION 'Legacy accepted evidence cannot acquire a new decision identity' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO intent FROM public.omni_meeting_commitment_resolution_intents
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND proposal_id = NEW.proposal_id
      AND owner_actor_id = NEW.owner_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'An exact owner decision claim is required' USING ERRCODE = '55000'; END IF;
  SELECT COALESCE(array_agg(phase ORDER BY phase_order),ARRAY[]::TEXT[]) INTO phases
    FROM public.omni_meeting_commitment_resolution_progress
    WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND proposal_id = NEW.proposal_id;
  IF TG_TABLE_NAME = 'omni_meeting_commitment_resolution_progress' THEN
    IF NEW.request_sha256 <> intent.request_sha256 OR NEW.meeting_id <> intent.meeting_id OR
      NEW.phase_order <> cardinality(phases) + 1 OR 'interrupted' = ANY(phases) OR
      EXISTS (SELECT 1 FROM public.omni_meeting_commitment_resolutions WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND proposal_id = NEW.proposal_id) THEN
      RAISE EXCEPTION 'Resolution progress cannot replace, resume or reinterpret a claimed effect' USING ERRCODE = '55000';
    END IF;
    IF NEW.phase = 'interrupted' THEN RETURN NEW; END IF;
    IF intent.intent_snapshot->'request'->>'decision' = 'dismissed' THEN plan := ARRAY['resolution_started'];
    ELSIF intent.intent_snapshot->'request'->'communication' <> 'null'::JSONB THEN
      plan := ARRAY['work_started','work_completed','draft_started','draft_completed','meeting_started','meeting_completed','resolution_started'];
    ELSE plan := ARRAY['work_started','work_completed','meeting_started','meeting_completed','resolution_started']; END IF;
    IF plan[NEW.phase_order] IS DISTINCT FROM NEW.phase OR plan[1:cardinality(phases)] IS DISTINCT FROM phases THEN
      RAISE EXCEPTION 'Resolution progress is outside the exact claimed sequence' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- Existing accepted rows are untouched. Every new terminal row must match its
  -- admitted decision and completed child identities in the same transaction.
  IF NEW.meeting_id <> intent.meeting_id OR NEW.proposal_sha256 <> intent.proposal_sha256 OR
    NEW.decision IS DISTINCT FROM intent.intent_snapshot->'request'->>'decision' OR
    phases[cardinality(phases)] IS DISTINCT FROM 'resolution_started' THEN
    RAISE EXCEPTION 'Resolution has no exact prepared decision' USING ERRCODE = '55000';
  END IF;
  IF NEW.decision = 'confirmed' AND (
    NEW.resolution_snapshot->>'ownerParticipantId' IS DISTINCT FROM intent.intent_snapshot->'request'->>'ownerParticipantId' OR
    NEW.resolution_snapshot->>'dueAt' IS DISTINCT FROM intent.intent_snapshot->'request'->>'dueAt' OR
    NEW.resolution_snapshot->>'communicationPolicyId' IS DISTINCT FROM intent.intent_snapshot->'request'->'communication'->>'policyId' OR
    NEW.work_item_id IS DISTINCT FROM (SELECT phase_snapshot->>'resourceId' FROM public.omni_meeting_commitment_resolution_progress WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND proposal_id=NEW.proposal_id AND phase='work_completed') OR
    NEW.draft_id IS DISTINCT FROM (SELECT phase_snapshot->>'resourceId' FROM public.omni_meeting_commitment_resolution_progress WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND proposal_id=NEW.proposal_id AND phase='draft_completed') OR
    NEW.resolution_snapshot->>'meetingRevisionId' IS DISTINCT FROM (SELECT phase_snapshot->>'resourceId' FROM public.omni_meeting_commitment_resolution_progress WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND proposal_id=NEW.proposal_id AND phase='meeting_completed')
  ) THEN RAISE EXCEPTION 'Resolution differs from its immutable request or child acknowledgements' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END
$function$;

DO $policies$
DECLARE table_name TEXT; role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['omni_meeting_commitment_resolution_intents','omni_meeting_commitment_resolution_progress'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY omni_tenant_isolation ON public.%I FOR ALL USING (public.omni_tenant_visible(tenant_id)) WITH CHECK (public.omni_tenant_visible(tenant_id))',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL USING ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_canonical(tenant_id,owner_actor_id)) WITH CHECK ((SELECT public.omni_system_scope_enabled()) OR public.omni_actor_scope_v1_allows_canonical(tenant_id,owner_actor_id))',table_name || '_owner',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.omni_protect_meeting_commitment_evidence_v1()',table_name || '_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.omni_protect_meeting_commitment_evidence_v1()',table_name || '_no_truncate',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.omni_admit_meeting_resolution_intent_v1()',table_name || '_admit',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['omni_runtime','omni_maintenance'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',table_name,role_name);
        EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I',table_name,role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='omni_backup') THEN EXECUTE format('GRANT SELECT ON public.%I TO omni_backup',table_name); END IF;
  END LOOP;
END
$policies$;
CREATE POLICY omni_meeting_resolution_intent_read ON public.omni_meeting_commitment_resolution_intents AS RESTRICTIVE FOR SELECT
  USING (public.omni_meeting_access_v1_allows(tenant_id,workspace_id,project_id,owner_actor_id,effective_access_class));
CREATE POLICY omni_meeting_resolution_progress_read ON public.omni_meeting_commitment_resolution_progress AS RESTRICTIVE FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.omni_meeting_commitment_resolution_intents intent
    WHERE intent.tenant_id=omni_meeting_commitment_resolution_progress.tenant_id
      AND intent.workspace_id=omni_meeting_commitment_resolution_progress.workspace_id
      AND intent.proposal_id=omni_meeting_commitment_resolution_progress.proposal_id));
CREATE POLICY omni_meeting_resolution_intent_write ON public.omni_meeting_commitment_resolution_intents AS RESTRICTIVE FOR INSERT
  WITH CHECK (public.omni_meeting_write_v1_allows(tenant_id,workspace_id,project_id,owner_actor_id,effective_access_class));
CREATE POLICY omni_meeting_resolution_progress_write ON public.omni_meeting_commitment_resolution_progress AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.omni_meeting_commitment_resolution_intents intent
    WHERE intent.tenant_id=omni_meeting_commitment_resolution_progress.tenant_id
      AND intent.workspace_id=omni_meeting_commitment_resolution_progress.workspace_id
      AND intent.proposal_id=omni_meeting_commitment_resolution_progress.proposal_id
      AND public.omni_meeting_write_v1_allows(intent.tenant_id,intent.workspace_id,intent.project_id,intent.owner_actor_id,intent.effective_access_class)));
CREATE TRIGGER omni_meeting_commitment_resolution_requires_intent
  BEFORE INSERT ON public.omni_meeting_commitment_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.omni_admit_meeting_resolution_intent_v1();
REVOKE ALL ON FUNCTION public.omni_admit_meeting_resolution_intent_v1() FROM PUBLIC;
INSERT INTO public.omni_schema_version(version,name,checksum,applied_at)
VALUES (220,'meeting_commitment_resolution_intents_v1','45e63154aeaca286c2da9d898873be0e26fa3a2412ab58ac22a373d1f759339b',clock_timestamp());
COMMIT;
