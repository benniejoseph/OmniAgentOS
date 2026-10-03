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
