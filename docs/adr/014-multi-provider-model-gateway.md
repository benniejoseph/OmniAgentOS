# ADR 014: Multi-provider model gateway

Status: Accepted · 2026-09-29 · Supersedes [ADR 001](001-openai-only.md)

## Context

ADR 001 used the OpenAI Responses API for every model call. Asael has since
added Gemini, Anthropic and Amazon Bedrock models, and a workspace can assign
the model for each functional role in Settings. Parts of the code still
assumed one provider: the deployment's route and the shared usage type lived
under `src/lib/openai`, the provider error classifier lived in the OpenAI
adapter, default model names were scattered through configuration, and a run
failed once its conversation passed 128 items.

## Decision

Every model turn goes through one gateway (`src/lib/models/gateway.ts`) and a
provider adapter (`src/lib/models/adapters/`): OpenAI Responses, Gemini
Interactions, Anthropic Messages or Bedrock Converse.

- **Routing.** A workspace's model assignment decides the provider and model
  of a turn. An assignment that cannot be used as saved stops the run with a
  `model_route_degraded` event and calls no model, unless the deployment sets
  `OMNIAGENT_MODEL_ROUTE_ALLOW_DEPLOYMENT_FALLBACK=true`. Without an
  assignment, the deployment route (`src/lib/models/deployment-route.ts`)
  chooses from the configured providers: a model policy the agent names, else
  the request's apparent complexity.
- **Default models.** One table (`src/lib/models/default-models.ts`) names the
  model each deployment role uses and the environment variable that names
  another. `.env.example` documents each variable with its default, and a test
  keeps the two the same.
- **Errors.** Every adapter maps a provider SDK or HTTP failure through
  `classifyProviderError` (`src/lib/models/provider-errors.ts`) into a typed
  error that says whether a retry can help.
- **Pricing.** One price table per provider, set in the environment
  (`*_MODEL_PRICING_JSON`), prices uncached input, prompt-cache reads and
  writes, output, and web search queries (`src/lib/models/pricing.ts`). A dated
  snapshot takes the price of the model it snapshots unless it is listed.
- **Conversation.** The provider-neutral conversation
  (`src/lib/models/conversation.ts`) holds native user and assistant
  messages, untrusted observations, tool calls and their results. It is the
  source of truth for replay and recovery. An adapter may also keep native
  continuation state that only its provider accepts, such as Claude thinking
  or OpenAI encrypted reasoning, and replays it verbatim. The conversation is
  capped at 128 items. Rather than failing past the cap, it replaces its
  oldest complete tool rounds with one untrusted observation that lists what
  they did.
- **Contract.** `src/lib/models/provider-contract.test.ts` holds every adapter
  to the same behavior: a metered text answer, a tool round trip, a rejected
  credential, a reply cut off at its token limit and a rate limit. It runs
  from recorded fixtures, or live against each provider with credentials.

Every turn still sends the full conversation. It does not use
`previous_response_id` or `previous_interaction_id`, so no provider keeps
application state and Zero Data Retention stays possible, as ADR 001 required.

## Consequences

- A new provider needs an adapter, its errors mapped through
  `classifyProviderError`, a price table, and a pass of the contract suite.
- OpenAI remains the default for the deployment's own roles: the agent, web
  search, embeddings, speech, OCR and Computer Use.
- Compaction is lossy: a removed round survives only as a line of at most a
  few hundred characters. It changes the cached prompt prefix once, so the
  next turn misses the prompt cache.
- Native continuation state is not compacted, since it must replay verbatim.
  Bedrock's native state keeps its own limit of 64 messages.
- The deployment route's complexity estimate is still a pattern match on the
  request text.
