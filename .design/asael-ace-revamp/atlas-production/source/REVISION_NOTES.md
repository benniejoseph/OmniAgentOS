# ATLAS sculpt 04 — silhouette and face correction

Status: **unexported, unreviewed source**. This revision does not replace or accept production artwork. Creative revision: `sculpt-04-compact-mantle-cheek-sweep-expressive-eyes`.

The approved `../../DESIGN_BRIEF.md` and actual `../../references/atlas-selected.png` remain authoritative. The sculpt author inspected the actual sculpt-03 front, three-quarter and profile light turnarounds. Sculpt 03 was not accepted: its pale throat still read as a long rectangular beard, the collar as a level ring, the torso as repeated leaf plates, the neck as too exposed, the irises as small pins, and the legs and feet as too slight. Naming those forms correctly had not made the image sufficiently like the study.

Root reported sculpt-03 export measurements of **43,642 triangles, 1,786,956 bytes, fourteen bones and twelve clips**. Those measurements belong to the archived sculpt-03 source and outputs, not this revision. The archive is `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-sculpt-03-review.tar.gz`.

## Concrete changes

- **Higher, fuller shoulders.** The chest remains broad farther up the body. Folded wings begin approximately 0.24 model units higher, with fuller shoulder underforms and longer overlapping coverts. The neck-to-chest transition and its skin weights follow the higher shoulder line. The head is no longer presented above the same long exposed column.
- **Shorter, diagonal pale field.** The throat profile now spans approximately 0.58 model units instead of 0.87. Its lower end shifts to one side, and the cross-sections sweep upward across the cheek. The field follows the body surface with subtle grain and an irregular edge. All seven repeated rows of pale vanes are removed; only six small cheek tufts remain. The shorter field and raised collar are intended to remove the rectangular beard silhouette.
- **Tailored collar.** The band follows a sloped path around the enlarged neck, dips at the front and has an asymmetric overlapping tab. Its narrow edge sits slightly above the band to avoid coplanar surfaces. It no longer uses horizontal elliptical loft rings.
- **Directional plumage.** The 132 breast leaves and repeated nape rows are removed. A continuous shallow relief surface carries fine curved grain, with 44 low breast/mantle tufts at deliberately varied positions. Each tuft has three unequal tips; roots merge into the underlying surface. The repeated closed leaf volumes no longer determine the torso silhouette. Wing and tail vanes have broader roots and longer tapers, thinner depth, and less alternating color. Six broader crown sweeps replace the previous eight blades.
- **Larger expressive eyes.** Iris width increases from 0.07 to 0.116 model units; pupil width increases from 0.032 to 0.048. The eye surfaces curve into the outer temples. Irises and pupils follow that curved surface and stay within the full almond aperture; mobile upper lids cover the iris tops in the neutral pose. The full upper opening remains behind the lid for raised-lid expressions. The dark seam is replaced with umber, and the brow is smaller, higher and softly arched. This is intended to retain poised half-lids while removing the dark mask and pin-eye effect.
- **Sculpted beak.** The upper mandible has a raised cere, narrow central keel, broader lower side planes and a stronger descending hook. Its cross-sections and restrained vertex shading distinguish the ridge from the flanks in a frontal view. The lower mandible retains an independent jaw hinge.
- **Planted stance.** Fuller feathered thighs cover more of the upper legs. Tarsi are thicker and bent. The foot centers move outward, digit spread increases, and the forward toes are longer with visible knuckles and curved talons. The rear digits are also larger. These changes address both the thin straight legs and the small-foot impression.

The construction remains deterministic, with one merged skinned mesh, one matte vertex-color material and no textures or image/provider dependencies. A source-level count suggests roughly **41,600 triangles**, below the 50,000 target. **This is not an exported measurement.** Root must establish the actual count and byte size from the matching export.

## Rig, clips and behavioral checks

The exact fourteen bone names remain `Root`, `Spine`, `Neck`, `Head`, `Jaw`, `BrowLeft`, `BrowRight`, `UpperLidLeft`, `UpperLidRight`, `WingLeft`, `WingTipLeft`, `WingRight`, `WingTipRight`, and `Tail`. Rest pivots move with the revised neck, jaw, brows, eyelids and shoulders; the skeleton hierarchy is unchanged.

The eight exact state mappings and all existing pose/keyframe values and durations are preserved: `available` (600ms), `listening` (640ms), `responding` (1120ms), `working` (660ms), `needs_you` (900ms), `blocked` (720ms), `completed` (900ms), and `paused` (660ms). The inspection clips `rest`, `quick_reaction`, `speech_test`, and `satisfied_nod` remain, for twelve clips total. Each retains fourteen quaternion tracks. No renderer, application state adapter, new loop or audio synchronization is added.

Two existing deformation probes in `scripts/atlas/model.test.mjs` now identify their semantic target across topology changes. The eyelid test finds a central forward vertex with more than 90% upper-lid influence instead of using an obsolete part name and row offset. The jaw test finds the forwardmost lower-mandible vertex instead of a base-ring offset. Their original movement thresholds remain **greater than 0.015 for the lid** and **greater than 0.01 for the mandible**; iris/upper-beak isolation and exact reset checks remain. These edits repair the probes, not weaken the behavior being checked.

## Required visual review and limits

No Node, Python, browser, export, runtime test or Git operation was run by the sculpt author. Only the three owned source files and the two topology-dependent behavioral probes were edited. Root performs serial validation and rendering.

The next matching front, three-quarter and profile renders must establish whether these changes improve the actual identity. In particular:

1. Check the shortened throat and fuller shoulder transition against the selected full-body pose. The pale sweep must read as cheek/throat plumage, not a smaller beard or a smooth bib.
2. Check that continuous body relief reads as fine feathers at portrait and full-body scales, rather than ribbing. Check the sparse tuft roots, wing overlaps and crown ends for visible seams or floating shapes.
3. Inspect both eyes from the profile as well as the front. Confirm the iris is large and legible, the outer lids sit in the temple, the neutral brow is welcoming, and the upper lid actually covers the eye throughout the blink. The analytical hinge placement is not proof of a convincing blink.
4. Check the beak's central ridge and hook in the front view, mouth closure in the profile, and independent jaw deformation. Check the collar/tab contact and any neck or wing intersections during the existing gestures.
5. Check the larger feet on the ground and the thigh-to-tarsus transition, actual triangle count below 50,000, fourteen bones/twelve clips, and 36px/72px/108px portrait legibility in both themes. Physical-device performance remains a later, separate verification.

This is another procedural art pass, not a claim that the selected illustration has now been matched. The reference has densely painted feather transitions and carefully authored facial planes. Shallow geometry and vertex colors may still fall short of that finish; only the resulting images can establish whether this approach is adequate. No publication should be inferred from structural tests passing.

## Export boundary

All previous outputs and measurements are stale for sculpt 04. A new `export-manifest.json` must bind the exact creative revision and current source hashes before using the resulting outputs. `sourceExpectedSha256` still identifies the approved raster reference and is unchanged.

The existing eight-state delivery contract is unchanged: both themes, transparent 256px WebP posters, four-column sprite sheets at 20fps with endpoint frames, and the existing GLB/inspection exports. Playback remains non-looping and lifecycle-gated. Renderer, exporter, publisher, adapters, public assets and native assets are untouched. Matching renders require an explicit artistic acceptance before publication.
