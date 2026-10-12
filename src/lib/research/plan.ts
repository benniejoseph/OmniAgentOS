import { createHash } from "node:crypto";
import { RESEARCH_DEPTH_LIMITS, researchOptionsSchema, type ResearchOptions } from "@/lib/research/contracts";

export type ResearchFacet = { id: string; question: string; query: string };
export type ResearchPlan = {
  schemaVersion: 1;
  id: string;
  query: string;
  depth: ResearchOptions["depth"];
  sourceGuidance: string;
  allowedDomains: string[];
  facets: ResearchFacet[];
  limits: { searches: number; reads: number; questions: number; gapRounds: number; evidenceChars: number; reportWords: string };
};

/** A deterministic, inspectable collection plan; preferences never confer authority. */
export function buildResearchPlan(query: string, options: Partial<ResearchOptions> = {}): ResearchPlan {
  const preferences = researchOptionsSchema.parse(options);
  const question = query.trim();
  if (!question) throw new Error("A research question is required.");
  const limits = RESEARCH_DEPTH_LIMITS[preferences.depth];
  const supplied = preferences.questions.length ? preferences.questions : questionParts(question);
  const topic = question.replace(/\s+/gu, " ").slice(0, 300).replace(/[.!?]+$/u, "");
  const candidates = supplied.length > 1 || preferences.questions.length
    ? supplied
    : [
        supplied[0] || topic,
        `What primary evidence and useful comparisons explain ${topic}?`,
        `What limitations, disagreements, or changes affect ${topic}?`,
      ];
  const questions = [...new Set(candidates.map((value) => value.trim().slice(0, 500)).filter(Boolean))]
    .slice(0, limits.questions);
  const facets = questions.map((facet, index) => ({
    id: `question-${index + 1}`,
    question: facet,
    query: researchFacetQuery(question, facet, preferences.sourceGuidance),
  }));
  const identity = JSON.stringify({ query: question, ...preferences, questions });
  return {
    schemaVersion: 1,
    id: `research-plan-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    query: question,
    depth: preferences.depth,
    sourceGuidance: preferences.sourceGuidance,
    allowedDomains: preferences.allowedDomains,
    facets,
    limits: { ...limits },
  };
}

/** Keep scope separate from the focused question, including when a long scope must be bounded. */
export function researchFacetQuery(scope: string, question: string, sourceGuidance = ""): string {
  const suffix = `\nInvestigate: ${question.slice(0, 500)}${sourceGuidance ? `\nSource guidance: ${sourceGuidance.slice(0, 1_500)}` : ""}`;
  const room = 4_000 - suffix.length - 7;
  return `Scope: ${boundedScope(scope, room)}${suffix}`;
}

export function researchDomainAllowed(value: string, allowedDomains: readonly string[] = []): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return !allowedDomains.length || allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

const stopWords = new Set("a an and are as at be been being by can could do does for from had has have how i if in into is it its me my of on or our should than that the their them there these they this those through to use using was we were what when where which who why will with would you your about according also analysis answer based compare comparison comparisons comprehensive context current detailed different discuss document evidence explain findings information key limitations main most new original primary provide question questions recent relevant report research review show source sources such useful very whether write".split(" "));

export function researchTerms(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || [])
    .map((term) => term.replace(/[._-]+$/u, ""))
    .filter((term) => term.length > 2 && !stopWords.has(term)))].slice(0, 80);
}

/** Lexical relevance is a selection hint, never an assessment of factual support. */
export function researchTextRelevance(text: string, query: string): number {
  const terms = researchTerms(query);
  if (!terms.length) return 0;
  const haystack = new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || [])
    .flatMap((term) => [term.replace(/[._-]+$/u, ""), ...term.split(/[._-]+/u)]));
  const hits = terms.filter((term) => haystack.has(term)).length;
  return Math.min(1, hits / Math.max(1, Math.min(terms.length, 12)));
}

function questionParts(query: string) {
  return query.split(/\n+|(?<=\?)\s+|;\s+/u)
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter((part) => part.length > 12 && !/^(?:format|word count|length|output format|use markdown|organize (?:the|your) report)\b/iu.test(part))
    .slice(0, 6);
}

function boundedScope(value: string, max: number) {
  if (value.length <= max) return value;
  const marker = " [Middle omitted for the query limit; do not infer missing constraints.] ";
  const side = Math.floor((max - marker.length) / 2);
  return `${value.slice(0, side)}${marker}${value.slice(-(max - side - marker.length))}`;
}
