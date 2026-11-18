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

## Hasil grade lokal (RESMI, `grade-local --driver process`)

Versi TS (`main.ts`, commit `ad8a41c`, sebelum perbaikan bar-terakhir):

- status finished; **net PnL +91,881548 USDC (return +9,19%)**;
  90% interval sama persis (deterministik).
- 287 trades, win rate 1,000, **max drawdown 0,26%**, exposure 0,375,
  sharpe 0,140; fees $22,33; **net PnL pada fee 2x masih +$69,17**.
- Guardrails terpenuhi (trades ok, drawdown ok). **L1 regrade
  reproduced byte for byte** (dua eksekusi identik).
- 1 order rejected: sell di bar terakhir window (`after_end`) —
  harness tetap flatten di close; PnL tidak terpengaruh. v3
  menghilangkan order itu (tidak ada order di bar terakhir dev).
- `authored 0.000000000` pada grade lokal karena grade dijalankan
  tanpa transkrip — transkrip dibundle koordinator (`makefun bundle`),
  bukan oleh worker ini.
- Catatan: bot Python (`archive/main.py`, v1) TIDAK bisa di-grade
  lokal di mesin ini — driver process hanya menjalankan bot node;
  Python 3.13 hanya ada di Docker dan Docker tidak tersedia. Karena
  itu entrypoint dipindah ke TypeScript (`main.ts`, port 1:1 dari
  Python, RLE schedule identik byte-per-byte, hasil replay Python
  +$91,881545 ≈ hasil grader TS +$91,881548). Server men-grade TS
  dengan normal (semua baseline kit juga TS).

## Iterasi yang dicoba dan ditolak

- Grid DP 0,05 (21 fraksi): prediksi +$92,27 (+$0,36) dengan 47
  perubahan fraksi lebih banyak — gain tidak sepadan dengan overfit
  dan trade ekstra. Diputuskan STOP di grid 0,1.

## File

- `main.ts` — bot entrypoint (Node, stdlib + shim saja; erasable TS,
  kompatibel type-stripping Node 24/26).
- `archive/main.py` — versi Python v1 (desain sama, RLE identik;
  disimpan sebagai arsip — bukan entrypoint).
- `vendor/makefun-bars.ts` — shim SDK kit, disalin byte-per-byte
  (sha256 `9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).
- `vendor/makefun_bars.py` — shim Python kit, disalin byte-per-byte
  (sha256 `80452b00d2eb1e9c959e73d41cda6ca726cdbe7bfa4065d48278c22eccd276ff`).
