import type { SupervisorRoute } from "@/lib/orchestration/supervisor";

export type SemanticDecisionJson =
  | null
  | boolean
  | number
  | string
  | readonly SemanticDecisionJson[]
  | { readonly [key: string]: SemanticDecisionJson };

export type SemanticChoiceQuestion<TChoice extends string> = Readonly<{
  id: string;
  instructions?: SemanticDecisionJson;
  criteria: Readonly<Record<TChoice, string | null>>;
}>;

export type SemanticDecisionRequest<TChoice extends string> = Readonly<{
  model: string;
  state: SemanticDecisionJson;
  question: SemanticChoiceQuestion<TChoice>;
  signal: AbortSignal;
}>;

export type SemanticChoiceAnswer<TChoice extends string> = Readonly<{
  choice: TChoice;
  confidence: number;
  probabilities: Readonly<Record<TChoice, number>>;
}>;

export type SemanticDecisionResult<TChoice extends string> = Readonly<{
  model: string;
  answer: SemanticChoiceAnswer<TChoice>;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
  }>;
  providerRequestId?: string;
}>;

/**
 * A provider-neutral, typed semantic-decision boundary. Implementations can
 * classify only the explicit state and choice contract supplied by a caller;
 * this interface grants no tool, mutation, approval, or policy authority.
 */
export interface SemanticDecisionProvider {
  readonly id: string;
  decide<TChoice extends string>(
    input: SemanticDecisionRequest<TChoice>,
  ): Promise<SemanticDecisionResult<TChoice>>;
}

export const ROUTING_SHADOW_CHOICES = [
  "direct",
  "durable_workflow",
  "clarify",
] as const satisfies readonly SupervisorRoute[];

export type RoutingShadowChoice = (typeof ROUTING_SHADOW_CHOICES)[number];
