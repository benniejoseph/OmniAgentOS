CREATE TABLE IF NOT EXISTS public.omni_custom_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  tool_ids TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  knowledge_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, actor_id, slug)
);
CREATE INDEX IF NOT EXISTS omni_custom_skills_owner_updated_idx
ON public.omni_custom_skills (tenant_id, actor_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS public.omni_custom_agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  accent TEXT NOT NULL DEFAULT 'emerald',
  model_policy TEXT NOT NULL DEFAULT 'auto',
  autonomy TEXT NOT NULL DEFAULT 'governed',
  approval_policy TEXT NOT NULL DEFAULT 'risk_based',
  memory_scope TEXT NOT NULL DEFAULT 'all',
  skill_ids TEXT[] NOT NULL DEFAULT '{}',
  tool_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, actor_id, slug)
);
CREATE INDEX IF NOT EXISTS omni_custom_agents_owner_updated_idx
ON public.omni_custom_agents (tenant_id, actor_id, updated_at DESC);
ALTER TABLE public.omni_custom_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_custom_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE public.omni_custom_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_custom_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_tenant_isolation ON public.omni_custom_skills
FOR ALL USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
CREATE POLICY omni_tenant_isolation ON public.omni_custom_agents
FOR ALL USING (public.omni_tenant_visible(tenant_id))
WITH CHECK (public.omni_tenant_visible(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.omni_custom_skills TO omni_runtime, omni_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.omni_custom_agents TO omni_runtime, omni_maintenance;
GRANT SELECT ON public.omni_custom_skills TO omni_backup;
GRANT SELECT ON public.omni_custom_agents TO omni_backup;
INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)
VALUES (26, 'custom_agent_and_skill_studio', 'b9330011742af71d64d932ad34bd55d374d7b936d2db88a7e502f50a29aec04c', NOW());
