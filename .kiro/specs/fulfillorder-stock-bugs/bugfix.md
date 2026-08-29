# Bugfix Requirements Document

## Introduction

Dokumen ini mencakup 6 bug yang telah teridentifikasi dan dikonfirmasi pada proyek Saweria Payment Bot — sebuah Telegram bot toko digital berbasis Node.js + MongoDB. Tiga bug pertama (BUG-01, BUG-02, BUG-03) terbukti melalui kegagalan test otomatis (Jest), sementara tiga bug berikutnya (BUG-04, BUG-05, BUG-06) ditemukan melalui analisis kode statis. Dampak bug-bug ini mencakup: pesan error yang tidak konsisten kepada pembeli, pengiriman digital yang tidak terkontrol pada produk kuantitas ganda, stok yang diklaim dobel saat order diproses ulang, crash saat order expired, konfigurasi test yang menghasilkan warning, dan pemilihan produk yang salah pada kampanye marketing.

---

## Bug Analysis

### BUG-01: fulfillOrder — Pesan stok kosong tidak konsisten

#### Current Behavior (Defect)

Ketika `fulfillOrder` dipanggil untuk order dengan produk bertipe `AUTO` dan tidak ada stok sama sekali di database (tidak ada dokumen `Stock` dengan `product_id` yang cocok, baik `AVAILABLE` maupun `SOLD`), fungsi mengembalikan pesan yang berbeda dari standar yang digunakan di tempat lain dalam sistem.

1.1 WHEN produk bertipe `AUTO` dan tidak ada stok `AVAILABLE` maupun `SOLD` untuk `product_id` tersebut di database THEN sistem mengembalikan pesan `"❌ Link belum diisi admin. Hubungi Admin untuk mendapat akses."` sebagai konten delivery

1.2 WHEN test SIM-01a memanggil `fulfillOrder` untuk order tanpa stok apapun THEN hasil `result[0].content` tidak cocok dengan pola `/Habis stok/` yang diexpect oleh test suite

#### Expected Behavior (Correct)

2.1 WHEN produk bertipe `AUTO` dan tidak ada stok sama sekali (kosong total) di database THEN sistem SHALL mengembalikan pesan yang mengandung teks `"Habis stok"` sebagai konten delivery

2.2 WHEN test SIM-01a memanggil `fulfillOrder` untuk order tanpa stok apapun THEN `result[0].content` SHALL cocok dengan pola `/Habis stok/`

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN produk bertipe `AUTO` dan stok `AVAILABLE` tersedia di database THEN sistem SHALL CONTINUE TO mengklaim satu stok secara atomik dan mengembalikan `content` stok tersebut sebagai delivery

3.2 WHEN produk bertipe `AUTO` dan tidak ada stok `AVAILABLE` tetapi ada stok `SOLD` THEN sistem SHALL CONTINUE TO menggunakan konten dari stok `SOLD` tersebut (produk digital unlimited)

3.3 WHEN `fulfillOrder` dijalankan dengan order yang memiliki beberapa `OrderItem` berbeda THEN sistem SHALL CONTINUE TO memproses setiap item secara independen

---

### BUG-02: fulfillOrder — Auto-restock dalam loop merusak batas quantity

#### Current Behavior (Defect)

Ketika `fulfillOrder` dijalankan untuk `OrderItem` dengan `quantity: 2` dan hanya tersedia 1 stok `AVAILABLE`, logika auto-restock (yang membuat ulang stok setelah klaim pertama) menyebabkan iterasi ke-2 dari loop quantity menemukan stok baru tersebut dan berhasil mengklaimnya, sehingga kedua unit dianggap berhasil dideliver.

1.3 WHEN `OrderItem.quantity` adalah 2 dan hanya ada 1 stok `AVAILABLE` untuk produk tersebut THEN sistem menghasilkan 2 delivery berhasil dan 0 delivery "habis stok"

1.4 WHEN loop `for(let i=0; i<item.quantity; i++)` pada iterasi pertama berhasil klaim stok dan langsung membuat stok `AVAILABLE` baru THEN iterasi kedua menemukan stok baru tersebut dan juga berhasil diklaim, sehingga `quantity: 2` terpenuhi dari 1 stok fisik asli

#### Expected Behavior (Correct)

2.3 WHEN `OrderItem.quantity` adalah 2 dan hanya ada 1 stok `AVAILABLE` untuk produk tersebut THEN sistem SHALL menghasilkan tepat 1 delivery berhasil dan 1 delivery dengan pesan "habis stok"

2.4 WHEN auto-restock dilakukan untuk produk digital THEN sistem SHALL NOT membuat stok baru di dalam loop quantity yang sama — restock SHALL terjadi di luar siklus pemrosesan quantity order yang sedang berjalan

#### Unchanged Behavior (Regression Prevention)

3.4 WHEN `OrderItem.quantity` adalah 1 dan 1 stok `AVAILABLE` tersedia THEN sistem SHALL CONTINUE TO menghasilkan 1 delivery berhasil

3.5 WHEN `OrderItem.quantity` adalah 2 dan 2 atau lebih stok `AVAILABLE` tersedia THEN sistem SHALL CONTINUE TO menghasilkan 2 delivery berhasil

3.6 WHEN produk digital diproses dan auto-restock diperlukan THEN sistem SHALL CONTINUE TO menyediakan konten yang sama untuk pembeli berikutnya di order yang berbeda

---

### BUG-03: fulfillOrder — Tidak ada guard idempotency, stok diklaim ganda

#### Current Behavior (Defect)

Ketika `fulfillOrder` dipanggil dua kali untuk `orderId` yang sama (misalnya karena retry, race condition, atau double-fire event), panggilan ke-2 tidak mendeteksi bahwa `OrderItem` sudah pernah diproses. Stok yang di-restock oleh panggilan ke-1 diklaim kembali oleh panggilan ke-2, menghasilkan total stok `SOLD` yang lebih banyak dari semestinya.

1.5 WHEN `fulfillOrder` dipanggil dua kali dengan `orderId` yang sama THEN sistem menghasilkan `Stock` dengan status `SOLD` sebanyak 2 untuk produk yang seharusnya hanya 1

1.6 WHEN `OrderItem.fulfilled` sudah bernilai `1` dari panggilan sebelumnya THEN loop `for(let i=0; i<item.quantity; i++)` tetap berjalan penuh tanpa mengecek nilai `fulfilled`

#### Expected Behavior (Correct)

2.5 WHEN `fulfillOrder` dipanggil dua kali dengan `orderId` yang sama THEN sistem SHALL menghasilkan total `Stock` berstatus `SOLD` sebanyak 1, bukan 2

2.6 WHEN `fulfillOrder` memproses sebuah `OrderItem` dan `OrderItem.fulfilled` sudah bernilai `1` THEN sistem SHALL melewati (skip) item tersebut tanpa mengklaim stok baru

#### Unchanged Behavior (Regression Prevention)

3.7 WHEN `fulfillOrder` dipanggil pertama kali untuk order yang belum pernah diproses THEN sistem SHALL CONTINUE TO memproses semua `OrderItem` dan mengklaim stok sesuai quantity

3.8 WHEN order berisi beberapa `OrderItem` berbeda yang belum pernah diproses THEN sistem SHALL CONTINUE TO memproses setiap item dan mengembalikan semua delivery

---

### BUG-04: handleOrderExpired — `DripLog` tidak di-import di index.js

#### Current Behavior (Defect)

Fungsi `handleOrderExpired` di `index.js` memanggil `DripLog.findOne(...)` dan `DripLog.create(...)`, namun variabel `DripLog` tidak ada dalam scope karena tidak disertakan dalam destructuring import `require('./database')` di baris pertama `index.js`.

1.7 WHEN order expired dan `handleOrderExpired` dieksekusi THEN sistem menghasilkan `ReferenceError: DripLog is not defined` pada runtime karena `DripLog` tidak di-import

1.8 WHEN blok `try/catch` di dalam `handleOrderExpired` menangkap error tersebut THEN fungsi silent-fail dan DripLog CART_ABANDON tidak dibuat, sehingga user abandoner tidak masuk ke funnel cart abandon campaign

#### Expected Behavior (Correct)

2.7 WHEN order expired dan `handleOrderExpired` dieksekusi THEN sistem SHALL menemukan variabel `DripLog` dalam scope tanpa error

2.8 WHEN order expired dan belum ada DripLog CART_ABANDON untuk user tersebut THEN sistem SHALL membuat DripLog baru dengan `campaign_type: 'CART_ABANDON'` dan `stage: 0`

#### Unchanged Behavior (Regression Prevention)

3.9 WHEN `handleOrderExpired` dipanggil THEN sistem SHALL CONTINUE TO mengirim pesan "QR sudah kedaluwarsa" ke user melalui Telegram

3.10 WHEN user telah abandon 3 kali atau lebih THEN sistem SHALL CONTINUE TO mengirim notifikasi high-intent alert ke admin

3.11 WHEN semua import lain dari `./database` di `index.js` digunakan THEN sistem SHALL CONTINUE TO berfungsi normal — perubahan hanya menambahkan `DripLog` ke daftar import tanpa memodifikasi yang lain

---

### BUG-05: jest.config.js — `runInBand` bukan opsi yang valid di config file

#### Current Behavior (Defect)

Opsi `runInBand: true` ditempatkan di dalam `jest.config.js`, padahal Jest tidak mengenalinya sebagai opsi konfigurasi file yang valid. Jest hanya mengakui `--runInBand` sebagai CLI flag.

1.9 WHEN `npm test` dijalankan THEN Jest menampilkan `Validation Warning: Unknown option "runInBand" with value true was found` sebelum test berjalan

1.10 WHEN warning tersebut muncul THEN opsi `runInBand` diabaikan oleh Jest, sehingga test berpotensi berjalan secara paralel (berbeda proses) dan `MONGODB_URI` yang di-set oleh `jest.setup` mungkin tidak tersedia di semua worker

#### Expected Behavior (Correct)

2.9 WHEN `npm test` dijalankan THEN Jest SHALL berjalan tanpa `Validation Warning` terkait `runInBand`

2.10 WHEN test suite membutuhkan eksekusi serial (in-band) untuk kondisi shared MongoDB URI THEN Jest SHALL CONTINUE TO menjalankan semua test dalam satu proses yang sama

#### Unchanged Behavior (Regression Prevention)

3.12 WHEN `jest.config.js` diupdate THEN semua opsi lain yang sudah valid (`testEnvironment`, `setupFilesAfterEnv`, `testTimeout`, `clearMocks`, `moduleNameMapper`) SHALL CONTINUE TO berfungsi seperti sebelumnya

3.13 WHEN `npm test` dijalankan setelah fix THEN semua test yang sebelumnya pass SHALL CONTINUE TO pass

---

### BUG-06: scheduler.js — `rotationIndex` digunakan sebelum dideklarasikan di blok HOT

#### Current Behavior (Defect)

Di dalam fungsi `runNonBuyerCampaign`, variabel `rotationIndex` digunakan di dalam blok `if (segment === 'HOT')` (`const p = prodList[rotationIndex] || prodList[0]`), namun `const rotationIndex = ...` baru dideklarasikan beberapa puluh baris kemudian, setelah semua blok `if/else` segmentasi selesai. Karena `const` tidak di-hoist seperti `var`, ekspresi `prodList[rotationIndex]` dievaluasi dengan `rotationIndex` bernilai `undefined` (atau melempar `ReferenceError` di strict mode), sehingga selalu jatuh ke `prodList[0]`.

1.11 WHEN kampanye non-buyer berjalan untuk user dengan segment `HOT` dan ada lebih dari 1 produk THEN `rotationIndex` bernilai `undefined` pada saat digunakan, sehingga `prodList[undefined]` adalah `undefined` dan sistem selalu memilih `prodList[0]` alih-alih produk yang seharusnya dipilih berdasarkan rotasi hash user-id + hari

1.12 WHEN setiap user HOT menerima pesan kampanye THEN semua user HOT selalu mendapat promosi produk pertama di array, mengabaikan logika rotasi yang dirancang untuk mendistribusikan promosi produk secara merata

#### Expected Behavior (Correct)

2.11 WHEN kampanye non-buyer berjalan untuk user dengan segment `HOT` THEN sistem SHALL menggunakan nilai `rotationIndex` yang sudah terhitung (berdasarkan `(userIdNum + dayOfYear) % prodList.length`) untuk memilih produk yang dipromosikan

2.12 WHEN `rotationIndex` dihitung sebelum blok segmentasi `if/else` dimulai THEN setiap user HOT SHALL menerima promosi produk yang berbeda sesuai rotasi, bukan selalu produk pertama

#### Unchanged Behavior (Regression Prevention)

3.14 WHEN kampanye berjalan untuk user dengan segment `WARM`, `COLD`, atau `GHOST` THEN sistem SHALL CONTINUE TO menggunakan `prodList[0]` sebagai referensi produk (behavior ini tidak berubah karena segmen tersebut tidak bergantung pada `rotationIndex`)

3.15 WHEN `rotationIndex` dipindahkan sebelum blok `if/else` THEN nilai akhir `firstPromo` yang dikirim ke `sendSafe` SHALL CONTINUE TO menggunakan `rotationIndex` yang sama, sehingga pesan dan media yang dikirim tetap konsisten untuk satu user dalam satu hari

---

## Bug Condition Summary (Pseudocode)

### BUG-01 — Fix Checking

```pascal
FUNCTION isBugCondition_01(order, stockDB)
  INPUT: order dengan 1 OrderItem bertipe AUTO, stockDB
  OUTPUT: boolean
  RETURN stockDB.count({ product_id: order.items[0].product_id }) = 0
END FUNCTION

// Property: Fix Checking
FOR ALL order WHERE isBugCondition_01(order, stockDB) DO
  result ← fulfillOrder'(order._id)
  ASSERT result[0].content MATCHES /Habis stok/
END FOR

// Property: Preservation Checking
FOR ALL order WHERE NOT isBugCondition_01(order, stockDB) DO
  ASSERT fulfillOrder(order._id) = fulfillOrder'(order._id)
END FOR
```

### BUG-02 — Fix Checking

```pascal
FUNCTION isBugCondition_02(orderItem, availableStockCount)
  INPUT: orderItem dengan quantity > 1, availableStockCount
  OUTPUT: boolean
  RETURN orderItem.quantity > availableStockCount AND availableStockCount > 0
END FUNCTION

// Property: Fix Checking
FOR ALL (orderItem, stock) WHERE isBugCondition_02(orderItem, stock.available) DO
  results ← fulfillOrder'(orderItem.order_id)
  delivered ← results WHERE content STARTS_WITH 'https://'
  exhausted ← results WHERE content INCLUDES 'Habis'
  ASSERT delivered.length = stock.available
  ASSERT exhausted.length = orderItem.quantity - stock.available
END FOR
```

### BUG-03 — Fix Checking

```pascal
FUNCTION isBugCondition_03(orderId, callCount)
  INPUT: orderId, callCount (jumlah kali fulfillOrder dipanggil)
  OUTPUT: boolean
  RETURN callCount >= 2 AND OrderItem.fulfilled[orderId] = 1
END FUNCTION

// Property: Fix Checking (idempotency)
FOR ALL orderId WHERE isBugCondition_03(orderId, 2) DO
  fulfillOrder'(orderId)  // panggilan ke-2
  soldCount ← Stock.count({ status: 'SOLD', product_id: ... })
  ASSERT soldCount = quantity_ordered  // tidak bertambah dari panggilan ke-1
END FOR
```

### BUG-04 — Fix Checking

```pascal
FUNCTION isBugCondition_04(scope)
  INPUT: scope variabel saat handleOrderExpired dipanggil
  OUTPUT: boolean
  RETURN 'DripLog' NOT IN scope
END FUNCTION

// Property: Fix Checking
FOR ALL expired_order DO
  ASSERT handleOrderExpired'(ctx, chatId, msgId, orderId) DOES_NOT_THROW ReferenceError
  ASSERT DripLog.findOne({ user_id: expired_order.user_id, campaign_type: 'CART_ABANDON' }) IS_NOT_NULL
END FOR
```

### BUG-05 — Fix Checking

```pascal
FUNCTION isBugCondition_05(jestConfig)
  INPUT: jest.config.js content
  OUTPUT: boolean
  RETURN 'runInBand' IN jestConfig.keys
END FUNCTION

// Property: Fix Checking
FOR ALL jest_run WHERE isBugCondition_05(config) DO
  output ← run npm test
  ASSERT output DOES_NOT_CONTAIN 'Validation Warning: Unknown option "runInBand"'
  ASSERT tests_run_serially = true  // via --runInBand in package.json script
END FOR
```

### BUG-06 — Fix Checking

```pascal
FUNCTION isBugCondition_06(segment, prodList)
  INPUT: segment string, prodList array
  OUTPUT: boolean
  RETURN segment = 'HOT' AND prodList.length > 1 AND rotationIndex DECLARED_AFTER usage
END FUNCTION

// Property: Fix Checking
FOR ALL user WHERE isBugCondition_06('HOT', prodList) DO
  msg ← buildMessage'(user, 'HOT', prodList)
  rotationIndex ← (hash(user._id) + dayOfYear) % prodList.length
  expected_product ← prodList[rotationIndex]
  ASSERT msg CONTAINS expected_product.name OR expected_product.name IN msg
END FOR
```
