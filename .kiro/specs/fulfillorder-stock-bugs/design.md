# fulfillorder-stock-bugs Bugfix Design

## Overview

Dokumen ini mendefinisikan pendekatan perbaikan minimal-invasif untuk 6 bug yang teridentifikasi pada proyek Saweria Payment Bot. Semua bug bersifat terlokalisasi — tidak memerlukan perubahan arsitektur, hanya perubahan baris kode yang tepat sasaran.

| Bug | File | Fungsi/Lokasi | Dampak |
|-----|------|---------------|--------|
| BUG-01 | `store.js` | `fulfillOrder` | Pesan stok kosong tidak cocok ekspektasi test |
| BUG-02 | `store.js` | `fulfillOrder` | Auto-restock dalam loop merusak batas quantity |
| BUG-03 | `store.js` | `fulfillOrder` | Tidak ada guard idempotency — stok diklaim ganda |
| BUG-04 | `index.js` | Import baris 17 | `DripLog` undefined → `ReferenceError` di runtime |
| BUG-05 | `jest.config.js` + `package.json` | Konfigurasi Jest | `runInBand` tidak valid di config file → warning |
| BUG-06 | `scheduler.js` | `runNonBuyerCampaign` | `rotationIndex` digunakan sebelum dideklarasikan |

Pendekatan umum: **bug condition methodology** — setiap bug diperlakukan sebagai kondisi C(X) yang menghasilkan output P(result) yang salah. Fix difokuskan pada mengubah output untuk input C(X) menjadi benar, tanpa mengubah output untuk input ¬C(X).

---

## Glossary

- **Bug_Condition (C)**: Kondisi input yang memicu bug — subset dari semua input yang menyebabkan fungsi menghasilkan output yang salah
- **Property (P)**: Perilaku yang diharapkan ketika C(X) = true — output yang seharusnya dihasilkan oleh kode yang sudah di-fix
- **Preservation**: Perilaku untuk input ¬C(X) yang TIDAK boleh berubah setelah fix
- **F**: Fungsi original (sebelum fix)
- **F'**: Fungsi yang sudah di-fix
- **fulfillOrder**: Fungsi di `store.js` yang mengklaim stok dari database dan mengembalikan array delivery hasil order
- **OrderItem**: Dokumen MongoDB yang merepresentasikan satu item dalam sebuah order, berisi `product_id`, `quantity`, dan `fulfilled`
- **Stock**: Dokumen MongoDB yang merepresentasikan satu unit stok digital, berisi `product_id`, `content`, dan `status` (`AVAILABLE` | `SOLD`)
- **DripLog**: Dokumen MongoDB untuk marketing automation — melacak stage kampanye per user per produk
- **rotationIndex**: Indeks rotasi produk yang dihitung dari hash `userId + dayOfYear` untuk mendistribusikan promosi secara merata

---

## Bug Details

### BUG-01: Pesan Stok Kosong Tidak Konsisten

#### Bug Condition

Bug muncul ketika `fulfillOrder` diproses untuk `OrderItem` bertipe `AUTO` dan **tidak ada dokumen `Stock` sama sekali** di database untuk `product_id` tersebut — baik status `AVAILABLE` maupun `SOLD`.

**Formal Specification:**
```
FUNCTION isBugCondition_01(order, stockDB)
  INPUT: order dengan 1 OrderItem bertipe AUTO, stockDB
  OUTPUT: boolean

  RETURN stockDB.count({ product_id: order.items[0].product_id }) = 0
         AND order.items[0].product.type = 'AUTO'
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: Order untuk produk `AUTO` dengan database stok kosong → `result[0].content = "❌ Link belum diisi admin. Hubungi Admin untuk mendapat akses."`
- **Expected**: Order untuk produk `AUTO` dengan database stok kosong → `result[0].content` mengandung teks `"Habis stok"`

---

### BUG-02: Auto-Restock Dalam Loop Merusak Batas Quantity

#### Bug Condition

Bug muncul ketika `OrderItem.quantity > 1` dan jumlah stok `AVAILABLE` lebih kecil dari `quantity`. Loop `for(let i=0; i<item.quantity; i++)` pada iterasi pertama mengklaim stok dan langsung membuat stok baru (`AVAILABLE`) di tempat yang sama, sehingga iterasi berikutnya menemukan stok baru itu dan berhasil mengklaimnya juga.

**Formal Specification:**
```
FUNCTION isBugCondition_02(orderItem, availableStockCount)
  INPUT: orderItem dengan quantity, availableStockCount integer
  OUTPUT: boolean

  RETURN orderItem.quantity > 1
         AND availableStockCount > 0
         AND availableStockCount < orderItem.quantity
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: `quantity: 2`, stok tersedia: 1 → hasil: 2 delivery berhasil, 0 "habis stok"
- **Expected**: `quantity: 2`, stok tersedia: 1 → hasil: 1 delivery berhasil, 1 "habis stok"
- **Edge case**: `quantity: 1`, stok tersedia: 1 → tetap 1 delivery berhasil (tidak berubah)

---

### BUG-03: Tidak Ada Guard Idempotency

#### Bug Condition

Bug muncul ketika `fulfillOrder` dipanggil **lebih dari satu kali** untuk `orderId` yang sama. Panggilan ke-2 tidak mengecek apakah `OrderItem.fulfilled` sudah bernilai `1`. Loop tetap berjalan penuh dan mengklaim stok baru yang di-restock oleh panggilan ke-1.

**Formal Specification:**
```
FUNCTION isBugCondition_03(orderId, callCount)
  INPUT: orderId, callCount integer
  OUTPUT: boolean

  RETURN callCount >= 2
         AND EXISTS OrderItem WHERE order_id = orderId AND fulfilled = 1
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: `fulfillOrder(orderId)` dipanggil 2x → total stok `SOLD` = 2 (seharusnya 1)
- **Expected**: `fulfillOrder(orderId)` dipanggil 2x → total stok `SOLD` = 1 (idempoten)

---

### BUG-04: DripLog Tidak Di-import di index.js

#### Bug Condition

Bug muncul ketika `handleOrderExpired` dieksekusi pada runtime. Fungsi ini memanggil `DripLog.findOne(...)` dan `DripLog.create(...)`, tetapi `DripLog` tidak ada dalam scope karena tidak disertakan dalam destructuring import `require('./database')` di baris 17 `index.js`.

**Formal Specification:**
```
FUNCTION isBugCondition_04(scope)
  INPUT: scope variabel saat handleOrderExpired dieksekusi
  OUTPUT: boolean

  RETURN 'DripLog' NOT IN scope.variables
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: Order expire → `handleOrderExpired` dipanggil → `ReferenceError: DripLog is not defined` → DripLog `CART_ABANDON` tidak dibuat → user tidak masuk funnel cart abandon
- **Expected**: Order expire → `DripLog` ditemukan dalam scope → `DripLog.findOne/create` berjalan normal

---

### BUG-05: runInBand Bukan Opsi Valid di jest.config.js

#### Bug Condition

Bug muncul setiap kali `npm test` dijalankan. Opsi `runInBand: true` ditulis di dalam `jest.config.js`, padahal Jest hanya mengenali `--runInBand` sebagai CLI flag, bukan sebagai opsi config file.

**Formal Specification:**
```
FUNCTION isBugCondition_05(jestConfig)
  INPUT: object dari jest.config.js
  OUTPUT: boolean

  RETURN 'runInBand' IN Object.keys(jestConfig)
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: `npm test` → Jest output mengandung `Validation Warning: Unknown option "runInBand" with value true was found`
- **Expected**: `npm test` → Jest berjalan tanpa warning, serial (in-band) karena `--runInBand` di npm script

---

### BUG-06: rotationIndex Digunakan Sebelum Dideklarasikan

#### Bug Condition

Bug muncul di dalam `runNonBuyerCampaign` untuk setiap user dengan segment `HOT` dan `prodList.length > 1`. Variabel `rotationIndex` digunakan di dalam blok `if (segment === 'HOT')` (ekspresi `prodList[rotationIndex]`), namun `const rotationIndex = ...` baru dideklarasikan puluhan baris kemudian, setelah semua blok `if/else` segmentasi selesai.

**Formal Specification:**
```
FUNCTION isBugCondition_06(segment, prodList, codeOrder)
  INPUT: segment string, prodList array, codeOrder (urutan deklarasi vs penggunaan)
  OUTPUT: boolean

  RETURN segment = 'HOT'
         AND prodList.length > 1
         AND usageLineOf(rotationIndex) < declarationLineOf(rotationIndex)
END FUNCTION
```

#### Contoh Konkret

- **Buggy**: User HOT, `prodList = [prodA, prodB, prodC]` → `rotationIndex` adalah `undefined` saat digunakan di blok HOT → `prodList[undefined]` = `undefined` → fallback ke `prodList[0]` → semua user HOT selalu dapat promosi produk pertama
- **Expected**: User HOT, `prodList = [prodA, prodB, prodC]`, `userId=123`, `dayOfYear=100` → `rotationIndex = (123 + 100) % 3 = 1` → user mendapat promosi `prodList[1]` = `prodB`

---

## Expected Behavior

### Preservation Requirements

Bagian ini mendefinisikan apa yang **tidak boleh berubah** setelah seluruh fix diterapkan.

**Unchanged Behaviors:**

- **store.js**: Ketika stok `AVAILABLE` tersedia, `fulfillOrder` SHALL CONTINUE TO mengklaim stok secara atomik dan mengembalikan `content` stok tersebut
- **store.js**: Ketika tidak ada stok `AVAILABLE` tapi ada stok `SOLD` (produk digital unlimited), `fulfillOrder` SHALL CONTINUE TO menggunakan konten dari stok `SOLD` tersebut
- **store.js**: Ketika `quantity: 2` dan 2 stok tersedia, `fulfillOrder` SHALL CONTINUE TO menghasilkan 2 delivery berhasil
- **store.js**: Ketika `fulfillOrder` dipanggil pertama kali untuk order yang belum diproses, SHALL CONTINUE TO memproses semua `OrderItem` secara normal
- **index.js**: Semua import lain dari `./database` (User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog) SHALL CONTINUE TO berfungsi normal
- **index.js**: `handleOrderExpired` SHALL CONTINUE TO mengirim pesan "QR sudah kedaluwarsa" dan high-intent alert ke admin
- **jest.config.js**: Semua opsi valid lainnya (`testEnvironment`, `setupFilesAfterEnv`, `testTimeout`, `clearMocks`, `moduleNameMapper`) SHALL CONTINUE TO berfungsi
- **scheduler.js**: Untuk segment `WARM`, `COLD`, dan `GHOST`, pemilihan produk `prodList[0]` SHALL CONTINUE TO digunakan (tidak bergantung pada `rotationIndex`)

**Scope:**
Semua input yang tidak memenuhi kondisi buggy masing-masing bug harus menghasilkan output yang identik antara F dan F'.

---

## Hypothesized Root Cause

### BUG-01 — Root Cause

**Pesan hardcode yang tidak konsisten**: Developer menulis pesan error spesifik `"❌ Link belum diisi admin..."` di blok `else` terdalam tanpa menyadari bahwa test suite mengekspektasi format standar `"Habis stok"` yang digunakan di bagian lain sistem. Tidak ada konstanta terpusat untuk pesan stok habis.

### BUG-02 — Root Cause

**Side-effect di dalam loop yang mempengaruhi iterasi berikutnya**: `await Stock.create({ status: 'AVAILABLE' })` ditempatkan langsung setelah klaim stok berhasil di dalam iterasi loop yang sama. MongoDB tidak membedakan antara stok "asli" dan stok "baru hasil restock" — keduanya memiliki `status: 'AVAILABLE'` dan `product_id` yang sama. Iterasi ke-2 mengambil stok baru itu karena query `findOneAndUpdate` tidak tahu bahwa stok ini baru saja dibuat dalam iterasi sebelumnya.

**Solusi yang dipilih**: Kumpulkan konten yang perlu di-restock dalam array sementara selama loop, kemudian jalankan semua `Stock.create` setelah loop selesai. Ini memisahkan fase "klaim" dari fase "restock".

### BUG-03 — Root Cause

**Tidak ada guard idempotency di level item**: Komentar di kode menyebutkan bahwa status `SUCCESS` di-set secara atomik di `onPaymentSuccess()` sebagai idempotency guard untuk order, tetapi tidak ada guard serupa untuk pemrosesan item individual. `OrderItem.fulfilled` di-set di akhir loop tapi tidak pernah dicek di awal.

### BUG-04 — Root Cause

**Destructuring import tidak lengkap**: Import database di `index.js` baris 17 menggunakan destructuring manual. `DripLog` dibutuhkan oleh `handleOrderExpired` (ditambahkan belakangan saat fitur cart abandon diimplementasi) tetapi tidak ditambahkan ke daftar import. Karena `handleOrderExpired` menggunakan `try/catch`, error ini silent-fail di production.

### BUG-05 — Root Cause

**Kebingungan antara opsi config file dan CLI flag**: Jest memisahkan opsi yang bisa ditulis di config file (`jest.config.js`) dengan opsi yang hanya berlaku sebagai CLI flag. `runInBand` hanya tersedia sebagai `--runInBand` CLI flag. Menempatkannya di config file menyebabkan Jest memvalidasinya sebagai opsi tak dikenal dan mengabaikannya.

### BUG-06 — Root Cause

**Temporal Dead Zone (TDZ) dengan `const`**: `const rotationIndex` menggunakan deklarasi `const` yang tidak di-hoist ke atas scope fungsi (berbeda dengan `var`). Karena deklarasi ada di bawah blok `if (segment === 'HOT')` yang menggunakannya, pada saat eksekusi blok HOT, `rotationIndex` belum dideklarasikan. Dalam non-strict mode JavaScript, akses ke `const` sebelum deklarasi melempar `ReferenceError`, namun karena ada `try/catch` di level atas loop, ini bisa menjadi silent-fail. Di praktiknya, karena penggunaan ada sebelum deklarasi di alur eksekusi, nilainya menjadi `undefined` atau melempar error — keduanya menyebabkan fallback ke `prodList[0]`.

---

## Correctness Properties

Property 1: Bug Condition — Pesan Stok Kosong Total (BUG-01)

_For any_ order dengan `OrderItem` bertipe `AUTO` di mana tidak ada dokumen `Stock` sama sekali di database untuk `product_id` tersebut (isBugCondition_01 returns true), fungsi `fulfillOrder'` yang sudah di-fix SHALL mengembalikan array delivery di mana `content` mengandung teks `"Habis stok"`.

**Validates: Requirements 2.1, 2.2**

---

Property 2: Preservation — Perilaku Stok Normal (BUG-01)

_For any_ order di mana stok `AVAILABLE` atau stok `SOLD` tersedia di database (isBugCondition_01 returns false), fungsi `fulfillOrder'` SHALL menghasilkan hasil yang identik dengan `fulfillOrder` original — mengklaim stok atomik atau menggunakan konten stok `SOLD` sebagaimana mestinya.

**Validates: Requirements 3.1, 3.2, 3.3**

---

Property 3: Bug Condition — Batas Quantity Dihormati (BUG-02)

_For any_ `OrderItem` dengan `quantity > 1` di mana `availableStockCount < quantity` dan `availableStockCount > 0` (isBugCondition_02 returns true), fungsi `fulfillOrder'` SHALL menghasilkan tepat `availableStockCount` delivery berhasil dan `quantity - availableStockCount` delivery dengan pesan "habis stok" — tidak lebih dari yang tersedia secara fisik.

**Validates: Requirements 2.3, 2.4**

---

Property 4: Preservation — Quantity Terpenuhi Jika Stok Cukup (BUG-02)

_For any_ `OrderItem` di mana `availableStockCount >= quantity` (isBugCondition_02 returns false), fungsi `fulfillOrder'` SHALL menghasilkan tepat `quantity` delivery berhasil, identik dengan perilaku original.

**Validates: Requirements 3.4, 3.5, 3.6**

---

Property 5: Bug Condition — Idempotency Pada Panggilan Ganda (BUG-03)

_For any_ `orderId` di mana `fulfillOrder'` dipanggil dua kali (isBugCondition_03 returns true), total jumlah dokumen `Stock` berstatus `SOLD` setelah kedua panggilan SHALL sama dengan jumlah setelah panggilan pertama saja — panggilan ke-2 tidak mengklaim stok baru.

**Validates: Requirements 2.5, 2.6**

---

Property 6: Preservation — First-Call Tetap Berjalan Normal (BUG-03)

_For any_ `orderId` yang dipanggil pertama kali dengan semua `OrderItem.fulfilled = 0` (isBugCondition_03 returns false), `fulfillOrder'` SHALL memproses semua item dan mengklaim stok sesuai quantity, identik dengan perilaku original.

**Validates: Requirements 3.7, 3.8**

---

Property 7: Bug Condition — DripLog Tersedia di Scope (BUG-04)

_For any_ expired order yang memicu `handleOrderExpired'` (isBugCondition_04 returns true sebelum fix), fungsi SHALL mengeksekusi tanpa `ReferenceError` dan SHALL berhasil membuat dokumen `DripLog` baru dengan `campaign_type: 'CART_ABANDON'` dan `stage: 0` jika belum ada.

**Validates: Requirements 2.7, 2.8**

---

Property 8: Preservation — Perilaku handleOrderExpired Lainnya (BUG-04)

_For any_ pemanggilan `handleOrderExpired'`, fungsi SHALL CONTINUE TO mengirim pesan "QR sudah kedaluwarsa" ke user dan mengirim high-intent alert ke admin jika abandon >= 3, identik dengan perilaku original.

**Validates: Requirements 3.9, 3.10, 3.11**

---

Property 9: Bug Condition — Tidak Ada Warning runInBand (BUG-05)

_For any_ pemanggilan `npm test` setelah fix (isBugCondition_05 returns true sebelum fix), output Jest SHALL NOT mengandung string `Validation Warning: Unknown option "runInBand"`.

**Validates: Requirements 2.9, 2.10**

---

Property 10: Preservation — Opsi Jest Lainnya Tetap Berfungsi (BUG-05)

_For any_ pemanggilan `npm test`, semua opsi Jest yang valid (`testEnvironment`, `setupFilesAfterEnv`, `testTimeout`, `clearMocks`, `moduleNameMapper`) SHALL CONTINUE TO berfungsi identik, dan semua test yang sebelumnya pass SHALL CONTINUE TO pass.

**Validates: Requirements 3.12, 3.13**

---

Property 11: Bug Condition — rotationIndex Dihitung Sebelum Digunakan (BUG-06)

_For any_ user dengan segment `HOT` dan `prodList.length > 1` (isBugCondition_06 returns true), `runNonBuyerCampaign'` SHALL memilih produk yang dipromosikan berdasarkan nilai `rotationIndex = (userIdNum + dayOfYear) % prodList.length` yang sudah terhitung — bukan selalu `prodList[0]`.

**Validates: Requirements 2.11, 2.12**

---

Property 12: Preservation — Segmen Non-HOT Tidak Terpengaruh (BUG-06)

_For any_ user dengan segment `WARM`, `COLD`, atau `GHOST` (isBugCondition_06 returns false karena tidak bergantung `rotationIndex`), `runNonBuyerCampaign'` SHALL menghasilkan pemilihan produk yang identik dengan original — `prodList[0]` sebagai referensi default.

**Validates: Requirements 3.14, 3.15**

---

## Fix Implementation

### BUG-01: Ganti Teks Pesan Stok Kosong

**File**: `store.js`  
**Fungsi**: `fulfillOrder`  
**Lokasi**: Blok `else` terdalam — setelah `if (anyStock)` gagal, di dalam `if (product && product.type === 'AUTO')`

**Perubahan Spesifik:**
```javascript
// SEBELUM:
deliveredStocks.push({
  product_id: item.product_id,
  content: '❌ Link belum diisi admin. Hubungi Admin untuk mendapat akses.'
});

// SESUDAH:
deliveredStocks.push({
  product_id: item.product_id,
  content: '⚠️ Habis stok. Hubungi Admin untuk mendapat akses.'
});
```

**Dampak**: 1 baris diubah. Tidak ada logika yang berubah. Hanya teks pesan.

---

### BUG-02: Pisahkan Auto-Restock dari Loop Quantity

**File**: `store.js`  
**Fungsi**: `fulfillOrder`  
**Lokasi**: Loop `for(let i=0; i<item.quantity; i++)`

**Perubahan Spesifik:**

1. Deklarasikan array `restockQueue` sebelum loop:
   ```javascript
   const restockQueue = []; // konten yang perlu di-restock setelah loop selesai
   ```

2. Di dalam blok `if (stock)` — **hapus** `await Stock.create(...)` dan **ganti** dengan push ke queue:
   ```javascript
   // HAPUS:
   await Stock.create({
     product_id: item.product_id,
     content: stock.content,
     status: 'AVAILABLE'
   });

   // GANTI DENGAN:
   restockQueue.push({ product_id: item.product_id, content: stock.content });
   ```

3. Di dalam blok `else → if (anyStock)` — **hapus** `await Stock.create(...)` dan **ganti** dengan push ke queue:
   ```javascript
   // HAPUS:
   await Stock.create({
     product_id: item.product_id,
     content: anyStock.content,
     status: 'AVAILABLE'
   });

   // GANTI DENGAN:
   restockQueue.push({ product_id: item.product_id, content: anyStock.content });
   ```

4. Setelah loop selesai, jalankan semua restock:
   ```javascript
   // Setelah closing brace for loop
   for (const r of restockQueue) {
     await Stock.create({ product_id: r.product_id, content: r.content, status: 'AVAILABLE' });
   }
   ```

**Dampak**: Loop berjalan sampai selesai tanpa side-effect ke pool stok. Restock terjadi setelah loop, sehingga iterasi berikutnya tidak menemukan stok baru hasil restock iterasi sebelumnya. Behavior untuk `quantity: 1` identik dengan sebelumnya.

---

### BUG-03: Tambahkan Guard Idempotency

**File**: `store.js`  
**Fungsi**: `fulfillOrder`  
**Lokasi**: Di awal blok `for (const item of items)`

**Perubahan Spesifik:**

Tambahkan 1 baris guard sebelum loop quantity:
```javascript
for (const item of items) {
  // [BUGFIX BUG-03] Skip item yang sudah pernah diproses — idempotency guard
  if (item.fulfilled) continue;

  for(let i=0; i<item.quantity; i++) {
    // ... sisa kode tidak berubah
  }
}
```

**Dampak**: 1 baris tambahan. Panggilan ke-2 untuk orderId yang sama akan menemukan semua `OrderItem.fulfilled = 1` (di-set di akhir iterasi pertama) dan meng-skip semuanya. Return value adalah array kosong `[]` — tidak ada stok baru yang diklaim.

---

### BUG-04: Tambahkan DripLog ke Import

**File**: `index.js`  
**Lokasi**: Baris 17 — destructuring import dari `./database`

**Perubahan Spesifik:**
```javascript
// SEBELUM:
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog } = require("./database");

// SESUDAH:
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog, DripLog } = require("./database");
```

**Dampak**: `DripLog` ditambahkan di akhir daftar destructuring. Tidak ada import lain yang berubah. Tidak ada logika yang berubah.

---

### BUG-05: Pindahkan runInBand dari Config ke npm Script

**File 1**: `jest.config.js`  
**Perubahan**: Hapus baris `runInBand: true`

```javascript
// SEBELUM:
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/mongo-memory.js'],
  testTimeout: 60000,
  clearMocks: true,
  runInBand: true, // ← HAPUS BARIS INI
  moduleNameMapper: {
    'puppeteer-extra$': '<rootDir>/tests/__mocks__/puppeteer-extra.js',
    'puppeteer-extra-plugin-stealth': '<rootDir>/tests/__mocks__/puppeteer-stealth.js'
  }
};

// SESUDAH:
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/mongo-memory.js'],
  testTimeout: 60000,
  clearMocks: true,
  moduleNameMapper: {
    'puppeteer-extra$': '<rootDir>/tests/__mocks__/puppeteer-extra.js',
    'puppeteer-extra-plugin-stealth': '<rootDir>/tests/__mocks__/puppeteer-stealth.js'
  }
};
```

**File 2**: `package.json`  
**Perubahan**: Tambahkan `--runInBand` ke npm script `test`

```json
// SEBELUM:
"test": "jest --runInBand"

// SESUDAH (sudah ada --runInBand di package.json, tidak perlu diubah):
"test": "jest --runInBand"
```

> **Catatan**: Setelah memeriksa `package.json`, script `"test": "jest --runInBand"` **sudah benar**. Yang perlu dilakukan hanya menghapus `runInBand: true` dari `jest.config.js`.

**Dampak**: Warning Jest hilang. Test tetap berjalan serial karena `--runInBand` ada di npm script. Tidak ada perubahan pada test behavior.

---

### BUG-06: Pindahkan Deklarasi rotationIndex ke Sebelum Blok if/else

**File**: `scheduler.js`  
**Fungsi**: `runNonBuyerCampaign`

**Perubahan Spesifik:**

1. **Hapus** deklarasi `rotationIndex` dari posisi saat ini (setelah semua blok `if/else` segmentasi):
   ```javascript
   // HAPUS dari posisi akhir (setelah blok COLD/GHOST):
   const userIdNum = typeof user._id === 'object' ? parseInt(String(user._id).slice(-6), 16) : Number(user._id);
   const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
   const rotationIndex = (userIdNum + dayOfYear) % (prodList.length || 1);
   ```

2. **Pindahkan** ke tepat sebelum blok `if (segment === 'HOT')`:
   ```javascript
   // [BUGFIX BUG-06] Hitung rotationIndex SEBELUM blok if/else segmentasi
   // agar tersedia saat digunakan di blok HOT
   const userIdNum = typeof user._id === 'object' ? parseInt(String(user._id).slice(-6), 16) : Number(user._id);
   const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
   const rotationIndex = (userIdNum + dayOfYear) % (prodList.length || 1);

   if (segment === 'HOT') {
     // ... kode HOT sekarang bisa menggunakan rotationIndex dengan benar
     const p = prodList[rotationIndex] || prodList[0];
     // ...
   }
   ```

**Dampak**: Nilai `rotationIndex` tersedia saat blok `HOT` dieksekusi. Untuk segmen `WARM`, `COLD`, `GHOST` — nilai `rotationIndex` dihitung tetapi tidak digunakan (tidak ada efek samping). Behavior untuk segmen non-HOT identik dengan sebelumnya.

---

## Testing Strategy

### Validation Approach

Strategi testing mengikuti dua fase:
1. **Eksplorasi (pre-fix)**: Tulis test yang membuktikan bug ada — test HARUS gagal pada kode yang belum di-fix
2. **Verifikasi (post-fix)**: Setelah fix diterapkan, test HARUS pass untuk semua properti

### Exploratory Bug Condition Checking

**Goal**: Konfirmasi bahwa bug benar-benar terjadi sebelum fix. Jika test pass pada kode unfixed, berarti bug condition atau test tidak tepat.

**Test Cases — Harus GAGAL pada kode unfixed:**

1. **SIM-01a (BUG-01)**: Buat order produk `AUTO` tanpa stok apapun → assert `result[0].content` matches `/Habis stok/` → GAGAL karena mendapat `"❌ Link belum diisi admin..."`

2. **SIM-02a (BUG-02)**: Buat `OrderItem.quantity = 2`, masukkan 1 stok `AVAILABLE` → panggil `fulfillOrder` → assert `deliveredStocks.length = 1` dan 1 entry mengandung "habis" → GAGAL karena mendapat 2 delivery berhasil

3. **SIM-03a (BUG-03)**: Buat order, panggil `fulfillOrder` dua kali → assert `Stock.countDocuments({status:'SOLD'}) = 1` → GAGAL karena count = 2

4. **SIM-04a (BUG-04)**: Mock `handleOrderExpired` execution → assert tidak throw `ReferenceError` → GAGAL karena `DripLog is not defined`

5. **SIM-05a (BUG-05)**: Jalankan Jest, capture stderr → assert stderr tidak mengandung `"Validation Warning: Unknown option"` → GAGAL karena warning muncul

6. **SIM-06a (BUG-06)**: Panggil `runNonBuyerCampaign` untuk user HOT dengan 3 produk → assert produk yang dipromosikan sesuai `rotationIndex` → GAGAL karena selalu `prodList[0]`

**Expected Counterexamples:**
- BUG-01: content = `"❌ Link belum diisi admin..."`
- BUG-02: 2 delivery berhasil padahal stok hanya 1
- BUG-03: 2 stok SOLD padahal order hanya 1
- BUG-04: `ReferenceError: DripLog is not defined`
- BUG-05: Warning message di Jest output
- BUG-06: Produk pertama selalu dipilih, rotasi tidak terjadi

### Fix Checking

**Goal**: Setelah fix, verifikasi bahwa semua input C(X) menghasilkan output yang benar.

**Pseudocode (umum):**
```
FOR ALL input WHERE isBugCondition_N(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior_N(result)
END FOR
```

**Test Cases per Bug — Harus PASS setelah fix:**

1. **BUG-01**: `fulfillOrder'` dengan stok kosong total → `result[0].content` matches `/Habis stok/`
2. **BUG-02**: `fulfillOrder'` dengan `quantity:2`, stok tersedia: 1 → tepat 1 delivery berhasil, 1 entry "habis"
3. **BUG-03**: `fulfillOrder'` dipanggil 2x → `Stock.countDocuments({status:'SOLD'}) = 1`
4. **BUG-04**: `handleOrderExpired'` dipanggil → tidak throw, DripLog CART_ABANDON dibuat
5. **BUG-05**: `npm test` output → tidak ada `"Validation Warning"` terkait `runInBand`
6. **BUG-06**: `runNonBuyerCampaign'` user HOT → produk dipilih sesuai `rotationIndex`

### Preservation Checking

**Goal**: Setelah fix, verifikasi bahwa input ¬C(X) menghasilkan output identik dengan fungsi original.

**Pseudocode (umum):**
```
FOR ALL input WHERE NOT isBugCondition_N(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing direkomendasikan untuk BUG-02 dan BUG-03 karena:
- Menghasilkan banyak kombinasi quantity dan jumlah stok secara otomatis
- Menangkap edge case seperti `quantity: 0`, `quantity: 100`, `stok: 0`, `stok: 1000`
- Memberikan jaminan kuat bahwa behavior tidak berubah untuk semua non-buggy input

**Test Cases per Bug:**

1. **BUG-01 Preservation**: Stok `AVAILABLE` tersedia → delivery berhasil dengan konten stok (identik)
2. **BUG-02 Preservation**: `quantity: 2`, stok tersedia: 3 → 2 delivery berhasil (identik)
3. **BUG-03 Preservation**: Panggilan pertama dengan order baru → semua item diproses (identik)
4. **BUG-04 Preservation**: Semua import lain masih berfungsi → tidak ada perubahan behavior import
5. **BUG-05 Preservation**: Test pass/fail rate identik sebelum dan sesudah fix → tidak ada test yang rusak
6. **BUG-06 Preservation**: User WARM/COLD/GHOST → `prodList[0]` tetap dipilih (identik)

### Unit Tests

- Test `fulfillOrder` dengan kombinasi: stok kosong total, stok cukup, stok kurang dari quantity
- Test `fulfillOrder` dipanggil 2x dengan orderId sama — verifikasi idempotency
- Test `handleOrderExpired` dengan order expired — verifikasi DripLog dibuat
- Test output Jest config — verifikasi tidak ada warning `runInBand`
- Test `runNonBuyerCampaign` dengan berbagai segment dan prodList ukuran berbeda

### Property-Based Tests

- Generate random `quantity` (1–10) dan random `availableStock` (0–10) → verifikasi `min(quantity, availableStock)` delivery berhasil dan `max(0, quantity - availableStock)` delivery "habis"
- Generate random `orderId` dan simulate double-call → verifikasi total SOLD tidak berubah di call ke-2
- Generate random array `prodList` (panjang 1–20) dan random `userId` → verifikasi `rotationIndex` selalu dalam range `[0, prodList.length)` dan produk yang dipilih konsisten

### Integration Tests

- Test full flow: buat order → payment success → `fulfillOrder` → verifikasi delivery dikirim ke user
- Test expired flow: buat order → tunggu expire → `handleOrderExpired` → verifikasi DripLog CART_ABANDON ada di DB
- Test double-payment: simulasi webhook dua kali → verifikasi stok tidak diklaim ganda
- Test `npm test` end-to-end: verifikasi semua test pass tanpa warning setelah fix BUG-05
