// SPDX-License-Identifier: MIT
// EarlySniper v4 — a paper-money sniper bot for pump.fun-style bonding
// curves, speaking agent-fun/replay/v2 through the kit's vendor shim.
//
// Idea, in one paragraph: on this tape the money is made at the bottom of
// the curve, not by chasing strength. Coins that have already run +15%
// keep fading (median 0.90x a few minutes later), while a coin bought
// when its real SOL reserve first reaches ~1 SOL — price still near its
// creation level — rides the crowd that arrives after it. v4 exits fast
// instead of trailing runners: a fixed take-profit (+25%), a fixed
// stop-loss (-15%) and a short time stop. The faithful replay sim ranked
// this exit set least-bad on the dev window, and capping every loss at
// -15% keeps drawdown small while the fast turnover cycles through many
// coins. One small buy per coin, at most five open positions. Every
// decision comes only from the hello message and the batches the harness
// sends (events, marks, fills, account); there is no clock, no
// environment read, no randomness and no network, so the two grading runs
// produce byte-identical action logs.
//
// Money is paper only: 10 SOL of replay capital, zero real SOL moves.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

// --- sizing ---------------------------------------------------------------
// Buy as early as the 1%-of-real-reserve cap allows a useful size: the
// round-trip guardrail needs >= 0.01 SOL, so the reserve must be >= 1.2 SOL.
const TARGET_BUY = 50_000_000n; // 0.05 SOL per entry, before the reserve cap
const MIN_BUY = 12_000_000n; // 0.012 SOL
const MIN_REAL_SOL = 1_200_000_000n; // real reserves >= 1.2 SOL

// --- entry: first trade where the reserve is big enough --------------------
// Price must still be near where the bot first saw the coin: never chase
// a coin that already ran away, and only while it is still young.
const MAX_ENTRY_MULT = 1.5; // price now vs the price at first sight
const MAX_AGE_SLOTS = 3600; // coin created at most ~this many slots ago
const MIN_TRADES = 2; // at least this many trades seen before trusting it

// --- exit: fixed targets, fast turnover ------------------------------------
// v4: take-profit +25%, stop-loss -15%, short time stop. No trailing exit:
// the faithful replay sim ranked this exit set least-bad on the dev window.
const TAKE_PROFIT = 1.25; // sell when the mark value is +25% over cost
const STOP_LOSS = 0.85; // sell when the mark value is -15% under cost
const MAX_HOLD_SLOTS = 1800; // time stop: sell whatever it is worth by then
const SLIPPAGE_BPS = 500;

interface Coin {
  createdSlot: number | null;
  firstPrice: number; // SOL per token at the first trade seen (0 until then)
  trades: number; // trades seen on this coin
  entered: boolean; // the bot already bought this coin once: never re-buy
  entrySlot: number; // slot the current position was first seen held
}

const coins = new Map<string, Coin>();

function coinFor(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      createdSlot: null,
      firstPrice: 0,
      trades: 0,
      entered: false,
      entrySlot: -1,
    };
    coins.set(mint, c);
  }
  return c;
}

/** Mark value of a holding in lamports, from the curve's latest reserves. */
function markValue(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

function hasPending(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const touched = new Set<string>(); // mints with a trade in this batch

    // Fold this batch's events into the per-coin tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coinFor(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint);
        const price =
          Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (c.firstPrice === 0) c.firstPrice = price;
        c.trades += 1;
        touched.add(e.mint);
      }
    }

    // --- exits first: free the position slots before deciding entries -----
    for (const [mint, holding] of state.positions) {
      const c = coins.get(mint);
      if (c === undefined) continue;
      if (c.entrySlot < 0) c.entrySlot = batch.slot;
      const value = markValue(state, mint, holding.token_amount);
      if (value <= 0n) continue;
      const cost = holding.cost_lamports;

      const up = Number(value) / Number(cost);
      const stale = batch.slot - c.entrySlot > MAX_HOLD_SLOTS;

      if (up >= TAKE_PROFIT || up <= STOP_LOSS || stale) {
        if (hasPending(state, mint, 'sell')) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        c.entrySlot = -1;
      }
    }

    // --- entries: buy once per coin, as early as the reserve cap allows ---
    const maxPositions = state.hello.caps.max_open_positions;
    for (const mint of touched) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (state.committedPositionCount() >= maxPositions) break;
      if (state.positions.has(mint)) continue;
      if (hasPending(state, mint, 'buy')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      if (c.entered) continue; // one entry per coin, ever
      if (c.createdSlot === null) continue;
      if (batch.slot - c.createdSlot > MAX_AGE_SLOTS) continue;
      if (c.trades < MIN_TRADES) continue;
      if (c.firstPrice <= 0) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;

      // Price now, from the latest trade on this coin.
      const lastPrice =
        Number(curve.virtual_quote_reserves) /
        Number(curve.virtual_token_reserves);
      if (lastPrice > c.firstPrice * MAX_ENTRY_MULT) continue;

      // Size: target buy, capped by the harness's 1%-of-real-reserve rule
      // and by free cash (leaving room for the tx fees of this order).
      let size = TARGET_BUY;
      const cap = state.maxBuyLamports(mint);
      if (size > cap) size = cap;
      const free = state.freeCashLamports() - 2n * state.txFeeLamports();
      if (size > free) size = free;
      if (size < MIN_BUY) continue;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      c.entered = true;
    }

    return orders;
  },
});
