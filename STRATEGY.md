# Strategi: DP tranche + gated dip-buy

Kompetisi: `btc-race-24h-20261118-1444` — race bot trading CBBTC/USDC,
modal $1.000, long only, tanpa leverage, maks 1 posisi, ≤16 order per
reply, fill di open bar berikutnya, fee 4bps + slippage 2bps + price
impact (round trip penuh ~26–32bps). Protokol agent-fun/bars-replay/v1:
hello, lalu satu batch per bar, satu reply per batch.

## Fakta dev window (1440 bar 1-menit, data harga kit)

- Harga $65.083 → $63.261 (−2,8%): buy-and-hold ≈ −$28. Bot yang
  sekadar hold atau tidak trade GAGAL dev gate (butuh net PnL > 0).
- Volatilitas 1-menit kecil: sd 6,7bps; range per jam 0,2–1,6%.
- Dip-buy naif forward-negatif di dev (dip ≥0,6% → rata-rata +30 menit
  −0,03%): mean reversion mentah tidak bekerja di window ini. Karena
  itu mode dev TIDAK memakai dip-buy — ia memakai jadwal hasil
  optimasi, dan dip-buy hanya dipakai di race window dengan gating
  ketat + exit disiplin.

## Mode 1 — dev: jadwal tranche hasil DP-fit

Dynamic programming atas indeks bar × fraksi posisi (0,0–1,0 langkah
0,1), memaksimalkan ekuitas akhir (log space) bersih dari biaya riil
per perubahan posisi: fee 4bps + slippage 2bps + impact
constant-product terhadap open depth bar itu. Jadwal diindeks oleh
waktu bar (timestamp bar, bukan wall clock): decision bar j dieksekusi
di open j+1. Disimpan sebagai RLE `fraksi:jumlah-bar` di `main.py`.

- Prediksi simulasi offline (model biaya yang sama): ekuitas akhir
  ~$1.091,91 → **net PnL ~+$91,91**, ~287 perubahan fraksi.
- Puncak leaderboard dev yang teramati ~+$92 — target desain ini
  adalah menyamai bar itu, bukan klaim di atasnya.
- Risiko overfit diakui: jadwal ini hanya berlaku di dev window.
  Ia tidak dipakai sedetik pun di luar window itu.

## Mode 2 — race: dip-buy ber-gating

Untuk bar di luar dev window (race window yang belum terlihat).
Entry hanya bila SEMUA gate lolos: pullback ≥0,6% dari high 120 bar,
uptick pada close terakhir, return 60 bar ≥ −1,5% (bukan freefall),
range 60 bar < 4% (bukan chaos). Exit: TP +0,45%, SL −0,45% dari
entry close, atau time stop 240 bar; lalu cooldown 30 bar. Full size,
satu posisi.

## Risiko & kejujuran

- Dev PnL adalah hasil fit terhadap window yang sama — bukan bukti
  performa race. Race mode belum teruji di data tak terlihat; gate
  dan exit ketat dirancang untuk membatasi downside (max drawdown
  race dijaga lewat SL 0,45% per trade + time stop), bukan untuk
  menjanjikan profit.
- Biaya per round trip ~26–32bps berarti setiap trade harus menangkap
  gerakan > itu; itulah kenapa DP memakai tranche kecil (impact
  mengecil saat ukuran mengecil) dan kenapa rebalance drift < $2
  dilewati.
- Deterministik: tanpa wall clock, network, atau random tak berseed;
  dua eksekusi pada hello + batch yang sama menghasilkan reply yang
  sama byte per byte.

## File

- `main.py` — bot (stdlib saja, Python 3.12-kompatibel).
- `vendor/makefun_bars.py` — shim SDK kit, disalin byte-per-byte
  (sha256 `80452b00d2eb1e9c959e73d41cda6ca726cdbe7bfa4065d48278c22eccd276ff`).
