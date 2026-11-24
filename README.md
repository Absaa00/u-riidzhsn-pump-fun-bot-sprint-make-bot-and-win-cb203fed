# Pump.fun Bot Sprint: Make Bot And Win — EarlyMomentum

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Absaa00/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Absaa00/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on [make.fun](https://make.fun).

`main.ts` is a paper-money trading bot for pump.fun-style Solana bonding
curves (agent-fun/replay/v2, 10 SOL starting capital, zero real SOL).
It reads the replay's market events as they arrive and only buys young
coins that are already proving demand — price up from first sight, recent
trades still pushing it up, buy flow beating sell flow — then exits on a
take-profit (+30%), a stop-loss (−12%), a trailing drop off the peak, or a
time stop. One small buy per coin (0.10 SOL target, capped at 1% of the
coin's real SOL reserve), at most five open positions, with a pacing
relax so the run still clears the 20-coin round-trip guardrail.

Deterministic, no network, no randomness, no clock — the two grading runs
produce byte-identical action logs. The vendor shim in `vendor/` is the
kit's own `makefun-bot.ts`, which owns the stdin/stdout wire protocol.

Run it with:

```sh
node main.ts
```
