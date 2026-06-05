import OpenAI from "openai";
import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";
import { AGENT_MODEL, EMBEDDING_MODEL, hasOpenAIKey } from "@/lib/config";

let client: OpenAI | null = null;

export function getOpenAIClient() {
  if (!hasOpenAIKey()) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

export async function embedTexts(input: string[]) {
  if (!hasOpenAIKey() || input.length === 0) {
    return null;
  }

  const response = await getOpenAIClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });

  return response.data.map((item) => item.embedding);
}

export async function* streamOpenAIResponse({
  instructions,
  input,
  abortSignal,
}: {
  instructions: string;
  input: string;
  abortSignal?: AbortSignal;
}) {
  const stream = await getOpenAIClient().responses.create(
    {
      model: AGENT_MODEL,
      instructions,
      input,
      stream: true,
    },
    { signal: abortSignal },
  );

  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    if (event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        yield delta;
      }
    }
  }
}

export async function createStructuredResponse({
  instructions,
  input,
  schema,
  name,
}: {
  instructions: string;
  input: string;
  schema: ResponseFormatTextJSONSchemaConfig["schema"];
  name: string;
}) {
  const response = await getOpenAIClient().responses.create({
    model: AGENT_MODEL,
    instructions,
    input,
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema,
      },
    },
  });

  return response.output_text;
}
