export const ARCHITECTURE_DECISION_REGISTRY_VERSION = 1 as const;

export const REQUIRED_ARCHITECTURE_DECISIONS = Object.freeze([
  Object.freeze({ id: "ADR-005", topic: "canonical_truth", status: "accepted" }),
  Object.freeze({ id: "ADR-006", topic: "agent_identity", status: "accepted" }),
  Object.freeze({ id: "ADR-007", topic: "object_storage", status: "accepted" }),
  Object.freeze({ id: "ADR-008", topic: "a2a_boundary", status: "accepted" }),
  Object.freeze({ id: "ADR-009", topic: "ap2_boundary", status: "accepted" }),
  Object.freeze({ id: "ADR-010", topic: "workspace_model", status: "accepted" }),
  Object.freeze({ id: "ADR-011", topic: "native_api", status: "accepted" }),
] as const);

export type ArchitectureDecision =
  (typeof REQUIRED_ARCHITECTURE_DECISIONS)[number];

