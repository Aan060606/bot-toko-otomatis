/**
 * scheduler.js — Behavioral Marketing Automation
 *
 * CAMPAIGN 1 — Non-Buyer (Belum beli sama sekali):
 *   CART_ABANDON : Klik beli tapi tidak jadi bayar dalam 72 jam
 *   INACTIVE     : Tidak aktif > 7 hari
 *   COLD_LEAD    : Buka bot, belum pernah klik beli
 *
 * CAMPAIGN 2 — Cross-Sell (Sudah beli sebagian, belum lengkap):
 *   Cek produk apa yang sudah dibeli user
 *   Tawarkan produk pertama yang belum dibeli (urutan database)
 *
 * Anti-Spam : User hanya dapat 1 pesan otomatis per 3 hari
 * Template  : Bisa diubah Admin via /set_msg tanpa coding ulang
 */

const { User, UserEvent, Order, OrderItem, Product, BroadcastLog, Setting } = require('./database');

let marketingEnabled = true;
let cronTimer = null;

// Ambil template pesan dari DB, fallback ke default
async function getMsg(key, defaultMsg) {
  const row = await Setting.findById('marketing_' + key).lean();
  return row ? row.value : defaultMsg;
}

// Kirim pesan ke 1 user, tandai is_blocked jika gagal
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

// Cek apakah user masih dalam cooldown anti-spam 3 hari
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
    'Sepertinya kamu tadi tertarik dengan produk kami tapi belum menyelesaikan pembayaran.\n\n' +
    'Ada kendala? Jangan ragu hubungi Admin ya!\n\n' +
    'Klik /start untuk lanjutkan. Jangan sampai ketinggalan! \u26A1'
  );
  const msgInactive = await getMsg('inactive',
    '\u{1F440} *Sudah lama tidak melihat kamu!*\n\n' +
    'Kamu tahu tidak, kami punya banyak genre *VIP Permanen* yang bisa kamu pilih sesuai selera?\n\n' +
    'Sekali beli \u2014 nikmati selamanya. Tanpa biaya langganan! \u{1F389}\n\n' +
    'Klik /start sekarang dan pilih genre favoritmu! \u{1F680}'
  );

  const nonBuyers = await User.find({ purchase_count: 0, is_blocked: false }).lean();
  const stats = { cold: 0, abandon: 0, inactive: 0, skipped: 0, failed: 0 };

  for (const user of nonBuyers) {
    if (isInCooldown(user)) { stats.skipped++; continue; }

    const segment = await classifyNonBuyer(user);
    let msg;
    if (segment === 'CART_ABANDON') msg = msgCartAbandon;
    else if (segment === 'INACTIVE') msg = msgInactive;
    else msg = msgColdLead;

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

// ─── CAMPAIGN 2: CROSS-SELL ─────────────────────────────────────────────────

// Ambil daftar product_id yang sudah berhasil dibeli user
async function getBoughtProductIds(userId) {
  const successOrders = await Order.find({ user_id: userId, status: 'SUCCESS' }).lean();
  if (!successOrders.length) return [];
  const orderIds = successOrders.map(o => o._id);
  const items = await OrderItem.find({ order_id: { $in: orderIds } }).lean();
  return [...new Set(items.map(i => String(i.product_id)))];
}

async function runCrossSellCampaign(bot, allProducts) {
  // Minimal harus ada 2 produk agar cross-sell masuk akal
  if (allProducts.length < 2) return { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  const msgTemplate = await getMsg('cross_sell',
    '\u{1F389} *Hei {nama}!*\n\n' +
    'Kamu sudah punya akses *{produk_lama}* \u2014 pilihan yang tepat! \u{1F44D}\n\n' +
    'Tapi tahukah kamu kami juga punya *{produk_baru}*?\n\n' +
    'Sama-sama *VIP Permanen* \u2014 sekali beli, nikmati selamanya!\n\n' +
    'Klik /start untuk lihat dan langsung order! \u{1F525}'
  );

  // Target: sudah beli setidaknya 1 produk, belum diblokir
  const partialBuyers = await User.find({ purchase_count: { $gt: 0 }, is_blocked: false }).lean();
  const totalCount = allProducts.length;
  const stats = { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  for (const user of partialBuyers) {
    if (isInCooldown(user)) { stats.skipped++; continue; }

    const boughtIds = await getBoughtProductIds(user._id);

    // Skip jika sudah beli semua produk (user lengkap)
    if (boughtIds.length >= totalCount) { stats.complete++; continue; }

    // Cari produk pertama yang belum dibeli (Opsi B: urutan database)
    const targetProduct = allProducts.find(p => !boughtIds.includes(String(p._id)));
    if (!targetProduct) { stats.skipped++; continue; }

    // Buat nama produk yang sudah dimiliki untuk pesan personal
    const boughtProducts = allProducts.filter(p => boughtIds.includes(String(p._id)));
    const boughtNames = boughtProducts.map(p => p.name).join(' & ') || 'VIP';
    const nama = user.first_name || 'Kamu';

    const msg = msgTemplate
      .replace('{nama}', nama)
      .replace('{produk_lama}', boughtNames)
      .replace('{produk_baru}', targetProduct.name);

    const result = await sendSafe(bot, user._id, msg);
    if (result.ok) {
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });
      stats.crossSell++;
    } else {
      stats.failed++;
    }
    await delay(1500);
  }

  return stats;
}

// ─── CAMPAIGN UTAMA: JALANKAN NON-BUYER + CROSS-SELL ───────────────────────

async function runMarketingCampaign(bot) {
  if (!marketingEnabled) {
    return { skipped: true, reason: 'Marketing dimatikan Admin' };
  }

  console.log('[MARKETING] Campaign 1: Non-Buyer dimulai...');
  const nonBuyerStats = await runNonBuyerCampaign(bot);

  // Ambil semua produk aktif sekali saja untuk efisiensi
  const allProducts = await Product.find({ active: 1 }).lean();

  console.log('[MARKETING] Campaign 2: Cross-Sell dimulai...');
  const crossSellStats = await runCrossSellCampaign(bot, allProducts);

  const combined = {
    cold: nonBuyerStats.cold,
    abandon: nonBuyerStats.abandon,
    inactive: nonBuyerStats.inactive,
    crossSell: crossSellStats.crossSell,
    complete: crossSellStats.complete,
    skipped: (nonBuyerStats.skipped || 0) + (crossSellStats.skipped || 0),
    failed: (nonBuyerStats.failed || 0) + (crossSellStats.failed || 0)
  };

  const totalSent = combined.cold + combined.abandon + combined.inactive + combined.crossSell;

  await BroadcastLog.create({
    admin_id: 0,
    target_segment: 'AUTO_MARKETING_FULL',
    message_text: 'NonBuyer[Cold:' + combined.cold + '|Abandon:' + combined.abandon + '|Inactive:' + combined.inactive + '] CrossSell:' + combined.crossSell + ' Complete:' + combined.complete + ' Skip:' + combined.skipped + ' Fail:' + combined.failed,
    status: 'COMPLETED',
    success_count: totalSent,
    failed_count: combined.failed
  });

  return combined;
}

// ─── CRON JOB HARIAN (jam 10.00 WIB) ───────────────────────────────────────

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

  console.log('[MARKETING] Cron aktif — campaign berjalan setiap hari jam 10.00 WIB');
}

function stopDailyCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }

module.exports = { runMarketingCampaign, startDailyCron, stopDailyCron, setMarketingEnabled, isMarketingEnabled };
