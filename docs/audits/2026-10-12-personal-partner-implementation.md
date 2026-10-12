# Personal partner implementation — 2026-10-12

The owner selected a personal AI partner that carries real work across life and projects, and authorized implementation and removal decisions. This change implements the first complete increment on `codex/personal-partner`.

## Product decisions

Asael's purpose is to help the owner turn an intention into work, use relevant context, follow progress, and return with useful evidence and decisions. The product should make those jobs easy to find. The number of agents, tools, dashboards or infrastructure layers is not a measure of its usefulness.

The primary navigation is now **Today, Assistant, My work and Library** on web and native. Today starts with focus, agenda, decisions and work; saved preferences still take precedence. Specialist tools remain available in secondary navigation and through their existing routes. The attention queue is labelled **Needs you**.

The unused `DashboardOverview` implementation was removed. Payments were removed from general navigation while the disabled execution capability, direct route and historical records were retained. Exact account, configuration and receipt evidence remains inspectable, with less of that material occupying the main Responsibilities interface. Capture's optional recording studio now loads when needed, preserving its parent-owned draft and recording deep links while reducing initial JavaScript. Public positioning and the product vision now describe the personal partner direction; the prior enterprise business hypothesis is marked historical.

## Complete work-item tracking

The owner selects an accessible canonical work item and uses **Set up work-item tracking** to create a complete inactive draft. The preset supplies a built-in read-only routine, seven daily checks, a seven-day expiry, finite notification allowance and a stop condition. It preserves existing owner-authored values. Saving, reviewing, starting checks and enabling inbox updates are distinct actions with recovery paths.

The scheduler reads the exact work item through the governed `app.work_items.show` tool. It observes status, deadlines, overdue transitions, priority, owners, readable dependencies and linked outputs. The first observation establishes a quiet baseline; unchanged state stays quiet. Completion and reopening can be observed. A task marked done is not automatically represented as independently verified.

Each wake revalidates current ownership, access, source state and execution authority. Activation review pins remain immutable. Changed work-item state can therefore be observed without turning the original review into a mutable authorization record. Checks and notification delivery have finite budgets and expiry. Tracking itself does not change the work item or send external messages.

Migration 246 extends existing runtime and notification guards rather than introducing another tracking store. Native contract 48 represents the new lane; older contract-47 clients receive an explicit upgrade response before reading or changing a work-item configuration they cannot represent. The compatibility check includes stored runtime and notification configurations even when the editable draft has subsequently changed.

## Measured changes to agent guidance

Proposed custom-agent guidance now has a real paired text comparison. The owner supplies 3–10 different examples with bounded literal assertions. Baseline and candidate use the same model, agent definition, active guidance, examples and scoring rule. Execution alternates their order and withholds tools, retrieval and memory. The comparison is bounded to 20 calls, 1,000 output tokens per call and a 120-second execution window.

New guidance can activate only after at least one additional passing example, no individual regression, fresh results and unchanged model/definition/guidance pins. Tied, regressed, incomplete, stale or mismatched comparisons cannot activate it. Existing active guidance remains reversible. The result exposes the paired outputs and measured or unknown cost; eligibility and confidence are not presented as proof of improvement.

Migration 247 stores comparison attempts with immutable request identity and completed results. A request is reserved before model calls. Retrying the same request recovers its recorded result rather than starting another paid comparison. An interrupted attempt resolves as incomplete. Web and native expose the same comparison, activation and recovery boundaries.

These checks measure behavior on the supplied examples. They do not establish general intelligence, factual correctness, statistical significance or improved tool execution. Real provider calls were not made during local verification.

## Dependency maintenance

The production audit identified four compatible upgrades, now installed and locked: MCP SDK 1.31.0, proxy-addr 2.0.8, sharp 0.35.5 and source-map-js 1.2.2. The production audit has zero high or critical findings.

Three related moderate entries remain in the mammoth → argparse → sprintf-js CLI dependency chain, for which the audit reports no patched release. The application uses `mammoth.extractRawText`; a real DOCX fixture extraction confirmed that this path did not load mammoth's CLI, argparse or sprintf-js. No forced downgrade or replacement document converter was introduced.

## Scope and release boundary

This is a local implementation candidate. It has not been deployed, and production data or connected accounts were not used for verification. Browser checks use the real interface and isolated authentication with explicitly intercepted synthetic effects. Database checks use an isolated local PostgreSQL instance. The developer's saved environment file was left untouched.

Production promotion still needs the normal hosted CI and paired web/worker release process, including migrations 246/247 and contract-48 artifacts. See [deployment](../deployment.md) and [production rollout](../production-rollout.md). The product direction and deliberately narrow capability claims are recorded in [the product vision](../vision/PRODUCT.md).

## Validation evidence

| Check | Result |
| --- | --- |
| TypeScript and route type generation | Passed |
| ESLint and type-scale policy | Passed; 1,570 files checked for the type-scale rule |
| Native contract generation and frozen archives | Passed |
| Flutter static analysis | Passed; no issues |
| Full Flutter suite | 2,411 tests passed |
| TypeScript unit suite | 1,142 files passed; 8,020 tests passed; one explicitly gated live-provider test skipped |
| Coverage thresholds | Passed: 70.89% lines/statements, 75.98% functions, 77.39% branches |
| PostgreSQL integration suite | 39 files passed; 414 tests passed; optional restore drill initially gated |
| PostgreSQL dump/restore drill | Passed separately with PostgreSQL 17 binaries; all 415 integration cases exercised successfully |
| Browser Responsibilities regression | 91 checks passed |
| Browser work-item setup and tracking | 34 checks passed |
| Browser agent guidance and existing lifecycle | 248 checks passed |
| Browser Assistant and shared shell | 120 checks passed |
| Browser public pages | 275 checks passed |
| Browser Capture, Library and recording links after deferred loading | 106 checks passed |
| Capture/performance regression tests after deferred loading | 27 files and 182 tests passed; changed-file lint passed |
| Optimized Next.js production build | Passed in a separate directory without saved environment files or credentials; includes final TypeScript validation |
| Initial JavaScript budgets | All 42 checked routes passed; Capture reduced from 800,815 to 759,657 bytes against its unchanged 800,000-byte limit |
| Server trace packaging | Passed: 43 page traces exclude native binaries; 100 route handlers include the native packages they use |
| Worker and operations script checks | Passed |
| Production dependency audit | Passed at the repository's high-severity gate; zero high/critical, three related moderate entries described above |

The 874 browser checks include real desktop/phone rendering, light/dark themes, relevant keyboard and focus behavior, enlarged-text/reflow checks and axe scans. Mutation effects and model results are explicitly synthetic in that lane. The PostgreSQL and unit suites separately exercise the real storage and execution contracts. These are complementary checks, not live-provider or production-release evidence.
