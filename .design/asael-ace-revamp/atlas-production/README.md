# ATLAS editable source and delivery lab

**Status, 5 October 2026 (IST): wing-color01 is the current retained local wing-finish refinement; its matching complete export is verified. The full character remains unaccepted and unpublished.** Root reviewed all fifteen matched sheets / 120 captures; independent review covered six comparison sheets and the selected concept reference. Feather color is more coherent across the torso and wing bases, particularly in three-quarter, profile and raised-wing views. The benefit is subtle at 256px and neutral at small sizes, with no new obvious wrap banding or wing/body junction defect in the reviewed samples. Only UV/color attributes of 26 wing parts change; all attributes of the other 141 parts, all geometry, skin, rig, static poses, 168 tracks and atlas bytes remain exact FACE02. The comparison archive binds fourteen sources, 120 captures and fifteen sheets. The matching wing-color01 export verifies nineteen sources, 104 artifacts, 33 raster files and 237 archived members; its GLB is 2,969,088 bytes. All 21 targeted model/lid checks pass. Seventy-two source/export captures cover 36 pairs: 32 exact, four differing by seven total pixels at maximum one channel byte. FACE02 is the historical export predecessor. Existing lid finish, final likeness, natural acting, continuous attachment, small-size needs-you readability and device acceptance remain open. See [ART_REVIEW.md](ART_REVIEW.md) for the review, archive digest and limits.

**Rejected FACE03 and raised01 experiments:** FACE03 upper-lid depth shaping introduced closed-cap pinholes and a raised-eye white sliver; its subtle bulk reduction did not justify these defects despite passing candidate checks. The later raised01 pose experiment showed no contour or small-size readability benefit and slightly weakened questioning asymmetry, without a clear new defect. Each experiment was archived and all seventeen export-bound FACE02 sources restored exactly at its checkpoint; neither produced a new full export or publication. Future lid retention requires triangle-interior and raised/closing coverage plus matched visual review; sampled vertex probes alone are insufficient. The FACE03 pixels do not establish a source-level cause. Details and matching archives are recorded in [ART_REVIEW.md](ART_REVIEW.md).

The approved static concept portrait remains the web/native fallback. Web and native bounded raster adapters are implemented; the earlier adapter checkpoint passed 26 web unit cases, full native analysis and all 37 companion cases. PR54's UI revamp and PR55's approved full-body static greeting are accepted and merged. PR55 passed all 16 hosted checks on `e9f1fbdbcf8f5e4bc576787e7d355820787490ba`; its private Mac app 1.23.14+49 package is verified. No 3D/state bundle has been published. The public HTTP-200 manifest contains only `{"schemaVersion":1,"status":"awaiting-art-review"}`; the web reader uses `no-cache` so later reviewed metadata is revalidated, while the placeholder retains the approved neutral portrait. The retained `output/benchmark.json` is stale rough-01 evidence, not a measurement of FACE02 or wing-color01. [MEASUREMENTS.md](MEASUREMENTS.md) separates those revisions; [IMPLEMENTATION.md](../IMPLEMENTATION.md) records release acceptance.

PR56's scoped language preference and web/native motion intensity are accepted and merged after all 16 hosted checks passed on `a3fb4215b632f8b6d56487e3617b0afb82085aba`. All 277 focused web/server checks, full Flutter analysis and 11 companion checks passed; the private Mac 1.23.15 (50) package is verified. This changes neither the database/API version nor the unpublished art bundle, and does not establish physical-device performance.

PR57's expanded web Voice integration shares the bounded ATLAS player and is accepted and merged after all 14 applicable hosted checks passed on `76a2230e911d1d8436c731fc965f53037b5dadd6`. The 48 focused unit checks, 114 maintained browser checks and ESLint passed. The complete browser suite passed on that exact hosted head after an incomplete local compact/greeting run. This web-only change leaves native API/version and the verified Mac 1.23.15 (50) package unchanged. Software UI priorities through PR60 are accepted; final artwork, physical-device/performance acceptance and production promotion remain open.

PR58's native Automation run navigation is accepted and merged after all 16 hosted checks passed on `52e54d2cd14ccc4501d23b46367e94dcd9e30b16`. It merged at `2026-10-04T20:43:05Z` as `d7b5bca4292dd6c8f31c09fdd949c04cd0556f9c`. The verified private Mac 1.23.16 (51) package has SHA-256 `3616583ca5151a8373355e2f7f7b35df22739c05439965e0c37983018c79de9f`; its exact source and the merged tree match. This follow-up needs no migration or API version change. Production is not promoted.

PR59's native scoped content search is accepted and merged after all 16 hosted checks passed on `608368ed679e483105198e62966f02dac198b662`; merge commit is `2fd786531899d686da6686988e82e3c5faa83224`. It publishes native v39 / app 1.23.17+52. The 59 focused native cases, Flutter analysis, 44 contract checks and three visual captures pass. The verified private Mac52 package has SHA-256 `f52edbd1dc200e55b86dc9ced5e8ef7d9b335fe27d118fe8929a7456376d5fa7`, built from `2d4c1410b400f2d72e1ca7e3ec9ed6471ce8ed49`; only two test files differ from the accepted candidate, with application/packaging inputs exact. Quality + Monitoring is accepted and merged through PR60 after all sixteen hosted checks succeeded on `51b48d927f707d035e726729ef04eb58555f2d2a`, including all 1,292 Flutter tests. It merged as `45977bded2317bfa04b89b18cc11c971d58f3085` at `2026-10-04T22:31:09Z`. All 118 focused checks, eight root-reviewed widget captures and full Flutter analysis pass. The universal private Mac 1.23.18 (53) package is verified, including version/build and private signatures, with SHA-256 `fd6596167fd7e9c4bb7382c041eab2d8c3d71153ae01e02b29969367322035b4`. Accepted head, built source and merged full Git tree are identical at `5b6f845c0d09f683ef4894c93e280e87955cd31d`; `pr60-acceptance.json` and `macos-native-operations-release/verification.json` record the receipts. At this acceptance checkpoint, the native release checkout was clean and detached at accepted main. Security UI is next on a separate native branch, with build 54 reserved and no new migration or native API version; implementation and release acceptance remain pending. Parked connector work must rebase native v39 and use the next free build, at least 55. Production is unchanged.

## Source and usage record

- Reference: `../references/atlas-selected.png`, a 2560 × 2256 generated concept contact sheet, **not** an editable model or sprite-ready rig.
- Provenance: `../references/atlas-export.json`; selected Stitch project `4399395118624914882`, “ATLAS — Personality Study.”
- Approved reference SHA-256: `876591c5a2b739df99d6aab647554dc53bcab97d55bf0c3e0864e39e1c98c070`.
- The user selected this original generated reference and authorized the Asael implementation, including derivative construction and local measurement work. This records project usage authorization and source provenance; no third-party character model or texture is included.
- SVG paths, procedural mesh topology, bone placement, palette interpretation and clip keyframes are editable authored source. No image-generation API, external character asset, celebrity likeness, sampled voice or downloaded texture was used in this construction. Voice is absent.
- Procedural seed: **0**, with no random generator. Source geometry and clip inputs are deterministic; browser/GPU pixels and GLB bytes are not promised identical across tool versions or machines. The exporter records actual source hashes and tool versions.
- Current retained refinement: wing-color01. Its comparison changes UV/color attributes only on the two folded-wing underforms and 24 coverts. The other 141 parts and all positions, normals, indices, skin, rig, poses, 168 tracks and atlas bytes remain exact FACE02. Matching complete export and source/GLB comparison remain pending until root records their measured results.
- Last verified complete export, now the historical predecessor: `sculpt-04-face-02-anchored-brows`, including the retained face-01, feather-02 and feather-03 refinements. The retained `atlas-rough.glb` filename is a compatibility name, not a final-art label. Wing-color01 requires its own matching complete export before those output facts can be claimed for it.
- Face-02 changed only the two named brow parts' shape, normals, scalar colors, UVs and Head/Brow skin attributes. The other 165 parts, full atlas, all indices, rig, poses and 168 tracks remained exact FEATHER03. Topology was unchanged; the attached borders/terminal rings remained Head-bound while central ridges retained Brow motion. Bounded review recorded clearer neutral/listening integration and a substantially quieter eyebrow gesture, retained by wing-color01.
- The preceding feather-03 refinement changed 298,806 lower-atlas pixels against feather-02. Every part attribute, including UVs, all topology, rig, poses and tracks remained exact at that checkpoint. Full-width rows 480–1023 retained their bytes and frozen image digest; the torso blend faded out over Y=1.90–2.02 below the collar. Face-01's retained lids/brows and completed settle, plus feather-02's angular chart and physical throat mask, remained unchanged in that paint-only pass. Decoded RGBA storage stayed at 4,194,304 bytes, an arithmetic size rather than a GPU/performance measurement.

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

The archived FACE02 predecessor's eight-state raster export uses transparent 256px WebP posters and sprite sheets, sampled at 20Hz with four columns. Each clip includes its final endpoint: `frameCount = ceil(durationMs / 50) + 1`, with the last sample clamped to the authored duration. No clip loops. Wing-color01 preserves the authored clips; its matching raster artifacts remain pending.

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

At the verified FACE02 checkpoint, `output/atlas-v1/manifest.json` bound face-02, with schema version 1, frame size 256, fps 20, columns 4, and exactly those eight states. Each state has a duration, frame count and light/dark poster/sprite basenames with SHA-256 hashes. The shared admission bound is at most 1200ms and 25 frames; that export uses at most 1120ms and 24 frames. The bundle contains 32 images plus the manifest. Its transparent light/dark image pairs have identical hashes because they share the same lighting without a composited backdrop; their names alone do not establish distinct theme treatment. These historical artifact facts do not verify the pending wing-color01 bundle.

The implemented adapters keep actual microphone/playback precedence, separate work status and verified completion identity. State/receipt observations consumed while motion is suppressed must not replay on return, theme change or late asset arrival. Reduced motion supplies a static image. Hidden/offscreen/disposed instances cancel pending motion, and controls never wait for animation. Assets remain decorative and cannot authorize tools, recording, playback or run completion. The approved static portrait stays available when the bundle is absent or invalid.

## Export and inspection — root execution only

**Wing-color01 matching export: pending.** The retained comparison archive is `wing-color01-comparison/matching-source-baseline-and-captures.tar.gz`, SHA-256 `222bf301d5a808487d27400f03a6cc9f87a5a353cb1f6afd3ea98c85cffd364e`, containing fourteen bound sources, 120 captures and fifteen comparison sheets. Root must record the matching complete-export and source/GLB results separately; comparison retention does not supply those measurements.

Historical verified predecessor: root exported face-02 at `2026-10-04T22:10:08.914731+00:00` (5 October in IST). That complete export contains a self-contained 2,969,076-byte GLB with 27,543 vertices, 49,844 triangles, 14 bones, 12 clips, 167 parts, one material, one embedded 1024 × 1024 RGBA8 map and zero external resources. Its manifest retains `ROUGH_RENDERED_NOT_REVIEWED`; local refinement retention does not accept the complete character or acting. Root verified all 17 source hashes, 104 artifact hashes/bytes and 169 archive members in `atlas-face-02-export-verification.json`. Matching source/output is archived as `atlas-face-02-review.tar.gz`, SHA-256 `5c51cca88d2df62d38b725ef9c1524532499249e2adecd35a0588aa6ae87508a`; [MEASUREMENTS.md](MEASUREMENTS.md) records exact manifest and comparison hashes. Structural export success is not physical-device acceptance.

Ten model checks passed at FACE02. Its source/GLB parity covers 42 captures / 21 pairs across seven groups and three views: fifteen pairs are exact, and the remaining six total 21 changed pixels at maximum one channel byte. Listening differs by two pixels per view; closed three-quarter by one; completed three-quarter by four and profile by ten. Both modes passed hide/reload/dispose without page/console/rejected-request errors. The ten static-tool checks passed at feather-02 on unchanged scripts and were not rerun for face-02. Feather-03's 24-capture comparison, feather-02's 56-capture count-correction record and finish-02's 80-state review remain historical. Map/bitmap cleanup is implemented, but allocation, reclamation and physical-device performance remain unmeasured.

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

Do not run this admission for the unaccepted full-character bundle or any later mismatched source. The publisher verifies the approved reference, current source/artifact hashes, exact manifest, dimensions, transparency, state names, frame bounds and local basenames. It then copies only the 33-file bundle to `public/companion/atlas-v1` and `apps/flutter/assets/companion/atlas-v1`. It stages both destinations and restores prior files on a reported copy failure; it does not promise cross-filesystem atomicity through a process crash. It does not render, install dependencies, deploy, certify performance or infer artistic approval from a successful export. No 3D/state-bundle publication has occurred as of this record.

## Functional release and remaining acceptance

[TASKS.md](../TASKS.md) permits a usable functional release with static ATLAS before final clips, and task 2.6 separates the adapter/preferences from the final asset upgrade. Keep the approved portrait and bounded fallback while completing ordinary build/migration/deployment gates. This is not completion of the full revamp or approval of tasks 0.5–0.6.

The next bounded artistic target is the sixteen primary vanes: they still read as flat, uniform brown strips beside the textured coverts, clearest in the front and three-quarter completed .34 samples. A restrained feather-direction/taper shading pass can address that surface mismatch while preserving geometry, rig and motion. Retention should require a visible benefit at 256px with a quiet 72px result; another texture pass alone cannot establish final likeness or acting.

Final likeness, readable state acting and target-device performance remain outstanding. The old rough-01 measurements cannot be transferred to this larger mesh or the new sprite bundle. Physical native/mobile startup, memory, battery/thermal behavior, actual background transitions and deployed asset costs require their own evidence; see [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md). The retained source and verified predecessor export exist; the matching wing-color01 export is pending and final creative delivery is not accepted.

## Official implementation references

- [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html)
- [Three.js SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html)
- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [Three.js cleanup guide](https://threejs.org/manual/pages/cleanup.html)
