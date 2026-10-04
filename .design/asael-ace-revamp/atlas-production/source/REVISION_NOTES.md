# ATLAS sculpt 02 — source revision

Status: authored source, not exported or visually accepted. The approved static concept remains the product asset.

The revision follows `../ART_REVIEW.md` and direct inspection of `../../references/atlas-selected.png`, the rough-01 three-quarter light turnaround, profile dark turnaround and 108px light portrait. Those images show the earlier exported model, not this source revision. The selected study remains the identity reference: tapered umber eagle, pale throat, hooked golden beak, amber eyes and one charcoal collar.

## Geometry intent

- Recess the shallow eye surfaces within a shaped orbital plane; replace the round exposed socket with a narrow rim, lower lid and independently deformable upper lid.
- Replace the fixed stern brow bars with neutral curved feather vanes and small overlapping brow coverts. Retain asymmetric brow acting.
- Replace straight head spikes with rounded, swept crown and cheek layers.
- Build the body and folded wings from tapered overlapping coverts and primaries. The underlying body remains a continuous tapered volume; the feathers are part of the same skinned mesh.
- Continue the pale throat under a thinner collar and add short pale throat feathers. Keep the charcoal collar and its single small tab.
- Smooth the hooked upper beak while preserving its gold silhouette. Add restrained nostril marks rather than another facial focal point.

The model retains one merged skinned mesh, one vertex-color material, the original coordinate system and the original twelve bone names. Two upper-lid bones bring the skeleton to exactly fourteen bones. No texture, new product integration, phoneme rig or eye-tracking behavior is introduced.

## Eight authored state timelines

| Exact state / clip | Duration | Acting intent |
| --- | ---: | --- |
| `available` | 600ms | One soft blink, then the neutral still pose. |
| `listening` | 640ms | Small inquisitive tilt and more open lids, then hold. |
| `responding` | 1120ms | One restrained illustrative phrase gesture, then the responding pose. This is not audio synchronization. |
| `working` | 660ms | Orient once toward the work, then hold. No thinking loop. |
| `needs_you` | 900ms | Asymmetric eyebrow question with a small double-take, then wait. |
| `blocked` | 720ms | Calm lower-and-settle without alarm, shaking or blame. |
| `completed` | 900ms | Satisfied nod and compact wing-to-breast gesture, then the completed pose. |
| `paused` | 660ms | Relaxed lids and folded wings settle into a static pause. |

Each state timeline ends at its corresponding static pose. Every clip contains all fourteen quaternion tracks so replacement and reset cannot inherit a previous gesture. The four original inspection clips `rest`, `quick_reaction`, `speech_test` and `satisfied_nod` remain available; the exact `listening` state clip replaces the earlier listening test. The GLB export is therefore expected to contain twelve clips: eight state clips and four inspection clips.

The playback controller is unchanged. Its allowlist and manual inspection controls include the new clips. It still admits only one current gesture, cancels on replacement, reduced motion, hidden/offscreen state and disposal, and limits clip duration. No event authority or completion inference is added by the art source. Product playback must remain authoritative: responding does not establish audible speech, and a completed performance must be tied to the existing confirmed completion identity. No looping idle performance is authored.

## Evidence boundary and next review

`model.json` carries creative revision `sculpt-02-eyelids-layered-plumage-eight-states`. All existing `../output/` assets, byte counts, geometry counts, benchmark results and visual reviews remain rough-01 evidence and are stale for this revision. Export metadata now records the creative revision and retains the source hashes. A new export must match both before its measurements can be associated with these sources.

The model and expression SVG sheets are editable construction illustrations. They are not actual turnarounds, deformed mesh samples or proof of production fidelity.

No source/runtime test, export, render, browser benchmark or physical-device measurement was run for this revision by its author. Root must export and inspect the actual geometry before acceptance. In particular, inspect lid occlusion throughout the blink, eye recess and brow neutrality at front/profile/three-quarter angles, wing-to-breast intersections, throat/collar deformation and feather overlap. Compare new 36px, 72px and 108px portraits against the selected study in both themes. Verify all fourteen bones and twelve clips, interruption/reduced-motion behavior, actual geometry/byte bounds and device performance separately.

The procedural construction is still a sculpting scaffold. Authoring the eight state timelines does not establish final acting quality, natural speech performance or production approval.

## Exact-state raster export and explicit publication

The exporter retains the GLB, opaque comparison portraits/turnarounds and legacy quick-reaction sequence. It additionally prepares `../output/atlas-v1/manifest.json` with transparent 256px WebP static posters and four-column WebP sprite sheets for every state in both themes. The PNG samples come directly from an alpha-enabled renderer buffer with no background compositor; sprite assembly copies RGBA samples into transparent cells and encodes lossless WebP. Existing opaque comparison exports still use their original backgrounds. Capture restores the prior camera, renderer size/clear settings, background and bone pose. It does not resume an interrupted gesture.

The delivery schema is exactly:

```json
{
  "schemaVersion": 1,
  "creativeRevision": "sculpt-02-eyelids-layered-plumage-eight-states",
  "frameSize": 256,
  "fps": 20,
  "columns": 4,
  "states": {
    "available": {
      "durationMs": 600,
      "frameCount": 13,
      "light": {
        "poster": "available-light-poster.webp",
        "sprite": "available-light-sprite.webp",
        "posterSha256": "<actual 64-character lowercase SHA-256>",
        "spriteSha256": "<actual 64-character lowercase SHA-256>"
      },
      "dark": {
        "poster": "available-dark-poster.webp",
        "sprite": "available-dark-sprite.webp",
        "posterSha256": "<actual 64-character lowercase SHA-256>",
        "spriteSha256": "<actual 64-character lowercase SHA-256>"
      }
    }
  }
}
```

The example abbreviates the required eight-state map; an actual manifest must contain all eight exact names. Every basename is `<state>-<light|dark>-<poster|sprite>.webp`. Duration comes from the authored clip in milliseconds. Frame count is `ceil(durationMs / 50) + 1`; sample `i` is at `min(i * 50, durationMs)`. The format accepts at most 1200ms and 25 frames. Current clips reach at most 1120ms and 24 frames. The last sample includes the exact clip endpoint. Sprites are 1024px wide and `256 * ceil(frameCount / 4)` high, row-major, with unused cells transparent. Neither format nor publisher creates a loop. Consumer state and lifecycle gates remain responsible for admission and cancellation.

Root-only commands, from the repository worktree:

```sh
python3 scripts/atlas/export.py --overwrite
python3 scripts/atlas/inspect_glb.py
# Only after inspecting the matching current renders:
python3 scripts/atlas/publish.py --accept-reviewed
```

Export uses the existing Playwright/Chromium and Pillow installations; nothing is installed automatically. Source inventory and hashes are captured before rendering and checked again afterward. Publication verifies the complete current source inventory (including the exporter and publisher), all recorded artifact bytes/hashes, approved reference provenance, exact manifest/state/timing/basename contracts, WebP dimensions, transparency and unused sprite cells. A changed source or output requires a new export and review.

The publisher copies exactly 33 files—the manifest and 32 images—to each of `public/companion/atlas-v1/` and `apps/flutter/assets/companion/atlas-v1/`. It requires explicit `--accept-reviewed`; structural checks alone do not authorize publishing. Both bundles are staged before replacement, each directory is switched as a unit, and reported replacement failures attempt restoration of both previous copies. These two directories are not a cross-filesystem crash transaction; an interrupted or uncertain publication must be inspected and explicitly rerun. Recovery directories are retained if restoration fails. Publication is not deployment, runtime integration, visual certification by software or physical-device performance evidence.
