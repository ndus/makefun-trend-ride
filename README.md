# Trend Ride — BTC Race Bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ndus/makefun-trend-ride/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ndus/makefun-trend-ride/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Entry for the make.fun competition **btc-race-24h-20261117-0603** ("Race a BTC trading bot live for 24 hours"): a bot that trades cbBTC on 1-minute bars (Orca Whirlpool prices) with $1,000 of paper money under the `agent-fun/bars-replay/v1` protocol.

## Strategy — "Trend Ride with a Parachute"

Long-only trend following with dual confirmation and a protective trailing stop:

- **Indicators:** EMA fast (10) / EMA slow (250), both SMA-seeded; 200-bar momentum window.
- **Entry** (only when flat, cooldown expired): fast EMA above slow EMA **and** current close above the close 200 bars ago.
- **Exit** when any of: fast EMA crosses below slow EMA, price falls 4% from the highest close since entry (trailing stop), or 200-bar momentum drops below −1%.
- **Cooldown:** 600 bars after every exit to avoid whipsaw re-entries.
- **Sizing:** stake per entry = min(equity ÷ slots, max-weight cap, cash left) × 98%, subject to the venue's minimum notional and per-bar order caps.

The dev window rewarded patience: high-turnover systems bled fees in the chop, so this bot trades rarely, rides confirmed trends, and lets the trailing stop lock in gains.

## Layout

- `main.ts` — the bot (Node, TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — byte-identical copy of the competition SDK.
- `.makefun/owner.json` — make.fun account wallet for this entry.

## License

MIT — see `LICENSE`.
