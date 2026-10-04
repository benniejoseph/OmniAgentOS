# ATLAS export and measurement records — 4 October 2026

## Last complete eyelid-03 export: no matching performance comparison

The retained `output/export-manifest.json` was written at `2026-10-04T18:03:14.083731+00:00` for `sculpt-04-eyelid-03-interior-surface-clearance`. It records **104 artifacts** and a **2,035,216-byte GLB**, with **27,190 vertices, 49,748 triangles, 14 bones and 12 clips**: eight application states plus the four inspection aliases `rest`, `quick_reaction`, `speech_test` and `satisfied_nod`. Runtime records Three.js 0.186.0, headless Chrome 154.0.8037.94 and ANGLE/Metal reporting Apple M2. These are export/renderer facts, not measured responsiveness, battery or thermal results. Matching source/output is archived in `atlas-eyelid-03-review.tar.gz`. All nine structure checks passed. Root reviewed actual rest, mid-blink and peak-blink front/three-quarter/profile captures: forward bulge is much reduced, front white breakthrough is gone and the neutral iris remains legible. A thin outer white seam and profile gap remain; final blink and overall artwork acceptance are still open.

The eyelid-03 state bundle contains a schema-version-1 manifest and 32 transparent WebP assets: light/dark poster and sprite for each state, 256px frames, four columns and 20Hz inclusive sampling. Its durations are 600–1120ms and frame counts 13–24; the shared format admits at most 1200ms/25 frames. Theme pairs have identical image hashes. No 3D/state bundle has been published, and actual-art review found final likeness insufficient; see [ART_REVIEW.md](ART_REVIEW.md). The complete export binds eyelid-03; no matching performance measurement is claimed.

Root's `atlas-production-adapter-unit.log` records **26 passing web adapter unit cases** on 4 October 2026, including the public metadata-only `awaiting-art-review` response. The web manifest reader uses `no-cache` revalidation; this placeholder publishes no artwork and retains the approved neutral portrait. The full native analyzer reported no issues in `atlas-native-adapter-analyze.log`, and **all 37 companion cases passed** in `atlas-companion-final-regression.log` (the earlier 15-case run was a focused subset, not an additional total).

Historical sculpt-04 evidence includes **all nine geometry/lifecycle checks** passing. Historical sculpt-02 evidence includes **nine Node geometry/lifecycle checks** in `atlas-sculpt-02-structure-tests.log` and **three Python tool tests** in `atlas-sculpt-02-tool-tests.log`. The earlier full adapter web build passed in `atlas-adapter-final-web-build.log` before the subsequent manifest/cache change. Its package-preparation status is superseded by the accepted PR53/PR54/PR55 release checkpoints and signed packages in [IMPLEMENTATION.md](../IMPLEMENTATION.md); PR55 is merged after all 16 hosted checks passed and its private greeting package is verified. These are implementation/build checks, not physical-device or eyelid-03 performance measurements. Evidence logs are under `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/`.

PR56 is accepted and merged after all 16 hosted checks passed on `a3fb4215b632f8b6d56487e3617b0afb82085aba`. Its scoped language and motion-intensity implementation passed **277 focused web/server checks**, full Flutter analysis and **11 companion checks**. The private Mac 1.23.15 (50) package is verified from that exact source. There is no database/API version change and no new art or performance measurement in this release.

PR57's web-only expanded Voice shared-player integration is accepted and merged after all 14 applicable hosted checks passed on `76a2230e911d1d8436c731fc965f53037b5dadd6`. The 48 focused unit checks, 114 maintained browser checks and ESLint passed. Local compact/greeting validation reached 75 passing checks before a 180-second document-navigation timeout; that local run was incomplete. The complete browser suite passed on the exact hosted head. Native API/version and the verified Mac 1.23.15 (50) package are unchanged. These results supply no new artwork or physical-device performance acceptance.

Eyelid-03 export manifest SHA-256: `9eb70a01ed62ce630de1c866b4550064890233a42abe796e205293213e88e8cf`.

Eyelid-03 raster manifest SHA-256: `863daf3362c45dd6fe08f8f5361c83ff10a31642923637695e1e8b1be50f45fa`.

**The remaining `output/benchmark.json` is stale rough-01 evidence.** It predates the later sculpts and must not be paired with the eyelid-03 export manifest or used to claim that the larger model/state bundle meets the old timings. A fresh matching comparison has not been recorded here.

## Archived throat-04 checkpoint

The historical `sculpt-04-throat-04-refined-boundary-sampling` export at `2026-10-04T17:30:25.836966+00:00` is retained in `atlas-throat-04-review.tar.gz`. It contains 104 artifacts, a 2,035,216-byte GLB, 27,190 vertices, 49,748 triangles, 14 bones and 12 clips. All nine structure checks passed. Front/three-quarter review retained the finer boundary, with no holes or detached strips, while leaving final art unaccepted. Eyelid-03 retains these counts with changed source/weights; this archive is a historical checkpoint.

Archived throat-04 export manifest SHA-256: `11560d413754487581c6c18541d1cc88d70d4eaf0ce6a8b62e1edcc3985a1710`.

Archived throat-04 raster manifest SHA-256: `766d3e1109b5b165e236970170d3163b45c35bca59e7233013f535bdadd89f95`.

## Archived beak-02 baseline

The historical `sculpt-04-beak-02-curved-hook-jaw-contact` export at `2026-10-04T17:00:41.390833+00:00` is retained in `atlas-beak-02-review.tar.gz`. It contains 104 artifacts, a 1,754,824-byte GLB, 23,314 vertices, 41,700 triangles, 14 bones and 12 clips. Root's 18 comparison captures found the beak improved while the full model remained unaccepted. This baseline is not the current complete export. The intervening throat-03 source study was rejected for its coarse staircase boundary.

Archived beak-02 export manifest SHA-256: `8cdda6f89d9e830b9c11b7f3ea2ba4f5f7e1c7521e0a4239b3c1b110ea3815e6`.

Archived beak-02 raster manifest SHA-256: `90b813ceaac8120a1e5948feac7eb1821f1893e47346b7b257fa0a343b0be059`.

## Archived rough-01 local comparison

The results below belong exclusively to `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`, which preserves the matching rough-01 output, export manifest and benchmark. They are retained for comparison, not transferred to later sculpts, beak-02 or eyelid-03.

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

This archived comparison supports continued evaluation of a static default with a bounded pre-rendered reaction. It does not approve any 3D artwork, validate the adapters on physical targets, or measure the eyelid-03 state bundle. The approved app/native static portrait remains the fallback; PR55's static full-body greeting is a separate accepted and merged delivery change. See ART_REVIEW.md and PERFORMANCE_PLAN.md for the remaining decisions.

Evidence: the matching `output/benchmark.json` and `output/export-manifest.json` **inside the rough-01 archive**, not the mixed-revision working output directory.

Archived rough-01 export manifest SHA-256: `51d74717770ebbac6e5fcc8da2f3c8b014a5fd83bb364b26eccd6316602d0b03`.

Archived rough-01 benchmark SHA-256: `a126179d9210c0f30493387edafdb97930c07441f75a6b46123516740492546a`.
