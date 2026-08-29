# Implementation Plan

- [x] 1. Tulis bug condition exploration tests (SEBELUM implement fix)
  - **Property 1: Bug Condition** - 6 Bug Scenarios (BUG-01 s/d BUG-06)
  - **CRITICAL**: Test-test ini HARUS GAGAL pada kode yang belum di-fix — kegagalan membuktikan bug ada
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: Test ini mengenkode expected behavior — akan memvalidasi fix ketika pass setelah implementasi
  - **GOAL**: Tampilkan counterexample yang membuktikan bug ada
  - **Scoped PBT Approach**: Untuk bug deterministik, scope property ke kasus konkret yang gagal agar reprodusibel

  **BUG-01 — Pesan stok kosong:**
  - Bug Condition: `isBugCondition_01` → `stockDB.count({ product_id }) = 0` AND `product.type = 'AUTO'`
  - Tulis test: order produk `AUTO` tanpa stok apapun di DB → assert `result[0].content` matches `/Habis stok/`
  - Jalankan pada kode unfixed: ekspektasi GAGAL karena mendapat `"❌ Link belum diisi admin..."`
  - Dokumentasikan counterexample: `content = "❌ Link belum diisi admin. Hubungi Admin untuk mendapat akses."`
  - Test referensi: SIM-01a sudah ada di `tests/simulation/sim-store-edge.test.js`

  **BUG-02 — Batas quantity:**
  - Bug Condition: `isBugCondition_02` → `orderItem.quantity > 1 AND availableStockCount > 0 AND availableStockCount < quantity`
  - Tulis test: `quantity: 2`, stok tersedia: 1 → assert tepat 1 delivery berhasil, 1 delivery mengandung `"Habis"`
  - Jalankan pada kode unfixed: ekspektasi GAGAL karena mendapat 2 delivery berhasil dari 1 stok fisik
  - Dokumentasikan counterexample: `delivered.length = 2` padahal stok = 1
  - Test referensi: SIM-01b sudah ada di `tests/simulation/sim-store-edge.test.js`

  **BUG-03 — Idempotency:**
  - Bug Condition: `isBugCondition_03` → `callCount >= 2 AND EXISTS OrderItem WHERE fulfilled = 1`
  - Tulis test: panggil `fulfillOrder(orderId)` dua kali → assert `Stock.countDocuments({status:'SOLD'}) = 1`
  - Jalankan pada kode unfixed: ekspektasi GAGAL karena count = 2 (stok diklaim ganda)
  - Dokumentasikan counterexample: `soldCount = 2` padahal seharusnya 1
  - Test referensi: SIM-01c sudah ada di `tests/simulation/sim-store-edge.test.js`

  **BUG-06 — rotationIndex HOT segment:**
  - Bug Condition: `isBugCondition_06` → `segment = 'HOT' AND prodList.length > 1 AND usageLineOf < declarationLineOf`
  - Tulis test: panggil `runNonBuyerCampaign` untuk user HOT dengan `prodList` 3 produk berbeda
  - Hitung expected: `rotationIndex = (userIdNum + dayOfYear) % prodList.length`
  - Assert pesan yang dibuild mengandung `prodList[rotationIndex].name`, bukan selalu `prodList[0].name`
  - Jalankan pada kode unfixed: ekspektasi GAGAL karena `rotationIndex` undefined saat digunakan, selalu jatuh ke `prodList[0]`
  - Dokumentasikan counterexample: produk yang dipilih selalu `prodList[0]` meskipun `rotationIndex = 1` atau `2`
  - Scope ke kasus konkret: `userId` yang menghasilkan `rotationIndex != 0` (misal userId=5, dayOfYear=100, prodList.length=3 → rotationIndex=2)

  - Jalankan semua exploration tests: `npx jest tests/simulation/sim-store-edge.test.js --runInBand`
  - **EXPECTED OUTCOME**: SIM-01a, SIM-01b, SIM-01c GAGAL (membuktikan BUG-01/02/03 ada)
  - Mark task complete ketika test sudah ditulis, dijalankan, dan kegagalan terdokumentasi
  - _Requirements: 1.1, 1.2 (BUG-01), 1.3, 1.4 (BUG-02), 1.5, 1.6 (BUG-03), 1.11, 1.12 (BUG-06)_

- [x] 2. Tulis preservation property tests (SEBELUM implement fix)
  - **Property 2: Preservation** - Perilaku Normal fulfillOrder dan Non-HOT Segment
  - **IMPORTANT**: Ikuti observation-first methodology
  - Observasi perilaku pada kode unfixed untuk input non-buggy (isBugCondition = false)

  **Observasi yang perlu diverifikasi pada kode unfixed:**
  - Observe: `fulfillOrder` dengan 1 stok `AVAILABLE` → 1 delivery berhasil dengan konten stok tersebut
  - Observe: `fulfillOrder` dengan `quantity: 2` dan 2 stok `AVAILABLE` → 2 delivery berhasil
  - Observe: `fulfillOrder` dengan stok `SOLD` (bukan `AVAILABLE`) → menggunakan konten stok `SOLD` (produk digital unlimited)
  - Observe: `fulfillOrder` dipanggil pertama kali (belum pernah diproses) → semua OrderItem diproses normal
  - Observe: `runNonBuyerCampaign` untuk user WARM/COLD/GHOST → menggunakan `prodList[0]` sebagai referensi produk

  **Property-Based Tests yang perlu ditulis:**
  - PBT: Untuk semua `quantity: 1` dengan 1 stok tersedia → tepat 1 delivery berhasil (tidak berubah setelah fix)
  - PBT: Untuk semua `quantity >= 2` dengan stok >= quantity → tepat `quantity` delivery berhasil (tidak berubah)
  - PBT: Untuk semua panggilan pertama `fulfillOrder` (fulfilled=0) → semua item diproses (tidak berubah)
  - PBT: Untuk random `userId` dengan segment WARM/COLD/GHOST → produk yang dipilih selalu dari `prodList[0]` (tidak berubah)
  - Tulis tests di file baru: `tests/simulation/sim-preservation.test.js`

  - Jalankan pada kode unfixed: semua preservation tests harus PASS
  - **EXPECTED OUTCOME**: Semua preservation tests PASS (membuktikan baseline behavior yang harus dijaga)
  - Mark task complete ketika tests sudah ditulis, dijalankan, dan semua pass pada kode unfixed
  - _Requirements: 3.1, 3.2, 3.3 (BUG-01), 3.4, 3.5, 3.6 (BUG-02), 3.7, 3.8 (BUG-03), 3.14, 3.15 (BUG-06)_

- [ ] 3. Implementasi fix untuk semua 6 bug

  - [x] 3.1 BUG-01: Ganti teks pesan stok kosong di store.js
    - File: `store.js`, fungsi `fulfillOrder`, blok `else` terdalam setelah `if (anyStock)` gagal
    - Ganti: `'❌ Link belum diisi admin. Hubungi Admin untuk mendapat akses.'`
    - Dengan: `'⚠️ Habis stok. Hubungi Admin untuk mendapat akses.'`
    - Perubahan minimal: hanya 1 baris teks, tidak ada logika yang berubah
    - _Bug_Condition: isBugCondition_01 → stockDB.count({ product_id }) = 0 AND product.type = 'AUTO'_
    - _Expected_Behavior: result[0].content MATCHES /Habis stok/_
    - _Preservation: Ketika stok AVAILABLE atau SOLD tersedia, delivery tetap menggunakan konten stok_
    - _Requirements: 2.1, 2.2_

  - [x] 3.2 BUG-02: Pisahkan auto-restock dari loop quantity di store.js
    - File: `store.js`, fungsi `fulfillOrder`, loop `for(let i=0; i<item.quantity; i++)`
    - Tambah deklarasi `const restockQueue = [];` sebelum loop `for(let i...)`
    - Di dalam blok `if (stock)`: hapus `await Stock.create({...AVAILABLE})`, ganti dengan `restockQueue.push({ product_id: item.product_id, content: stock.content })`
    - Di dalam blok `else → if (anyStock)`: hapus `await Stock.create({...AVAILABLE})`, ganti dengan `restockQueue.push({ product_id: item.product_id, content: anyStock.content })`
    - Setelah loop `for(let i...)` selesai: tambah loop `for (const r of restockQueue) { await Stock.create({ product_id: r.product_id, content: r.content, status: 'AVAILABLE' }); }`
    - Loop `for (const item of items)` tetap sama, hanya isi di dalamnya yang berubah
    - _Bug_Condition: isBugCondition_02 → orderItem.quantity > 1 AND availableStockCount > 0 AND availableStockCount < quantity_
    - _Expected_Behavior: tepat min(quantity, availableStockCount) delivery berhasil, sisanya "Habis"_
    - _Preservation: quantity=1 stok=1 → tetap 1 delivery; quantity=2 stok=2 → tetap 2 delivery_
    - _Requirements: 2.3, 2.4_

  - [x] 3.3 BUG-03: Tambah guard idempotency di store.js
    - File: `store.js`, fungsi `fulfillOrder`, di awal blok `for (const item of items)`
    - Tambah 1 baris: `if (item.fulfilled) continue;` setelah `for (const item of items) {`
    - Guard ini membuat panggilan ke-2 meng-skip semua item yang sudah `fulfilled = 1`
    - Posisi: tepat sebelum deklarasi `restockQueue` dan loop `for(let i...)`
    - _Bug_Condition: isBugCondition_03 → callCount >= 2 AND EXISTS OrderItem WHERE fulfilled = 1_
    - _Expected_Behavior: total Stock SOLD setelah 2 panggilan = quantity_ordered (tidak bertambah)_
    - _Preservation: Panggilan pertama (fulfilled=0) tetap memproses semua item secara normal_
    - _Requirements: 2.5, 2.6_

  - [x] 3.4 BUG-04: Tambah DripLog ke import di index.js
    - File: `index.js`, baris 17 — destructuring import dari `./database`
    - Tambahkan `DripLog` di akhir daftar destructuring
    - Sebelum: `const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog } = require("./database");`
    - Sesudah: `const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog, DripLog } = require("./database");`
    - Tidak ada import lain yang berubah, tidak ada logika yang berubah
    - _Bug_Condition: isBugCondition_04 → 'DripLog' NOT IN scope.variables saat handleOrderExpired dipanggil_
    - _Expected_Behavior: handleOrderExpired tidak throw ReferenceError; DripLog.findOne/create berjalan normal_
    - _Preservation: Semua import lain (User, Product, Stock, dll) tetap berfungsi normal_
    - _Requirements: 2.7, 2.8_

  - [x] 3.5 BUG-05: Hapus runInBand dari jest.config.js
    - File: `jest.config.js`
    - Hapus baris `runInBand: true,` beserta komentarnya
    - `--runInBand` sudah ada di npm script `package.json` ("test": "jest --runInBand") — tidak perlu diubah
    - Verifikasi: tidak ada opsi valid lain yang ikut terhapus
    - _Bug_Condition: isBugCondition_05 → 'runInBand' IN Object.keys(jestConfig)_
    - _Expected_Behavior: npm test berjalan tanpa "Validation Warning: Unknown option runInBand"_
    - _Preservation: testEnvironment, setupFilesAfterEnv, testTimeout, clearMocks, moduleNameMapper tetap berfungsi_
    - _Requirements: 2.9, 2.10_

  - [x] 3.6 BUG-06: Pindahkan deklarasi rotationIndex di scheduler.js
    - File: `scheduler.js`, fungsi `runNonBuyerCampaign`
    - Pindahkan 3 baris berikut dari posisi setelah blok if/else (sekitar baris 600) ke tepat sebelum `if (segment === 'HOT')`:
      ```javascript
      const userIdNum = typeof user._id === 'object' ? parseInt(String(user._id).slice(-6), 16) : Number(user._id);
      const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      const rotationIndex = (userIdNum + dayOfYear) % (prodList.length || 1);
      ```
    - Hapus duplikasi deklarasi yang ada di posisi lama (setelah blok if/else)
    - Tambahkan komentar: `// [BUGFIX BUG-06] Hitung rotationIndex SEBELUM blok if/else agar tersedia di blok HOT`
    - Deklarasi `firstPromo` di baris 602 yang menggunakan `rotationIndex` tetap di tempatnya (tidak dipindah)
    - _Bug_Condition: isBugCondition_06 → segment = 'HOT' AND prodList.length > 1 AND usageLineOf(rotationIndex) < declarationLineOf(rotationIndex)_
    - _Expected_Behavior: user HOT mendapat promosi prodList[rotationIndex] sesuai hash userId+dayOfYear, bukan selalu prodList[0]_
    - _Preservation: user WARM/COLD/GHOST tetap menggunakan prodList[0] sebagai referensi (tidak bergantung rotationIndex)_
    - _Requirements: 2.11, 2.12_

  - [x] 3.7 Verifikasi exploration test BUG-01/02/03 sekarang pass
    - **Property 1: Expected Behavior** - 6 Bug Scenarios
    - **IMPORTANT**: Jalankan ULANG test yang SAMA dari task 1 — jangan tulis test baru
    - Test SIM-01a: `fulfillOrder` stok kosong → assert `result[0].content` matches `/Habis stok/` → HARUS PASS
    - Test SIM-01b: `fulfillOrder` qty=2 stok=1 → assert 1 delivered + 1 exhausted → HARUS PASS
    - Test SIM-01c: `fulfillOrder` dipanggil 2x → assert `soldCount = 1` → HARUS PASS
    - **EXPECTED OUTCOME**: Semua exploration tests PASS (membuktikan bug sudah di-fix)
    - _Requirements: 2.1, 2.2 (BUG-01), 2.3, 2.4 (BUG-02), 2.5, 2.6 (BUG-03)_

  - [-] 3.8 Verifikasi preservation tests masih pass setelah fix
    - **Property 2: Preservation** - Perilaku Normal Tidak Berubah
    - **IMPORTANT**: Jalankan ULANG test yang SAMA dari task 2 — jangan tulis test baru
    - Semua preservation tests dari `tests/simulation/sim-preservation.test.js` harus tetap PASS
    - **EXPECTED OUTCOME**: Semua preservation tests PASS (membuktikan tidak ada regresi)
    - Konfirmasi: delivery normal tetap berjalan, idempotency tidak merusak panggilan pertama, segmen non-HOT tidak terpengaruh
    - _Requirements: 3.1–3.8 (store.js), 3.9–3.11 (index.js), 3.12, 3.13 (jest), 3.14, 3.15 (scheduler.js)_

- [~] 4. Checkpoint — Pastikan semua test pass
  - Jalankan full test suite: `npm test`
  - Pastikan tidak ada `Validation Warning: Unknown option "runInBand"` di output Jest
  - Pastikan semua test yang sebelumnya pass tetap pass (tidak ada regresi)
  - Pastikan SIM-01a, SIM-01b, SIM-01c semua pass
  - Jika ada test yang fail atau pertanyaan yang muncul, tanyakan ke user sebelum melanjutkan
