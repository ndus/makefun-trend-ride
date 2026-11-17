import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_FAST = 10;
const EMA_SLOW = 250;
const MOM_BARS = 200;
const TRAIL_STOP = 0.04;
const EXIT_MOM = -0.01;
const COOLDOWN_BARS = 600;
const STAKE_BPS = 9800n;
const MAX_SLIPPAGE_BPS = 100;

type SymbolState = {
  closes: number[];
  fast: number | null;
  slow: number | null;
  seen: number;
  fastSeed: number[];
  peak: number | null;
  cooldown: number;
};

const history = new Map<string, SymbolState>();

function newSymbolState(): SymbolState {
  return { closes: [], fast: null, slow: null, seen: 0, fastSeed: [], peak: null, cooldown: 0 };
}

function updateEma(previous: number | null, seed: number[], period: number, close: number): number | null {
  if (previous !== null) {
    const k = 2 / (period + 1);
    return previous + k * (close - previous);
  }
  seed.push(close);
  if (seed.length < period) return null;
  return seed.reduce((sum, value) => sum + value, 0) / period;
}

await runBars({
  onHello(state) {
    for (const { symbol } of state.hello.symbols) history.set(symbol, newSymbolState());
  },
  onBatch(state, batch) {
    const candidates: string[] = [];
    const sells: OrderInput[] = [];

    for (const { symbol } of state.hello.symbols) {
      const closeRaw = state.close(symbol);
      if (closeRaw === null) continue;
      const data = history.get(symbol) ?? newSymbolState();
      const close = Number(closeRaw);
      data.seen++;
      data.fast = updateEma(data.fast, data.fastSeed, EMA_FAST, close);
      data.closes.push(close);
      if (data.closes.length > MOM_BARS + 1) data.closes.shift();
      if (data.slow !== null) {
        const k = 2 / (EMA_SLOW + 1);
        data.slow += k * (close - data.slow);
      } else if (data.seen === EMA_SLOW) {
        data.slow = data.closes.reduce((sum, value) => sum + value, 0) / EMA_SLOW;
      }

      const position = state.positions.get(symbol);
      if (position) {
        data.cooldown = 0;
        data.peak = data.peak === null ? close : Math.max(data.peak, close);
        const momentum = data.closes.length === MOM_BARS + 1
          ? close / data.closes[0]! - 1
          : null;
        const exit = (data.fast !== null && data.slow !== null && data.fast < data.slow)
          || close <= data.peak * (1 - TRAIL_STOP)
          || (momentum !== null && momentum < EXIT_MOM);
        if (exit) {
          sells.push({ side: 'sell', symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          data.peak = null;
          data.cooldown = COOLDOWN_BARS;
        }
      } else {
        data.peak = null;
        if (data.cooldown > 0) {
          data.cooldown--;
          history.set(symbol, data);
          continue;
        }
        const momentumClose = data.closes.length === MOM_BARS + 1 ? data.closes[0]! : null;
        if (data.fast !== null && data.slow !== null && data.seen >= EMA_SLOW && momentumClose !== null
          && data.cooldown === 0 && data.fast > data.slow && close > momentumClose) {
          candidates.push(symbol);
        }
      }
      history.set(symbol, data);
    }

    if (batch.seq < state.warmupBars || batch.seq < 0) return [];

    const orderCap = state.hello.caps.max_orders_per_bar;
    if (sells.length > 0) return sells.slice(0, orderCap);

    const slots = Math.min(state.hello.symbols.length, state.hello.caps.max_open_positions);
    const room = Math.max(0, slots - state.positions.size);
    const buyCount = Math.min(room, orderCap, candidates.length);
    if (buyCount === 0) return [];

    const perSlot = state.equity / BigInt(slots);
    const weightCap = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
    const availableCash = state.cash / BigInt(buyCount);
    const base = [perSlot, weightCap, availableCash].reduce((min, amount) => amount < min ? amount : min);
    const stake = (base * STAKE_BPS) / BPS;
    if (stake < BigInt(state.hello.fees.min_notional_quote_units) || stake <= 0n) return [];

    return candidates.slice(0, buyCount).map((symbol) => ({
      side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS,
    }));
  },
});
