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

let marketingEnabled = true;
let cronTimer = null;

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function getMsg(key, defaultMsg) {
  const row = await Setting.findById('marketing_' + key).lean();
  return row ? row.value : defaultMsg;
}

async function sendSafe(bot, userId, text) {
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
    return { ok: true };
  } catch (err) {
    const isBlocked = err.description && (
      err.description.includes('bot was blocked') ||
      err.description.includes('user is deactivated') ||
      err.description.includes('chat not found')
    );
    if (isBlocked) await User.findByIdAndUpdate(userId, { is_blocked: true });
    return { ok: false, blocked: isBlocked };
  }
}

function isInCooldown(user) {
  if (!user.last_broadcast_at) return false;
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  return user.last_broadcast_at > threeDaysAgo;
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ─── CAMPAIGN 1: NON-BUYER ──────────────────────────────────────────────────

async function classifyNonBuyer(user) {
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const recentCheckout = await UserEvent.findOne({
    user_id: user._id,
    event_type: 'CHECKOUT',
    created_at: { $gte: seventyTwoHoursAgo }
  }).lean();

  if (recentCheckout) return 'CART_ABANDON';
  if (user.last_active_at && user.last_active_at < sevenDaysAgo) return 'INACTIVE';
  return 'COLD_LEAD';
}

async function runNonBuyerCampaign(bot) {
  const msgColdLead = await getMsg('cold_lead',
    '*Hei!* \u{1F44B}\n\nKamu sudah pernah mampir ke toko kami tapi belum bergabung jadi *Member VIP*.\n\n' +
    'Kami punya berbagai pilihan *Akses VIP Permanen* \u2014 sekali bayar, nikmati selamanya! \u2705\n\n' +
    'Klik /start untuk lihat semua pilihan genre! \u{1F525}'
  );
  const msgCartAbandon = await getMsg('cart_abandon',
    '\u{1F6D2} *Hei! Kamu hampir jadi Member VIP!*\n\n' +
    'Sepertinya kamu tadi tertarik tapi belum menyelesaikan pembayaran.\n\n' +
    'Ada kendala? Hubungi Admin jika butuh bantuan!\n\n' +
    'Klik /start untuk lanjutkan. Jangan sampai ketinggalan! \u26A1'
  );
  const msgInactive = await getMsg('inactive',
    '\u{1F440} *Sudah lama tidak melihat kamu!*\n\n' +
    'Kamu tahu tidak, kami punya banyak genre *VIP Permanen* sesuai selera?\n\n' +
    'Sekali beli \u2014 nikmati selamanya. Tanpa biaya langganan! \u{1F389}\n\n' +
    'Klik /start sekarang! \u{1F680}'
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

  for (const user of nonBuyers) {
    if (isInCooldown(user)) { stats.skipped++; continue; }

    const segment = await classifyNonBuyer(user);
    const msg = segment === 'CART_ABANDON' ? msgCartAbandon
               : segment === 'INACTIVE'     ? msgInactive
               : msgColdLead;

    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) {
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });
      if (segment === 'CART_ABANDON') stats.abandon++;
      else if (segment === 'INACTIVE') stats.inactive++;
      else stats.cold++;
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
    // Cari user lain yang juga punya irisan produk yang sama
    const orderItems = await OrderItem.find({ product_id: { $in: boughtIds } }).lean();
    const orderIds = orderItems.map(i => i.order_id);
    const similarOrders = await Order.find({
      _id: { $in: orderIds },
      user_id: { $ne: userId },
      status: 'SUCCESS'
    }).lean();
    const similarUserIds = [...new Set(similarOrders.map(o => o.user_id))];

    if (similarUserIds.length > 0) {
      // Hitung produk yang paling sering dibeli similar users (yang belum dimiliki target)
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
    '\u{1F389} *Hei {nama}!*\n\n' +
    'Kamu sudah punya akses *{produk_lama}* \u2014 pilihan yang tepat! \u{1F44D}\n\n' +
    'Tapi tahukah kamu kami juga punya *{produk_baru}*?\n\n' +
    'Sama-sama *VIP Permanen* \u2014 sekali beli, nikmati selamanya!\n\n' +
    'Klik /start untuk lihat dan langsung order! \u{1F525}'
  );

  const partialBuyers = await User.find({ purchase_count: { $gt: 0 }, is_blocked: { $ne: true } }).lean();
  const totalCount = allProducts.length;
  const stats = { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

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

    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) {
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });

      // Simpan ke DripLog untuk follow-up bertingkat
      await DripLog.create({
        user_id: user._id,
        product_id: String(targetProduct._id),
        stage: 1,
        sent_at: new Date()
      });

      stats.crossSell++;
    } else {
      stats.failed++;
    }
    await delay(1500);
  }
  return stats;
}

// ─── CAMPAIGN 3: DRIP FOLLOW-UP (3 TAHAP) ──────────────────────────────────

async function runDripFollowUp(bot) {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const stats = { stage2: 0, stage3: 0, skipped: 0, failed: 0 };

  // === Stage 2: Kirim urgensi ke yang sudah 3 hari di stage 1 dan belum beli ===
  const stage1Logs = await DripLog.find({
    stage: 1,
    sent_at: { $lte: threeDaysAgo },
    converted: false
  }).lean();

  for (const log of stage1Logs) {
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked || user.purchase_count > 0) {
      // User sudah beli atau diblokir — tandai converted, skip
      await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
      continue;
    }

    const product = await require('./database').Product.findById(log.product_id).lean();
    const productName = product ? product.name : 'produk pilihan kami';

    const msg =
      `\u23F0 *Hei ${user.first_name || 'Kamu'}!*\n\n` +
      `Masih ingat *${productName}* yang kami tawarkan beberapa hari lalu?\n\n` +
      `Penawaran ini hampir selesai! Jangan sampai kamu menyesal karena kehabisan.\n\n` +
      `Klik /start sekarang sebelum terlambat! \u{1F525}`;

    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 2, sent_at: new Date() });
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });
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
    if (!user || user.is_blocked || user.purchase_count > 0) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
      continue;
    }

    const product = await require('./database').Product.findById(log.product_id).lean();
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
      `\u{1F514} *${user.first_name || 'Hei'}! Ini reminder terakhir dari kami.*\n\n` +
      `Kami tahu kamu tertarik dengan *${productName}*.\n\n` +
      `Sebagai apresiasi, kami kasih *diskon spesial Rp5.000* khusus untukmu, berlaku 24 jam!\n\n` +
      `Klik /start sekarang untuk klaim diskon otomatismu! \u{1F381}`;

    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 3, sent_at: new Date() });
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });
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

  console.log('[MARKETING] Campaign 1: Non-Buyer...');
  const nonBuyerStats = await runNonBuyerCampaign(bot);

  const allProducts = await Product.find({ active: 1 }).lean();

  console.log('[MARKETING] Campaign 2: Cross-Sell (Smart Recommendation)...');
  const crossSellStats = await runCrossSellCampaign(bot, allProducts);

  console.log('[MARKETING] Campaign 3: Drip Follow-Up (Stage 2 & 3)...');
  const dripStats = await runDripFollowUp(bot);

  const combined = {
    cold: nonBuyerStats.cold,
    abandon: nonBuyerStats.abandon,
    inactive: nonBuyerStats.inactive,
    crossSell: crossSellStats.crossSell,
    complete: crossSellStats.complete,
    dripStage2: dripStats.stage2,
    dripStage3: dripStats.stage3,
    skipped: (nonBuyerStats.skipped || 0) + (crossSellStats.skipped || 0) + (dripStats.skipped || 0),
    failed: (nonBuyerStats.failed || 0) + (crossSellStats.failed || 0) + (dripStats.failed || 0)
  };

  const totalSent = combined.cold + combined.abandon + combined.inactive
                  + combined.crossSell + combined.dripStage2 + combined.dripStage3;

  await BroadcastLog.create({
    admin_id: 0,
    target_segment: 'AUTO_MARKETING_FULL',
    message_text:
      'NonBuyer[C:' + combined.cold + '|A:' + combined.abandon + '|I:' + combined.inactive + '] ' +
      'CrossSell:' + combined.crossSell + ' Complete:' + combined.complete + ' ' +
      'Drip[S2:' + combined.dripStage2 + '|S3:' + combined.dripStage3 + '] ' +
      'Skip:' + combined.skipped + ' Fail:' + combined.failed,
    status: 'COMPLETED',
    success_count: totalSent,
    failed_count: combined.failed
  });

  return combined;
}

// ─── CRON JOB HARIAN (jam 10.00 WIB) ────────────────────────────────────────

function startDailyCron(bot) {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(async () => {
    const jakartaHour = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })
    ).getHours();

    if (jakartaHour === 10) {
      console.log('[MARKETING] Cron job harian berjalan...');
      try {
        const stats = await runMarketingCampaign(bot);
        console.log('[MARKETING] Selesai:', JSON.stringify(stats));
      } catch (err) {
        console.error('[MARKETING] Error cron:', err.message);
      }
    }
  }, 60 * 60 * 1000);

  console.log('[MARKETING] Cron aktif — jam 10.00 WIB setiap hari');
}

function stopDailyCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }

module.exports = {
  runMarketingCampaign,
  markDripConverted,
  startDailyCron,
  stopDailyCron,
  setMarketingEnabled,
  isMarketingEnabled
};
