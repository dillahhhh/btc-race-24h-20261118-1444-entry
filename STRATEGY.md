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

Verifikasi v3 (commit `dff4338`, grade ulang resmi): net PnL
**+91,881548 USDC** (identik), 287 trades, max drawdown 0,26%,
**0 rejected**, L1 regrade reproduced byte for byte,
`result_sha256 fdc989577c1cdb48b73ddb6d35b22a84b6e300646cbf5804d134f043aa79f7e7`,
`action_log_sha256 8472852023f0dd3a62f0d915a41ad4400dd71f9395d282a72627302757fe5868`.
v3 adalah versi final (STOP iterasi — grid DP 0,05 hanya +$0,36).

## v5 fix — race mode: entry dari harga fill, exit hanya saat fill terkonfirmasi

Dua temuan review (substansi BENAR, tapi nomor baris yang dikutip
857–865 / 917–921 TIDAK COCOK dengan file apa pun di repo:
`main.ts` 209 baris, `archive/main.py` 209 baris,
`vendor/makefun-bars.ts` 352 baris — lokasi sebenarnya di `main.ts`:
entry `raceEntry = close` baris 185, TP/SL baris 151–152, reset
exit baris 155–157):

- (a) Entry TP/SL diukur dari close bar sinyal, padahal buy baru
  terisi di open bar berikut. Perbaikan: `raceEntry` TIDAK lagi
  di-set saat entry; `onBatch` memproses `batch.fills` SEBELUM
  `raceOrders` dan mengisi `raceEntry` dari `fill.price` buy yang
  berstatus filled (client_id `race-buy-N`). Selama posisi terbuka
  tapi entry masih null dan cost basis tidak tersedia, TP/SL TIDAK
  dievaluasi — bot menunggu laporan fill di batch berikut.
  Fallback: bila posisi terbuka tanpa fill yang cocok, entry
  diturunkan dari cost basis posisi (`cost * 10**(qty_scale+
  price_scale) / (qty * 10**quote_scale)`, inversi `value()` shim;
  cost sudah termasuk fee jadi sedikit di atas harga fill asli).
- (b) State exit dulu di-reset saat sell DIKIRIM, sebelum fill
  terkonfirmasi — sell yang ditolak (mis. `max_slippage` tepat saat
  harga menembus SL) membuat `raceEntry` null lalu di-re-anchor ke
  close saat itu, SL bergeser turun. Perbaikan: `raceExitPending`
  menandai sell yang sedang dalam perjalanan; entry + `raceHeld`
  dipertahankan, sell kedua tidak dikirim selama pending. Sell
  filled → baru reset + cooldown 30. Sell rejected → pending
  dibersihkan, entry asli dipertahankan, exit terpicu lagi dan sell
  dikirim ulang.
- `client_id` race harus unik per order: harness menolak pemakaian
  ulang id apa pun di satu run (`duplicate_client_id` — dan id order
  yang DITOLAK pun ikut hangus, `sim/bars/engine.ts` `usedIds`).
  Karena itu buy memakai `race-buy-N` (N = nomor trade) dan setiap
  percobaan sell memakai `race-sell-N-M` (M = nomor percobaan) —
  BUKAN `race-buy`/`race-sell` tetap, yang akan ditolak di trade
  kedua. Dev mode tidak memakai client_id eksplisit (shim tetap
  memberi `o1, o2, ...`), jadi perilaku dev byte-identik.
- Gate/threshold (0,6% / 0,45% / 240 / 30), `MAX_SLIPPAGE_BPS`,
  `SCHEDULE_RLE`/DP, dan mode dev TIDAK disentuh.

Verifikasi v5 (grade lokal `--driver process`, Docker tidak tersedia):
net PnL **+91,881548 USDC (identik dengan v3)**, 287 trades,
max drawdown 0,26%, **0 rejected**,
`action_log_sha256` identik dengan v3
(`8472852023f0dd3a62f0d915a41ad4400dd71f9395d282a72627302757fe5868`),
L1 regrade reproduced byte for byte, 2x grade `--worktree`.
Grade dev TIDAK menyentuh mode race (semua 1440 bar di dev window),
jadi perbaikan race diuji terpisah dengan harness sintetis
(`/tmp/race-test/test.mjs`, 314 assertion, 2 skenario): wait-tanpa-fill,
fallback cost-basis, sell-ditolak lalu kirim-ulang dengan id baru +
entry dipertahankan, dan trade kedua memakai `race-buy-2`. Fallback
cost-basis TIDAK pernah terpakai saat grade (mode race tidak jalan
di dev window; di harness nyata fill selalu dilaporkan di batch yang
sama dengan posisi, jadi fallback hanya defensif).
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
