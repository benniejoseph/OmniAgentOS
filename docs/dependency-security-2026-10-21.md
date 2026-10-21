# October 21 dependency repair

The release audit exposed runtime dependency vulnerabilities and two critical development-tool vulnerabilities. This repair updates the affected dependencies, applies the MCP input bound required by upstream, and retains the existing tenant authorization and tool governance. It does not replace the test framework or downgrade Mammoth or Next's ESLint configuration.

## Runtime dependencies

| Dependency | Resolved version | Reason and application boundary |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.0 | Fixes the four reported SDK advisories; Asael also configures a 256-element tool-input budget. |
| `hono` | 4.13.11 | Pins the compatible patch for the reported static-path decoding issue. |
| `mammoth` → `argparse` | Mammoth 1.12.1, argparse 2.0.1 | A Mammoth-scoped override removes vulnerable `sprintf-js`; Mammoth itself stays unchanged. |

[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) requires both an SDK upgrade and an explicit `maxToolInputElements` limit. `createAsaelMcpServer` sets 256 before SDK/Zod argument validation. The currently exported read tools accept at most two flat arguments. The existing streamed 1,000,000-byte JSON body limit, network boundary, authentication, rate limit, tenant/actor scope and governed executor remain intact. The regression sends excessive array values and object keys through the real in-memory SDK transport; valid arguments still reach the existing execution-scope gate.

The other SDK repairs cover [experimental task ownership](https://github.com/advisories/GHSA-22jm-h49p-29qw), [cross-origin transport/OAuth redirects](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) and [bearer-token resource validation](https://github.com/advisories/GHSA-rvq5-wwqv-78pq). Asael uses the SDK HTTP client transport, so the redirect repair matters. Its server supplies no experimental task store and uses its own service-key authentication instead of the SDK bearer verifier. No new task or authentication feature is enabled. Hono's patch addresses [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7).

There is no published patched `sprintf-js` version for [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). It was reached through Mammoth's CLI parser dependency, not the application's DOCX library import. A clean-process real DOCX conversion confirms that the library imports neither argparse, sprintf-js nor Mammoth's CLI. The scoped argparse override removes the vulnerable package from the installed graph. Although argparse 2 is a major rewrite, its legacy compatibility aliases work with the installed Mammoth CLI: help, HTML/Markdown conversion, output path, style map and three invalid-argument cases were exercised. Expected legacy deprecation warnings remain. Remove this override after an upstream Mammoth version supplies a safe parser dependency and the same behavior checks pass. See the [argparse changelog](https://github.com/nodeca/argparse/blob/2.0.1/CHANGELOG.md).

## Development dependencies

Compatible patches pin brace-expansion 1.1.21/2.1.7/5.0.12, Browserslist 4.28.7, js-yaml 4.3.2 and Vite 6.4.4. They address the reported [brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [Browserslist](https://github.com/advisories/GHSA-c83g-rgw3-j3cx), [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh) and [Vite](https://github.com/advisories/GHSA-698v-4r3x-3vcv) findings. Npm also refreshed compatible transitive Rollup and browser-data packages in the lockfile.

Vitest and its coverage provider remain 3.2.7. A scoped Tinypool 2.1.2 override fixes [constructor-option prototype pollution](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and [run-option prototype pollution](https://github.com/advisories/GHSA-85c8-ppgw-ccpr). Tinypool 2's documented breaking change is [dropping Node 18](https://github.com/tinylibs/tinypool/releases/tag/v2.0.0); this repository requires Node 24. The declaration comparison removes no public method consumed by Vitest. On Node 24.20.0, both thread and child-process pools passed inherited-option rejection, run, abort, recycle, pending cancellation, getters and destruction probes. Real Vitest tests then passed in both pool modes. This is a specifically verified compatibility override, not a general policy of cross-major overrides.

## Remaining development advisories

The final full audit reports **0 critical, 5 high and 3 moderate entries**. Every remaining affected lockfile node is development-only. Eight entries represent the following two root advisories and their dependents; they are not eight independent defects. The production-only audit reports **zero vulnerabilities**.

| Root advisory | Remaining entries | Why not changed in this release |
| --- | --- | --- |
| [braces stack exhaustion, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, `eslint-config-next` — five high entries | Installed braces 3.0.3 has no published patched release. Npm proposes downgrading eslint-config-next to 14.2.35, which is incompatible with the intended Next 16 tooling. This is not performed. |
| [Vitest mocker traversal, GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | `@vitest/mocker`, `vitest`, `@vitest/coverage-v8` — three moderate entries | The first upstream patch is 4.1.11, requiring a coordinated Vitest/coverage major upgrade from 3.2.7. Npm currently suggests 5.0.5. No unsupported internal mocker override is imposed. |

The braces path is development lint/glob processing; an attacker-controlled deeply nested pattern can still exhaust that tool process. The repository does not expose that parser as an application service. The mocker advisory concerns a mock-server/WebSocket path: the repository's unit and integration configurations use the Node environment and its scripts do not enable a browser, API or standalone mocker server. These boundaries reduce the present exposure; they do not patch the dependencies. Keep test/mock services private, use reviewed glob patterns, and reassess when a supported braces fix or planned Vitest migration is available.

## Verification and build gate

Focused evidence comprises 63 MCP/document/capture regressions, nine Mammoth compatibility checks, a separate clean-process DOCX import check, the two Tinypool runtime probes, changed-file lint, and final Vitest fork-mode (four) and thread-mode (21) checks after the development patches. No full test suite or additional Next build was run for this dependency repair.

`postbuild` now invokes the existing `check:route-js` budget against the assets just built. This makes the same budget part of the required release build; it adds no second build or test suite. The redundant explicit invocation is removed from `verify` and the CI workflow. Budget values are unchanged.

Machine-readable reports and command output are retained under `/Volumes/Extreme Pro/Asael-agent-reviews/2026-10-21-principal-repairs/dependency-*`. Local checks are preparation evidence; deployment and authenticated live verification remain separate release steps.
