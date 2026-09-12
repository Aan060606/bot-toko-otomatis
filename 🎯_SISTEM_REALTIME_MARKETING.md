# 🎯 SISTEM REALTIME MARKETING - ANALISA LENGKAP

**Trigger**: Saat user AKTIF (buka bot, klik tombol, kirim pesan)
**Tujuan**: Kirim promo LANGSUNG saat user online (bukan jam tetap seperti cron)

---

## ⚡ CARA KERJA REALTIME MARKETING

### **TRIGGER POINT:**
```javascript
// index.js line 843-850
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  
  // Update last_active_at setiap user kirim command/pesan
  await User.findByIdAndUpdate(userId, { 
    $set: { last_active_at: new Date() } 
  });
  
  // ⚡ TRIGGER REALTIME MARKETING
  // Delay 5 detik: biar user baca respons bot dulu
  setTimeout(() => {
    scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {});
  }, 5000);
  
  return next();
});
```

**Artinya**: 
- ✅ **SETIAP kali** user buka bot
- ✅ **SETIAP kali** user klik tombol apa pun
- ✅ **SETIAP kali** user kirim pesan
- → Tunggu 5 detik → **CEK apakah user layak dapat promo**

---

## 🎯 FLOW REALTIME MARKETING

```
USER AKTIF (online)
      ↓
[Delay 5 detik]
      ↓
triggerRealtimeMarketing()
      ↓
┌─────────────────────┐
│ 1. CEK USER         │
│    - Tidak blocked? │
│    - Tidak opt-out? │
│    - Tidak quiet?   │
└─────────────────────┘
      ↓
┌─────────────────────┐
│ 2. CEK COOLDOWN     │
│    - last_broadcast │
│      > 48 jam?      │
└─────────────────────┘
      ↓
┌─────────────────────┐
│ 3. CEK PRODUK       │
│    - Ada unbought?  │
│    - Semua sudah?   │
└─────────────────────┘
      ↓
┌─────────────────────┐
│ 4. KLASIFIKASI      │
│    SEGMENT          │
│    (HOT/WARM/COLD)  │
└─────────────────────┘
      ↓
┌─────────────────────┐
│ 5. HITUNG DISKON    │
│    Berdasarkan      │
│    segment          │
└─────────────────────┘
      ↓
┌─────────────────────┐
│ 6. KIRIM PROMO      │
│    LANGSUNG!        │
└─────────────────────┘
```

---

## 📋 CODE LENGKAP

### **Function: triggerRealtimeMarketing()**
```javascript
// scheduler.js line 2358-2465
async function triggerRealtimeMarketing(bot, userId) {
  try {
    // 0. Check marketing enabled
    if (!isMarketingEnabled()) return;
    
    // 1. Ambil data user
    const user = await User.findById(userId).lean();
    if (!user || user.is_blocked || user.opt_out) return;
    
    // 2. Quiet hour check (00:00-06:00 WIB)
    if (isUserQuietHour(user)) return;
    
    // 3. Cooldown check (48 jam)
    // Gunakan isInCooldown() TANPA currentCampaign
    // agar TIDAK bypass lock — strict 48h
    if (isInCooldown(user)) return;
    
    // 4. Ambil semua produk
    const allProducts = await Product.find({ active: 1 }).lean();
    if (allProducts.length === 0) return;
    
    // 5. Build keyboard dengan produk unbought + diskon dinamis
    const { keyboard, products: unboughtProducts } = 
      await buildAllProductsKeyboard(userId, allProducts, discountVal);
    
    // 6. Jika semua sudah dibeli → skip
    if (!keyboard || unboughtProducts.length === 0) return;
    
    // 7. Klasifikasi segment berdasarkan last_active_at
    const segment = await classifyNonBuyer(user);
    
    // 8. Hitung diskon berdasarkan segment
    let discountVal = 0;
    if (segment === 'HOT')   discountVal = 5;
    else if (segment === 'WARM')  discountVal = 10;
    else if (segment === 'COLD')  discountVal = 15;
    else if (segment === 'GHOST') discountVal = 20;
    
    // 9. Create/Update diskon global untuk user (24 jam valid)
    const existingDisc = await Discount.findOne({
      target_user_id: Number(userId),
      trigger_event: 'REALTIME',
      active: true
    }).lean();
    
    if (!existingDisc) {
      await Discount.findOneAndUpdate(
        { 
          target_user_id: Number(userId),
          target_product_id: null,
          trigger_event: 'REALTIME',
          type: 'PERCENTAGE',
          active: true
        },
        { 
          $set: { 
            value: discountVal,
            valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 jam
          } 
        },
        { upsert: true }
      );
    }
    
    // 10. Build pesan berdasarkan segment
    const name = user.first_name || 'Bro';
    let msg = '';
    
    if (segment === 'HOT') {
      msg = `🔥 <b>Halo ${name}!</b>\n\n` +
            `Kamu lagi online — pas banget!\n\n` +
            `Ada produk eksklusif buat kamu dengan <b>diskon 5%</b>.\n\n` +
            `Cek di bawah — promo khusus 48 jam!`;
    } else if (segment === 'WARM') {
      msg = `☕ <b>Hai ${name}, Lama Tidak Ketemu!</b>\n\n` +
            `Udah ada produk baru nih.\n\n` +
            `Spesial buat kamu: <b>diskon 10%</b> untuk 48 jam.\n\n` +
            `Jangan sampai kehabisan!`;
    } else if (segment === 'COLD' || segment === 'GHOST') {
      const disc = segment === 'COLD' ? 15 : 20;
      msg = `❄️ <b>WELCOME BACK, ${name}!</b>\n\n` +
            `Udah lama gak aktif — kangen nih!\n\n` +
            `Spesial comeback: <b>DISKON ${disc}%</b> 🎁\n\n` +
            `Valid 48 jam. Buruan claim!`;
    }
    
    // 11. Kirim promo REALTIME
    const sendOpts = {
      parseMode: 'HTML',
      mediaType: 'animation', // atau 'photo'
      keyboard,
      campaign: `RT_${segment}`, // RT = RealTime
      userName: name,
      reason: unboughtProducts.map(p => p.name).join(', ')
    };
    
    const result = await sendSafe(bot, userId, msg, sendOpts);
    
    if (result.ok) {
      // 12. Update last_broadcast_at (cooldown 48 jam aktif)
      await User.findByIdAndUpdate(userId, { 
        $set: { last_broadcast_at: new Date() } 
      });
      
      // 13. Create DripLog untuk tracking
      await DripLog.create({
        user_id: userId,
        product_id: unboughtProducts[0]._id,
        campaign_type: 'NON_BUYER',
        stage: 1,
        sent_at: new Date(),
        converted: false,
        variant: Math.random() > 0.5 ? 'A' : 'B'
      });
    }
    
  } catch (err) {
    // Silent fail
  }
}
```

---

## ✅ KELEBIHAN REALTIME MARKETING

### **1. TIMING PERFECT** ⏰
```
USER ONLINE → LANGSUNG DAPAT PROMO
Bukan jam 10:00 pagi ketika user masih tidur!
```

### **2. CONTEXT AWARE** 🎯
```
User buka menu produk → dapat promo produk
User lihat cart → dapat diskon checkout
User aktif setelah 7 hari tidak aktif → COLD segment diskon 15%
```

### **3. NO WASTED MESSAGE** 💰
```
Cron: Kirim ke 1000 user jam 10:00
      → 700 offline (wasted)
      → 300 online (effective)

Realtime: Kirim HANYA saat user online
         → 1000/1000 online (100% effective!)
```

### **4. COOLDOWN KETAT** 🛡️
```javascript
// Cooldown 48 jam tanpa bypass
if (isInCooldown(user)) return;

// Tidak ada exception untuk buyer, VIP, dll
// Semua user = sama = 48 jam cooldown
```

### **5. ADAPTIVE DISCOUNT** 💰
```
HOT (aktif <3d):     5% (gentle nudge)
WARM (3-7d):        10% (medium push)
COLD (7-30d):       15% (re-engage)
GHOST (30-60d):     20% (last effort)
```

---

## ❌ KESALAHAN YANG DITEMUKAN

### **1. TRIGGER SETIAP PESAN = SPAM POTENTIAL** 🚨

**Masalah:**
```javascript
// index.js - bot.use() dipanggil SETIAP pesan/command
bot.use(async (ctx, next) => {
  // ...
  setTimeout(() => {
    scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {});
  }, 5000);
  
  return next();
});
```

**Skenario Abuse:**
```
User A:
08:00:00 → Kirim /start
08:00:05 → triggerRealtimeMarketing() → CEK (cooldown OK)
08:00:06 → Klik "Lihat Produk"
08:00:11 → triggerRealtimeMarketing() → CEK (cooldown OK)
08:00:12 → Kirim "Halo"
08:00:17 → triggerRealtimeMarketing() → CEK (cooldown OK)

Total: 3 trigger dalam 17 detik!
```

**Dampak:**
- ❌ **Function overhead**: triggerRealtimeMarketing() dipanggil berulang kali
- ❌ **Database queries**: 3x query User.findById, Discount.findOne, dll
- ⚠️ **Performance degradation** saat traffic tinggi

---

### **2. NO RATE LIMIT PER SESSION** 🚨

**Masalah:**
```javascript
// Cooldown check hanya cek last_broadcast_at (48 jam)
// Tidak ada limit trigger PER SESSION (misal: max 1x per 5 menit)
if (isInCooldown(user)) return;
```

**Skenario:**
```
User baru (tidak ada last_broadcast_at):
08:00:00 → /start → trigger #1 → PASS (no cooldown)
08:00:06 → Klik menu → trigger #2 → PASS (no cooldown)
08:00:12 → Kirim pesan → trigger #3 → PASS (no cooldown)

Semua PASS karena cooldown belum di-set!
(last_broadcast_at hanya di-set SETELAH kirim berhasil)
```

**Dampak:**
- ❌ **Multiple trigger** sebelum first message sent
- ❌ **Race condition** jika 2 trigger jalan parallel
- ⚠️ **Potential duplicate message** (walaupun jarang)

---

### **3. DELAY 5 DETIK TIDAK CUKUP** 🚨

**Masalah:**
```javascript
// Delay hanya 5 detik
setTimeout(() => {
  scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {});
}, 5000);
```

**Skenario:**
```
User A:
08:00:00 → Kirim /start
08:00:01 → Bot reply menu
08:00:05 → Trigger realtime marketing
08:00:06 → User dapat promo (TERLALU CEPAT!)

User baru buka bot, belum sempat baca menu,
langsung dibombardir promo!
```

**Dampak:**
- ❌ **Bad UX**: User kewalahan dengan 2 pesan bersamaan
- ⚠️ **Looks like spam**: Telegram user anggap bot spam
- ⚠️ **Lower engagement**: User langsung close bot

---

### **4. TIDAK CEK APAKAH USER SEDANG CHECKOUT** 🚨

**Masalah:**
```javascript
// Tidak ada check: apakah user sedang dalam proses checkout?
// Langsung kirim promo meskipun user sudah di halaman QR payment!
```

**Skenario:**
```
User B:
08:00:00 → Klik "Beli Sekarang" (produk A)
08:00:01 → Bot kirim QR code payment
08:00:05 → triggerRealtimeMarketing() triggered
08:00:06 → User dapat promo produk B (WHILE PAYING A!)

User confused: Lagi bayar produk A, kok dapat promo produk B?
```

**Dampak:**
- ❌ **Distraction during checkout**: User distracted, cancel payment
- ❌ **Lower conversion rate**: User pindah ke produk lain (abandon cart)
- ⚠️ **Bad timing**: Promo datang di waktu yang salah

---

### **5. DISKON 48 JAM TERLALU LAMA** 🚨

**Masalah:**
```javascript
// Diskon valid 48 jam
valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000)

// Padahal user dapat promo saat ONLINE (realtime)
// Seharusnya diskon SHORT-TERM untuk urgency!
```

**Dampak:**
- ❌ **No urgency**: User bisa "pikir-pikir dulu" 2 hari
- ⚠️ **Lower conversion rate**: Tidak ada FOMO
- ⚠️ **Discount abuse**: User bisa kumpulkan diskon dari berbagai trigger

---

### **6. SEGMENT CLASSIFICATION BASED ON LAST ACTIVE** 🚨

**Masalah:**
```javascript
// Segment berdasarkan last_active_at
const segment = await classifyNonBuyer(user);

// Tapi user BARU SAJA AKTIF (trigger realtime)!
// Jadi last_active_at = NOW
// Artinya: SEMUA user realtime = HOT (< 3 hari)!
```

**Bukti:**
```javascript
// index.js - Update last_active_at SEBELUM trigger
await User.findByIdAndUpdate(userId, { 
  $set: { last_active_at: new Date() }  // SET NOW!
});

// scheduler.js - classifyNonBuyer()
const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
// daysInactive = 0 (karena last_active_at baru di-update!)

if (daysInactive < 1) return 'HOT'; // SELALU HOT!
```

**Dampak:**
- ❌ **SEMUA realtime user = HOT segment** (5% diskon)
- ❌ **WARM/COLD/GHOST segment tidak pernah terpakai** dalam realtime
- ⚠️ **User yang seharusnya COLD (7+ hari) hanya dapat 5%** (harusnya 15%!)

---

## 🔧 SOLUSI PERBAIKAN

### **1. FIX: RATE LIMIT PER SESSION**
```javascript
// Tambah in-memory Set untuk tracking recent triggers
const recentTriggers = new Map(); // userId -> timestamp

async function triggerRealtimeMarketing(bot, userId) {
  // Check if already triggered in last 5 minutes
  const lastTrigger = recentTriggers.get(userId);
  if (lastTrigger && (Date.now() - lastTrigger) < 5 * 60 * 1000) {
    return; // Skip — already triggered recently
  }
  
  // ... rest of logic
  
  // Mark as triggered
  if (result.ok) {
    recentTriggers.set(userId, Date.now());
    
    // Cleanup old entries (memory leak prevention)
    setTimeout(() => recentTriggers.delete(userId), 10 * 60 * 1000);
  }
}
```

### **2. FIX: DELAY LEBIH LAMA**
```javascript
// Increase delay to 30 seconds (bukan 5 detik)
setTimeout(() => {
  scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {});
}, 30000); // 30 detik
```

### **3. FIX: SKIP IF IN CHECKOUT**
```javascript
async function triggerRealtimeMarketing(bot, userId) {
  // ... other checks
  
  // Check if user has pending order (in checkout process)
  const pendingOrder = await Order.findOne({
    user_id: userId,
    status: 'PENDING',
    created_at: { $gte: new Date(Date.now() - 15 * 60 * 1000) } // Last 15 min
  }).lean();
  
  if (pendingOrder) {
    return; // Skip — user sedang checkout!
  }
  
  // ... rest of logic
}
```

### **4. FIX: DISKON SHORT-TERM (URGENCY)**
```javascript
// Reduce discount validity to 6 hours (bukan 48 jam)
valid_until: new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 jam!

// Update pesan:
msg = `⏰ <b>PROMO KILAT — 6 JAM SAJA!</b>\n\n` +
      `Kamu lagi online — pas banget!\n\n` +
      `<b>Diskon ${discountVal}%</b> berakhir HARI INI jam ${endTime}.\n\n` +
      `Buruan sebelum hangus! 🔥`;
```

### **5. FIX: SEGMENT BASED ON PREVIOUS ACTIVITY**
```javascript
// Jangan update last_active_at sebelum classify
// Atau simpan "last_active_before_trigger"

async function triggerRealtimeMarketing(bot, userId) {
  // Ambil user SEBELUM last_active_at di-update
  const user = await User.findById(userId).lean();
  
  // Classify berdasarkan PREVIOUS activity (bukan NOW)
  const segment = await classifyNonBuyer(user);
  
  // ... rest
}
```

**Atau alternatif:**
```javascript
// Gunakan "joined_at" + "purchase_count" untuk segment
// Bukan "last_active_at"
function classifyNonBuyerRealtime(user) {
  const daysSinceJoin = (Date.now() - new Date(user.joined_at)) / (1000*60*60*24);
  
  if (user.purchase_count === 0 && daysSinceJoin < 7) return 'HOT';
  if (user.purchase_count === 0 && daysSinceJoin < 30) return 'WARM';
  if (user.purchase_count === 0 && daysSinceJoin < 60) return 'COLD';
  return 'GHOST';
}
```

---

## 📊 SUMMARY

### **SISTEM REALTIME MARKETING:**
- ✅ **Konsep bagus**: Kirim saat user online (bukan jam tetap)
- ✅ **Timing perfect**: User aktif = ready to engage
- ✅ **Cooldown 48h**: Anti-spam protection

### **KESALAHAN:**
1. ❌ Trigger setiap pesan (performance overhead)
2. ❌ No rate limit per session (potential spam)
3. ❌ Delay terlalu pendek (bad UX)
4. ❌ Tidak skip saat checkout (distraction)
5. ❌ Diskon 48 jam (no urgency)
6. ❌ Segment classification broken (semua jadi HOT!)

### **IMPACT:**
- ❌ **Performance**: Database queries berlebihan
- ❌ **UX**: User kewalahan, spam-like behavior
- ❌ **Conversion**: Lower rate karena no urgency & wrong segment

### **FIX PRIORITY:**
1. 🔴 **URGENT**: Segment classification (semua jadi HOT = salah!)
2. 🟠 **HIGH**: Rate limit per session
3. 🟠 **HIGH**: Skip if in checkout
4. 🟡 **MEDIUM**: Increase delay to 30s
5. 🟡 **MEDIUM**: Short-term discount (6h)

---

**FILE TERSEDIA**: `🎯_SISTEM_REALTIME_MARKETING.md`

**Mau saya fix yang mana dulu?** 🚀

