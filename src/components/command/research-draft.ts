export type ResearchDraft = {
  depth: "quick" | "deep";
  questions: string;
  sourceGuidance: string;
  domains: string;
};

export const emptyResearchDraft: ResearchDraft = { depth: "quick", questions: "", sourceGuidance: "", domains: "" };

export type ResearchDraftValidation = { draft: ResearchDraft; valid: boolean };
