// SPDX-License-Identifier: MIT
// EarlyMomentum — a paper-money momentum bot for pump.fun-style bonding
// curves, speaking agent-fun/replay/v2 through the kit's vendor shim.
//
// Idea, in one paragraph: most new pump.fun coins either run up fast in
// their first minutes or fade to nothing, so the bot only buys young coins
// that are already proving demand — price up from where the bot first saw
// it, recent trades still pushing it up, and buy flow beating sell flow —
// then exits on a fixed take-profit, a fixed stop-loss, a trailing drop
// off the peak, or a time stop. One small buy per coin, at most five open
// positions, never more than the harness's 1%-of-real-reserve buy cap.
// Every decision comes only from the hello message and the batches the
// harness sends (events, marks, fills, account); there is no clock, no
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
const TARGET_BUY = 100_000_000n; // 0.10 SOL per entry, before the reserve cap
const MIN_BUY = 12_000_000n; // 0.012 SOL: above the 0.01 SOL round-trip floor
const MIN_REAL_SOL = 3_000_000_000n; // need real reserves >= 3 SOL for a useful buy cap

// --- entry: a young coin proving demand ------------------------------------
// v2: stricter entry (dev v1: 567 round trips, 27% win rate, -2.94 SOL —
// the +10% entries caught too many fading tops). Demand a stronger run
// before chasing, and let the winners run instead of capping them at +30%.
const MAX_AGE_SLOTS = 1200; // coin created at most ~this many slots ago
const MIN_TRADES = 5; // at least this many trades seen before trusting it
const LOOKBACK = 12; // trades kept per coin for momentum + flow
const MOMENTUM = 1.15; // price now vs the price at first sight
const SHORT_MOMENTUM = 1.05; // price now vs 5 trades ago
const FLOW_RATIO = 1.6; // buy SOL vs sell SOL over the lookback window

// --- exit: cut losers fast, let runners run ---------------------------------
// v2: no fixed take-profit — a runner is sold only on a trailing drop off
// its peak, so one 2-10x coin can pay for many small -10% stops.
const TAKE_PROFIT = 10.0; // effectively off; the trail exit banks runners
const STOP_LOSS = 0.9; // sell when the mark value is -10% under cost
const TRAIL_TRIGGER = 1.25; // trailing exit arms once the peak is +25%
const TRAIL_DROP = 0.85; // ... then sell on a 15% fall from that peak
const MAX_HOLD_SLOTS = 2400; // stale-position time stop
const SELL_COOLDOWN_SLOTS = 600; // do not re-buy a coin just sold

// --- guardrail pacing: the run needs >= 20 distinct round-tripped coins ---
const TOTAL_SLOTS_EST = 100_000; // ~6h final window at the dev slot rate
const TARGET_COINS = 20;
const SLIPPAGE_BPS = 500;

interface Trade {
  price: number; // SOL per token, from virtual reserves after the trade
  sol: number; // SOL size of the trade
  buy: boolean;
}

interface Coin {
  createdSlot: number | null;
  firstPrice: number; // 0 until the first trade is seen
  recent: Trade[]; // last LOOKBACK trades, oldest first
  lastSellSlot: number; // slot of our last sell here, for the re-buy cooldown
  entrySlot: number; // slot the current position was first seen held
  peakValue: bigint; // best mark value (lamports) while the position is held
}

const coins = new Map<string, Coin>();
const bought = new Set<string>(); // mints with at least one filled buy
const roundTripped = new Set<string>(); // mints with a completed buy+sell
let firstSlot = -1;

function coinFor(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      createdSlot: null,
      firstPrice: 0,
      recent: [],
      lastSellSlot: -1,
      entrySlot: -1,
      peakValue: 0n,
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
    if (firstSlot < 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];
    const touched = new Set<string>(); // mints with a trade in this batch

    // Fold this batch's fills into the round-trip bookkeeping first.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy' && BigInt(fill.quote_lamports) > 0n) {
        bought.add(fill.mint);
      }
      if (fill.side === 'sell' && BigInt(fill.token_amount) > 0n && bought.has(fill.mint)) {
        roundTripped.add(fill.mint);
        coinFor(fill.mint).lastSellSlot = fill.slot;
      }
    }

    // Fold this batch's events into the per-coin tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coinFor(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint);
        const price =
          Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (c.firstPrice === 0) c.firstPrice = price;
        c.recent.push({
          price,
          sol: Number(e.sol_amount) / Number(LAMPORTS_PER_SOL),
          buy: e.is_buy,
        });
        if (c.recent.length > LOOKBACK) c.recent.shift();
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
      if (value > c.peakValue) c.peakValue = value;
      const cost = holding.cost_lamports;

      const up = Number(value) / Number(cost);
      const peakUp = Number(c.peakValue) / Number(cost);
      const stale = batch.slot - c.entrySlot > MAX_HOLD_SLOTS && up < 1.05;
      const trailing =
        peakUp >= TRAIL_TRIGGER && Number(value) <= Number(c.peakValue) * TRAIL_DROP;

      if (up >= TAKE_PROFIT || up <= STOP_LOSS || trailing || stale) {
        if (hasPending(state, mint, 'sell')) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        c.entrySlot = -1;
        c.peakValue = 0n;
      }
    }

    // --- entries: only young coins proving demand, with pacing relax ------
    const elapsed = batch.slot - firstSlot;
    const expectedCoins = (TARGET_COINS * elapsed) / TOTAL_SLOTS_EST;
    const relaxed =
      elapsed > 5000 && roundTripped.size < expectedCoins * 0.8;
    const maxAge = relaxed ? 3000 : MAX_AGE_SLOTS;
    const momentum = relaxed ? 1.05 : MOMENTUM;
    const shortMomentum = relaxed ? 1.02 : SHORT_MOMENTUM;
    const flowRatio = relaxed ? 1.2 : FLOW_RATIO;
    const minReal = relaxed ? 1_500_000_000n : MIN_REAL_SOL;

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
      if (c.createdSlot === null) continue;
      if (batch.slot - c.createdSlot > maxAge) continue;
      if (c.lastSellSlot >= 0 && batch.slot - c.lastSellSlot < SELL_COOLDOWN_SLOTS) continue;
      if (c.recent.length < MIN_TRADES) continue;
      if (curve.real_quote_reserves < minReal) continue;

      const last = c.recent[c.recent.length - 1];
      const fiveAgo = c.recent[Math.max(0, c.recent.length - 5)];
      if (c.firstPrice <= 0) continue;
      if (last.price < c.firstPrice * momentum) continue;
      if (last.price < fiveAgo.price * shortMomentum) continue;

      let buySol = 0;
      let sellSol = 0;
      for (const t of c.recent) {
        if (t.buy) buySol += t.sol;
        else sellSol += t.sol;
      }
      if (buySol < sellSol * flowRatio) continue;

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
    }

    return orders;
  },
});
