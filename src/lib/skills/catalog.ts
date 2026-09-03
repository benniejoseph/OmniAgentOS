import type { AgentSkill } from "@/lib/skills/types";

const createdAt = "2026-01-01T00:00:00.000Z";

export const builtInSkills: AgentSkill[] = [
  {
    id: "core.research", tenantId: "system", actorId: "system", slug: "evidence-research", name: "Evidence research",
    description: "Find, compare, and synthesize source-backed information while separating fact from inference.",
    instructions: "Decompose the question, retrieve current and durable evidence, compare sources, cite every material claim, and state unresolved uncertainty.",
    category: "research", status: "active", version: 1, toolIds: ["web.search", "knowledge.search", "memory.search"], tags: ["research", "citations"], knowledgeTags: [], builtIn: true, createdAt, updatedAt: createdAt,
  },
  {
    id: "core.builder", tenantId: "system", actorId: "system", slug: "verified-builder", name: "Verified builder",
    description: "Turn an outcome into a concrete artifact and verify it against explicit acceptance criteria.",
    instructions: "Clarify the deliverable, produce the smallest complete artifact, run available verification, and report exactly what changed and what remains.",
    category: "creation", status: "active", version: 1, toolIds: ["knowledge.search", "http.request"], tags: ["build", "verify"], knowledgeTags: [], builtIn: true, createdAt, updatedAt: createdAt,
  },
  {
    id: "core.critic", tenantId: "system", actorId: "system", slug: "adversarial-review", name: "Adversarial review",
    description: "Challenge assumptions, unsafe actions, unsupported claims, and incomplete verification.",
    instructions: "Inspect the proposed work for missing evidence, unsafe effects, edge cases, and weak success criteria. Block consequential work when evidence is insufficient.",
    category: "analysis", status: "active", version: 1, toolIds: ["knowledge.search", "runs.list"], tags: ["review", "safety"], knowledgeTags: [], builtIn: true, createdAt, updatedAt: createdAt,
  },
  {
    id: "core.memory", tenantId: "system", actorId: "system", slug: "memory-curation", name: "Memory curation",
    description: "Retrieve, reconcile, and retain personal context with provenance and contradiction awareness.",
    instructions: "Prefer explicit user corrections and newer grounded claims. Preserve provenance, mark superseded information, and never turn uncertainty into a durable fact.",
    category: "memory", status: "active", version: 1, toolIds: ["memory.search", "memory.write", "memory.correct", "memory.forget", "knowledge.search", "knowledge.ingest"], tags: ["memory", "provenance"], knowledgeTags: [], builtIn: true, createdAt, updatedAt: createdAt,
  },
];

export function getBuiltInSkill(id: string) {
  return builtInSkills.find((skill) => skill.id === id);
}
