import { z } from "zod";

const ids = z.array(z.string().min(1).max(120)).max(50).default([]);

export const skillInputSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(2).max(500),
  instructions: z.string().min(10).max(12_000),
  category: z.enum(["research", "creation", "analysis", "memory", "automation", "personal"]),
  status: z.enum(["active", "disabled"]).default("active"),
  toolIds: ids,
  tags: z.array(z.string().min(1).max(100)).max(30).default([]),
  knowledgeTags: z.array(z.string().min(1).max(100)).max(30).default([]),
}).strict();

export const skillPatchSchema = skillInputSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one change is required.");

export const customAgentInputSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(120),
  description: z.string().min(2).max(700),
  instructions: z.string().min(10).max(12_000),
  status: z.enum(["ready", "learning", "paused"]).default("ready"),
  accent: z.enum(["emerald", "blue", "amber", "violet", "rose"]).default("emerald"),
  modelPolicy: z.enum(["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"]).default("auto"),
  autonomy: z.enum(["assist", "governed", "execute"]).default("governed"),
  approvalPolicy: z.enum(["always", "risk_based", "read_only"]).default("risk_based"),
  memoryScope: z.enum(["session", "project", "all"]).default("all"),
  skillIds: ids,
  toolIds: ids,
}).strict();

export const customAgentPatchSchema = customAgentInputSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one change is required.");
