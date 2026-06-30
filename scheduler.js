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

const formatRupiah = (angka) => 'Rp' + angka.toLocaleString('id-ID');

let marketingEnabled = true;
let cronTimer = null;
let lastCronDate = null; // Guard untuk mencegah double-fire di jam 10

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
    buttons.push([Markup.button.callback(`🎁 Beli ${product.name} • ${strikeThrough(numPart)}${kPart}  ➔  Rp${formatK(finalPrice)}`, `buy_now_${product._id}`)]);
  } else {
    buttons.push([Markup.button.callback(`🛒 Beli ${product.name} • Rp${formatK(product.price)}`, `buy_now_${product._id}`)]);
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
    const extra = { parse_mode: 'Markdown' };
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

// Cek apakah user pernah dikirimi broadcast dalam 3 hari terakhir (Anti-Spam Shield)
function isInCooldown(user) {
  if (String(user._id) === String(process.env.ADMIN_CHAT_ID)) return false; // Admin kebal cooldown untuk testing
  if (!user.last_broadcast_at) return false;
  const daysSinceLast = (new Date() - new Date(user.last_broadcast_at)) / (1000 * 60 * 60 * 24);
  return daysSinceLast < 3;
}

// ─── CAMPAIGN 1: NON-BUYER ──────────────────────────────────────────────────

// Klasifikasikan kenapa user belum beli
async function classifyNonBuyer(user) {
  const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
  
  if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
    // Batasi Cart Abandonment hanya untuk event dalam 30 hari terakhir (Mitigasi Blast)
    const daysSinceCheckout = (new Date() - new Date(lastEvent.created_at)) / (1000 * 60 * 60 * 24);
    if (daysSinceCheckout <= 30) {
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
  const msgCartAbandon = await getMsg('cart_abandon',
    '\u26A0\uFE0F *Selesaikan Transaksi {produk}*\n\n' +
    '\u27DF Jangan lewatkan update terbaru\n\n' +
    '\u{1F447} Lanjut di bawah'
  );

  const msgInactive = await getMsg('inactive',
    '\u2728 *Koleksi {produk} Rilis!*\n\n' +
    '\u27DF Ratusan update panas minggu ini\n\n' +
    '\u{1F447} Cek sekarang'
  );

  const msgColdLead = await getMsg('cold_lead',
    '\u23F3 *Promo Perdana {produk}! (24 Jam)*\n\n' +
    '\u27DF Ribuan konten update tiap hari\n' +
    '\u27DF Sekali bayar, aktif selamanya\n\n' +
    '\u{1F447} Amankan sekarang'
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

    const segment = await classifyNonBuyer(user);
    let msg = segment === 'CART_ABANDON' ? msgCartAbandon
               : segment === 'INACTIVE'     ? msgInactive
               : msgColdLead;
               
    if (defaultProduct) {
      msg = msg.replace(/\{produk\}/g, defaultProduct.name);
    }

    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
    if (result.ok) {
      if (segment === 'CART_ABANDON') stats.abandon++;
      else if (segment === 'INACTIVE') stats.inactive++;
      else stats.cold++;

      if (defaultProduct) {
        const existingDrip = await DripLog.findOne({ user_id: user._id, product_id: String(defaultProduct._id), converted: false }).lean();
        if (!existingDrip) {
          await DripLog.create({
            user_id: user._id,
            product_id: String(defaultProduct._id),
            campaign_type: 'NON_BUYER',
            stage: 1,
            sent_at: new Date(),
            variant: Math.random() > 0.5 ? 'A' : 'B'
          });
        }
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

// ─── CAMPAIGN 3: DRIP FOLLOW-UP (Stage 2 & 3) ──────────────────────────────

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

  const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

  // === Stage 2: Kirim urgensi ke yang sudah 3 hari di stage 1 dan belum beli ===
  const stage1Logs = await DripLog.find({
    stage: 1,
    sent_at: { $lte: threeDaysAgo },
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

      const msg = log.variant === 'B'
        ? `\u26A0\uFE0F *Peringatan Terakhir, ${user.first_name || 'Bos'}!*\n\nPromo ${productName} akan ditutup.\n\n\u{1F447} Sikat sekarang`
        : `\u23F3 *Promo ${productName} Mau Habis!*\n\n\u27DF Slot sangat terbatas\n\n\u{1F447} Amankan segera`;

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

  // === Stage 3: Final reminder + diskon khusus ke yang sudah 3 hari di stage 2 ===
  const stage2Logs = await DripLog.find({
    stage: 2,
    sent_at: { $lte: threeDaysAgo },
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
      
      const msg = log.variant === 'B'
        ? `\u{1F6A8} *Waktu Terbatas!*\n\nDiskon ${discountRule.percentage}% untuk ${product ? product.name : 'produk ini'} khusus hari ini.\n\n\u{1F447} Jangan sampai kelewatan`
        : `\u{1F48E} *${discountRule.title}!*\n\n\u27DF Potongan otomatis (24 Jam)\n\n\u{1F447} Klaim diskon sekarang`;

      let keyboard = null;
      if (product) keyboard = buildProductMarkup(product, discountAmount);

      const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 3, sent_at: new Date() });
        
        // Simpan riwayat diskon yang diberikan
        await Discount.create({
          target_user_id: user._id,
          type: 'PERCENTAGE',
          value: discountRule.percentage,
          valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000)
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

  // === Stage 4: Down-sell (Produk Termurah) untuk user yang mengabaikan Stage 3 > 7 hari ===
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stage3Logs = await DripLog.find({
    stage: 3,
    sent_at: { $lte: sevenDaysAgo },
    converted: false
  }).lean();

  for (const log of stage3Logs) {
    try {
      const defaultProduct = await Product.findOne({ active: 1 }).sort({ price: 1 }).lean();
      if (defaultProduct && String(defaultProduct._id) !== String(log.product_id)) {
        const user = await User.findById(log.user_id).lean();
        if (!user || user.is_blocked) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
          continue;
        }

        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const forceSend = new Date(log.sent_at) <= fourteenDaysAgo;
        if (!forceSend && isInCooldown(user)) continue;

        // Kalau ternyata user udah punya produk termurah ini
        const boughtIds = await getBoughtProductIds(user._id);
        if (boughtIds.includes(String(defaultProduct._id))) {
          await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
          continue;
        }

        const msg = `\u{1F614} *Masih Ragu, ${user.first_name || 'Bos'}?*\n\n` +
                    `Mungkin penawaran sebelumnya belum cocok untukmu saat ini.\n\n` +
                    `Sebagai opsi paling hemat, cobalah *${defaultProduct.name}*!\n\n` +
                    `\u27DF Harga sangat terjangkau\n` +
                    `\u27DF Akses instan\n\n` +
                    `\u{1F447} Coba opsi hemat ini`;

        const keyboard = buildProductMarkup(defaultProduct);
        const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
        if (result.ok) {
          await DripLog.findByIdAndUpdate(log._id, { stage: 4, sent_at: new Date() });
          stats.stage4 = (stats.stage4 || 0) + 1;
        } else {
          stats.failed++;
        }
        await delay(1500);
      }
    } catch (err) {
      console.error(`[DRIP] Error di Stage 4 untuk log ${log._id} (User: ${log.user_id}):`, err);
      continue;
    }
  }

  return stats;
}

// Fungsi publik: tandai DripLog sebagai converted saat user beli
// Dipanggil dari store.js saat fulfillOrder
async function markDripConverted(userId) {
  try {
    const logs = await DripLog.find({ user_id: userId, converted: false }).lean();
    for (const log of logs) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true });
      if (log.variant) {
        await ABTestResult.create({
          variant: log.variant,
          stage: log.stage,
          converted: true,
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

  let dripStats = { stage2: 0, stage3: 0, skipped: 0, failed: 0 };
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
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'NON_BUYER_DONE' });
    progress.campaign = 'NON_BUYER_DONE';
  }

  if (progress.campaign === 'NON_BUYER_DONE') {
    console.log('[MARKETING] Campaign VIP Win-Back...');
    vipCount = await runVIPWinBackCampaign(bot);
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'VIP_DONE' });
    progress.campaign = 'VIP_DONE';
  }

  if (progress.campaign === 'VIP_DONE') {
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
    vipWinBack: vipCount,
    skipped: nonBuyerStats.skipped + crossSellStats.skipped + dripStats.skipped,
    failed: nonBuyerStats.failed + crossSellStats.failed + dripStats.failed
  };

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
    { $group: { _id: "$stage", total: { $sum: 1 }, converted: { $sum: { $cond: ["$converted", 1, 0] } } } }
  ]);

  const abStats = await ABTestResult.aggregate([
    { $match: { created_at: { $gte: startOfDay } } },
    { $group: { _id: "$variant", conversions: { $sum: 1 } } }
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
  if (cronTimer) clearInterval(cronTimer);

  cronTimer = setInterval(async () => {
    // Jalankan setiap jam 10 Pagi WIB (UTC+7)
    const now = new Date();
    const utcHours = now.getUTCHours();
    const jakartaHour = (utcHours + 7) % 24;
    
    const today = now.toDateString();

    if (jakartaHour >= 10 && lastCronDate !== today) {
      console.log(`[CRON] Menjalankan Marketing Automations (${now.toISOString()})...`);
      
      try {
        const stats = await runMarketingCampaign(bot, today);
        if (!stats.skipped) {
          console.log('[CRON] Marketing selesai. Stats:', stats);
        } else {
          console.log('[CRON] Marketing diskip:', stats.reason);
        }
        
        // Tandai selesai hanya JIKA sukses tanpa crash
        const progress = await CronProgress.findOne({ date: today });
        if (progress && progress.completed) {
          lastCronDate = today;
        }
      } catch (err) {
        console.error('[CRON] Gagal menjalankan marketing:', err);
      }
    }
    if (jakartaHour === 2 && lastCronDate !== today + '_backup') {
      lastCronDate = today + '_backup';
      try {
        const { runDatabaseBackup } = require('./backup');
        await runDatabaseBackup(bot);
      } catch (err) {
        console.error('[CRON] Gagal menjalankan backup:', err);
      }
    }

    if (jakartaHour === 3 && lastCronDate !== today + '_cleanup') {
      lastCronDate = today + '_cleanup';
      await cleanupConvertedDripLogs();
    }
    
    if (jakartaHour === 23 && lastCronDate !== today + '_metrics') {
      lastCronDate = today + '_metrics';
      try {
        const adminId = process.env.ADMIN_ID;
        if (adminId) {
          const metricsMsg = await getCampaignMetrics();
          await bot.telegram.sendMessage(adminId, metricsMsg, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        console.error('[CRON] Gagal kirim metrics harian:', err);
      }
    }
  }, 1000 * 60 * 60); // Cek setiap jam
  console.log('[CRON] Marketing Scheduler started. Berjalan tiap jam 10.00 WIB.');
}

function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }
function stopDailyCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
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
