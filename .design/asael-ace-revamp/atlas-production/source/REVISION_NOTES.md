# ATLAS sculpt 04, primary color 01 — retained long-feather finish

Current status: **local primary-feather finish retained; final character, motion and device acceptance remain open**. Creative revision: `sculpt-04-primary-color-01-continuous-wing-finish`. Matching export validity is established by this revision in the output manifest and external verification receipt. The verified wing-color01 predecessor is archived separately.

Exactly sixteen `curved_primary_Left/Right_0..7` vanes gain tapered lengthwise UV strips in the existing brown rear atlas. The coordinates follow the retained vane profile and reuse the same lateral values on front and rear, with no wrap or new paint. Original scalar tones are retained. The two number-5 vanes previously used the lighter feather palette; all sixteen now sample umber paint once. That accent darkening alone does not justify retention.

Root reviewed nine named sheets covering rest/full 256px, raised/full 256px, light/dark 512px, completed .08/.34/.48/.78 and small 72/36px. Independent review covered all 22sheets / 176 captures. Directional color across several vanes improves coherence with the coverts, most clearly at 512px and subtly at 256px. Small-size results remain neutral. No new distracting shaft marks, noisy stripes, abrupt texture edges or wing junction defect was identified in the samples. Fan geometry still reads stiff; color does not resolve silhouette, natural acting or continuous motion.

The exact scope proof preserves all geometry, normals, ordered indices, skin, every atlas byte, rig, poses and all 168 tracks. All151otherparts remain exact. Candidate/baseline sources, all captures and the retention decision are preserved in `primary-color01-comparison/matching-source-baseline-and-captures.tar.gz`, SHA256 `2e923193e73c52c6ba4a72078dbf0649f4d31cd823a06e54b846da82efeb48fb` (15 sources, 220 members). Full art, eyelid finish, likeness, natural acting and device acceptance remain open. The approved static portrait/greeting remains public.

## Wing color 01 — historical retained checkpoint

Status at the wing-color01 checkpoint: **local wing finish retained; final character, natural acting and device acceptance remain open**. Creative revision: `sculpt-04-wing-color-01-coherent-plumage`. Full-export validity is established only by the matching revision in `output/export-manifest.json` and its external verification receipt. The preceding FACE02 export is preserved separately; no current result is inferred from that predecessor.

The two wing underforms and 24 coverts now sample existing brown rear-chart texels through a wing-local angular mapping. Normalized wing-local height maps to pixel-center rows 48.5–447.5; the side-adjusted angular coordinate maps to columns 544.5–991.5. These coordinates stay inside the padded brown body island, away from the pale throat and white patch. Vertex colors retain the original scalar tones instead of multiplying the brown atlas by brown a second time. No atlas pixels are repainted.

Exact scope comparison against FACE02 preserves all positions, normals, ordered indices, skin attributes, rig, static poses, all 168 tracks and complete atlas bytes. The remaining 141 parts retain every attribute exactly. Root reviewed all 15 matched sheets / 120 captures; independent review agrees to retain the more coherent wing/body finish. The improvement is clearest in profile, three-quarter and raised-wing samples, subtle at 256 pixels and neutral at 72/36 pixels. No new obvious wrap banding or wing/body junction defect appeared in those samples. This is bounded visual evidence, not continuous-motion or final-character acceptance.

The frozen comparison archive is `wing-color01-comparison/matching-source-baseline-and-captures.tar.gz`, SHA256 `222bf301d5a808487d27400f03a6cc9f87a5a353cb1f6afd3ea98c85cffd364e`; fourteen candidate/baseline/helper sources and 156 archive members verify. Existing bulky closed lids, final likeness, acting, small-size needs-you readability and device acceptance remain open. The rejected FACE03 and raised01 experiments are archived separately; their changes are absent. The approved static portrait remains the public delivery.

# FACE02 authoring checkpoint — historical notes

Status recorded before the completed FACE02 export: **local integration refinement retained; final art, natural acting and device acceptance remain open; matching face02 export and GLB parity pending**. Creative revision: `sculpt-04-face-02-anchored-brows`. Retained feather03 is preserved without overwriting prior copies in `/tmp/atlas-feather03-final-source.mjs` and `/tmp/atlas-feather03-final-model.json`. Before edits, source SHA256 `0387126409a69524635aa85961decf3a07ccb0f1098af77b86f98ef83a09f217` and configuration SHA256 `220cfe788006cf9211a3d1e2c2d4efb9a9d1d4df8351022f00fa898bd4e3f3bb` matched those copies exactly. Feather03 remains the latest retained complete matching export, at `2026-10-04T21:45:36.836138+00:00`; its archive SHA256 is `a46db9540d3541c050cff22257ea4770f6692e10a78ab7e5665bc5edca1ea753`. Its export results do not establish face02 export parity.

Independent review selected only `neutral_brow_sweep_Left` and `neutral_brow_sweep_Right`. Face01 softened their relief but the smooth separate strips and blunt ends remained. Geometry-only burial also left every vertex attached to the moving Brow bone, so existing expressive raises could lift the attachments away from the head. This refinement changes those two parts' shape, shading coordinates and Head/Brow binding together; no eye or lid geometry is involved.

The original center path, 17 rings, eight vertices per ring, scalar tone sequence and full index topology remain. A broad shallow cross-section replaces the round strip. Its vertical half-span is `.003 + (.020 + .010 sin(πt)) × attachment`; the attachment envelope uses smoothstep over the first .22 and last .28 of path length, tapering both ends to a narrow buried terminal ring. Five cross-section vertices sit 0.0018–0.004 model units inside the supporting head mesh. The front ridge adds up to .012 units above that buried base; adjacent front samples add 45% of that relief. The original ring orientation is retained so front-facing normals stay outward.

The contact sampler caches the actual Float32 positions, indices and normals of the retained head triangles before `append()` adds unchanged UV seam copies and disposes the geometry. It finds the foremost triangle at each brow vertex's X/Y using barycentric coordinates, with no analytic-surface fallback. This read does not alter the head. Sampled head normals blend into brow normals toward attachment borders and terminal rings to avoid a separate dark shading rim. The bounded visual review below found no new trench in the sampled phases; continuous deformation and final naturalism remain separate acceptance questions.

Both terminal rings and the two attachment borders, including their buried back vertices, are fully Head-bound. The central front ridge receives the longitudinal attachment envelope as Brow weight, reaching full Brow influence through the middle. Its two neighboring front samples use half that Brow influence; all remaining weight belongs to Head. Existing bones, pivots, poses and animation keys are untouched. This keeps the borders seated under the strongest authored `needs_you` raise while leaving the center free to react, but does not establish continuous collision-free deformation or expressive quality.

Only these two parts now sample the existing front upper feather atlas using the retained angular mapping and scalar tones. This removes their separate flat umber color path without repainting or adding an image, material or map. The exact scope proof confirms that changes are confined to positions, normals, colors, UVs and skin indices/weights in the two brows. Every atlas byte, the other 165 parts and their mapping, all ordered indices, eye/lid contact, beak/head/body/wings, rig, palette, static poses and all 168 clip tracks remain exact feather03. Topology is unchanged, retaining 49,844 triangles.

The model suite now admits upper-chart UVs on precisely the two named brows while preserving the other 119 constant-white parts and 46 already mapped parts. One additional narrow case independently raycasts attachment points against the actual head triangles, checks fully Head-bound borders and terminal rings, and applies the existing strongest `needs_you` key to prove fixed attachments and nonzero central Brow motion. The upper-image digest and prior geometry/eye/lifecycle assertions remain. The author performed static reads/edits and backup copies only. Root subsequently ran all ten model checks and `/tmp/atlas-face02-parity.mjs`; both pass. Matching GLB parity and the full face02 export remain pending.

## Face 02 bounded review

Root and independent visual review inspected all seventeen matched sheets / 102 images, including neutral, listening, strongest needs-you, blink, closed and completed views, front/three-quarter/profile angles, and 72/36-pixel samples. Both retain clearer neutral/listening integration, with no new trench, detached tip or lid obstruction in sampled phases. The asymmetric crest remains readable, but the distinct eyebrow gesture is substantially quieter, especially at three-quarter. This is a local integration gain with an expressive tradeoff; it does not establish final likeness or natural acting.

The nine bound comparison files are preserved in `face02-comparison/matching-source-and-baseline.tar.gz`, SHA256 `15966ef551dfda6b6ffa474e2def0a6bb5ffc750deb59aa317f165cc5a78157f`. Exact scope proof preserves the other 165 parts, the full atlas and all 168 animation tracks. Existing bulky closed lids remain open. Stills do not prove continuous attachment or small-size `needs_you` readability. Device acceptance, matching face02 GLB/full-export verification and publication remain separate pending gates; feather03 is still the latest retained complete matching export.

## Feather 03 retained short torso-vane paint refinement

Current status: **local paint refinement retained; final art, motion stability and publication unaccepted**. Creative revision: `sculpt-04-feather-03-short-vanes`. Retained feather02 (`sculpt-04-feather-02-angular-color`) is the exact baseline, saved as `/tmp/atlas-feather02-final-source.mjs` and `/tmp/atlas-feather02-final-model.json`. Feather02 is the preserved prior complete matching export, at `2026-10-04T21:32:27.157894+00:00`, with 17 source hashes, 104 artifacts and 163 archive members verified. Its archive SHA256 is `42a6653c7d0d45f6ce5bd6110b4404812e14d9cd3fbe1fc4df284f379d122910`; those results do not validate feather03.

The retained angular chart removed feather01's large side/profile loops, but long narrow torso highlights still read as hair. This candidate changes torso paint only. `featherMotifs()` and all hash, exclusion and placement decisions remain untouched. The accepted list is generated once and reused for both the retained and revised scalar fields. Revised stamps keep each original X/Y anchor, direction, light side, highlight/shadow coefficients and terminal-shadow selection. Their final painted widths increase 18% and lengths decrease 25%; none of those shape changes feeds back into placement or rejection.

The revised vane keeps the existing taper and opacity envelope. Bend scales with width. Existing barb endpoints scale by 1.18 laterally and .75 longitudinally; their attachment distances scale by .75 and soft stroke widths by 1.08. The soft highlight's lateral denominator broadens from .42 to .60 and the opposite shadow from .52 to .64. The same 16%-selected minority of terminal accents gains a curved tip at `t = .88 - .16u²`, with longitudinal softness .065, lateral softness .82 and a 1.6 multiplier on its existing .035 coefficient. No new shaft, full outline, stamp center or repeated row is introduced.

The original field is computed through its retained arithmetic path. Revised values replace it only through Y=1.90, then mix back to the original using a smoothstep fade over 1.90–2.02. No scalar field entry at or above Y=2.02 is written by that blend. The upper chart therefore receives the original values directly, including its head/throat feather detail. The existing palette, throat mask, color limits, atlas conversion, front-to-rear body copy, angular UV mapping, padding, alpha and white patch remain untouched. This keeps the entire 1024-wide RGBA region from row 480 through 1023 within the exact retained-image boundary.

Intended changes are lower torso atlas pixels only. All 167 parts' positions, normals, scalar/palette colors, UVs, ordered indices and skin attributes, all bones/poses and all clips must remain exact feather02. There is no wing geometry or additional wing texture mapping in this candidate. Image size remains 1024 × 1024 RGBA8 with one material and one map.

The focused model case retains its color-bound, front/rear identity, angular ownership, seam-filter, finite geometry and lifecycle assertions. It additionally hashes all 2,228,224 full-width upper-region bytes against root's independently computed retained feather02 digest: `2ffac06903676fb1451b46e492ba17ba4d8b8d49f7fc955ad98e4d958c99d0e4`. This protects the head, throat, upper gutters and white patch together. The author used static reads/edits only. Root verification and visual review follow; final likeness, natural acting, shimmer, performance and publication remain unaccepted.

## Feather 03 bounded review

Exact baseline parity confirms zero mesh-attribute, UV, index, part, rig, static-pose or clip changes. Only 298,806 lower image pixels change; full-width rows 480–1023 remain byte-identical. All nine model/lifecycle checks pass, including the frozen upper-region digest. The matched source/configuration, notes, model checks, helper and 96 comparison images are archived in `feather03-comparison/matching-source-and-baseline.tar.gz`, SHA256 `28a93ff1b23bb545cbade400b9991662801b6ae3467e29a027ab9137f15f69dc`.

Root reviewed working/torso, completed and full comparison sheets. Independent review inspected all twelve sheets plus original working views from four angles and completed profile pairs. Both retain the modest improvement: shorter softer marks reduce the hair-like chest/flank streaks without new hard scales, repeated rows, woodgrain loops or a visible below-collar transition. The improvement is clearest close up and subtle at full-body scale. Small light/dark 36/72-pixel samples show no obvious new speckling or readability regression. Soft mottling remains, layered feather relief is not achieved, and smooth wings still contrast with the body. These still observations do not prove continuous motion, shimmer, physical performance or final artistic acceptance. Matching GLB and full-export receipts remain separate evidence.

## Feather 02 retained angular color-surface refinement

Current status: **local refinement retained; final art, motion stability and publication unaccepted**. Creative revision: `sculpt-04-feather-02-angular-color`. Retained face01 (`sculpt-04-face-01-integrated-eyes`) remains the exact geometry, rig and clip baseline, preserved in `/tmp/atlas-face01-final-source.mjs` and `/tmp/atlas-face01-final-model.json`. The rejected feather01 source/config are preserved in `/tmp/atlas-feather01-candidate-source.mjs` and `/tmp/atlas-feather01-candidate-model.json` for a mapping-only comparison.

Root and independent review rejected feather01's curved, swirling marks in side/profile temple and torso/wing views. Its added front/rear detail was useful, but the planar rest-X projection compresses texture coordinates near the side of the oval and shifts them as the head/body radius changes with height. Feather02 changes the surface chart before changing the paint itself.

For each mapped rest point, the combined retained silhouette profile supplies radius X, radius Z and center Z at that Y. X and Z are normalized by those radii. Positive front depth is first raised to the reciprocal of the unchanged `frontContour` exponent, recovering the original oval cosine beneath the squared face. `atan2(normalizedX, abs(recoveredCosine))` then gives the signed angle across a front or rear half-circumference. The range −π/2 to π/2 maps to the existing 480-column island. Using both X and Z avoids a planar side projection and avoids clamping raised shell/tuft points through an `asin` input. This is angular spacing, not a claim of equal physical arc length or distortion-free painting.

The fixed-hash motif placement, vanes, barbs, underpaint, boundary fades and modulation coefficients remain exactly the feather01 algorithm. Its chart X now represents normalized angular distance rather than physical rest X. The existing physical-X/Y throat mask is evaluated using `radiusX(Y) × sin(chartAngle)` before its unchanged pale blend and contrast attenuation. This changes only the front throat pixels required to preserve that physical region under the new chart. Rear image bytes, the common umber feather field, Y rows 16–959, 1024 image size, opaque alpha, umber gutters, white patch, filtering and color space are intended to remain exact feather01 values.

Both continuous layers and all 44 previously mapped body tufts receive the angular UVs; the other 121 parts retain their white-patch UVs. The existing front/rear triangle classification, 303 seam copies and all indices stay unchanged. Identical rest points on paired seam copies obtain identical local chart coordinates, with the original 512-pixel island separation. Geometry, normals, scalar colors, palette, skin, bones, poses, cameras and all face01 clips are outside this mapping correction. In particular, lower-body UV values are now allowed to change; the earlier lower-UV freeze was specific to feather01.

The focused model case now converts image samples to physical X for pale exclusion and interior bounds. It also checks equal chart spacing for all 48 radial samples on an authored torso ring and an authored squared-face ring: the former rejects planar projection and the latter additionally detects a missing contour inversion. Existing deterministic image, color-bound, ownership, seam-filter, finite geometry, skin and lifecycle checks remain. The author used static reads/edits only; the root verification and visual review are recorded below. Continuous motion stability, device performance and publication remain unaccepted.

## Feather 02 review and bounded verification

Root and independent review retained the correction after 96 matched comparison images. The broad temple loops, shoulder arch and concentric flank rings in feather01 are removed. Head/throat detail remains useful, and the pale region has no new obvious spill or conspicuous hard chart boundary in the reviewed samples. The physical mask is retained by construction, but its rasterized boundary is not pixel-identical. Root reviewed full, portrait, working, completed, dark portrait and 36-pixel sheets plus original profile comparisons; the independent reviewer inspected all twelve sheets and original head/flank/completed/front/three-quarter samples. Fine texture mostly disappears at 36 pixels and adds modest variation at 72 pixels. Torso strokes remain painterly or hair-like; smooth wings, cheek/neck tuft lines and separate wing layers still need finish work.

Exact face01 parity preserves positions, normals, colors, indices, skin, rig, poses and all 168 clip tracks. UVs change only in the 46 mapped parts; 121 parts remain exact. The 1024 RGBA map changes 661,439 pixels against face01, still decoding to 4,194,304 bytes. All nine model/lifecycle cases pass. Comparison source/configuration and baseline are archived in `feather02-comparison/matching-source-and-baseline.tar.gz`, SHA256 `0a27626b37ba4267ca04ee22d9b4c2909124ac269eddebf1368b1b5e746ff0c1`.

The source/embedded-GLB round trip covers seven groups, four angles and both modes: 56 captures and 28 pairs. Eight rest pairs are exact; all posed differences total 39 pixels, maximum one channel value. The candidate GLB is 2,985,740 bytes. Hide/reload/dispose passes without page/console/rejected-network errors. The raw helper inherited hardcoded 20-pair/40-capture summary values after adding closed-eye and completed-hold groups. Its archived source/receipt stay unchanged; `count-correction.json` verifies all artifact hashes, 56 actual capture entries and 28 actual pixel-pair rows. The helper now derives counts from group/view arrays. The archive SHA256 is `7a76f0de3795ece4ee447b168151f148840e5d840738cc8d8d22f332d2135b2c`.

These are bounded still, scope and lifecycle observations, not continuous motion/collision, shimmer, natural acting, measured GPU allocation or physical-device acceptance. Full-export validity is determined by its matching manifest and external verification receipt. The approved portrait/static greeting remains the public delivery.

## Feather 01 rejected planar candidate

Status: **rejected after comparison; retained here as authoring history**. Creative revision: `sculpt-04-feather-01-directional-color`. Root captured 96 images covering full/portrait, speech, listening, working, completed, 36/72-pixel and dark views. Root and independent review rejected visible curved/swirl stretching at the temple and torso/wing in side/profile views. The matching source/baseline comparison archive is `feather01-comparison/matching-source-and-baseline.tar.gz`, SHA256 `1486391d1d6fcdd71281b362f0662611604eabe71d7899892e9611bfcfaa4d74`. The following paragraphs describe that candidate's original construction, not approval of its appearance.

The existing 1024 × 1024 atlas, two X islands (16–495 and 528–1007), body mapping (.38–2.08 across rows 16–480), opaque alpha, umber gutters and white X/Y ≥ 992 patch remain. Upper rows 480–959 now cover rest Y 2.08–3.075, including the silhouette top at 3.055. Atlas construction evaluates the shared Y=2.08 row once. Each body texel is generated once and copied exactly to the rear. Upper front/rear also share the same feather field; only the retained front throat mask mixes in pale color and attenuates local contrast. The previous grain02 byte-exact throat fixture was deliberately scoped to that pass and is superseded by the new upper mapping and bounded pale-color checks.

Placement considers 4,096 independently hashed candidates and caps accepted motifs at 1,000. Anisotropic exclusion radii are 45% of width and 42% of length, each scaled by a hashed .8–1.2 spacing factor. Neighbor bins are .06 × .11 model units and only accelerate rejection; they do not prescribe rows. Full width/length ranges blend smoothly from body .040–.070 / .11–.19 to neck .020–.036 / .07–.12 over Y 1.98–2.38, then head .022–.040 / .060–.10 over Y 2.65–2.90. Direction varies continuously from a slight outward body sweep, through the diagonal throat flow, to outward crown/temple flow, with independent ±12-degree variation. No mirrored placement or sequential random state is used. The actual accepted count is not yet measured.

Each bounded stamp follows a quadratic bend of up to 28% of its width. Its broad root tapers by `(1-t)^.6`, with opacity fades over the first 20% and final 10% of length and the outer 30% of lateral extent. Soft asymmetric highlights use a .16 coefficient and opposite-side shadows .11, each varied by .75–1.25. Three to six candidate barbs use independent positions, rootward lean, side choice and 22% omission; their smooth stroke widths are .007–.008 model units and signed strengths .025–.050. A 16% minority has a soft .035 terminal shadow. There is no closed outline or continuous shaft. Overlap is normalized by accumulated opacity with a floor of one, and anisotropic noise of at most ±.0165 supplies underpainting.

Modulation fades only at true chart boundaries, over .018 model units in X and at Y .38/3.075. It does not fade at 2.08 or the old 2.76 clamp. Final linear-color multiplier limits are .76–1.22 for the body, blending toward .80–1.17 above Y 2.38–2.74. The pale region attenuates modulation by up to 35% and blends its limits toward .83–1.10 according to the existing mask. These are hard limits, not measured extrema or a requirement that each motif reach them. sRGB interpretation, linear min/mag filtering, clamp wrapping, flipY=false, no mipmaps and one embedded PNG on export remain unchanged.

Intended structural scope is atlas pixels and UV values within the same two continuous layers plus 44 body tufts. Many lower-body UV arrays remain exact because only the upper mapping changes. The 303 seam-copy construction, complete indices, all geometry/normals/colors/skin, other 121 parts, rig, static poses and every face01 clip remain untouched. The focused model case now checks deterministic map bytes, body/rear equality, body/head/pale limits, upper pale exclusion, matched seam-copy samples, continuous-triangle island ownership, actual upper-head UV coverage and complete edge/filter/white footprints. Geometry, skin and lifecycle assertions are retained.

Only the three source files and `scripts/atlas/model.test.mjs` were edited using static reads/edits. No runtime, Node, Python, browser, Git, build, installation or export was run by this author for feather01. Root owns exact scope proof and matched light/dark full/portrait, 36/72-pixel, tilt, speech, working and completed review. Printed scales, visible rows, crosshatching, transitions, planar stretch, tiny-output shimmer and contrast against untextured crown/temple/wing parts remain possible failure modes. Color marks do not supply physical feather relief. Final likeness, motion, device performance and publication remain unaccepted.

## Face 01 retained integrated eyes

Current status: **local refinement retained; final face finish and natural acting remain unaccepted**. Creative revision: `sculpt-04-face-01-integrated-eyes`. Retained grain02 (`sculpt-04-grain-02-continuous-color`) is the exact baseline, preserved in `/tmp/atlas-grain02-final-source.mjs` and `/tmp/atlas-grain02-final-model.json`. Its retained evidence remains below.

Only `soft_lower_lid_Left`, `soft_lower_lid_Right`, `neutral_brow_sweep_Left` and `neutral_brow_sweep_Right` are reshaped. The lower lid's original first two rows, including their positions and normals, remain exact: the upper closing seam samples that fixed first strip. X/Y stay unchanged throughout the lower lid. Rows 2–4 recess to no farther forward than the existing analytic cheek surface minus 0.0015, 0.0025 and 0.0035 model units respectively; already deeper points stay deeper. This is intended to end the visible dark band near its halfway row while preserving the thin eye-contact edge. The current umber color remains unchanged.

Each brow retains the original 17 × 8 sweep, center path samples, X coordinates, tone values, topology and bone binding. Its vertical span expands 22.5%; the lower section vertices flatten to the existing per-ring underside before that expansion. Positive Z relief above the sampled head surface is reduced 35%, and smooth end envelopes over the first 18% and last 22% of the curve bury the ends at least 0.003 model units below that surface. These fits use the retained profile and front contour; they do not prove contact with every rendered head triangle or a natural brow silhouette through poses.

Completed's `UpperLidLeft` and `UpperLidRight` keys change only at 0.48, 0.64 and 0.78 seconds, to `[17,0,0]`, `[14.5,0,0]` and `[12.5,0,0]`. The prior omitted 0.48-second lid keys compiled to zero, producing a return toward the neutral opening between the 18-degree satisfaction peak and the 12-degree held pose. The candidate instead holds a partial squint and settles once. All other completed keys and channels, its 0.90-second duration, all static poses and all eleven other clips remain unchanged. In particular, the established shoulder/child-wing trajectory is retained exactly.

Root's exact comparison confirms four parts' positions/normals changed, while 163 other parts, all ordered indices, colors, UVs, skin, rig, static poses, profiles, full texture and 166 of 168 tracks remain exact. The first two lower-lid contact rows include exact positions and normals. All clip timestamps and durations stay exact. Both modified lid tracks settle monotonically from their peak to the existing static pose. Nine model/lifecycle checks pass.

Root and independent review inspected 72 matched before/after captures: full body, neutral portrait, half-close/closed/half-open blink, listening, completed at .34/.48/.64/.78 seconds and native 36/72-pixel portraits in front, three-quarter and profile. The lower rims are quieter; broader less projecting brows improve integration; no new visible sclera leak is seen in those samples. Completed's half-lidded expression now holds through the sampled fold and return. The medial brow ends remain blunt and the brows partly read as separate pieces. The gain is moderate at full-body scale and small at 36 pixels. Existing fine bright closed-eye dots predate this change.

Comparison source, baseline, helper and PNGs are preserved in face01-comparison/matching-source-and-baseline.tar.gz, SHA256 2cc6f8d412d46befd84a48eb07540dd7bc1431d3c4846f6fdec54413aa2fc5f2. These are bounded still and structural observations, not continuous collision, interpolation smoothness, blink timing, physical performance or final acting acceptance. Grain02 remains the latest complete matching export at this checkpoint; the retained source needs its own final export. No final-art or publication approval is implied.

## Grain 02 retained continuous body-color grain

Current status: **local refinement retained; final art and natural acting unaccepted**. Creative revision: `sculpt-04-grain-02-continuous-color`. Retained finish03 (`sculpt-04-finish-03-padded-color-chart`) is the exact baseline; its evidence remains below.

The candidate uses one deterministic 1024 × 1024 RGBA atlas. The front chart spans X 16–495; the rear spans X 528–1007. The retained 480 × 480 throat grid moves unchanged to front Y 480–959. Its row-major RGBA fixture SHA256 is `469f12ced11fcc8de012429225cb435ee9f8946d26e8064eed3a14b9ecc6e05f`. Body Y .38–2.08 maps over texels 16–480, and the rear head remains plain umber. Umber padding surrounds both charts. The existing 504/512 UV of the other 121 parts now samples texel 1008 within the white patch at X/Y ≥ 992.

A fixed integer hash feeds smooth anisotropic value noise. A slow .012-unit horizontal warp bends the coarse (40X,14Y) and fine (68X+7Y,24Y) fields; their .065/.025 blend is clamped to ±.075 before linear-color modulation. Smooth fades cover Y .46–.56 and 1.98–2.08. Each body texel is generated once and copied byte-for-byte to the rear chart. The throat and head receive no grain. No random generator, shader customization, normal map, external resource or additional material is introduced.

The two continuous layers reuse all 303 existing seam copies and the same complete index buffer. Each of the 44 breast/mantle tufts selects one atlas island from its mean rest Z and maps rest X/Y throughout that part. Its retained scalar tone is stored in all three color channels so the atlas supplies umber. Exact comparison confirms changes are limited to UVs in these 46 parts and colors in the 44 tufts; all positions, normals, indices, skin inputs, rig, poses, clips, original tuft scalar tones and the other 121 parts remain exact against finish03. Wing, temple and head construction is unchanged.

The atlas retains sRGB interpretation, linear min/mag filtering, clamp wrapping, no mipmaps and one embedded PNG on export. Decoded RGBA storage is 4,194,304 bytes, compared with finish03's 1,048,576; GPU allocation and performance remain unmeasured. Nine model/lifecycle checks and ten static-tool checks pass. The old 480² throat bytes, front/rear body field identity, chart filter padding and separate white footprint are verified.

Root reviewed 64 before/after captures across full, portrait, torso, working, completed and native 36/72-pixel samples. Independent review retains the subtle body variation without a demonstrated new defect. The small-size benefit is minimal; the field remains a quiet base, not the reference's dense fine feather finish. The comparison archive SHA256 is `fc6f62d88f11d1c5f63a991d78c0fcaac140da16bf4b7f33667412abbea9bd02`.

An initial contact-sheet impression of a sharper throat was withdrawn after matched original PNG/crop inspection and measured differences. The head/throat region differs by at most one channel value in 26 front, 67 three-quarter, 187 profile and 226 rear pixels. Its edge coarseness is already present in finish03. Review future suspected edge regressions in matched original pixels before attributing them to source changes; rescaled contact sheets alone can mislead. The exact regional measurements and helper are preserved in `grain02-protected-region-review.tar.gz`.

Forty procedural/embedded-GLB captures preserve appearance: eight rest pairs are pixel-identical; twelve posed pairs differ at 0–10 pixels each by at most one channel value, 31 pixels total. Both modes decode one1024²map. Hide/reload/dispose pass without page/console/rejected-network errors. Matching comparison archive SHA256: `cdfd1fa8da0ea4bc75d3b29d677dc1dc51aa95973689e83ada6429bccda39705`. Full-export measurements belong in `../ART_REVIEW.md` and the matching export manifest; source hashes must agree.

Motion shimmer, grazing-angle quality beyond these samples, natural acting, final likeness/finish, physical performance and publication remain open. No reviewed admission is authorized by this local retention.

## Finish 03 retained settled feather ends and padded color chart

Current status: **local refinement retained; full character and natural acting unaccepted**. Creative revision: `sculpt-04-finish-03-padded-color-chart`. Retained finish02 is the exact baseline.

Only the contact-fitted branch of the 44 breast/mantle tufts changes. A smooth rise over the first two row intervals and a smooth settling envelope over the last three lower the middle relief and return the terminal row into the sampled shell. With the existing lift, outward displacement is bounded by −0.0004 and +0.0044 model units. Roots and lateral edges remain just inside the sampled surface. Footprint, tip heights, all Y values, sweep, tone arrays, vertex order and indices are unchanged; the four temple tufts retain their separate construction.

Forty before/after captures cover full body, portrait, torso, working and completed in front, three-quarter, profile and rear. Root and independent review retain the reduction in raised droplets and long cuts without a new profile/rear gap or protrusion. Small slits and isolated marks remain. Body02 comparison archive SHA256: `71f78247d16631c32907e0422511cb6209542221a822dbd8cd7b09d0bc2c0d1b`.

Eighteen diagnostic captures without the four temple tufts show that descending cheek edges come from those pieces, but the horizontal pale head line persists. That diagnostic archive is `3e5d6b23db425ad596af6b47d3228d7269a5198553dc68b512555dfd5429753b`; no tuft was removed from retained source. Eighteen further captures changing only texture padding remove the horizontal line in portrait, listening and completed front/three-quarter/profile views. Root and independent review retain the correction with no observed new color regression. The chart margin now uses umber while the separate 16 × 16 white patch around other parts' constant UV remains white. Padding diagnostic archive SHA256: `0293e94d73ed1aa4425cd95f62a8872415e6f10e0e2c4f5cb9c446cfbf89db32`.

Exact comparison against finish02 passes: 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material, one texture and 167 parts. Only positions/derived normals in 44 breast/mantle parts and 31,488 texture-margin pixels change. All 123 other parts, complete indices, colors, UVs, skin indices/weights, chart interior, white patch, rig, poses, palette and clips remain exact. Nine final model/lifecycle checks pass, including a regression check for the chart's filter footprint and the separate white sample.

Forty procedural/exported GLB captures preserve appearance: eight rest pairs are pixel-identical; the other twelve pairs differ by 0–10 pixels each and at most one channel value (31 pixels total). Both modes decode one embedded 512 × 512 texture, and hide/reload/dispose complete without page, console or rejected-network errors. This does not establish GPU reclamation, physical-device performance or natural acting. Matching full-export measurements and archive identity belong in `../ART_REVIEW.md` and `output/export-manifest.json` with all source hashes verified.

The reference still requires finer continuous feather flow, softer descending temple edges, eye/wing-joint finish and stronger overall likeness. No final art or publication approval is implied.

## Finish 02 retained color and crown refinement

Current status: **local refinement retained; full character and natural acting unaccepted**. Creative revision: `sculpt-04-finish-02-seam-safe-color`.

Root inspected all 40 comparisons against wing02, covering full/portrait, speech, listening and completed samples in front, three-quarter, profile and rear views. The throat staircase is removed and the shorter crown reads more compactly. The large pale head/crown artifacts from finish01 are gone. Independent review agrees with retention; faint horizontal temple dashes, isolated torso cuts, coarse wing joints, fine eye edges and overall finish remain open. Comparison archive SHA256: `7e23f81183edab49ea4c14dbc15254d29cc474ea8b2552342b827153b3ac81c3`.

Exact parity measures 27,543 vertices (+303 seam copies), 49,844 triangles (unchanged), fourteen bones, twelve clips, one material, one 512 × 512 texture and 167 parts. The two continuous layers duplicate 126 and 177 shared front/back vertices respectively. All 149,532 ordered triangle corners preserve skin bindings; all non-crown positions/normals, all 159 other part arrays/relative indices, rig, poses and all 168 clip tracks remain exact. The deterministic texture stores 1,048,576 decoded RGBA bytes; this is not a GPU allocation measurement.

The first exported reload exposed a lab CSP issue: ImageBitmapLoader's blob fetch was blocked, and the loader silently displayed the continuous layers without their map. That failed comparison is preserved in `finish02-glb-parity`, archive SHA256 `6a999c17d5a7cfd1b9d3f2e11ad4d09992c30571dc32a8582556b61137b345e7`. The local lab now permits its embedded blob fetch and rejects a GLB unless its one 512 × 512 color map actually decoded.

After correction, 40 procedural/reloaded captures show the same geometry and one texture in each mode. Eight full/portrait rest pairs are pixel-identical. The remaining twelve pairs differ at 0–10 pixels per image, at most one channel value; 31 pixels differ across all twenty pairs. No page/console/network errors were recorded. Hide, explicit reload and disposal complete in both modes. Matching source and helper are preserved in `finish02-glb-parity-fixed`, archive SHA256 `2ddabd3f42dcd61ebad801f2d18558a164f2555134d64628b5e529bd9b1b5bad`. Resource reclamation, physical-device performance and final motion are not established by these observations.

Full-export measurements and archive identity belong in `../ART_REVIEW.md` and the matching `output/export-manifest.json`; require all source hashes to match. This stable source record does not approve publication. The authoring/rejected-candidate records below remain history.

## Finish 02 authoring record — before comparison

Status: **unreviewed candidate**. Creative revision: `sculpt-04-finish-02-seam-safe-color`. Retained wing-02 is the exact baseline.

Finish01 removed the throat staircase, but actual front/side comparisons found new pale lines around the crown and upper head. Eight isolated renders showed the texture-only variant contains the lines while the crown-only variant does not. Triangles joining top-chart front UVs to bottom-chart back UVs interpolate through the pale throat region. The 40-frame comparison and 8-frame isolation are preserved, including matching source, in `finish01-comparison` (archive SHA256 `17d24d8a0da40e59c3c52b104847ff527f18e615729303bdbb6a28566e37430c`) and `finish01-isolation-comparison` (archive SHA256 `d5bfcc1787fd6637e9b92d3f578aeff85ca8c2491bfbf0997351611a21133b75`). Finish01 is rejected as-is.

Finish02 assigns a consistent mapping to each triangle. Front triangles project x/y; fully rear triangles sample the plain umber row. Only vertices shared by both mappings are duplicated, within their original two continuous parts. Ordered triangle positions, normals and skin inputs remain unchanged; the six crown geometries retain the shorter candidate ends. The same deterministic embedded 512 × 512 map, material and all clips remain. Actual counts, scoped parity, matching comparisons and exported appearance remain pending.

## Finish 01 rejected candidate history

Status: **unreviewed candidate**. Creative revision: `sculpt-04-finish-01-throat-color-crown`. Retained wing-02 is the exact baseline.

The unchanged throat contour is sampled into a deterministic 512 × 512 RGBA color chart. The two continuous body layers receive matching planar UVs and retain their scalar vertex-tone variation. All other parts sample a padded white patch and keep their original vertex colors. Rear vertices use the chart's plain umber row. The map uses sRGB-encoded bytes, sRGB interpretation, linear filtering, clamped wrapping, no mipmaps and no vertical flip. It is embedded as PNG in the GLB; no external texture fetch is introduced. Decoded RGBA storage is 1,048,576 bytes by arithmetic, not a measured GPU allocation.

Only the six crown pieces change positions and derived normals: their last two control points shorten the swept ends and reduce terminal rise. Roots, widths, depths, grids, tone values and Head binding remain. All other positions/normals, complete indices, skin bindings, rig, poses and clips are intended to remain exact; expected topology delta is zero. The texture replaces the old zero-texture contract with one bounded embedded texture, and viewer cleanup now disposes unique maps and closes unique bitmap images.

Matching visual comparisons, exact part parity, structural checks, procedural-versus-reloaded export appearance and full export are pending. No visible improvement, full-character acceptance or production publication is claimed by this authoring record.

## Wing 02 retained mesh-contact checkpoint

Current status: **local refinements reviewed; full character and natural state acting unaccepted**. Creative revision: `sculpt-04-wing-02-mesh-contact`.

Completed02 folds the primary fan across the upper breast; wing02 fits all 24 coverts to actual underform triangles and keeps the lower samples on that surface. Root inspected all 60 matching comparisons for each refinement. Independent rest, peak and portrait review agrees with wing02 retention. The dangling spur is removed, root and lateral edges are quieter, and sampled resting/raised outlines remain coherent. Fine seams, throat/lid finish, torso accents, crown shape, overall likeness and natural acting remain open.

Exact parity finds only 24 coverts changed relative to completed02; 143 parts, all indices, rig, poses, clips and palette remain exact. The completed02 comparison separately changes only one child-wing quaternion track. Counts remain 27,240 vertices, 49,844 triangles, fourteen bones and twelve clips. Completed02 comparison archive SHA256: `79e0594003517b7fd67c2045cbfdc15b6cd4e470901be272883819fd97bed969`; wing02 archive SHA256: `63bb502f34331496ac35949caf528ee7341989761394d69a2223264866f3d5a4`.

Full-export measurements and archive identity belong in `../ART_REVIEW.md` and a matching `output/export-manifest.json`; require every source hash to match. This stable source record does not approve publication.

## Rejected throat sampling experiments — fully reverted

Throat05 redistributed existing angular columns toward vertex-mask transitions. Exact parity limited changes to the two continuous layers, and all nine structural checks passed. Root nevertheless rejected all 30 rendered comparisons because new cap-row color streaks appeared below the beak and above the collar. Nine isolated-layer captures reproduced the bands in each individual layer, so layer intersection was not the leading cause. Throat06 restricted redistribution to Y=2.245–2.645 with smooth fades. Its 30 comparisons removed the cap streaks but left longer sharp steps along the lower diagonal boundary; this also failed visual retention.

Both experiments, their exact source/baselines and diagnostic receipts are preserved externally. Neither angular warp nor contact changes remain in this source. The original wing02 throat is restored exactly. Throat05 comparison archive SHA256: `4c8208359944232c9f2c6be219818d7698d82428e84ecc06b30dc6c215d7d11a`; throat06: `40862783654febfff8ef093d91132d13c531e1c79d5e18520ad3c4459d513143`. These failures establish that positive-density redistribution alone does not preserve a smooth interpolated boundary across rows; a later correction must keep samples aligned with the contour.

## Wing 02 retained comparison

Status: **retained source comparison; full character remains unaccepted**. Creative revision: `sculpt-04-wing-02-mesh-contact`. Root reviewed all 60 matching captures plus independent rest/peak/portrait views; parity and nine structural checks passed. The following construction record preserves authoring intent. The author inspected `wing-parts-debug/wing-parts-contact.png`: the pink row-2/column-3 covert forms the long square-ended spur. This pass changes only the 24 coverts and addresses both inaccurate support contact and the return to unfitted geometry below the lower pole.

The actual underform triangles are cached before append. Each covert sample casts a radial ray from the shifted centerline, using the nearest positive hit as support; the analytic inner surface is only a numerical fallback. Roots sit 0.002 inside that support, side margins blend toward it, and the attached rear surfaces extend inside it. Free ends retain the existing finite 0.00012 thickness release. Raw height below q=-0.84 is smoothly compressed toward -0.975 for every across sample, keeping the lower rings on the support; no original-distal-geometry blend remains.

Original grids, indices, tones, part names/order and bindings are retained; expected topology delta is **zero**. Underforms, primary01, other geometry, palettes, rig, poses and all clips—including completed02—remain unchanged. Root retained completed02 after 60 source captures and exact one-track parity; primary01 remains the last matching full export. Only the three assigned source files were edited using static reads/edits and existing image inspection, with no runtime, tests, Git, browser or export. Freeze for matching parity and actual review; contact, tip finish, intersections and final art remain unverified.

## Completed 02 retained comparison

Status: **retained source comparison; full character and natural acting remain unaccepted**. Creative revision: `sculpt-04-completed-02-breast-fold`. Root retained the candidate after all 60 source captures and exact one-track parity. The following authoring record predates that comparison: root selected coordinated pitch/roll after reviewing 96 external exploratory captures, where the vane faces read across the upper breast. Those exploratory previews alone were not source validation or final acting acceptance.

Only completed's `WingTipLeft` values at 0.20, 0.34, 0.48 and 0.64 seconds change, copied from `wing-fold-preview/fold0_30_-115-model.json`: `[45,5,-20]`, `[0,30,-115]`, `[3,28,-109]` and `[51,0,-8]`. All other keys/channels, shoulder motion, timestamps, duration, static poses, geometry, rig, materials and other clips remain unchanged. `atlas-model.mjs` changes only its revision header. Primary 01 remains the last matching full export.

Only the three assigned source files were edited using static reads/edits; no runtime, tests, browser, export or Git operation was run. Freeze for root's exact one-track parity, nine checks and all-phase source comparison. Intermediate body/junction contact, release and final acting quality remain unverified; full-character acceptance is unchanged.

## Primary 01 retained checkpoint

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
