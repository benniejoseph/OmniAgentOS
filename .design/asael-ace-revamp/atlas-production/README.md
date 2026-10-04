# ATLAS editable source and delivery lab

**Status, 5 October 2026 (IST): wing-02 is the last complete matching export and visual review; the full model remains unaccepted and unpublished.** The export records 104 artifacts, including a self-contained 2,039,724-byte skinned GLB with 27,240 vertices, 49,844 triangles, 14 bones and 12 clips. All nine final structure/lifecycle checks passed. Root retained completed-02's breast fold after 60 actual comparisons, then wing-02's underform contact and lower-tail compression after 60 actual comparisons and an independent rest/peak/portrait review; the dangling spur is removed. Throat-05 and throat-06 were each rejected after 30 comparisons and fully reverted, restoring wing-02's original throat exactly. Throat/lid edges, torso cut-like accents, the sharp crown, overall finish/likeness, all-state acting, delivery-size readability and device performance remain unaccepted. The eight application-state clips and four inspection aliases are authored, but their existence is not artistic acceptance. Primary-01, completed-01, eyelid-03, throat-04 and beak-02 remain historical checkpoints. See [ART_REVIEW.md](ART_REVIEW.md) for the actual findings.

The approved static concept portrait remains the web/native fallback. Web and native bounded raster adapters are implemented; the earlier adapter checkpoint passed 26 web unit cases, full native analysis and all 37 companion cases. PR54's UI revamp and PR55's approved full-body static greeting are accepted and merged. PR55 passed all 16 hosted checks on `e9f1fbdbcf8f5e4bc576787e7d355820787490ba`; its private Mac app 1.23.14+49 package is verified. No 3D/state bundle has been published. The public HTTP-200 manifest contains only `{"schemaVersion":1,"status":"awaiting-art-review"}`; the web reader uses `no-cache` so later reviewed metadata is revalidated, while the placeholder retains the approved neutral portrait. The retained `output/benchmark.json` is stale rough-01 evidence, not a measurement of wing-02. [MEASUREMENTS.md](MEASUREMENTS.md) separates those revisions; [IMPLEMENTATION.md](../IMPLEMENTATION.md) records release acceptance.

PR56's scoped language preference and web/native motion intensity are accepted and merged after all 16 hosted checks passed on `a3fb4215b632f8b6d56487e3617b0afb82085aba`. All 277 focused web/server checks, full Flutter analysis and 11 companion checks passed; the private Mac 1.23.15 (50) package is verified. This changes neither the database/API version nor the unpublished art bundle, and does not establish physical-device performance.

PR57's expanded web Voice integration shares the bounded ATLAS player and is accepted and merged after all 14 applicable hosted checks passed on `76a2230e911d1d8436c731fc965f53037b5dadd6`. The 48 focused unit checks, 114 maintained browser checks and ESLint passed. The complete browser suite passed on that exact hosted head after an incomplete local compact/greeting run. This web-only change leaves native API/version and the verified Mac 1.23.15 (50) package unchanged. Software UI priorities through PR57 are accepted; final artwork, physical-device/performance acceptance and production promotion remain open.

## Source and usage record

- Reference: `../references/atlas-selected.png`, a 2560 × 2256 generated concept contact sheet, **not** an editable model or sprite-ready rig.
- Provenance: `../references/atlas-export.json`; selected Stitch project `4399395118624914882`, “ATLAS — Personality Study.”
- Approved reference SHA-256: `876591c5a2b739df99d6aab647554dc53bcab97d55bf0c3e0864e39e1c98c070`.
- The user selected this original generated reference and authorized the Asael implementation, including derivative construction and local measurement work. This records project usage authorization and source provenance; no third-party character model or texture is included.
- SVG paths, procedural mesh topology, bone placement, palette interpretation and clip keyframes are editable authored source. No image-generation API, external character asset, celebrity likeness, sampled voice or downloaded texture was used in this construction. Voice is absent.
- Procedural seed: **0**, with no random generator. Source geometry and clip inputs are deterministic; browser/GPU pixels and GLB bytes are not promised identical across tool versions or machines. The exporter records actual source hashes and tool versions.
- Last fully exported creative revision: `sculpt-04-wing-02-mesh-contact`. The retained `atlas-rough.glb` filename is a compatibility name, not a final-art label. Any subsequent source revision requires its own matching complete export before these output facts can change.
- This matching checkpoint retains primary-01 and earlier work. Completed-02 changed one `WingTipLeft` quaternion track, with geometry and the other 11 clips exact. Wing-02 then changed 24 coverts, with the other 143 parts, all topology, rig, poses, clips and palette exact against completed-02. Local improvement does not establish final art or all-state acting acceptance.

## Editable files

| File | Purpose |
| --- | --- |
| `sheets/model-sheet.svg` | Editable front, profile and three-quarter construction, palette and collar reference. |
| `sheets/expression-sheet.svg` | Expression and timing construction. Keep its adjacent model-sheet reference groups together or expand them in a vector editor. |
| `sheets/atlas-front.svg` | Standalone vector construction reference; not an actual mesh render. |
| `source/model.json` | Proportions, palette, camera, 14-bone hierarchy, static poses and eight state performances. |
| `source/atlas-model.mjs` | Procedural geometry, skin influences, material, state clips, four inspection aliases and pose reset. |
| `source/REVISION_NOTES.md` | Authored revision history and intended scope; source edits do not establish a matching export or artistic acceptance. |
| `web/` | Isolated lab, lifecycle gate, viewer and export hooks. No session, microphone, provider or execution channel. |
| `../../../scripts/atlas/` | Root-run export, inspection, local comparison and explicit publication tools. |

The GLB has actual geometry, skin, joints and animation channels. It can be opened by a compatible editor, but no Blender scene or Blender import compatibility has been certified. JS/JSON remain the editable source of record. Vector sheets and procedural geometry are separate constructions; the actual renders must be compared with the approved study rather than assuming either construction proves likeness.

## State clips and delivery boundary

The last complete wing-02 eight-state raster export uses transparent 256px WebP posters and sprite sheets, sampled at 20Hz with four columns. Each clip includes its final endpoint: `frameCount = ceil(durationMs / 50) + 1`, with the last sample clamped to the authored duration. No clip loops.

| Application state | Duration | Frames per theme |
| --- | ---: | ---: |
| `available` | 600ms | 13 |
| `listening` | 640ms | 14 |
| `responding` | 1120ms | 24 |
| `working` | 660ms | 15 |
| `needs_you` | 900ms | 19 |
| `blocked` | 720ms | 16 |
| `completed` | 900ms | 19 |
| `paused` | 660ms | 15 |

The additional GLB clips `rest`, `quick_reaction`, `speech_test` and `satisfied_nod` are retained inspection aliases. They are not additional application states or independent success signals. The synthetic beak test has no audio or phoneme alignment; the responding gesture does not claim lip sync.

`output/atlas-v1/manifest.json` binds wing-02, with schema version 1, frame size 256, fps 20, columns 4, and exactly those eight states. Each state has a duration, frame count and light/dark poster/sprite basenames with SHA-256 hashes. The shared admission bound is at most 1200ms and 25 frames; this export uses at most 1120ms and 24 frames. The bundle contains 32 images plus the manifest. Its transparent light/dark image pairs have identical hashes because they share the same lighting without a composited backdrop; their names alone do not establish distinct theme treatment.

The implemented adapters keep actual microphone/playback precedence, separate work status and verified completion identity. State/receipt observations consumed while motion is suppressed must not replay on return, theme change or late asset arrival. Reduced motion supplies a static image. Hidden/offscreen/disposed instances cancel pending motion, and controls never wait for animation. Assets remain decorative and cannot authorize tools, recording, playback or run completion. The approved static portrait stays available when the bundle is absent or invalid.

## Export and inspection — root execution only

Root exported wing-02 at `2026-10-04T19:37:43.326236+00:00` (5 October in IST) using Three.js 0.186.0, headless Chrome 154.0.8037.94 and a renderer reporting Apple M2 through ANGLE/Metal. The manifest retains `ROUGH_RENDERED_NOT_REVIEWED` as the export-time status; subsequent review retained local improvements while leaving final art and acting acceptance open. Matching source and output are archived in `atlas-wing-02-review.tar.gz` under the release evidence directory. Root verified all 17 current source hashes, all 104 artifact hashes/bytes and reread all 139 archive members in `atlas-wing-02-export-verification.json`; [MEASUREMENTS.md](MEASUREMENTS.md) records the manifest and archive hashes. Structural export success is not visual or physical-device acceptance.

All nine wing-02 structure checks passed. Historical sculpt-04 evidence includes all nine geometry/lifecycle checks passing. Earlier sculpt-02 evidence includes nine Node geometry/lifecycle checks, three Python tool tests and the full adapter web build in `atlas-adapter-final-web-build.log`, before the subsequent metadata-only manifest/cache change. Those historical build/package preparation records are superseded by the accepted PR53/PR54/PR55/PR56 checkpoints and signed packages in IMPLEMENTATION.md. These validation results do not measure wing-02 performance or accept its appearance.

Reproduction commands, run serially from the repository worktree by root after preserving matching prior evidence:

```sh
node --test scripts/atlas/model.test.mjs
python3 -m unittest discover -s scripts/atlas -p 'test_*.py'
python3 scripts/atlas/export.py --overwrite
python3 scripts/atlas/inspect_glb.py
python3 scripts/atlas/benchmark.py --repeats 3 --dpr 1 2
```

Use Python 3.10+ with Playwright, Pillow and an installed Chromium; `--chromium-executable /absolute/path` selects an existing executable. Tools are not auto-installed. Export requires the reviewed Three.js version. Preserve prior evidence before `--overwrite`: the rough-01 output is archived at `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`.

The isolated loopback server accepts read methods and the capture tools block unexpected browser requests. Export checks the approved reference and complete source inventory before and after capture. It writes the GLB, actual light/dark turnarounds and state samples, small portraits, legacy nineteen-frame reaction sequences, the new transparent state bundle and a hash/size-bound export manifest. Transparent capture restores scene, camera, renderer and pose afterward; it does not remove a backdrop from an opaque screenshot. `inspect_glb.py` checks the 14-joint skeleton and all 12 exact clip names. None of these operations changes public/native assets.

## Explicit publication — not performed

`scripts/atlas/publish.py` requires an explicit `--accept-reviewed` flag. Only after the matching actual art has been accepted, root may run:

```sh
python3 scripts/atlas/publish.py --accept-reviewed
```

Do not run this admission for the unaccepted wing-02 bundle or any later mismatched source. The publisher verifies the approved reference, current source/artifact hashes, exact manifest, dimensions, transparency, state names, frame bounds and local basenames. It then copies only the 33-file bundle to `public/companion/atlas-v1` and `apps/flutter/assets/companion/atlas-v1`. It stages both destinations and restores prior files on a reported copy failure; it does not promise cross-filesystem atomicity through a process crash. It does not render, install dependencies, deploy, certify performance or infer artistic approval from a successful export. No 3D/state-bundle publication has occurred as of this record.

## Functional release and remaining acceptance

[TASKS.md](../TASKS.md) permits a usable functional release with static ATLAS before final clips, and task 2.6 separates the adapter/preferences from the final asset upgrade. Keep the approved portrait and bounded fallback while completing ordinary build/migration/deployment gates. This is not completion of the full revamp or approval of tasks 0.5–0.6.

Final likeness, readable state acting and target-device performance remain outstanding. The old rough-01 measurements cannot be transferred to this larger mesh or the new sprite bundle. Physical native/mobile startup, memory, battery/thermal behavior, actual background transitions and deployed asset costs require their own evidence; see [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md). Source and export exist; final creative delivery is not accepted.

## Official implementation references

- [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html)
- [Three.js SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html)
- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [Three.js cleanup guide](https://threejs.org/manual/pages/cleanup.html)
