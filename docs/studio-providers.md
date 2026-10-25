# Creative Studio providers

Creative Studio reuses Asael's provider vault, specialized image/video model assignments, private Capture asset library and AI usage ledger. Credentials never enter a flow, browser response or provider receipt. Configure Google in **Settings → Providers**, validate the connection and assign `gemini-3.1-flash-image` to image generation and `gemini-omni-1.1-flash` to video generation. Existing deployment fallback uses `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL` and `GEMINI_VIDEO_MODEL`. Different assigned models remain visibly unavailable until their controls are implemented; Studio does not silently substitute another model.

The free **Demo** operations use original fixed PNG/MP4 fixtures. A label is burned into every frame. Prompts, references and control changes exercise the workflow without changing that fixture or contacting a paid model. Three distinct image fixtures exercise explicit output selection. `src/lib/studio/fixtures/generate-demo.mjs` rebuilds them locally; set `STUDIO_FIXTURE_FFMPEG` if the bundled executable is unavailable. It also writes a statically imported manifest, so private fixture ingestion works inside serverless functions without relying on CDN files under `public/`.

## Supported controls

| Operation        | Model                  | Inputs                              | Controls                                        |
| ---------------- | ---------------------- | ----------------------------------- | ----------------------------------------------- |
| Generate image   | Gemini 3.1 Flash Image | Text                                | 1 output; 1K/2K/4K; 1:1, 16:9, 9:16, 4:3 or 3:4 |
| Edit image       | Gemini 3.1 Flash Image | Text + 1–4 PNG/JPEG/WebP references | Same image controls                             |
| Text to video    | Gemini Omni 1.1 Flash  | Text                                | 1 output, 720p, 16:9 or 9:16                    |
| Image to video   | Gemini Omni 1.1 Flash  | Text + start frame                  | Same video controls                             |
| Frame transition | Gemini Omni 1.1 Flash  | Text + start/end frames             | Same video controls                             |

The video model chooses a duration within its documented 3–10 second range. There is no invented duration, seed, fps, negative-prompt or audio switch. The provider request shows explicit first/last image role tags in addition to the prompt. References are hash-checked and limited to 16 MiB combined; each saved output must fit Capture's 20 MiB limit. A larger output remains a failed save with its provider receipt preserved.

Google image generation requests JPEG output. Its `ImageResponseFormat.mime_type` enum permits `image/jpeg`; the wider PNG/JPEG/WebP input list belongs to `ImageContent` and must not be used as the output contract. The [API reference](https://ai.google.dev/api/interactions-api#responseformat) and [official OpenAPI document](https://ai.google.dev/static/api/interactions.openapi.json) establish this distinction. A small pinned copy of the specific image output schema drives the offline regression; validating only the broad `ResponseFormat` union is insufficient because it includes a permissive object fallback.

The October 25 live trial at revision `96a2a57f` sent PNG output and received HTTP 400 before any image or video was saved. This is a confirmed contract mismatch, but the exact rejection reason was discarded by that revision and cannot be reconstructed. A non-generating model-catalog check subsequently accepted the same Google connection and listed both assigned models. The correction changes only the requested image output MIME type; model pins, background mode and token limits stay unchanged. A successful catalog check or offline schema regression does not establish generation success; record any new, separately budgeted live attempt independently.

## Submission, cancellation and recovery

Google Interactions uses `background: true`, `store: true` and `stream: false`. Stored provider interactions are required for background retrieval; Google's normal paid retention applies. One submitted attempt creates one interaction. The engine must checkpoint **submitting** before the POST, save the returned handle/output descriptors before ingesting, and never retry an ambiguous submission automatically. There is no documented provider idempotency key in this adapter. `submissionKey` identifies Asael's persisted attempt, not a promise of provider-side deduplication.

A quote pins the exact model, assignment revision and provider connection version. Before submission, those settings must still match. Later GET polling and cancellation use the original owner-scoped provider connection even if the workspace's model assignment changes. Revoked/rotated credentials block further access rather than use another account. A process interruption before a handle was saved is **uncertain** and needs reconciliation; GET polling and saving an already received output can be repeated safely.

Cancellation is best effort: `POST /interactions/{id}/cancel`. The UI must retain a completed result if completion wins the race. Cancellation does not guarantee that Google will not charge for work already performed. Fetches have bounded time and byte limits. Only final `model_output` media enters the library; thought content, echoed inputs and provider error bodies are not persisted as assets. Remote output URLs are server-only, use public-network checks and an explicit Google host allowlist, and are copied into the private library before rendering.

For HTTP rejections the adapter reads at most 16 KiB, classifies recognized provider reasons and known request fields, then discards the body. Saved failure messages use fixed text and allowlisted field paths, never raw provider messages, headers, echoed prompts, URLs or credentials. An unrecognized diagnostic stays an explicit unknown cause. HTTP status still determines whether submission was rejected or uncertain; diagnostics cannot enable an automatic retry or remove a limit.

AI usage uses a stable owner+attempt ID. Repeated status reads cannot create additional usage records. Demo produces no paid-usage record. The recorded provider request ID and token usage let operators reconcile actual billing. Unknown provider prices are not presented as zero.

## Price and bounded smoke verification

Prices and controls were checked against Google documentation on **2026-10-25**. They are estimates, not a provider-account spending cap, and exclude account-specific taxes or fees. The server sends a nonremovable `generation_config.max_output_tokens` of 8,192 for image and 65,536 for video; a provider rejection never triggers an unbounded fallback. No tools, grounding, previous interaction, extension, additional candidates or automatic generation retries are sent.

For the exact current models, a conservative request reservation prices every output token at its most expensive modality:

- Image: 131,072 maximum input tokens × $0.50/M + 8,192 output tokens × $60/M = **$0.557056**.
- Video: 1,048,576 maximum input tokens × $1.50/M + 65,536 output tokens × $17.50/M = **$2.719744**.
- One image and one video reserve **$3.2768**, leaving $1.7232 of margin under a $5 verification authorization. The 720p output estimate before input/thinking is approximately $0.10/second. A rejected request or incomplete generation consumes its original attempt allowance; no second generation may be inferred from unused estimates.

Before a paid smoke, verify the exact model pins, one request per stage, the token-cap payload, and the remaining total authorized spend. If the provider rejects background mode or the output cap, preserve that result and stop paid verification. Changing request semantics requires a new bounded plan. This document does not assert that a live smoke has passed; record the actual receipts separately.

Primary sources: [Interactions reference](https://ai.google.dev/api/interactions-api), [background execution](https://ai.google.dev/gemini-api/docs/background-execution), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [Omni video generation](https://ai.google.dev/gemini-api/docs/omni), [image model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image), [video model limits](https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash), and [pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Selected release scenario

The paired release runner supports `OMNIAGENT_RELEASE_FEATURE_PROBE=studio_flow_v1`. This keeps the normal health, authentication, provenance and rollback gates. It exercises Studio on the staged candidate before promotion, then performs a read-only check of the same flow, run, attempts and assets on the canonical URL. The active Fly worker remains held during staging; the probe advances only its own due `studio-run:<id>` job through the authenticated `advance` action and the normal queue lease. It never triggers a general workflow tick or unrelated scheduled work.

Configure the release environment with:

```text
OMNIAGENT_RELEASE_FEATURE_PROBE=studio_flow_v1
STUDIO_SMOKE_MODE=demo
SMOKE_STUDIO_FLOW_EVIDENCE_FILE=/absolute/private/release-directory/studio-flow.json
```

`STUDIO_SMOKE_MODE` must be explicit. `demo` verifies durable queue execution and actual fixture PNG/MP4 storage without paid generation; it does not prove Google generation. For the authorized live provider verification, use `live` and set `LIVE_VERIFY_STUDIO_GENERATION=CONFIRMED`. The release runner supplies its existing fresh login credentials, internal authentication secret, exact revision, candidate URL and `LIVE_VERIFY_STUDIO_FLOW=CONFIRMED` to `scripts/smoke-studio-flow.mjs`. Do not place credentials in a shell command, evidence file or committed configuration.

Both modes save one four-node graph: original-image prompt → one image → one image-to-video continuation → a gallery retaining both outputs. The live mode requires the exact Google models above and a quote reserving $3.2768. It accepts at most **two generation attempts and $3.50**, verifies that the video consumes the generated image's exact ID and content hash, and compares downloaded bytes with the durable asset receipts. Decoded dimensions/duration and provider/model/attempt provenance must be present. An uncertain submission, provider failure, failed ingestion or changed quote stops the scenario; there is no paid retry or fallback.

The evidence file is created exclusively before any mutation. Reusing it for `exercise` is rejected, including after an ambiguous run-create response. Keep it and the generated resources for reconciliation. The runner passes `SMOKE_STUDIO_FLOW_MODE=readback` after promotion, which permits only resource reads plus fresh sign-in/sign-out; it cannot create or advance a run. A failed canonical read can be checked again against the original successful exercise evidence without new generation. Changing the evidence filename is not authorization to spend again: account for every prior accepted or uncertain request within the user's total allowance.

Focused verification uses `node --test scripts/smoke-studio-flow.test.mjs`; its HTTP fixture tests the real script's admission, budget, one-submission, readback and ambiguity behavior without contacting a paid provider. Record the live result separately; passing the fixture test does not establish provider availability or Google request acceptance.
