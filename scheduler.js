/**
 * scheduler.js — Behavioral Marketing Automation (Full Version)
 *
 * CAMPAIGN 1 — Non-Buyer (Belum beli sama sekali):
 *   CART_ABANDON : Klik beli tapi tidak jadi bayar dalam 72 jam
 *   INACTIVE     : Tidak aktif > 7 hari
 *   COLD_LEAD    : Buka bot, belum pernah klik beli
 *
 * CAMPAIGN 2 — Cross-Sell (Sudah beli sebagian, belum lengkap):
 *   Smart Recommendation: rekomendasikan produk populer di antara similar users
 *   Fallback: produk terlaris keseluruhan → urutan database
 *
 * CAMPAIGN 3 — Drip Follow-Up (Bertingkat 3 Tahap):
 *   Stage 1 (D+0) : Pesan awal (dari campaign 1 atau 2)
 *   Stage 2 (D+3) : Pesan urgensi "Promo hampir habis!"
 *   Stage 3 (D+6) : Final reminder + diskon khusus
 *
 * Anti-Spam : User hanya dapat 1 pesan otomatis per 3 hari
 * Template  : Bisa diubah Admin via /set_msg
 */

const { User, UserEvent, Order, OrderItem, Product, DripLog, BroadcastLog, Setting, Discount, ABTestResult, CronProgress } = require('./database');
const { Markup } = require('telegraf');
const cron = require('node-cron');
let previewModule = null;
try { previewModule = require('./preview'); } catch(e) { /* preview module optional */ }

const formatRupiah = (angka) => 'Rp' + angka.toLocaleString('id-ID');

let marketingEnabled = true;
let cronTasks = []; // Array of node-cron tasks (restart-proof)
let lastCronDate = null; // Still used for manual/startup run guard

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function getSetting(key, defaultVal) {
  const row = await Setting.findById(key).lean();
  return row ? row.value : defaultVal;
}

async function getMsg(key, defaultMsg) {
  return await getSetting('marketing_' + key, defaultMsg);
}

function formatK(num) {
  return num >= 1000 ? (num / 1000) + 'k' : num.toString();
}

function strikeThrough(text) {
  return text.split('').join('\u0336') + '\u0336';
}

function buildProductMarkup(product, discountAmount = 0) {
  const buttons = [];
  if (product.preview_url) {
    buttons.push([Markup.button.url(`📺 Preview Content ${product.name}`, product.preview_url)]);
  }

  if (discountAmount > 0 && product.price > discountAmount) {
    const finalPrice = Math.max(0, product.price - discountAmount);
    const originalK = formatK(product.price);
    const numPart = originalK.replace('k', '');
    const kPart = originalK.includes('k') ? 'k' : '';
    buttons.push([Markup.button.callback(`💥 SIKAT DISKON! ${strikeThrough(numPart)}${kPart} ➔ Rp${formatK(finalPrice)}`, `buy_now_${product._id}`)]);
  } else {
    buttons.push([Markup.button.callback(`🔥 AMANKAN AKSES VIP (Rp${formatK(product.price)})`, `buy_now_${product._id}`)]);
  }
  return Markup.inlineKeyboard(buttons);
}

async function calculateDynamicDiscount(user) {
  const daysSinceJoin = (Date.now() - new Date(user.joined_at)) / (1000 * 60 * 60 * 24);
  const purchaseCount = user.purchase_count || 0;
  const totalSpent = user.total_spent || 0;

  if (totalSpent > 100000 || purchaseCount >= 5) {
    return { percentage: 10, title: 'Khusus Member VIP' };
  }
  
  if (purchaseCount === 0 && daysSinceJoin > 30) {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const prevBigDiscounts = await Discount.countDocuments({
      target_user_id: user._id,
      type: 'PERCENTAGE',
      value: { $gte: 25 },
      created_at: { $gte: ninetyDaysAgo }
    });
    
    if (prevBigDiscounts >= 2) return { percentage: 25, title: 'Spesial Comeback 25%' };
    if (prevBigDiscounts === 1) return { percentage: 35, title: 'Spesial Comeback 35%' };
    return { percentage: 50, title: 'Spesial Comeback 50%' };
  }
  
  if (purchaseCount === 0 && daysSinceJoin <= 30) {
    return { percentage: 20, title: 'Diskon Khusus 20%' };
  }
  
  return { percentage: 15, title: 'Promo Pelanggan Setia' };
}

async function sendSafe(bot, userId, text, options = {}) {
  try {
    const extra = { parse_mode: 'HTML' };
    if (options.keyboard && options.keyboard.reply_markup) {
      extra.reply_markup = options.keyboard.reply_markup;
    } else if (options.keyboard) {
      extra.reply_markup = options.keyboard;
    }
    
    if (options.media) {
      const hType = options.mediaType || "url";
      const hFile = options.media;
      if (hType === "photo" || (hType === "url" && hFile.match(/\.(jpeg|jpg|png)$/i))) {
        await bot.telegram.sendPhoto(userId, hFile, { caption: text, ...extra });
      } else {
        await bot.telegram.sendAnimation(userId, hFile, { caption: text, ...extra });
      }
    } else {
      await bot.telegram.sendMessage(userId, text, extra);
    }
    
    await User.findByIdAndUpdate(userId, { last_broadcast_at: new Date() });
    return { ok: true };
  } catch (err) {
    const isBlocked = err.description && (
      err.description.includes('bot was blocked') ||
      err.description.includes('user is deactivated') ||
      err.description.includes('chat not found')
    );
    if (isBlocked) await User.findByIdAndUpdate(userId, { is_blocked: true });
    return { ok: false, isBlocked, error: err.message };
  }
}

// Cek apakah user pernah dikirimi broadcast dalam 6 jam terakhir (Anti-Spam Shield Fast-Paced)
function isInCooldown(user) {
  if (String(user._id) === String(process.env.ADMIN_CHAT_ID)) return false; // Admin kebal cooldown untuk testing
  if (!user.last_broadcast_at) return false;
  const hoursSinceLast = (new Date() - new Date(user.last_broadcast_at)) / (1000 * 60 * 60);
  return hoursSinceLast < 6;
}

// ─── CAMPAIGN 1: NON-BUYER ──────────────────────────────────────────────────

// Klasifikasikan kenapa user belum beli
async function classifyNonBuyer(user) {
  const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
  
  if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
    const hoursSinceCheckout = (new Date() - new Date(lastEvent.created_at)) / (1000 * 60 * 60);
    // Upgrade 1: Cart Abandonment instan jika > 30 menit (0.5 jam) tapi < 30 hari
    if (hoursSinceCheckout >= 0.5 && hoursSinceCheckout <= 30 * 24) {
      return 'CART_ABANDON';
    }
  }

  const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
  if (daysInactive > 7) {
    // Tidak buka bot > 7 hari -> Inactive
    return 'INACTIVE';
  }

  // Buka bot, belum pernah klik beli -> Cold Lead
  return 'COLD_LEAD';
}

async function runNonBuyerCampaign(bot) {
  // ─ CART ABANDON: User udah mau beli tapi kabur ─
  const msgCartAbandon = await getMsg('cart_abandon',
    `🔴 <b>Bos, Anda Hampir Dapat Akses {produk}!</b>\n\n` +
    `Jangan sampai Anda menyesal — ini bukan channel JAV biasa.\n\n` +
    `🇮🇩 <b>Subtitle Indonesia dikerjakan sendiri oleh tim kami</b>\n` +
    `<i>Bukan repost, bukan auto-sub. Hasil terjemahan manusia, bukan mesin.</i>\n\n` +
    `<blockquote>Slot VIP Anda masih tersimpan selama beberapa menit ke depan.</blockquote>\n\n` +
    `👇 <b>Selesaikan Pembayaran Sekarang</b>`
  );

  // ─ INACTIVE: Sudah lama tidak buka bot ─
  // Angle: Update subtitle terus bertambah, makin banyak kalau nunggu!
  const msgInactive = await getMsg('inactive',
    `🇮🇩 <b>Update Subtitle Baru {produk} Sudah Keluar!</b>\n\n` +
    `Tim J-SUB Collection baru saja selesai menerjemahkan batch subtitle baru.\n\n` +
    `🎬 Puluhan video baru + subtitle Indo eksklusif\n` +
    `🔍 Cari & request video langsung via bot\n` +
    `✅ Bukan repost — subtitle dikerjakan manual oleh admin\n\n` +
    `<blockquote>Semakin banyak koleksi = harga VIP akan naik. Sekarang masih harga opening.</blockquote>\n\n` +
    `👇 <b>Gabung VIP Sekarang</b>`
  );

  // ─ COLD LEAD: Belum pernah klik beli ─
  // Angle: Social proof + unique value yang tidak ada di tempat lain
  const msgColdLead = await getMsg('cold_lead',
    `🌟 <b>Kenapa 3.200+ Member Pilih {produk}?</b>\n\n` +
    `Satu alasan utama: <b>Subtitle Indonesia buatan sendiri.</b>\n\n` +
    `Di luar sana banyak channel JAV, tapi hampir semua:\n` +
    `❌ Repost dari channel lain\n` +
    `❌ Subtitle mesin (tidak akurat)\n` +
    `❌ Tidak ada yang bisa di-request\n\n` +
    `Di <b>{produk}</b>:\n` +
    `✅ Subtitle 100% dikerjakan tim sendiri\n` +
    `✅ Request video via bot, langsung diproses\n` +
    `✅ Cari video via bot, tanpa scroll capek\n` +
    `✅ Akses permanen, bayar sekali\n\n` +
    `<blockquote>Harga opening DISKON berlangsung. Segera naik seiring koleksi bertambah.</blockquote>\n\n` +
    `👇 <b>Amankan Akses VIP Sekarang</b>`
  );

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const nonBuyers = await User.find({ 
    $or: [
      { purchase_count: 0 },
      { purchase_count: null },
      { purchase_count: { $exists: false } }
    ],
    is_blocked: { $ne: true },
    last_active_at: { $gte: sixtyDaysAgo }
  }).lean();
  const stats = { cold: 0, abandon: 0, inactive: 0, skipped: 0, failed: 0 };

  const allProducts = await Product.find({ active: 1 }).lean();
  let defaultProduct = null;
  if (allProducts.length > 0) {
    const popular = await OrderItem.aggregate([
      { $group: { _id: '$product_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);
    if (popular.length > 0) {
      defaultProduct = allProducts.find(p => String(p._id) === String(popular[0]._id)) || allProducts[0];
    } else {
      defaultProduct = allProducts[0];
    }
  }

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");
  let keyboard = null;
  if (defaultProduct) keyboard = buildProductMarkup(defaultProduct);

  for (const user of nonBuyers) {
    if (isInCooldown(user)) { stats.skipped++; continue; }

    if (defaultProduct) {
      const existingDrip = await DripLog.findOne({ user_id: user._id, product_id: String(defaultProduct._id), converted: false }).lean();
      if (existingDrip) {
        // [BUGFIX] Stage 5 Recycling: Jika user di-reset ke stage:0, langsung upgrade ke stage:1
        // agar masuk pipeline lagi. Tanpa ini, user stuck selamanya di stage:0.
        if (existingDrip.stage === 0) {
          await DripLog.findByIdAndUpdate(existingDrip._id, { stage: 1, sent_at: new Date() });
          // Lanjutkan — biarkan user ini diproses dalam iterasi ini
        } else {
          stats.skipped++;
          continue; // Jangan spam Campaign 1 jika user masih dalam Funnel (Stage 1, 2, 3)
        }
      }
    }

    const segment = await classifyNonBuyer(user);
    let msg = segment === 'CART_ABANDON' ? msgCartAbandon
               : segment === 'INACTIVE'     ? msgInactive
               : msgColdLead;
               
    if (defaultProduct) {
      msg = msg.replace(/\{produk\}/g, defaultProduct.name);
    }

    // 🔥 KIRIM PREVIEW DULU sebelum teks promo (bila ada cache preview dari grup VIP)
    // Ini membuat user melihat konten nyata sebelum pitch = konversi jauh lebih tinggi
    if (previewModule) {
      try {
        await previewModule.sendPreviewToUser(bot, user._id, 3);
        await delay(800); // Jeda sebentar agar preview tampil lebih dulu
      } catch(e) { /* preview gagal = skip saja, jangan crash campaign */ }
    }

    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
    if (result.ok) {
      if (segment === 'CART_ABANDON') stats.abandon++;
      else if (segment === 'INACTIVE') stats.inactive++;
      else stats.cold++;

      if (defaultProduct) {
        // Upgrade 2: Berikan Diskon 10% sejak Stage 1 untuk CART_ABANDON agar segera convert
        let initialDiscount = 0;
        if (segment === 'CART_ABANDON') {
          initialDiscount = 10;
          await Discount.create({
            target_user_id: Number(user._id),
            type: 'PERCENTAGE',
            value: initialDiscount,
            valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000)
          });
        }

        await DripLog.create({
          user_id: user._id,
          product_id: String(defaultProduct._id),
          campaign_type: 'NON_BUYER',
          stage: 1,
          sent_at: new Date(),
          variant: Math.random() > 0.5 ? 'A' : 'B'
        });
      }
    } else {
      stats.failed++;
    }
    await delay(1500);
  }
  return stats;
}

// ─── CAMPAIGN 2: CROSS-SELL + SMART RECOMMENDATION ─────────────────────────

async function getBoughtProductIds(userId) {
  const successOrders = await Order.find({ user_id: userId, status: 'SUCCESS' }).lean();
  if (!successOrders.length) return [];
  const orderIds = successOrders.map(o => o._id);
  const items = await OrderItem.find({ order_id: { $in: orderIds } }).lean();
  return [...new Set(items.map(i => String(i.product_id)))];
}

// Smart Recommendation: cari produk populer di antara user dengan profil beli serupa
async function getSmartRecommendation(userId, boughtIds, allProducts) {
  const unbought = allProducts.filter(p => !boughtIds.includes(String(p._id)));
  if (!unbought.length) return null;

  try {
    // Cari user yang pernah beli produk yang sama
    const similarUsersQuery = await OrderItem.aggregate([
      { $match: { product_id: { $in: boughtIds } } },
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.status': 'SUCCESS', 'order.user_id': { $ne: userId } } },
      { $group: { _id: '$order.user_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 }
    ]);
    
    if (similarUsersQuery.length > 0) {
      const similarUserIds = similarUsersQuery.map(u => u._id);
      
      // Cari produk apa yang paling banyak dibeli oleh similar users, yang belum dimiliki target
      const topCandidates = await OrderItem.aggregate([
        { $match: { product_id: { $nin: boughtIds } } },
        { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
        { $unwind: '$order' },
        { $match: { 'order.user_id': { $in: similarUserIds }, 'order.status': 'SUCCESS' } },
        { $group: { _id: '$product_id', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);

      if (topCandidates.length > 0) {
        const recommended = allProducts.find(p => String(p._id) === String(topCandidates[0]._id));
        if (recommended) return recommended;
      }
    }

    // Fallback 1: produk terlaris secara keseluruhan yang belum dimiliki
    const globalTop = await OrderItem.aggregate([
      { $match: { product_id: { $nin: boughtIds } } },
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.status': 'SUCCESS' } },
      { $group: { _id: '$product_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);

    if (globalTop.length > 0) {
      const recommended = allProducts.find(p => String(p._id) === String(globalTop[0]._id));
      if (recommended) return recommended;
    }
  } catch (e) {
    // Silent fail, pakai urutan database sebagai fallback final
  }

  // Fallback final: urutan database
  return unbought[0];
}

async function runCrossSellCampaign(bot, allProducts) {
  if (allProducts.length < 2) return { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  const msgTemplate = await getMsg('cross_sell',
    '\u{1F451} *Upgrade ke {produk_baru}!*\n' +
    'Punya {produk_lama} belum cukup.\n\n' +
    '\u27DF VIP Permanen\n' +
    '\u27DF Update Otomatis\n\n' +
    '\u{1F447} Order sekarang'
  );

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const partialBuyers = await User.find({ 
    purchase_count: { $gt: 0 }, 
    is_blocked: { $ne: true },
    last_active_at: { $gte: sixtyDaysAgo }
  }).lean();
  const totalCount = allProducts.length;
  const stats = { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

  for (const user of partialBuyers) {
    if (isInCooldown(user)) { stats.skipped++; continue; }

    const boughtIds = await getBoughtProductIds(user._id);
    if (boughtIds.length >= totalCount) { stats.complete++; continue; }

    // Smart Recommendation (bukan lagi sekedar urutan database)
    const targetProduct = await getSmartRecommendation(user._id, boughtIds, allProducts);
    if (!targetProduct) { stats.skipped++; continue; }

    const boughtNames = allProducts
      .filter(p => boughtIds.includes(String(p._id)))
      .map(p => p.name).join(' & ') || 'VIP';

    const msg = msgTemplate
      .replace('{nama}', user.first_name || 'Kamu')
      .replace('{produk_lama}', boughtNames)
      .replace('{produk_baru}', targetProduct.name);

    const keyboard = buildProductMarkup(targetProduct);

    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
    if (result.ok) {
      // Simpan ke DripLog untuk follow-up bertingkat
      const existingDrip = await DripLog.findOne({ user_id: user._id, product_id: String(targetProduct._id), converted: false }).lean();
      if (!existingDrip) {
        await DripLog.create({
          user_id: user._id,
          product_id: String(targetProduct._id),
          campaign_type: 'CROSS_SELL',
          stage: 1,
          sent_at: new Date(),
          variant: Math.random() > 0.5 ? 'A' : 'B'
        });
      }

      stats.crossSell++;
    } else {
      stats.failed++;
    }
    await delay(1500);
  }
  return stats;
}

// ─── CAMPAIGN 3: DRIP FOLLOW-UP (BERTINGKAT) ───────────────────────────────

async function runDripFollowUp(bot) {
  const stats = { stage2: 0, stage3: 0, skipped: 0, failed: 0 };
  const now = new Date();

  // === HARD CAP 90 HARI: Tutup funnel diam-diam jika macet terlalu lama ===
  const ninetyDaysAgo = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000));
  try {
    await DripLog.updateMany(
      { converted: false, created_at: { $lte: ninetyDaysAgo } },
      { $set: { converted: true, exited_reason: 'TIMEOUT' } }
    );
  } catch (err) {
    console.error('[DRIP] Gagal eksekusi 90-day hard cap:', err);
  }

  const sixHoursAgo = new Date(now.getTime() - (6 * 60 * 60 * 1000));
  const twelveHoursAgo = new Date(now.getTime() - (12 * 60 * 60 * 1000));

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

  // === Stage 2: Kirim urgensi ke yang sudah 6 jam di stage 1 dan belum beli ===
  const stage1Logs = await DripLog.find({
    stage: 1,
    sent_at: { $lte: sixHoursAgo },
    converted: false
  }).lean();

  for (const log of stage1Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
        continue;
      }

      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const forceSend = new Date(log.sent_at) <= fourteenDaysAgo;
      if (!forceSend && isInCooldown(user)) continue;

      if (log.campaign_type === 'NON_BUYER' && user.purchase_count > 0) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
        continue;
      } else if (log.campaign_type === 'CROSS_SELL') {
        const boughtIds = await getBoughtProductIds(user._id);
        if (boughtIds.includes(String(log.product_id))) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
          continue;
        }
      }

      const product = await Product.findById(log.product_id).lean();
      const productName = product ? product.name : 'produk pilihan kami';

      // Stage 2: PANIC + PERSONAL. Nama user dipanggil, unique value ditonjolkan!
      const msg = log.variant === 'B'
        ? `📹 <b>${user.first_name || 'Bos'}, Ini Yang Anda Lewatkan di ${productName}:</b>\n\n` +
          `Baru saja tim kami selesai translate subtitle untuk 5 video baru.\n` +
          `Member VIP sudah bisa nonton. Anda belum.\n\n` +
          `🇮🇩 Subtitle Indonesia manual (bukan mesin)\n` +
          `🔍 Request & cari video via bot 24 jam\n` +
          `♾️ Akses selamanya, bayar sekali\n\n` +
          `<blockquote>Channel masih baru = harga masih opening. Sebentar lagi naik.</blockquote>\n\n` +
          `👇 <b>Gabung Sebelum Harga Naik</b>`
        : `⚠️ <b>${user.first_name || 'Bos'}, Slot VIP Menyempit!</b>\n\n` +
          `<b>${productName}</b> bukan channel repost biasa.\n` +
          `Semua subtitle Indo dikerjakan manual oleh tim kami.\n\n` +
          `Fakta: harga akan naik otomatis seiring koleksi bertambah.\n` +
          `Sekarang masih harga opening terbaik.\n\n` +
          `<blockquote>Jangan tunda lagi — rugi kalau bayar lebih mahal nanti.</blockquote>\n\n` +
          `👇 <b>Kunci Harga Opening Sekarang</b>`;

      let keyboard = null;
      if (product) keyboard = buildProductMarkup(product);

      const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 2, sent_at: new Date() });
        stats.stage2++;
      } else {
        if (result.isBlocked) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
        }
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      console.error(`[DRIP] Error di Stage 2 untuk log ${log._id} (User: ${log.user_id}):`, err);
      continue;
    }
  }

  // === Stage 3: Final reminder + diskon khusus ke yang sudah 12 jam di stage 2 ===
  const stage2Logs = await DripLog.find({
    stage: 2,
    sent_at: { $lte: twelveHoursAgo },
    converted: false
  }).lean();

  for (const log of stage2Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
        continue;
      }

      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const forceSend = new Date(log.sent_at) <= fourteenDaysAgo;
      if (!forceSend && isInCooldown(user)) continue;

      if (log.campaign_type === 'NON_BUYER' && user.purchase_count > 0) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
        continue;
      } else if (log.campaign_type === 'CROSS_SELL') {
        const boughtIds = await getBoughtProductIds(user._id);
        if (boughtIds.includes(String(log.product_id))) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
          continue;
        }
      }

      const product = await Product.findById(log.product_id).lean();
      const discountRule = await calculateDynamicDiscount(user);
      const discountAmount = product ? Math.floor(product.price * (discountRule.percentage / 100)) : 0;
      
      // Psikologi Stage 3: PERSONAL DISCOUNT + TRUST. Diskon terasa eksklusif untuk dia saja!
      const msg = log.variant === 'B'
        ? `💌 <b>${user.first_name || 'Bos'}, Ini Pesan Pribadi dari Tim Kami</b>\n\n` +
          `Kami perhatikan Anda sudah 2x melihat ${product ? product.name : 'channel kami'} tapi belum bergabung.\n\n` +
          `Kami ingin Anda di dalam, jadi kami siapkan:\n\n` +
          `🎁 <b>Kupon Diskon ${discountRule.percentage}% - Khusus untuk Anda</b>\n` +
          `⏳ <i>Berlaku hanya 72 jam ke depan</i>\n\n` +
          `<blockquote>Harga sudah otomatis terpotong di tombol di bawah.</blockquote>\n\n` +
          `👇 <b>Pakai Diskon Saya Sekarang</b>`
        : `💥 <b>FLASH DEAL: Diskon ${discountRule.percentage}% Untuk ${user.first_name || 'Anda'}!</b>\n\n` +
          `Sistem kami secara otomatis mendeteksi bahwa Anda layak mendapat harga spesial.\n\n` +
          `Ini yang Anda dapatkan:\n` +
          `✅ Akses ${product ? product.name : 'VIP'} selamanya\n` +
          `✅ Update harian JAV Sub Indo\n` +
          `✅ Harga ${discountRule.percentage}% lebih murah dari harga normal\n\n` +
          `<blockquote>Kupon hangus dalam 72 jam. Tidak bisa diperpanjang.</blockquote>\n\n` +
          `👇 <b>Klaim Diskon ${discountRule.percentage}% Saya</b>`;

      let keyboard = null;
      if (product) keyboard = buildProductMarkup(product, discountAmount);

      const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 3, sent_at: new Date() });
        
        // Simpan riwayat diskon yang diberikan (72 jam = 3 hari agar user sempat pakai)
        // FIX: target_user_id harus Number, valid_until 72 jam bukan 24 jam
        await Discount.create({
          target_user_id: Number(user._id),
          type: 'PERCENTAGE',
          value: discountRule.percentage,
          valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000)
        });

        stats.stage3++;
      } else {
        if (result.isBlocked) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
        }
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      console.error(`[DRIP] Error di Stage 3 untuk log ${log._id} (User: ${log.user_id}):`, err);
      continue;
    }
  }

  
  // === Stage 4 (Upgrade): Down-sell Ekstrem 70% untuk user yang abaikan Stage 3 > 7 hari ===
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stage3Logs = await DripLog.find({
    stage: 3,
    campaign_type: 'NON_BUYER', // SUPER PENTING: Hanya untuk yang belum pernah beli!
    sent_at: { $lte: sevenDaysAgo },
    converted: false
  }).lean();

  for (const log of stage3Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
        continue;
      }
      if (isInCooldown(user)) continue;

      const product = await Product.findById(log.product_id).lean();
      if (!product) {
         await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
         continue;
      }

      const msgStage4 = `🚨 <b>KESEMPATAN TERAKHIR: DISKON CUCI GUDANG 70%!</b>\n\n` +
                        `Ini adalah penawaran terakhir dan paling gila dari kami untuk <b>{produk}</b>.\n` +
                        `Jika Anda melewatkan ini, penawaran tidak akan pernah muncul lagi.\n\n` +
                        `<blockquote>Klaim diskon 70% Anda sekarang sebelum akses ditutup selamanya.</blockquote>`;

      let finalMsg = msgStage4.replace(/{produk}/g, product.name);
      const discountAmount = Math.floor(product.price * 0.7); // 70%
      const keyboard = buildProductMarkup(product, discountAmount); 

      const result = await sendSafe(bot, user._id, finalMsg, { media: hFile, mediaType: hType, keyboard });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 4, sent_at: new Date() });
        
        await Discount.create({
          target_user_id: Number(user._id),
          type: 'PERCENTAGE',
          value: 70, // 70% discount for escape hatch
          valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000)
        });

        stats.stage4 = (stats.stage4 || 0) + 1;
      } else {
        if (result.isBlocked) await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      console.error('[DRIP] Error di Stage 4', err);
      continue;
    }
  }

  // === Stage 5 (Recycling): Masukkan ulang ke pipeline setelah 14 hari ===
  const fourteenDaysAgoForReset = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const stage4Logs = await DripLog.find({
    stage: 4,
    converted: false,
    sent_at: { $lte: fourteenDaysAgoForReset }
  }).lean();

  for (const log of stage4Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked || user.purchase_count > 0) {
        // Jika ternyata sudah beli atau diblokir, tutup saja selamanya
        await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'CLEANUP' });
        continue;
      }

      // Reset user ke stage 0 agar masuk pipeline dari awal lagi!
      // Kita set sent_at ke 'now' supaya besok baru dikirim stage 1-nya
      await DripLog.findByIdAndUpdate(log._id, { 
        stage: 0, 
        sent_at: new Date(),
        variant: Math.random() > 0.5 ? 'A' : 'B', // Ganti varian (A/B testing)
        exited_reason: null // Reset agar tidak dianggap TIMEOUT/BLOCKED
      });
      console.log(`[DRIP] ♻️ Mereset user ${log.user_id} dari Stage 4 kembali ke awal pipeline!`);
      stats.recycled = (stats.recycled || 0) + 1;
    } catch (err) {
      console.error('[DRIP] Error mereset Stage 4', err);
    }
  }

  return stats;
}

// Fungsi publik: tandai DripLog sebagai converted saat user beli
// Dipanggil dari store.js saat fulfillOrder
async function markDripConverted(userId, amount = 0) {
  try {
    const logs = await DripLog.find({ user_id: userId, converted: false }).lean();
    for (const log of logs) {
      await DripLog.findByIdAndUpdate(log._id, { 
        converted: true,
        $inc: { revenue_generated: amount },
        exited_reason: 'PURCHASE'
      });
      if (log.variant) {
        await ABTestResult.create({
          variant: log.variant,
          stage: log.stage,
          converted: true,
          revenue_generated: amount,
          created_at: new Date()
        });
      }
    }
  } catch (e) { /* silent */ }
}

// ─── CAMPAIGN UTAMA ──────────────────────────────────────────────────────────

async function runMarketingCampaign(bot, todayStr) {
  if (!marketingEnabled) {
    return { skipped: true, reason: 'Marketing dimatikan Admin' };
  }

  let progress = await CronProgress.findOne({ date: todayStr });
  if (!progress) progress = await CronProgress.create({ date: todayStr, campaign: 'START' });

  // Upgrade 3: Peak Hours berdasarkan DATA REAL - jam pembayaran terbanyak
  // Data: Jam 17 (7 bayar), 21 (3 bayar), 23 (2 bayar), 01 (3 bayar), 07 (3 bayar)
  // Hari terbaik: Minggu, Senin, Selasa
  const currentHour = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Jakarta'})).getHours();
  const currentDay = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Jakarta'})).getDay(); // 0=Minggu, 1=Senin
  // Peak hours: 07, 09, 12, 17, 21, 23, 01 (semua jam aktif user)
  const isPeakHour = [7, 9, 12, 17, 21, 23, 1].includes(currentHour);
  // Weekend boost: Sabtu-Senin kirim lebih agresif (hari dengan konversi tertinggi)
  const isHighConversionDay = [0, 1, 2].includes(currentDay); // Minggu, Senin, Selasa

  let dripStats = { stage2: 0, stage3: 0, stage4: 0, skipped: 0, failed: 0 };
  let nonBuyerStats = { cold: 0, abandon: 0, inactive: 0, skipped: 0, failed: 0 };
  let vipCount = 0;
  let crossSellStats = { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  if (progress.campaign === 'START') {
    console.log('[MARKETING] Campaign 3: Drip Follow-Up (Stage 2 & 3)...');
    dripStats = await runDripFollowUp(bot);
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'DRIP_DONE' });
    progress.campaign = 'DRIP_DONE';
  }

  if (progress.campaign === 'DRIP_DONE') {
    console.log('[MARKETING] Campaign 1: Non-Buyer...');
    nonBuyerStats = await runNonBuyerCampaign(bot);
    
    // Only advance progress if it's a peak hour, so next campaigns can run later
    if (isPeakHour || Object.values(nonBuyerStats).reduce((a,b)=>a+b,0) > 0) {
      await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'NON_BUYER_DONE' });
      progress.campaign = 'NON_BUYER_DONE';
    }
  }

  if (progress.campaign === 'NON_BUYER_DONE' && isPeakHour) {
    console.log('[MARKETING] Campaign VIP Win-Back...');
    vipCount = await runVIPWinBackCampaign(bot);
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'VIP_DONE' });
    progress.campaign = 'VIP_DONE';
  }

  if (progress.campaign === 'VIP_DONE' && isPeakHour) {
    const allProducts = await Product.find({ active: 1 }).lean();
    console.log('[MARKETING] Campaign 2: Cross-Sell (Smart Recommendation)...');
    crossSellStats = await runCrossSellCampaign(bot, allProducts);
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'COMPLETED', completed: true });
  }

  const combined = {
    cold: nonBuyerStats.cold,
    abandon: nonBuyerStats.abandon,
    inactive: nonBuyerStats.inactive,
    crossSell: crossSellStats.crossSell,
    complete: crossSellStats.complete,
    stage2: dripStats.stage2,
    stage3: dripStats.stage3,
    stage4: dripStats.stage4,
    vipWinBack: vipCount,
    skipped: nonBuyerStats.skipped + crossSellStats.skipped + dripStats.skipped,
    failed: nonBuyerStats.failed + crossSellStats.failed + dripStats.failed
  };

  // Bersihkan user yang sudah nge-block (Auto-cleanup Upgrade 5)
  try { await User.deleteMany({ is_blocked: true, purchase_count: { $in: [0, null] } }); } catch(e){}

  return combined;
}

// Fungsi helper delay (agar tidak spam rate limit)
const delay = ms => new Promise(r => setTimeout(r, ms));

// Fungsi publik untuk tes marketing output
async function sendTestMarketing(bot, userId, type) {
  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");
  
  const allProducts = await Product.find({ active: 1 }).lean();
  let defaultProduct = allProducts.length > 0 ? allProducts[0] : { _id: "dummy", name: "Produk Contoh", price: 50000 };
  let keyboard = buildProductMarkup(defaultProduct);

  let msg = '';

  if (type === 'cold_lead') {
    msg = await getMsg('cold_lead', '\u23F3 *Promo Perdana {produk}! (24 Jam)*\n\n\u27DF Ribuan konten update tiap hari\n\u27DF Sekali bayar, aktif selamanya\n\n\u{1F447} Amankan sekarang');
    msg = msg.replace(/\{produk\}/g, defaultProduct.name);
  } else if (type === 'cart_abandon') {
    msg = await getMsg('cart_abandon', '\u26A0\uFE0F *Selesaikan Transaksi {produk}*\n\n\u27DF Jangan lewatkan update terbaru\n\n\u{1F447} Lanjut di bawah');
    msg = msg.replace(/\{produk\}/g, defaultProduct.name);
  } else if (type === 'inactive') {
    msg = await getMsg('inactive', '\u2728 *Koleksi {produk} Rilis!*\n\n\u27DF Ratusan update panas minggu ini\n\n\u{1F447} Cek sekarang');
    msg = msg.replace(/\{produk\}/g, defaultProduct.name);
  } else if (type === 'cross_sell') {
    const msgTemplate = await getMsg('cross_sell', '\u{1F451} *Upgrade ke {produk_baru}!*\nPunya {produk_lama} belum cukup.\n\n\u27DF VIP Permanen\n\u27DF Update Otomatis\n\n\u{1F447} Order sekarang');
    msg = msgTemplate.replace('{produk_lama}', 'VIP Basic').replace('{produk_baru}', defaultProduct.name);
  } else if (type === 'stage2') {
    msg = `\u23F3 *Promo ${defaultProduct.name} Mau Habis!*\n\n\u27DF Slot sangat terbatas\n\n\u{1F447} Amankan segera`;
  } else if (type === 'stage3') {
    // Simulasi untuk test marketing (misalnya profil Dead Lead)
    const mockUser = { _id: 1, joined_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000), purchase_count: 0, total_spent: 0 };
    const discountRule = await calculateDynamicDiscount(mockUser);
    const discountAmount = Math.floor(defaultProduct.price * (discountRule.percentage / 100));
    
    msg = `\u{1F48E} *${discountRule.title} ${defaultProduct.name}!*\n\n\u27DF Potongan otomatis (24 Jam)\n\n\u{1F447} Klaim diskon sekarang`;
    keyboard = buildProductMarkup(defaultProduct, discountAmount);
  } else if (type === 'downsell') {
    msg = `\u{1F614} *Masih Ragu, Bos?*\n\nMungkin penawaran sebelumnya belum cocok untukmu saat ini.\n\nSebagai opsi paling hemat, cobalah *${defaultProduct.name}*!\n\n\u27DF Harga sangat terjangkau\n\u27DF Akses instan\n\n\u{1F447} Coba opsi hemat ini`;
  } else {
    return { ok: false, error: 'Tipe tidak valid. Gunakan: cold_lead, cart_abandon, inactive, cross_sell, stage2, stage3' };
  }

  return await sendSafe(bot, userId, `[TEST MODE]\n\n${msg}`, { media: hFile, mediaType: hType, keyboard });
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────
async function cleanupConvertedDripLogs() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    const result = await DripLog.deleteMany({ converted: true, sent_at: { $lte: thirtyDaysAgo } });
    if (result.deletedCount > 0) {
      console.log(`[CLEANUP] Dihapus ${result.deletedCount} DripLog yang sudah converted (> 30 hari).`);
    }
  } catch (err) {
    console.error('[CLEANUP] Gagal menghapus DripLog:', err);
  }
}

// ─── VIP WIN-BACK ────────────────────────────────────────────────────────────
async function runVIPWinBackCampaign(bot) {
  let count = 0;
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  
  const vips = await User.find({
    $or: [{ total_spent: { $gt: 100000 } }, { purchase_count: { $gte: 5 } }],
    last_active_at: { $lte: fourteenDaysAgo, $gte: sixtyDaysAgo },
    is_blocked: { $ne: true }
  }).lean();

  for (const user of vips) {
    if (isInCooldown(user)) continue;
    
    const msg = `\u{1F44B} *Halo ${user.first_name || 'VIP'}!*\n\nLama tak jumpa. Kami di sini sangat merindukan kehadiran Anda.\n\nJika Anda butuh sesuatu atau ada kendala, jangan ragu untuk membalas pesan ini langsung.\n\nSemoga hari Anda menyenangkan!`;
    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) count++;
    await delay(1500);
  }
  return count;
}

// ─── DASHBOARD METRICS ───────────────────────────────────────────────────────
async function getCampaignMetrics() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const dripStats = await DripLog.aggregate([
    { $match: { sent_at: { $gte: startOfDay } } },
    { $group: { 
      _id: "$stage", 
      total: { $sum: 1 }, 
      converted: { $sum: { $cond: ["$converted", 1, 0] } },
      revenue: { $sum: "$revenue_generated" }
    }}
  ]);

  const abStats = await ABTestResult.aggregate([
    { $match: { created_at: { $gte: startOfDay } } },
  ]);

  let msg = `\u{1F4CA} *Laporan Marketing Harian*\n\n`;
  msg += `*Performa Drip (Dikirim Hari Ini)*\n`;
  if (dripStats.length === 0) msg += `- Belum ada data\n`;
  dripStats.forEach(s => {
    msg += `Stage ${s._id}: ${s.total} terkirim, ${s.converted} konversi\n`;
  });
  
  msg += `\n*A/B Test Konversi Hari Ini*\n`;
  if (abStats.length === 0) msg += `- Belum ada data\n`;
  abStats.forEach(s => {
    msg += `Varian ${s._id}: ${s.conversions} konversi\n`;
  });

  return msg;
}

function startCron(bot) {
  // Bersihkan semua task lama (anti-duplikasi)
  cronTasks.forEach(t => t.destroy());
  cronTasks = [];

  // ── TASK 1: Marketing Campaign — Setiap jam tepat (restart-proof!) ──────────
  // Format: 0 * * * * = Detik 0, Menit 0, Setiap Jam, Setiap Hari
  const marketingTask = cron.schedule('0 * * * *', async () => {
    if (!marketingEnabled) return;
    const now = new Date();
    // Format: "2026-07-27" — daily key agar campaign berjalan tuntas dalam 1 hari
    const jakartaDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const todayHourStr = `${jakartaDate.getFullYear()}-${String(jakartaDate.getMonth()+1).padStart(2,'0')}-${String(jakartaDate.getDate()).padStart(2,'0')}`;
    console.log(`[CRON] ⏰ Menjalankan Marketing Automations (${now.toISOString()})...`);
    try {
      const stats = await runMarketingCampaign(bot, todayHourStr);
      if (stats.skipped) {
        console.log('[CRON] Marketing diskip:', stats.reason);
      } else {
        console.log('[CRON] ✅ Marketing selesai. Stats:', JSON.stringify(stats));
      }
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan marketing:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 2: Database Backup — Setiap hari jam 02:00 WIB ────────────────────
  const backupTask = cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] ⏰ Menjalankan Database Backup...');
    try {
      const { runDatabaseBackup } = require('./backup');
      await runDatabaseBackup(bot);
      console.log('[CRON] ✅ Backup selesai.');
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan backup:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 3: Cleanup DripLogs Expired — Setiap hari jam 03:00 WIB ───────────
  const cleanupTask = cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] ⏰ Menjalankan cleanup DripLogs...');
    await cleanupConvertedDripLogs();
    console.log('[CRON] ✅ Cleanup selesai.');
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 4: Laporan Harian — Setiap hari jam 23:00 WIB ─────────────────────
  const metricsTask = cron.schedule('0 23 * * *', async () => {
    console.log('[CRON] ⏰ Mengirim Laporan Harian...');
    try {
      const adminId = process.env.ADMIN_ID || process.env.ADMIN_CHAT_ID;
      if (adminId) {
        const metricsMsg = await getCampaignMetrics();
        await bot.telegram.sendMessage(adminId, metricsMsg, { parse_mode: 'Markdown' });
        console.log('[CRON] ✅ Laporan harian terkirim.');
      }
    } catch (err) {
      console.error('[CRON] ❌ Gagal kirim metrics harian:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 5: Reminder Diskon Mau Hangus — Setiap hari jam 20:00 WIB ─────────
  const discountReminderTask = cron.schedule('0 20 * * *', async () => {
    console.log('[CRON] ⏰ Mengirim reminder diskon mau hangus...');
    try {
      const sixHoursLater = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const expiringDiscounts = await Discount.find({
        valid_until: { $gt: new Date(), $lte: sixHoursLater },
        used_count: 0
      }).lean();
      
      const hType = await getSetting('header_type', 'url');
      const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');
      
      for (const disc of expiringDiscounts) {
        const user = await User.findById(disc.target_user_id).lean();
        if (!user || user.is_blocked) continue;
        
        const product = await Product.findOne({ active: 1 }).sort({ price: -1 }).lean();
        const discountAmount = product ? Math.floor(product.price * disc.value / 100) : 0;
        const keyboard = product ? buildProductMarkup(product, discountAmount) : null;
        
        const reminderMsg = `⏰ *DISKON ${disc.value}% HANGUS DALAM 6 JAM!*\n\n` +
          `Bos, kupon diskon spesial Anda akan kedaluwarsa malam ini.\n\n` +
          `➟ Klik tombol di bawah sebelum hangus!`;
        
        await sendSafe(bot, disc.target_user_id, reminderMsg, { media: hFile, mediaType: hType, keyboard });
        await delay(1500);
      }
      console.log('[CRON] ✅ Reminder diskon terkirim ke', expiringDiscounts.length, 'user.');
    } catch (err) {
      console.error('[CRON] ❌ Gagal kirim reminder diskon:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 6: Auto-Close Order Macet — Setiap hari jam 04:00 WIB ──────────────
  const stuckOrderTask = cron.schedule('0 4 * * *', async () => {
    console.log('[CRON] ⏰ Membersihkan order macet...');
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await Order.updateMany(
        { status: 'PENDING', created_at: { $lte: sevenDaysAgo } },
        { $set: { status: 'EXPIRED' } }
      );
      console.log('[CRON] ✅ Auto-close order macet:', result.modifiedCount, 'order ditutup.');
    } catch (err) {
      console.error('[CRON] ❌ Gagal close order macet:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  cronTasks = [marketingTask, backupTask, cleanupTask, metricsTask, discountReminderTask, stuckOrderTask];
  
  // Langsung jalankan marketing sekali saat bot nyala (startup run)
  // Gunakan daily key agar tidak bikin CronProgress duplikat
  const jakartaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const startupStr = `${jakartaNow.getFullYear()}-${String(jakartaNow.getMonth()+1).padStart(2,'0')}-${String(jakartaNow.getDate()).padStart(2,'0')}`;
  console.log('[CRON] 🚀 Marketing Scheduler (node-cron) started. Dijadwalkan setiap jam, restart-proof!');
  console.log('[CRON] Menjalankan startup run untuk tanggal:', startupStr);
  runMarketingCampaign(bot, startupStr)
    .then(stats => console.log('[CRON] ✅ Startup run selesai. Stats:', JSON.stringify(stats)))
    .catch(err => console.error('[CRON] ❌ Startup run gagal:', err.message));
}


function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }
function stopDailyCron() {
  cronTasks.forEach(t => t.destroy());
  cronTasks = [];
  console.log('[CRON] All scheduled tasks stopped.');
}

module.exports = {
  startCron,
  runMarketingCampaign,
  sendTestMarketing,
  markDripConverted,
  setMarketingEnabled,
  isMarketingEnabled,
  stopDailyCron
};
