# ATLAS actual-art review — 4 October 2026

## Eyelid03 refinement — latest full export, character still unaccepted

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
