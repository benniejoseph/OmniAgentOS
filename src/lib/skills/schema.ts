import { z } from "zod";

const ids = z.array(z.string().min(1).max(120)).max(50);
const tags = z.array(z.string().min(1).max(100)).max(30);

const skillFields = {
  name: z.string().min(2).max(120),
  description: z.string().min(2).max(500),
  instructions: z.string().min(10).max(12_000),
  category: z.enum(["research", "creation", "analysis", "memory", "automation", "personal"]),
  status: z.enum(["active", "disabled"]),
  toolIds: ids,
  tags,
  knowledgeTags: tags,
};

export const skillInputSchema = z.object({
  ...skillFields,
  status: skillFields.status.default("active"),
  toolIds: skillFields.toolIds.default([]),
  tags: skillFields.tags.default([]),
  knowledgeTags: skillFields.knowledgeTags.default([]),
}).strict();

export const skillPatchSchema = z.object(skillFields).partial().strict().refine((value) => Object.keys(value).length > 0, "At least one change is required.");

const customAgentFields = {
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(120),
  description: z.string().min(2).max(700),
  instructions: z.string().min(10).max(12_000),
  status: z.enum(["ready", "learning", "paused"]),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]),
  modelPolicy: z.enum(["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"]),
  autonomy: z.enum(["assist", "governed", "execute"]),
  approvalPolicy: z.enum(["always", "risk_based", "read_only"]),
  memoryScope: z.enum(["session", "project", "all"]),
  skillIds: ids,
  toolIds: ids,
};

export const customAgentInputSchema = z.object({
  ...customAgentFields,
  status: customAgentFields.status.default("ready"),
  accent: customAgentFields.accent.default("emerald"),
  modelPolicy: customAgentFields.modelPolicy.default("auto"),
  autonomy: customAgentFields.autonomy.default("governed"),
  approvalPolicy: customAgentFields.approvalPolicy.default("risk_based"),
  memoryScope: customAgentFields.memoryScope.default("all"),
  skillIds: customAgentFields.skillIds.default([]),
  toolIds: customAgentFields.toolIds.default([]),
}).strict();

export const customAgentPatchSchema = z.object(customAgentFields).partial().strict().refine((value) => Object.keys(value).length > 0, "At least one change is required.");
