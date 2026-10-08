"use client";

import { useId } from "react";
import { researchOptionsSchema, type ResearchOptions } from "@/lib/research/contracts";
import styles from "./research.module.css";

export type ResearchDraft = {
  depth: "quick" | "deep";
  questions: string;
  sourceGuidance: string;
  domains: string;
};

export const emptyResearchDraft: ResearchDraft = { depth: "quick", questions: "", sourceGuidance: "", domains: "" };

export function researchOptionsFromDraft(draft: ResearchDraft): ResearchOptions {
  const questions = draft.questions.split("\n").map((value) => value.trim()).filter(Boolean);
  if (draft.depth === "quick" && questions.length > 3) throw new Error("Quick research supports up to 3 questions. Choose Deep to investigate up to 6.");
  const result = researchOptionsSchema.safeParse({
    depth: draft.depth,
    questions,
    sourceGuidance: draft.sourceGuidance.trim(),
    allowedDomains: draft.domains.split(/[\s,]+/u).map((value) => value.trim().toLowerCase()).filter(Boolean),
  });
  if (!result.success) throw new Error("Check your research brief: use up to 6 questions of 500 characters, 1,500 characters of source guidance, and 10 domain names such as example.com.");
  return result.data;
}

export function ResearchOptionsEditor({ value, disabled, onChange }: {
  value: ResearchDraft;
  disabled?: boolean;
  onChange: (value: ResearchDraft) => void;
}) {
  const id = useId();
  let error: string | undefined;
  try { researchOptionsFromDraft(value); } catch (failure) { error = (failure as Error).message; }
  return <fieldset className={styles.options} disabled={disabled}>
    <legend>Research depth</legend>
    <div className={styles.depthChoices}>
      {(["quick", "deep"] as const).map((depth) => <label key={depth}>
        <input type="radio" name={`${id}-depth`} value={depth} checked={value.depth === depth} onChange={() => onChange({ ...value, depth })} />
        <span><strong>{depth === "quick" ? "Quick" : "Deep"}</strong><span>{depth === "quick" ? "A focused report in this conversation." : "Broader research in the background, with a saved plan and progress."}</span></span>
      </label>)}
    </div>
    <details className={styles.brief}>
      <summary>Edit research brief <span className={styles.optional}>Optional</span></summary>
      <p>Your message is the main question. Add priorities or source restrictions here.</p>
      <label htmlFor={`${id}-questions`}>Questions to investigate</label>
      <textarea id={`${id}-questions`} rows={3} maxLength={3005} value={value.questions} placeholder={`One question per line, up to ${value.depth === "quick" ? 3 : 6}`} onChange={(event) => onChange({ ...value, questions: event.target.value })} />
      <label htmlFor={`${id}-guidance`}>Source guidance</label>
      <textarea id={`${id}-guidance`} rows={3} maxLength={1500} value={value.sourceGuidance} placeholder="For example: prefer primary sources published in the last year." onChange={(event) => onChange({ ...value, sourceGuidance: event.target.value })} />
      <label htmlFor={`${id}-domains`}>Restrict to these domains</label>
      <input id={`${id}-domains`} type="text" maxLength={2540} value={value.domains} placeholder="example.com, another.org" onChange={(event) => onChange({ ...value, domains: event.target.value })} aria-describedby={`${id}-domain-help`} />
      <p id={`${id}-domain-help`}>Leave blank to search the public web. Up to 10 domain names, without https:// or page paths.</p>
    </details>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </fieldset>;
}
