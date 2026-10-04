# ATLAS export and measurement records — 5 October 2026 (IST)

## Last complete finish-03 export: no matching performance comparison

The retained `output/export-manifest.json` was written at `2026-10-04T20:32:41.680641+00:00` (5 October in IST) for `sculpt-04-finish-03-padded-color-chart`. It records **104 artifacts** and a **2,321,804-byte GLB**, with **27,543 vertices, 49,844 triangles, 14 bones and 12 clips**: eight application states plus the four inspection aliases `rest`, `quick_reaction`, `speech_test` and `satisfied_nod`. Runtime records Three.js 0.186.0, headless Chrome 154.0.8037.94 and ANGLE/Metal reporting Apple M2. These are export/renderer facts, not measured responsiveness, battery or thermal results. Matching source/output is archived in `atlas-finish-03-review.tar.gz`; root verified all 17 current source hashes, all 104 artifact hashes/bytes and reread all 152 archive members in `atlas-finish-03-export-verification.json`. It has one material, one embedded 512 × 512 RGBA8 color texture and zero external resources. All nine new model/lifecycle checks passed; the earlier static tool tests were not rerun. Forty body comparisons retained lower relief across 44 breast/mantle tufts without a new profile/rear gap or protrusion. Eighteen padding comparisons removed the horizontal pale temple line; descending temple geometry remains rough. Small body slits/marks, feather flow, eye/wing-joint finish, overall likeness, natural acting, delivery-size readability and device performance remain unaccepted. The prior 80-state review belongs to finish-02 and was not rerun.

The finish-03 state bundle contains a schema-version-1 manifest and 32 transparent WebP assets: light/dark poster and sprite for each state, 256px frames, four columns and 20Hz inclusive sampling. Its durations are 600–1120ms and frame counts 13–24; the shared format admits at most 1200ms/25 frames. Theme pairs have identical image hashes. No 3D/state bundle has been published, and actual-art review found final likeness insufficient; see [ART_REVIEW.md](ART_REVIEW.md). The complete export binds finish-03; no matching performance measurement is claimed.

Root's `atlas-production-adapter-unit.log` records **26 passing web adapter unit cases** on 4 October 2026, including the public metadata-only `awaiting-art-review` response. The web manifest reader uses `no-cache` revalidation; this placeholder publishes no artwork and retains the approved neutral portrait. The full native analyzer reported no issues in `atlas-native-adapter-analyze.log`, and **all 37 companion cases passed** in `atlas-companion-final-regression.log` (the earlier 15-case run was a focused subset, not an additional total).

Historical sculpt-04 evidence includes **all nine geometry/lifecycle checks** passing. Historical sculpt-02 evidence includes **nine Node geometry/lifecycle checks** in `atlas-sculpt-02-structure-tests.log` and **three Python tool tests** in `atlas-sculpt-02-tool-tests.log`. The earlier full adapter web build passed in `atlas-adapter-final-web-build.log` before the subsequent manifest/cache change. Its package-preparation status is superseded by the accepted PR53/PR54/PR55 release checkpoints and signed packages in [IMPLEMENTATION.md](../IMPLEMENTATION.md); PR55 is merged after all 16 hosted checks passed and its private greeting package is verified. These are implementation/build checks, not physical-device or finish-03 performance measurements. Evidence logs are under `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/`.

PR56 is accepted and merged after all 16 hosted checks passed on `a3fb4215b632f8b6d56487e3617b0afb82085aba`. Its scoped language and motion-intensity implementation passed **277 focused web/server checks**, full Flutter analysis and **11 companion checks**. The private Mac 1.23.15 (50) package is verified from that exact source. There is no database/API version change and no new art or performance measurement in this release.

PR57's web-only expanded Voice shared-player integration is accepted and merged after all 14 applicable hosted checks passed on `76a2230e911d1d8436c731fc965f53037b5dadd6`. The 48 focused unit checks, 114 maintained browser checks and ESLint passed. Local compact/greeting validation reached 75 passing checks before a 180-second document-navigation timeout; that local run was incomplete. The complete browser suite passed on the exact hosted head. Native API/version and the verified Mac 1.23.15 (50) package are unchanged. These results supply no new artwork or physical-device performance acceptance.

Finish-03 export manifest SHA-256: `fe1a30d2fda61a494ece550312476d4b7c7403c36ebb32044a3a3e84ebf535ff`.

Finish-03 raster manifest SHA-256: `f0cacea831488baf3a12ef3904c8a8cbf92118c4a8199cacbf76344ebe9daa9e`.

Finish-03 archive SHA-256: `179fa4c55775942d0c7e04bd2701a38f96f618b7091a253ea8027d2d30cedbb7`.

Exact comparison changes only positions/derived normals in 44 breast/mantle parts and 31,488 texture-margin pixels. All 123 other parts, complete indices, colors, UVs, skin indices/weights, chart interior, separate white patch, rig, poses, palette and clips remain exact against finish-02. Forty body comparisons retained lower relief; eighteen temple-tuft diagnostic captures left the horizontal line visible, and eighteen padding-only comparisons removed it. No temple tuft was removed from retained source.

Forty source/exported-GLB captures preserve one decoded 512 × 512 texture per mode. Eight rest pairs are pixel-identical; the other twelve pairs differ by 0–10 pixels each and at most one channel value (31 pixels total). Hide/reload/dispose pass with zero page/console/rejected-network errors. These checks do not establish allocation, GPU reclamation, natural acting or physical-device performance. The nine static tool tests and 80-state review were not rerun; those results remain attributed to finish-02 below.

**The remaining `output/benchmark.json` is stale rough-01 evidence.** It predates the later sculpts and must not be paired with the finish-03 export manifest or used to claim that the larger model/state bundle meets the old timings. A fresh matching comparison has not been recorded here.

## Archived finish-02 checkpoint

The historical `sculpt-04-finish-02-seam-safe-color` export at `2026-10-04T20:07:57.362206+00:00` is retained in `atlas-finish-02-review.tar.gz`. It contains 104 artifacts, a 2,321,804-byte GLB, 27,543 vertices, 49,844 triangles, 14 bones, 12 clips, one material and one embedded 512 × 512 RGBA8 texture, with 17 source hashes and 146 archive members verified. All nine model/lifecycle checks and nine static tool tests passed at that checkpoint. Forty comparisons retained the smooth throat, shorter crown and removal of finish-01's large pale head cracks.

Finish-02 adds one deterministic 512 × 512 RGBA8 color texture and shortens six crown pieces. It duplicates 303 shared UV-seam vertices (126 silhouette and 177 plumage), producing 27,543 vertices while retaining 49,844 triangles and 167 parts. All 149,532 ordered triangle corners preserve skin bindings; non-crown positions/normals, all 159 other part arrays/relative indices, rig, poses and all 12 clips/168 tracks remain exact. Finish-01 was rejected for pale head cracks; texture-only isolation identified UV interpolation across the pale throat chart.

The initial GLB reload was blocked by the lab's CSP blob-fetch policy and displayed a white body without its map. That failure is preserved in `finish02-glb-parity`. The lab now allows its embedded blob fetch and requires the decoded color map. In `finish02-glb-parity-fixed`, 40 procedural/reloaded captures retain one texture in each mode: eight rest pairs are pixel-identical; the remaining twelve pairs differ at 0–10 pixels per image, by at most one channel value, totaling 31 pixels across all twenty pairs. Page/console/network errors are zero, and hide, explicit reload and disposal pass in both modes. Cleanup deduplicates maps/bitmaps; these observations do not measure allocation or resource reclamation.

Root reviewed all 80 exported state frames (eight states × five samples × two themes) in four `finish02-state-review` sheets. The throat stays smooth, no new large pale head/crown breakthrough was seen and completion fold/return remains coherent. These are still observations, not natural-motion or device approval. State-review archive SHA-256: `dee010d2abde804667543cd5f3b71835522e4f54cd197cbd382ddfae16f798b0`.

Archived finish-02 export manifest SHA-256: `6932d66e120c84b62000b4dc44664389d029cf564b3c4a4f3c3629a51af1a5e1`.

Archived finish-02 raster manifest SHA-256: `3c84431f9f5256122bef5f975fcc5e0844c8c90bbcb8af9ee690a9b3cf27893d`.

Archived finish-02 archive SHA-256: `3c9f954a2d0bbd8c179e447c30214bf17af5fc5c697bf859d72fddc00d47520a`.

## Archived wing-02 checkpoint

The historical `sculpt-04-wing-02-mesh-contact` export at `2026-10-04T19:37:43.326236+00:00` is retained in `atlas-wing-02-review.tar.gz`. It contains 104 artifacts, a 2,039,724-byte GLB, 27,240 vertices, 49,844 triangles, 14 bones and 12 clips, with 17 source hashes and 139 archive members verified. All nine structure/lifecycle checks passed. Completed-02's breast fold and wing-02's contact/lower-tail compression were each retained after 60 actual comparisons; wing-02 also received independent rest/peak/portrait review, and the dangling spur was removed. Throat-05/06 were each rejected after 30 comparisons and fully reverted at that checkpoint.

Completed-02 changed exactly one `WingTipLeft` quaternion track; geometry and the other 11 clips were exact. Wing-02 then changed 24 coverts, with the other 143 parts, all topology, rig, poses, clips and palette exact against completed-02. Throat-05/06 diagnostics found interpolation bands even in isolated layers; both rejected studies were fully reverted before this matching export. These comparisons do not measure performance or accept the full character.

Archived wing-02 export manifest SHA-256: `8096da6653d3e2a22596343e895d6d50b49e4a2aaf8075a6e5a15e047962af3c`.

Archived wing-02 raster manifest SHA-256: `4a1b1d1da6123eed178f48f555187f991dd41575b9c053da37f163ef9d05b922`.

Archived wing-02 archive SHA-256: `ac287508e845048e901edd734a8291d49b5abcbad51c3d2e561380c945027a32`.

## Archived primary-01 checkpoint

The historical `sculpt-04-primary-01-overlapping-fan` export at `2026-10-04T18:55:02.119850+00:00` is retained in `atlas-primary-01-review.tar.gz`. It contains 104 artifacts, a 2,039,712-byte GLB, 27,240 vertices, 49,844 triangles, 14 bones and 12 clips, with 17 current source hashes and 129 archive members verified. All nine structure checks passed. Its 48 comparison captures retained the compact overlapping fan without a new large sampled joint gap; independent rest/peak/peak-portrait review found no regression that blocked retention. Mechanical joint tabs and the downward gesture fan remained unaccepted at that checkpoint.

Exact comparison shows only 16 primary parts changed; the other 151 parts, all indices, rig, poses, clips and palette are unchanged. The narrow comparison archive is `primary01-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `9255860ff9b93e3e3f075d9f3a7a3880279d7ddb0bb284868112837fb598e5da`. These checks do not measure performance or accept the full character.

Archived primary-01 export manifest SHA-256: `7c8edd39f0914824956523fa9920977daeb82c3564736682c69e524d6263923a`.

Archived primary-01 raster manifest SHA-256: `a39d4798ad2d3312f63e008d2730f837ab4b0ae35ceaa0b914eb3d36092ec3f6`.

Archived primary-01 archive SHA-256: `4e6f41976e761ea0cb92b135b77c4f96275c17da63682de826dbeb623e036f99`.

## Archived completed-01 checkpoint

The historical `sculpt-04-completed-01-forward-clearance` export at `2026-10-04T18:41:03.423334+00:00` is retained in `atlas-completed-01-review.tar.gz`, from checkpoint `2e8c330299bbc508211894819c6ace136e3bab23`. It contains 104 artifacts, a 2,039,716-byte GLB, 27,240 vertices, 49,844 triangles, 14 bones and 12 clips, with 17 matching source hashes and all nine structure checks passing. Its 48 acting captures retained torso clearance and return alongside the body while the long parallel primaries and coarse junction remained unaccepted. Eyelid-04's 24 captures had retained profile coverage and readable neutral irises, with fine edge specks remaining.

The completed-01 comparison uses byte-identical geometry to eyelid-04 and leaves the other 11 clips identical. Across 2,172 non-wing quaternion samples, the maximum difference is `4.246830940246582e-7`. These narrow comparison checks do not measure performance or accept the acting. The matching archive includes bound sources, artifacts, reference and review helper scripts.

Archived completed-01 export manifest SHA-256: `ebba096e6d27382fc1c8244df9340f0deaaa57f12150e3450e8b0f4c33914fb8`.

Archived completed-01 raster manifest SHA-256: `6453dfee0b275ca44f778a7a44c8e935485bbc5ded8c2e61f4904913ddf87376`.

Archived completed-01 archive SHA-256: `e3de498df9ca902689bd9aab0f3b6164fb573fc8e06db7f2ff9b7cff86d85e21`.

## Archived eyelid-03 checkpoint

The historical `sculpt-04-eyelid-03-interior-surface-clearance` export at `2026-10-04T18:03:14.083731+00:00` is retained in `atlas-eyelid-03-review.tar.gz`. It contains 104 artifacts, a 2,035,216-byte GLB, 27,190 vertices, 49,748 triangles, 14 bones and 12 clips. All nine structure checks passed. Rest/mid/peak-blink front/three-quarter/profile review retained reduced forward bulge, removal of front white breakthrough and a legible neutral iris, with a thin outer white seam and profile gap still visible. This was a local improvement without final blink or art acceptance.

Archived eyelid-03 export manifest SHA-256: `9eb70a01ed62ce630de1c866b4550064890233a42abe796e205293213e88e8cf`.

Archived eyelid-03 raster manifest SHA-256: `863daf3362c45dd6fe08f8f5361c83ff10a31642923637695e1e8b1be50f45fa`.

The later retained tuft-01, grain-01 and wing-01 comparisons are preserved in `tuft01-comparison/matching-source-and-baseline.tar.gz`, `grain01-comparison/matching-source-and-baseline.tar.gz` and `wing01-comparison/matching-source-and-baseline.tar.gz` under the same release evidence directory. These are matching comparison archives, not separate full exports; their changes are included in completed-01 and subsequent full exports, including current finish-03.

## Archived throat-04 checkpoint

The historical `sculpt-04-throat-04-refined-boundary-sampling` export at `2026-10-04T17:30:25.836966+00:00` is retained in `atlas-throat-04-review.tar.gz`. It contains 104 artifacts, a 2,035,216-byte GLB, 27,190 vertices, 49,748 triangles, 14 bones and 12 clips. All nine structure checks passed. Front/three-quarter review retained the finer boundary, with no holes or detached strips, while leaving final art unaccepted. The historical eyelid-03 checkpoint retains these counts with changed source/weights; this archive is a historical checkpoint.

Archived throat-04 export manifest SHA-256: `11560d413754487581c6c18541d1cc88d70d4eaf0ce6a8b62e1edcc3985a1710`.

Archived throat-04 raster manifest SHA-256: `766d3e1109b5b165e236970170d3163b45c35bca59e7233013f535bdadd89f95`.

## Archived beak-02 baseline

The historical `sculpt-04-beak-02-curved-hook-jaw-contact` export at `2026-10-04T17:00:41.390833+00:00` is retained in `atlas-beak-02-review.tar.gz`. It contains 104 artifacts, a 1,754,824-byte GLB, 23,314 vertices, 41,700 triangles, 14 bones and 12 clips. Root's 18 comparison captures found the beak improved while the full model remained unaccepted. This baseline is not the current complete export. The intervening throat-03 source study was rejected for its coarse staircase boundary.

Archived beak-02 export manifest SHA-256: `8cdda6f89d9e830b9c11b7f3ea2ba4f5f7e1c7521e0a4239b3c1b110ea3815e6`.

Archived beak-02 raster manifest SHA-256: `90b813ceaac8120a1e5948feac7eb1821f1893e47346b7b257fa0a343b0be059`.

## Archived rough-01 local comparison

The results below belong exclusively to `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`, which preserves the matching rough-01 output, export manifest and benchmark. They are retained for comparison, not transferred to later sculpts or finish-03.

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

This archived comparison supports continued evaluation of a static default with a bounded pre-rendered reaction. It does not approve any 3D artwork, validate the adapters on physical targets, or measure the finish-03 state bundle. The approved app/native static portrait remains the fallback; PR55's static full-body greeting is a separate accepted and merged delivery change. See ART_REVIEW.md and PERFORMANCE_PLAN.md for the remaining decisions.

Evidence: the matching `output/benchmark.json` and `output/export-manifest.json` **inside the rough-01 archive**, not the mixed-revision working output directory.

Archived rough-01 export manifest SHA-256: `51d74717770ebbac6e5fcc8da2f3c8b014a5fd83bb364b26eccd6316602d0b03`.

Archived rough-01 benchmark SHA-256: `a126179d9210c0f30493387edafdb97930c07441f75a6b46123516740492546a`.
