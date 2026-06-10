# ADR 001: OpenAI as the only model provider

Status: Accepted · 2026-06-10

## Context

The platform needs generation, embeddings, structured output, and hosted web search. Multi-provider abstractions add a compatibility layer that must be designed before the agent capability itself is proven.

## Decision

Use the OpenAI Responses API exclusively (`src/lib/openai/client.ts`): streaming with function tools and `previous_response_id` chaining, `text-embedding-3-*` embeddings (dimension-capped for pgvector HNSW), and the hosted `web_search` tool.

## Consequences

- Single SDK, single billing surface, hosted web search for free.
- Vendor lock-in is contained to one module; a future provider abstraction should wrap `streamResponseTurn`, `embedTexts`, and `createStructuredResponse` only.
- Fallback mode (no key) streams a clearly labeled simulated response so the UI remains demoable.
