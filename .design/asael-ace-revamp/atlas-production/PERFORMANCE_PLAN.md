# ATLAS delivery evidence plan

**Current boundary, 5 October 2026 (IST):** wing-02 is the last complete matching export and visual review, with all nine structure checks passing. Root retained completed-02's breast fold after 60 actual comparisons, then wing-02's underform contact and lower-tail compression after 60 actual comparisons and an independent rest/peak/portrait review; the dangling spur is removed. Throat-05 and throat-06 were each rejected after 30 comparisons and fully reverted, restoring wing-02's original throat exactly. Throat/lid edges, torso cut-like accents, the sharp crown, overall finish/likeness, all-state acting, delivery-size readability and device performance remain unaccepted. Primary-01, completed-01, eyelid-03, throat-04 and beak-02 are historical checkpoints. Web/native bounded raster adapters are implemented; the earlier adapter checkpoint passed 26 web unit cases, full native analysis and all 37 companion cases. The approved static portrait remains the fallback. PR55's static full-body greeting and PR56's scoped language/motion intensity are accepted and merged, each after all 16 hosted checks passed, with private Mac packages verified through 1.23.15 (50). The public metadata-only `awaiting-art-review` manifest and web `no-cache` revalidation do not publish 3D artwork. No 3D/state-bundle publication or physical-device performance acceptance has occurred.

The 36-case local comparison in [MEASUREMENTS.md](MEASUREMENTS.md) belongs to archived **rough-01**, at `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`. Retained `output/benchmark.json` is an old leftover and does not measure wing-02. No old timing or memory estimate is a budget result for the larger mesh or state sprite format.

Software UI priorities through PR57 are accepted. Its expanded web Voice shared-player integration passed all 14 applicable hosted checks; native API/version and the verified Mac 1.23.15 (50) package are unchanged. Wing-02 retains completed-02's breast fold and adds underform contact/lower-tail compression; rejected throat-05/06 studies were fully reverted. Final art, physical-device/performance and production-environment gates remain open.

## Delivery paths and evidence

| Delivery | Current implementation/evidence | Remaining limit |
| --- | --- | --- |
| Approved static portrait | Existing web/native fallback; independent controls and status retained | Measure any changed production startup/asset costs against this baseline |
| Approved static full-body greeting | PR55 accepted and merged after all 16 hosted checks passed; app 1.23.14+49 private package verified; full Flutter analysis, 21 focused cases, 39 browser checks and five native captures passed | No production or physical-device performance claim |
| Rough-01 generated still / live GLB / nineteen-frame sequence | Archived 36-case headless loopback comparison at 36/256px and DPR1/2 | Old source only; no physical/mobile/native result |
| Wing-02 live GLB | Last complete export: 2,039,724-byte GLB, 27,240 vertices, 49,844 triangles, 14 bones, 12 clips | Not final art; no fresh comparative runtime measurement; no production native 3D renderer assumed |
| Wing-02 state posters/sprites | 32 transparent WebP images plus manifest; eight states, both theme slots, 256px, 20Hz, four columns | Not published or visually accepted; asset bytes/decode/frame/energy costs need a matching run |
| Primary-01 checkpoint | Matching source/output retained in `atlas-primary-01-review.tar.gz`; 2,039,712-byte GLB with the same geometry counts as wing-02 | Historical export, not the current model or a performance result |
| Completed-01 checkpoint | Matching source/output retained in `atlas-completed-01-review.tar.gz`; 2,039,716-byte GLB with the same geometry counts as wing-02 | Historical export, not the current model or a performance result |
| Beak-02 baseline | Matching source/output retained in `atlas-beak-02-review.tar.gz` | Historical export, not the current model or a performance result |
| Web state adapter | Bounded manifest/player/fallback implemented; 26 unit cases passed in root's `atlas-production-adapter-unit.log` | Unit coverage is not browser, device, artwork or performance certification |
| Native state adapter | Bounded local-asset player/fallback implemented; full analyzer clean and all 37 companion cases passed; later signed packages are ready | Physical-target evidence remains separate; 3D/state bundle is not packaged for delivery |
| Scoped language and motion intensity | PR56 accepted; 277 focused web/server checks, full Flutter analysis and 11 companion checks passed; private Mac 1.23.15 (50) verified | No database/API version change, art publication or physical-device performance claim |
| Expanded web Voice shared player | PR57 accepted after all 14 applicable hosted checks; 48 focused unit checks, 114 maintained browser checks and ESLint passed; exact-head hosted full browser suite passed | Web-only; native API/version and Mac 1.23.15 (50) unchanged; no new artwork or physical-device performance evidence |
| Eyelid-03 / throat-04 checkpoints | Matching source/output retained in `atlas-eyelid-03-review.tar.gz` and `atlas-throat-04-review.tar.gz`; each has 27,190 vertices and 49,748 triangles | Historical exports, not the current model or performance results |

All nine wing-02 structure checks passed. Historical sculpt-04 evidence includes all nine geometry/lifecycle checks passing. Historical sculpt-02 evidence includes nine Node geometry/lifecycle checks, three Python tool tests and the complete adapter web build in `atlas-adapter-final-web-build.log` before the subsequent metadata-only manifest/cache change. PR53/PR54/PR55/PR56 later passed all 16 hosted checks each and have signed private packages ready. These checks do not establish a measured wing-02 performance budget.

The shared format admits at most 1200ms and 25 frames, with `ceil(durationMs / 50) + 1` samples including a clamped final endpoint. The wing-02 export uses at most 1120ms/24 frames. These are implemented admission limits, **not measured performance budgets**. Keep existing app route budgets unchanged.

## Matching local comparison

Any new comparison must bind its exact source and export hashes; do not run against a stale mixed-revision manifest. Archive prior evidence before replacing output. Record browser, OS, renderer/GPU when exposed, theme, CSS size, DPR, timestamps, tool versions, network/cache conditions and raw sample counts. A headless/software result must remain labeled as such.

Use serial workloads on the 8GB development machine. The old baseline used three repetitions per mode, 36/256px and DPR1/2, with uncompressed loopback requests and disabled HTTP cache. It was a short workload, not a sustained soak. A new state-player comparison must measure the actual poster/sprite path rather than treating the retained nineteen-frame lab alternative as equivalent.

Metrics retain narrow meanings:

- Delivery-ready timing measures mode initialization, not GPU/compositor completion.
- Import, fetch/parse, compile and image decode may be reported separately when present.
- CPU submission/frame-work samples exclude asynchronous GPU work.
- Animation-frame callback intervals are not guaranteed presented frames or an FPS promise; report sample count and distributions.
- The independent-control handler-to-second-frame value is a lab responsiveness proxy, not field INP.
- Geometry/texture/draw counts are object counts. RGBA size multiplication is an arithmetic estimate, not measured allocation or GPU residency.

Production route/bundle analysis is distinct from standalone asset-transfer measurements. No warm-cache, compressed-download, field interaction or native startup claim follows from the old loopback run.

## Functional lifecycle evidence

The archived rough-01 lab passed its declared static-idle, one-shot-end, interruption, reduced-motion, offscreen, hide/show, disposal, held-late-load, asset-failure and independent-control checks. Its headless backend did not expose a real hidden-document transition, so that result remains **unobserved**. Do not carry these results forward as proof of the current production adapters.

The production player must preserve actual microphone/playback precedence and exact verified completion identity. Check no replay after visibility, theme, preferences, owner or conversation changes; consume suppressed transitions; prime restored terminal history; prevent a late manifest/image from reviving an obsolete clip; and release timers/image work on interruption or disposal. A missing or rejected bundle must keep the approved static portrait, readable status and all controls. Root's 26 web unit cases and 37 native companion cases are evidence for their tested boundaries, not for real-device scheduling, energy use or visual acceptance.

## Physical target matrix — outstanding

| Target | Evidence required | Status |
| --- | --- | --- |
| Supported desktop browser | Cold/warm startup, control latency, real foreground/background, sustained frame pacing, memory and asset failure | Pending for the current bundle/adapter |
| Supported mobile web device | Actual device/OS/browser, touch latency, power/network conditions, memory pressure, thermal/battery traces | Pending |
| Supported macOS native build and auxiliary windows | Packaged asset admission, quick-entry/voice/control independence, background/reopen/disposal, memory and energy | Analyzer and companion cases passed; signed private packages ready; physical measurements pending |
| Supported iOS native build | Packaged static/pre-rendered path, startup, voice/control independence, failure fallback, lifecycle and energy | Pending; no live 3D renderer required or assumed |
| Supported Android native build | Same evidence as iOS, including lifecycle loss/recreate | Pending; no live 3D renderer required or assumed |
| Production web route | Same-revision static baseline, unchanged route-budget compliance and actual delivered asset costs | Separate from standalone lab; pending current-asset comparison |

For battery/thermal work, record physical device, ambient conditions, display brightness, battery/charging state, network, workload duration, measurement tool/version and baseline. Compare static and candidate under the same conditions. Do not infer watts, GPU allocation or thermal suitability from browser frame timing.

## Publication and release boundary

First obtain actual visual acceptance of a matching export. Only then may root invoke `scripts/atlas/publish.py --accept-reviewed`; it verifies current source/artifact hashes and exact bounded transparent assets before copying the manifest and images to the web/native asset directories. No 3D/state-bundle publication has occurred, and the unaccepted wing-02 bundle or any later mismatched source must not be admitted by treating export or comparison renders as review approval. Publication is not deployment or physical-device certification.

The functional product can ship with the approved static portrait and implemented fallback/player boundaries, through normal build/migration/deployment gates. TASKS phase 2 and task 2.6 allow this usable milestone before final clips. Keep final creative likeness, eight-state visual acceptance and physical performance evidence outstanding; do not declare the whole plan complete. Broad regression deferral changes scheduling, not these evidence limits.
