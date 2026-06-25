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

const { User, UserEvent, Order, OrderItem, Product, DripLog, BroadcastLog, Setting, Discount } = require('./database');
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

function strikeThrough(text) {
  return text.split('').map(char => char + '\u0336').join('');
}

function buildProductMarkup(product, discountAmount = 0) {
  const buttons = [];
  if (product.preview_url) {
    buttons.push([Markup.button.url(`📺 Preview Content ${product.name}`, product.preview_url)]);
  }
  
  if (discountAmount > 0 && product.price > discountAmount) {
    const finalPrice = product.price - discountAmount;
    const oldPriceStr = strikeThrough(formatRupiah(product.price));
    buttons.push([Markup.button.callback(`🎁 Beli ${product.name} ${oldPriceStr} ➡️ ${formatRupiah(finalPrice)}`, `buy_now_${product._id}`)]);
  } else {
    buttons.push([Markup.button.callback(`🛒 Beli ${product.name} - ${formatRupiah(product.price)}`, `buy_now_${product._id}`)]);
  }
  return Markup.inlineKeyboard(buttons);
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
  if (!user.last_broadcast_at) return false;
  const daysSinceLast = (new Date() - new Date(user.last_broadcast_at)) / (1000 * 60 * 60 * 24);
  return daysSinceLast < 3;
}

// ─── CAMPAIGN 1: NON-BUYER ──────────────────────────────────────────────────

// Klasifikasikan kenapa user belum beli
async function classifyNonBuyer(user) {
  const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
  
  if (lastEvent && lastEvent.event_type === 'CLICK_BUY') {
    // Pernah klik beli, tapi tidak ada transaksi sukses -> Cart Abandon
    return 'CART_ABANDON';
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
    '\u26A0\uFE0F \u{1D41F}\u{1D404}\u{1D40D}\u{1D403}\u{1D408}\u{1D40D}\u{1D406} \u{1D413}\u{1D411}\u{1D400}\u{1D40D}\u{1D412}\u{1D400}\u{1D402}\u{1D413}\u{1D408}\u{1D40E}\u{1D40D}\n\n' +
    'Akses eksklusif Anda hampir siap. Jangan biarkan koleksi ratusan mahakarya ini tertunda.\n\n' +
    'Lanjutkan pembayaran Anda dengan aman melalui tombol di bawah \u{1F447}'
  );

  const msgInactive = await getMsg('inactive',
    '\u2728 \u{1D40D}\u{1D404}\u{1D416} \u{1D402}\u{1D40E}\u{1D40B}\u{1D40B}\u{1D404}\u{1D402}\u{1D413}\u{1D408}\u{1D40E}\u{1D40D} \u{1D400}\u{1D40B}\u{1D404}\u{1D411}\u{1D413}\n\n' +
    'Katalog eksklusif kami baru saja diperbarui dengan ratusan mahakarya terbaru minggu ini.\n\n' +
    'Kembali dan temukan koleksi terhangat sekarang \u{1F447}'
  );

  const msgColdLead = await getMsg('cold_lead',
    '\u269C\uFE0F \u{1D409}-\u{1D412}\u{1D414}\u{1D401} \u{1D40F}\u{1D411}\u{1D404}\u{1D40C}\u{1D408}\u{1D414}\u{1D40C} \u{1D400}\u{1D402}\u{1D402}\u{1D404}\u{1D412}\u{1D412} \u269C\uFE0F\n\n' +
    'Tingkatkan pengalaman Anda dengan koleksi terlengkap dan terkurasi. Ribuan pengguna telah bergabung dalam lingkaran eksklusif kami.\n\n' +
    '\u2726 Akses Instan & Permanen\n' +
    '\u2726 Update Otomatis Setiap Hari\n' +
    '\u2726 Tanpa Biaya Berlangganan\n\n' +
    'Amankan akses VIP Anda sekarang \u{1F447}'
  );

  const nonBuyers = await User.find({ 
    $or: [
      { purchase_count: 0 },
      { purchase_count: null },
      { purchase_count: { $exists: false } }
    ],
    is_blocked: { $ne: true }
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
    const msg = segment === 'CART_ABANDON' ? msgCartAbandon
               : segment === 'INACTIVE'     ? msgInactive
               : msgColdLead;

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
            sent_at: new Date()
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
    '\u{1F451} \u{1D404}\u{1D417}\u{1D402}\u{1D40B}\u{1D414}\u{1D412}\u{1D408}\u{1D415}\u{1D404} \u{1D414}\u{1D40F}\u{1D406}\u{1D411}\u{1D400}\u{1D403}\u{1D404}\n\n' +
    'Halo {nama},\nSebagai pemegang akses *{produk_lama}*, Anda kini berhak membuka gerbang menuju koleksi tingkat lanjut: *{produk_baru}*.\n\n' +
    '\u2726 Akses Penuh tanpa Batas\n' +
    '\u2726 Tersinkronisasi Otomatis\n\n' +
    'Tingkatkan level Anda sekarang \u{1F447}'
  );

  const partialBuyers = await User.find({ purchase_count: { $gt: 0 }, is_blocked: { $ne: true } }).lean();
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
          sent_at: new Date()
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
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
      continue;
    }

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

    const msg =
      `\u23F3 \u{1D40B}\u{1D408}\u{1D40C}\u{1D408}\u{1D413}\u{1D404}\u{1D403} \u{1D413}\u{1D408}\u{1D40C}\u{1D404} \u{1D40E}\u{1D405}\u{1D405}\u{1D404}\u{1D411}\n\n` +
      `Halo ${user.first_name || 'VIP'},\nKesempatan untuk mengakses *${productName}* hampir berakhir. ` +
      `Jangan lewatkan mahakarya eksklusif ini sebelum penawaran ditutup.\n\n` +
      `Amankan slot Anda segera \u{1F447}`;

    let keyboard = null;
    if (product) keyboard = buildProductMarkup(product);

    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 2, sent_at: new Date() });
      stats.stage2++;
    } else {
      stats.failed++;
    }
    await delay(1500);
  }

  // === Stage 3: Final reminder + diskon khusus ke yang sudah 3 hari di stage 2 ===
  const stage2Logs = await DripLog.find({
    stage: 2,
    sent_at: { $lte: threeDaysAgo },
    converted: false
  }).lean();

  for (const log of stage2Logs) {
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
      continue;
    }

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
    const productName = product ? product.name : 'produk pilihan kami';

    // Buat diskon khusus untuk user ini saja, berlaku 24 jam
    const dripCode = 'DRIP_' + log.user_id + '_' + Date.now();
    await Discount.create({
      code: dripCode,
      type: 'FIXED',
      value: 5000,
      trigger_event: 'ALL',
      target_user_id: user._id,
      target_product_id: String(log.product_id),
      valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000),
      max_uses: 1,
      active: true
    });

    const msg =
      `\u{1F48E} \u{1D405}\u{1D408}\u{1D40D}\u{1D400}\u{1D40B} \u{1D402}\u{1D400}\u{1D40B}\u{1D40B} & \u{1D411}\u{1D404}\u{1D416}\u{1D400}\u{1D411}\u{1D403}\n\n` +
      `Halo ${user.first_name || 'VIP'}, ini adalah panggilan terakhir.\n` +
      `Sebagai bentuk apresiasi dari kami, nikmati *Potongan Eksklusif Rp5.000* untuk mengklaim *${productName}*.\n\n` +
      `\u27DF Potongan otomatis aktif saat checkout\n` +
      `\u27DF Hanya berlaku dalam 24 Jam\n\n` +
      `Klaim keistimewaan Anda sekarang \u{1F447}`;

    let keyboard = null;
    if (product) keyboard = buildProductMarkup(product, 5000);

    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard });
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 3, sent_at: new Date() });
      stats.stage3++;
    } else {
      stats.failed++;
    }
    await delay(1500);
  }

  return stats;
}

// Fungsi publik: tandai DripLog sebagai converted saat user beli
// Dipanggil dari store.js saat fulfillOrder
async function markDripConverted(userId) {
  try {
    await DripLog.updateMany(
      { user_id: userId, converted: false },
      { $set: { converted: true } }
    );
  } catch (e) { /* silent */ }
}

// ─── CAMPAIGN UTAMA ──────────────────────────────────────────────────────────

async function runMarketingCampaign(bot) {
  if (!marketingEnabled) {
    return { skipped: true, reason: 'Marketing dimatikan Admin' };
  }

  console.log('[MARKETING] Campaign 3: Drip Follow-Up (Stage 2 & 3)...');
  const dripStats = await runDripFollowUp(bot);

  console.log('[MARKETING] Campaign 1: Non-Buyer...');
  const nonBuyerStats = await runNonBuyerCampaign(bot);

  const allProducts = await Product.find({ active: 1 }).lean();

  console.log('[MARKETING] Campaign 2: Cross-Sell (Smart Recommendation)...');
  const crossSellStats = await runCrossSellCampaign(bot, allProducts);

  const combined = {
    cold: nonBuyerStats.cold,
    abandon: nonBuyerStats.abandon,
    inactive: nonBuyerStats.inactive,
    crossSell: crossSellStats.crossSell,
    complete: crossSellStats.complete,
    stage2: dripStats.stage2,
    stage3: dripStats.stage3,
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
    msg = await getMsg('cold_lead', '\u269C\uFE0F \u{1D409}-\u{1D412}\u{1D414}\u{1D401} \u{1D40F}\u{1D411}\u{1D404}\u{1D40C}\u{1D408}\u{1D414}\u{1D40C} \u{1D400}\u{1D402}\u{1D402}\u{1D404}\u{1D412}\u{1D412} \u269C\uFE0F\n\nTingkatkan pengalaman Anda dengan koleksi terlengkap dan terkurasi. Ribuan pengguna telah bergabung dalam lingkaran eksklusif kami.\n\n\u2726 Akses Instan & Permanen\n\u2726 Update Otomatis Setiap Hari\n\u2726 Tanpa Biaya Berlangganan\n\nAmankan akses VIP Anda sekarang \u{1F447}');
  } else if (type === 'cart_abandon') {
    msg = await getMsg('cart_abandon', '\u26A0\uFE0F \u{1D41F}\u{1D404}\u{1D40D}\u{1D403}\u{1D408}\u{1D40D}\u{1D406} \u{1D413}\u{1D411}\u{1D400}\u{1D40D}\u{1D412}\u{1D400}\u{1D402}\u{1D413}\u{1D408}\u{1D40E}\u{1D40D}\n\nAkses eksklusif Anda hampir siap. Jangan biarkan koleksi ratusan mahakarya ini tertunda.\n\nLanjutkan pembayaran Anda dengan aman melalui tombol di bawah \u{1F447}');
  } else if (type === 'inactive') {
    msg = await getMsg('inactive', '\u2728 \u{1D40D}\u{1D404}\u{1D416} \u{1D402}\u{1D40E}\u{1D40B}\u{1D40B}\u{1D404}\u{1D402}\u{1D413}\u{1D408}\u{1D40E}\u{1D40D} \u{1D400}\u{1D40B}\u{1D404}\u{1D411}\u{1D413}\n\nKatalog eksklusif kami baru saja diperbarui dengan ratusan mahakarya terbaru minggu ini.\n\nKembali dan temukan koleksi terhangat sekarang \u{1F447}');
  } else if (type === 'cross_sell') {
    const msgTemplate = await getMsg('cross_sell', '\u{1F451} \u{1D404}\u{1D417}\u{1D402}\u{1D40B}\u{1D414}\u{1D412}\u{1D408}\u{1D415}\u{1D404} \u{1D414}\u{1D40F}\u{1D406}\u{1D411}\u{1D400}\u{1D403}\u{1D404}\n\nHalo {nama},\nSebagai pemegang akses *{produk_lama}*, Anda kini berhak membuka gerbang menuju koleksi tingkat lanjut: *{produk_baru}*.\n\n\u2726 Akses Penuh tanpa Batas\n\u2726 Tersinkronisasi Otomatis\n\nTingkatkan level Anda sekarang \u{1F447}');
    msg = msgTemplate.replace('{nama}', 'VIP').replace('{produk_lama}', 'VIP Basic').replace('{produk_baru}', defaultProduct.name);
  } else if (type === 'stage2') {
    msg = `\u23F3 \u{1D40B}\u{1D408}\u{1D40C}\u{1D408}\u{1D413}\u{1D404}\u{1D403} \u{1D413}\u{1D408}\u{1D40C}\u{1D404} \u{1D40E}\u{1D405}\u{1D405}\u{1D404}\u{1D411}\n\nHalo VIP,\nKesempatan untuk mengakses *${defaultProduct.name}* hampir berakhir. Jangan lewatkan mahakarya eksklusif ini sebelum penawaran ditutup.\n\nAmankan slot Anda segera \u{1F447}`;
  } else if (type === 'stage3') {
    msg = `\u{1F48E} \u{1D405}\u{1D408}\u{1D40D}\u{1D400}\u{1D40B} \u{1D402}\u{1D400}\u{1D40B}\u{1D40B} & \u{1D411}\u{1D404}\u{1D416}\u{1D400}\u{1D411}\u{1D403}\n\nHalo VIP, ini adalah panggilan terakhir.\nSebagai bentuk apresiasi dari kami, nikmati *Potongan Eksklusif Rp5.000* untuk mengklaim *${defaultProduct.name}*.\n\n\u27DF Potongan otomatis aktif saat checkout\n\u27DF Hanya berlaku dalam 24 Jam\n\nKlaim keistimewaan Anda sekarang \u{1F447}`;
    keyboard = buildProductMarkup(defaultProduct, 5000);
  } else {
    return { ok: false, error: 'Tipe tidak valid. Gunakan: cold_lead, cart_abandon, inactive, cross_sell, stage2, stage3' };
  }

  return await sendSafe(bot, userId, `[TEST MODE]\n\n${msg}`, { media: hFile, mediaType: hType, keyboard });
}

function startCron(bot) {
  if (cronTimer) clearInterval(cronTimer);

  cronTimer = setInterval(async () => {
    // Jalankan setiap jam 10 Pagi WIB (UTC+7)
    const now = new Date();
    const utcHours = now.getUTCHours();
    const jakartaHour = (utcHours + 7) % 24;
    
    const today = now.toDateString();

    if (jakartaHour === 10 && lastCronDate !== today) {
      lastCronDate = today;
      console.log(`[CRON] Menjalankan Marketing Automations (${now.toISOString()})...`);
      
      try {
        const stats = await runMarketingCampaign(bot);
        if (!stats.skipped) {
          console.log('[CRON] Marketing selesai. Stats:', stats);
        } else {
          console.log('[CRON] Marketing diskip:', stats.reason);
        }
      } catch (err) {
        console.error('[CRON] Gagal menjalankan marketing:', err);
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
