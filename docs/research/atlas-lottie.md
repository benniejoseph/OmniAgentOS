# ATLAS vector companion

Research and implementation direction: 7 October 2026. The owner's replacement
request supersedes the historical eagle/raster studies. The subsequent request
for a **new recognizable animated mascot**, informed by LottieFiles, also
supersedes the first compass/orbit design. `DESIGN.md` and the existing shared
theme remain the design authority.

## Format research

Lottie describes animation as JSON and renders it at runtime. The official web
player accepts animation data, supports SVG rendering, and exposes explicit
play, pause, stop, frame seeking, segment, completion, and disposal controls.
`setSubframe(false)` follows the composition's authored frame rate. These APIs
support a short state reaction without an ambient animation loop.
[Official lottie-web documentation](https://github.com/airbnb/lottie-web)

Renderer features are not identical. The official compatibility table supports
basic shapes, ellipses, fills, strokes, and transforms across the relevant
renderers; masks, expressions, 3D and effects have more restrictions. ATLAS
therefore uses only ordinary vector shape layers and transform keyframes. It has
no raster/image assets, fonts, text, masks, expressions, external URLs or effects.
[Official feature comparison](https://github.com/airbnb/lottie-web/wiki/Features)
and [Airbnb's supported features](https://github.com/airbnb/lottie/blob/master/supported-features.md)

The Flutter package documents bundled JSON loading, composition loading, custom
`AnimationController` ownership, and native frame-rate selection. Its
`FrameRate.composition` option avoids requesting the display's maximum frame
rate. Optional render caching trades memory for rendering cost. ATLAS instead
keeps small composition data and uses finite playback, with no raster frame
cache. The existing `lottie` dependency already supports this integration.
[Flutter package documentation](https://pub.dev/packages/lottie)

The web app already includes `lottie-react`, which wraps the Lottie player.
It is loaded as a client-only dynamic component according to the installed
Next.js lazy-loading guide. A quiet still pose does not need the animation
runtime. [Maintainer's React package](https://github.com/Gamote/lottie-react)

## Concrete LottieFiles references

These creator-published references informed the character's gesture vocabulary.
They are references, not bundled stock assets:

- [Robot standing, Penxel Studio](https://lottiefiles.com/free-animation/robot-standing-cdB6OGVdsa):
  the creator describes a standing robot with body movement and blinking eyes.
  This supports a clear face and restrained expression changes.
- [Cute Bot Say Users Hello, Abdul Latif](https://lottiefiles.com/free-animation/cute-bot-say-users-hello-fsKwsuIXi0):
  the greeting character demonstrates a readable face and a distinct welcoming
  gesture. Its image reference informed approachable head/body proportions.
- [Futuristic Robot Constructor, Tanjil Mahmud](https://lottiefiles.com/free-animation/futuristic-robot-constructor-5FSNfVhxoG):
  a character reference for an articulated hand gesture and a clear silhouette.

The implementation authors its own paths, rig hierarchy, poses and keyframes.
No source JSON, image, character geometry or remote asset URL is embedded.
Reference pages and their published image references were retrieved directly;
interactive playback on LottieFiles was unavailable in this tool session.

## Original ATLAS Scout artwork and state vocabulary

ATLAS Scout has an ivory shell, a large charcoal face with expressive eyes and
mouth, articulated hands, a compact body, and a small gold crest. The face is the
primary identifying feature at small sizes. A listening tilt, raised hand,
focused glance and open speaking expression communicate state through the
character. The retired compass is absent from current artwork and fallbacks.

The parented rig moves the head, face, eyes and crest together. Hands rotate from
shoulders, and completion lifts the whole character before settling. Shapes use
the existing warm-neutral, charcoal, gold, success and warning palette from
`src/app/globals.css` and native `AppTheme`. Light/dark exports preserve the ivory
shell and charcoal face while adapting outlines and accent brightness. Updating
theme colors requires regenerating the exports from their authoring palette.

| Application state | Still pose | Authored finite reaction |
|---|---|---|
| Available / idle | Open eyes, small smile, relaxed hands | Welcome wave is authored; normal idle/greeting policy remains still |
| Listening | Head tilted, hand near head | Attentive tilt and hand-to-ear gesture |
| Working | Focused downward glance | A short look between work areas and coordinated hand movement |
| Responding | Open speaking expression, hands outward | Three small mouth changes and an open-hand gesture |
| Needs you | Raised hand and attention badge | A deliberate raised-hand gesture; existing policy keeps it still |
| Blocked | Concerned eye shape, level mouth, attention badge | Restrained head tilt; existing policy keeps it still |
| Completed | Both hands raised, check on chest | One lift and acknowledgment after the receipt gate |
| Paused | Resting eyes and pause badge | Still |

Each animation is 256 × 256 at 30 fps for 1.2 seconds, with no loop. There are
eight state files for each theme. The generator writes byte-identical JSON to
web and Flutter and produces SVG stills from the same geometry and final rig
transforms. The completion still keeps its check with motion disabled. Original
art was manually inspected in light/dark contact sheets at large and compact
sizes; no device or runtime performance result is inferred from those sheets.

Authoring source:
`.design/asael-ace-revamp/atlas-lottie/source/generate.mjs`.
Run this file with Node to update the artwork deliveries. This command authors
assets; it is not a test or application build.

## Integration and safeguards

- Web: `companion-atlas-player.tsx` retains the per-owner/conversation reaction
  ledger. `companion-atlas-lottie.tsx` renders still SVGs, lazily admits bounded
  same-origin JSON, and controls the Lottie instance. The conversation, voice
  stage, and former standalone mascot wrapper share this player.
- Native: `atlas_player.dart` uses the same JSON compositions through
  `atlas_lottie_assets.dart`. It retains the original lifecycle, route/TickerMode,
  viewport/scroll and explicit macOS low-power-state checks. Reduced motion and
  accessible navigation keep a still pose. A theme-aware Scout vector painter is the
  loading/failure fallback. The former brand mascot uses this same player.
- No clip loops. Idle has no running animation controller. Offscreen, hidden,
  low-power, reduced-motion, disabled-motion and unavailable reactions remain
  consumed; restoring visibility does not celebrate historical work. The web
  waits for the inner element's first visibility observation before deciding
  whether an otherwise eligible reaction is offscreen.
- Browsers do not expose a universal low-power-mode signal. Web respects reduced
  motion, document visibility, intersection visibility and exposed data-saving
  preference; it does not claim a battery-mode guarantee. Native retains the
  existing macOS low-power integration.
- Artwork is decorative. Existing status labels, device/playback signals,
  execution authority and completion receipts remain the source of truth. The
  player never starts microphone capture, audio playback or agent work.

Raster posters/sprites and the earlier standalone Lottie files have no active
UI references and are no longer in Flutter's bundled asset list. The retired web deliveries now live under
`.design/asael-ace-revamp/atlas-lottie/legacy-delivery/`, outside the served public
directory. Unbundled native historical assets and legacy parsing helpers remain
in the repository for historical compatibility. The production measurement
component now uses an explicit Lottie observation contract; it has not been run
as part of this release.

## Validation boundary

This change was prepared through primary-source research, source inspection,
deterministic asset authoring and visual inspection of exported still poses. No test suite, audit, application build or deployment was run by this
implementation lane. The release owner is responsible for the authorized build
and live verification. No performance measurement or device validation is
claimed by this document.
