# ATLAS editable source and delivery lab

**Status, 4 October 2026: sculpt-02 exported and visually reviewed; insufficient final likeness, not accepted or published.** The current export records 104 artifacts, including a self-contained 1,414,604-byte skinned GLB with 18,390 vertices, 33,718 triangles, 14 bones and 12 clips. The eight application-state clips and four inspection aliases are authored, but their existence is not artistic acceptance. See [ART_REVIEW.md](ART_REVIEW.md) for the actual findings.

The approved static concept portrait remains the web/native companion asset. Web and native bounded raster adapters are implemented; root's web adapter unit run passed 26 cases, the full native analyzer reported no issues, and all 37 companion cases passed. No sculpt-02 artwork has been published. The public HTTP-200 manifest contains only `{"schemaVersion":1,"status":"awaiting-art-review"}`; the web reader uses `no-cache` so later reviewed metadata is revalidated, while the placeholder retains the approved neutral portrait. The current `output/benchmark.json` is stale rough-01 evidence, not a measurement of this export. [MEASUREMENTS.md](MEASUREMENTS.md) separates the two revisions.

## Source and usage record

- Reference: `../references/atlas-selected.png`, a 2560 × 2256 generated concept contact sheet, **not** an editable model or sprite-ready rig.
- Provenance: `../references/atlas-export.json`; selected Stitch project `4399395118624914882`, “ATLAS — Personality Study.”
- Approved reference SHA-256: `876591c5a2b739df99d6aab647554dc53bcab97d55bf0c3e0864e39e1c98c070`.
- The user selected this original generated reference and authorized the Asael implementation, including derivative construction and local measurement work. This records project usage authorization and source provenance; no third-party character model or texture is included.
- SVG paths, procedural mesh topology, bone placement, palette interpretation and clip keyframes are editable authored source. No image-generation API, external character asset, celebrity likeness, sampled voice or downloaded texture was used in this construction. Voice is absent.
- Procedural seed: **0**, with no random generator. Source geometry and clip inputs are deterministic; browser/GPU pixels and GLB bytes are not promised identical across tool versions or machines. The exporter records actual source hashes and tool versions.
- Current creative revision: `sculpt-02-eyelids-layered-plumage-eight-states`. The retained `atlas-rough.glb` filename is a compatibility name, not a final-art label.

## Editable files

| File | Purpose |
| --- | --- |
| `sheets/model-sheet.svg` | Editable front, profile and three-quarter construction, palette and collar reference. |
| `sheets/expression-sheet.svg` | Expression and timing construction. Keep its adjacent model-sheet reference groups together or expand them in a vector editor. |
| `sheets/atlas-front.svg` | Standalone vector construction reference; not an actual mesh render. |
| `source/model.json` | Proportions, palette, camera, 14-bone hierarchy, static poses and eight state performances. |
| `source/atlas-model.mjs` | Procedural geometry, skin influences, material, state clips, four inspection aliases and pose reset. |
| `source/REVISION_NOTES.md` | Authored sculpt-02 changes and their intended scope; actual acceptance is recorded separately here. |
| `web/` | Isolated lab, lifecycle gate, viewer and export hooks. No session, microphone, provider or execution channel. |
| `../../../scripts/atlas/` | Root-run export, inspection, local comparison and explicit publication tools. |

The GLB has actual geometry, skin, joints and animation channels. It can be opened by a compatible editor, but no Blender scene or Blender import compatibility has been certified. JS/JSON remain the editable source of record. Vector sheets and procedural geometry are separate constructions; the actual renders must be compared with the approved study rather than assuming either construction proves likeness.

## State clips and delivery boundary

The current eight-state raster export uses transparent 256px WebP posters and sprite sheets, sampled at 20Hz with four columns. Each clip includes its final endpoint: `frameCount = ceil(durationMs / 50) + 1`, with the last sample clamped to the authored duration. No clip loops.

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

`output/atlas-v1/manifest.json` has schema version 1, the creative revision, frame size 256, fps 20, columns 4, and exactly those eight states. Each state has a duration, frame count and light/dark poster/sprite basenames with SHA-256 hashes. The shared admission bound is at most 1200ms and 25 frames; this source currently uses at most 1120ms and 24 frames. The bundle contains 32 images plus the manifest. Current transparent light/dark image pairs have identical hashes because they share the same lighting without a composited backdrop; their names alone do not establish distinct theme treatment.

The implemented adapters keep actual microphone/playback precedence, separate work status and verified completion identity. State/receipt observations consumed while motion is suppressed must not replay on return, theme change or late asset arrival. Reduced motion supplies a static image. Hidden/offscreen/disposed instances cancel pending motion, and controls never wait for animation. Assets remain decorative and cannot authorize tools, recording, playback or run completion. The approved static portrait stays available when the bundle is absent or invalid.

## Export and inspection — root execution only

Root exported the current revision at `2026-10-04T01:59:09.672255+00:00` using Three.js 0.186.0, headless Chrome 154.0.8037.94 and a renderer reporting Apple M2 through ANGLE/Metal. The manifest retains `ROUGH_RENDERED_NOT_REVIEWED` as the export-time status; the subsequent visual rejection is recorded in ART_REVIEW.md. Structural export success is not visual or physical-device acceptance.

Root also passed nine sculpt-02 Node geometry/lifecycle checks and three Python tool tests. The full web build with the adapter passed in `atlas-adapter-final-web-build.log`, before the subsequent metadata-only manifest/cache change. The later package remains pending. These validation results do not measure current-asset performance or accept its appearance.

Prepared commands, run serially from the repository worktree by root:

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

Do not run this admission for the rejected sculpt-02 bundle. The publisher verifies the approved reference, current source/artifact hashes, exact manifest, dimensions, transparency, state names, frame bounds and local basenames. It then copies only the 33-file bundle to `public/companion/atlas-v1` and `apps/flutter/assets/companion/atlas-v1`. It stages both destinations and restores prior files on a reported copy failure; it does not promise cross-filesystem atomicity through a process crash. It does not render, install dependencies, deploy, certify performance or infer artistic approval from a successful export. No publication has occurred as of this record.

## Functional release and remaining acceptance

[TASKS.md](../TASKS.md) permits a usable functional release with static ATLAS before final clips, and task 2.6 separates the adapter/preferences from the final asset upgrade. Keep the approved portrait and bounded fallback while completing ordinary build/migration/deployment gates. This is not completion of the full revamp or approval of tasks 0.5–0.6.

Final likeness, readable state acting and target-device performance remain outstanding. The old rough-01 measurements cannot be transferred to this larger mesh or the new sprite bundle. Physical native/mobile startup, memory, battery/thermal behavior, actual background transitions and deployed asset costs require their own evidence; see [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md). Source and export exist; final creative delivery is not accepted.

## Official implementation references

- [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html)
- [Three.js SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html)
- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [Three.js cleanup guide](https://threejs.org/manual/pages/cleanup.html)
