# ATLAS actual-art review — 5 October 2026 (IST)

## Wing-color01 — retained wing finish and verified matching full export

Root retains wing-color01 after reviewing all fifteen matched comparison sheets /
120 captures. Independent review of six comparison sheets and the selected
concept reference agrees: feather color is more coherent across the torso and
wing bases, especially in three-quarter, profile and raised-wing samples. The
gain is subtle at 256px. Root finds the 72/36px result neutral; the independent
72px comparison likewise adds no distracting texture. No new obvious wrap
banding or wing/body junction defect appears in the reviewed light, dark,
resting or posed samples. This is an incremental finish improvement, not final
character or continuous-motion approval.

Exact scope parity confines changes to UV/color attributes of the two folded-wing
underforms and 24 coverts. All attributes of the other 141 parts, including the
face, torso and sixteen primaries, remain exact FACE02. All positions, normals,
ordered indices, skin indices/weights, rig/binds, static poses, all twelve clips
and 168 tracks, material settings and complete atlas bytes are preserved. These
scope facts do not by themselves demonstrate appearance or motion quality.

The matching comparison archive is
`wing-color01-comparison/matching-source-baseline-and-captures.tar.gz`, SHA256
`222bf301d5a808487d27400f03a6cc9f87a5a353cb1f6afd3ea98c85cffd364e`.
It binds fourteen sources, 120 captures and fifteen sheets. The retention
decision is recorded at `2026-10-04T23:34:34.884045+00:00` in
`wing-color01-comparison/decision.json`.

The matching full export completed at `2026-10-04T23:38:46.946533+00:00`. All nineteen source hashes, 104 artifacts, 33 raster delivery files and 237 archived members verify. The self-contained GLB is 2,969,088 bytes: 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 1024 × 1024 RGBA map, with zero external resources. Eleven model/lifecycle checks and ten lid-coverage checks pass. Full-export GLB comparison covers 72 captures / 36 pairs: 32 byte-exact and four differing by seven total pixels, maximum one channel byte. Root reviewed full, torso, raised-wing and closed-eye sheets; both modes pass hide/reload/dispose with no page/console/rejected-request errors. This verifies retention through export, not final character or continuous-motion acceptance.

Full archive: `atlas-wing-color01-review.tar.gz`, SHA256 `b40b163425a7f7cd678db9f5c33b2a02dd49080b6c97c55a02c864feae448c3a`. Verification receipt: `atlas-wing-color01-export-verification.json`. The nineteen source files now include the two standalone lid diagnostic files absent from the seventeen-source FACE02 export.

Final likeness, lid finish, natural acting, continuous attachment, small-size state readability, device performance and publication remain open. The approved static portrait/greeting remain active.

Next concrete art target: the sixteen primary vanes still read as flat, uniform
brown strips beside the textured coverts, clearest in the completed .34 front
and three-quarter samples. The selected reference has a more continuous feather
finish across that transition. A bounded feather-direction/taper shading pass
on those vanes, preserving geometry, rig and motion, should be compared at
256px and 72px. Retain only a visible normal-size improvement without distracting
small-size patterning; this recommendation does not imply that surface color
will resolve final silhouette or acting.

## Raised01 — rejected pose experiment; FACE02 restored at that checkpoint

Root and independent review rejected raised01 after 108 captures / eighteen
sheets. It demonstrated no contour or small-size readability benefit in front
or either 30-degree view and slightly weakened questioning asymmetry. No clear
new defect was identified. Closed and final-hold controls were pixel-identical;
those stills do not establish continuous-motion quality.

Only the left upper-lid `needs_you` keys at .34 and .48 seconds changed to
-16 degrees. Matching source, baseline, capture helper and all comparisons are
preserved in `raised01-comparison/matching-source-baseline-and-captures.tar.gz`,
SHA256 `21f7c106c3ae640e6f430f1c4be507df2eaed0a29e52fde0f7e0b3606ff4eeee`.
The rejection is recorded at `2026-10-04T23:17:43.690368+00:00`. All seventeen
FACE02 export-bound inputs were restored and verified after archival; the
narrower closed-highlight guard remains committed separately. No new full
model export or publication followed from this experiment.

## FACE03 — rejected upper-lid depth experiment; exact FACE02 restored

Root and independent review rejected the candidate after 78 matched captures /
thirteen sheets. The independent reviewer also inspected eighteen original
512-pixel captures. At `available` .12, new bright pinholes appear on both closed
upper caps in light and dark views: front near (199,128) and (313,128), and
three-quarter near (153,128) and (252,128). At raised `needs_you` .34, a new white
sliver appears along the upper eye contour. The intended reduction in lid bulk
is subtle and does not justify these defects.

All eleven candidate model checks and the two-part scope proof passed. These
checks did not catch the visible coverage defects; sampled vertex-only probes
are insufficient. The renders do not prove a source-level cause. Any future
upper-lid refinement must preserve triangle-interior coverage and raised/closing
pose coverage before retention, with matched visual review. This is a narrow
coverage requirement, not a claim that continuous motion is already certified.

The matching candidate source/baseline/render archive is
`face03-comparison/matching-source-and-baseline.tar.gz`, SHA256
`5949060f704f1efa3ca81a38770673231e389ea70663a1f826db2b943a354ce4`.
`face03-comparison/review-decision.json` records the rejection at
`2026-10-04T22:28:26.255756+00:00`. Root restored all seventeen export-bound
FACE02 source files exactly. FACE02 remained the retained complete export at
that checkpoint; no new full GLB export or publication followed from FACE03,
and final character/acting/device acceptance remained open.

## FACE02 — verified historical export predecessor, character still unaccepted

The FACE02 source is `sculpt-04-face-02-anchored-brows`. Root and independent visual review inspected all seventeen matched sheets / 102 images and retained its clearer neutral/listening integration. No new trench, detached tip or lid obstruction was seen in the sampled phases. The asymmetric crest remains readable, but the distinct eyebrow gesture is substantially quieter, especially at three-quarter. Wing-color01 preserves this brow refinement and its recorded expressive tradeoff.

Ten model checks and `/tmp/atlas-face02-parity.mjs` pass. Changes are confined to `neutral_brow_sweep_Left` and `neutral_brow_sweep_Right`; the other 165 parts, all ordered indices, the full atlas, rig/static poses and all 168 animation tracks remain exact FEATHER03. The existing topology is retained. Shallow broad ridges fit the actual retained head triangles, with fully Head-bound attachment borders and terminal rings blending toward Brow-bound centers. Only those two parts reuse the existing upper feather atlas; every image byte stays unchanged.

The nine bound comparison files are preserved in `face02-comparison/matching-source-and-baseline.tar.gz`, SHA256 `15966ef551dfda6b6ffa474e2def0a6bb5ffc750deb59aa317f165cc5a78157f`. Review includes neutral/listening/strongest-needs-you, blink/closed/completed, front/three-quarter/profile and 72/36-pixel samples. These stills do not prove continuous attachment or small-size `needs_you` readability. Existing bulky closed lids, final likeness, natural acting and device acceptance remain open.

The matching full export completed at `2026-10-04T22:10:08.914731+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 169 archive members verify in `atlas-face-02-export-verification.json`. The self-contained GLB is 2,969,076 bytes, retaining 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, 167 parts, one material and one embedded 1024 × 1024 RGBA8 map, with zero external resources. Ten FACE02 model checks passed. The unchanged static-tool scripts retained FEATHER02's ten passing checks; they were not rerun for FACE02.

Source/GLB parity covers 42 captures / 21 pairs across seven groups and three views. Fifteen pairs are pixel-identical. Listening differs by two pixels in each of three views; closed three-quarter differs by one; completed three-quarter by four and profile by ten. The summed difference is 21 pixels, at most one channel byte. Both modes pass hide/reload/dispose without page, console or rejected-request errors. These are bounded still and lifecycle observations, not continuous attachment, natural acting or performance acceptance.

The GLB comparison archive `face02-glb-parity/matching-source-and-baseline.tar.gz` has SHA256 `c95a062aee104efe36139d48025eaa43fc45bfe0faebd4e1f8a91a3e5f05c9d4`. Full archive `atlas-face-02-review.tar.gz` has SHA256 `5c51cca88d2df62d38b725ef9c1524532499249e2adecd35a0588aa6ae87508a`. Export-manifest SHA256 is `424b740d77b1da8531b84c7ce9cd57615edee99aa07b56db1d6b31da04a5e95a`; raster-manifest SHA256 is `1d5ecf746f98dd23999f3c573fc138f3f667af50beb6fea34bacad7e18e6fdea`.

FACE02 is the verified complete export predecessor to retained wing-color01, whose matching export is pending. FEATHER03 and earlier exports below are dated history. No final-art, continuous-motion, device-performance or publication acceptance is claimed; the approved static portrait/greeting remain active.

## FEATHER03 — historical torso-paint export at 21:45 UTC

The retained torso-vane refinement is exported as `sculpt-04-feather-03-short-vanes` at `2026-10-04T21:45:36.836138+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 166 archive members verify. The self-contained GLB is 2,969,080 bytes, retaining 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 1024 × 1024 RGBA8 PNG. Nine FEATHER03 model/lifecycle checks pass; the unchanged static-tool scripts retain their ten passing FEATHER02 checks.

Accepted stamp centers, directions and placement decisions stay exact. The painted torso vanes are 25% shorter and 18% broader with wider soft highlights and curved tips on the same selected minority. A smooth fade restores original paint over Y=1.90–2.02. Exact comparison preserves every mesh attribute, UV, part, index, rig, pose and all 168 tracks; only 298,806 lower-atlas pixels change. All full-width bytes in rows 480–1023, including head/throat/gutters/white patch, are identical to FEATHER02. Front/rear body image bytes match.

Root reviewed full, working/torso and completed sheets. Independent review inspected all twelve light/dark/large/small sheets and original torso views from four angles plus completed profiles. Both retain a modest improvement: chest and flank are less hair-like without visible hard scales, repeated rows, woodgrain loops or a below-collar transition. The gain is clearest close up and subtle at full-body scale; 36/72-pixel samples show no obvious new speckling or face-readability loss. Soft mottling, clearly layered feather relief, smooth-wing contrast, face/wing integration and final likeness remain open.

At the FEATHER03 checkpoint, twenty-four source/embedded-GLB captures covered full, working torso and completed in four views. All eight full/working pairs are pixel-identical. Completed front differs in six pixels by at most one channel value; the other three pairs are exact. Hide/reload/dispose passes with no page/console/rejected-network errors. These are bounded still and lifecycle observations, not motion, shimmer, performance or final-art acceptance. FEATHER02's broader 56-capture face/pose comparison and finish02's older 80-state review remain distinct historical evidence.

Comparison archive: `feather03-comparison/matching-source-and-baseline.tar.gz`, SHA256 `28a93ff1b23bb545cbade400b9991662801b6ae3467e29a027ab9137f15f69dc`. GLB archive: `feather03-glb-parity/matching-source-and-baseline.tar.gz`, SHA256 `8aa84168b5d61c3d7cd4345df2e098d5eacba6a6f08277a77a3d695c09fc129e`. Full archive: `atlas-feather-03-review.tar.gz`, SHA256 `a46db9540d3541c050cff22257ea4770f6692e10a78ab7e5665bc5edca1ea753`. Receipt: `atlas-feather-03-export-verification.json`. Export-manifest SHA256: `590ce12d1c6182c536b47f3b8b8ca866c2cb70a7c3794ff130ef79d15b5b61f4`; raster-manifest SHA256: `b34a1ace69c9fc717a2d9cc7938cf7227803bb03bd64f115fdc29ef02a44466a`.

This retained local refinement is not publication approval. The approved portrait/static greeting remain active. Final character finish, natural acting, physical-device acceptance and publication are pending.

## FACE01 and FEATHER02 — previous matching full export, character still unaccepted

The retained eye integration and angular feather-color pass are exported as `sculpt-04-feather-02-angular-color` at `2026-10-04T21:32:27.157894+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 163 archive members verify. The GLB is 2,985,740 bytes: 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 1024 × 1024 RGBA8 PNG. Nine model/lifecycle and ten static-tool checks pass. This is a local art checkpoint; the final character is unaccepted and unpublished.

FACE01 recesses the lower eye rims while preserving both contact rows and broadens/reduces the brow relief. Only four parts change position/normal attributes. Completed's two upper-lid tracks retain a coherent half-lidded settle at .48/.64/.78 seconds; the other 166 tracks remain exact. Seventy-two comparisons support local retention, including closed/half blink and four completed samples. Brows still have blunt medial ends and partly separate-looking relief; bounded stills do not prove timing or continuous collision.

FEATHER01 was rejected for curved woodgrain-like loops around the temple, shoulder and flank. FEATHER02 replaces planar X/Y mapping with a profile-relative half-circumference chart, including inversion of the squared front contour. Its original physical throat mask is evaluated after converting chart angle back to surface X. The deterministic tapered color motifs, sparse barbs and weak underpaint add head/throat/body detail. All FACE01 geometry, normals, scalar colors, indices, skin, rig, poses and 168 clip tracks are exact; only 46 mapped-part UVs and the color image change. The other 121 parts remain exact. The image changes 661,439 pixels against FACE01 and still decodes to 4,194,304 RGBA bytes.

Root and independent review retain FEATHER02 after 96 matched light/dark comparisons. The broad loops are removed, with no new obvious pale spill or hard atlas boundary in the reviewed samples. The pale boundary is visually retained, not pixel-identical. Fine texture is largely lost at 36 pixels and gives modest variation at 72 pixels. Torso strokes still look painterly/hair-like rather than layered feathers; smooth wing surfaces and long cheek/neck tuft lines remain finish work. Root inspected six sheets and original profile comparisons; the independent reviewer inspected all twelve sheets and selected originals.

The actual embedded-GLB comparison covers 56 captures, seven groups and 28 pairs. Eight rest pairs are pixel-identical; all posed differences total 39 pixels at maximum one channel value. Closed-eye and completed-hold samples are included. Hide/reload/dispose passes with no page/console/rejected-network errors. The raw helper inherited stale hardcoded 20-pair/40-capture summary values; the unchanged archived receipt and `count-correction.json` bind all 56 hashed captures and 28 comparison rows. Future helper counts derive from the arrays. These observations do not certify shimmer, natural acting, physical performance or final art acceptance.

Comparison archives: `face01-comparison/matching-source-and-baseline.tar.gz` SHA256 `2cc6f8d412d46befd84a48eb07540dd7bc1431d3c4846f6fdec54413aa2fc5f2`; `feather02-comparison/matching-source-and-baseline.tar.gz` SHA256 `0a27626b37ba4267ca04ee22d9b4c2909124ac269eddebf1368b1b5e746ff0c1`; `feather02-glb-parity/matching-source-and-baseline.tar.gz` SHA256 `7a76f0de3795ece4ee447b168151f148840e5d840738cc8d8d22f332d2135b2c`.

Full archive: `atlas-feather-02-review.tar.gz` SHA256 `42a6653c7d0d45f6ce5bd6110b4404812e14d9cd3fbe1fc4df284f379d122910`. Receipt: `atlas-feather-02-export-verification.json`. Export-manifest SHA256: `a640792086fa974e46e6728ee53525e3bbd2ab8e0831052600acf42f5a7561f8`; raster-manifest SHA256: `a18049126eadf73071939585d440478b553b3815451e604c7cee16b50f977725`. Final layered plumage, stronger likeness, wing/face integration, natural acting, device acceptance and publication remain open. The approved portrait/static greeting remain active.

## Grain02 — previous matching full export, character still unaccepted

The retained subtle body-grain pass is exported as `sculpt-04-grain-02-continuous-color` at `2026-10-04T20:49:56.541894+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 156 archive members are verified. The GLB is 2,494,008 bytes, with 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 1024 × 1024 RGBA8 PNG. There are no external image or buffer resources. Nine model/lifecycle and ten static-tool checks pass.

The deterministic color field adds quiet variation across the torso and its 44 body tufts. Exact comparison confirms all positions, normals, indices, skin bindings, rig, poses, clips, original tuft scalar tones and 121 other parts remain unchanged. Only the two continuous layers and 44 tufts change UVs; only those tufts change stored color representation. The old 480 × 480 throat chart is preserved exactly in the larger atlas, and front/rear body fields match byte-for-byte.

Root and independent review retain this modest improvement after 64 comparisons: full, portrait, torso, working, completed and native 36/72-pixel samples in four views. It has little visible benefit at the smallest sizes and still falls short of the reference's feather density. A contact-sheet impression of sharper throat edges was withdrawn after matched original PNG/crop review. Protected head/throat regions differ by at most one channel value in 26/67/187/226 pixels across front/three-quarter/profile/rear. Existing edge coarseness remains. Confirm suspected edge regressions in original matched pixels before changing the source.

The before/after archive is `grain02-comparison/matching-source-and-baseline.tar.gz`, SHA256 `fc6f62d88f11d1c5f63a991d78c0fcaac140da16bf4b7f33667412abbea9bd02`. The regional correction proof is `grain02-protected-region-review.tar.gz`, SHA256 `cb58db97b485dedb4b096bbd8fb67494f3824ecd631900589cf4724c06b49444`.

Forty procedural/GLB captures show eight pixel-identical rest pairs and twelve posed pairs differing at 0–10 pixels each by at most one channel value (31 pixels total). One 1024px map decodes in both modes; hide, explicit reload and disposal pass with no page/console/rejected-network errors. Matching GLB comparison archive SHA256: `cdfd1fa8da0ea4bc75d3b29d677dc1dc51aa95973689e83ada6429bccda39705`.

Decoded RGBA storage rises from 1,048,576 to 4,194,304 bytes; GLB size rises by 172,204 bytes. These are storage facts, not measured GPU allocation or performance. Small-size motion shimmer, grazing-angle motion, physical responsiveness and natural acting are unmeasured. The old eighty-state still review belongs to finish02 and was not repeated.

Full archive: `atlas-grain-02-review.tar.gz`, SHA256 `0481b753a17762d02aa5710e5f4bcbd53f4a83a9c205d86699e0e71747fb0669`. Receipt: `atlas-grain-02-export-verification.json`. Export-manifest SHA256: `5bb5c5f88d453e83eb370ee04df545a512f28d13929990a2c4381fe1571dde12`; raster-manifest SHA256: `f3958e1e371eea06c12dd923b81d357590ec8093ed5f6f5ce97fc6813012d55a`.

Final fine feather layering, temple and eye edges, wing junctions, stronger likeness, natural acting, device acceptance and publication remain open. The approved portrait/static greeting remain active; this local retention is not final art approval.

## Finish03 — previous matching full export, character still unaccepted

The retained body-surface and texture-padding refinement is exported as `sculpt-04-finish-03-padded-color-chart` at `2026-10-04T20:32:41.680641+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 152 archive members were verified. The GLB is 2,321,804 bytes, with 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 512 × 512 RGBA8 PNG. There are no external image or buffer resources. Nine final model/lifecycle checks pass; unchanged static-tool coverage last passed at finish02.

Forty body comparisons support retaining the shallower, settling relief of 44 breast/mantle tufts. Raised droplets and long cuts are quieter; no new outline/rear gap is observed. The four temple tufts remain unchanged. An eighteen-capture omission experiment showed their descending cheek edges are separate from the horizontal pale line. A second eighteen-capture experiment changed only texture padding and removed that horizontal line across portrait, listening and completed views. Root and independent review retain umber margins around the existing chart, with the separate white sample patch preserved.

Exact comparison against finish02 confirms zero topology delta. Only positions/normals in those 44 parts and 31,488 padding pixels change; all other 123 parts, complete indices, colors, UVs, skin indices/weights, chart interior, white patch, rig, poses, palette and clips remain exact. Nine structure/lifecycle checks include the texture filter-footprint regression. Matching body and padding archives are `body02-comparison` (SHA256 `71f78247d16631c32907e0422511cb6209542221a822dbd8cd7b09d0bc2c0d1b`) and `padding-isolation-comparison` (SHA256 `0293e94d73ed1aa4425cd95f62a8872415e6f10e0e2c4f5cb9c446cfbf89db32`).

Forty source/export captures preserve the decoded texture and visible appearance. Eight rest pairs are pixel-identical; twelve posed pairs differ at 0–10 pixels per image by at most one channel value (31 differing pixels total). Hide, explicit reload and disposal succeed without page/console/rejected-network errors. Visual review of all five sheets finds no source/export mismatch. Matching GLB comparison archive SHA256: `6f6acdab617f561afe915006c8f65b76316c5dcd4569af9ef1c2d22068f7280a`. These are bounded still/lifecycle observations; the older eighty-state-sample review belongs to finish02 and was not repeated.

Full archive: `atlas-finish-03-review.tar.gz`, SHA256 `179fa4c55775942d0c7e04bd2701a38f96f618b7091a253ea8027d2d30cedbb7`. Receipt: `atlas-finish-03-export-verification.json`. Export-manifest SHA256: `fe1a30d2fda61a494ece550312476d4b7c7403c36ebb32044a3a3e84ebf535ff`; raster-manifest SHA256: `f0cacea831488baf3a12ef3904c8a8cbf92118c4a8199cacbf76344ebe9daa9e`.

The head/body remain too smooth between isolated feather accents. Descending temple edges, eye detail, coarse wing junctions, stronger reference likeness and natural acting remain pending, along with delivery-size/device performance and publication. The approved neutral portrait/static greeting remain active. This retained refinement is not final art approval.

## Finish02 — previous matching full export, character still unaccepted

The retained color/crown refinement is exported as `sculpt-04-finish-02-seam-safe-color` at `2026-10-04T20:07:57.362206+00:00`. All seventeen source hashes, 104 artifact hashes/byte lengths and 146 archive members were verified. The GLB is 2,321,804 bytes, with 27,543 vertices, 49,844 triangles, fourteen bones, twelve clips, one material and one embedded 512 × 512 RGBA8 PNG. There are no external image or buffer resources. Nine final model/lifecycle checks and nine static-tool tests pass.

The throat staircase is removed by a deterministic color texture. Six crown ends are shorter. Front/back texture seams duplicate 303 vertices, preserving every ordered triangle and skin binding outside the declared crown geometry change. The other 159 parts, rig, poses and all 168 clip tracks remain exact. Root reviewed forty matching wing02 comparisons; independent review agrees with local retention. Fine temple dashes, torso cuts, eye edges, wing-joint finish, overall likeness and natural acting remain open.

Finish01 was rejected for bright crown/head lines. Eight isolation captures confirmed texture interpolation caused them. Finish02's triangle-consistent mapping removes the large lines. Comparison archive: `finish02-comparison/matching-source-and-baseline.tar.gz`, SHA256 `7e23f81183edab49ea4c14dbc15254d29cc474ea8b2552342b827153b3ac81c3`.

An actual exported reload also caught a blocked local blob fetch that silently omitted the color map. The lab CSP now admits its embedded image fetch, and GLB loading fails unless the one 512 × 512 map decoded. The failed diagnostic is preserved in `finish02-glb-parity`. Forty corrected procedural/reloaded captures contain one texture in each mode: eight rest pairs are pixel-identical; twelve posed pairs differ at 0–10 pixels each by at most one channel value (31 differing pixels total). No page, console or network errors were recorded. Hide, reload and disposal complete in both modes; actual allocation reclamation remains unmeasured. Corrected comparison archive SHA256: `2ddabd3f42dcd61ebad801f2d18558a164f2555134d64628b5e529bd9b1b5bad`.

Root inspected eighty exported state samples across all eight states and both themes. The smooth throat remains, with no new large pale head/crown breakthrough in those frames; the completed fold/return remains coherent. These stills do not establish motion quality, delivery-size or physical-device acceptance. Matching sprite archive: `finish02-state-review/matching-source-and-baseline.tar.gz`, SHA256 `dee010d2abde804667543cd5f3b71835522e4f54cd197cbd382ddfae16f798b0`.

Full archive: `atlas-finish-02-review.tar.gz`, SHA256 `3c9f954a2d0bbd8c179e447c30214bf17af5fc5c697bf859d72fddc00d47520a`. Receipt: `atlas-finish-02-export-verification.json`. Export-manifest SHA256: `6932d66e120c84b62000b4dc44664389d029cf564b3c4a4f3c3629a51af1a5e1`; raster-manifest SHA256: `3c84431f9f5256122bef5f975fcc5e0844c8c90bbcb8af9ee690a9b3cf27893d`.

This is a retained local art checkpoint. The final character remains unaccepted and unpublished; the approved portrait/static greeting remain active. The previous checkpoints below are history.

## Wing02 — previous matching full export

The retained breast-fold trajectory and actual-mesh covert fitting are exported
together as `sculpt-04-wing-02-mesh-contact` at
`2026-10-04T19:37:43.326236+00:00`. The export contains 104 artifacts, 27,240
vertices, 49,844 triangles, fourteen bones, twelve clips and a 2,039,724-byte GLB.
All nine final structure/lifecycle checks pass. All seventeen source hashes and
all 104 artifact hashes/byte lengths match; all 139 archive members were reread
and verified.

Full source/output archive: `atlas-wing-02-review.tar.gz`, SHA256
`ac287508e845048e901edd734a8291d49b5abcbad51c3d2e561380c945027a32`.
Receipt: `atlas-wing-02-export-verification.json`. Export-manifest SHA256:
`8096da6653d3e2a22596343e895d6d50b49e4a2aaf8075a6e5a15e047962af3c`;
raster-manifest SHA256:
`4a1b1d1da6123eed178f48f555187f991dd41575b9c053da37f163ef9d05b922`.

Root also inspected eighty sampled exported frames covering all eight states in
both themes. The sampled wing fold and return stay coherent, with no new large
detached part visible. These still samples do not establish natural motion,
delivery-size readability or physical performance. Matching sprite evidence is
preserved in `wing02-state-review/matching-source-and-baseline.tar.gz`, SHA256
`c6041644b6492cda2296e269d5ed905fb02c9cb658ebbef580912567ba066fed`.

Two subsequent throat sampling experiments were visually rejected and fully
reverted before this export. Throat/lid edges, isolated torso accents, pointed
crown feathers, overall finish/likeness and natural state acting remain open.
The full character remains unaccepted and unpublished; the approved portrait
and static greeting stay active in the application.

## Throat05 and throat06 — rejected experiments, original throat restored

Both candidates passed exact two-part parity with zero topology or weight
changes. Throat05 also passed all nine structural checks. Root rejected its 30
comparisons because new horizontal color streaks appeared below the beak and
above the collar. Nine isolated-layer captures reproduced the bands in each
layer independently, contradicting the initial intersection hypothesis.

Throat06 restricted angular redistribution to the middle neck. Its 30 comparisons
removed the cap bands but produced longer sharp steps along the lower diagonal
boundary. That was not a sufficient improvement to retain. Both candidates and
their diagnostics are archived externally; all executable source/configuration
has been verified restored to retained wing02, apart from review metadata.

Throat05 comparison archive SHA256:
`4c8208359944232c9f2c6be219818d7698d82428e84ecc06b30dc6c215d7d11a`;
throat06 comparison archive SHA256:
`40862783654febfff8ef093d91132d13c531e1c79d5e18520ad3c4459d513143`.
The isolated throat05-layer archive SHA256 is
`f1e746b4d6582788a1d720e57ef2ca1fa0f284fac6529cac24e92399486dab3e`.
A later boundary correction must preserve contour alignment between rows;
positive sampling density alone did not do that.

## Wing02 comparison — retained mesh contact, full character unaccepted

Root inspected all 60 comparisons against the exact retained completed02 source
and configuration: nine completed-motion phases in three angles, plus peak
portraits. Fitting the 24 coverts to actual underform triangles removes the long
dangling spur and reduces exposed roots and stepped lateral edges. The resting
outline, raised joint and return remain coherent in these samples. Fine seams,
overall feather finish and natural all-state acting still need review.

All nine structure/lifecycle checks pass. Exact part parity finds only the 24
coverts changed; the other 143 parts, complete indices, rig, poses, clips and
palette remain identical. Counts remain 27,240 vertices and 49,844 triangles.
Matching source, baseline and capture helper are preserved in
`wing02-comparison/matching-source-and-baseline.tar.gz`, SHA256
`63bb502f34331496ac35949caf528ee7341989761394d69a2223264866f3d5a4`.
Primary01 remains the latest full export at this comparison checkpoint. This
retains a local refinement; it does not establish full-character acceptance.

## Completed02 comparison — retained breast fold, full character unaccepted

Root first inspected 96 external configuration-preview captures. Z-only sweeps
left the vanes dark and edge-on; the selected coordinated child rotation brings
their broad faces diagonally across the upper breast. Those exploratory configs
are preserved under `wing-sweep-preview` and `wing-fold-preview` and are distinct
from the authored source comparison.

All 60 authored-source comparison captures were then inspected: rest, clearance,
folding, peak, settle, unfolding, release, lowering and held pose in three angles,
plus peak portraits. The new fold replaces the downward hanging fan while
preserving shoulder clearance and return to rest. No new large collision appears
in these samples. Coarse upper-wing tabs, joint edges, final feather/face finish
and natural all-state acting remain open; this is a retained local refinement.

All nine structure checks pass. Exact parity verifies that only the completed
`WingTipLeft.quaternion` track changes. Geometry, all timestamps/durations,
static poses, rig, palette, the other thirteen completed tracks and the other
eleven clips remain identical to primary01. Counts remain 27,240 vertices,
49,844 triangles, fourteen bones and twelve clips. The matching comparison
archive is `completed02-comparison/matching-source-and-baseline.tar.gz`, SHA256
`79e0594003517b7fd67c2045cbfdc15b6cd4e470901be272883819fd97bed969`.
Primary01 remains the latest full export at this comparison checkpoint; no
publication or device/performance acceptance follows.

## Primary01 — previous matching full export, character still unaccepted

The compact overlapping primary fan is retained after root inspected all 48
comparison captures against the completed01 GLB: seven completed-motion phases
in three angles plus peak portraits. The shorter overlapping vanes replace the
separated strips and improve the resting and raised-wing outline. No new large
joint gap appears in these samples. An independent review of rest, peak and peak
portraits found no visible regression preventing local retention.

The current matching export is `sculpt-04-primary-01-overlapping-fan`, completed
at `2026-10-04T18:55:02.119850+00:00`: 104 artifacts, 27,240 vertices, 49,844
triangles, fourteen bones, twelve clips and a 2,039,712-byte GLB. All nine
structure/lifecycle checks pass. Exact parity finds only sixteen primary parts
changed; the other 151 parts, complete indices, rig, poses, clips and palette
remain identical. All seventeen source hashes and all 104 artifact hashes/byte
lengths match; all 129 archive members were reread and verified.

Full source/output archive: `atlas-primary-01-review.tar.gz`, SHA256
`4e6f41976e761ea0cb92b135b77c4f96275c17da63682de826dbeb623e036f99`.
The receipt is `atlas-primary-01-export-verification.json` in the release evidence
directory. Export-manifest SHA256:
`7c8edd39f0914824956523fa9920977daeb82c3564736682c69e524d6263923a`;
raster-manifest SHA256:
`a39d4798ad2d3312f63e008d2730f837ab4b0ae35ceaa0b914eb3d36092ec3f6`.
The pre-export comparison has its own bound source/baseline archive at
`primary01-comparison/matching-source-and-baseline.tar.gz`, SHA256
`9255860ff9b93e3e3f075d9f3a7a3880279d7ddb0bb284868112837fb598e5da`.

The highest-priority remaining art issue is the mechanical transition between
the forward covert mass and downward fan during the gesture, including exposed
square tabs and hard layered edges. Fine throat/lid edges, overall likeness and
feather finish, all-state acting, delivery-size readability and physical-device
performance remain open. This is retained local progress; the complete character
is unaccepted and unpublished. The approved portrait/static greeting stay active.

## Completed01 — previous matching full export, character still unaccepted

The retained body-tuft, shallow-grain, fitted-wing, temporal-lid and completed
trajectory refinements are now exported together as
`sculpt-04-completed-01-forward-clearance`. The matching export completed at
`2026-10-04T18:41:03.423334+00:00`: 104 artifacts, 27,240 vertices, 49,844 triangles,
fourteen bones, twelve clips and a 2,039,716-byte GLB. All nine final structure
checks pass. All seventeen source hashes and all 104 artifact hashes/byte counts
match. Source, output, reference and review helpers are preserved in
`atlas-completed-01-review.tar.gz`; verification is recorded in
`atlas-completed-01-export-verification.json` in the release evidence directory.

The export-manifest SHA256 is
`ebba096e6d27382fc1c8244df9340f0deaaa57f12150e3450e8b0f4c33914fb8`;
the raster-manifest SHA256 is
`6453dfee0b275ca44f778a7a44c8e935485bbc5ded8c2e61f4904913ddf87376`.

Actual comparisons support the local improvements described below. Long parallel
primary feathers, the covert/primary junction, fine throat and lid edges, overall
finish and natural all-state acting still prevent final art acceptance. Small
delivery-size review and physical-device performance also remain open. No
`--accept-reviewed` publication, production migration or deployment occurred.
The approved concept portrait/static greeting remain the application artwork.

## Completed01 comparison — retained forward clearance, final acting open

Root inspected all 48 comparison captures at rest, clearance, peak, settle,
release, lowering and the final held pose in three angles, plus peak portraits.
The baseline used identical current geometry and the exact prior eyelid04
configuration. The moving wing now visibly clears the torso and returns to its
resting side. The long parallel primaries and coarse covert/primary junction are
more exposed; final feather integration and natural acting remain unaccepted.

All nine structure/lifecycle checks pass. Geometry is byte-identical to eyelid04
at 27,240 vertices and 49,844 triangles, with fourteen bones and twelve clips.
The other eleven clips are identical. Across 2,172 non-wing quaternion samples,
maximum component difference is 4.246830940246582e-7. Source, exact baseline
configuration, capture script and receipt are preserved in
`completed01-comparison/matching-source-and-baseline.tar.gz`. These samples do
not certify every intermediate collision or all-state acting. No bundle is
published; the next full-export receipt will be recorded above this comparison.

## Eyelid04 comparison — retained temporal return, final finish open

Root inspected all 24 matching rest, closing, closed and opening captures in
front, three-quarter and profile. The large white wedge visible through the
closed profile lid is now covered. Neutral irises remain readable; the sampled
intermediate views do not show a new large breakthrough. Fine edge specks and
the overall lid shape still need finishing, so this does not establish complete
blink or character acceptance.

All nine structure/lifecycle checks pass. Exact comparison against wing01 finds
only the two upper-lid seams changed; the other 165 parts and their topology,
rig, poses, clips and palette remain identical. The added curved return totals
50 vertices and 96 triangles: the current rendered model has 27,240 vertices,
49,844 triangles and fourteen bones. Source, eyelid03 baseline GLB and receipt
are archived in `eyelid04-comparison/matching-source-and-baseline.tar.gz`.
Eyelid03 remains the latest full export at this comparison checkpoint. No
art/state bundle has been published.

## Wing01 comparison — retained fitted coverts, acting still unaccepted

Root inspected all 38 matching captures, including rest, speech, listening,
the held completed pose, and completed motion at .17s and its .34s peak. The
exposed square shoulder tabs are removed, the coverts wrap around the supporting
volume, and the resting outline is more continuous. At the completed peak,
the moving wing still becomes substantially buried in the torso; the original
motion already had this problem. Long parallel primary feathers, overall feather
finish and convincing state acting remain open. This is a retained local shape
improvement, not final wing or character acceptance.

All nine structure/lifecycle checks pass. Exact comparison against grain01 finds
only the 24 coverts and two underforms changed; the other 141 parts, all indices,
rig, poses, clips and palette remain identical. Both rendered models have 27,190
vertices, 49,748 triangles and fourteen bones. Matching source, baseline GLB,
capture script and receipt are preserved in
`wing01-comparison/matching-source-and-baseline.tar.gz`. Eyelid03 remains the
latest full export. No state bundle is published.

## Grain01 comparison — retained shallow finish, no full export yet

Root inspected all 22 matching full-body, portrait, speech and held-gesture
captures. The regular neck/throat bars are visibly quieter after replacing the
sharp repeating relief with shallow staggered grain. The sampled views show no
new throat holes or detached tufts. Fine throat-edge stepping, pointed tuft tips,
wing-root tabs/oval underforms and the profile blink gap remain unaccepted.

All nine structure/lifecycle checks pass. Exact comparison against tuft01 finds
only the shell and its 44 fitted body tufts changed; the other 122 parts, complete
indices, rig, poses, clips and palette remain identical. The render count remains
27,190 vertices, 49,748 triangles and fourteen bones. Matching source, eyelid03
baseline GLB and receipt are archived in
`grain01-comparison/matching-source-and-baseline.tar.gz`. This is a retained local
improvement, not full-export, performance or final art acceptance. Eyelid03 is
still the latest full export. Nothing has been published.

## Tuft01 comparison — retained local improvement, no full export yet

Root inspected all 22 matching full-body, portrait, speech and held-gesture
comparison captures against eyelid03. The broad rectangular chest/mantle roots
are replaced by tufts that follow the body surface. Pointed lower ridges and
coarse feather finish remain; wing-root tabs, oval underforms, periodic shell
ribbing, the profile blink gap and fine throat boundary still prevent final
character acceptance.

All nine structure/lifecycle checks pass. Exact source comparison verifies that
only the 44 breast/mantle parts change; the other 123 parts, complete indices,
rig, poses, clips and palette are identical. Both rendered models measure 27,190
vertices, 49,748 triangles and fourteen bones. This is comparison evidence, not
a new full-export or performance result. Matching source, baseline GLB and
receipt are archived in `tuft01-comparison/matching-source-and-baseline.tar.gz`
within the release evidence directory. Eyelid03 remains the latest full export.
No artwork has been published.

## Eyelid03 refinement — previous matching full export

Root inspected actual neutral, mid-blink and peak-closure front, three-quarter
and profile portraits. The revised hinges, fitted rim and interior clearance
reduce the forward bulge and remove frontal white breakthroughs. The neutral
iris remains legible. A thin outer white seam and profile gap remain, so full
blink coverage is not accepted. Body panels, wing integration, regular feather
ribbing and fine throat-edge quality also remain open.

The matching full export contains 104 artifacts, 27,190 vertices, 49,748 triangles,
fourteen bones, twelve clips and a 2,035,216-byte GLB, exported at
`2026-10-04T18:03:14.083731+00:00`. All nine structure/lifecycle checks pass.
Matching source/output are archived as `atlas-eyelid-03-review.tar.gz`. All
seventeen source hashes match the export. The counts equal throat04; the source,
skin weights and rendered frames differ. No art/state bundle is published.

PR57 is accepted at `76a2230e911d1d8436c731fc965f53037b5dadd6` after all fourteen
applicable hosted checks passed. It merged at 17:57:33 UTC as
`79386e2694a39cb01d5948f1fbbc6e06513105cf`; expanded Voice now shares bounded
playback while the public manifest continues to select the neutral fallback.
Software acceptance does not accept this prototype artwork.

## Throat04 refinement — previous retained export

Root inspected matching front, three-quarter, profile and listening portraits.
The coarse stepped color boundary is substantially finer; the holes and detached
strips remain absent. Fine edge stepping, feather finish, body integration and
convincing eyelid closure still prevent final character acceptance.

The matching full export has 104 artifacts, 27,190 vertices, 49,748 triangles,
fourteen bones, twelve clips and a 2,035,216-byte GLB. All nine structure/lifecycle
checks pass. Export time is `2026-10-04T17:30:25.836966+00:00`; matching source and
output are preserved in `atlas-throat-04-review.tar.gz`. This was the matching full
export at that checkpoint, with beak02 retained in its geometry. Later eyelid source changes require
matching renders and must not borrow this export's measurements. No state bundle
has been published.

## Throat03 comparison — unaccepted

Root inspected the matching front, three-quarter, profile and listening renders.
Removing the separate pale sheet resolved the visible holes and detached strips,
but the color boundary is now a coarse staircase along the cheek and diagonal
throat edge. This revision is not accepted. Its matching source and beak02
baseline are archived in `throat03-comparison/matching-source-and-baseline.tar.gz`
within the release evidence directory. Throat04 was the next narrow sampling correction; its completed export is
recorded above and does not imply publication.

The UI, static greeting and personality release are accepted through PR54–56.
All 16 hosted checks passed for PR56 at `a3fb4215b632f8b6d56487e3617b0afb82085aba`;
merge `fe36089bc409e79e5fc267a277a65cb2605c3ee0` completed at 17:24:06 UTC.
Private Mac 1.23.15 (50) is verified. These software releases do not establish
final 3D art or physical-device acceptance.

## Beak02 refinement — retained, full character still unaccepted

Root compared 18 actual full-body, portrait and speech-test captures of
`sculpt-04-beak-02-curved-hook-jaw-contact` with the sculpt04 baseline and approved
reference. The beak now has shaped mouth corners, a continuous hook in profile
and a closed resting jaw seam. This is a visible local improvement over the flat
diamond and separated mandible in the preceding render. The pale angular throat,
feather finish, attached body volumes and eyelid closure still prevent final
character acceptance. Selected speech samples do not certify collision-free
motion or audio alignment.

The matching full export contains 104 artifacts, 23,314 vertices, 41,700 triangles,
14 bones, 12 clips and a 1,754,824-byte GLB. All nine structural/lifecycle checks
passed. Matching source and output are archived as `atlas-beak-02-review.tar.gz`
in the release evidence directory. Narrow later throat source revisions require
their own matching renders; they must not borrow this export's measurements.
No 3D/state bundle has been published.

The UI and static full-body greeting are accepted through PR54 and PR55, with
private Mac package 1.23.14 (49) ready. Those releases use approved concept images
and do not establish final 3D or physical-device acceptance.

## Previous sculpt-04 review

**Sculpt-04 improves the rough prototype but remains unaccepted for publication.**
Root inspected the actual front, three-quarter, profile and blink sequence beside
the approved reference. The shorter throat, larger iris and quieter chest are
visible improvements. The pale field is still an angular bib; wing and thigh
volumes read as attached ovals, the side silhouette is tubular, and the feather
finish remains faceted. The front beak needs more convincing volume. Closing lids
bulge away from the face and retain a pale rim. These issues need a deliberate
topology/material pass rather than acceptance based on feature names or palette.

The matching sculpt-04 export has 104 artifacts, 23,254 vertices, 41,580 triangles,
14 bones, 12 clips and a 1,750,516-byte GLB. All nine geometry/lifecycle checks pass,
including semantic eyelid/mandible deformation checks at their original movement
thresholds. Actual source and output are archived as `atlas-sculpt-04-review.tar.gz`.
The transparent sprite's RGB values outside the character are not opacity;
sampled background alpha is zero. No character bundle was published or deployed.
The current UI keeps the approved concept portrait while final art remains open.

## Previous sculpt-03 review

**Sculpt-03 is also unaccepted for publication.** Root rendered and inspected the
actual front and three-quarter views beside the approved concept. The continuous
anatomy and integrated eyelids improve the construction, but the pale throat still
reads as a long rectangular beard, the collar as a horizontal ring, and the large
uniform feathers as tiled leaves. The neck is too narrow relative to the shoulders;
eyes and feet are too small. The golden beak needs stronger volume and hook from
the front. These are visible likeness gaps, not only missing validation.

The exact sculpt-03 export contains 104 artifacts. Its GLB measures 1,786,956 bytes,
23,436 vertices and 43,642 triangles, with 14 bones and 12 clips. Source and matching
output are archived as `atlas-sculpt-03-review.tar.gz` in the release evidence
directory. Seven of nine geometry/lifecycle checks passed; two topology-specific
deformation checks need to select the new eyelid and mandible vertices correctly.
Neither that test adjustment nor successful structural export will accept the art.
The next source pass is in progress; the approved neutral portrait remains active.

## Previous sculpt-02 review

**Sculpt-02 is insufficient for final likeness and is not accepted for publication.** Root inspected actual output from creative revision `sculpt-02-eyelids-layered-plumage-eight-states` against the approved original eagle reference. The export completed; its 104 artifacts, 14 bones and 12 clips establish an authored construction and delivery candidate, not an approved character.

The current rendered model still differs materially from the study:

- The neck is elongated and too thin, weakening the compact head-to-body silhouette.
- The pale throat hangs like a dangling beard instead of flowing into the throat/chest and collar.
- The eyes read as circular orbital rings/socket forms rather than recessed expressive eyes with integrated eyelids and brows.
- The overlapping plumage reads as flat scales rather than swept, tapered feather volumes.
- Crown and feet remain visibly primitive; the expanded view exposes the construction rather than the intended character finish.

Retaining the umber/pale/gold palette, hooked beak and collar is not enough to establish likeness. The newly authored eyelids and feather layers do not resolve these issues merely because they exist in source. The next creative pass needs to correct actual silhouette, throat/collar continuity, facial planes and dimensional feather forms, then compare front/profile/three-quarter renders and small portraits with the reference. No source or geometry change is implied by this review record.

All eight application-state clips are authored, alongside four retained inspection aliases. Their shape, naming and bounded timings are implementation evidence only. Natural expressive acting, small/expanded readability and lack of expression drift remain unaccepted; the synthetic beak test is not audio-aligned speech.

The previous rough-01 review also found protruding eyes, a stern brow, spike-like side feathers and primitive body/wing/collar forms. Its output and measurements are preserved in `/Volumes/Extreme Pro/Asael-release-records/2026-10-03-followups/ui-validation/atlas-rough-01-output.tar.gz`; those findings and measurements belong to that older revision.

At the sculpt-02 checkpoint, the approved static concept portrait remained the web/native companion asset. Bounded web/native raster adapters were implemented without publishing that sculpt: 26 web adapter unit cases passed, the full native analyzer reported no issues, and all 37 companion cases passed. Root also passed nine Node geometry/lifecycle checks and three Python tool tests. The public metadata-only `awaiting-art-review` manifest kept neutral delivery, with web `no-cache` revalidation. The full adapter web build passed before that final manifest/cache change; later private packages and their release acceptance are recorded above. None of these checks accepts art or stands in for physical-device measurement.

No `--accept-reviewed` publication has occurred. A functional release may retain the approved portrait and working static fallback while final 3D creative delivery remains explicitly outstanding, as allowed by TASKS phase 2 and task 2.6. Do not mark final-model/state-performance tasks 0.5–0.6 or the whole revamp complete from this export.
