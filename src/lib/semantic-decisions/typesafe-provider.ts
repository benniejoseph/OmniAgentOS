import "server-only";

import { z } from "zod";
import type {
  SemanticDecisionJson,
  SemanticDecisionProvider,
  SemanticDecisionRequest,
  SemanticDecisionResult,
} from "@/lib/semantic-decisions/types";

const TYPE_SAFE_SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_REQUEST_BYTES = 24_000;
const MAX_RESPONSE_BYTES = 64_000;

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1).max(160),
  confidence: z.number().finite().min(0).max(1),
  probabilities: z.record(
    z.string().min(1).max(160),
    z.number().finite().min(0).max(1),
  ),
}).strict();

const responseSchema = z.object({
  model: z.string().min(1).max(240),
  answers: z.record(z.string().min(1).max(120), choiceAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type TypeSafeSemanticDecisionFailure =
  | "authentication_failed"
  | "rate_limited"
  | "request_rejected"
  | "provider_unavailable"
  | "response_too_large"
  | "schema_mismatch";

export class TypeSafeSemanticDecisionError extends Error {
  constructor(
    readonly code: TypeSafeSemanticDecisionFailure,
    readonly retryable: boolean,
  ) {
    super(`TypeSafe semantic decision failed: ${code}.`);
    this.name = "TypeSafeSemanticDecisionError";
  }
}

export function createTypeSafeSemanticDecisionProvider(input: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): SemanticDecisionProvider {
  const apiKey = boundedText(input.apiKey, "apiKey", 16, 8_192);
  const fetchImpl = input.fetchImpl || fetch;

  return Object.freeze({
    id: "typesafe",
    async decide<TChoice extends string>(
      request: SemanticDecisionRequest<TChoice>,
    ): Promise<SemanticDecisionResult<TChoice>> {
      const model = boundedText(request.model, "model", 1, 240);
      const questionId = boundedIdentifier(request.question.id, "question.id");
      const choices = Object.keys(request.question.criteria) as TChoice[];
      if (choices.length < 2 || choices.length > 12) {
        throw new TypeSafeSemanticDecisionError("request_rejected", false);
      }
      const criteria = Object.fromEntries(choices.map((choice) => [
        boundedIdentifier(choice, "choice"),
        request.question.criteria[choice] === null
          ? null
          : boundedText(
              request.question.criteria[choice] || "",
              "criterion",
              1,
              1_000,
            ),
      ]));
      const body = JSON.stringify({
        state: validatedJson(request.state),
        questions: {
          [questionId]: {
            type: "choice",
            ...(request.question.instructions === undefined
              ? {}
              : { instructions: validatedJson(request.question.instructions) }),
            criteria,
          },
        },
        model,
      });
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        throw new TypeSafeSemanticDecisionError("request_rejected", false);
      }

      let response: Response;
      try {
        response = await fetchImpl(TYPE_SAFE_SYSTEM_ONE_ENDPOINT, {
          method: "POST",
          cache: "no-store",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw new TypeSafeSemanticDecisionError("provider_unavailable", true);
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new TypeSafeSemanticDecisionError("authentication_failed", false);
        }
        if (response.status === 429) {
          throw new TypeSafeSemanticDecisionError("rate_limited", true);
        }
        if (response.status >= 500) {
          throw new TypeSafeSemanticDecisionError("provider_unavailable", true);
        }
        throw new TypeSafeSemanticDecisionError("request_rejected", false);
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw new TypeSafeSemanticDecisionError("response_too_large", false);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new TypeSafeSemanticDecisionError("schema_mismatch", false);
      }
      const parsed = responseSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new TypeSafeSemanticDecisionError("schema_mismatch", false);
      }
      const answer = parsed.data.answers[questionId];
      const expectedChoices = new Set(choices);
      const probabilityChoices = Object.keys(answer?.probabilities || {});
      const probabilityTotal = Object.values(answer?.probabilities || {})
        .reduce((total, probability) => total + probability, 0);
      if (
        !answer ||
        !expectedChoices.has(answer.choice as TChoice) ||
        probabilityChoices.length !== expectedChoices.size ||
        probabilityChoices.some((choice) => !expectedChoices.has(choice as TChoice)) ||
        probabilityTotal < 0.98 ||
        probabilityTotal > 1.02
      ) {
        throw new TypeSafeSemanticDecisionError("schema_mismatch", false);
      }

      return Object.freeze({
        model: parsed.data.model,
        answer: Object.freeze({
          choice: answer.choice as TChoice,
          confidence: answer.confidence,
          probabilities: Object.freeze(
            Object.fromEntries(choices.map((choice) => [
              choice,
              answer.probabilities[choice],
            ])) as Record<TChoice, number>,
          ),
        }),
        usage: Object.freeze({
          inputTokens: parsed.data.usage.input_tokens,
          outputTokens: parsed.data.usage.output_tokens,
        }),
        providerRequestId: boundedOptionalHeader(
          response.headers.get("x-request-id") ||
            response.headers.get("request-id"),
        ),
      });
    },
  });
}

function validatedJson(value: SemanticDecisionJson): SemanticDecisionJson {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new TypeSafeSemanticDecisionError("request_rejected", false);
  }
  return value;
}

function boundedText(
  value: string,
  field: string,
  min: number,
  max: number,
) {
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    void field;
    throw new TypeSafeSemanticDecisionError("request_rejected", false);
  }
  return normalized;
}

function boundedIdentifier(value: string, field: string) {
  const normalized = boundedText(value, field, 1, 120);
  if (!/^[a-z][a-z0-9_]{0,119}$/i.test(normalized)) {
    throw new TypeSafeSemanticDecisionError("request_rejected", false);
  }
  return normalized;
}

function boundedOptionalHeader(value: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 240 ? normalized : undefined;
}
