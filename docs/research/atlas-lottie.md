# ATLAS vector companion

Research and implementation direction: 7 October 2026. The owner's replacement
request supersedes the historical eagle/raster studies. `DESIGN.md` and the
existing shared theme remain the design authority.

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

## Original artwork and state vocabulary

ATLAS is a rounded compass heart within an open orbital path, accompanied by a
small guiding satellite. The restrained silhouette remains readable in the
compact conversation status and expands to the voice stage without a separate
character design. Artwork uses the current light/dark surface, outline, gold,
success and warning tokens from `src/app/globals.css` and native `AppTheme`.
These fixed export palettes match the theme; changing theme tokens requires
updating the authoring palette and regenerating both deliveries.

| Application state | Still pose | Eligible finite reaction |
|---|---|---|
| Available / idle | Compass heart and satellite | Still in normal use |
| Listening | Two curved listening marks | A small ring expansion and settle |
| Working | Compass and orbit | A short forward turn and settle |
| Responding | Three response marks | A restrained pulse |
| Needs you | Attention badge | Still under the existing intensity policy |
| Blocked | Attention badge and unchanged status text | Still |
| Completed | Confirmed check and small glint | One reveal after the existing receipt gate |
| Paused | Pause badge | Still |

Each animation is 256 × 256, 30 fps, and 700 ms (completion: 800 ms). There are
eight state files for each theme. The generator writes byte-identical JSON to
web and Flutter and produces the web's SVG poses from the same shape geometry.
The SVG completion pose shows its check even when motion is disabled. These are
original vectors; no stock animation or third-party character is embedded.

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
  accessible navigation keep a still pose. A theme-aware vector painter is the
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

This change was prepared through source inspection and deterministic asset
authoring. No test suite, audit, application build or deployment was run by this
implementation lane. The release owner is responsible for the authorized build
and live verification. No performance measurement or device validation is
claimed by this document.
