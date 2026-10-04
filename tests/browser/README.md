# Browser interaction checks

This layer runs the actual Next application and Chrome with a fresh private
synthetic account. It covers conversation submission/reopening and safe message
rendering, Chat/Map draft retention, voice-consent focus and microphone state,
phone navigation, and an exact approval followed by a queue reread. Desktop and
phone light/dark states produce viewport PNGs and axe WCAG A/AA reports.

The runner starts and stops its own loopback development server. Use a checkout
without Next dotenv files and stop any existing development server first. It
passes an explicit environment with no database/provider/connector credentials,
creates a temporary application data directory, and signs in through the real
login route so server-rendered permissions are authentic. It deletes that data
after the run and never writes the password or session cookies to an artifact.
The preview disables sampled web-vitals telemetry so random diagnostic POSTs
cannot change an interaction test's request budget.

Every browser API write is blocked except one exact, wholly intercepted
conversation request and one exact approval request per viewport. Optional read
sources use explicit unavailable fixtures. Unexpected writes, external requests,
popups, downloads, browser errors, page overflow and axe violations fail the run.
No model, real approval execution, external connector, microphone or audio device
is exercised. Database integration, provider contracts and device acceptance keep
their existing separate checks.

Run serially with other local checks, especially on an 8 GB host:

```sh
python3 -m venv /tmp/asael-browser-venv
/tmp/asael-browser-venv/bin/pip install -r tests/browser/requirements.txt
npm install --prefix /tmp/asael-browser-tools --ignore-scripts --no-audit --no-fund axe-core@4.11.0
/tmp/asael-browser-venv/bin/python -m playwright install chromium
/tmp/asael-browser-venv/bin/python tests/browser/run.py \
  --axe /tmp/asael-browser-tools/node_modules/axe-core/axe.min.js
```

Node 24 must be on PATH. To use an already installed Chrome, pass `--chrome` with
its executable path and omit the Playwright browser installation. Pass `--output`
to save evidence outside the default ignored `test-results/browser` directory.
The runner requires no embedded browser or native preview panel.

`report.json` records assertions and exact intercepted request dispositions;
individual axe reports retain incomplete manual checks as well as violations.
Screenshots are review artifacts, not a claim of pixel equivalence across OS/font
versions. Automated visual regressions currently cover overflow, pointer mode and
accessibility; screen-reader, physical-device, performance/energy and reviewed
pixel baselines remain additional acceptance gates.

`semantic_reviews.py` uses the same runner options for the actual Memory → Reviews
route. It checks stale reads and source-version changes, exact review/probe
receipts, independent refresh failures, draft/focus retention and disposal.
Seven desktop and two phone evaluation POSTs are wholly intercepted; no real
evaluation or activation runs. Its axe scope is the semantic review bench and
its screenshots retain the surrounding application for context. CI runs it
serially after the conversation/approval suite.

`activity.py` exercises the actual primary Activity navigation and a real isolated
authenticated read before intercepting synthetic records. It checks bounded
grouping/paging, exact source hrefs, cursor expiry, retained stale data, malformed
responses, request races, disposal and unavailable-versus-empty states. It allows
no application writes. Desktop and phone each receive light/dark screenshots and
axe scans; CI runs this suite serially after the semantic review suite. Source href
assertions preserve identities but do not by themselves prove a destination's
domain action or native conversation continuity.

`companion_preferences.py` checks General settings independently of advanced
configuration availability. It reads real isolated defaults before and after
fixtures; seven exact synthetic PATCH attempts per viewport exercise held saves,
uncertain same-key retries, older replay receipts, newer snapshots, revision
conflicts, owned home selection, deleted-home fallback, reset and disposal. Drafts
survive local section changes and follow-up read failures. Nine scoped axe scans
cover desktop/phone themes, the owned-thread picker, 320px, 200% text and forced
colors. Viewport changes settle for two animation frames before reflow sampling.
No real preference is saved and previews request no audio or execution. Durable
persistence is covered separately by PostgreSQL integration tests; native
adoption and final ATLAS rendering retain their own gates.

`meetings.py` covers the list and exact detail route, independent unavailable or
malformed sources, an outside-window meeting, repeated pending-media polls,
A→B→A read races, frozen editor revisions, accepted receipts during failed reads,
proposal digest drift, exact owner/due-date/recipient/draft review, consent, media
identity, Calendar status and disposal. Desktop declares eleven business effects
and thirteen Calendar requests; phone declares one creation and four Calendar
requests. Every effect is fulfilled by the synthetic fixture. Six page-wide axe
scans and desktop/phone detail/editor images accompany the assertions. Long source
labels must reflow, transcripts retain list semantics, and editor controls expose
stable names independently of option or textarea contents. The shared snapshot
check records overflow geometry to make future failures actionable. Live calendar,
media, WorkItem creation and message sending are outside this browser boundary.

`accounts.py` exercises the Accounts list and exact dossier, six independent
source reads, outside-window selection, retained failures, conflicts, copied
identities, exact approval return links and legacy CRM restrictions. Its five
desktop mutations are exact intercepted synthetic requests; phone performs no
mutations. The suite checks frozen write inputs, receipt-versus-refresh behavior,
retained drafts, dialog/focus behavior, long evidence, 320px reflow, text scaling,
forced colors and six scoped axe scans. It does not sync a live CRM, create real
work, contact an OAuth provider or execute an agent.

`companion_presence.py` exercises the static ATLAS portrait and eight-state
presentation adapter on Command. Exact synthetic run receipts distinguish
verified completion, partial/unverified outcomes, queued work and failures.
Preference, home-thread and disposed reads cannot replace another owner/view;
failed or pending Home navigation preserves the composer draft and changes the
URL only after the selected conversation is adopted. The suite covers missing
assets, hidden documents, reduced motion, 320px/200% keyboard access to every
dock destination, both themes and eight scoped axe scans. It forwards no
application write, OAuth, provider, microphone or playback request; the shared
runner's isolated bootstrap login is the only real setup mutation. This is a
static portrait, not evidence of the later ATLAS rig or animation pipeline.

The specialist, operations and public families run in three additional hosted
jobs. Each job runs its suites serially within the existing 15-minute limit;
local execution remains wholly serial. Route JavaScript and server-trace budgets
remain unchanged. Every family uses the same isolated login, blocked external
traffic and exact intercepted effects as the core harness.

| Suite | Main interaction boundary |
| --- | --- |
| `markets.py` | Five views; exact instrument, interval and snapshot; retained evidence, pending jobs and chart adapter fallback |
| `agents.py` | Roster, outcomes and exact Agent identity; release, grant and adaptation inspectors; independent stale sources |
| `capabilities.py` | Seven independent source reads; connection/manifest review, extension lifecycle and exclusive actions |
| `workflows.py` | Plan/schedules/history; immutable policy and procedure pins, quarantine, recovery and exact schedule controls |
| `payments.py` | Exact mandate constraints, cancelled/unsupported synthetic authenticator flows and signer removal |
| `operational_views.py` | Quality, Monitoring and Security; scoped actions, retained failures and independent source recovery |
| `settings_advanced.py` | Dirty editors, conflicts, provider rotation, API secrets, recovery/export and same-key uncertain retries |
| `public_pages.py` | Nine public/legal reading routes, health deadlines and factual private availability with zero effects |
| `access_recovery.py` | Credential errors/return destinations, explicit simulated demo, offline recovery, loading and branded 404 |

These suites include theme, narrow-width, text scaling, keyboard and accessibility
checks. WebAuthn, payment, provider, connector and browser downloads use synthetic
fixtures; passing them does not establish a hardware signer, external effect or
production deployment. Public legal meaning is preserved by source review.
`missions.py` exercises the actual legacy history routes with GET-only synthetic
Mission fixtures. It checks readable summaries, an exact bookmark outside the
50-row list, independent task/evidence/event failures, summary-only access,
canonical unverified status, bounded event cursors, URL filters and return links.
Hidden views and replaced routes cancel pending reads; malformed reads remain
retryable and only authoritative missing/denied bookmarks fall back to Work.
The mounted account-refresh control reproves canonical owner and role changes;
held responses from the previous scope cannot restore private evidence or
start further reads, and exact bookmarks and URL filters remain intact.
Desktop and phone checks cover themes, 320px reflow, 200% text, focus and axe.
No legacy executor, review mutation, provider or evidence destination is invoked.
This suite runs serially in the work-family job within its existing time limit.

`capture_library.py` covers current Library identities/citations, bounded paging,
malformed and retained reads, exact items outside the visible page, compact
Results hosting, and exact recording metadata outside the recent history. Private
transcript reads require an explicit action in the current visible owner epoch;
A→B→A selection and hidden-view restoration cannot disclose an old response.
Reindexing uses a three-lane exclusive batch and preserves unknown submitted keys
across failed reads and subsequent batches for the lifetime of the current view.
Desktop permits exactly eleven intercepted reindex POSTs; phone permits none.
No media, microphone or provider is used. Thirteen axe scans cover desktop/phone
themes, 320px and 200% text. Long panels use scrolled viewport captures with pointer
checks before and after; element captures must not resize touch contexts.
Historical content availability and durable unknown-result recovery across page
reload remain separate server/native acceptance gates.
