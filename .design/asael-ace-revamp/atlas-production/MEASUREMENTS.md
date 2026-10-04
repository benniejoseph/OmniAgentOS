# ATLAS export and measurement records — 4 October 2026

## Current sculpt-02: export facts, no current performance comparison

The current `output/export-manifest.json` was written at `2026-10-04T01:59:09.672255+00:00` for `sculpt-02-eyelids-layered-plumage-eight-states`. It records **104 artifacts** and a **1,414,604-byte GLB**, with **18,390 vertices, 33,718 triangles, 14 bones and 12 clips**: eight application states plus the four inspection aliases `rest`, `quick_reaction`, `speech_test` and `satisfied_nod`. Runtime records Three.js 0.186.0, headless Chrome 154.0.8037.94 and ANGLE/Metal reporting Apple M2. These are export/renderer facts, not measured responsiveness, battery or thermal results.

The new state bundle contains a schema-version-1 manifest and 32 transparent WebP assets: light/dark poster and sprite for each state, 256px frames, four columns and 20Hz inclusive sampling. Current durations are 600–1120ms and frame counts 13–24; the shared format admits at most 1200ms/25 frames. Theme pairs currently have identical image hashes. No bundle has been published, and actual-art review found final likeness insufficient; see [ART_REVIEW.md](ART_REVIEW.md).

Root's `atlas-production-adapter-unit.log` records **26 passing web adapter unit cases** on 4 October 2026, including the public metadata-only `awaiting-art-review` response. The web manifest reader uses `no-cache` revalidation; this placeholder publishes no artwork and retains the approved neutral portrait. The full native analyzer reported no issues in `atlas-native-adapter-analyze.log`, and **all 37 companion cases passed** in `atlas-companion-final-regression.log` (the earlier 15-case run was a focused subset, not an additional total).

Sculpt-02 also passed **nine Node geometry/lifecycle checks** in `atlas-sculpt-02-structure-tests.log` and **three Python tool tests** in `atlas-sculpt-02-tool-tests.log`. The full web build with the adapter passed in `atlas-adapter-final-web-build.log` before the subsequent manifest/cache change; the later package remains pending. These are implementation/build checks, not a browser/device or sculpt-02 performance run. Evidence logs are under `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/`.

Current export manifest SHA-256: `d56bed4d92ec5f67afed508111354d937989d39d25489b7946f30704ccb5fe3d`.

Current raster manifest SHA-256: `21ba8041391ff82c928fa7ce8f334a970da24111c9bc7ba408db1078a85e5140`.

**The remaining `output/benchmark.json` is stale rough-01 evidence.** It predates sculpt-02 and must not be paired with the current export manifest or used to claim that the larger model/new sprite bundle meets the old timings. A fresh comparison has not been recorded here.

## Archived rough-01 local comparison

The results below belong exclusively to `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`, which preserves the matching rough-01 output, export manifest and benchmark. They are retained for comparison, not transferred to sculpt-02.

Captured at `2026-10-03T20:20:45.506325+00:00` with headless Chrome 154.0.8037.94 on macOS-27.0-arm64-arm-64bit-Mach-O. All 36 fresh-context cases passed their declared checks. Each row below reports three repetitions; it is a short loopback lab sample, not a production or physical-mobile performance claim.

That archived 408,512-byte self-contained GLB contains 5,302 vertices, 8,268 triangles, twelve bones and five authored clips. The same 256px generated still/frames were used at both CSS sizes. The live path includes the actual uncompressed Three.js and loader module requests. Network interception disabled HTTP cache.

| Delivery | CSS px / DPR | Median ready (ms) | Encoded resources (bytes) | Median independent control proxy (ms) | Worst sampled frame-work p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| poster | 36 / 1 | 13.90 | 36,169 | 43.10 | No motion |
| poster | 36 / 2 | 9.10 | 36,169 | 43.90 | No motion |
| poster | 256 / 1 | 9.40 | 36,169 | 43.90 | No motion |
| poster | 256 / 2 | 10.70 | 36,169 | 47.00 | No motion |
| glb | 36 / 1 | 76.30 | 2,725,751 | 27.50 | 0.80 |
| glb | 36 / 2 | 76.20 | 2,725,751 | 27.50 | 0.80 |
| glb | 256 / 1 | 79.40 | 2,725,751 | 31.90 | 0.80 |
| glb | 256 / 2 | 80.80 | 2,725,751 | 31.10 | 0.70 |
| sequence | 36 / 1 | 34.40 | 158,596 | 29.10 | 0.20 |
| sequence | 36 / 2 | 34.50 | 158,596 | 28.50 | 0.10 |
| sequence | 256 / 1 | 37.00 | 158,596 | 26.80 | 0.20 |
| sequence | 256 / 2 | 49.20 | 158,596 | 27.10 | 0.20 |

Ready is the mode-specific initialization to ready stage. The control value measures its handler to a second animation-frame callback and is **not INP**. Frame work includes pose update and synchronous draw submission; asynchronous GPU time is excluded. With three repetitions, the table does not establish a sustained frame-rate or latency guarantee.

All declared idle, interrupt, reduced-motion, offscreen, hide/show, disposal, late-load, failure geometry and independent-control assertions passed. A real hidden-document transition was not observed by this headless backend; its hidden-tab result remains unobserved.

The old still has a 262,144-byte decoded RGBA arithmetic estimate; nineteen sequence frames have a 4,980,736-byte estimate. These are not measured allocation or GPU residency. Actual GPU memory/time, physical-device battery/thermal behavior, native integration, warm cache and deployed route budgets remain outside that record.

The initial benchmark attempt failed because an expression-based test wait conflicted with the lab CSP. Function-form predicates fixed the harness; no CSP relaxation was made. The exporter was rerun to bind the corrected benchmark source in its provenance, followed by the complete 36-case comparison.

This archived comparison supports continued evaluation of a static default with a bounded pre-rendered reaction. It does not approve rough-01 or sculpt-02, validate the current adapters on physical targets, or measure the new state bundle. The approved app/native static portrait remains the current delivery. See ART_REVIEW.md and PERFORMANCE_PLAN.md for the remaining decisions.

Evidence: the matching `output/benchmark.json` and `output/export-manifest.json` **inside the rough-01 archive**, not the mixed-revision working output directory.

Archived rough-01 export manifest SHA-256: `51d74717770ebbac6e5fcc8da2f3c8b014a5fd83bb364b26eccd6316602d0b03`.

Archived rough-01 benchmark SHA-256: `a126179d9210c0f30493387edafdb97930c07441f75a6b46123516740492546a`.
