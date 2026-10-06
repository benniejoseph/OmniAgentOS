import type { AgentSkill, SkillCategory } from "@/lib/skills/types";

const createdAt = "2026-01-01T00:00:00.000Z";

type BuiltInSkillDefinition = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  category: SkillCategory;
  toolIds: string[];
  tags: string[];
};

function builtInSkill(definition: BuiltInSkillDefinition): AgentSkill {
  return {
    ...definition,
    tenantId: "system",
    actorId: "system",
    status: "active",
    version: 1,
    knowledgeTags: [],
    builtIn: true,
    createdAt,
    updatedAt: createdAt,
  };
}

export const builtInSkills: AgentSkill[] = [
  builtInSkill({
    id: "core.research",
    slug: "evidence-research",
    name: "Evidence research",
    description: "Find, compare, and synthesize source-backed information while separating fact from inference.",
    instructions: "Decompose the question, retrieve current and durable evidence, compare sources, cite every material claim, and state unresolved uncertainty.",
    category: "research",
    toolIds: ["web.search", "knowledge.search", "memory.search"],
    tags: ["research", "citations"],
  }),
  builtInSkill({
    id: "core.builder",
    slug: "verified-builder",
    name: "Verified builder",
    description: "Turn an outcome into a concrete artifact and verify it against explicit acceptance criteria.",
    instructions: "Clarify the deliverable, produce the smallest complete artifact, run available verification, and report exactly what changed and what remains.",
    category: "creation",
    toolIds: ["web.search", "knowledge.search", "app.projects.builder.show", "app.projects.builder.create", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.file.delete", "app.projects.builder.command.run", "app.projects.builder.checkpoint.create", "app.projects.builder.repositories.list", "app.projects.builder.repository.bind", "app.projects.builder.repository.checkout", "app.projects.builder.delivery.create", "app.projects.builder.deployment.preview", "app.projects.builder.deployment.refresh", "app.projects.builder.release.preview", "app.projects.builder.release.refresh"],
    tags: ["build", "verify", "deliver"],
  }),
  builtInSkill({
    id: "core.critic",
    slug: "adversarial-review",
    name: "Adversarial review",
    description: "Challenge assumptions, unsafe actions, unsupported claims, and incomplete verification.",
    instructions: "Inspect the proposed work for missing evidence, unsafe effects, edge cases, and weak success criteria. Block consequential work when evidence is insufficient.",
    category: "analysis",
    toolIds: ["knowledge.search", "runs.list", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.verification.show"],
    tags: ["review", "safety"],
  }),
  builtInSkill({
    id: "core.memory",
    slug: "memory-curation",
    name: "Memory curation",
    description: "Retrieve, reconcile, and retain personal context with provenance and contradiction awareness.",
    instructions: "Prefer explicit user corrections and newer grounded claims. Preserve provenance, mark superseded information, and never turn uncertainty into a durable fact.",
    category: "memory",
    toolIds: ["memory.search", "memory.write", "memory.correct", "memory.forget", "knowledge.search", "knowledge.ingest"],
    tags: ["memory", "provenance"],
  }),

  builtInSkill({
    id: "productivity.daily-focus",
    slug: "daily-focus-planner",
    name: "Daily focus planner",
    description: "Turn commitments, deadlines, and available time into a realistic plan for the day.",
    instructions: "Review the current agenda and commitments, then choose at most three meaningful outcomes. Separate urgent from important work, protect focus time, expose conflicts, and leave recovery space. Never invent a commitment or change the schedule without a governed action.",
    category: "personal",
    toolIds: ["app.today.show", "app.today.agenda.show", "app.today.brief.show", "app.today.brief.generate", "app.today.item.create", "app.today.item.update", "app.projects.list", "app.projects.show", "app.meetings.commitments.list", "memory.search"],
    tags: ["productivity", "planning", "focus"],
  }),
  builtInSkill({
    id: "productivity.project-planning",
    slug: "outcome-project-planning",
    name: "Project planning",
    description: "Convert an outcome into milestones, small work items, dependencies, risks, and verification gates.",
    instructions: "Begin with the desired outcome and acceptance criteria. Decompose it into independently verifiable milestones, identify dependencies and risks, keep work items small, and define the next executable action. Prefer an explicit deterministic workflow for repeatable procedures.",
    category: "automation",
    toolIds: ["app.projects.list", "app.projects.show", "app.projects.create", "app.projects.update", "app.projects.plan", "app.work_items.create", "app.work_items.update", "app.workflows.plan", "knowledge.search", "memory.search"],
    tags: ["productivity", "projects", "planning"],
  }),
  builtInSkill({
    id: "productivity.meeting-steward",
    slug: "meeting-steward",
    name: "Meeting preparation & follow-through",
    description: "Prepare useful meetings and turn decisions, owners, and due dates into accountable follow-through.",
    instructions: "Before a meeting, establish the outcome, context, agenda, and open decisions. Afterwards, distinguish decisions from discussion, name owners and due dates, and surface unresolved commitments. Never create or resolve a commitment unless the governed action matches the user's intent.",
    category: "personal",
    toolIds: ["app.meetings.list", "app.meetings.show", "app.meetings.create", "app.meetings.update", "app.meetings.commitments.list", "app.meetings.commitments.propose", "app.meetings.commitments.resolve", "app.today.item.create", "memory.search"],
    tags: ["productivity", "meetings", "commitments"],
  }),
  builtInSkill({
    id: "productivity.decision-memo",
    slug: "decision-memo",
    name: "Decision memo",
    description: "Frame a consequential choice with evidence, trade-offs, reversibility, and a clear recommendation.",
    instructions: "State the decision, constraints, and deadline. Present viable options, strongest evidence, assumptions, failure modes, reversibility, and second-order effects. Recommend one option with confidence and specify what new evidence would change the recommendation.",
    category: "analysis",
    toolIds: ["web.search", "knowledge.search", "memory.search", "app.projects.list", "app.projects.show"],
    tags: ["productivity", "decisions", "strategy"],
  }),

  builtInSkill({
    id: "design.product-ux",
    slug: "product-ux-design",
    name: "Product & UX design",
    description: "Shape useful, coherent product experiences from user goals through implementable interaction details.",
    instructions: "Start with the user's job, context, constraints, and success signal. Map the main flow and edge states before styling. Establish hierarchy, responsive behavior, accessibility, loading, empty, error, and recovery states. Make distinctive choices that fit the product instead of applying generic decoration, then verify the implemented experience.",
    category: "creation",
    toolIds: ["web.search", "knowledge.search", "memory.search", "app.assets.list", "app.assets.show", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.checkpoint.create", "app.projects.builder.verification.run", "app.projects.builder.verification.show"],
    tags: ["design", "ux", "product", "responsive"],
  }),
  builtInSkill({
    id: "design.systems-accessibility",
    slug: "design-systems-accessibility",
    name: "Design systems & accessibility",
    description: "Create consistent interface systems with reusable tokens, components, interaction states, and inclusive behavior.",
    instructions: "Audit existing patterns before adding new ones. Reuse semantic tokens and components, define every interactive state, preserve keyboard and assistive-technology access, and check contrast, focus, target size, motion, and responsive behavior. Fix the system-level cause when repeated inconsistency is found and verify affected surfaces.",
    category: "analysis",
    toolIds: ["web.search", "knowledge.search", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.checkpoint.create", "app.projects.builder.verification.run", "app.projects.builder.verification.show"],
    tags: ["design", "design-system", "accessibility", "components"],
  }),
  builtInSkill({
    id: "design.visual-critique",
    slug: "visual-critique-polish",
    name: "Visual critique & polish",
    description: "Diagnose hierarchy, composition, typography, spacing, color, motion, and usability problems in an interface.",
    instructions: "Evaluate the actual screen against its task and product language. Identify the few issues with the highest user impact, explain the visual principle behind each, and propose specific changes. Preserve strengths and intentional brand choices. Treat polish as functional: clarity, legibility, feedback, and interaction quality come before ornament.",
    category: "analysis",
    toolIds: ["web.search", "knowledge.search", "app.assets.list", "app.assets.show", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.verification.show"],
    tags: ["design", "critique", "visual", "polish"],
  }),

  builtInSkill({
    id: "engineering.implementation",
    slug: "software-implementation",
    name: "Software implementation",
    description: "Implement a bounded feature in the existing architecture with focused verification and a clean handoff.",
    instructions: "Read the relevant architecture and local conventions first. Trace the current behavior, define acceptance criteria, make the smallest cohesive change, preserve security and data boundaries, and verify the changed path with focused tests. Do not broaden scope, hide failures, or claim completion without evidence.",
    category: "creation",
    toolIds: ["knowledge.search", "app.projects.builder.show", "app.projects.builder.create", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.file.delete", "app.projects.builder.command.run", "app.projects.builder.checkpoint.create", "app.projects.builder.checkpoint.restore", "app.projects.builder.verification.run", "app.projects.builder.verification.show"],
    tags: ["coding", "implementation", "engineering"],
  }),
  builtInSkill({
    id: "engineering.debugging",
    slug: "root-cause-debugging",
    name: "Debugging & root-cause analysis",
    description: "Reproduce a failure, isolate its cause, repair it narrowly, and protect the behavior with a regression check.",
    instructions: "Turn the symptom into a reproducible case. Gather observations before forming hypotheses, trace the failing data and control path, and distinguish root cause from downstream noise. Apply the narrowest robust fix, add a regression check, and verify both the original failure and nearby success paths.",
    category: "analysis",
    toolIds: ["knowledge.search", "app.runs.list", "app.runs.show", "app.runs.trajectory", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.command.run", "app.projects.builder.checkpoint.create", "app.projects.builder.verification.run", "app.projects.builder.verification.show"],
    tags: ["coding", "debugging", "root-cause", "regression"],
  }),
  builtInSkill({
    id: "engineering.review-security",
    slug: "code-review-security",
    name: "Code review & security",
    description: "Review changes for correctness, regressions, security boundaries, data isolation, and maintainability.",
    instructions: "Trace behavior rather than reviewing syntax alone. Prioritize concrete defects by impact and likelihood, verify tenant and actor scope, untrusted-input handling, approvals, idempotency, secrets, concurrency, failure recovery, and test coverage. Cite exact evidence, avoid speculative findings, and summarize residual risk when no defect is found.",
    category: "analysis",
    toolIds: ["knowledge.search", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.verification.show"],
    tags: ["coding", "review", "security", "quality"],
  }),
  builtInSkill({
    id: "engineering.quality-performance",
    slug: "testing-performance-engineering",
    name: "Testing & performance engineering",
    description: "Build proportionate tests and remove measured bottlenecks without weakening correctness.",
    instructions: "Define the critical behavior and realistic failure modes, then choose the smallest test layer that proves them. For performance work, measure first, identify the dominant bottleneck, protect correctness, and compare the same workload before and after. Prefer targeted regression tests and budgets over broad, noisy suites.",
    category: "analysis",
    toolIds: ["knowledge.search", "app.projects.builder.show", "app.projects.builder.tree", "app.projects.builder.search", "app.projects.builder.file.read", "app.projects.builder.file.update", "app.projects.builder.command.run", "app.projects.builder.checkpoint.create", "app.projects.builder.verification.run", "app.projects.builder.verification.show"],
    tags: ["coding", "testing", "performance", "quality"],
  }),

  builtInSkill({
    id: "communication.clear-writing",
    slug: "clear-writing-editing",
    name: "Clear writing & editing",
    description: "Turn complex material into accurate, concise writing suited to its audience and purpose.",
    instructions: "Identify the audience, desired outcome, and required tone. Lead with the conclusion, use concrete language, preserve important nuance, remove repetition, and make actions and ownership explicit. Verify factual claims and never fabricate quotes, sources, or certainty. Drafting does not authorize delivery.",
    category: "creation",
    toolIds: ["web.search", "knowledge.search", "memory.search", "app.communications.drafts.list", "app.communications.drafts.create"],
    tags: ["writing", "editing", "communication"],
  }),
  builtInSkill({
    id: "automation.workflow-design",
    slug: "workflow-automation-design",
    name: "Workflow automation design",
    description: "Turn a repeatable procedure into a deterministic, observable, and safely recoverable automation.",
    instructions: "Confirm the trigger, inputs, owner, expected effect, and stopping conditions. Model explicit steps, approvals, idempotency, retries, timeouts, and recovery paths. Keep open-ended judgment in a bounded agent step and deterministic work in the workflow. Validate readiness before starting and preserve an observable execution trail.",
    category: "automation",
    toolIds: ["app.workspaces.readiness", "app.workflows.list", "app.workflows.show", "app.workflows.plan", "app.workflows.plans.list", "app.workflows.start", "app.workflows.executions.list", "app.workflows.trajectory", "app.runs.list", "app.runs.show"],
    tags: ["automation", "workflows", "reliability"],
  }),
  builtInSkill({
    id: "learning.knowledge-synthesis",
    slug: "learning-knowledge-synthesis",
    name: "Learning & knowledge synthesis",
    description: "Transform source material into structured understanding, durable concepts, and useful retrieval cues.",
    instructions: "Establish the learning objective, separate source claims from interpretation, identify core concepts and relationships, reconcile contradictions, and produce a concise synthesis with examples and open questions. Preserve provenance and request a governed write before retaining anything as knowledge or memory.",
    category: "research",
    toolIds: ["web.search", "knowledge.search", "knowledge.ingest", "memory.search", "memory.write", "app.knowledge.list", "app.knowledge.search", "app.knowledge.ingest", "app.memory.search", "app.memory.write"],
    tags: ["learning", "knowledge", "synthesis", "research"],
  }),
  builtInSkill({
    id: "creation.document-studio",
    slug: "document-presentation-studio",
    name: "Document studio",
    description: "Create clear, polished, editable PowerPoint files and native Google Docs, Sheets, or Slides from an ordinary request.",
    instructions: "Translate the user's audience, purpose, evidence, and desired outcome into a concise artifact structure. Choose an Asael-owned editable PowerPoint when the user wants a downloadable deck. Choose native Google Docs, Sheets, or Slides when the user asks for a collaborative Workspace file. Use one governed creator, preserve project and evidence context, return the private artifact or verified Google editor link, and never claim unsupported evidence or expose binary content in the conversation.",
    category: "creation",
    toolIds: ["web.search", "knowledge.search", "memory.search", "app.artifacts.presentations.create", "google.docs.create", "google.sheets.create", "google.slides.create"],
    tags: ["documents", "presentations", "slides", "spreadsheets", "powerpoint", "google-workspace", "creation"],
  }),
];

export const BUILT_IN_SKILL_IDS = Object.freeze(
  builtInSkills.map((skill) => skill.id),
);

export function getBuiltInSkill(id: string) {
  return builtInSkills.find((skill) => skill.id === id);
}
