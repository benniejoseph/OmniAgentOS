# Current ATLAS component measurements

This separate harness imports the unchanged `src/components/companion-atlas-player.tsx`,
its real preference hook and `next/image`. It bundles them with the installed React,
Next and esbuild dependencies in production mode. It does not build a Next route,
modify the application, publish artwork, start provider activity or authenticate.

The fixture server is read-only and binds only `127.0.0.1`. Browser requests are
restricted to the fixture document, bundle, synthetic preference read and admitted
public artwork. Every application write and external request is refused. All 33
shipped HELD01 files must match the pinned accepted manifest and its image hashes.
The old rough benchmark, outputs, source/export records and artwork stay untouched.
DOM readiness uses explicit `page.evaluate` functions with Python monotonic
deadlines and bounded polling. It does not use Playwright's eval-based
`wait_for_function`; the fixture CSP remains unchanged without `unsafe-eval` or
a browser CSP bypass.

Three variants share the exact same production component and instrumentation:

- `neutral`: visible, motion off; the known non-admitted manifest response makes
  the real production fallback display the approved neutral PNG.
- `poster`: visible, motion off; the exact HELD01 manifest selects state posters.
- `motion`: visible, expressive/full motion; after preferences, the initial poster
  and real intersection are ready, a synthetic available-to-working transition
  admits the finite working sprite through the production playback gate.

The preference snapshot is a synthetic persisted revision, so nondefault settings
preserve the real parser's revision-zero semantics. No audio, real microphone or
verified completion is claimed. The working clip is representative, not an
all-state or largest-asset performance claim. Every variant still imports all
player JavaScript and performs the production manifest read.

The initial matrix is light/dark × 72/256 CSS pixels × DPR 1/2, three repetitions
per variant: 72 cases, serially. These are approved art comparison/authored scales,
not the live compact Assistant's 36px or Voice's 108px desktop / 64px mobile slots.
72px greeting is static in the app. The isolated fixture is client-rendered; it
does not reproduce Next SSR/hydration or the production shell's styles/layout.
Variants are interleaved within each theme/size/DPR and their order rotates per
repetition, without discarding a warmup sample.
`--sizes 36 64 72 108 256` extends this bounded matrix to 180 cases. The 36px compact
and 64/108px Voice slot sizes are labelled in each case, without implying the
fixture recreates those app layouts or physical/mobile devices.

## Root-run commands

Run each script's `--help` first. Use the existing Python environment with
`tests/browser/requirements.txt`; no dependency installation is required by this
harness. Replace the example `/tmp` destinations with NEW evidence directories.
The output parent directory must already exist. The builder and measurement runner
refuse existing destinations, including partially failed builds; preserve those
and choose a new directory for a retry.

```sh
node scripts/atlas/production-measurement-build.mjs --help
python scripts/atlas/production_measurement_server.py --help
python scripts/atlas/production_measurement.py --help
node scripts/atlas/production-measurement-build.mjs --output /tmp/atlas-current-component-build
```

The skill helper has already been inspected with `--help`. It can manage the
fixture server while the separate measurement process runs:

```sh
python /Users/benniejoseph/.codex/skills/webapp-testing/scripts/with_server.py \
  --server "python scripts/atlas/production_measurement_server.py --bundle-dir /tmp/atlas-current-component-build --port 8766" \
  --port 8766 -- \
  python scripts/atlas/production_measurement.py \
    --bundle-dir /tmp/atlas-current-component-build \
    --origin http://127.0.0.1:8766 \
    --output /tmp/atlas-current-component-measurements \
    --sizes 36 64 72 108 256
```

Use `--chromium-executable /absolute/browser/path` only when a configured Chromium
is needed. `--repeats 1` is a 24-case fixture smoke check with the default two sizes
(60 cases with all five), not the final three-sample comparison. No broad lifecycle
regression suite is part of this command.

## Evidence and interpretation

`build.json` records actual Git HEAD/tree and dirty status, exact compiler input
bytes (including uncommitted harness source), dependency versions, bundle and
metafile hashes, all 33 public raster files and the static PNG. It never labels a
dirty checkout clean. Physical inputs are explicitly tagged and hashed. Generated
esbuild define inputs are separately tagged in `virtualInputs`, with the exact
define replacement and compiler metadata; `compilation.define` records the full
configuration. They are not misrepresented as physical files or silently omitted.
The server and client verify both input kinds again; the client
also checks the server identity and re-verifies inputs after measurement. Root
should synchronize accepted main before building; a source change requires a new
fixture build and evidence destination.

Each case retains raw resource/navigation entries, DOM style observations, poster
readiness, real input event/handler timestamps, the independent control's second
rAF timestamp, request inventory and bounded functional checks. First repetitions
also capture the actual final poster. `measurement.json` binds the case records by
SHA-256 and records source/build identity, OS, browser/tool versions and browser
GPU metadata when exposed. A functional fixture failure ends the run and produces
a failing, incomplete receipt; there are no invented timing thresholds.
The motion observation window begins at observed sprite admission, not the input
event; startup latency remains separate. A bounded loaded-poster wait accommodates
the production image's lazy loading after the sprite ends. Fixture timeouts mark
missing observations, not product performance-budget failures.

MutationObserver timestamps represent observed DOM advances; callbacks can coalesce.
They are not rendered frames, player callback CPU time, presented FPS or GPU timing.
Poster complete/natural dimensions are observed readiness, not isolated decode
duration. The player itself uses `Image.onload` and 50ms timers, not rAF. The two-rAF
control proxy is not field INP. The harness does not run a continuous rAF loop.

Requests use uncompressed loopback delivery and a new context per case. Playwright
request interception disables browser HTTP cache; OS/filesystem, image-decode and
GPU caches are not claimed cold. `no-cache` on the manifest is not called `no-store`.
Static variants and motion variants have the same instrumentation. Raw sample
counts remain visible, and three repetitions are not a sustained workload.

Production route costs remain explicitly `unobserved` in this receipt. The esbuild
bundle and runtime motion-off variant are not a causal static route bundle baseline.
Record a matching-source Next build's `.next/diagnostics/route-bundle-stats.json`
separately, using the existing `scripts/check-route-js-budget.mjs` schema and
unchanged `performance-budgets.json`; bind source/tree, lockfile/configuration,
stats, budgets and referenced chunks. A separate static-only comparison needs a
disposable source copy and its exact substitution diff/hash. This harness neither
imports an unbound route receipt nor infers a budget pass from its absence.

Energy, thermal/battery behavior, native/physical-device performance, memory
reclamation, real hidden-document transitions, natural motion and live 3D remain
outside these lab measurements.

## Paired production route measurement

`production_route_comparison.py` is the separately reviewed, serial route-size
helper. Run its `--help` first, then supply an accepted full commit, a matching
installed dependency tree, an existing Node 24 binary and a NEW external directory:

```sh
python scripts/atlas/production_route_comparison.py --help
python scripts/atlas/production_route_comparison.py \
  --source /absolute/repository \
  --head FULL_40_CHARACTER_ACCEPTED_COMMIT \
  --dependencies /absolute/matching-installed-project \
  --node /absolute/node24 \
  --output /absolute/new-route-evidence
```

The helper archives that commit and copies dependencies inside its own disposable
project. It preserves the caller's `HOME`, uses a task-specific temporary directory,
and explicitly allowlists the other build environment values. It does not copy
private dotenv files or inherit provider credentials. Ordinary build/font network
access is possible; this is not an egress-confinement claim.

Both variants use the same path, lockfile, environment and complete Turbopack route
graph with `next build --turbopack --experimental-build-mode compile`. That mode
skips typechecking and application prerender, so this is a production compilation
comparison, not a full release build or a replacement for hosted release checks.
The static-only counterfactual changes only the player module to the approved
neutral portrait while preserving its public interface and real preference read;
it removes manifest/sprite/gate mechanics. It is not a feature-equivalent product
replacement and is never copied back into the application.

The helper retains both compilations, exact substitution, source/dependency
inventories, route statistics, referenced chunk identities and the unchanged route
budget checker results. It pins the reviewed player/configuration, Next version
and HELD01 manifest; changed pins require review. `comparison.json` reports actual
minus static-only first-load JavaScript bytes for every route. No asset transfer,
GPU or energy result follows from these JavaScript totals. The original helper
used for the first comparison and this checked-in copy have identical bytes.
