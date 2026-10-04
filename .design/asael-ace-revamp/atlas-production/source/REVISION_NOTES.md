# ATLAS sculpt 04, eyelid 03 — clearance for the interior lid surface

Status: **authored source; full character remains unaccepted**. Creative revision: `sculpt-04-eyelid-03-interior-surface-clearance`. The full character remains unaccepted. Retained beak-02, throat-04 and eyelid-02 rim work is unchanged.

The author inspected eyelid-02 closed front/three-quarter/profile and closing three-quarter captures in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/eyelid02-comparison/`. Root retained the improvement over the large lower crescents, but two white corner spots and a thin outer seam remained. All nine tests passed with unchanged topology. The reviewed source/baseline is archived in that directory. In the front image the spots appear at the inner canthi, spatially separate from the existing highlight centers; highlight geometry is left unchanged.

The fitted closing rim is retained. This patch adjusts depth only for the three existing interior rows of each upper lid. Their neutral and 68-degree closed positions are checked against the eye surface in the same aperture column, with a 0.006–0.008 model-unit clearance allowance. A bounded three-step construction fit accounts for how added rest depth changes the skinned closed position. This supports the surface between the rim and attachment, where rim closure alone does not establish coverage. The outermost attachment row and rim/seam are unchanged.

No highlight, iris, pupil or sclera is moved, recolored, hidden or rebound. Neutral aperture height/width, lid weights, all hinges, clips, materials, depth behavior and other character geometry are unchanged. This is static lid geometry construction, not a state-dependent visibility rule. The existing grid and indices are reused; expected vertex/triangle delta is zero, not a measured export.

Only the three assigned source files were edited. No runtime, tests, browser, export or Git operation was run. Freeze for the same 24-capture comparison, including neutral appearance, mid-blink and exact peak closure from all three angles. The clearance fit does not prove coverage between vertices or establish a visually acceptable eyelid volume. Throat 04 remains the historical last matching full export recorded below.

Root reviewed matching rest, mid-blink and exact 0.12-second closed views in front, three-quarter and profile. The frontal white breakthroughs and forward bulge are reduced; the neutral iris remains legible. A thin outer white seam and a visible profile gap remain, so full blink coverage is not accepted. All nine structure checks pass with unchanged 27,190 vertices, 49,748 triangles and fourteen bones in the narrow comparison. Matching full-export evidence belongs in `../ART_REVIEW.md`; no publication is implied.

## Eyelid 02 retained local improvement

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-eyelid-02-aperture-fitted-rim`. The full character remains unaccepted. Retained beak-02 and throat-04 work is unchanged.

The author inspected eyelid-01 closed front/three-quarter, closing profile and rest three-quarter captures in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/eyelid01-comparison/`. Root's 24-capture review found less forward bulging and a smaller upper white scallop, but large lower/corner crescents and inner-canthus white spots remained. All nine structural tests passed with unchanged geometry counts; that did not establish a correct blink. Matching source and baseline are archived in that directory.

This patch keeps eyelid-01 hinges and fits each existing upper-rim column to the lower aperture at the unchanged 68-degree peak. Its neutral depth is adjusted where the curved temple would otherwise leave closure short, and its mobile influence is solved from that column's aperture height. A small nominal overlap of 0.002 times the local almond height factor extends the closing edge past the lower aperture. The neutral rim is kept ahead of the sclera; the two exact canthus endpoints remain Head-bound. Outer root rows remain Head-bound, and the depth correction fades into them. The seam follows the same fitted rim.

Only upper-lid geometry and its local weights change. Neutral rim height and width, iris/pupil/sclera geometry and Head binding, lower lids, all pivots, every clip, colors/materials and other character geometry are unchanged. The hinge used for fitting is read from the existing rig. No eye geometry is hidden and no depth behavior changes. The same vertex grid and indices are reused: expected vertex/triangle delta is zero, not a new measured export.

Only the three assigned source files were edited. No runtime, tests, browser, export or Git operation was run. Freeze for root's matching 24 captures, especially the exact `available` t=0.12 front/three-quarter/profile closure, intermediate closure and neutral expression. The per-column fit is a source prediction; it does not prove complete coverage between vertices or a visually acceptable blink. Throat 04 remains the historical last matching full export recorded below.

## Eyelid 01 reviewed history

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-eyelid-01-hinge-canthus-weights`. The full character remains unaccepted. Retained beak-02 and throat-04 work is unchanged.

The author inspected the actual archived beak-02 available-state blink sprite and the unchanged eye construction in the throat-04 blink. The closing lids bulge forward and expose pale sclera around their edges. The original central rim rotates from approximately Y2.800/Z0.295 to Y2.675/Z0.346 around the low hinge at the existing 68-degree peak; this is a source calculation, not a new render measurement.

This patch moves only `UpperLidLeft` and `UpperLidRight` pivots to Y2.7515/Z0.2231, preserving their X coordinates, names and Head parent. It replaces world-height-based upper-lid weights with weights authored from the existing mesh's local rows and horizontal position. The outer root rows and canthi bind to Head; the central rim and its seam remain lid-bound, with intermediate weights joining them. The proposed central-rim closure is approximately Y2.703/Z0.295 and must be checked in the actual blink.

No mesh positions, indices, colors, materials, iris/pupil/head binding or lower-lid binding change. All other pivots and every pose/keyframe value and duration remain unchanged. The existing lid grid is reused, so the expected vertex and triangle delta is zero. No current export measurements or visual improvement are claimed.

Root's last matching full throat-04 export completed at **2026-10-04T17:30:25.836966+00:00** and is archived in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-throat-04-review.tar.gz`: 104 artifacts, 27,190 vertices, 49,748 triangles, fourteen bones, twelve clips and a 2,035,216-byte GLB. Those measurements belong to throat 04. The retained source notes below preserve root's pre-export review wording as history.

Only the three assigned source files were edited. No runtime, tests, browser, export or Git operation was run. Freeze for root's exact `available` t=0.12 peak and mid-blink front/three-quarter/profile captures, including reset and iris isolation checks. The geometric prediction does not establish a correct eyelid silhouette or complete sclera coverage.

## Throat 04 retained baseline

Status: **authored source; full character remains unaccepted**. Creative revision: `sculpt-04-throat-04-refined-boundary-sampling`. Root retains the smoother throat boundary as a local improvement alongside unchanged beak 02. Matching export and acceptance evidence are recorded separately in `../ART_REVIEW.md`; source metadata does not establish publication approval.

The author inspected throat-03 front, three-quarter, profile and listening captures in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/throat03-comparison/`. The sheet breakthrough and loose strips are gone, but the diagonal color boundary forms large visible steps and the upper margin is jagged. The matching source/baseline archive in that directory preserves that reviewed pass.

This patch changes only feather-shell sampling in the neck and the shared color-mask transition. The last fourteen shell bands cover Y=2.162 to 2.680. The first is halved; the remaining thirteen are divided into thirds. Existing vertices, surface formulas and the torso grid below this range are retained. Most neck row gaps decrease from 0.037 to approximately 0.01233 model units. The pale/umber transition increases from 0.045 to 0.060 units on both existing neck surfaces, spanning several refined rows.

Expected topology delta: **27 additional rings × 112 vertices = 3,024 vertices**, and **27 × 112 × 2 = 6,048 triangles**. The throat-03 comparison receipt records 24,166 vertices and 43,700 triangles. Adding this source delta predicts **27,190 vertices and 49,748 triangles**, below the 50,000 target. These are arithmetic predictions, not measurements of a throat-04 export; root must verify them.

The rounded mask profile, base-neck sampling, beak 02, eyes, outer proportions, bones, pivots and clips are unchanged. There is no throat overlay, loose feather addition, material change or depth-test bypass. Only the three assigned source files were edited, with no runtime, tests, browser, export or Git operation.

Root inspected matching front and three-quarter portraits: the coarse staircase is reduced to a finer edge and the holes and loose strips remain absent. Narrow comparison geometry measures 27,190 vertices, 49,748 triangles and fourteen bones; all nine structure/lifecycle checks pass. Fine boundary stepping, feather finish and eyelid closure remain open. The matching full export must bind this source before its measurements can be used. Full-character artistic acceptance and publication remain separate.

## Throat 03 reviewed history

The following records the preceding source pass and its intent before the boundary-sampling defect was reviewed.

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-throat-03-integrated-neck-color`. The full character remains unaccepted. Beak 02 remains the retained improvement and last matching full export.

The author inspected throat-02 front, three-quarter, profile and listening captures in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/throat02-comparison/`. Root reviewed 22 captures: the rounded boundary improved and the strips were gone, but dark holes and streaks broke through the near-coplanar pale sheet at rest and during head tilt. Throat 02 was not retained. The matching source is archived in that directory.

This patch removes the separate throat mesh and its pale-weight geometry attribute entirely. The rounded throat-02 profile, sideways sweep and smooth boundary now define a color mask applied to the existing front-facing silhouette and continuous feather shell. The profile contains only height and half-width; there is no throat-sheet offset.

Both existing neck surfaces receive the same pale/umber mask. Additional base neck rows sample the existing silhouette profile at intervals no greater than 0.020 model units, allowing the underlying vertex colors to follow the boundary instead of interpolating across the former long spans. The body/head profile values, outer proportions and feather-shell geometry are unchanged. No overlay, depth-test change, texture or new material is introduced.

Beak 02 and its nostrils, eyes, bones, pivots and clips remain unchanged. Topology changes through removal of the sheet and denser base-neck sampling; no current totals are claimed. Only the three assigned source files were edited, with no runtime, tests, browser, export or Git operation.

Freeze for root's actual front/three-quarter/profile and listening review. Check color continuity between shell and base, the rounded boundary, and the existing head deformation. Removing the sheet addresses the overlap mechanism in source; only renders can establish whether the visible artifacts are resolved. Historical beak-02 export measurements below do not describe this revision.

## Throat 02 rejected history

The following records the preceding unretained pass and its intent before the breakthrough artifacts were reviewed.

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-throat-02-flush-rounded-blend`. The full character remains unaccepted. Beak 02 remains the retained improvement and last matching full export.

The author inspected throat-01 front, three-quarter, profile and listening captures in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/throat01-comparison/`. Root reviewed 22 comparison captures and reported nine passing structure tests, but did not retain the art: the field still ended in a triangular point and the cheek tufts appeared as detached torn strips. The matching source/baseline archive there preserves that rejected pass; those tests do not validate this revision.

This patch removes all ten pale cheek strips and keeps the pale region on one fitted surface. The lower profile stays broad through a rounded, sloping end instead of narrowing to a point. The surface samples the existing neck feather relief with a 0.0015-unit separation, replacing the previous 0.010–0.013-unit sheet offset and its separate grain pattern.

A narrow per-vertex boundary transition blends pale into the existing umber palette color, including the lower and upper ends. The blend uses a smooth ramp over a nominal 0.045 model-unit boundary distance. Minimal `append()` support is gated to the named throat surface; other parts retain their existing color path. No textures, materials or rendering framework are added.

Beak 02 and its nostrils, eyes, body proportions, bones, pivots and clips are unchanged. Topology changes through denser throat sampling and removal of the strips; no current export totals are claimed. Only the three assigned source files were edited, with no runtime, tests, browser, export or Git operation.

Freeze for root's actual front/three-quarter/profile and listening review. Check the rounded color boundary, contact with the neck, continuity under motion, and whether the blend still reads as a raised bib or introduces clipping. This source is a proposed correction, not evidence that the art is fixed. Beak-02 measurements in the history below remain historical only.

## Throat 01 rejected history

The following records the preceding unretained source pass and its intent before actual render review.

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-throat-01-curved-cheek-sweep`. The full character remains unaccepted. Beak 02 is retained unchanged as the last reviewed improvement and last matching full export.

The author inspected the actual beak-02 front, three-quarter and profile portraits in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/beak02-comparison/` and the selected reference. The pale field still forms a straight-sided inverted bib with an angular cheek rim. This patch changes only `throat()`, its profile and the immediately overlapping cheek tufts:

- Interpolate the authored contour as a smooth curve with forty longitudinal intervals instead of seven straight spans. Reshape the lower taper into a shorter, rounded, sideways sweep and round the upper edge beneath the cheeks.
- Introduce small irregularities along the side boundary and reduce the pale surface's lift toward that boundary, keeping the center's existing relief and tone.
- Replace six evenly spaced cheek tufts with ten short, unequal overlaps. Lower their roots into the pale surface and follow the curved cheek edge.

Beak 02 geometry and nostrils, eyes, body proportions, palette/materials, skeleton, bone pivots and all clips are unchanged. The throat and cheek topology counts increase. No measurements are claimed for this source; root owns all rendering and validation. Only the three assigned source files were edited, with no runtime, tests, browser, export or Git operation.

Root's last matching beak-02 full export is archived at `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-beak-02-review.tar.gz`. Root reported 104 artifacts, nine passing structure tests, and a GLB with 23,314 vertices, 41,700 triangles, fourteen bones, twelve clips and 1,754,824 bytes. Those results belong only to beak 02 and do not validate or measure throat 01.

Freeze for matching front/three-quarter/profile renders. Check whether the curve removes the bib impression, whether pale/dark feather edges remain attached without a raised rim, and whether the lower sweep meets the collar cleanly through the existing head gestures. Source geometry alone does not establish the visual result.

## Beak 02 retained baseline

Status: **authored source; full character remains unaccepted**. Creative revision: `sculpt-04-beak-02-curved-hook-jaw-contact`. Root's matching export and visual findings are recorded separately in `../ART_REVIEW.md`; source metadata does not establish acceptance. Neither sculpt 04 nor beak 01 was accepted.

The author inspected the actual beak-01 front, three-quarter and profile portraits, sculpt-04 baseline front/profile portraits, and selected reference. Root's review images are in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-beak-01-review/`. Beak 01 clarified the ridge but retained a diamond-shaped front silhouette, a thin isolated hook tip in profile, and a visible resting jaw gap.

This patch changes only the two beak parts and nostril placement:

- End the broad mouth corners earlier and narrow the descending hook sooner. Ten upper cross-sections replace seven; two extra ridge points round the culmen. The ring centers now progress forward through the tip, while the outer ridge describes the downward curve.
- Fit the lower jaw's upper surface to the upper lip's existing concave section, with a nominal 0.0015 model-unit rest clearance and a thin tapered shell. Both parts share their section coordinates. Paired cap strips close the concave jaw without a crossing triangle fan.
- Move the nostrils onto the revised side surface. Retain the beak-01 tone range; this revision changes shape and contact, not simply its color.

The lower jaw remains fully attached to the existing independent Jaw bone. Body, eyes, materials, all bone pivots and all clips are unchanged. Upper and lower beak vertex/triangle counts increase; no exported totals or byte measurements are claimed. The author ran no runtime, tests, export, browser or Git operation. Only the three owned source files were edited.

Root reviewed 18 comparison captures including front/three-quarter/profile and a speech-test sample. Mouth-corner silhouette, continuous hook curvature and resting jaw contact improve over sculpt04 and beak01. The broader character still has unresolved throat, feather-finish and eyelid defects. Nominal rest clearance and selected captures are not proof of collision-free animation. Any complete export must bind this exact source revision and hashes.

## Beak 01 history

The following records the preceding unaccepted `sculpt-04-beak-01-raised-keel-hook` patch.

Status: **unexported, unreviewed source**. Creative revision: `sculpt-04-beak-01-raised-keel-hook`. Sculpt 04 remains unaccepted; this patch does not establish artistic acceptance or replace production artwork.

The author inspected the selected reference and matching sculpt-04 front and three-quarter light turnarounds in `../output/`. The front beak still reads as a flat golden kite. This is one narrow correction inside the existing `upperBeak()` ring construction:

- Pull the central culmen forward through the middle rings, then bring it back into the existing hook. Narrow its shoulders so the upper surface forms a raised ridge with recessed flanks.
- Increase the existing vertex-tone separation between the ridge and flanks, with a small darkening toward the hook.
- Preserve the section centers, mouth-corner widths, lower contact edge and maximum forward reach of 0.571 model units. Ring and vertex counts are unchanged. The lower mandible, eyes, body, materials, rig and all clips are untouched.

Only `atlas-model.mjs`, `model.json` and this note were edited for beak 01. No runtime, export, test, browser or Git operation was run. Root must render the matching front and three-quarter views, check the profile and jaw contact, and judge the actual result before further work. The existing `../output/` files are sculpt-04 evidence and are stale for this patch.

## Sculpt 04 baseline history

The following notes describe the broader preceding `sculpt-04-compact-mantle-cheek-sweep-expressive-eyes` revision; they are retained as history, not as claims of new changes in beak 01.

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
