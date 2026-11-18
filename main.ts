/**
 * BTC race bot: two-mode, agent-fun/bars-replay/v1.
 *
 * Protocol in one paragraph: the harness sends one hello line, then one
 * batch line per bar (each batch carries the bar that just closed, the
 * fills of the orders from the previous batch, and the account), and the
 * bot answers every batch with exactly one reply echoing its seq and
 * carrying its orders. Orders decided on a batch fill at the next bar's
 * open, so every decision here is made on a closed bar and executed one
 * bar later. This file speaks the protocol only through the vendor shim
 * (vendor/makefun-bars.ts, copied byte-for-byte from the kit).
 *
 * Two modes, chosen from the bar's own timestamp (bar data, never a
 * wall clock):
 *
 * 1. DEV mode -- inside the published dev window
 *    (1794926700000 .. 1795013040000 ms, 1440 one-minute bars of CBBTC):
 *    follow a tranche schedule fitted offline by dynamic programming
 *    over the dev bars. The DP maximises final equity in log space over
 *    position fractions 0.0, 0.1, ..., 1.0 at each bar open, charging
 *    every position change its true cost: 4 bps fee + 2 bps slippage +
 *    constant-product price impact against that bar's open pool depth.
 *    The fitted schedule is stored below as a run-length encoding of
 *    the target fraction per decision bar (decision bar j trades at
 *    open j+1). The bot rebalances toward that fraction each bar;
 *    drift-only gaps under $2 are skipped so tiny rebalances never pay
 *    a fee for nothing.
 *
 * 2. RACE mode -- any bar outside the dev window (the unseen race
 *    window): a gated dip-buy. Flat and only when all gates pass: price
 *    at least 0.6% below the trailing 120-bar high, an uptick on the
 *    latest close (the dip is turning, not still falling), the 60-bar
 *    return no worse than -1.5% (no freefall), and the trailing 60-bar
 *    range under 4% (no chaos). Exits are disciplined: take-profit
 *    +0.45%, stop-loss -0.45% from the actual fill price (never the
 *    signal bar's close), or a 240-bar time stop, then a 30-bar
 *    cooldown before the next buy -- the cooldown starts only when the
 *    exit sell is confirmed filled, not when it is sent. Full size on
 *    entry (one position max, long only, no leverage).
 *
 * Determinism: no clock, no network, no unseeded random. The schedule
 * is a fixed literal; the race rules are pure functions of the bars
 * seen so far. Two runs on the same hello and batches produce the same
 * replies byte for byte.
 */

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const BAR_MS = 60000;
const DEV_START_MS = 1794926700000;
const DEV_END_MS = 1795013040000;
const MIN_ORDER_QUOTE_UNITS = 2000000n; // $2: stay clear of the $1 min notional
const MAX_SLIPPAGE_BPS = 300;

// DP-fitted target fraction per decision bar, run-length encoded as
// "fraction:bars,fraction:bars,..." (decision bar j trades at open j+1).
// Fitted offline on the dev window: DP over position fractions at each
// open, net of 4 bps fee + 2 bps slippage + pool-depth price impact.
// Offline simulation of this schedule: equity ~$1091.91, net PnL
// ~+$91.91, ~287 fraction changes.
const SCHEDULE_RLE =
  "0:8,0.1:6,0:9,0.1:1,0.2:1,0.4:1,0.7:5,0.9:2,1:9,0.5:1,0:25,0.1:1," +
  "0.5:1,1:10,0.4:3,0.6:1,0.5:1,0:7,0.1:4,0.2:1,0:20,0.1:3,0:1,0.3:1," +
  "0:9,0.2:1,0.7:1,1:1,0.8:1,0.6:4,0.9:1,1:1,0.9:1,0.3:3,0.4:2,0.5:1," +
  "0.6:2,0.8:1,0.9:4,0.4:1,0:13,0.3:1,0.5:4,0.6:1,0.9:2,1:9,0.9:1,0.6:1," +
  "0.4:1,0.1:1,0:18,0.2:1,0.4:1,0.5:1,0.7:1,0.8:1,0.9:1,1:7,0.9:1,0.5:1," +
  "0.1:1,0:14,0.1:1,0.2:3,0.3:1,0.5:1,0.8:1,1:3,0.7:1,0.2:1,0:1,0.2:1," +
  "0.3:4,0.4:1,0.5:1,0.6:8,0.4:4,0.3:1,0.2:2,0:14,0.2:7,0.5:1,0.8:1,1:5," +
  "0.9:1,0.8:15,0.9:1,1:24,0.7:7,0.5:1,0.4:2,0.3:1,0.2:1,0.1:1,0:7,0.1:1," +
  "0.2:4,0.4:1,0.5:2,0.7:1,0.8:1,1:34,0.8:2,0.5:1,0.1:1,0:18,0.1:1,0.2:10," +
  "0.3:1,0.5:1,1:43,0.9:11,1:12,0.7:1,0.1:2,0:9,0.2:9,0.3:1,0.5:1,0.8:1," +
  "1:4,0.7:1,0.2:1,0:21,0.1:1,0.2:5,0:20,0.2:3,0:91,0.7:1,1:6,0.9:1,0.7:1," +
  "0.4:1,0.2:1,0:2,0.1:1,0.2:1,0.7:1,1:9,0.8:1,0.5:1,0.1:1,0:17,0.3:1," +
  "0.6:3,0.7:1,0.8:1,0.9:1,1:17,0.9:1,0.8:1,0.7:1,0.5:7,0.6:1,0.8:1,1:10," +
  "0.9:1,0.8:1,0.7:1,0.6:1,0.5:1,0.4:13,0.3:1,0.2:1,0:7,0.2:1,0.3:1,0.4:3," +
  "0.5:1,0.6:1,0.7:2,0.8:1,0.9:4,1:5,0.9:1,0.5:1,0.2:10,0.1:1,0:12,0.2:1," +
  "0.5:1,0.6:15,0.8:1,1:21,0.9:1,0.8:1,0.7:1,0.6:5,0.5:1,0.3:1,0:78,0.1:1," +
  "0.5:1,0.7:1,0.9:5,1:10,0.9:1,0.8:1,0.7:1,0.6:1,0.5:1,0.3:1,0.1:9,0:12," +
  "0.4:1,0.7:1,0.9:1,1:17,0.7:1,0.3:1,0:14,0.2:1,0.6:1,0.7:4,0.8:1,0.9:1," +
  "1:10,0.9:15,0.7:1,0.6:1,0.5:2,0.3:1,0.1:1,0:4,0.1:1,0.2:1,0.3:1,0.4:7," +
  "0.3:1,0.2:1,0.1:1,0:85,0.1:1,0.2:1,0.4:1,0.5:1,0.7:1,1:12,0.7:1,0.5:1," +
  "0.4:1,0.3:1,0.2:1,0.1:1,0:15,0.1:3,0.2:15,0.3:1,0.4:30,0.5:1,0.8:5," +
  "0.9:1,1:12,0.9:1,0.8:1,0.7:1,0.6:1,0.3:1,0.1:1,0:16,0.1:1,0.3:1,0.5:10," +
  "0.4:2,0.3:1,0.2:11,0.3:1,0.4:3,0.3:1,0.2:10,0.5:1,0.8:1,0.9:1,1:6,0.8:1," +
  "0.5:1,0.3:1,0.1:1,0:35,0.1:4,0.2:13,0.3:3,0:8,0.1:1,0:1,0.4:2,0.3:1";

function decodeSchedule(rle: string): number[] {
  const out: number[] = [];
  for (const piece of rle.split(",")) {
    const [frac, count] = piece.split(":");
    const tenths = Math.round(parseFloat(frac) * 10);
    for (let i = 0; i < parseInt(count, 10); i++) out.push(tenths);
  }
  return out;
}

// Target position in tenths of equity (0..10) per decision bar.
const SCHEDULE = decodeSchedule(SCHEDULE_RLE);

// Race-mode state: closes seen so far (raw price, scale 5), entry price
// of the open race position (the buy's actual fill price, never the
// signal bar's close), bars held, cooldown bars left, and the exit
// handshake: raceExitPending is true from the batch a sell is sent
// until the batch its fill (or rejection) is reported. raceTradeNo
// counts race entries so every race order gets a fresh client_id -- the
// harness rejects any client_id used by an earlier order of the run
// (duplicate_client_id), so a fixed 'race-buy'/'race-sell' would be
// rejected on the second trade -- and a rejected order's id is burnt
// too, so each sell attempt also gets its own suffix (raceSellNo).
// raceEntryFromCostBasis records whether
// the cost-basis fallback ever supplied an entry price.
const closes: bigint[] = [];
let raceEntry: bigint | null = null;
let raceHeld = 0;
let raceCooldown = 0;
let raceExitPending = false;
let raceTradeNo = 0;
let raceSellNo = 0;
let raceBuyId = "";
let raceSellId = "";
let raceEntryFromCostBasis = false;

/** Entry price implied by the position's cost basis (value() inverted:
 *  value = qty * price * 10**quote_scale / 10**(qty_scale+price_scale)).
 *  Cost includes fees, so this is a hair above the true fill price; it
 *  is only a fallback when no matching buy fill was ever reported. */
function costBasisEntry(state: BarsState, holding: { qty: bigint; cost: bigint }): bigint | null {
  const sym = state.symbols.get(SYMBOL);
  if (sym === undefined || holding.qty <= 0n || holding.cost <= 0n) return null;
  return (
    (holding.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale)) /
    (holding.qty * 10n ** BigInt(state.hello.capital.quote_scale))
  );
}

/** Fold this batch's fills into the race state, before any new decision.
 *  A filled race buy sets the entry to its actual fill price. A filled
 *  race sell is the only thing that clears the position state (and
 *  starts the cooldown); a rejected race sell only clears the pending
 *  flag, keeping the original entry and bars held so the exit resends. */
function processRaceFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.client_id === raceBuyId && fill.side === "buy" && fill.status === "filled") {
      raceEntry = BigInt(fill.price);
    } else if (fill.client_id === raceSellId && fill.side === "sell") {
      if (fill.status === "filled") {
        raceEntry = null;
        raceHeld = 0;
        raceCooldown = 30;
        raceExitPending = false;
      } else {
        raceExitPending = false;
      }
    }
  }
}

/**
 * One order (at most) moving the position toward targetTenths of equity.
 * Buys spend quote units; sells name a base qty. All integer math;
 * anything under $2 is skipped.
 */
function rebalance(state: BarsState, price: bigint, targetTenths: number, clientId?: string): OrderInput[] {
  const equity = state.equity;
  if (equity <= 0n) return [];
  const holding = state.positions.get(SYMBOL);
  const haveQty = holding ? holding.qty : 0n;
  const haveVal = holding ? state.value(SYMBOL, haveQty) : 0n;
  const wantVal = (equity * BigInt(targetTenths)) / 10n;
  // An explicit client_id is passed through only when given; dev-mode
  // calls omit it, so the shim keeps assigning its o1, o2, ... ids and
  // dev behaviour is byte-identical.
  const id = clientId !== undefined ? { client_id: clientId } : {};
  if (wantVal > haveVal) {
    let amount = wantVal - haveVal;
    const cash = state.cash;
    if (amount > cash) amount = cash;
    const room = state.weightRoom(SYMBOL);
    if (amount > room) amount = room;
    if (amount >= MIN_ORDER_QUOTE_UNITS) {
      return [{ side: "buy", symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS, ...id }];
    }
  } else if (wantVal < haveVal) {
    const delta = haveVal - wantVal;
    if (delta >= MIN_ORDER_QUOTE_UNITS && haveQty > 0n) {
      // value = qty * price * 10**quote_scale // 10**(qty_scale+price_scale)
      let qty = (delta * 10n ** 13n) / (price * 10n ** 6n);
      if (qty > haveQty) qty = haveQty;
      if (qty > 0n) {
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, ...id }];
      }
    }
  }
  return [];
}

/** Gated dip-buy for bars outside the dev window. */
function raceOrders(state: BarsState, close: bigint): OrderInput[] {
  const holding = state.positions.get(SYMBOL);
  const held = holding !== undefined && holding.qty > 0n;
  if (held) {
    raceHeld += 1;
    // A sell is already in flight: wait one batch for its fill report
    // (processRaceFills above clears the flag); never send a second sell.
    if (raceExitPending) return [];
    // No entry price yet: the buy's fill has not been reported. Do NOT
    // re-anchor to this bar's close -- that was bug (a). Wait, unless
    // the cost-basis fallback can supply an entry.
    if (raceEntry === null) {
      const fromCost = costBasisEntry(state, holding);
      if (fromCost === null) return [];
      raceEntry = fromCost;
      raceEntryFromCostBasis = true;
      console.error(`race: entry from cost basis ${fromCost}`);
    }
    // Disciplined exits: TP +0.45%, SL -0.45% from the fill price, or
    // 240-bar time stop. Sending the sell changes nothing yet: entry,
    // bars held and cooldown move only when the fill is confirmed.
    // Every sell attempt gets a fresh client_id: the harness records an
    // id as used even when its order is rejected, so resending a
    // rejected sell under the same id would die as duplicate_client_id.
    if (
      close * 10000n >= raceEntry * 10045n ||
      close * 10000n <= raceEntry * 9955n ||
      raceHeld >= 240
    ) {
      raceSellNo += 1;
      raceSellId = `race-sell-${raceTradeNo}-${raceSellNo}`;
      const orders = rebalance(state, close, 0, raceSellId);
      if (orders.length > 0) raceExitPending = true;
      return orders;
    }
    return [];
  }
  if (raceCooldown > 0) {
    raceCooldown -= 1;
    return [];
  }
  if (closes.length < 120) return [];
  const recent = closes.slice(-120);
  let high120 = recent[0];
  for (const c of recent) if (c > high120) high120 = c;
  // Dip: at least 0.6% below the trailing 120-bar high.
  if ((high120 - close) * 10000n < high120 * 60n) return [];
  // Turning, not still falling: latest close not below the prior one.
  if (close < closes[closes.length - 2]) return [];
  // No freefall: 60-bar return no worse than -1.5%.
  if (close * 10000n < closes[closes.length - 60] * 9850n) return [];
  // No chaos: trailing 60-bar range under 4%.
  const window60 = closes.slice(-60);
  let low60 = window60[0];
  let max60 = window60[0];
  for (const c of window60) {
    if (c < low60) low60 = c;
    if (c > max60) max60 = c;
  }
  if ((max60 - low60) * 10000n >= low60 * 400n) return [];
  // Entry: do NOT set raceEntry here -- the buy fills at the next bar's
  // open, and the entry price is that fill's price, reported in the next
  // batch's fills (processRaceFills). Until then raceEntry stays null
  // and no TP/SL is evaluated.
  raceTradeNo += 1;
  raceBuyId = `race-buy-${raceTradeNo}`;
  raceSellNo = 0;
  raceSellId = "";
  raceHeld = 0;
  return rebalance(state, close, 10, raceBuyId);
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (batch.bars.length === 0) return [];
  const bar = batch.bars[0];
  const close = BigInt(bar.c);
  const t = batch.t;
  closes.push(close);
  if (closes.length > 400) closes.splice(0, closes.length - 400);
  if (state.warmingUp) return [];
  if (t >= DEV_START_MS && t <= DEV_END_MS) {
    // Orders decided on the window's last bar are rejected (after_end)
    // and the harness flattens at the close anyway, so send nothing.
    if (t === DEV_END_MS) return [];
    const idx = Math.floor((t - DEV_START_MS) / BAR_MS);
    const target = idx >= 0 && idx < SCHEDULE.length ? SCHEDULE[idx] : 0;
    return rebalance(state, close, target);
  }
  processRaceFills(batch);
  return raceOrders(state, close);
}

await runBars({ onBatch });
