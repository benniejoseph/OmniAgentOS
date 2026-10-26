# Geist font provenance

These unmodified Latin variable fonts are vendored from the installed `next@16.4.3` package, at `dist/next-devtools/server/font/`. Their embedded version is 1.401. Both fonts provide the `wght` axis from 100 to 900 (default 400).

The upstream project is [vercel/geist-font](https://github.com/vercel/geist-font). Copyright 2024 The Geist Project Authors. The fonts are licensed under the SIL Open Font License 1.1; the complete copyright notice and license are included in [OFL.txt](./OFL.txt), retrieved from the [upstream license](https://raw.githubusercontent.com/vercel/geist-font/main/OFL.txt).

`src/app/layout.tsx` loads these files through `next/font/local`, retaining the existing Geist CSS variables, Latin subset, variable weights and swap display. Local source files remove the Google Fonts build-time download, allowing credential-isolated builds with networking disabled.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `geist-latin.woff2` | 28356 | `1b5ebfb3a01a97343ac96873e6d59a8cb285c66012b6a1ac509cb2765e995ba8` |
| `geist-mono-latin.woff2` | 31288 | `b7ac144b394cbd81052d6397ec0c33397977b1d7e9bc095e744e652a378c6fb3` |
| `OFL.txt` | 4383 | `c683bfbcc7e087f5d37a54ef628f10387c451a83ddc459b151403a164ac46c90` |

When updating a font, replace the files deliberately, retain the license and update this provenance. Do not fetch fonts during an application build.
