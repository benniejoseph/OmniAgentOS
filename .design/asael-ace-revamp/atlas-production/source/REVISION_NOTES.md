# ATLAS sculpt 04, primary 01 — retained overlapping fan

Current status: **local refinement reviewed; full character and natural state acting unaccepted**. Creative revision: `sculpt-04-primary-01-overlapping-fan`.

Root inspected all 48 matching comparison captures across rest, clearance, peak, settle, release, lowering and the held pose in three angles, plus peak portraits. The compact overlapping fan replaces the long separated strips and improves the resting and raised-wing outline. No new large joint gap appears in these samples. Coarse covert/junction tabs, fine throat/lid edges, overall finish and natural all-state acting remain open; these samples do not prove every intermediate collision or final acceptance.

All nine structure/lifecycle checks pass. Exact comparison against completed01 changes only sixteen primary parts; the other 151 parts, complete indices, rig, poses, clips and palette remain identical. The measured model remains 27,240 vertices, 49,844 triangles, fourteen bones and twelve clips. Matching comparison source/baseline are preserved in `primary01-comparison/matching-source-and-baseline.tar.gz`, SHA256 `9255860ff9b93e3e3f075d9f3a7a3880279d7ddb0bb284868112837fb598e5da`.

Full-export measurements and archive identity belong in `../ART_REVIEW.md` and the matching `output/export-manifest.json`; require every source hash to match. This stable source record does not approve publication. The following authoring record and earlier checkpoints remain history.

## Primary 01 authoring record — before root comparison

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-primary-01-overlapping-fan`. Completed 01 is the matching baseline. The author inspected its rest/peak three-quarter and peak profile captures, then applied the reviewer's gathered-root and shared-fan proposal. Only the sixteen primary geometries change: roots gather around the existing WingTip pivots, curved centerlines form an oblique fan, and broader vanes overlap with a small shingle offset. Closed tips retain finite width/depth.

Each original closed 8 × 8 grid, complete index buffer, vertex-tone array, part name/order, shade and whole-WingTip binding is retained; only positions and derived normals change. Expected topology delta is **zero**. The global feather helper, coverts, underforms, body, eyes, rig, poses and all clips—including completed01—remain unchanged. World-rest positions use identity append transforms.

Only the three assigned source files were edited with static reads/edits and existing image inspection; no runtime, tests, browser, export or Git operation was run. Freeze for root's scoped parity, nine structural checks and 48 phase/angle comparisons. Root-band continuity through the 55-degree child counterpitch, vane overlap, intersections and silhouette remain unverified. Final art and natural acting remain unaccepted; no visual success is claimed.

## Completed 01 retained checkpoint

Current status: **local refinements reviewed; full character and natural state acting unaccepted**. Creative revision: `sculpt-04-completed-01-forward-clearance`.

Root inspected all 48 completed-01 comparison captures, using identical current geometry with the exact prior eyelid-04 configuration as the baseline. The staged wing now clears the torso visibly at clearance, peak and settle, then returns alongside the body. The long parallel primaries and coarse covert/primary junction remain conspicuous, so this is a retained trajectory correction, not final acting acceptance. Earlier body, grain, wing and temporal-lid refinements remain retained.

All nine structure/lifecycle checks pass. Geometry is byte-identical to eyelid-04 at 27,240 vertices and 49,844 triangles; the rig has fourteen bones and twelve clips. The other eleven clips are identical. Across 2,172 non-wing quaternion samples, the maximum component difference is 4.246830940246582e-7. The matching comparison archive is `completed01-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `235b7c44c673a14473687a5c24b5b2736537b89f692f830ffd88ed4f826cab97`.

The authoritative full-export time, measurements and archive identity belong in `../ART_REVIEW.md` and a matching `output/export-manifest.json`; require every source hash to match. This source record is stable across export and does not approve publication. The notes below preserve pre-comparison authoring intent and earlier checkpoint evidence as history.

## Completed 01 authoring record — before root comparison

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-completed-01-forward-clearance`. The full character remains unaccepted. Geometry, including retained eyelid-04 and wing-01 work, is unchanged.

Only completed's `WingLeft` and `WingTipLeft` acting channels change. The candidate pitches the shoulder forward before a mild inward fold, counterpitches the child, then returns both channels to zero at the existing 0.90-second completed state. Specified shoulder/child rotations `[X,Y,Z]` are: t=0 `[0,0,0]` / `[0,0,0]`; 0.08 `[-16,0,5]` / `[14,0,0]`; 0.20 `[-60,0,5]` / `[55,0,0]`; 0.34 `[-60,0,-8]` / `[55,0,-4]`; 0.48 `[-58,0,-6]` / `[53,0,-3]`; 0.64 `[-56,0,4]` / `[51,0,0]`; 0.78 `[-22,0,4]` / `[20,0,0]`; 0.90 `[0,0,0]` / `[0,0,0]`.

Existing head/lid values at the original keys and the 0.90-second duration remain. New 0.20, 0.64 and 0.78 keys copy the supplied head/lid values exactly from `/tmp/atlas-completed-preserved-keys.json`, preventing the builder from resetting those channels at inserted times. Root derived those values from the prior quaternion trajectory; this author did not calculate or execute a new interpolation. Root must verify the resulting non-wing trajectory. Other poses, clips, rig, pivots, skin bindings, geometry and materials are unchanged. Expected topology delta is **zero**.

Root retained eyelid 04 after all 24 captures: the large white profile wedge is covered at peak closure, neutral irises remain readable, and intermediate samples show no new large breakthrough. Fine edge specks and shape remain unfinished; full blink/art acceptance is not established. Nine checks passed. Exact parity found only two seam parts changed and 165 unchanged; +50 vertices/+96 triangles produced measured comparison counts of 27,240 vertices and 49,844 triangles. Matching source/baseline/receipt are archived in `eyelid04-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `1ff34bc0f5f22398e67abd400c2a11a5d654d48100b0fd2933e33f316c8ca6a7`. These are comparison results, not a new full export. Eyelid 03 remains the last matching full export recorded below.

Only the three assigned source files were edited using static reads/edits. No runtime, tests, browser, export or Git operation was run. Freeze for root's non-wing trajectory check and rest, clearance, peak, settle and return comparisons in three angles. Forward clearance, shoulder attachment and primary overlap are candidate behavior until those captures are reviewed; no visual improvement or full-character acceptance is claimed.

## Eyelid 04 retained local improvement

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-eyelid-04-temporal-return`. The full character remains unaccepted. Retained tuft-01, grain-01 and wing-01 work is unchanged.

The author inspected the unchanged eyelid-03 closed profile and three-quarter captures. A white wedge remains visible between the upper edge and stationary lower lid. The existing upper seam provides height but insufficient inward depth. This patch changes only `upper_lid_seam_Left` and `upper_lid_seam_Right`, adding one cross-section row: original front edge, rounded middle, inward contact edge.

The original front-edge positions and every column's existing Head/lid weight are preserved. The return fades in with a smooth ramp over temporal `side*u=0.42` to `0.67`, beyond the iris's approximately 0.372 normalized outer extent. Central/medial seam geometry is split at its midpoint with the same footprint. The middle ring receives a 0.001-times-almond-factor rounding offset, restricted to the temporal ramp and tapering at the canthus.

The closed contact target uses `Y=-(eyeLower+0.002)*edge`. At each column, interpolation between the actual lower lid's first two mesh rows gives its X/Z at that height; forward clearance is `0.00125*edge`. This samples the stationary lower-lid mesh band, not the sclera depth equation. The existing 68-degree blended Head/lid Y/Z transform is inverted about the unchanged hinge to obtain the contact edge's rest position. Each of the three rings retains the same column weight. This is fixed geometry, with no state-dependent hiding, recoloring or depth-test change.

Only the two seam grids increase from one to two row intervals. Expected delta: **50 vertices and 96 triangles**, predicting **27,240 vertices and 49,844 triangles**, 156 below the 50,000 triangle budget. These are source calculations, not current measurements. Soft upper/lower lids, eye surfaces, iris, pupils, highlights, front edge, rig, hinges, weights, clips, materials, body and wings remain unchanged. Peak contact from this inverse fit does not establish intermediate-blink clearance or a correct silhouette.

Root retained wing 01 after all 38 comparison captures: square shoulder tabs are gone and coverts follow the smaller underform; the rest outline improves. The completed peak still buries much of the wing in the body, and long parallel primaries/other finish remain unaccepted. Nine structural checks passed; parity found exactly 26 changed and 141 unchanged parts, with zero topology delta and 49,748 triangles. Matching source/baseline/receipt are archived in `wing01-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `122b8bf295928eff416175d5d20dffe94a43f3da6c33c9fe10be0a5088a1ab74`. Wing 01 has comparison evidence only; eyelid 03 remains the last matching full export recorded below.

Only the three assigned source files were edited using static reads/edits and existing image inspection. No runtime, tests, browser, export or Git operation was run. Freeze for root's nine checks, bounded part parity and 24 rest/closing/closed/opening captures across front, three-quarter and profile. Review neutral iris visibility, temporal depth closure and intermediate contact before retaining this revision. No visual improvement or full-character acceptance is claimed.

## Wing 01 retained local improvement

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-wing-01-fitted-coverts`. The full character remains unaccepted. Retained tuft-01 and grain-01 work is unchanged.

The author inspected grain-01 full three-quarter/profile and completed-gesture captures. Raised covert roots surround a smooth exposed oval, while descending vane shafts enter the old underform. This patch fits the full covert surfaces, not only their caps, and changes only 24 `layered_wing_covert` parts plus two `folded_wing_underform` parts.

A shared wing envelope retains the original center, radii, eight-degree rotation and height. Above normalized sphere height q=0.35, its shoulder cap shifts inward in world X with a smooth ramp, reaching 0.10 model units at the upper pole. The inner underform smoothly scales X/Z radii through 1.00 at q=0.60, 0.91 at q=0 and 0.84 at q=-0.60 and below. The existing SphereGeometry(20,10) vertices are remapped without changing indices; normals are recomputed, with existing duplicate seam/pole normals reconciled without merging vertices.

The original transformed covert centerlines recover coordinates in the original wing frame. Each across point wraps onto the shared surface. Existing eight-by-eight rings use root-to-tip width multipliers `[.18,.72,.90,.76,.56,.31,.10,.006]`; the root crest sits 0.006 inside the inner underform, the t=0.18 ring emerges, and crests from t=0.37 follow the outer envelope. Closed rear surfaces extend inward into the inner underform through t=0.76. As clarified by the explorer, the free distal ends then smoothly reduce total thickness across the existing last three rings to a finite 0.00012 units, avoiding tiny-width but thick terminal fins. The lower fit separately fades from full at q=-0.84 to zero at q=-0.99, returning to original geometry below that range.

All placement tuples, lengths, sweep/curl inputs, part names, indices, tone values and respective whole-`Wing` bindings remain. The global `feather()` construction, all sixteen primaries, rig, pivots, clips, materials, body and face remain unchanged. Expected topology delta is **exactly zero**: the 26 affected parts retain 1,998 vertices and 3,696 triangles by construction. These are arithmetic counts, not measurements of wing 01. Actual moving shoulder contact and covert/primary overlap remain unverified.

Root retained grain 01 after all 22 comparison captures: neck/throat ribbing is quieter, with no new throat holes or detached tufts in sampled views; the fine staircase and pointed tuft finish remain. Nine structural checks passed. Parity found 45 changed and 122 unchanged parts; comparison counts were 27,190 vertices, 49,748 triangles and fourteen bones. Source/baseline/receipt are archived in `grain01-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `b4f4611d1bd189a1ea8899299167364323dcea7c67568bf2bf3c59976eb47f44`. Tuft 01 and grain 01 have comparison evidence only. Eyelid 03 remains the last matching full export recorded below.

Only the three assigned source files were edited, with static reads/edits and existing image inspection; no runtime, tests, browser, export or Git operation was run. Freeze for root's exact parity check allowing 26 changed parts and 34 renders, including completed at 0.34 seconds in full/portrait front, three-quarter and profile. Inspect upper attachment, whole vane visibility, tip thickness and lower overlap during motion. No visual improvement or artistic acceptance is claimed before that review.

## Grain 01 retained local improvement

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-grain-01-shallow-staggered-plumage`. The full character remains unaccepted.

Only `plumageShell()`'s phase, shaft, stagger/envelope, relief and tone field changes. The specified field replaces the narrow 28-cycle fourth-power ridges with a 16-cycle smooth cosine shaft and staggered longitudinal envelope. Relief modulation decreases from 0.006 to 0.0016 model units, with the existing 0.0008 offset and 0.0022 boundary-scaled base retained. Tone modulation uses the specified shallow grain and five-cycle variation. Grid, indices, Y samples, profile, outward vector and boundary calculation remain exactly as authored.

Retained tuft-01 construction automatically fits its 44 breast/mantle tufts to the revised shell. Thus the allowed geometry changes are the shell and those 44 fitted parts; all other geometry, materials, rig, clips and placement tuples remain unchanged. Expected vertex/triangle delta is **exactly zero**, not a current measurement. Shell radial movement is bounded by 0.006 model units from the field ranges. Its projected silhouette and pale throat-mask edge still require actual render review; unchanged mask code does not imply identical visible boundary pixels.

Root retained tuft 01 after inspecting all 22 captures: rectangular root plates are gone, while pointed lower ridges/slits and coarse finish remain. Nine structural checks passed; external parity found exactly 44 changed and 123 unchanged parts with identical indices, rig, poses, clips and palette. Comparison measurements were 27,190 vertices, 49,748 triangles and fourteen bones. Matching source/baseline/receipt are archived in `tuft01-comparison/matching-source-and-baseline.tar.gz`, SHA-256 `2316d4830bea30aa8874a93969fdd7662322408e241811d92045697df45283c3`. This is comparison evidence, not a full tuft-01 export. The last matching full export remains eyelid 03, recorded below.

Only the three assigned source files were edited with static reads/edits; no runtime, tests, browser, export or Git operation was run. Freeze for root's parity check allowing 45 affected parts and matching renders, including throat boundary and tuft contact in gestures. No visible improvement is claimed. Wing work remains separate.

## Tuft 01 retained local improvement

Status: **authored, unexported, unreviewed source**. Creative revision: `sculpt-04-tuft-01-surface-fitting`. The full character remains unaccepted. Retained beak-02, throat-04 and eyelid-03 work is unchanged.

The author inspected the matching eyelid-03 full-body front and three-quarter light turnarounds and the selected reference. The body tufts have broad straight roots, raised side edges and wide terminal panels. This patch changes only the existing 24 `breast_flow_tuft` and 20 `mantle_flow_tuft` grids.

Each body-tuft column now follows its own angle around the curved body instead of translating sideways from a single tangent plane. A small sampler interpolates the already-created feather shell's existing triangles at that angle and height, including their actual displaced relief. The shell itself is unchanged. Root and lateral edges sit 0.0018 model units inside that sampled surface, while a smooth root ramp and squared side falloff introduce shallow central relief. This avoids relying on analytic relief alone where the shell's coarser triangles differ from the analytic surface.

The body-only width envelope curves down to 18% of root half-width at the terminal row, replacing 54%. It retains finite width and the existing three unequal terminal lobes. All original placement tuples, tip-height formulas, vertex order, tone values, indices, names and `spineWeight` calls remain. The original sample heights are preserved, so the existing Y-based binding semantics remain; no stale weight array is copied. The four temple tufts retain their original construction path.

Expected topology delta is **exactly zero**: each of the same 44 body grids still has 13 × 6 = 78 vertices and 12 × 5 × 2 = 120 triangles. This is source arithmetic, not a measured tuft-01 export. No eyes, beak, throat, body profile, outer proportions, wings, rig, clips, materials, lighting or shell ribbing are revised. Only the three assigned source files were edited, with static reads/edits and image inspection; no runtime, tests, browser, export or Git operation was run.

The last matching full export is eyelid 03, exported **2026-10-04T18:03:14.083731+00:00** and archived as `atlas-eyelid-03-review.tar.gz`: 104 artifacts, 27,190 vertices, 49,748 triangles, fourteen bones, twelve clips and a 2,035,216-byte GLB. Root reported all nine structural checks passing. These are historical results, not validation of tuft 01; 252 triangles remain below the 50,000 budget if the zero-delta prediction is confirmed. The retained eyelid review wording below remains history.

Freeze for root's nine structural checks and 22 matching comparison captures, including profile and existing gestures. Review whether the roots/sides remain in contact through deformation, whether the rounded lobes read as integrated feathers, and whether coarse shell interpolation causes visible facets or intersections. No visual improvement or full-character acceptance is claimed before those renders. Shell ribbing and wing-root integration remain separate follow-ups.

## Eyelid 03 retained local improvement

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
