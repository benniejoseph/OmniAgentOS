# ICT Trading Research Agent

**Status:** Stage 0 foundation, authorized TradingView Advanced Charts rendering, Stage 2 provider access, immutable price snapshots, official macro schedules/vintages, event windows, deterministic technical primitives, descriptive comparable-event baselines, and the Stage 7 forward-shadow journal foundation are implemented; saved chart analysis, transcript ontology, transcript-authoritative ICT rules, sufficient calibration evidence, agent annotations, and deterministic backtesting remain pending
**Research date:** 2026-09-10; implementation activated 2026-09-11
**Initial instruments:** Nasdaq-100 exposure and gold exposure

## Current implementation boundary

The private `/app/markets` workspace, canonical instrument registry, provider-readiness API, and server-only market adapters now exist. `XAU/USD` is bound to the indicative Twelve Data spot mapping. The user's `NAS100` research label is bound to Twelve Data's `NDX` cash-index symbol and remains explicitly distinct from `NQ`/`MNQ`, `QQQ`, and any broker's executable `NAS100` or `US100` quote. Twelve Data recognizes NDX, while the currently connected account reports that NDX time series requires a Grow or Venture entitlement; the application exposes that limitation rather than substituting another instrument. Successful price reads retain the bounded raw provider response and normalized bars in an immutable owner-private snapshot with a content digest and typed observation event. Short interval-aware cache windows reuse the exact stored snapshot, so page interactions reduce provider calls without creating untraceable in-memory data.

`Meridian` is a built-in, read-only market-research specialist. Its text model uses the separately configurable `market_research` assignment in Settings; the market workspace does not consider a deployment fallback to be an explicit assignment. The application requires only `TWELVE_DATA_API_KEY` for market bars and `FRED_API_KEY` for leakage-safe historical release dates and later vintages. The official BLS calendar is a public source and requires no application credential.

The current UI exposes four progressively loaded views: Research desk, News impact lab, ICT + Quarterly, and Forecast journal. The Research desk uses the owner's authorized TradingView Advanced Charts v32.2.0 checkout with a client Datafeed over the same immutable Asael snapshot shown in its evidence label; it does not fetch a second or hidden market feed. The renderer stays mounted while the user changes research tabs, supports responsive zoom/pan, indicators, and manual drawing tools, and changes intervals only after Asael loads the corresponding evidence-bound snapshot. The chart library is loaded only when verified bars exist, and its data label exposes the shortened snapshot digest plus whether the server created or reused the snapshot. The News Impact Lab can enqueue and track owner-private background imports for official event history and exact XAU/USD price windows. Reviewed BLS, Census, BEA, and Federal Reserve schedules supply exact release times; initial-release FRED observations retain the values available at the historical release. Every replay stores its bounded raw provider response, normalized bars, exact event coordinate, content digests, and deterministic post-event measurements.

The ICT + Quarterly view now runs `market-technical-primitives:1` against one caller-owned immutable snapshot. It reports New-York-time 90-minute/session context, only those calendar opens whose boundary exists inside the snapshot, range position, five-bar swings, three-bar price gaps, range-relative displacement, and 20-bar boundary sweeps. The formulas and output digest are visible. These are neutral reproducible foundations and deliberately claim no transcript authority; order blocks, market-structure shifts, inversions, and other ICT-specific semantics remain unavailable until the user's transcript evidence and reviewed definitions exist.

The News Impact Lab also derives a digest-bound `market-event-baseline:1` projection from the caller's replay cohort. Each exact release family reports its sample size, empirical direction split, 5/15/60/240-minute return distribution, and favorable/adverse excursion medians. A configurable minimum sample distinguishes low-sample rows from a usable descriptive baseline. This is not probability calibration: no historical frequency is presented as a prediction, and the baseline cannot condition on consensus surprise, macro regime, or transcript-reviewed technical context until those inputs exist.

The Forecast Journal now implements the append-only `market-forward-shadow:1` foundation. Meridian resolves the active, catalog-backed `market_research` assignment from Settings, binds one immutable price snapshot plus its deterministic technical and event-baseline digests, and creates exactly one bullish, bearish, and neutral scenario for the next daily or weekly New York window. The first actor/instrument/horizon/window result is permanent; retries reuse it. Its provider, model, assignment ID and revision, configuration digest, and persisted AI-usage receipt are sealed with the forecast. Outcomes are written later as separate immutable receipts after the window closes. Until sufficient forward samples exist, the contract remains `uncalibrated`, exposes no numeric probability, and withholds Brier score. The production canary sealed one daily abstention and one weekly neutral lead on the explicitly configured OpenAI `gpt-6-astra` assignment revision 1. Both remain open until their September 14–18, 2026 windows close.

Production event coverage is currently 60 of 142 eligible exact-time XAU/USD windows across CPI, PPI, Employment Situation, JOLTS, personal income/outlays, retail sales, FOMC, and GDP. Every family still remains below the 20-event descriptive gate, so the UI correctly reports zero qualified groups. More history improves descriptive evidence but does not by itself create a calibrated forecast.

Trading Economics is no longer a dependency. The free-source path uses FRED/ALFRED for durable release history and vintages plus the official BLS calendar for upcoming BLS schedules. Free official sources do not provide a complete historical economist-consensus archive, so that field remains nullable. Scraping an unlicensed commercial calendar is not part of the trusted pipeline.

## Purpose

Design a private research workspace that can use user-supplied ICT course transcripts, current market data, dated web research, deterministic feature detection, chart annotations, and reproducible backtests. The first version must assist research; it must not autonomously execute trades or present its output as guaranteed financial advice.

The transcripts describe a discretionary trading methodology. Their predictive value must be established through controlled historical tests and forward shadow evaluation rather than assumed from the source material.

## Recommended decisions

1. Use retrieval-augmented generation (RAG), a reviewed concept graph, and deterministic ICT feature detectors. Do not train a model on raw transcripts merely to make their knowledge available.
2. Resolve the exact tradable instrument before building any market-data or backtest integration. `NDX`, `NQ`/`MNQ`, `QQQ`, broker-specific `NAS100`/`US100`, `XAU/USD`, and `GC`/`MGC` are not interchangeable.
3. Use the owner's authorized TradingView Advanced Charts v32.2.0 repository access, while keeping its licensed files out of the public application repository. Repository access is technically confirmed; the owner remains responsible for retaining the private-use licence or approval associated with that access.
4. Use Twelve Data as the initial multi-asset display and research feed. Use the intended broker's own historical feed for CFD validation, or Databento/CME data for execution-quality NQ/MNQ and GC/MGC futures research.
5. Keep language models outside the historical replay loop. An agent may propose a typed strategy, but a deterministic engine must execute and score it.
6. Journal every forecast before its outcome is known. Do not move beyond research mode until forward results pass predetermined gates.

## 1. Instrument identity is a hard boundary

The product name shown to a person is not a sufficiently precise data identity.

| User label | Possible instrument | Important differences |
| --- | --- | --- |
| NAS100 / US100 | Broker-specific CFD | Vendor price construction, spread, financing, session, leverage and symbol vary by broker. |
| Nasdaq-100 | `NDX` cash index | Benchmark value; not itself an executable instrument. |
| Nasdaq futures | `NQ` or `MNQ` | Expiring CME contracts with contract rolls, tick values and nearly continuous sessions. |
| Nasdaq ETF | `QQQ` | Exchange-traded security with equity sessions and its own tracking behaviour. |
| Gold spot | `XAU/USD` | Decentralized spot/CFD feed; provider and broker quotes can differ. |
| Gold futures | `GC` or `MGC` | Expiring COMEX contracts with centralized trades, order book and roll behaviour. |

Nasdaq identifies the cash Nasdaq-100 as `NDX`. CME identifies `NQ` and `MNQ` as its Nasdaq-100 futures products, with MNQ one-tenth the size of NQ. CME identifies `GC` as its 100-troy-ounce benchmark gold contract and `MGC` as its 10-troy-ounce Micro contract. See [Nasdaq's NDX overview](https://indexes.nasdaq.com/Index/Overview/NDX), [CME Nasdaq-100 futures](https://www.cmegroup.com/markets/equities/nasdaq/nasdaq-futures.html), and [CME Gold products](https://www.cmegroup.com/markets/metals/precious/gold-futures.html).

### Required identity record

Every market request, forecast, drawing and backtest must refer to an immutable instrument identity containing:

- Internal instrument ID and asset class.
- Venue or price-source identity.
- Provider-specific symbols, including the broker symbol where applicable.
- Currency, tick size and price precision.
- Exchange/session calendar and timezone.
- Contract multiplier, expiry and roll policy for futures.
- Spread, financing and commission model for CFDs.
- Whether the value is executable, indicative, midpoint, last trade or index value.

No adapter may infer that `US100`, `NDX`, `NQ` or `QQQ` are equivalent.

## 2. Transcript knowledge: RAG before training

### Current facts

Vector-store workflows support file status, configurable chunking and metadata, which makes source knowledge replaceable and traceable. Fine-tuning is primarily useful for stable behaviour, format, classification and efficiency. OpenAI's current materials separately describe RAG as a way to extend model knowledge and fine-tuning as behavioural customization. OpenAI also announced on 2026-05-08 that its existing fine-tuning platform is winding down for new users, reinforcing the need for a provider-neutral design. See [OpenAI vector-store files](https://platform.openai.com/docs/api-reference/vector-stores-files/generic.svg) and [OpenAI's model-customization update](https://openai.com/index/introducing-improvements-to-the-fine-tuning-api-and-expanding-our-custom-models-program/).

### Recommendation

Use three connected but independently versioned layers:

1. **Evidence layer:** original files, transcript text, timecoded chunks and source hashes.
2. **Knowledge layer:** reviewed concepts, definitions, examples, conditions, invalidations and contradictions.
3. **Execution layer:** deterministic, measurable feature definitions derived from approved concepts.

A transcript chunk should retain:

- Course, module, lesson, video and speaker.
- Start and end timecodes.
- Original and normalized text.
- Source-file hash and transcript version.
- Publication date, ingestion date and user-provided provenance.
- Extracted concepts, instruments, sessions and timeframes.
- Extraction confidence and human-review state.

Useful graph relationships include `DEFINES`, `EXAMPLE_OF`, `REQUIRES`, `CONFIRMS`, `INVALIDATES`, `CONTRADICTS`, `APPLIES_TO_SESSION`, `APPLIES_TO_TIMEFRAME`, and `DERIVED_FROM_CHUNK`.

Hybrid lexical and semantic retrieval should return transcript citations down to the timecode. The agent must distinguish a source statement from an app-derived interpretation. Ambiguous terms such as displacement, liquidity sweep or fair-value gap must not become executable rules until a measurable definition has been reviewed and versioned.

Fine-tuning or distillation should be reconsidered only after there is a curated labelled dataset and a fixed evaluation showing a material benefit for a narrow task such as concept extraction, structured annotation generation or classification. It should not be the storage mechanism for transcript knowledge or live market facts.

## 3. Charting options and licence constraints

### Advanced Charts

TradingView states that Advanced Charts is free only when TradingView attribution remains visible and the implementation environment is public, not private or behind a paywall. The library is distributed from restricted repositories, is non-redistributable, and must not be placed in public repositories. See [Advanced Charts introduction](https://www.tradingview.com/charting-library-docs/latest/introduction/) and [installation requirements](https://www.tradingview.com/charting-library-docs/latest/getting_started/quick-start/). The owner supplied and technically confirmed access to the restricted repository on 2026-09-11. Asael pins v32.2.0 at commit `f936c921ba510ba20ac51a71b8b4c5c03c043dbc`, excludes every licensed artifact from public Git, and stages those assets only from the authorized checkout during a local release.

Advanced Charts and Trading Platform do not include market data. The application must implement a Datafeed API backed by its own provider. See [TradingView's Datafeed API](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/).

The embedded libraries also do not provide Pine Script, Strategy Tester, Bar Replay or TradingView.com alerts. Custom indicators must be implemented in JavaScript and backtesting remains the application's responsibility. See [TradingView's unsupported-feature FAQ](https://www.tradingview.com/charting-library-docs/latest/resources/Frequently-Asked-Questions/) and [custom-indicator documentation](https://www.tradingview.com/charting-library-docs/latest/custom_studies/).

Advanced Charts has a rich Drawings API for typed objects including trend lines, rectangles, price ranges, forecasts and labels. See [TradingView's Drawings API](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api/).

### Lightweight Charts

TradingView Lightweight Charts is Apache-2.0 licensed, requires the applicable attribution notice, and supports custom drawing and annotation primitives. Official examples include trend lines, rectangles, session highlighting and volume profiles. See the [Lightweight Charts repository](https://github.com/tradingview/lightweight-charts), [plugin documentation](https://tradingview.github.io/lightweight-charts/docs/5.1/plugins/intro), and [official plugin examples](https://tradingview.github.io/lightweight-charts/plugin-examples/).

### Decision gate

- Advanced Charts is now the selected renderer based on the owner's restricted-repository access; retain the associated private-use approval and required attribution.
- Never commit, mirror, package, or redistribute its library files through the public OmniAgentOS repository.
- Keep the application's future annotation schema independent of the renderer so drawings, forecasts, and backtests remain portable.

## 4. Market-data strategy

### Twelve Data: suitable first adapter, not the sole source of truth

Twelve Data provides REST OHLC time series and WebSocket price streaming. Its `/time_series` endpoint currently costs one API credit per symbol and returns at most 5,000 records per request. Intraday depth is generally several years while daily data is deeper. See [Twelve Data historical-data guidance](https://support.twelvedata.com/en/articles/5656039-how-to-get-historical-prices), [credit rules](https://support.twelvedata.com/en/articles/5615854-credits), and [current individual pricing](https://twelvedata.com/pricing).

REST and WebSocket have separate quotas. Twelve Data currently documents price updates, but not OHLC, indicators or bid/ask values, through WebSocket. Full WebSocket access requires an eligible plan; trial tiers are more restricted. See [Twelve Data's WebSocket FAQ](https://support.twelvedata.com/en/articles/5194610-websocket-faq).

`XAU/USD` is explicitly supported. Twelve Data describes its commodity and forex prices as aggregated midpoint data rather than broker-executable quotes and warns that decentralized market feeds can differ from broker prices. See [Twelve Data commodities](https://twelvedata.com/commodities) and its [price-deviation explanation](https://support.twelvedata.com/en/articles/11850499-understanding-price-deviations-in-commodities-and-forex-data).

Implementation implications:

- Discover and validate provider symbols; never hard-code an assumed `US100` alias.
- Cache historical ranges and update incrementally.
- Build normalized bars server-side from streaming prices only when their semantics are acceptable.
- Preserve the raw provider payload and a normalized immutable snapshot.
- Record provider, plan-dependent latency, retrieved time and data completeness.
- Treat a midpoint research feed as different from the user's executable broker feed.

### Higher-fidelity futures data

Databento provides historical and live CME/CBOT/NYMEX/COMEX datasets with bars, trades, top-of-book and deeper book schemas. Its current CME offering advertises more than 16 years of history, with historical usage and live-data licensing dependent on plan. See [Databento's historical API](https://databento.com/docs/api-reference-historical), [CME dataset coverage](https://databento.com/docs/knowledge-base/datasets), and [current pricing](https://databento.com/pricing/).

Recommendation:

- Use Databento or an equivalent licensed CME feed for serious NQ/MNQ and GC/MGC evaluation.
- Use the intended broker's own historical prices, spreads and financing for broker CFD validation.
- Do not use a good result on NQ or GC as proof of equivalent performance on a broker's NAS100 or XAU/USD CFD.

### Macroeconomic and current information

FRED/ALFRED supports real-time periods and vintage dates, allowing retrieval of economic observations as they were known at a historical point rather than using later revisions. See [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html), [series observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), and [vintage dates](https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html).

Current web research should supplement, not replace, market feeds. Every web fact used by an analysis must carry its source URL, publication time, retrieval time and the analysis's market `asOf` time. Retrieved content is untrusted data and cannot alter tool permissions or agent instructions.

## 5. Agent and tool boundary

The model is a research orchestrator, not a price engine, backtest engine or execution gateway.

### Allowed governed tools

| Tool family | Typed responsibility |
| --- | --- |
| `clock.now` | Return authoritative server time, timezone and market-session context. |
| `knowledge.retrieve` | Return reviewed ICT evidence with chunk and timecode citations. |
| `market.snapshot` | Return immutable, provider-labelled data identified by a snapshot hash. |
| `market.features` | Run versioned deterministic feature detectors. |
| `macro.as_of` | Retrieve point-in-time macro observations and release metadata. |
| `web.research` | Retrieve dated, cited current information as untrusted content. |
| `backtest.submit` | Validate and enqueue a versioned strategy specification. |
| `backtest.read` | Read progress and immutable results; never rewrite them. |
| `chart.propose_annotations` | Submit typed drawing objects for validation and rendering. |

All calls must retain tenant, actor, run, instrument and data-snapshot scope and pass through the governed executor with idempotency and observable events.

### Forbidden model capabilities

The model must not:

- Fabricate, modify or fill missing market bars.
- Execute arbitrary chart JavaScript or provider SDK code.
- Place or cancel orders.
- Read brokerage credentials.
- Change strategy rules, risk settings or data sources silently.
- Promote self-learned behaviour directly into the active strategy.
- Use web search as the authoritative price feed.

### Typed analysis result

Every analysis proposal must include:

- Canonical instrument ID plus display and provider symbols.
- Data snapshot ID/hash, provider, freshness and `asOf` time.
- Timeframe and forecast horizon.
- Bullish, bearish and neutral scenarios.
- Calibrated probability or explicitly uncalibrated confidence.
- Entry or observation zone, targets and invalidation.
- Supporting ICT concepts with transcript timecode citations.
- Dated market and web evidence.
- Missing-data and uncertainty warnings.
- A bounded array of validated chart annotations.

Annotations should be data, not executable code: shape type, time/price anchors, style token, label, source claim ID and visibility range. The renderer must reject unsupported shapes, off-domain coordinates, arbitrary URLs and excessive object counts.

## 6. Deterministic backtesting and leakage controls

The agent may create a candidate strategy specification. A deterministic engine must validate, replay and score it without model calls or live web access inside the replay loop.

[LEAN](https://github.com/QuantConnect/Lean) is a credible engine candidate because it is event-driven and models historical data as a stream bounded by a simulated time frontier. Its model supports extensible fees, fills and slippage. See [LEAN's time-frontier explanation](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-engine), [reality-model documentation index](https://www.quantconnect.com/docs/v2/writing-algorithms), and [backtest result semantics](https://www.quantconnect.com/docs/v2/cloud-platform/backtesting/results). A narrower internal engine remains viable if the first scope is deliberately limited.

Every backtest manifest must pin:

- Strategy, ontology and feature-detector versions.
- Raw dataset and normalized snapshot hashes.
- Exact instrument/contract and provider mapping.
- Session calendar, timezone and daylight-saving rules.
- Futures roll and price-adjustment policy.
- Bar-close, next-bar and intrabar fill assumptions.
- Spread, fees, commissions, financing, slippage and latency.
- Random seed where stochastic modelling exists.
- Model, prompt and retrieval versions that produced the candidate strategy.
- Code revision and environment image.

### Leakage and overfitting controls

- Use walk-forward time splits, never random time-series splits.
- Purge/embargo samples by at least the largest feature lookback plus forecast horizon.
- Lock a final untouched test period before tuning begins.
- During an as-of simulation, retrieve only transcripts, news and macro values available by simulated time.
- If later transcripts are used to formalize a rule and it is tested on earlier prices, label it **retrospective rule evaluation**, not historical forecast performance.
- Preserve exact futures contracts and define all rolls; do not silently test on a back-adjusted continuous series and claim executable results.
- Include realistic transaction costs and reject results whose edge disappears under plausible stress.
- Compare against simple predeclared baselines.
- Record every parameter search and prevent repeated inspection of the locked holdout.
- Report uncertainty across regimes, not only one aggregate return.

Evaluation should include probability calibration, directional precision, abstention coverage, expectancy, maximum drawdown, turnover, profit factor, Sharpe/Sortino where appropriate, tail loss, sensitivity to costs, and stability across instruments, sessions and time windows.

The strongest initial evidence should come from an append-only forward shadow journal: forecasts are sealed before outcomes, then scored after the horizon closes.

## 7. Financial-risk controls

The CFTC states that AI cannot predict future or sudden market changes and specifically warns users to account for fees, spreads and subscription costs. It also warns that hypothetical results have inherent limitations and can overstate or understate actual performance. See the [CFTC AI trading advisory](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/AITradingBots.html) and [CFTC guidance on hypothetical trading systems](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/fraudadv_tradingsystem.html).

Research-mode controls:

- Label forecasts as research and backtests as hypothetical.
- Never use certainty, guaranteed-return or urgency language.
- Display source, assumptions, data freshness and invalidation beside every prediction.
- Fail closed when data is stale, incomplete or mapped to the wrong instrument.
- Keep an immutable audit trail of evidence, models, tools, settings and user decisions.
- Require human review before accepting a newly extracted concept or detector.
- Treat adaptive learning as a candidate version requiring evaluation and promotion; never mutate active behaviour in place.

If paper or live execution is considered later, it must be a separate authorization boundary with isolated credentials, explicit order approval, position/leverage limits, daily-loss and drawdown caps, volatility/news circuit breakers and a kill switch. Jurisdiction-specific legal review is required before the system is offered to anyone else or represented as personalized advice.

## 8. Staged build order and exit gates

### Stage 0 — identity, scope and licensing

- Choose the actual Nasdaq and gold instruments.
- Record intended broker and execution feed.
- Retain evidence of the private-use approval associated with the authorized Advanced Charts access.
- Define forecast horizons, risk language and evaluation metrics.

**Exit gate:** one reviewed instrument registry and one documented chart-library decision.

### Stage 1 — transcript knowledge foundation

- Async transcript ingestion with provenance and timecodes.
- Reviewed ICT ontology and graph relationships.
- Hybrid retrieval with citations and contradiction handling.
- A fixed set of retrieval and concept-extraction evaluations.

**Exit gate:** representative questions return correct, timecoded evidence; ambiguous concepts remain visibly unresolved.

### Stage 2 — market-data plane

- Twelve Data adapter, cache and rate control.
- Immutable raw and normalized snapshots.
- Symbol discovery, sessions, clock and data-quality checks.
- Point-in-time macro adapter.

**Exit gate:** the same snapshot can be replayed deterministically and every displayed bar has an instrument/provider identity.

### Stage 3 — visual research workspace

- Candlestick chart with responsive multi-timeframe navigation.
- Manual drawings and typed agent annotation rendering.
- Evidence panel linking each drawing to transcript and market inputs.
- Save and compare immutable analysis versions.

**Exit gate:** no model-generated executable chart code; drawings survive reload and retain evidence links.

### Stage 4 — deterministic ICT feature detectors

- Convert only reviewed concepts into measurable versioned detectors.
- Visual overlays and false-positive review workflows.
- Unit and golden-dataset tests for session, timezone and boundary behaviour.

**Exit gate:** detector output is reproducible from a snapshot hash and definition version.

### Stage 5 — asynchronous backtest service

- Select LEAN or a deliberately scoped internal event-driven engine.
- Versioned strategy schema, queue, cancellation and progress events.
- Costs, fills, financing, rolls and downloadable run manifests.
- Walk-forward and locked-holdout evaluation.

**Exit gate:** identical manifests reproduce identical results and leakage checks pass.

### Stage 6 — bounded trading research agent

- Orchestrate transcript retrieval, snapshots, deterministic features, macro/web research, hypothesis generation and risk critique.
- Produce scenario-based typed analysis and chart plans.
- Keep all model/provider choices configurable in Settings.

**Exit gate:** no direct execution path; all claims have evidence or an explicit uncertainty marker.

### Stage 7 — forward shadow evaluation

- Seal predictions before outcomes. **Implemented:** append-only daily and weekly scenarios, exact evidence/model receipts, separately appended deterministic outcomes, and an honest scorecard.
- Score calibration, performance, abstention and regime stability.
- Compare agent proposals against deterministic baselines.

**Current gate:** two production forecasts are open and cannot be scored before their windows close. Probability calibration remains blocked by sample size, missing consensus-surprise history, and missing reviewed transcript/regime context; the application must continue to abstain or show uncalibrated scenarios rather than manufacture confidence.

**Exit gate:** predeclared sample size, duration and risk-adjusted criteria pass without changing the locked rules.

### Stage 8 — paper trading, separately approved

- Paper-only execution gateway.
- Explicit approvals, risk caps, stale-data protection and kill switch.
- Reconcile expected versus simulated fills.

Live execution is outside this research plan and requires a separate decision, threat model, operational readiness review and authorization.

## 9. Decisions required before implementation

1. Is the target Nasdaq product `NDX`, `NQ`/`MNQ`, `QQQ`, or a named broker's NAS100/US100 CFD?
2. Is the gold product `XAU/USD` from a named broker or `GC`/`MGC` futures?
3. Which broker feed must the eventual research match?
4. TradingView repository access is confirmed and Advanced Charts is integrated. Retain the corresponding private-use approval; access alone must not be treated as a general redistribution licence.
5. Are all transcript files lawfully available for private processing, and do they include course/video metadata and dates?
6. What forecast horizons and sessions should be evaluated first?
7. What forward-shadow duration and minimum evidence threshold will be required before paper trading is even considered?
