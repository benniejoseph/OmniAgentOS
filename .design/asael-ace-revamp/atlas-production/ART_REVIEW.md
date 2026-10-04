# ATLAS actual-art review — 4 October 2026

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

The approved static concept portrait remains the web/native companion asset. Bounded web/native raster adapters are implemented without publishing this sculpt: 26 web adapter unit cases passed, the full native analyzer reported no issues, and all 37 companion cases passed. Root also passed nine Node geometry/lifecycle checks and three Python tool tests. The public metadata-only `awaiting-art-review` manifest keeps neutral delivery, with web `no-cache` revalidation. The full adapter web build passed before that final manifest/cache change; the later package remains pending. None of these checks accepts art or stands in for physical-device measurement.

No `--accept-reviewed` publication has occurred. A functional release may retain the approved portrait and working static fallback while final 3D creative delivery remains explicitly outstanding, as allowed by TASKS phase 2 and task 2.6. Do not mark final-model/state-performance tasks 0.5–0.6 or the whole revamp complete from this export.
