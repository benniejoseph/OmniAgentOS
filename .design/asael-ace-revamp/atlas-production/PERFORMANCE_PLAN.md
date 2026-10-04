# ATLAS delivery evidence plan

**Current boundary, 4 October 2026:** sculpt-02 export is complete but actual likeness is insufficient. Web/native bounded raster adapters are implemented; root passed 26 web adapter unit cases, full native analysis with no issues, and all 37 companion cases. The approved static portrait remains in use. The public metadata-only `awaiting-art-review` manifest and web `no-cache` revalidation do not publish artwork. No sculpt-02 publication or physical-device performance acceptance has occurred.

The 36-case local comparison in [MEASUREMENTS.md](MEASUREMENTS.md) belongs to archived **rough-01**, at `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`. Current `output/benchmark.json` is an old leftover and does not measure sculpt-02. No old timing or memory estimate is a budget result for the larger mesh or current sprite format.

## Delivery paths and evidence

| Delivery | Current implementation/evidence | Remaining limit |
| --- | --- | --- |
| Approved static portrait | Existing web/native fallback; independent controls and status retained | Measure any changed production startup/asset costs against this baseline |
| Rough-01 generated still / live GLB / nineteen-frame sequence | Archived 36-case headless loopback comparison at 36/256px and DPR1/2 | Old source only; no physical/mobile/native result |
| Sculpt-02 live GLB | Actual 1,414,604-byte GLB, 18,390 vertices, 33,718 triangles, 14 bones, 12 clips | Not final art; no fresh comparative runtime measurement; no production native 3D renderer assumed |
| Sculpt-02 state posters/sprites | 32 transparent WebP images plus manifest; eight states, both theme slots, 256px, 20Hz, four columns | Not published or visually accepted; asset bytes/decode/frame/energy costs need a matching run |
| Web state adapter | Bounded manifest/player/fallback implemented; 26 unit cases passed in root's `atlas-production-adapter-unit.log` | Unit coverage is not browser, device, artwork or performance certification |
| Native state adapter | Bounded local-asset player/fallback implemented; full analyzer clean and all 37 companion cases passed | Later package pending; physical-target evidence remains separate |

Root also passed nine Node geometry/lifecycle checks and three Python tool tests for sculpt-02. The complete web adapter build passed in `atlas-adapter-final-web-build.log` before the subsequent metadata-only manifest/cache change. These checks do not establish a measured current-asset performance budget.

The shared format admits at most 1200ms and 25 frames, with `ceil(durationMs / 50) + 1` samples including a clamped final endpoint. Current source uses at most 1120ms/24 frames. These are implemented admission limits, **not measured performance budgets**. Keep existing app route budgets unchanged.

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
| Supported macOS native build and auxiliary windows | Packaged asset admission, quick-entry/voice/control independence, background/reopen/disposal, memory and energy | Analyzer and companion cases passed; later package and physical measurements pending |
| Supported iOS native build | Packaged static/pre-rendered path, startup, voice/control independence, failure fallback, lifecycle and energy | Pending; no live 3D renderer required or assumed |
| Supported Android native build | Same evidence as iOS, including lifecycle loss/recreate | Pending; no live 3D renderer required or assumed |
| Production web route | Same-revision static baseline, unchanged route-budget compliance and actual delivered asset costs | Separate from standalone lab; pending current-asset comparison |

For battery/thermal work, record physical device, ambient conditions, display brightness, battery/charging state, network, workload duration, measurement tool/version and baseline. Compare static and candidate under the same conditions. Do not infer watts, GPU allocation or thermal suitability from browser frame timing.

## Publication and release boundary

First obtain actual visual acceptance of a matching export. Only then may root invoke `scripts/atlas/publish.py --accept-reviewed`; it verifies current source/artifact hashes and exact bounded transparent assets before copying the manifest and images to the web/native asset directories. No publication has occurred, and the rejected sculpt-02 bundle must not be admitted by treating successful export as review approval. Publication is not deployment or physical-device certification.

The functional product can ship with the approved static portrait and implemented fallback/player boundaries, through normal build/migration/deployment gates. TASKS phase 2 and task 2.6 allow this usable milestone before final clips. Keep final creative likeness, eight-state visual acceptance and physical performance evidence outstanding; do not declare the whole plan complete. Broad regression deferral changes scheduling, not these evidence limits.
