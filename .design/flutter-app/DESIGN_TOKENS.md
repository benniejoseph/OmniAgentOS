# Flutter Design Tokens: Precision Instrument

The Flutter theme extends the existing web palette rather than replacing it.

## Color

| Semantic token | Light | Dark |
| --- | --- | --- |
| background | `#F7F5F0` | `#11171A` |
| surface | `#FEFDFC` | `#182124` |
| surfaceRaised | `#EFEEE8` | `#202B2F` |
| surfaceOverlay | `#E2E2DA` | `#2B393E` |
| textPrimary | `#1D292C` | `#EAF0F0` |
| textSecondary | `#52666D` | `#A8B8BC` |
| border | `#C5CFCE` | `#3A4A50` |
| primary | `#13785C` | `#55C89A` |
| onPrimary | `#FFFFFF` | `#09281F` |
| accent | `#9B6712` | `#E7B957` |
| success | `#24764D` | `#58C58A` |
| warning | `#A16A13` | `#E6B84D` |
| danger | `#B13C34` | `#EF766D` |
| info | `#336CB5` | `#78A6E5` |

## Type

- Display/body: Inter or platform sans; mono: JetBrains Mono/platform mono.
- Scale: 11, 12, 14, 16, 18, 22, 28, 36.
- Weights: 400, 500, 600, 700.
- Labels use restrained tracking; body line height 1.45; headings 1.15.

## Space and Shape

- Base unit: 4dp. Scale: 0, 2, 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: 6dp controls, 10dp surfaces, 16dp sheets, full pills only for status/filter controls.
- Borders are 1dp; elevation is rare and reserved for overlays.
- Content max width 1440dp; readable prose max width 720dp.

## Motion

- Instant 50ms, fast 140ms, normal 220ms, slow 360ms.
- Standard emphasized deceleration for entrances; shared-axis transitions for domain drill-down.
- Intentional motions: shell destination transition, streamed-content reveal/batch settle, inspector/sheet shared-axis transition.
- Reduced-motion mode removes translation and nonessential animation.

## Breakpoints

- Compact: `<600dp`
- Medium: `600-1023dp`
- Expanded: `1024-1439dp`
- Large: `>=1440dp`

## Interaction

- Minimum touch target 48dp; compact desktop rows may be 40dp with pointer input.
- Focus ring uses primary at 3dp with contrast-safe outer gap.
- State is expressed with icon + label + color.
- Routine workspace regions are cardless; containers exist only when they define interaction, selection, or hierarchy.
