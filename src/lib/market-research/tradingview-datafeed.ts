import type {
  MarketBarsResult,
  MarketInstrument,
  MarketInterval,
} from "@/lib/market-research/contracts";

export const TRADINGVIEW_LIBRARY_VERSION = "32.2.0" as const;
export const TRADINGVIEW_LIBRARY_PATH =
  "/vendor/tradingview/charting_library/" as const;
export const TRADINGVIEW_LIBRARY_SCRIPT =
  `${TRADINGVIEW_LIBRARY_PATH}charting_library.standalone.js` as const;

export type TradingViewResolution = "5" | "15" | "60";

export type TradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type TradingViewHistoryMetadata = {
  noData: boolean;
  nextTime?: number;
};

export type TradingViewPeriodParams = {
  from: number;
  to: number;
  countBack?: number;
  firstDataRequest: boolean;
};

export type TradingViewSymbolInfo = {
  name: string;
  ticker: string;
  description: string;
  type: string;
  session: string;
  exchange: string;
  listed_exchange: string;
  timezone: string;
  format: "price";
  pricescale: number;
  minmov: number;
  has_intraday: true;
  intraday_multipliers: readonly TradingViewResolution[];
  supported_resolutions: readonly TradingViewResolution[];
  volume_precision: number;
};

type TradingViewSearchResult = {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker: string;
  type: string;
};

export type AsaelTradingViewDatafeed = {
  onReady: (callback: (configuration: {
    supported_resolutions: readonly TradingViewResolution[];
    supports_marks: false;
    supports_timescale_marks: false;
    supports_time: false;
  }) => void) => void;
  searchSymbols: (
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: (results: TradingViewSearchResult[]) => void,
  ) => void;
  resolveSymbol: (
    symbolName: string,
    onResolve: (symbol: TradingViewSymbolInfo) => void,
    onError: (message: string) => void,
  ) => void;
  getBars: (
    symbolInfo: TradingViewSymbolInfo,
    resolution: string,
    periodParams: TradingViewPeriodParams,
    onResult: (
      bars: TradingViewBar[],
      metadata?: TradingViewHistoryMetadata,
    ) => void,
    onError: (message: string) => void,
  ) => void;
  subscribeBars: () => void;
  unsubscribeBars: () => void;
};

export type TradingViewMarketSnapshot = {
  instrument: MarketInstrument;
  bars: MarketBarsResult;
};

const supportedResolutions = ["5", "15", "60"] as const;

export function marketIntervalToTradingViewResolution(
  interval: MarketInterval,
): TradingViewResolution {
  if (interval === "5min") return "5";
  if (interval === "15min") return "15";
  return "60";
}

export function createTradingViewSymbolInfo(
  snapshot: TradingViewMarketSnapshot,
): TradingViewSymbolInfo {
  const isIndex = snapshot.instrument.assetClass === "equity_index";
  return {
    name: snapshot.bars.providerSymbol,
    ticker: snapshot.instrument.instrumentId,
    description: snapshot.instrument.label,
    type: isIndex ? "index" : "forex",
    session: isIndex ? "0930-1600" : "24x7",
    exchange: "Twelve Data",
    listed_exchange: "Twelve Data",
    timezone: isIndex ? "America/New_York" : "Etc/UTC",
    format: "price",
    pricescale: 100,
    minmov: 1,
    has_intraday: true,
    intraday_multipliers: supportedResolutions,
    supported_resolutions: supportedResolutions,
    volume_precision: 0,
  };
}

export function createAsaelTradingViewDatafeed(
  getSnapshot: () => TradingViewMarketSnapshot,
): AsaelTradingViewDatafeed {
  return {
    onReady(callback) {
      globalThis.setTimeout(() => callback({
        supported_resolutions: supportedResolutions,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: false,
      }), 0);
    },
    searchSymbols(userInput, exchange, symbolType, onResult) {
      const snapshot = getSnapshot();
      const symbol = createTradingViewSymbolInfo(snapshot);
      const query = userInput.trim().toLowerCase();
      const aliases = [
        symbol.name,
        symbol.ticker,
        symbol.description,
        ...snapshot.instrument.aliases,
      ].map((value) => value.toLowerCase());
      const exchangeMatches = !exchange || exchange === symbol.exchange;
      const typeMatches = !symbolType || symbolType === symbol.type;
      const queryMatches = !query || aliases.some((value) => value.includes(query));
      onResult(exchangeMatches && typeMatches && queryMatches ? [{
        symbol: symbol.name,
        full_name: `${symbol.exchange}:${symbol.name}`,
        description: symbol.description,
        exchange: symbol.exchange,
        ticker: symbol.ticker,
        type: symbol.type,
      }] : []);
    },
    resolveSymbol(symbolName, onResolve, onError) {
      const snapshot = getSnapshot();
      const symbol = createTradingViewSymbolInfo(snapshot);
      const acceptedNames = new Set([
        symbol.name,
        symbol.ticker,
        snapshot.instrument.canonicalSymbol,
        ...snapshot.instrument.aliases,
      ].map((value) => value.toLowerCase()));
      globalThis.setTimeout(() => {
        if (!acceptedNames.has(symbolName.trim().toLowerCase())) {
          onError("This chart is restricted to the selected Asael instrument.");
          return;
        }
        onResolve(symbol);
      }, 0);
    },
    getBars(_symbolInfo, resolution, periodParams, onResult, onError) {
      const snapshot = getSnapshot();
      const expectedResolution = marketIntervalToTradingViewResolution(
        snapshot.bars.interval,
      );
      if (resolution !== expectedResolution) {
        globalThis.setTimeout(() => onError(
          "Use Asael's interval control to load an evidence-bound snapshot.",
        ), 0);
        return;
      }

      const eligible = snapshot.bars.bars.filter((bar) =>
        bar.time <= periodParams.to
      );
      const countBack = Math.max(0, Math.floor(periodParams.countBack || 0));
      const selected = countBack > 0
        ? eligible.slice(-countBack)
        : eligible.filter((bar) => bar.time >= periodParams.from);
      const bars = selected.map<TradingViewBar>((bar) => ({
        time: bar.time * 1_000,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        ...(bar.volume === null ? {} : { volume: bar.volume }),
      }));
      globalThis.setTimeout(() => onResult(bars, { noData: bars.length === 0 }), 0);
    },
    subscribeBars() {
      // Immutable snapshots refresh through Asael's explicit controls.
    },
    unsubscribeBars() {
      // No live subscription is opened by this snapshot-only datafeed.
    },
  };
}
