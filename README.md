# Pump.fun Bot Sprint: Make Bot And Win — EarlySniper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Absaa00/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Absaa00/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun).

`main.ts` is a paper-money trading bot for pump.fun-style Solana bonding
curves (agent-fun/replay/v2, 10 SOL starting capital, zero real SOL).
It reads the replay's market events as they arrive and buys each coin
once, as early as the 1%-of-real-reserve buy cap allows a useful size —
when the coin's real SOL reserve first reaches ~1.2 SOL, price still near
its creation level — then exits fast on a take-profit (+25%), a
stop-loss (−15%), or a short time stop. On this tape, coins that already
ran +15% keep fading, and capping every loss keeps drawdown small while
fast turnover cycles through many coins. One small buy per coin (0.05
SOL target), at most five open positions.

Deterministic, no network, no randomness, no clock — the two grading runs
produce byte-identical action logs. The vendor shim in `vendor/` is the
kit's own `makefun-bot.ts`, which owns the stdin/stdout wire protocol.

Run it with:

```sh
node main.ts
```
