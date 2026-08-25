export type SkillCategory = "research" | "creation" | "analysis" | "memory" | "automation" | "personal";
export type SkillStatus = "active" | "disabled";

export type AgentSkill = {
  id: string;
  tenantId: string;
  actorId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  category: SkillCategory;
  status: SkillStatus;
  version: number;
  toolIds: string[];
  tags: string[];
  knowledgeTags: string[];
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CustomAgentStatus = "ready" | "learning" | "paused";
export type AgentAccent = "emerald" | "blue" | "amber" | "violet" | "rose";
export type AgentModelPolicy = "auto" | "openai_fast" | "openai_reasoning" | "gemini_fast";
export type AgentAutonomy = "assist" | "governed" | "execute";
export type AgentApprovalPolicy = "always" | "risk_based" | "read_only";
export type AgentMemoryScope = "session" | "project" | "all";

export type CustomAgentDefinition = {
  id: string;
  tenantId: string;
  actorId: string;
  slug: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  status: CustomAgentStatus;
  accent: AgentAccent;
  modelPolicy: AgentModelPolicy;
  autonomy: AgentAutonomy;
  approvalPolicy: AgentApprovalPolicy;
  memoryScope: AgentMemoryScope;
  skillIds: string[];
  toolIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type AgentBuilderLedger = {
  skills: AgentSkill[];
  agents: CustomAgentDefinition[];
};
