import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------------
// Strategy: "Trend Ride with a Parachute"
// Long-only trend following with dual confirmation (EMA cross + momentum)
// and a trailing stop to protect gains. Cooldown after exits to avoid
// whipsaw. Designed to capture sustained moves while sitting out chop.
// ---------------------------------------------------------------------

const EMA_FAST = 10;
const EMA_SLOW = 250;
const MOM_BARS = 200;
const TRAIL_STOP = 0.04;          // 4% trailing stop from peak
const EXIT_MOM = -0.01;           // exit if momentum < -1%
const COOLDOWN_BARS = 600;
const STAKE_BPS = 9800;           // 98% of per-slot stake
const MAX_SLIPPAGE_BPS = 100;

interface SymbolState {
  closes: number[];               // ring buffer of closes (length <= MOM_BARS+1)
  emaFast: number | null;
  emaSlow: number | null;
  barsSeen: number;
  highestSinceEntry: number | null;
  cooldown: number;
  holding: boolean;
}

function createSymbolState(): SymbolState {
  return {
    closes: [],
    emaFast: null,
    emaSlow: null,
    barsSeen: 0,
    highestSinceEntry: null,
    cooldown: 0,
    holding: false,
  };
}

// Update EMA with standard formula, seeding with SMA of first N closes
function updateEMA(prev: number | null, price: number, period: number, seedCount: number): number {
  if (prev === null) {
    // Seed with SMA of first `period` closes (we'll call only when enough bars)
    // Actually we'll seed externally; this function just does the update.
    return price;
  }
  const k = 2 / (period + 1);
  return price * k + prev * (1 - k);
}

function computeSMA(closes: number[], period: number): number {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

const states = new Map<string, SymbolState>();
let warmup = 0;

await runBars({
  onHello(state) {
    warmup = state.warmupBars;
  },
  onBatch(state, batch) {
    const barsBySymbol = new Map<string, Bar>();
    for (const bar of batch.bars) barsBySymbol.set(bar.symbol, bar);

    const orders: (BuyInput | SellInput)[] = [];
    const candidates: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      const bar = barsBySymbol.get(symbol);
      if (!bar) continue;

      let s = states.get(symbol);
      if (!s) {
        s = createSymbolState();
        states.set(symbol, s);
      }

      const close = Number(bar.c);
      s.closes.push(close);
      if (s.closes.length > MOM_BARS + 1) s.closes.shift();
      s.barsSeen++;

      if (s.barsSeen === EMA_FAST) s.emaFast = computeSMA(s.closes, EMA_FAST);
      else if (s.barsSeen > EMA_FAST) s.emaFast = updateEMA(s.emaFast, close, EMA_FAST, 0);

      if (s.barsSeen === EMA_SLOW) s.emaSlow = computeSMA(s.closes, EMA_SLOW);
      else if (s.barsSeen > EMA_SLOW) s.emaSlow = updateEMA(s.emaSlow, close, EMA_SLOW, 0);

      if (s.barsSeen < EMA_SLOW || batch.seq < warmup) continue;

      const position = state.positions.get(symbol);
      if (position) {
        s.highestSinceEntry = Math.max(s.highestSinceEntry ?? close, close);
        const momExit =
          s.closes.length > MOM_BARS && close / s.closes[0] - 1 < EXIT_MOM;
        const exit =
          s.emaFast! < s.emaSlow! ||
          close <= s.highestSinceEntry * (1 - TRAIL_STOP) ||
          momExit;
        if (exit) {
          orders.push({
            side: 'sell',
            symbol,
            qty: position.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          s.cooldown = COOLDOWN_BARS;
          s.highestSinceEntry = null;
        }
      } else {
        if (s.cooldown > 0) {
          s.cooldown--;
          continue;
        }
        if (
          s.emaFast! > s.emaSlow! &&
          s.closes.length > MOM_BARS &&
          close > s.closes[0]
        ) {
          candidates.push(symbol);
        }
      }
    }

    const slots = Math.min(
      state.hello.symbols.length,
      state.hello.caps.max_open_positions,
    );
    if (slots > 0) {
      const cap =
        (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
      const perSlot = state.equity / BigInt(slots);
      let cashLeft = state.cash;
      let buys = 0;
      const maxBuys = slots - state.positions.size;
      for (const symbol of candidates) {
        if (
          buys >= maxBuys ||
          orders.length >= state.hello.caps.max_orders_per_bar
        ) {
          break;
        }

        let stake = perSlot;
        if (cap < stake) stake = cap;
        if (cashLeft < stake) stake = cashLeft;
        stake = (stake * BigInt(STAKE_BPS)) / BPS;

        if (stake < BigInt(state.hello.fees.min_notional_quote_units)) {
          continue;
        }

        orders.push({
          side: 'buy',
          symbol,
          notional_quote_units: stake,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        cashLeft -= stake;
        buys++;
      }
    }

    return orders;
  },
});
