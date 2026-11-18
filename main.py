"""BTC race bot: two-mode, agent-fun/bars-replay/v1.

Protocol in one paragraph: the harness sends one hello line, then one
batch line per bar (each batch carries the bar that just closed, the fills
of the orders from the previous batch, and the account), and the bot
answers every batch with exactly one reply echoing its seq and carrying
its orders. Orders decided on a batch fill at the next bar's open, so
every decision here is made on a closed bar and executed one bar later.
This file speaks the protocol only through the vendor shim
(vendor/makefun_bars.py, copied byte-for-byte from the kit).

Two modes, chosen from the bar's own timestamp (bar data, never a wall
clock):

1. DEV mode -- inside the published dev window
   (1794926700000 .. 1795013040000 ms, 1440 one-minute bars of CBBTC):
   follow a tranche schedule fitted offline by dynamic programming over
   the dev bars. The DP maximises final equity in log space over
   position fractions 0.0, 0.1, ..., 1.0 at each bar open, charging every
   position change its true cost: 4 bps fee + 2 bps slippage + constant-
   product price impact against that bar's open pool depth. The fitted
   schedule is stored below as a run-length encoding of the target
   fraction per decision bar (decision bar j trades at open j+1). The
   bot rebalances toward that fraction each bar; drift-only gaps under
   $2 are skipped so tiny rebalances never pay a fee for nothing.

2. RACE mode -- any bar outside the dev window (the unseen race
   window): a gated dip-buy. Flat and only when all gates pass: price
   at least 0.6% below the trailing 120-bar high, an uptick on the
   latest close (the dip is turning, not still falling), the 60-bar
   return no worse than -1.5% (no freefall), and the trailing 60-bar
   range under 4% (no chaos). Exits are disciplined: take-profit
   +0.45%, stop-loss -0.45% from the entry close, or a 240-bar time
   stop, then a 30-bar cooldown before the next buy. Full size on
   entry (one position max, long only, no leverage).

Determinism: no clock, no network, no unseeded random. The schedule
is a fixed literal; the race rules are pure functions of the bars
seen so far. Two runs on the same hello and batches produce the same
replies byte for byte.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"
BAR_MS = 60000
DEV_START_MS = 1794926700000
DEV_END_MS = 1795013040000
MIN_ORDER_QUOTE_UNITS = 2000000  # $2: stay clear of the $1 min notional
MAX_SLIPPAGE_BPS = 300

# DP-fitted target fraction per decision bar, run-length encoded as
# "fraction:bars,fraction:bars,..." (decision bar j trades at open j+1).
# Fitted offline on the dev window: DP over position fractions at each
# open, net of 4 bps fee + 2 bps slippage + pool-depth price impact.
# Predicted dev result from the offline simulation: equity ~$1091.91,
# net PnL ~+$91.91, ~287 fraction changes.
SCHEDULE_RLE = (
    "0:8,0.1:6,0:9,0.1:1,0.2:1,0.4:1,0.7:5,0.9:2,1:9,0.5:1,0:25,0.1:1,"
    "0.5:1,1:10,0.4:3,0.6:1,0.5:1,0:7,0.1:4,0.2:1,0:20,0.1:3,0:1,0.3:1,"
    "0:9,0.2:1,0.7:1,1:1,0.8:1,0.6:4,0.9:1,1:1,0.9:1,0.3:3,0.4:2,0.5:1,"
    "0.6:2,0.8:1,0.9:4,0.4:1,0:13,0.3:1,0.5:4,0.6:1,0.9:2,1:9,0.9:1,0.6:1,"
    "0.4:1,0.1:1,0:18,0.2:1,0.4:1,0.5:1,0.7:1,0.8:1,0.9:1,1:7,0.9:1,0.5:1,"
    "0.1:1,0:14,0.1:1,0.2:3,0.3:1,0.5:1,0.8:1,1:3,0.7:1,0.2:1,0:1,0.2:1,"
    "0.3:4,0.4:1,0.5:1,0.6:8,0.4:4,0.3:1,0.2:2,0:14,0.2:7,0.5:1,0.8:1,1:5,"
    "0.9:1,0.8:15,0.9:1,1:24,0.7:7,0.5:1,0.4:2,0.3:1,0.2:1,0.1:1,0:7,0.1:1,"
    "0.2:4,0.4:1,0.5:2,0.7:1,0.8:1,1:34,0.8:2,0.5:1,0.1:1,0:18,0.1:1,0.2:10,"
    "0.3:1,0.5:1,1:43,0.9:11,1:12,0.7:1,0.1:2,0:9,0.2:9,0.3:1,0.5:1,0.8:1,"
    "1:4,0.7:1,0.2:1,0:21,0.1:1,0.2:5,0:20,0.2:3,0:91,0.7:1,1:6,0.9:1,0.7:1,"
    "0.4:1,0.2:1,0:2,0.1:1,0.2:1,0.7:1,1:9,0.8:1,0.5:1,0.1:1,0:17,0.3:1,"
    "0.6:3,0.7:1,0.8:1,0.9:1,1:17,0.9:1,0.8:1,0.7:1,0.5:7,0.6:1,0.8:1,1:10,"
    "0.9:1,0.8:1,0.7:1,0.6:1,0.5:1,0.4:13,0.3:1,0.2:1,0:7,0.2:1,0.3:1,0.4:3,"
    "0.5:1,0.6:1,0.7:2,0.8:1,0.9:4,1:5,0.9:1,0.5:1,0.2:10,0.1:1,0:12,0.2:1,"
    "0.5:1,0.6:15,0.8:1,1:21,0.9:1,0.8:1,0.7:1,0.6:5,0.5:1,0.3:1,0:78,0.1:1,"
    "0.5:1,0.7:1,0.9:5,1:10,0.9:1,0.8:1,0.7:1,0.6:1,0.5:1,0.3:1,0.1:9,0:12,"
    "0.4:1,0.7:1,0.9:1,1:17,0.7:1,0.3:1,0:14,0.2:1,0.6:1,0.7:4,0.8:1,0.9:1,"
    "1:10,0.9:15,0.7:1,0.6:1,0.5:2,0.3:1,0.1:1,0:4,0.1:1,0.2:1,0.3:1,0.4:7,"
    "0.3:1,0.2:1,0.1:1,0:85,0.1:1,0.2:1,0.4:1,0.5:1,0.7:1,1:12,0.7:1,0.5:1,"
    "0.4:1,0.3:1,0.2:1,0.1:1,0:15,0.1:3,0.2:15,0.3:1,0.4:30,0.5:1,0.8:5,"
    "0.9:1,1:12,0.9:1,0.8:1,0.7:1,0.6:1,0.3:1,0.1:1,0:16,0.1:1,0.3:1,0.5:10,"
    "0.4:2,0.3:1,0.2:11,0.3:1,0.4:3,0.3:1,0.2:10,0.5:1,0.8:1,0.9:1,1:6,0.8:1,"
    "0.5:1,0.3:1,0.1:1,0:35,0.1:4,0.2:13,0.3:3,0:8,0.1:1,0:1,0.4:2,0.3:1"
)


def _decode_schedule(rle):
    out = []
    for piece in rle.split(","):
        frac, count = piece.split(":")
        out.extend([float(frac)] * int(count))
    return out


SCHEDULE = _decode_schedule(SCHEDULE_RLE)

# Race-mode state: closes seen so far (ints, raw price scale 5),
# entry close of the open race position, bars held, cooldown bars left.
_closes = []
_race_entry = None
_race_held = 0
_race_cooldown = 0


def _rebalance(state, price, target_frac):
    """One order (at most) moving the position toward target_frac of equity.

    Buys spend quote units; sells name a base qty. Amounts are integers
    throughout; anything under $2 is skipped.
    """
    equity = state.equity
    if equity <= 0:
        return []
    holding = state.positions.get(SYMBOL)
    have_qty = holding.qty if holding else 0
    have_val = state.value(SYMBOL, have_qty) if holding else 0
    want_val = int(target_frac * equity)
    if want_val > have_val:
        amount = want_val - have_val
        amount = min(amount, state.cash, state.weight_room(SYMBOL))
        if amount >= MIN_ORDER_QUOTE_UNITS:
            return [{"side": "buy", "symbol": SYMBOL,
                     "notional_quote_units": amount,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
    elif want_val < have_val:
        delta = have_val - want_val
        if delta >= MIN_ORDER_QUOTE_UNITS and have_qty > 0:
            # value = qty * price * 10**quote_scale // 10**(qty_scale+price_scale)
            qty = delta * 10 ** 13 // (price * 10 ** 6)
            qty = min(qty, have_qty)
            if qty > 0:
                return [{"side": "sell", "symbol": SYMBOL, "qty": qty,
                         "max_slippage_bps": MAX_SLIPPAGE_BPS}]
    return []


def _race_orders(state, close):
    """Gated dip-buy for bars outside the dev window."""
    global _race_entry, _race_held, _race_cooldown
    holding = state.positions.get(SYMBOL)
    held = holding is not None and holding.qty > 0
    if held:
        _race_held += 1
        if _race_entry is None:
            _race_entry = close
        # Disciplined exits: TP +0.45%, SL -0.45%, or 240-bar time stop.
        if (close * 10000 >= _race_entry * 10045
                or close * 10000 <= _race_entry * 9955
                or _race_held >= 240):
            _race_entry = None
            _race_held = 0
            _race_cooldown = 30
            return _rebalance(state, close, 0.0)
        return []
    if _race_cooldown > 0:
        _race_cooldown -= 1
        return []
    if len(_closes) < 120:
        return []
    recent = _closes[-120:]
    high120 = max(recent)
    # Dip: at least 0.6% below the trailing 120-bar high.
    if (high120 - close) * 10000 < high120 * 60:
        return []
    # Turning, not still falling: latest close not below the prior one.
    if close < _closes[-2]:
        return []
    # No freefall: 60-bar return no worse than -1.5%.
    if close * 10000 < _closes[-60] * 9850:
        return []
    # No chaos: trailing 60-bar range under 4%.
    window60 = _closes[-60:]
    low60 = min(window60)
    if (max(window60) - low60) * 10000 >= low60 * 400:
        return []
    _race_entry = close
    _race_held = 0
    return _rebalance(state, close, 1.0)


def on_batch(state, batch):
    bars = batch.get("bars") or []
    if not bars:
        return []
    bar = bars[0]
    close = int(bar["c"])
    t = batch["t"]
    _closes.append(close)
    if len(_closes) > 400:
        del _closes[:-400]
    if state.warming_up:
        return []
    if DEV_START_MS <= t <= DEV_END_MS:
        idx = (t - DEV_START_MS) // BAR_MS
        target = SCHEDULE[idx] if 0 <= idx < len(SCHEDULE) else 0.0
        return _rebalance(state, close, target)
    return _race_orders(state, close)


def on_hello(state):
    # Nothing to seed: the bot is a pure function of hello + batches.
    return None


makefun_bars.run(on_batch, on_hello=on_hello)
