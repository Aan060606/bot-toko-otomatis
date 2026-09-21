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

const { User, UserEvent, Order, OrderItem, Product, DripLog, BroadcastLog, Setting, Discount, ABTestResult, CronProgress, Stock } = require('./database');
const { Markup } = require('telegraf');
const logger     = require('./logger');
const store      = require('./store'); // Required to check global discounts

const cron = require('node-cron');
let previewModule = null;
try { previewModule = require('./preview'); } catch(e) { /* preview module optional */ }

const formatRupiah = (angka) => 'Rp' + angka.toLocaleString('id-ID');

let marketingEnabled = true;
let cronTasks = []; // Array of node-cron tasks (restart-proof)
let lastCronDate = null; // Still used for manual/startup run guard

// ─── SESSION TRACKER (In-Memory) ─────────────────────────────────────────────
// Melacak user yang sedang aktif online untuk multi-touchpoint follow-up.
// Tidak perlu DB — data ini ephemeral (hilang saat restart, tidak masalah).
//
// Struktur per user:
//   lastActivity : timestamp terakhir user kirim pesan/klik
//   timers       : array setTimeout yang dijadwalkan (bisa di-cancel)
//   touchpoints  : berapa follow-up sudah dikirim dalam sesi ini
//   sessionStart : kapan sesi dimulai
//
const activeSessions = new Map(); // userId → { lastActivity, timers[], touchpoints, sessionStart }

const SESSION_IDLE_MS    = 10 * 60 * 1000; // 10 menit diam → session dianggap berakhir
const MAX_TOUCHPOINTS    = 3;               // Maks 3 follow-up per sesi (tidak termasuk touchpoint pertama)

function getSession(userId) {
  return activeSessions.get(String(userId));
}

function updateSessionActivity(userId) {
  const id = String(userId);
  const existing = activeSessions.get(id);
  if (existing) {
    existing.lastActivity = Date.now();
  } else {
    activeSessions.set(id, {
      lastActivity  : Date.now(),
      sessionStart  : Date.now(),
      timers        : [],
      touchpoints   : 0
    });
  }
}

function isSessionStillActive(userId) {
  const session = getSession(userId);
  if (!session) return false;
  return (Date.now() - session.lastActivity) < SESSION_IDLE_MS;
}

function clearSessionTimers(userId) {
  const session = getSession(userId);
  if (session) {
    session.timers.forEach(t => clearTimeout(t));
    session.timers = [];
  }
}

function endSession(userId) {
  clearSessionTimers(userId);
  activeSessions.delete(String(userId));
}

// Bersihkan sesi lama tiap 30 menit (memory hygiene)
setInterval(() => {
  const now = Date.now();
  for (const [uid, session] of activeSessions.entries()) {
    if (now - session.lastActivity > SESSION_IDLE_MS * 3) {
      endSession(uid);
    }
  }
}, 30 * 60 * 1000);

// ─── HELPERS ────────────────────────────────────────────────────────────────

// [FIX] Mencegah spam jam 2 pagi tanpa mematikan fitur cron per jam.
function isUserQuietHour(user) {
  const currentHour = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Jakarta'})).getHours();
  // Pukul Rata: Jam 00:00 sampai 06:00 dilarang kirim promo (Kecuali Cart Abandon).
  // Mencegah block rate tinggi akibat False Positive kalong.
  if (currentHour >= 0 && currentHour <= 6) {
    return true; 
  }
  return false;
}

// [FIX BUG #2] Global rate limit: max 3 marketing messages per user per day
// Checks and increments the daily marketing message counter
// Returns true if allowed to send (< 3 messages today), false if rate limit exceeded
async function checkAndIncrementRateLimit(userId) {
  const user = await User.findById(userId);
  if (!user) return false;
  
  // Admin bypass
  if (String(user._id) === String(process.env.ADMIN_CHAT_ID)) return true;
  
  const now = new Date();
  const jakartaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  
  // Reset counter if past midnight
  if (user.marketing_messages_reset_at && now >= user.marketing_messages_reset_at) {
    const nextMidnight = new Date(jakartaNow);
    nextMidnight.setHours(24, 0, 0, 0);
    
    await User.findByIdAndUpdate(userId, {
      marketing_messages_today: 0,
      marketing_messages_reset_at: nextMidnight
    });
    user.marketing_messages_today = 0;
  }
  
  // Check rate limit (max 5/day)
  if (user.marketing_messages_today >= 5) {
    logger.info(`[RATE_LIMIT] User ${userId} exceeded 5 messages/day limit`);
    return false; // Rate limit exceeded
  }
  
  // Increment counter
  await User.findByIdAndUpdate(userId, {
    $inc: { marketing_messages_today: 1 }
  });
  
  return true; // Allowed to send
}

// [FIX BUG #3] Distributed locking to prevent race conditions between concurrent campaigns
// Acquires an atomic lock for a user on a specific date using MongoDB's findOneAndUpdate
// Returns true if lock acquired (can proceed), false if lock already held by another campaign
async function acquireCampaignLock(userId, campaignType) {
  const { CampaignLock } = require('./database');
  
  // Generate lock key with format: campaign_lock_{userId}_{YYYY-MM-DD}
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  const lockKey = `campaign_lock_${userId}_${today}`;
  
  // Lock expires in 1 hour (TTL)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  
  try {
    // [FIX] Mongoose v9: rawResult format berubah, lastErrorObject tidak ada lagi.
    // Solusi: pakai upsert + E11000 sebagai sinyal lock sudah dipegang instance lain.
    // Jika insert berhasil (tidak throw) = kita dapat lock.
    // Jika throw E11000 = lock sudah ada.
    await CampaignLock.create({
      lock_key: lockKey,
      campaign_type: campaignType,
      acquired_at: new Date(),
      expires_at: expiresAt
    });
    return true; // Lock berhasil diperoleh
  } catch (err) {
    // Duplicate key error (E11000) = lock sudah dipegang campaign lain → skip
    if (err.code === 11000) {
      logger.info(`[LOCK] User ${userId} locked by another campaign, skipping ${campaignType}`);
      return false;
    }
    // Error lain: log tapi tetap return false (safe-fail)
    logger.error(`[LOCK] Error acquiring lock for user ${userId}:`, err.message);
    return false;
  }
}

// [FIX BUG #11] Check if user currently has a pending order in checkout
// Returns true if user is in checkout (has PENDING order), false otherwise
// Purpose: Prevent marketing messages from interrupting active payment flows
async function isUserInCheckout(userId) {
  const { Order } = require('./database');
  
  try {
    // [FIX BUG#7] Hanya block jika PENDING dalam 35 menit terakhir
    // Sebelumnya: blok SEMUA PENDING tanpa batas waktu → user terkunci marketing 7 hari
    // QR Saweria expired dalam 30 menit → setelah 35 menit, order dianggap abandoned
    const thirtyFiveMinutesAgo = new Date(Date.now() - 35 * 60 * 1000);
    const pendingOrder = await Order.findOne({ 
      user_id: userId, 
      status: 'PENDING',
      created_at: { $gte: thirtyFiveMinutesAgo }
    }).lean();
    
    // Return true if pending order exists (user is in checkout)
    return pendingOrder !== null;
  } catch (err) {
    // On error, assume user is in checkout (fail-safe to prevent interruption)
    logger.error(`[CHECKOUT_CHECK] Error checking pending order for user ${userId}:`, err.message);
    return true;
  }
}

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

// [FIX BUTTON_DATA_INVALID] Unicode combining strikethrough (U+0336) di teks tombol
// menyebabkan Telegram error BUTTON_DATA_INVALID untuk semua user!
// Ganti dengan format teks biasa yang aman: coret visual pakai tanda ~
function strikeThrough(text) {
  return `~${text}~`;
}

async function buildProductMarkup(userId, product, discountAmount = 0) {
  // [FIX] Cek diskon global jika tidak ada diskon spesifik dari campaign
  if (discountAmount === 0 && userId && product) {
    try {
      const activeDisc = await store.applyAutomaticDiscount(userId, product._id, product.price);
      if (activeDisc) {
        discountAmount = activeDisc.deduction;
      }
    } catch(e) {}
  }

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

// Bangun keyboard dengan SEMUA produk yang belum dibeli user (untuk campaign & reminder)
async function buildAllProductsKeyboard(userId, allProducts, discountPercentage = 0) {
  // Ambil produk yang sudah dibeli user
  const successOrders = await Order.find({ user_id: userId, status: 'SUCCESS' }).lean();
  const orderIds = successOrders.map(o => o._id);
  const boughtItems = orderIds.length > 0
    ? await OrderItem.find({ order_id: { $in: orderIds } }).lean()
    : [];
  const boughtProductIds = new Set(boughtItems.map(i => String(i.product_id)));

  // Filter ke produk yang BELUM dibeli
  const unboughtProducts = allProducts.filter(p => !boughtProductIds.has(String(p._id)));
  if (unboughtProducts.length === 0) return { keyboard: null, products: [] };

  const buttons = [];
  for (const p of unboughtProducts) {
    if (p.preview_url) {
      buttons.push([Markup.button.url(`📺 Preview ${p.name}`, p.preview_url)]);
    }
    if (discountPercentage > 0 && p.price > 0) {
      const discountAmount = Math.floor(p.price * discountPercentage / 100);
      const finalPrice = Math.max(0, p.price - discountAmount);
      const originalK = formatK(p.price);
      const numPart = originalK.replace('k', '');
      const kPart = originalK.includes('k') ? 'k' : '';
      buttons.push([Markup.button.callback(
        `💥 ${p.name}: ${strikeThrough(numPart)}${kPart} ➤ Rp${formatK(finalPrice)}`,
        `buy_now_${p._id}`
      )]);
    } else {
      buttons.push([Markup.button.callback(
        `🔥 Beli ${p.name} (Rp${formatK(p.price)})`,
        `buy_now_${p._id}`
      )]);
    }
  }

  // Tombol Bundle — tampil jika ada ≥2 produk yang belum dibeli
  // [FIX] Gunakan 8 char pertama tiap ID agar callback < 64 char (Telegram limit)
  // Full ID: 24 char × 4 + 3 underscore = 99 char → OVERFLOW
  // Short ID: 8 char × 4 + 3 underscore = 35 char → AMAN
  if (unboughtProducts.length >= 2) {
    const totalNormal   = unboughtProducts.reduce((s, p) => s + (p.price || 0), 0);
    const bundleDisc    = 20; // 20% bundle discount
    const totalBundle   = Math.floor(totalNormal * (1 - bundleDisc / 100));
    const saving        = totalNormal - totalBundle;
    const shortIds      = unboughtProducts.map(p => String(p._id).slice(0, 8)).join('-');
    buttons.push([
      Markup.button.callback(
        `🎁 BUNDLE HEMAT ${bundleDisc}% — Rp${formatK(totalBundle)} (Hemat Rp${formatK(saving)})`,
        `buy_bndl_${shortIds}`
      )
    ]);
  }

  return { keyboard: Markup.inlineKeyboard(buttons), products: unboughtProducts };
}
// productPrice opsional — jika diisi, diskon di-cap sesuai harga produk
// Produk < Rp 100rb (misal 50rb & 60rb): max 15% agar tidak terlalu murah
// Produk >= Rp 100rb (misal 250rb): boleh sampai 30%
async function calculateDynamicDiscount(user, productPrice = 0) {
  const daysSinceJoin = (Date.now() - new Date(user.joined_at)) / (1000 * 60 * 60 * 24);
  const purchaseCount = user.purchase_count || 0;
  const totalSpent = user.total_spent || 0;

  // Tentukan batas maksimum diskon berdasarkan harga produk
  // Produk murah (< 100rb): max 15% — jangan sampai terasa "hampir gratis"
  // Produk mahal (>= 100rb): max 30%
  const maxDiscount = productPrice > 0 && productPrice < 100000 ? 15 : 30;

  const cap = (pct) => Math.min(pct, maxDiscount);

  if (totalSpent > 100000 || purchaseCount >= 5) {
    return { percentage: cap(10), title: 'Khusus Member VIP' };
  }
  
  if (purchaseCount === 0 && daysSinceJoin > 30) {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const prevBigDiscounts = await Discount.countDocuments({
      target_user_id: user._id,
      type: 'PERCENTAGE',
      value: { $gte: 15 },
      created_at: { $gte: ninetyDaysAgo }
    });
    
    if (prevBigDiscounts >= 2) return { percentage: cap(15), title: 'Spesial Comeback' };
    if (prevBigDiscounts === 1) return { percentage: cap(20), title: 'Spesial Comeback' };
    return { percentage: cap(25), title: 'Spesial Comeback' };
  }
  
  if (purchaseCount === 0 && daysSinceJoin <= 30) {
    return { percentage: cap(15), title: 'Diskon Khusus' };
  }
  
  return { percentage: cap(10), title: 'Promo Pelanggan Setia' };
}

// ==========================================
// TELEGRAM RATE LIMIT QUEUE (TASK 3)
// ==========================================
class TelegramQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.pausedUntil = 0;
    // 35ms delay = max ~28 req/sec (aman di bawah limit 30 req/sec)
    this.delayMs = 35;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      if (Date.now() < this.pausedUntil) {
        const waitTime = this.pausedUntil - Date.now();
        await new Promise(r => setTimeout(r, waitTime));
      }

      const { task, resolve, reject } = this.queue.shift();
      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        if (err.code === 429) {
          const retryAfter = err.parameters?.retry_after || 5;
          console.warn(`⚠️ [QUEUE] Telegram Rate Limit (429). Pause ${retryAfter} detik.`);
          this.pausedUntil = Date.now() + (retryAfter * 1000);
          this.queue.unshift({ task, resolve, reject }); // Retry
        } else {
          reject(err);
        }
      }

      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }
    }
    this.isProcessing = false;
  }
}

const telegramQueue = new TelegramQueue();

async function sendSafe(bot, userId, text, options = {}) {
  try {
    const extra = { parse_mode: 'HTML' };
    let replyMarkup = null;
    if (options.keyboard?.reply_markup) {
      replyMarkup = options.keyboard.reply_markup;
    } else if (options.keyboard?.inline_keyboard) {
      replyMarkup = options.keyboard;
    }
    if (replyMarkup) extra.reply_markup = replyMarkup;

    // [FIX PESAN PISAH] Selalu kirim teks+tombol dalam 1 pesan.
    // Media (GIF/foto/video) dikirim DULU sebagai visual, lalu 1 pesan teks+tombol.
    // Telegram mendukung reply_markup di photo & video tapi TIDAK di animation.
    // Solusi: sendAnimation tanpa caption, lalu sendMessage dengan teks+tombol.

    const task = async () => {
      if (options.mediaGroup && options.mediaGroup.length > 1) {
        // Album foto: kirim album dulu (tanpa caption), lalu teks+tombol dalam 1 pesan
        const mediaArr = options.mediaGroup.map(m => ({
          type: m.type || 'photo',
          media: m.file_id
        }));
        await bot.telegram.sendMediaGroup(userId, mediaArr);
        // Kirim teks+tombol sebagai 1 pesan setelah album
        return await bot.telegram.sendMessage(userId, text, extra);

      } else if (options.media) {
        const hType = options.mediaType || 'url';
        const hFile = options.media;
        const isPhoto = hType === 'photo' || (hType === 'url' && hFile.match(/\.(jpeg|jpg|png)$/i));
        const isVideo = hType === 'video';

        if (isPhoto) {
          // Foto: bisa caption+tombol dalam 1 pesan
          return await bot.telegram.sendPhoto(userId, hFile, { caption: text, parse_mode: 'HTML', reply_markup: replyMarkup || undefined });
        } else if (isVideo) {
          // Video: bisa caption+tombol dalam 1 pesan
          return await bot.telegram.sendVideo(userId, hFile, { caption: text, parse_mode: 'HTML', reply_markup: replyMarkup || undefined });
        } else {
          // GIF/Animation: sekarang kirim gabung dalam 1 pesan (caption + tombol)
          return await bot.telegram.sendAnimation(userId, hFile, { caption: text, parse_mode: 'HTML', reply_markup: replyMarkup || undefined });
        }
      } else {
        // Teks only
        return await bot.telegram.sendMessage(userId, text, extra);
      }
    };

    // Eksekusi API call melalui antrean rate limit
    await telegramQueue.enqueue(task);
    
    // [FIX KRITIS] Gunakan native driver — findByIdAndUpdate(userId) dengan _id=Number
    // sering silent fail di Mongoose → timestamp tidak tersimpan
    // → cooldown tidak bekerja → user bisa dapat double marketing (RT + cron)!
    try {
      const db = User.db.db;
      await db.collection('users').updateOne(
        { _id: Number(userId) },
        { $set: { last_broadcast_at: new Date(), last_promo_campaign: options.campaign || 'UNKNOWN' } }
      );
    } catch (_) {
      await User.updateOne({ _id: userId }, { $set: { last_broadcast_at: new Date(), last_promo_campaign: options.campaign || 'UNKNOWN' } }).catch(() => {});
    }
    // (sentInThisRun removed)
    logger.marketing.sent(userId, options.userName || '?', options.campaign || 'UNKNOWN', options.reason || '-');
    return { ok: true };
  } catch (err) {
    const isBlocked = err.code === 403 || err.code === 400 || (err.description && (
      err.description.includes('bot was blocked') ||
      err.description.includes('user is deactivated') ||
      err.description.includes('chat not found')
    ));
    if (isBlocked) {
      // [FIX IS_BLOCKED] Gunakan native driver karena findByIdAndUpdate
      // punya _id type mismatch (Number vs ObjectId) -> update silent fail
      // Akibat bug ini: SEMUA 498 user ter-flag is_blocked=true!
      try {
        const db = User.db.db;
        await db.collection('users').updateOne(
          { _id: Number(userId) },
          { $set: { is_blocked: true } }
        );
      } catch (_) {
        await User.updateOne({ _id: userId }, { $set: { is_blocked: true } }).catch(() => {});
      }
      logger.user.blocked(userId, err.description);
    } else {
      logger.marketing.failed(userId, options.campaign || 'UNKNOWN', err.message);
    }
    return { ok: false, isBlocked, error: err.message };
  }
}

const CAMPAIGN_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48 jam minimum antar campaign

function isInCooldown(user, { bypassForBuyer = false, overrideCooldownMs = null, currentCampaign = null } = {}) {
  if (String(user._id) === String(process.env.ADMIN_CHAT_ID)) return false;
  if (bypassForBuyer && user.purchase_count > 0) return false;
  
  // Jika campaign yang akan dikirim SAMA (atau dalam grup funnel yang sama) dengan campaign sebelumnya,
  // skip cooldown lintas-funnel (misal progresi internal funnel Cart Abandon stage 1 -> stage 2)
  if (currentCampaign && user.last_promo_campaign && user.last_promo_campaign.startsWith(currentCampaign)) {
    // [FIX BUG #4] VIP_WINBACK should NOT bypass cooldown - enforce full 48-hour cooldown
    if (currentCampaign === 'VIP_WINBACK') {
      // Do not bypass - fall through to normal cooldown check
    } else {
      // [FIX BUG #4] For other campaigns, increase MIN_BYPASS_AGE_MS from 5 minutes to 48 hours
      // This prevents spam while allowing funnel progression after sufficient time
      const MIN_BYPASS_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
      if (!user.last_broadcast_at || (new Date() - new Date(user.last_broadcast_at)) >= MIN_BYPASS_AGE_MS) {
        return false;
      }
    }
  }
  
  const cooldownLimit = overrideCooldownMs !== null ? overrideCooldownMs : CAMPAIGN_COOLDOWN_MS;
  
  if (user.last_broadcast_at) {
    const lastSent = new Date(user.last_broadcast_at).getTime();
    if (Date.now() - lastSent < cooldownLimit) {
      return true;
    }
  }
  return false;
}


// ─── CAMPAIGN 1: NON-BUYER ──────────────────────────────────────────────────

// Klasifikasikan kenapa user belum beli
async function classifyNonBuyer(user) {
  const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
  if (daysInactive < 1) return 'HOT';
  if (daysInactive >= 1 && daysInactive <= 7) return 'WARM';
  if (daysInactive > 7 && daysInactive <= 30) return 'COLD';
  return 'GHOST';
}

/**
 * Copywriting dinamis per produk — tidak hardcode JAV lagi.
 * Dipakai oleh Campaign 1 (Non-Buyer) agar pesan relevan untuk BOOCIL, OME TV, dll.
 *
 * @param {Array}  products  - array produk yang belum dibeli user (unboughtProducts)
 * @param {string} segment   - 'CART_ABANDON' | 'INACTIVE' | 'COLD_LEAD'
 * @returns {string}         - pesan HTML siap kirim
 */
function getProductCopy(products, segment) {
  // Ambil produk pertama sebagai anchor copy, sisanya disebutkan di keyboard
  const p = products[0];
  const name = p ? p.name : 'Channel VIP';
  const nameList = products.map(pr => `<b>${pr.name}</b>`).join(' &amp; ');

  const isJAV    = name.toLowerCase().includes('jav');
  const isBoocil = name.toLowerCase().includes('boocil');
  const isViral  = name.toLowerCase().includes('viral') || name.toLowerCase().includes('indo viral');
  const isOme    = name.toLowerCase().includes('ome') || name.toLowerCase().includes('vcs');

  // ── CART ABANDON ────────────────────────────────────────────────
  if (segment === 'CART_ABANDON') {
    if (isJAV) return (
      `🔴 <b>Bos, Akses ${nameList} Masih Menunggumu!</b>\n\n` +
      `Kamu hampir dapat akses — tinggal satu langkah lagi.\n\n` +
      `🇮🇩 <b>Subtitle Indonesia dikerjakan tim kami sendiri</b>\n` +
      `<i>Bukan auto-sub, bukan repost. Terjemahan manusia, bukan mesin.</i>\n\n` +
      `<blockquote>Slot VIP masih tersimpan. Jangan sampai diambil orang lain.</blockquote>\n\n` +
      `👇 <b>Selesaikan Pembayaran Sekarang</b>`
    );
    if (isBoocil) return (
      `🔴 <b>Hampir Masuk ke ${nameList}!</b>\n\n` +
      `Komunitas paling eksklusif ini masih menantimu.\n\n` +
      `👑 Konten premium eksklusif tiap hari\n` +
      `🔒 Akses permanen — bayar sekali\n` +
      `🤝 Member bisa saling share koleksi\n\n` +
      `<blockquote>Slot terbatas. Jangan sampai penuh sebelum kamu masuk.</blockquote>\n\n` +
      `👇 <b>Selesaikan Sekarang</b>`
    );
    if (isViral) return (
      `🔴 <b>Konten Viral Indonesia Masih Menunggumu!</b>\n\n` +
      `Kamu hampir dapat akses ke ${nameList} — video viral Indo paling fresh.\n\n` +
      `🔥 Dikurasi manual, update rutin\n` +
      `📱 Konten yang lagi rame dibahas sekarang\n` +
      `✅ Akses permanen\n\n` +
      `<blockquote>Jangan sampai ketinggalan konten viral terbaru.</blockquote>\n\n` +
      `👇 <b>Selesaikan Pembayaran</b>`
    );
    if (isOme) return (
      `🔴 <b>Session OME TV &amp; VCS Menunggumu!</b>\n\n` +
      `Kamu hampir dapat akses ${nameList} — komunitas session live terbaik.\n\n` +
      `📡 Jadwal session tiap malam\n` +
      `💡 Tips &amp; trik eksklusif dari member aktif\n` +
      `🎯 Partner VCS sesama member\n\n` +
      `<blockquote>Member lain sudah aktif session malam ini.</blockquote>\n\n` +
      `👇 <b>Selesaikan Sekarang</b>`
    );
    // Generic fallback
    return (
      `🔴 <b>Akses ${nameList} Masih Menunggumu!</b>\n\n` +
      `Kamu hampir masuk — jangan biarkan kesempatan ini hilang.\n\n` +
      `✅ Akses permanen\n` +
      `✅ Update rutin tanpa biaya tambahan\n` +
      `✅ Bayar sekali, nikmati selamanya\n\n` +
      `<blockquote>Slot VIP terbatas. Selesaikan sekarang.</blockquote>\n\n` +
      `👇 <b>Selesaikan Pembayaran</b>`
    );
  }

  // ── INACTIVE ─────────────────────────────────────────────────────
  if (segment === 'INACTIVE') {
    if (isJAV) return (
      `🎬 <b>Update Baru ${nameList} Sudah Masuk!</b>\n\n` +
      `Tim kami baru selesai menerjemahkan batch subtitle terbaru.\n\n` +
      `🇮🇩 Puluhan video baru + subtitle Indonesia eksklusif\n` +
      `🔍 Request video langsung via bot\n` +
      `✅ Subtitle manual — bukan auto-generated\n\n` +
      `<blockquote>Semakin lama nunggu = semakin banyak konten yang kamu lewati.</blockquote>\n\n` +
      `👇 <b>Gabung VIP Sekarang</b>`
    );
    if (isBoocil) return (
      `👑 <b>Komunitas ${nameList} Makin Ramai!</b>\n\n` +
      `Ada koleksi baru yang baru diupload member — kamu belum lihat.\n\n` +
      `📸 Konten eksklusif terbaru sudah masuk\n` +
      `🔥 Diskusi aktif antar member\n` +
      `🎁 Request konten spesial ke admin\n\n` +
      `<blockquote>Member yang gabung duluan dapat harga terbaik.</blockquote>\n\n` +
      `👇 <b>Gabung Sekarang</b>`
    );
    if (isViral) return (
      `📱 <b>Konten Viral Baru di ${nameList} Sudah Masuk!</b>\n\n` +
      `Ini yang lagi rame dibahas minggu ini — dan kamu ketinggalan.\n\n` +
      `🔥 Video viral dikurasi manual tiap hari\n` +
      `⚡ Update lebih cepat dari channel mana pun\n` +
      `✅ Hanya ada di sini\n\n` +
      `<blockquote>Semakin telat = semakin banyak yang kamu lewati.</blockquote>\n\n` +
      `👇 <b>Akses Sekarang</b>`
    );
    if (isOme) return (
      `📡 <b>Session ${nameList} Malam Ini Sudah Mulai!</b>\n\n` +
      `Member lain sudah aktif sesi OME TV dan VCS — kamu masih di luar.\n\n` +
      `🎯 Tips terbaru dari member aktif sudah dibagikan\n` +
      `📅 Jadwal session eksklusif minggu ini\n` +
      `🤝 Komunitas makin solid dan aktif\n\n` +
      `<blockquote>Gabung sekarang sebelum slot penuh.</blockquote>\n\n` +
      `👇 <b>Masuk Sekarang</b>`
    );
    return (
      `⭐ <b>Update Baru ${nameList} Sudah Masuk!</b>\n\n` +
      `Sudah lama tidak membuka bot — ada banyak yang baru.\n\n` +
      `✅ Konten baru diupdate rutin\n` +
      `✅ Akses permanen sekali bayar\n` +
      `✅ Tidak ada biaya tambahan\n\n` +
      `<blockquote>Harga masih opening. Segera naik.</blockquote>\n\n` +
      `👇 <b>Gabung Sekarang</b>`
    );
  }

  // ── COLD LEAD ─────────────────────────────────────────────────────
  if (isJAV) return (
    `🌟 <b>Kenapa 3.200+ Member Pilih ${nameList}?</b>\n\n` +
    `Satu alasan utama: <b>Subtitle Indonesia dikerjakan tim kami sendiri.</b>\n\n` +
    `Di luar sana banyak channel JAV, tapi hampir semua:\n` +
    `❌ Repost dari channel lain\n` +
    `❌ Subtitle mesin (tidak akurat)\n` +
    `❌ Tidak bisa di-request\n\n` +
    `Di <b>${name}</b>:\n` +
    `✅ Subtitle 100% manual — hasil terjemahan tim kami\n` +
    `✅ Request video via bot, langsung diproses\n` +
    `✅ Akses permanen, bayar sekali\n\n` +
    `<blockquote>Harga opening masih berlaku. Segera naik saat koleksi bertambah.</blockquote>\n\n` +
    `👇 <b>Amankan Akses VIP Sekarang</b>`
  );
  if (isBoocil) return (
    `👑 <b>Kenapa ${nameList} Beda dari yang Lain?</b>\n\n` +
    `Ini bukan sekadar channel — ini komunitas eksklusif.\n\n` +
    `Di luar sana:\n` +
    `❌ Konten recycle, tidak original\n` +
    `❌ Tidak ada interaksi\n` +
    `❌ Admin tidak responsif\n\n` +
    `Di <b>${name}</b>:\n` +
    `✅ Konten original &amp; eksklusif tiap hari\n` +
    `✅ Member aktif saling share koleksi\n` +
    `✅ Admin responsif — bisa request langsung\n` +
    `✅ Akses permanen sekali bayar\n\n` +
    `<blockquote>Komunitas terpilih. Slot terbatas.</blockquote>\n\n` +
    `👇 <b>Masuk ke Komunitas Sekarang</b>`
  );
  if (isViral) return (
    `🔥 <b>Mau Konten Viral Indo yang Paling Fresh?</b>\n\n` +
    `${nameList} adalah satu-satunya tempat di mana konten viral dikurasi manual setiap hari.\n\n` +
    `Di tempat lain:\n` +
    `❌ Konten sudah beredar lama, basi\n` +
    `❌ Tidak ada kurasi — asal upload\n\n` +
    `Di <b>${name}</b>:\n` +
    `✅ Viral terbaru masuk duluan\n` +
    `✅ Dikurasi manual — hanya yang terbaik\n` +
    `✅ Akses permanen, update terus\n\n` +
    `<blockquote>Kalau kamu suka konten viral Indo, ini tempatnya.</blockquote>\n\n` +
    `👇 <b>Akses Sekarang</b>`
  );
  if (isOme) return (
    `📡 <b>Mau Jago OME TV &amp; VCS? Ini Komunitasnya.</b>\n\n` +
    `${nameList} adalah komunitas khusus untuk yang serius belajar dan bermain OME TV.\n\n` +
    `Yang kamu dapat:\n` +
    `🎯 Teknik &amp; strategi dari member berpengalaman\n` +
    `📅 Jadwal session live bareng member\n` +
    `🤝 Partner VCS sesama member terpercaya\n` +
    `💡 Tips trik eksklusif yang tidak ada di YouTube\n` +
    `✅ Akses permanen\n\n` +
    `<blockquote>Komunitas aktif setiap malam. Jangan ketinggalan.</blockquote>\n\n` +
    `👇 <b>Gabung Komunitas Sekarang</b>`
  );
  // Generic
  return (
    `🌟 <b>Kenapa Ribuan Member Pilih ${nameList}?</b>\n\n` +
    `Konten premium eksklusif yang tidak bisa kamu temukan di tempat lain.\n\n` +
    `✅ Update rutin tanpa henti\n` +
    `✅ Admin responsif — request langsung dilayani\n` +
    `✅ Akses permanen, bayar sekali\n` +
    `✅ Komunitas member yang aktif\n\n` +
    `<blockquote>Harga masih opening. Segera naik.</blockquote>\n\n` +
    `👇 <b>Amankan Akses Sekarang</b>`
  );
}

async function runNonBuyerCampaign(bot) {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  // [FIX KRITIS] Dihapus filter buyer agar buyer juga di-follow up untuk sisa produk yang belum dibeli
  // const buyerUserIds = await Order.distinct('user_id', { status: 'SUCCESS' });

  const nonBuyers = await User.find({
    // _id: { $nin: buyerUserIds }, // Dihapus
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
    defaultProduct = popular.length > 0
      ? allProducts.find(p => String(p._id) === String(popular[0]._id)) || allProducts[0]
      : allProducts[0];
  }

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

  for (const user of nonBuyers) {
    if (isUserQuietHour(user)) { stats.skipped++; continue; }
    if (isInCooldown(user, { currentCampaign: 'NON_BUYER' })) { stats.skipped++; continue; }

    // [FIX BUG #3] Acquire distributed lock to prevent race conditions
    const gotLock = await acquireCampaignLock(user._id, 'NON_BUYER');
    if (!gotLock) {
      logger.info(`[LOCK] User ${user._id} locked by another campaign, skipping NON_BUYER`);
      stats.skipped++;
      continue;
    }

    // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
    if (await isUserInCheckout(user._id)) {
      logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping NON_BUYER to avoid payment flow interruption`);
      stats.skipped++;
      continue;
    }

    // [FIX] Cek semua produk, skip hanya jika SEMUA produk sudah ada drip aktif
    // [FIX C-2] Gunakan $gte: 0 agar user yang di-recycle (stage 0) ikut terdeteksi
    // Sebelumnya: $gt: 0 → stage 0 tidak pernah ditemukan → stage0Drip selalu undefined
    const existingDrips = await DripLog.find({ user_id: user._id, converted: false, stage: { $gte: 0 } }).lean();
    const dripProductIds = new Set(existingDrips.filter(d => d.stage > 0).map(d => String(d.product_id)));
    const allProductsHaveDrip = allProducts.every(p => dripProductIds.has(String(p._id)));
    if (existingDrips.length > 0) {
      const stage0Drip = existingDrips.find(d => d.stage === 0);
      if (stage0Drip) await DripLog.findByIdAndUpdate(stage0Drip._id, { stage: 1, sent_at: new Date() });
      if (allProductsHaveDrip) { stats.skipped++; continue; }
    }

    const segment = await classifyNonBuyer(user);

    // Jika opt-out dan BUKAN Cart Abandonment, lompat.
    if (user.opt_out && segment !== 'CART_ABANDON') {
      stats.skipped++; 
      continue; 
    }

    // [FIX DISKON] Semua segment dapat diskon — bukan hanya COLD/GHOST!
    // HOT = baru aktif, kasih diskon kecil sebagai insentif pertama
    // WARM = sudah kenal produk, kasih diskon medium biar push ke checkout
    // COLD/GHOST = sudah lama hilang, kasih diskon besar re-engagement
    let discountVal = 0;
    if      (segment === 'HOT')   discountVal = 15; // 15%
    else if (segment === 'WARM')  discountVal = 20; // 20%
    else if (segment === 'COLD')  discountVal = 25; // 25%
    else if (segment === 'GHOST') discountVal = 30; // 30%

    // Bangun keyboard dengan diskon dinamis
    const { keyboard: allKeyboard, products: unboughtProducts } = await buildAllProductsKeyboard(user._id, allProducts, discountVal);
    
    // [FIX] Jika user sudah beli SEMUA produk, tidak usah ditawari lagi
    if (!allKeyboard || unboughtProducts.length === 0) {
      stats.skipped++;
      continue;
    }
    
    const keyboard = allKeyboard;

    const prodList = unboughtProducts;
    
    // [FIX ROTASI] Rotasi produk berbasis jumlah pesan yang sudah diterima user
    // Sebelumnya: (userId + hari) % N → user yang sama selalu dapat produk SAMA setiap hari
    // Sekarang: (userId + broadcastCount) % N → produk berganti setiap kali user dapat pesan
    const userIdNum = typeof user._id === 'object' ? parseInt(String(user._id).slice(-6), 16) : Number(user._id);
    const broadcastCount = user.daily_message_count || 0; // berapa kali sudah dapat pesan
    const rotationIndex = (userIdNum + broadcastCount) % (prodList.length || 1);
    logger.info(`[ROTASI] userId=${user._id} broadcastCount=${broadcastCount} rotationIndex=${rotationIndex}/${prodList.length} → produk: ${prodList[rotationIndex]?.name || '-'}`);
    
    const customKey = segment === 'HOT' ? 'hot_lead'
                    : segment === 'WARM' ? 'warm_lead'
                    : 'cold_lead';
    const customMsg = await Setting.findById('marketing_' + customKey).lean();
    let msg;
    if (customMsg && customMsg.value) {
      const produkNames = prodList.map(p => `<b>${p.name}</b>`).join(' &amp; ');
      msg = customMsg.value.replace(/\{produk\}/g, produkNames);
    } else {
      if (segment === 'HOT') {
        const recentBuyers = await Order.countDocuments({ status: 'SUCCESS', created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
        const totalBuyers = (await Order.distinct('user_id', { status: 'SUCCESS' })).length;
        const p = prodList[rotationIndex] || prodList[0];
        const isJAV = p && p.name.toLowerCase().includes('jav');
        const socialLine = recentBuyers > 0
          ? `Dalam 24 jam terakhir, <b>${recentBuyers} orang baru masuk</b>. Total <b>${totalBuyers}+ member</b> sudah punya akses.`
          : `Sudah <b>${totalBuyers}+ member</b> yang punya akses penuh sekarang.`;
        // [FIX] HOT sekarang dapat diskon 5% — sebutkan di copy!
        msg = isJAV
          ? `🔑 <b>Akses VIP + Diskon ${discountVal}% Hari Ini!</b>\n\n` +
            `${socialLine}\n\n` +
            `Yang mereka dapat setiap hari:\n` +
            `🇮🇩 Subtitle Indonesia dibuat tim sendiri — bukan auto-sub\n` +
            `📥 Request video baru langsung via bot\n` +
            `✅ Akses permanen, bayar sekali\n\n` +
            `<blockquote>Masuk sekarang dengan harga lebih murah ${discountVal}%.</blockquote>\n\n` +
            `👇 <b>Gabung + Hemat ${discountVal}%</b>`
          : `🔑 <b>Akses VIP + Diskon ${discountVal}% Hari Ini!</b>\n\n` +
            `${socialLine}\n\n` +
            `<blockquote>Harga hemat ${discountVal}% — berlaku hari ini saja.</blockquote>\n\n` +
            `👇 <b>Gabung + Hemat ${discountVal}%</b>`;
      } else if (segment === 'WARM') {
        const totalBuyers = (await Order.distinct('user_id', { status: 'SUCCESS' })).length;
        const recentBuyers = await Order.countDocuments({
          status: 'SUCCESS',
          created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });
        // [FIX BUG #13] Apply rotation to WARM segment for fair product exposure
        const p = prodList[rotationIndex] || prodList[0];
        const isJAV = p && p.name.toLowerCase().includes('jav');
        // [FIX NON_BUYER_WARM] Upgrade copy — data log: 6.244 pesan, 0 konversi.
        // Sebelumnya: copy terlalu lembut ("Ada yang baru"). Sekarang: urgency + scarcity nyata.
        const socialLine24h = recentBuyers > 0
          ? `${recentBuyers} orang bergabung dalam 24 jam terakhir.`
          : `${totalBuyers}+ member aktif sudah di dalam.`;
        msg = isJAV
          ? `⚡ <b>${totalBuyers}+ member sudah akses — kamu kapan?</b>\n\n` +
            `Batch subtitle baru baru selesai. Tanpa auto-sub, tanpa repost — dikerjain manual.\n\n` +
            `<blockquote>${socialLine24h} Slot tidak unlimited.</blockquote>\n\n` +
            `Hari ini kamu bisa masuk dengan <b>harga lebih hemat ${discountVal}%.</b>\n` +
            `Diskon ini hangus otomatis dalam 48 jam — tidak bisa diperpanjang.\n\n` +
            `👇 <b>Masuk Sekarang — Hemat ${discountVal}%</b>`
          : `⚡ <b>${socialLine24h}</b>\n\n` +
            `Koleksi terus bertambah — dan harga akan ikut naik.\n\n` +
            `Sekarang kamu masih bisa masuk dengan <b>diskon ${discountVal}%.</b>\n\n` +
            `<blockquote>Diskon hangus 48 jam. Tidak ada perpanjangan.</blockquote>\n\n` +
            `👇 <b>Ambil Sekarang — Sebelum Harga Normal</b>`;
      } else {
        // COLD/GHOST = sudah lama tidak aktif, butuh re-engagement + diskon besar
        // [FIX BUG #13] Apply rotation to COLD/GHOST segments for fair product exposure
        const p = prodList[rotationIndex] || prodList[0];
        const isJAV = p && p.name.toLowerCase().includes('jav');
        msg = isJAV
          ? `🎁 <b>Diskon ${discountVal}% khusus buat kamu!</b>\n\n` +
            `Sudah lama tidak mampir. Kami kasih penawaran spesial hari ini.\n\n` +
            `🇮🇩 <b>Subtitle Indonesia dikerjakan sendiri oleh tim J-SUB.</b>\n` +
            `Bukan auto-sub. Bukan repost. Terjemahan manusia.\n\n` +
            `<blockquote>Koleksi terus bertambah. Diskon hangus 24 jam.</blockquote>\n\n` +
            `👇 <b>Ambil Diskon ${discountVal}% Sekarang</b>`
          : `🎁 <b>Diskon ${discountVal}% masih berlaku buat kamu!</b>\n\n` +
            `Sudah lama tidak mampir — kami siapkan penawaran spesial.\n\n` +
            `Akses VIP permanen + koleksi terus bertambah, harga lebih murah ${discountVal}%.\n\n` +
            `<blockquote>Diskon hangus dalam 24 jam. Tidak bisa diperpanjang.</blockquote>\n\n` +
            `👇 <b>Klaim Diskon ${discountVal}% Sekarang</b>`;
      }
    }

    // Jika memberi diskon, simpan ke database diskon
    // [FIX BUG#DISC-DUP] Cek duplikat dulu — jangan buat diskon baru jika user
    // sudah punya diskon aktif yang belum expired. Ini mencegah DB bloat
    // (sebelumnya: 1.813 records untuk 485 user = 3.7 diskon/user rata-rata)
    if (discountVal > 0 && !user.opt_out) {
      const existingDisc = await Discount.findOne({
        target_user_id: Number(user._id),
        active: true,
        valid_until: { $gt: new Date() }
      }).lean();
      if (!existingDisc) {
        await Discount.findOneAndUpdate(
          { target_user_id: Number(user._id), target_product_id: null, trigger_event: 'REALTIME', type: 'PERCENTAGE', active: true },
          { $set: { value: discountVal, valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
          { upsert: true }
        );
      }
    }

    // 🔥 Kirim preview dulu agar user lihat konten nyata sebelum pitch
    if (previewModule) {
      try {
        await previewModule.sendPreviewToUser(bot, user._id, 3);
        await delay(800);
      } catch(e) { /* preview gagal = skip, jangan crash campaign */ }
    }

    // [FIX ROTASI PRODUK] Pilih produk yang dipromote berdasarkan hash userId
    // Tiap user dapat produk berbeda — bukan cuma produk pertama terus
    const firstPromo = prodList[rotationIndex] || prodList[0];
    const promoMediaArr = firstPromo?.promo_media?.length > 1 ? firstPromo.promo_media : null;
    const promoImg  = firstPromo?.promo_image_id || hFile;
    const promoType = firstPromo?.promo_image_id ? (firstPromo.promo_media_type || 'photo') : hType;
    const sendOpts  = promoMediaArr
      ? { mediaGroup: promoMediaArr, keyboard, campaign: `NON_BUYER_${segment}`, userName: user.first_name || '?', reason: firstPromo?.name || '-' }
      : { media: promoImg, mediaType: promoType, keyboard, campaign: `NON_BUYER_${segment}`, userName: user.first_name || '?', reason: firstPromo?.name || '-' };

    // [FIX BUG #2] Check global rate limit (max 3 messages/day)
    const canSend = await checkAndIncrementRateLimit(user._id);
    if (!canSend) {
      logger.info(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day, skipping NON_BUYER campaign`);
      stats.skipped++;
      continue;
    }

    const result = await sendSafe(bot, user._id, msg, sendOpts);
    if (result.ok) {
      if (segment === 'CART_ABANDON') stats.abandon++;
      else if (segment === 'INACTIVE') stats.inactive++;
      else stats.cold++;

      // [FIX COOLDOWN] Update last_broadcast_at di DB setelah kirim berhasil
      // Ini yang membuat cooldown 48 jam bisa bekerja di-run berikutnya
      await User.findByIdAndUpdate(user._id, { $set: { last_broadcast_at: new Date() } }).catch(() => {});

      // Buat DripLog untuk setiap produk yang belum dibeli
      const unboughtForDrip = prodList;
      for (const dripProd of unboughtForDrip) {
        const existingForProd = await DripLog.findOne({
          user_id: user._id,
          product_id: String(dripProd._id),
          converted: false
        }).lean();
        if (existingForProd) continue;

        // [FIX] Cart abandon discount harus punya active:true!
        if (segment === 'CART_ABANDON' && String(dripProd._id) === String(unboughtForDrip[0]._id)) {
          const existCA = await Discount.findOne({ target_user_id: Number(user._id), active: true, valid_until: { $gt: new Date() } }).lean();
          if (!existCA) {
            await Discount.findOneAndUpdate(
              { target_user_id: Number(user._id), target_product_id: null, trigger_event: 'CART_ABANDON', type: 'PERCENTAGE', active: true },
              { $set: { value: 10, valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000) } },
              { upsert: true }
            );
          }
        }

        // [FIX DUPLIKAT] Upsert — aman kalau bot restart di tengah campaign
        try {
          await DripLog.findOneAndUpdate(
            { user_id: user._id, product_id: String(dripProd._id), campaign_type: 'NON_BUYER', stage: 1 },
            { $setOnInsert: { user_id: user._id, product_id: String(dripProd._id), campaign_type: 'NON_BUYER', stage: 1, sent_at: new Date(), converted: false, variant: Math.random() > 0.5 ? 'A' : 'B' } },
            { upsert: true }
          );
        } catch (e) {}
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

// Smart Recommendation: (Refactored to eliminate N+1 Query & Restore Collaborative Filtering)
async function getSmartRecommendation(userId, boughtIds, allProducts, globalTopProducts, similarityMap) {
  const unbought = allProducts.filter(p => !boughtIds.includes(String(p._id)));
  if (!unbought.length) return null;

  // 1. Tally Collaborative Filtering scores from precomputed similarityMap
  if (similarityMap) {
    const scores = {};
    for (const bId of boughtIds) {
      const similarArr = similarityMap[String(bId)] || [];
      // Similar products that user hasn't bought yet
      for (const simId of similarArr) {
        if (!boughtIds.includes(simId)) {
          scores[simId] = (scores[simId] || 0) + 1;
        }
      }
    }
    
    // Pick the product with the highest similarity score
    let bestSimId = null;
    let maxScore = 0;
    for (const [sId, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        bestSimId = sId;
      }
    }
    
    if (bestSimId) {
      const rec = allProducts.find(p => String(p._id) === bestSimId);
      if (rec) return rec;
    }
  }

  // 2. Fallback: Cukup cari produk teratas dari globalTopProducts yang belum dibeli
  // Karena globalTopProducts sudah memuat seluruh produk (diurutkan berdasarkan terlaris),
  // fungsi find() akan otomatis menemukan rekomendasi terbaik, atau fallback produk biasa.
  if (globalTopProducts && globalTopProducts.length > 0) {
    return globalTopProducts.find(p => !boughtIds.includes(String(p._id))) || null;
  }

  // Fallback darurat jika cache gagal terload
  return unbought[0];
}

async function runCrossSellCampaign(bot, allProducts, globalTopProducts, similarityMap) {
  if (allProducts.length < 2) return { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const partialBuyers = await User.find({ 
    purchase_count: { $gt: 0 }, 
    is_blocked: { $ne: true },
    opt_out: { $ne: true },  // [PRESERVE REQ 3.15] Skip opted-out users
    last_active_at: { $gte: sixtyDaysAgo }
  }).lean();
  const totalCount = allProducts.length;
  const stats = { crossSell: 0, complete: 0, skipped: 0, failed: 0 };

  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

  for (const user of partialBuyers) {
    // [FIX BUG #3] Acquire distributed lock to prevent race conditions
    const gotLock = await acquireCampaignLock(user._id, 'CROSS_SELL');
    if (!gotLock) {
      logger.info(`[LOCK] User ${user._id} locked by another campaign, skipping CROSS_SELL campaign`);
      stats.skipped++;
      continue;
    }

    // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
    if (await isUserInCheckout(user._id)) {
      logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping CROSS_SELL to avoid payment flow interruption`);
      stats.skipped++;
      continue;
    }

    // [FIX BUG#4] Tag campaign yang benar — sebelumnya salah copy-paste 'VIP_WINBACK'
    if (isInCooldown(user, { currentCampaign: 'CROSS_SELL' })) { stats.skipped++; continue; }

    const boughtIds = await getBoughtProductIds(user._id);
    if (boughtIds.length >= totalCount) { stats.complete++; continue; }

    const targetProduct = await getSmartRecommendation(user._id, boughtIds, allProducts, globalTopProducts, similarityMap);
    if (!targetProduct) { stats.skipped++; continue; }

    // [FIX BUG #8] Validate stock availability before recommendation
    const stockCount = await Stock.countDocuments({
      product_id: targetProduct._id,
      status: 'AVAILABLE'
    });
    if (stockCount === 0) {
      logger.info(`[CROSS_SELL] Product ${targetProduct._id} (${targetProduct.name}) is sold out, skipping user ${user._id}`);
      stats.skipped++;
      continue;
    }

    // [FIX] Guard duplikat: skip jika sudah pernah dapat cross-sell produk ini hari ini
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const alreadySentToday = await DripLog.findOne({
      user_id: user._id,
      product_id: String(targetProduct._id),
      campaign_type: 'CROSS_SELL',
      sent_at: { $gte: todayStart }
    }).lean();
    if (alreadySentToday) { stats.skipped++; continue; }

    const boughtNames = allProducts
      .filter(p => boughtIds.includes(String(p._id)))
      .map(p => p.name).join(' &amp; ') || 'VIP';

    const name = user.first_name || 'Bos';
    const tgt  = targetProduct.name;

    // [FIX] Pakai HTML bukan Markdown (*bold*) — sendSafe kirim parse_mode HTML
    // [FIX] Pesan lebih informatif dan personal
    const isJAV    = tgt.toLowerCase().includes('jav');
    const isBoocil = tgt.toLowerCase().includes('boocil');
    const isViral  = tgt.toLowerCase().includes('viral');
    const isOme    = tgt.toLowerCase().includes('ome') || tgt.toLowerCase().includes('vcs');

    let msg;
    if (isJAV) {
      msg = `🎬 <b>${name}, ada yang kamu belum punya nih!</b>\n\n` +
            `Kamu sudah punya <b>${boughtNames}</b> — tapi belum punya akses ke <b>${tgt}</b>.\n\n` +
            `🇮🇩 Subtitle Indonesia 100% manual, bukan mesin\n` +
            `🔍 Request &amp; cari video langsung via bot\n` +
            `✅ Akses permanen — bayar sekali\n\n` +
            `<blockquote>Member ${boughtNames} biasanya juga ambil ${tgt} untuk koleksi lengkap.</blockquote>\n\n` +
            `👇 <b>Lengkapi Koleksi VIP Sekarang</b>`;
    } else if (isBoocil) {
      msg = `👑 <b>${name}, koleksi VIP kamu belum lengkap!</b>\n\n` +
            `Kamu sudah punya <b>${boughtNames}</b> — selanjutnya upgrade ke <b>${tgt}</b>.\n\n` +
            `📸 Konten eksklusif yang tidak ada di mana pun\n` +
            `🤝 Komunitas member aktif, bisa saling share\n` +
            `✅ Akses permanen\n\n` +
            `<blockquote>Gabungan ${boughtNames} + ${tgt} = koleksi paling lengkap.</blockquote>\n\n` +
            `👇 <b>Upgrade Sekarang</b>`;
    } else if (isViral) {
      msg = `📱 <b>${name}, jangan sampai ketinggalan konten viral!</b>\n\n` +
            `Kamu sudah punya <b>${boughtNames}</b> — tambah <b>${tgt}</b> untuk koleksi makin kenceng.\n\n` +
            `🔥 Video viral Indonesia dikurasi manual tiap hari\n` +
            `⚡ Update lebih cepat dari channel lain\n` +
            `✅ Akses permanen\n\n` +
            `<blockquote>Banyak member ${boughtNames} juga aktif di ${tgt}.</blockquote>\n\n` +
            `👇 <b>Akses Sekarang</b>`;
    } else if (isOme) {
      msg = `📡 <b>${name}, komunitas OME TV &amp; VCS lagi aktif!</b>\n\n` +
            `Kamu sudah punya <b>${boughtNames}</b> — coba tambah <b>${tgt}</b>.\n\n` +
            `🎯 Teknik &amp; strategi dari member berpengalaman\n` +
            `📅 Jadwal session live eksklusif\n` +
            `✅ Akses permanen\n\n` +
            `<blockquote>Member ${boughtNames} biasanya juga main di ${tgt}.</blockquote>\n\n` +
            `👇 <b>Gabung Sekarang</b>`;
    } else {
      msg = `⭐ <b>${name}, koleksi VIP kamu belum lengkap!</b>\n\n` +
            `Kamu sudah punya <b>${boughtNames}</b> — upgrade ke <b>${tgt}</b> untuk akses lebih luas.\n\n` +
            `✅ Konten eksklusif\n✅ Update rutin\n✅ Akses permanen\n\n` +
            `<blockquote>Banyak member ${boughtNames} juga aktif di ${tgt}.</blockquote>\n\n` +
            `👇 <b>Upgrade Sekarang</b>`;
    }

    // [FIX BUG #2] Check global rate limit (max 3 messages/day)
    const canSend = await checkAndIncrementRateLimit(user._id);
    if (!canSend) {
      logger.info(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day, skipping CROSS_SELL campaign`);
      stats.skipped++;
      continue;
    }

    const keyboard = await buildProductMarkup(user._id, targetProduct);
    const crossMediaArr  = targetProduct.promo_media?.length > 1 ? targetProduct.promo_media : null;
    const crossPromoImg  = targetProduct.promo_image_id || hFile;
    const crossPromoType = targetProduct.promo_image_id ? (targetProduct.promo_media_type || 'photo') : hType;
    const crossSendOpts  = crossMediaArr
      ? { mediaGroup: crossMediaArr, keyboard, campaign: 'CROSS_SELL', userName: user.first_name || '?', reason: targetProduct?.name || '-' }
      : { media: crossPromoImg, mediaType: crossPromoType, keyboard, campaign: 'CROSS_SELL', userName: user.first_name || '?', reason: targetProduct?.name || '-' };

    const result = await sendSafe(bot, user._id, msg, crossSendOpts);
    if (result.ok) {
      // [FIX COOLDOWN] Update last_broadcast_at — bukan last_active_at!
      // last_active_at dipakai classifyNonBuyer() untuk segment HOT/WARM/COLD
      // kalau di-update di sini, buyer yang dapat cross-sell akan selalu jadi HOT
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() }).catch(() => {});

      const existingDrip = await DripLog.findOne({
        user_id: user._id,
        product_id: String(targetProduct._id),
        converted: false
      }).lean();
      if (!existingDrip) {
        // [FIX DUPLIKAT] Upsert — aman kalau bot restart di tengah campaign
        try {
          await DripLog.findOneAndUpdate(
            { user_id: user._id, product_id: String(targetProduct._id), campaign_type: 'CROSS_SELL', stage: 1 },
            { $setOnInsert: { user_id: user._id, product_id: String(targetProduct._id), campaign_type: 'CROSS_SELL', stage: 1, sent_at: new Date(), converted: false, variant: Math.random() > 0.5 ? 'A' : 'B' } },
            { upsert: true }
          );
        } catch (e) {}
      } else {
        // Update sent_at agar stage 2/3 timer dihitung dari sekarang
        await DripLog.findByIdAndUpdate(existingDrip._id, { sent_at: new Date() });
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
  const stats = { complete: 0, sent: 0, skipped: 0, failed: 0 };
  const now = new Date();
  const sentThisExecution = new Set(); // [FIX BUG#2] Intra-cron deduplication

  // [FIX BUG#2] Reset sentInThisRun di awal SETIAP panggilan runDripFollowUp
  // Sebelumnya hanya di-clear di runMarketingCampaign — saat drip-only path (baris 1769)
  // dipanggil, set masih berisi userId dari run sebelumnya → semua drip di-skip!

  // === HARD CAP 90 HARI: Tutup funnel diam-diam jika macet terlalu lama ===
  const ninetyDaysAgo = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000));
  const sevenDaysAgo  = new Date(now.getTime() - (7  * 24 * 60 * 60 * 1000));
  try {
    await DripLog.updateMany(
      { converted: false, created_at: { $lte: ninetyDaysAgo } },
      { $set: { converted: true, exited_reason: 'TIMEOUT' } }
    );
    // [FIX BUG#7] Cleanup stage=0 yang stuck >7 hari (cart abandon tidak ada yang kembali)
    await DripLog.updateMany(
      { stage: 0, converted: false, sent_at: { $lte: sevenDaysAgo } },
      { $set: { converted: true, exited_reason: 'STUCK_STAGE0' } }
    );
    // [FIX BUG#5] Exclude CROSS_SELL dari buyer cleanup
    // Sebelumnya: semua DripLog buyer (termasuk CROSS_SELL) dimark converted → Cross-sell S2/S3 dead code
    // Cross-sell DripLog MEMANG milik buyer — jangan dihapus sebelum waktunya
    const buyerUserIds = await Order.distinct('user_id', { status: 'SUCCESS' });
    if (buyerUserIds.length > 0) {
      const buyerDripFixed = await DripLog.updateMany(
        { user_id: { $in: buyerUserIds }, converted: false, campaign_type: { $ne: 'CROSS_SELL' } },
        { $set: { converted: true, exited_reason: 'BUYER_CLEANUP' } }
      );
      if (buyerDripFixed.modifiedCount > 0)
        console.log(`[DRIP] Cleanup buyer drip: ${buyerDripFixed.modifiedCount} logs dimark converted (CROSS_SELL dikecualikan)`);
    }
  } catch (err) {
    console.error('[DRIP] Gagal eksekusi cleanup:', err);
  }



  const hType = await getSetting('header_type', 'url');
  const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');

  // ─── HELPER: Ambil media header per produk ─────────────────────────────
  // Jika produk punya promo_image_id sendiri → pakai itu (lebih menarik, sesuai produk)
  // Jika tidak → fallback ke header global
  // Cache produk dengan media untuk fallback
  let _mediaFallbackCache = null;
  async function getProductMediaFallback() {
    if (_mediaFallbackCache) return _mediaFallbackCache;
    const prodsWithMedia = await Product.find({ active: 1, promo_image_id: { $exists: true, $ne: null, $ne: '' } }).lean();
    _mediaFallbackCache = prodsWithMedia;
    return prodsWithMedia;
  }

  async function getProductMedia(product) {
    if (product && product.promo_image_id) {
      return { file: product.promo_image_id, type: product.promo_media_type || 'photo' };
    }
    // Fallback: cari produk lain yang punya media (lebih baik dari GIF Giphy yang expired)
    const fallbacks = await getProductMediaFallback();
    if (fallbacks.length > 0) {
      // Pilih secara acak dari produk yang ada media agar variasi
      const pick = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      return { file: pick.promo_image_id, type: pick.promo_media_type || 'photo' };
    }
    return { file: hFile, type: hType };
  }

  // ─── HELPER: Copy per kategori produk ──────────────────────────────────
  // Tiap produk punya hook yang berbeda sesuai kontennya
  function getProductHook(product, stage) {
    const name = product ? product.name : 'Channel VIP';
    const isJAV     = name.toLowerCase().includes('jav');
    const isBoocil  = name.toLowerCase().includes('boocil');
    const isViral   = name.toLowerCase().includes('viral') || name.toLowerCase().includes('indo');
    const isOme     = name.toLowerCase().includes('ome') || name.toLowerCase().includes('vcs');

    if (stage === 2) {
      // Stage 2: Social proof + curiosity — apa yang mereka missed
      if (isJAV)    return `🎬 Video baru masuk tadi malam. Subtitle Indo-nya sudah siap. Member VIP langsung bisa nonton — kamu belum.`;
      if (isBoocil) return `👑 Komunitas ${name} makin rame. Ada yang udah upload koleksi baru tadi pagi. Sayang kalau kelewat.`;
      if (isViral)  return `🔥 Konten viral terbaru sudah masuk ke ${name}. Ini yang lagi rame dibahas member sekarang.`;
      if (isOme)    return `📡 Session OME TV & VCS member malem ini udah jalan. Kamu masih di luar.`;
      return `🔒 Update terbaru sudah masuk ke ${name}. Member VIP sudah bisa akses — kamu belum.`;
    }

    if (stage === 3) {
      // Stage 3: Value proof — tunjukkan isi konkret
      if (isJAV)    return `🎞️ Koleksi ${name}: ratusan video subtitle Indonesia manual, update rutin, request bebas. Bayar sekali, akses selamanya.`;
      if (isBoocil) return `👑 ${name}: komunitas eksklusif, konten premium tiap hari, sesama member saling share. Investasi kecil, value besar.`;
      if (isViral)  return `📱 ${name}: konten viral Indo paling fresh, dikurasi manual tim kami. Tidak ada di tempat lain.`;
      if (isOme)    return `🎥 ${name}: jadwal session live, tips & trik OME TV, partner VCS sesama member. Komunitas aktif.`;
      return `⭐ ${name}: konten premium eksklusif yang tidak bisa kamu temukan di tempat lain.`;
    }

    return name;
  }

  // ─── Timing Agresif tapi Natural ────────────────────────────────────────
  // Hari 1: Stage 1 — Perkenalan + hook (Campaign 1 / Non-Buyer)
  // Hari 2: Stage 2 — Social proof, apa yang mereka missed (1 hari setelah Stage 1)
  // Hari 4: Stage 3 — Value proof + diskon personal (2 hari setelah Stage 2)
  // Hari 9: Stage 4 — Penawaran terakhir (5 hari setelah Stage 3)
  // = Total 4 pesan dalam 9 hari — aggressive tapi tidak terasa spam
  const oneDayAgo  = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  // === Stage 2: Hari ke-2 — Social Proof & Curiosity ===
  const stage1Logs = await DripLog.find({
    stage: 1,
    sent_at: { $lte: oneDayAgo },
    converted: false
  }).lean();

  const globalTopProducts = arguments[3] || [];
  const similarityMap = arguments[4] || {};
  for (const log of stage1Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked || user.opt_out) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
        if (user && user.opt_out) stats.skipped++;
        continue;
      }

      // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
      if (await isUserInCheckout(user._id)) {
        logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping DRIP Stage 2 to avoid payment flow interruption`);
        stats.skipped++;
        continue;
      }

      // [FIX BUG #3] Acquire distributed lock to prevent race conditions
      const gotLock = await acquireCampaignLock(user._id, 'DRIP');
      if (!gotLock) {
        console.log(`[LOCK] User ${user._id} locked by another campaign - skipping DRIP Stage 2`);
        stats.skipped++;
        continue;
      }

      // [FIX SPAM] Cek cooldown — max 1 drip per user per hari (walau punya banyak produk)
      // [FIX H-2] Drip S2 pakai 'DRIP' bukan 'NON_BUYER' agar cooldown funnel tepat
      if (isInCooldown(user, { currentCampaign: 'DRIP' })) { stats.skipped++; continue; }
      if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

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

      // [FIX E11000] Cek apakah sudah ada DripLog Stage 2+ untuk user+produk+campaign ini
      // Jika ada (data lama dari bulan sebelumnya) → skip, tandai converted
      const alreadyStage2 = await DripLog.findOne({
        user_id: log.user_id,
        product_id: String(log.product_id),
        campaign_type: log.campaign_type,
        stage: { $gte: 2 }
      }).lean();
      if (alreadyStage2) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'ALREADY_ADVANCED' });
        stats.skipped++;
        continue;
      }

      const product = await Product.findById(log.product_id).lean();
      const { file: mediaFile, type: mediaType } = await getProductMedia(product);
      const hook = getProductHook(product, 2);
      const name = user.first_name || 'Bos';
      const productName = product ? product.name : 'Channel VIP';

      // Total buyers — social proof angka nyata
      const totalBuyers = await User.countDocuments({ purchase_count: { $gt: 0 } });
      // Rotasi 3 template (A/B/C) agar tidak timpang
      const variant3 = log.variant === 'B' ? 'B' : (Math.random() < 0.5 ? 'A' : 'C');

      const msg = variant3 === 'B'
        ? `👀 <b>${name}, satu hal yang bikin penasaran...</b>\n\n` +
          `${hook}\n\n` +
          `Sudah <b>${totalBuyers}+ member</b> yang gabung bulan ini.\n` +
          `Mereka yang masuk duluan dapat harga terbaik.\n\n` +
          `<blockquote>Harga masih opening — belum naik. Tapi tidak akan selamanya.</blockquote>\n\n` +
          `👇 <b>Lihat Apa yang Kamu Lewatkan</b>`
        : variant3 === 'C'
        ? `🔥 <b>${name}, ini yang lagi rame sekarang...</b>\n\n` +
          `${hook}\n\n` +
          `<b>${Math.floor(totalBuyers * 0.15)}+ orang</b> buka ${productName} hari ini.\n\n` +
          `<blockquote>Konten baru terus masuk — member yang sudah di dalam terus nambah koleksi.</blockquote>\n\n` +
          `👇 <b>Gabung Sebelum Harga Naik</b>`
        : `📌 <b>${name}, update dari ${productName}:</b>\n\n` +
          `${hook}\n\n` +
          `Minggu ini saja sudah ada <b>${Math.floor(totalBuyers * 0.3)}+ member baru</b> yang masuk.\n\n` +
          `<blockquote>Semakin telat gabung = semakin banyak konten yang kamu lewatin.</blockquote>\n\n` +
          `👇 <b>Gabung Sekarang</b>`;

      // [FIX S2 DISKON] Stage 2 uses segment-based progressive discounts
      // [FIX BUG #6] WARM segment gets 15% at stage 2 (progressive from 10% at stage 1)
      let keyboard = null;
      if (product) {
        // Classify user segment for progressive discount
        const segment = await classifyNonBuyer(user);
        let discountVal = 0;
        if      (segment === 'HOT')   discountVal = 15; // 15%
        else if (segment === 'WARM')  discountVal = 20; // 20%
        else if (segment === 'COLD')  discountVal = 25; // 25%
        else if (segment === 'GHOST') discountVal = 30; // 30%
        
        const s2DiscAmt = Math.floor((product.price || 0) * (discountVal / 100));
        keyboard = await buildProductMarkup(user._id, product, s2DiscAmt);
      }

      // [FIX BUG #2] Check global rate limit before sending
      const canSend = await checkAndIncrementRateLimit(user._id);
      if (!canSend) {
        console.log(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day - skipping DRIP Stage 2`);
        stats.skipped++;
        continue;
      }

      const result = await sendSafe(bot, user._id, msg, { media: mediaFile, mediaType, keyboard, campaign: 'NON_BUYER_DRIP_S2', userName: user.first_name || '?', reason: String(log.product_id) });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 2, sent_at: new Date() });
        stats.sent++;
        sentThisExecution.add(String(user._id));
      } else {
        if (result.isBlocked) await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 2 });
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      // [FIX E11000] Jika error duplikat key — anggap sudah terkirim, skip saja
      if (err.code === 11000) {
        console.log(`[DRIP] Stage 2 skip (sudah ada): user ${log.user_id}`);
        try { await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'ALREADY_ADVANCED' }); } catch(_){}
      } else {
        console.error(`[DRIP] Error Stage 2 user ${log.user_id}:`, err.message);
      }
      continue;
    }
  }

  // === Stage 3: Hari ke-4 — Value Proof + Diskon Personal ===
  const stage2Logs = await DripLog.find({
    stage: 2,
    sent_at: { $lte: twoDaysAgo },
    converted: false
  }).lean();

  for (const log of stage2Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked || user.opt_out) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
        if (user && user.opt_out) stats.skipped++;
        continue;
      }

      // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
      if (await isUserInCheckout(user._id)) {
        logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping DRIP Stage 3 to avoid payment flow interruption`);
        stats.skipped++;
        continue;
      }

      // [FIX BUG #3] Acquire distributed lock to prevent race conditions
      const gotLock = await acquireCampaignLock(user._id, 'DRIP');
      if (!gotLock) {
        console.log(`[LOCK] User ${user._id} locked by another campaign - skipping DRIP Stage 3`);
        stats.skipped++;
        continue;
      }

      // [FIX SPAM] Max 1 drip per user per hari
      // [FIX H-2] Drip S3 pakai 'DRIP' bukan 'NON_BUYER'
      if (isInCooldown(user, { currentCampaign: 'DRIP' })) { stats.skipped++; continue; }
      if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

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
      const discountRule = await calculateDynamicDiscount(user, product ? product.price : 0);
      const discountAmount = product ? Math.floor(product.price * (discountRule.percentage / 100)) : 0;
      const finalPrice = product ? product.price - discountAmount : 0;
      const { file: mediaFile, type: mediaType } = await getProductMedia(product);
      const hook = getProductHook(product, 3);
      const name = user.first_name || 'Bos';

      const msg = log.variant === 'B'
        ? `💌 <b>Pesan khusus untuk ${name}</b>\n\n` +
          `${hook}\n\n` +
          `Karena kamu sudah tertarik tapi belum sempat masuk, kami siapkan:\n\n` +
          `🎁 <b>Diskon ${discountRule.percentage}% — Khusus untuk kamu</b>\n` +
          `💰 Harga jadi: <b>Rp ${finalPrice.toLocaleString('id-ID')}</b>\n` +
          `⏳ <i>Berlaku 72 jam</i>\n\n` +
          `<blockquote>Harga ini tidak akan muncul lagi setelah 3 hari.</blockquote>\n\n` +
          `👇 <b>Klaim Harga Spesial Saya</b>`
        : `🔥 <b>${name}, diskon ${discountRule.percentage}% sudah disiapkan!</b>\n\n` +
          `${hook}\n\n` +
          `Sistem kami otomatis pilih kamu untuk dapat harga ini:\n` +
          `✅ Akses penuh selamanya\n` +
          `✅ Update rutin tanpa biaya tambahan\n` +
          `✅ Harga spesial: <b>Rp ${finalPrice.toLocaleString('id-ID')}</b> (hemat ${discountRule.percentage}%)\n\n` +
          `<blockquote>Diskon hangus dalam 72 jam. Tidak bisa diperpanjang.</blockquote>\n\n` +
          `👇 <b>Pakai Diskon Sekarang</b>`;

      let keyboard = null;
      if (product) keyboard = await buildProductMarkup(user._id, product, discountAmount);

      // [FIX BUG #2] Check global rate limit before sending
      const canSend = await checkAndIncrementRateLimit(user._id);
      if (!canSend) {
        console.log(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day - skipping DRIP Stage 3`);
        stats.skipped++;
        continue;
      }

      const result = await sendSafe(bot, user._id, msg, { media: mediaFile, mediaType, keyboard, campaign: 'NON_BUYER_DRIP_S3', userName: user.first_name || '?', reason: String(log.product_id) });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 3, sent_at: new Date() });
        // [FIX BUG#S3-DISC] Tambah active:true — tanpanya diskon tidak pernah berlaku
        // saat checkout karena applyAutomaticDiscount() query {active:true}
        // [FIX BUG#DISC-DUP] Cek duplikat — jangan buat diskon baru jika sudah ada
        const existingS3Disc = await Discount.findOne({
          target_user_id: Number(user._id),
          active: true,
          valid_until: { $gt: new Date() }
        }).lean();
        if (!existingS3Disc) {
          // [FIX] 72 jam — sesuai copy teks yang bilang 'Berlaku 72 jam'
          // Sebelumnya: 24 jam — user balik keesokan hari, diskon sudah hangus
          await Discount.findOneAndUpdate(
            { target_user_id: Number(user._id), target_product_id: String(log.product_id), trigger_event: 'DRIP', type: 'PERCENTAGE', active: true },
            { $set: { value: discountRule.percentage, valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000) } },
            { upsert: true }
          );
        }
        stats.sent++;
        sentThisExecution.add(String(user._id));
      } else {
        if (result.isBlocked) await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 3 });
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      console.error(`[DRIP] Error Stage 3 user ${log.user_id}:`, err);
      continue;
    }
  }

  
  // === Stage 4: Hari ke-9 — Penawaran Terakhir (5 hari setelah Stage 3) ===
  // [FIX] Hapus filter campaign_type:'NON_BUYER' — CROSS_SELL juga harus dapat Stage 4
  const stage3Logs = await DripLog.find({
    stage: 3,
    sent_at: { $lte: fiveDaysAgo },
    converted: false
  }).lean();

  for (const log of stage3Logs) {
    try {
      const user = await User.findById(log.user_id).lean();
      if (!user || user.is_blocked || user.opt_out) {
        await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
        if (user && user.opt_out) stats.skipped++;
        continue;
      }

      // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
      if (await isUserInCheckout(user._id)) {
        logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping DRIP Stage 4 to avoid payment flow interruption`);
        stats.skipped++;
        continue;
      }

      // [FIX BUG #3] Acquire distributed lock to prevent race conditions
      const gotLock = await acquireCampaignLock(user._id, 'DRIP');
      if (!gotLock) {
        console.log(`[LOCK] User ${user._id} locked by another campaign - skipping DRIP Stage 4`);
        stats.skipped++;
        continue;
      }

      // [FIX SPAM] Max 1 drip per user per hari
      // [FIX H-2] Drip S4 pakai 'DRIP' bukan 'NON_BUYER'
      if (isInCooldown(user, { currentCampaign: 'DRIP' })) { stats.skipped++; continue; }
      if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

      const product = await Product.findById(log.product_id).lean();
      if (!product) {
         await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
         continue;
      }

      const { file: mediaFile, type: mediaType } = await getProductMedia(product);
      const stage4DiscPct = product.price < 100000 ? 15 : 30;
      const discountAmount = Math.floor(product.price * (stage4DiscPct / 100));
      const finalPrice = product.price - discountAmount;
      const name = user.first_name || 'Bos';

      const msgStage4 =
        `⏰ <b>${name}, ini pesan terakhir dari kami.</b>\n\n` +
        `Kami sudah kirim beberapa kali karena kami yakin <b>${product.name}</b> cocok untuk kamu.\n\n` +
        `Setelah ini kami tidak akan ganggu lagi.\n\n` +
        `Tapi sebelum kami tutup penawaran ini — kami kasih diskon terakhir:\n` +
        `💰 <b>Diskon ${stage4DiscPct}% → Harga jadi Rp ${finalPrice.toLocaleString('id-ID')}</b>\n` +
        `⏳ Berlaku 72 jam saja.\n\n` +
        `<blockquote>Setelah ini tidak ada lagi penawaran harga khusus untuk produk ini.</blockquote>\n\n` +
        `👇 <b>Ini Kesempatan Terakhir Saya</b>\n\n` +
        `<i>Ketik /stop_promo jika tidak ingin menerima pesan penawaran lagi.</i>`;

      const keyboard = await buildProductMarkup(user._id, product, discountAmount);

      // [FIX BUG #2] Check global rate limit before sending
      const canSend = await checkAndIncrementRateLimit(user._id);
      if (!canSend) {
        console.log(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day - skipping DRIP Stage 4`);
        stats.skipped++;
        continue;
      }

      const result = await sendSafe(bot, user._id, msgStage4, { media: mediaFile, mediaType, keyboard, campaign: 'NON_BUYER_DRIP_S4', userName: user.first_name || '?', reason: String(log.product_id) });
      if (result.ok) {
        await DripLog.findByIdAndUpdate(log._id, { stage: 4, sent_at: new Date() });
        await Discount.findOneAndUpdate(
          { target_user_id: Number(user._id), target_product_id: String(log.product_id), trigger_event: 'DRIP', type: 'PERCENTAGE', active: true },
          // [FIX BUG#6] Samakan valid_until dengan copy ("72 jam") → 48 jam (tengah)
          // Sebelumnya: copy bilang 72 jam tapi DB set 24 jam → user balik esok hari, diskon hangus
          { $set: { value: stage4DiscPct, valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000) } },
          { upsert: true }
        );
        stats.sent++;
        sentThisExecution.add(String(user._id));
      } else {
        if (result.isBlocked) await DripLog.findByIdAndUpdate(log._id, { converted: true, stage: 4 });
        stats.failed++;
      }
      await delay(1500);
    } catch (err) {
      console.error('[DRIP] Error Stage 4', err);
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
      if (!user || user.is_blocked || user.purchase_count > 0 || user.opt_out) {
        // Jika ternyata sudah beli, diblokir, atau opt_out, tutup saja selamanya
        await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'CLEANUP' });
        if (user && user.opt_out) stats.skipped++;
        continue;
      }
      if (isUserQuietHour(user)) { stats.skipped++; continue; }

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

// ─── [W9] POST-PURCHASE FOLLOW-UP ────────────────────────────────────────────
// Stage 2 (3 hari): tips penggunaan + minta review
// Stage 3 (7 hari): cross-sell produk lain + diskon 10%
async function runPostPurchaseFollowUp(bot) {
  const stats = { complete: 0, sent: 0, skipped: 0 };
  const now   = new Date();
  const sentThisExecution = new Set();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const allProducts  = await Product.find({ active: 1 }).lean();
  const hType = await getSetting('header_type', 'url');
  const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');

  // ── Stage 2: Hari ke-3 — Tips + Review Request ───────────────────────────
  const ppStage1 = await DripLog.find({
    campaign_type: 'POST_PURCHASE',
    stage: 1,
    sent_at: { $lte: threeDaysAgo },
    converted: false
  }).lean();

  for (const log of ppStage1) {
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked || user.opt_out || isUserQuietHour(user) || isInCooldown(user, { bypassForBuyer: true, currentCampaign: 'POST_PURCHASE' })) { stats.skipped++; continue; }
    if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

    const product = await Product.findById(log.product_id).lean();
    const name    = user.first_name || 'Bos';
    const pName   = product ? product.name : 'Channel VIP';
    const isJAV   = pName.toLowerCase().includes('jav');
    const isBoocil= pName.toLowerCase().includes('boocil');
    const isOme   = pName.toLowerCase().includes('ome') || pName.toLowerCase().includes('vcs');

    let tips;
    if (isJAV)     tips = `🔍 Cari video favorit langsung via bot\n📥 Request subtitle untuk video baru\n🔔 Nyalakan notifikasi agar tidak ketinggalan update`;
    else if (isBoocil) tips = `📸 Lihat konten member aktif di channel\n🤝 Kenalan dengan member lain di komunitas\n🔔 Post koleksi kamu biar dapat feedback`;
    else if (isOme) tips = `📅 Cek jadwal session live malam ini\n🎯 Baca tips dari member senior di channel\n🤝 Minta pair dengan member aktif`;
    else tips = `✅ Akses channel VIP kamu sudah aktif\n🔔 Nyalakan notifikasi Telegram agar tidak ketinggalan\n💬 DM admin jika butuh bantuan`;

    const days = Math.round((now - new Date(log.sent_at)) / 86400000);
    const msg =
      `🎉 <b>${name}, akses VIP kamu sudah aktif ${days} hari!</b>\n\n` +
      `Sudah coba semua fitur di <b>${pName}</b>? Ini 3 hal yang sering dilewatkan member baru:\n\n` +
      `${tips}\n\n` +
      `<blockquote>Ada kendala akses atau pertanyaan? Langsung balas pesan ini — admin aktif.</blockquote>\n\n` +
      `⭐ <b>Senang dengan ${pName}? Ceritain ke teman kamu ya!</b>`;

    const media  = product?.promo_image_id || hFile;
    const mType  = product?.promo_image_id ? (product.promo_media_type || 'photo') : hType;
    const result = await sendSafe(bot, user._id, msg, { media, mediaType: mType, campaign: 'POST_PURCHASE_S2_TIPS', userName: user.first_name || '?', reason: 'tips_and_review' });
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 2, sent_at: new Date() });
      await User.findByIdAndUpdate(user._id, { last_active_at: new Date() });
      stats.stage2++;
      sentThisExecution.add(String(user._id));
    } else { stats.skipped++; }
    await delay(1500);
  }

  // ── Stage 3: Hari ke-7 — Cross-sell produk lain + Diskon 10% ─────────────
  const ppStage2 = await DripLog.find({
    campaign_type: 'POST_PURCHASE',
    stage: 2,
    sent_at: { $lte: sevenDaysAgo },
    converted: false
  }).lean();

  for (const log of ppStage2) {
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked || user.opt_out || isUserQuietHour(user) || isInCooldown(user, { bypassForBuyer: true, currentCampaign: 'POST_PURCHASE' })) { stats.skipped++; continue; }
    if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

    // [FIX C-3] Deklarasikan boughtIds di dalam loop — sebelumnya undefined → ReferenceError crash
    const boughtIds = await getBoughtProductIds(user._id);
    const nextProduct = await getSmartRecommendation(user._id, boughtIds, allProducts, cachedGlobalTopProducts, cachedSimilarityMap);
    if (!nextProduct) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'COMPLETE' });
      continue;
    }

    const boughtProd = await Product.findById(log.product_id).lean();
    const name       = user.first_name || 'Bos';
    const boughtName = boughtProd ? boughtProd.name : 'VIP';
    const discPrice  = Math.floor(nextProduct.price * 0.9);

    const msg =
      `🎁 <b>${name}, hadiah spesial dari kami!</b>\n\n` +
      `Terima kasih sudah jadi member <b>${boughtName}</b> selama seminggu.\n\n` +
      `Sebagai bentuk apresiasi, upgrade ke <b>${nextProduct.name}</b> dengan:\n` +
      `💰 <b>Diskon 10% — Rp${discPrice.toLocaleString('id-ID')}</b> (normal Rp${nextProduct.price.toLocaleString('id-ID')})\n` +
      `⏳ Penawaran berlaku <b>72 jam</b> saja\n\n` +
      `<blockquote>Member yang punya keduanya bilang koleksinya jauh lebih lengkap.</blockquote>\n\n` +
      `👇 <b>Klaim Diskon Sekarang</b>`;

    await Discount.findOneAndUpdate(
      { target_user_id: Number(user._id), target_product_id: String(nextProduct._id), trigger_event: 'CROSS_SELL', type: 'PERCENTAGE', active: true },
      { $set: { value: 10, valid_until: new Date(Date.now() + 72 * 60 * 60 * 1000) } },
      { upsert: true }
    );

    const keyboard = await buildProductMarkup(user._id, nextProduct);
    const media    = nextProduct.promo_image_id || hFile;
    const mType    = nextProduct.promo_image_id ? (nextProduct.promo_media_type || 'photo') : hType;
    const result   = await sendSafe(bot, user._id, msg, { media, mediaType: mType, keyboard, campaign: 'POST_PURCHASE_S3_CROSSSELL', userName: user.first_name || '?', reason: 'cross_sell_10' });
    if (result.ok) {
      await DripLog.findByIdAndUpdate(log._id, { stage: 3, converted: true, exited_reason: 'POST_PURCHASE_COMPLETE' });
      await User.findByIdAndUpdate(user._id, { last_active_at: new Date() });
      stats.stage3++;
      sentThisExecution.add(String(user._id));
    } else { stats.skipped++; }
    await delay(1500);
  }

  // ── Stage 4: Hari ke-14 — Final re-engagement + diskon 15% ──────────────────
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const ppStage3Done = await DripLog.find({
    campaign_type: 'POST_PURCHASE',
    stage: 3,
    converted: false, // stage 3 yang belum di-cross-sell (belum beli produk lain)
    sent_at: { $lte: fourteenDaysAgo }
  }).lean();

  for (const log of ppStage3Done) {
    const user = await User.findById(log.user_id).lean();
    if (!user || user.is_blocked || user.opt_out || isUserQuietHour(user) || isInCooldown(user, { bypassForBuyer: true, currentCampaign: 'POST_PURCHASE' })) { stats.skipped++; continue; }
    if (sentThisExecution.has(String(user._id))) { stats.skipped++; continue; }

    const boughtIds = await getBoughtProductIds(user._id);
    const nextProduct = await getSmartRecommendation(user._id, boughtIds, allProducts, arguments[3], arguments[4]);
    if (!nextProduct) {
      await DripLog.findByIdAndUpdate(log._id, { converted: true, exited_reason: 'ALL_BOUGHT' });
      continue;
    }

    const name        = user.first_name || 'Bos';
    const discPrice   = Math.floor(nextProduct.price * 0.85);
    const totalBuyers = await User.countDocuments({ purchase_count: { $gt: 0 } });

    const msg =
      `🔔 <b>${name.toUpperCase()}, penawaran terakhir dari kami.</b>\n\n` +
      `Kamu sudah 2 minggu jadi member dan kami senang kamu di sini.\n` +
      `<b>${totalBuyers}+ member</b> sudah punya akses lengkap — kamu bisa jadi salah satunya.\n\n` +
      `Upgrade ke <b>${nextProduct.name}</b> dengan:\n` +
      `💰 <b>Diskon 15% — Rp${discPrice.toLocaleString('id-ID')}</b> (normal Rp${nextProduct.price.toLocaleString('id-ID')})\n` +
      `⏳ Hanya berlaku <b>24 jam</b>\n\n` +
      `<blockquote>Setelah ini tidak ada penawaran lagi. Harga kembali normal.</blockquote>\n\n` +
      `👇 <b>Klaim Diskon Terakhir</b>\n\n` +
      `<i>Ketik /stop_promo jika tidak ingin menerima pesan penawaran lagi.</i>`;

    const keyboard = await buildProductMarkup(user._id, nextProduct);
    const media    = nextProduct.promo_image_id || hFile;
    const mType    = nextProduct.promo_image_id ? (nextProduct.promo_media_type || 'photo') : hType;
    const result2  = await sendSafe(bot, user._id, msg, { media, mediaType: mType, keyboard, campaign: 'POST_PURCHASE_S4_FINAL', userName: user.first_name || '?', reason: 'cross_sell_15' });
    if (result2.ok) {
      // [FIX H-5] Simpan diskon SETELAH pesan berhasil dikirim, bukan sebelumnya
      // Sebelumnya: diskon dibuat lalu pesan gagal → diskon bocor ke DB tanpa pesan
      await Discount.findOneAndUpdate(
        { target_user_id: Number(user._id), target_product_id: String(nextProduct._id), trigger_event: 'CROSS_SELL', type: 'PERCENTAGE', active: true },
        { $set: { value: 15, valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
        { upsert: true }
      );
      await DripLog.findByIdAndUpdate(log._id, { stage: 4, sent_at: new Date() });
      stats.sent++;
      sentThisExecution.add(String(user._id));
    } else { stats.skipped++; }
    await delay(1500);
  }

  return stats;
}


// Dipanggil dari index.js saat fulfillOrder (onPaymentSuccess)
async function markDripConverted(userId, amount = 0, boughtProductIds = []) {
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

    // [FIX TC-27] Buat POST_PURCHASE DripLog stage 1 untuk setiap produk yang dibeli
    // Ini yang memicu runPostPurchaseFollowUp untuk kirim tips (D+3) dan cross-sell (D+7)
    for (const prodId of boughtProductIds) {
      const existing = await DripLog.findOne({
        user_id: userId,
        product_id: String(prodId),
        campaign_type: 'POST_PURCHASE',
        converted: false
      }).lean();
      if (!existing) {
        // [FIX DUPLIKAT] Upsert — aman kalau bot restart di tengah campaign
        await DripLog.findOneAndUpdate(
          { user_id: userId, product_id: String(prodId), campaign_type: 'POST_PURCHASE', stage: 1 },
          { $setOnInsert: { user_id: userId, product_id: String(prodId), campaign_type: 'POST_PURCHASE', stage: 1, sent_at: new Date(), converted: false } },
          { upsert: true }
        );
      }
    }
  } catch (e) { console.error('[DRIP] markDripConverted error:', e.message); }
}

// ─── [UPGRADE 1] CART ABANDON HYPER-RECOVERY ─────────────────────────────────
async function runCartAbandonCampaign(bot) {
  const stats = { sent1h: 0, sent3h: 0, sent12h: 0, skipped: 0 };
  const now = new Date();

  // [FIX ROOT CAUSE] Sebelumnya menggunakan UserEvent CHECKOUT yang tidak pernah fired.
  // Sekarang langsung pakai DripLog CART_ABANDON stage 0 sebagai trigger —
  // DripLog ini di-create otomatis saat order expire di handleOrderExpired().
  // [FIX CART-SCHEDULE] Juga ambil DripLog yang sudah scheduled_at <= now (dini hari yang di-queue)
  const pendingCA = await DripLog.find({
    campaign_type: 'CART_ABANDON',
    stage: 0,           // Stage 0 = baru abandon, belum dapat pesan apapun
    converted: false,
    $or: [
      { scheduled_at: { $exists: false } },      // belum punya schedule = kirim sekarang
      { scheduled_at: { $lte: now } }             // sudah waktunya (queue dari malam)
    ]
  }).lean();

  for (const drip of pendingCA) {
    const user = await User.findById(drip.user_id).lean();
    if (!user || user.is_blocked) { stats.skipped++; continue; }
    
    // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
    if (await isUserInCheckout(user._id)) {
      logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping CART_ABANDON to avoid payment flow interruption`);
      stats.skipped++;
      continue;
    }
    
    // [FIX BUG #3] Acquire distributed lock to prevent race conditions
    const gotLock = await acquireCampaignLock(user._id, 'CART_ABANDON');
    if (!gotLock) {
      logger.info(`[LOCK] User ${user._id} locked by another campaign, skipping CART_ABANDON`);
      stats.skipped++;
      continue;
    }
    
    // Cart abandon non-buyer bypass cooldown 48 jam, TAPI tetap butuh jeda minimal 2 jam 
    // agar tidak bertabrakan agresif jika baru dapat promo lain.
    // Buyer tetap pakai cooldown normal 48 jam (di-skip jika < 48 jam).
    const customCooldown = user.purchase_count === 0 ? 2 * 60 * 60 * 1000 : null;
    if (isInCooldown(user, { overrideCooldownMs: customCooldown, currentCampaign: 'CART_ABANDON' })) { stats.skipped++; continue; }

    // Pastikan belum bayar setelah abandon terakhir
    const lastAbandoned = await Order.findOne({ user_id: user._id, status: 'EXPIRED' }).sort({ created_at: -1 }).lean();
    const paidAfter = lastAbandoned ? await Order.findOne({
      user_id: user._id, status: 'SUCCESS',
      created_at: { $gte: lastAbandoned.created_at }
    }).lean() : null;
    if (paidAfter) {
      await DripLog.findByIdAndUpdate(drip._id, { converted: true, exited_reason: 'PAID_AFTER_ABANDON' });
      continue;
    }

    const abandonCount = await Order.countDocuments({ user_id: user._id, status: 'EXPIRED' });
    const hoursSince = lastAbandoned ? (now - new Date(lastAbandoned.created_at)) / 3600000 : 99;

    // Pilih stage berdasarkan waktu sejak abandon terakhir
    let stage = 1; // Default: Stage 1 (pesan pertama, FOMO)
    if (hoursSince >= 12) stage = 3;
    else if (hoursSince >= 3)  stage = 2;

    const productId = drip.product_id || lastAbandoned?.product_id || null;
    const name = user.first_name || 'Bos';
    let msg = '';
    let keyboard = null;
    let discVal = 0;

    const cbData = productId ? `buy_now_${productId}` : 'buy_bndl_ALL';


    if (stage === 1) {
      // Stage 1: FOMO + Social Proof — tunjukkan orang lain sudah masuk
      const recentBuyers = await Order.countDocuments({
        status: 'SUCCESS',
        created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      });
      const socialProof = recentBuyers > 0
        ? `\n\n<blockquote>Dalam 24 jam terakhir, ${recentBuyers} orang baru saja dapat aksesnya. Mereka sudah di dalam — kamu belum.</blockquote>`
        : `\n\n<blockquote>Slot VIP masih ada, tapi tidak selalu.</blockquote>`;
      msg = `🔑 <b>${name}, kamu hampir masuk tadi.</b>${socialProof}\n\n` +
            `QR-nya expired, tapi akses masih bisa kamu ambil sekarang — prosesnya cuma 30 detik.\n\n` +
            `👇 <b>Lanjutkan checkout:</b>`;
      keyboard = Markup.inlineKeyboard([[Markup.button.callback('💳 Lanjutkan Sekarang', cbData)]]);

    } else if (stage === 2) {
      discVal = 10;
      // Stage 2: Spesifik deadline dengan jam exact + diskon
      const expireAt = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const expireStr = expireAt.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
      const totalMembers = await Order.countDocuments({ status: 'SUCCESS' });
      msg = `⏰ <b>${name}, diskon 10% berlaku sampai jam ${expireStr} malam ini.</b>\n\n` +
            `${totalMembers}+ member sudah punya akses penuh. Kamu bisa jadi yang berikutnya hari ini.\n\n` +
            `<blockquote>Diskon ini dibuat khusus buat kamu — tidak akan muncul lagi setelah jam ${expireStr}.</blockquote>\n\n` +
            `👇 <b>Ambil sebelum expired:</b>`;
      keyboard = Markup.inlineKeyboard([[Markup.button.callback(`🔥 Pakai Diskon 10% (s/d ${expireStr})`, cbData)]]);

    } else if (stage === 3) {
      discVal = 15;
      // Stage 3: Loss aversion — apa yang konkret mereka lewatkan
      const weeklyContent = await Order.countDocuments({
        status: 'SUCCESS',
        created_at: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      });
      const totalMembers = await Order.countDocuments({ status: 'SUCCESS' });
      msg = `🚨 <b>${name.toUpperCase()}, ini kesempatan terakhir.</b>\n\n` +
            `Minggu ini ada ${weeklyContent} member baru masuk dan langsung dapat akses koleksi terbaru.\n` +
            `Total ${totalMembers}+ orang sudah di dalam. Kamu masih di luar.\n\n` +
            `<b>Diskon 15%</b> — diskon terbesar yang pernah kami kasih — hangus tengah malam ini.\n` +
            `Tidak ada diskon lagi setelah ini.\n\n` +
            `<blockquote>Sekali masuk, akses selamanya. Tidak ada biaya bulanan.</blockquote>\n\n` +
            `👇 <b>Ambil sekarang atau tidak sama sekali:</b>`;
      keyboard = Markup.inlineKeyboard([[Markup.button.callback(`⚡ Klaim 15% OFF — Terakhir`, cbData)]]);
    }

    if (user.opt_out) {
      discVal = 0;
      msg = `⚠️ <b>[REMINDER TAGIHAN]</b>\n\n` +
            `Hai ${name}, tagihan Anda untuk pesanan ini akan segera kadaluarsa.\n` +
            `Silakan selesaikan pembayaran Anda untuk mendapatkan akses.\n\n` +
            `👇 <b>Lanjutkan Pembayaran:</b>`;
      keyboard = Markup.inlineKeyboard([[Markup.button.callback('💳 Bayar Tagihan', cbData)]]);
    }

    if (discVal > 0) {
      const targetProdId = productId && productId !== 'BUNDLE' ? String(productId) : null;
      await Discount.findOneAndUpdate(
        { target_user_id: Number(user._id), target_product_id: targetProdId, trigger_event: 'CART_ABANDON', type: 'PERCENTAGE', active: true },
        { $set: { value: discVal, valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
        { upsert: true }
      );
    }

    const hType = await getSetting('header_type', 'url');
    const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');
    
    // [FIX BUG #2] Check global rate limit (max 3 messages/day)
    const canSend = await checkAndIncrementRateLimit(user._id);
    if (!canSend) {
      logger.info(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day, skipping CART_ABANDON campaign`);
      stats.skipped++;
      continue;
    }
    
    // [FIX CART-QUIET] Jika quiet hour (00-07), jangan skip total — queue untuk jam 07:00
    // Data log: 51 order expired, hanya 3 dapat follow-up. Banyak expire dini hari tapi di-skip.
    // Solusi: jika malam, tandai DripLog dengan scheduled_at=07:00 hari ini agar cron 07:00 pick up.
    if (isUserQuietHour(user)) {
      const jakartaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      const scheduleAt = new Date(jakartaNow);
      scheduleAt.setHours(7, 1, 0, 0); // 07:01 WIB
      if (scheduleAt <= jakartaNow) scheduleAt.setDate(scheduleAt.getDate() + 1); // besok jika sudah lewat
      await DripLog.findByIdAndUpdate(drip._id, { scheduled_at: scheduleAt });
      logger.info(`[CART_ABANDON] Quiet hour — dijadwalkan jam 07:01 untuk user ${user._id}`);
      stats.skipped++;
      continue;
    }
    
    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard, campaign: 'CART_ABANDON', userName: user.first_name || '?', reason: drip.product_id || 'cart_abandon' });
    if (result.ok) {
      // Update DripLog stage 0 → stage yang dikirim (bukan buat baru, cegah duplikat)
      await DripLog.findByIdAndUpdate(drip._id, {
        stage: stage,
        sent_at: new Date()
      });
      if (stage === 1) stats.sent1h++;
      if (stage === 2) stats.sent3h++;
      if (stage === 3) stats.sent12h++;
      // [FIX BUG#4] Update last_broadcast_at via native driver — bukan last_active_at!
      // Ini yang menyebabkan cooldown tidak bekerja untuk cart abandon campaign
      try {
        const db = User.db.db;
        await db.collection('users').updateOne({ _id: Number(user._id) }, { $set: { last_broadcast_at: new Date() } });
      } catch (_) {}
    } else {
      stats.skipped++;
    }
    await delay(1500);
  }
  return stats;
}

// ─── [UPGRADE 2] FLASH SALE OTOMATIS (MINGGU MALAM) ────────────────────────────
async function runFlashSaleCampaign(bot, allProducts) {
  const stats = { sent: 0, skipped: 0 };
  const now = new Date();
  
  if (now.getDay() !== 0 || now.getHours() < 20) return stats;

  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const progressKey = `FLASHSALE-${dateStr}`;
  const progress = await CronProgress.findOne({ date: progressKey }).lean();
  if (progress) return stats; 

  const users = await User.find({
    is_blocked: { $ne: true },
    opt_out: { $ne: true },
    $or: [
      { purchase_count: { $in: [0, null] } },
      { last_active_at: { $lt: new Date(now - 30 * 24 * 60 * 60 * 1000) } }
    ]
  }).lean();

  if (users.length === 0) return stats;

  // Create global flash sale discount
  await Discount.findOneAndUpdate(
    { target_user_id: null, target_product_id: null, type: "PERCENTAGE", active: true },
    { $setOnInsert: { max_uses: 20, used_count: 0 }, $set: { value: 20, valid_until: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59) } },
    { upsert: true }
  );

  // Flash Sale message — DNA J-SUB: subtitle + koleksi berkembang
  const totalBuyersFS = await User.countDocuments({ purchase_count: { $gt: 0 } }).catch(() => 0);
  const msg = `⚡ <b>FLASH SALE MALAM INI — 4 JAM SAJA</b>\n\n` +
              `Belum ada subtitle Indonesia untuk judul favorit kamu?\n` +
              `<b>Tim J-SUB yang kerjakan sendiri.</b>\n\n` +
              `Malam ini harga turun 20% — hanya untuk 20 pembeli pertama.\n` +
              `Sudah <b>${totalBuyersFS}+ member</b> yang akses koleksi subtitle eksklusif J-SUB.\n\n` +
              `Harga berlaku sampai jam 24:00:\n` +
              `• VIP JAV SUB INDO  : <s>Rp60.000</s> → <b>Rp48.000</b>\n` +
              `• VIP INDO VIRAL    : <s>Rp50.000</s> → <b>Rp40.000</b>\n` +
              `• VIP OME TV &amp; VCS  : <s>Rp50.000</s> → <b>Rp40.000</b>\n` +
              `• BUNDLE SEMUA      : <s>Rp410.000</s> → <b>Diskon 20%</b>\n\n` +
              `<blockquote>Semakin lama proyek berjalan, semakin banyak subtitle yang dikerjakan. Nilai membership terus bertambah. Harga opening tidak selamanya berlaku.</blockquote>\n\n` +
              `👇 <b>Ambil Slot Flash Sale Kamu:</b>`;
  const buttons = [
    [Markup.button.callback('🎁 BELI BUNDLE (Semua VIP)', 'buy_bndl_ALL')]
  ];
  for (const p of allProducts) {
    buttons.push([Markup.button.callback(`🔥 Beli ${p.name}`, `buy_now_${p._id}`)]);
  }
  const keyboard = Markup.inlineKeyboard(buttons);

  const hType = await getSetting('header_type', 'url');
  const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');

  for (const user of users) {
    if (isUserQuietHour(user)) { stats.skipped++; continue; }
    // [FIX H-1] Tambahkan isInCooldown check per-user di Flash Sale
    if (isInCooldown(user, { currentCampaign: 'FLASH_SALE' })) { stats.skipped++; continue; }
    const result = await sendSafe(bot, user._id, msg, { media: hFile, mediaType: hType, keyboard, campaign: 'FLASH_SALE', userName: user.first_name || '?', reason: 'flash_sale' });
    if (result.ok) {
      stats.sent++;
      await User.findByIdAndUpdate(user._id, { last_active_at: new Date() });
    } else {
      stats.skipped++;
    }
    await delay(1500);
  }

  // [FIX C-4] CronProgress dibuat SETELAH loop selesai
  // Sebelumnya: dibuat sebelum loop → crash di tengah = semua sisa user tidak dapat Flash Sale
  await CronProgress.create({ date: progressKey, campaign: 'COMPLETED', completed: true, created_at: new Date() }).catch(() => {});
  return stats;
}

// --- CACHE MODULE LEVEL UNTUK GLOBAL TOP PRODUCTS & SIMILARITY MAP ---
let cachedGlobalTopProducts = null;
let cachedSimilarityMap = null;
let lastGlobalTopProductsUpdate = 0;

async function runMarketingCampaign(bot, todayStr) {
  if (!marketingEnabled) {
    return { skipped: true, reason: 'Marketing dimatikan Admin' };
  }

  // PRE-COMPUTE N+1 QUERY ELIMINATION (TASK 1)
  const allProducts = await Product.find({ active: 1 }).lean();
  const now = Date.now();
  if (!cachedGlobalTopProducts || (now - lastGlobalTopProductsUpdate > 3600000)) {
    // 1. Global Top Products
    const globalTop = await OrderItem.aggregate([
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.status': 'SUCCESS' } },
      { $group: { _id: '$product_id', qty: { $sum: 1 } } },
      { $sort: { qty: -1 } }
    ]);
    const topProducts = [];
    for (const row of globalTop) {
      const prod = allProducts.find(p => String(p._id) === String(row._id));
      if (prod) topProducts.push(prod);
    }
    for (const p of allProducts) {
      if (!topProducts.find(t => String(t._id) === String(p._id))) topProducts.push(p);
    }
    cachedGlobalTopProducts = topProducts;

    // 2. Similarity Map (Collaborative Filtering: Product -> [Similar Products])
    // Pre-compute O(1) query: Ambil semua riwayat belanja user yang sukses, lalu buat matrix di memori
    const userPurchases = await OrderItem.aggregate([
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.status': 'SUCCESS' } },
      { $group: { _id: '$order.user_id', products: { $addToSet: '$product_id' } } }
    ]);

    const coMatrix = {};
    for (const user of userPurchases) {
      const prods = user.products;
      for (let i = 0; i < prods.length; i++) {
        for (let j = 0; j < prods.length; j++) {
          if (i !== j) {
            const pA = String(prods[i]);
            const pB = String(prods[j]);
            if (!coMatrix[pA]) coMatrix[pA] = {};
            coMatrix[pA][pB] = (coMatrix[pA][pB] || 0) + 1;
          }
        }
      }
    }

    const simMap = {};
    for (const pA in coMatrix) {
      // Ambil top 3 produk yang paling sering dibeli bersama pA
      const sorted = Object.entries(coMatrix[pA]).sort((a,b) => b[1] - a[1]).slice(0,3);
      simMap[pA] = sorted.map(s => s[0]);
    }
    
    // Ensure every active product at least has an empty array if no co-occurrence
    for (const p of allProducts) {
      if (!simMap[String(p._id)]) simMap[String(p._id)] = [];
    }
    
    cachedSimilarityMap = simMap;
    
    lastGlobalTopProductsUpdate = now;
  }
  const globalTopProducts = cachedGlobalTopProducts;
  const similarityMap = cachedSimilarityMap;

  // [FIX SPAM] Reset per-run Set agar tracking hanya berlaku dalam 1 run ini

  // [FIX #3] Cleanup diskon expired — jalan tiap jam, bukan hanya jam 03:00
  try {
    const cleanedDisc = await Discount.updateMany(
      { active: true, valid_until: { $lt: new Date() } },
      { $set: { active: false } }
    );
    if (cleanedDisc.modifiedCount > 0)
      console.log(`[CLEANUP] ✅ ${cleanedDisc.modifiedCount} diskon expired dinonaktifkan.`);
  } catch (e) { console.error('[CLEANUP] Gagal cleanup diskon:', e.message); }

  // [BUGFIX W5] Gunakan date-only key (bukan jam) agar completed state survive seluruh hari
  // Sebelumnya: key per jam "2026-08-14-09" → setiap jam buat record baru → completed tidak pernah tersimpan
  // Sekarang: key per hari "2026-08-14" → state persist sampai tengah malam
  const jakartaDate = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Jakarta'}));
  const dateOnlyStr = todayStr || `${jakartaDate.getFullYear()}-${String(jakartaDate.getMonth()+1).padStart(2,'0')}-${String(jakartaDate.getDate()).padStart(2,'0')}`;
  let progress = await CronProgress.findOneAndUpdate(
    { date: dateOnlyStr },
    { $setOnInsert: { date: dateOnlyStr, campaign: 'START', completed: false, created_at: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );

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
  let cartAbandonStats = { sent1h: 0, sent3h: 0, sent12h: 0, skipped: 0 };
  let flashSaleStats = { sent: 0, skipped: 0 };

  // Jika sudah COMPLETED hari ini — skip, jangan kirim dobel
  if (progress.campaign === 'COMPLETED' && progress.completed === true) {
    const hourNow = jakartaDate.getHours();
    // Reset di tengah malam (jam 0) untuk hari baru
    if (hourNow === 0) {
      await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'START', completed: false });
      progress.campaign = 'START';
    } else {
      // Sudah selesai hari ini — Drip tetap jalan tiap jam, campaign utama skip
      console.log('[CRON] Campaign utama sudah selesai hari ini. Menjalankan recurring hourly campaigns...');
      // URUTAN PRIORITAS TASK 2: Cart Abandon > Post-Purchase > Drip
      await runCartAbandonCampaign(bot);  // [UPGRADE 1] Cart abandon jalan tiap jam (Prioritas 1)
      await runPostPurchaseFollowUp(bot); // [W9] Post-purchase jalan tiap jam (Prioritas 2)
      // [FIX BUG #9] DRIP moved to separate cron at :45 minutes (Prioritas 3)
      return { skipped: false, drip_only: true };
    }
  }

  if (progress.campaign === 'START') {
    // URUTAN PRIORITAS TASK 2: Cart Abandon > Post-Purchase
    // [FIX BUG #9] DRIP moved to separate cron at :45 minutes
    console.log('[MARKETING] Campaign 5: Cart Abandon Hyper-Recovery...');
    cartAbandonStats = await runCartAbandonCampaign(bot); // Prioritas 1
    console.log('[MARKETING] Campaign 4: Post-Purchase Follow-Up...');
    await runPostPurchaseFollowUp(bot);                   // Prioritas 2
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'DRIP_DONE' });
    progress.campaign = 'DRIP_DONE';
  }

  if (progress.campaign === 'DRIP_DONE') {
    console.log('[MARKETING] Campaign 1: Non-Buyer...');
    nonBuyerStats = await runNonBuyerCampaign(bot);
    
    // [FIX BUG#1] Hanya advance jika benar-benar kirim pesan (bukan hanya skipped)
    // Sebelumnya: reduce() ikut hitung skipped → COMPLETED jam 00:00 → campaign mati seharian
    const actuallySent = (nonBuyerStats.cold || 0) + (nonBuyerStats.abandon || 0) + (nonBuyerStats.inactive || 0);
    if (isPeakHour || actuallySent > 0) {
      await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'NON_BUYER_DONE' });
      progress.campaign = 'NON_BUYER_DONE';
    }
  }

  // [FIX BUG #9] VIP Win-back, Cross-sell, and DRIP extracted to separate cron schedules
  // VIP Win-back: runs at :30 minutes (separate cron)
  // Cross-sell: runs at :15 minutes (separate cron)
  // DRIP: runs at :45 minutes (separate cron)
  // [FIX BUG#2] Flash Sale dipindah ke cron terpisah jam 20:00 WIB hari Minggu
  // Sebelumnya: dipanggil setelah NON_BUYER_DONE (jam 00:00) → jam check < 20 selalu true → dead code
  if (progress.campaign === 'NON_BUYER_DONE') {
    await CronProgress.findByIdAndUpdate(progress._id, { campaign: 'COMPLETED', completed: true });
  }

  const combined = {
    cold: nonBuyerStats.cold,
    abandon: nonBuyerStats.abandon,
    inactive: nonBuyerStats.inactive,
    crossSell: 0,  // [FIX BUG #9] Moved to separate cron at :15 minutes
    complete: 0,   // [FIX BUG #9] Moved to separate cron at :15 minutes
    stage2: 0,     // [FIX BUG #9] DRIP moved to separate cron at :45 minutes
    stage3: 0,     // [FIX BUG #9] DRIP moved to separate cron at :45 minutes
    stage4: 0,     // [FIX BUG #9] DRIP moved to separate cron at :45 minutes
    vipWinBack: 0, // [FIX BUG #9] Moved to separate cron at :30 minutes
    cartAbandon1h: cartAbandonStats.sent1h,
    cartAbandon3h: cartAbandonStats.sent3h,
    cartAbandon12h: cartAbandonStats.sent12h,
    flashSaleSent: flashSaleStats.sent,
    skipped: nonBuyerStats.skipped + cartAbandonStats.skipped + flashSaleStats.skipped,
    failed: nonBuyerStats.failed
  };

  // [REMOVED] User.deleteMany dihapus — berbahaya, menghapus user permanen dari DB
  // Blocked user cukup di-skip saat campaign, tidak perlu dihapus

  return combined;
}

// Fungsi helper delay (agar tidak spam rate limit)
const delay = ms => new Promise(r => setTimeout(r, ms));

// Fungsi publik untuk tes marketing output
async function sendTestMarketing(bot, userId, type) {
  const hType = await getSetting("header_type", "url");
  const hFile = await getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");
  
  const allProducts = await Product.find({ active: 1 }).lean();
  // [FIX BUG#4] Sebelumnya selalu allProducts[0] = selalu produk pertama di DB (VIP JAV SUB INDO)
  // sehingga tombol preview selalu salah produk. Sekarang gunakan produk TERPOPULER.
  let defaultProduct = null;
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
  if (!defaultProduct) defaultProduct = { _id: 'dummy', name: 'Produk Contoh', price: 50000 };

  // Fake userId untuk test
  const testUserId = userId || process.env.ADMIN_CHAT_ID;
  let keyboard = await buildProductMarkup(testUserId, defaultProduct);

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
    keyboard = await buildProductMarkup(mockUser._id, defaultProduct, discountAmount);
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
  const ninetyDaysAgo   = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // [FIX W10] diperlebar dari 60 → 90 hari

  // [FIX W10] Perlebar criteria:
  // Sebelumnya: total_spent>100k ATAU purchase_count>=5 (terlalu ketat → 9 dormant buyer tidak terjangkau)
  // Sekarang: semua buyer (purchase_count>=1) yang tidak aktif 14-90 hari
  const vips = await User.find({
    purchase_count: { $gte: 1 },
    last_active_at: { $lte: fourteenDaysAgo, $gte: ninetyDaysAgo },
    is_blocked: { $ne: true }
  }).lean();

  for (const user of vips) {
    // [FIX BUG #4] Use correct campaign name for VIP_WINBACK cooldown check
    if (isUserQuietHour(user) || isInCooldown(user, { currentCampaign: 'VIP_WINBACK' })) continue;
    
    // [FIX BUG #3] Acquire distributed lock to prevent race conditions
    const gotLock = await acquireCampaignLock(user._id, 'VIP_WINBACK');
    if (!gotLock) {
      logger.info(`[LOCK] User ${user._id} locked by another campaign, skipping VIP_WINBACK campaign`);
      continue;
    }
    
    // [FIX BUG #2] Check global rate limit (max 3 messages/day)
    const canSend = await checkAndIncrementRateLimit(user._id);
    if (!canSend) {
      logger.info(`[RATE_LIMIT] User ${user._id} exceeded 3 messages/day, skipping VIP_WINBACK campaign`);
      continue;
    }
    
    // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
    if (await isUserInCheckout(user._id)) {
      logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping VIP_WINBACK to avoid payment flow interruption`);
      continue;
    }
    
    // [FIX BUG#3] VIP Winback: tambah keyboard tombol beli + diskon 20% + label benar
    // Sebelumnya: pesan tanpa tombol beli, tanpa diskon, label 'BROADCAST_MANUAL'
    // Buyer lama dapat pesan kosong setiap 48 jam tanpa bisa checkout
    const winbackDisc = 20;
    await Discount.findOneAndUpdate(
      { target_user_id: Number(user._id), active: true },
      { $setOnInsert: { target_user_id: Number(user._id), value: winbackDisc, active: true,
          valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000), created_at: new Date() } },
      { upsert: true }
    ).catch(() => {});

    const allProds = await Product.find({ active: 1 }).lean();
    const boughtWinback = await getBoughtProductIds(user._id);
    const unboughtWinback = allProds.filter(p => !boughtWinback.includes(String(p._id)));
    const winbackKeyboard = unboughtWinback.length > 0
      ? Markup.inlineKeyboard(unboughtWinback.slice(0, 3).map(p =>
          [Markup.button.callback(`🛒 ${p.name} — Hemat ${winbackDisc}%`, `buy_${p._id}`)]))
      : null;

    const msg =
      `🎁 <b>Halo ${user.first_name || 'VIP'}, kami kangen kamu!</b>\n\n` +
      `Sebagai member setia, kami siapkan <b>diskon ${winbackDisc}% eksklusif</b> khusus untuk kamu.\n\n` +
      `Koleksi sudah bertambah sejak terakhir kamu mampir — ada ${allProds.length} produk aktif sekarang.\n\n` +
      `<blockquote>Diskon ${winbackDisc}% ini hanya berlaku 48 jam. Tidak perlu kode apapun — otomatis terpotong saat checkout.</blockquote>\n\n` +
      `👇 <b>Pilih produk dan langsung dapatkan harga spesial:</b>`;
    const result = await sendSafe(bot, user._id, msg, {
      campaign: 'VIP_WINBACK',
      userName: user.first_name || '?',
      ...(winbackKeyboard ? { keyboard: winbackKeyboard } : {})
    });
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

let isMarketingRunning = false;
// [FIX DOUBLE-SEND] In-memory debounce untuk triggerRealtimeMarketing
// Mencegah double-trigger dari message + callback_query handler bersamaan
const rtInFlight = new Set();

function startCron(bot) {
  // Bersihkan semua task lama (anti-duplikasi)
  cronTasks.forEach(t => t.destroy());
  cronTasks = [];

  // ── TASK 1: Marketing Campaign — Setiap hari jam 10:00 WIB ─────────────────
  // [FIX BUG#1] Dikembalikan menjadi '0 * * * *' (setiap jam) agar Cart Abandon
  // bisa berjalan sesuai stage 1 jam dan 3 jam.
  // SPAM malam hari ditangani secara individual melalui fungsi isUserQuietHour().
  const marketingTask = cron.schedule('0 * * * *', async () => {
    if (!marketingEnabled) return;
    if (isMarketingRunning) {
      console.log(`[CRON] ⚠️ Skip: Marketing campaign sebelumnya belum selesai (kemungkinan tertunda Queue limit).`);
      return;
    }
    isMarketingRunning = true;

    const now = new Date();
    const jakartaDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    // [FIX C-1] Gunakan date-only key (bukan jam) agar CronProgress survive seharian
    // Sebelumnya: "2026-09-12-09" → tiap jam buat record baru → guard tidak pernah aktif
    // Sekarang:   "2026-09-12" → 1 record per hari, campaign utama tidak diulang
    const todayDateStr = `${jakartaDate.getFullYear()}-${String(jakartaDate.getMonth()+1).padStart(2,'0')}-${String(jakartaDate.getDate()).padStart(2,'0')}`;
    console.log(`[CRON] ⏰ Menjalankan Marketing Automations (${now.toISOString()})...`);
    try {
      const stats = await runMarketingCampaign(bot, todayDateStr);
      console.log('[CRON] ✅ Marketing selesai. Stats:', JSON.stringify(stats));
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan marketing:', err.message);
    } finally {
      isMarketingRunning = false;
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 1.1: CROSS_SELL Campaign — Jam 10-20 WIB setiap :15 menit ─────────
  // [FIX BUG #9] Stagger campaign schedules to reduce race conditions
  // CROSS_SELL runs at :15 minutes (15-minute gap from NON_BUYER at :00)
  const crossSellTask = cron.schedule('15 10-20 * * *', async () => {
    if (!marketingEnabled) return;
    console.log(`[CRON] ⏰ Menjalankan CROSS_SELL Campaign...`);
    try {
      // Pre-compute necessary context for CROSS_SELL
      const allProducts = await Product.find({ active: 1 }).lean();
      const now = Date.now();
      
      // Use cached data if available and fresh (< 1 hour old)
      if (!cachedGlobalTopProducts || (now - lastGlobalTopProductsUpdate > 3600000)) {
        console.log('[CROSS_SELL] Computing fresh product recommendations...');
        
        // 1. Global Top Products
        const globalTop = await OrderItem.aggregate([
          { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
          { $unwind: '$order' },
          { $match: { 'order.status': 'SUCCESS' } },
          { $group: { _id: '$product_id', qty: { $sum: 1 } } },
          { $sort: { qty: -1 } }
        ]);
        const topProducts = [];
        for (const row of globalTop) {
          const prod = allProducts.find(p => String(p._id) === String(row._id));
          if (prod) topProducts.push(prod);
        }
        for (const p of allProducts) {
          if (!topProducts.find(t => String(t._id) === String(p._id))) topProducts.push(p);
        }
        cachedGlobalTopProducts = topProducts;

        // 2. Similarity Map (Collaborative Filtering)
        const userPurchases = await OrderItem.aggregate([
          { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
          { $unwind: '$order' },
          { $match: { 'order.status': 'SUCCESS' } },
          { $group: { _id: '$order.user_id', products: { $addToSet: '$product_id' } } }
        ]);

        const coMatrix = {};
        for (const user of userPurchases) {
          const prods = user.products;
          for (let i = 0; i < prods.length; i++) {
            for (let j = 0; j < prods.length; j++) {
              if (i !== j) {
                const pA = String(prods[i]);
                const pB = String(prods[j]);
                if (!coMatrix[pA]) coMatrix[pA] = {};
                coMatrix[pA][pB] = (coMatrix[pA][pB] || 0) + 1;
              }
            }
          }
        }

        const simMap = {};
        for (const pA in coMatrix) {
          const sorted = Object.entries(coMatrix[pA]).sort((a,b) => b[1] - a[1]).slice(0,3);
          simMap[pA] = sorted.map(s => s[0]);
        }
        
        for (const p of allProducts) {
          if (!simMap[String(p._id)]) simMap[String(p._id)] = [];
        }
        
        cachedSimilarityMap = simMap;
        lastGlobalTopProductsUpdate = now;
      }
      
      const crossSellStats = await runCrossSellCampaign(bot, allProducts, cachedGlobalTopProducts, cachedSimilarityMap);
      console.log('[CRON] ✅ CROSS_SELL selesai. Stats:', JSON.stringify(crossSellStats));
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan CROSS_SELL:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 1.2: VIP_WINBACK Campaign — Jam 10-20 WIB setiap :30 menit ─────────
  // [FIX BUG #9] Stagger campaign schedules to reduce race conditions
  // VIP_WINBACK runs at :30 minutes (30-minute gap from NON_BUYER at :00, 15-minute gap from CROSS_SELL)
  const vipWinbackTask = cron.schedule('30 10-20 * * *', async () => {
    if (!marketingEnabled) return;
    console.log(`[CRON] ⏰ Menjalankan VIP_WINBACK Campaign...`);
    try {
      const vipCount = await runVIPWinBackCampaign(bot);
      console.log('[CRON] ✅ VIP_WINBACK selesai. Count:', vipCount);
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan VIP_WINBACK:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 1.3: DRIP Campaign — Jam 10-20 WIB setiap :45 menit ─────────
  // [FIX BUG #9] Stagger campaign schedules to reduce race conditions
  // DRIP runs at :45 minutes (45-minute gap from NON_BUYER at :00, 30-minute gap from CROSS_SELL, 15-minute gap from VIP_WINBACK)
  const dripTask = cron.schedule('45 10-20 * * *', async () => {
    if (!marketingEnabled) return;
    console.log(`[CRON] ⏰ Menjalankan DRIP Follow-Up Campaign (Stage 2, 3, 4)...`);
    try {
      const dripStats = await runDripFollowUp(bot);
      console.log('[CRON] ✅ DRIP selesai. Stats:', JSON.stringify(dripStats));
    } catch (err) {
      console.error('[CRON] ❌ Gagal menjalankan DRIP:', err.message);
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

  // ── TASK 3: Cleanup DripLogs & Expired Discounts — Setiap hari jam 03:00 WIB ───────────
  const cleanupTask = cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] ⏰ Menjalankan cleanup DripLogs dan Diskon...');
    await cleanupConvertedDripLogs();
    
    // Deactivate expired discounts to prevent DB bloat
    try {
      const result = await Discount.updateMany(
        { active: true, valid_until: { $lt: new Date() } },
        { $set: { active: false } }
      );
      if (result.modifiedCount > 0) {
        console.log(`[CLEANUP] Dinonaktifkan ${result.modifiedCount} diskon kedaluwarsa.`);
      }
    } catch (err) {
      console.error('[CLEANUP] Gagal menonaktifkan diskon kedaluwarsa:', err.message);
    }
    
    // [FIX BUG #5] Delete expired inactive discounts to prevent database bloat
    // This runs after deactivation to ensure expired discounts are marked inactive first
    try {
      const deleteResult = await Discount.deleteMany({
        valid_until: { $lt: new Date() },
        active: false
      });
      if (deleteResult.deletedCount > 0) {
        console.log(`[CLEANUP] Dihapus ${deleteResult.deletedCount} diskon kedaluwarsa yang tidak aktif.`);
      }
    } catch (err) {
      console.error('[CLEANUP] Gagal menghapus diskon kedaluwarsa:', err.message);
    }
    
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
        if (!disc.target_user_id) continue; // Diskon global, skip
        const user = await User.findById(disc.target_user_id).lean();
        if (!user || user.is_blocked) continue;

        // [FIX] Tampilkan SEMUA produk yang belum dibeli user, bukan hanya 1 produk
        const allProductsForReminder = await Product.find({ active: 1 }).lean();
        const { keyboard, products: unboughtProducts } = await buildAllProductsKeyboard(
          disc.target_user_id, allProductsForReminder, disc.value
        );
        if (!keyboard || unboughtProducts.length === 0) continue;

        const expiryTime = disc.valid_until
          ? new Date(disc.valid_until).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
          : '?';

        // Buat ringkasan harga semua produk yang bisa dibeli dengan diskon ini
        const productLines = unboughtProducts.map(p => {
          const discAmt = Math.floor(p.price * disc.value / 100);
          const finalP = p.price - discAmt;
          return `• ${p.name}: Rp${p.price.toLocaleString('id-ID')} ➤ <b>Rp${finalP.toLocaleString('id-ID')}</b>`;
        }).join('\n');

        const reminderMsg = `⏰ <b>DISKON ${disc.value}% HANGUS JAM ${expiryTime} WIB!</b>\n\n` +
          `Bos, kupon diskon spesial Anda akan segera kedaluwarsa.\n\n` +
          `<b>Produk yang bisa kamu ambil sekarang:</b>\n${productLines}\n\n` +
          `➟ Klik tombol di bawah <b>sebelum hangus!</b>`;

        const firstUnbought = unboughtProducts[0];
        const remMediaArr = firstUnbought?.promo_media?.length > 1 ? firstUnbought.promo_media : null;
        const reminderPromoImg = firstUnbought?.promo_image_id || hFile;
        const reminderPromoType = firstUnbought?.promo_image_id ? (firstUnbought.promo_media_type || 'photo') : hType;
        const remSendOpts = remMediaArr
          ? { mediaGroup: remMediaArr, keyboard }
          : { media: reminderPromoImg, mediaType: reminderPromoType, keyboard };

        await sendSafe(bot, disc.target_user_id, reminderMsg, remSendOpts);


        await delay(1500);
      }

      console.log('[CRON] ✅ Reminder diskon terkirim ke', expiringDiscounts.length, 'user.');
    } catch (err) {
      console.error('[CRON] ❌ Gagal kirim reminder diskon:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

  // ── TASK 6: Auto-Close Order Macet — Setiap hari jam 04:00 WIB ──────────────
  // [FIX BUG#2] Flash Sale sekarang jalan via cron terpisah jam 20:00 WIB hari Minggu
  // Sebelumnya: dipanggil di dalam NON_BUYER_DONE (jam 00:00) → jam < 20 → dead code seumur hidup
  const flashSaleTask = cron.schedule('0 20 * * 0', async () => {
    console.log('[CRON] ⚡ Flash Sale Minggu Malam mulai...');
    try {
      const allProducts = await Product.find({ active: 1 }).lean();
      const result = await runFlashSaleCampaign(bot, allProducts);
      console.log(`[CRON] ✅ Flash Sale selesai: sent=${result.sent} skipped=${result.skipped}`);
    } catch (err) {
      console.error('[CRON] ❌ Flash Sale error:', err.message);
    }
  }, { timezone: 'Asia/Jakarta' });

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

  cronTasks = [marketingTask, crossSellTask, vipWinbackTask, dripTask, backupTask, cleanupTask, metricsTask, discountReminderTask, flashSaleTask, stuckOrderTask];
  
  // [FIX BUG#8] Startup run: hanya jalankan drip + cart-abandon saat restart
  // BUKAN runMarketingCampaign penuh — karena itu bisa kirim campaign utama berkali-kali
  // jika container sering restart (misal: Coolify redeploy). Jika campaign utama
  // sudah COMPLETED hari ini, guard di runMarketingCampaign sudah mencegahnya.
  // Tapi jika terjadi restart tepat di saat campaign belum selesai = dobel kirim!
  // Solusi: startup hanya jalankan sub-tugas yang aman di-run berulang (drip + cart).
  console.log('[CRON] 🚀 Marketing Scheduler (node-cron) started. Dijadwalkan jam 10:00 WIB setiap hari.');
  console.log('[CRON] Startup: hanya drip follow-up & cart abandon (bukan campaign utama).');

  // [FIX 409-LOOP] Debounce startup drip: jangan jalankan jika ada flag startup terbaru
  // Saat 409 loop terjadi, bot restart puluhan kali dalam beberapa menit
  // → runDripFollowUp jalan puluhan kali → recycle Stage 4 berulang → spam ke user!
  // Solusi: tandai timestamp startup. Jika startup terlalu sering (< 5 menit), skip drip.
  const now = Date.now();
  const STARTUP_DEBOUNCE_MS = 5 * 60 * 1000; // 5 menit
  if (global._lastStartupDrip && (now - global._lastStartupDrip) < STARTUP_DEBOUNCE_MS) {
    const secsAgo = Math.floor((now - global._lastStartupDrip) / 1000);
    console.log(`[CRON] ⏭️  Startup drip diskip — restart terlalu cepat (${secsAgo}s lalu). Tunggu 5 menit antar restart.`);
  } else {
    global._lastStartupDrip = now;
    Promise.all([
      runCartAbandonCampaign(bot),
      runPostPurchaseFollowUp(bot),
      runDripFollowUp(bot)
    ])
      .then(() => console.log('[CRON] ✅ Startup drip selesai.'))
      .catch(err => console.error('[CRON] ❌ Startup drip gagal:', err.message));
  }
}


function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }
function stopDailyCron() {
  cronTasks.forEach(t => t.destroy());
  cronTasks = [];
  console.log('[CRON] All scheduled tasks stopped.');
}

// ─── REALTIME TRIGGER MARKETING ─────────────────────────────────────────────
// Dipanggil setiap kali user aktif (buka bot, klik tombol, kirim pesan).
// Ini menggantikan pendekatan "kirim ke semua jam 10:00" dengan pendekatan
// "kirim ke user SAAT user itu sedang aktif" → diskon tepat sasaran & timing pas.

async function triggerRealtimeMarketing(bot, userId) {
  try {
    if (!isMarketingEnabled()) return;

    // [GUARD 1] In-memory debounce — cegah double trigger dari message + callback_query
    // Masalah: Pppppp dapat 2x dalam 2 menit (07:27 + 07:28) karena kedua handler
    // (bot.on('message') DAN bot.on('callback_query')) sama-sama setTimeout 5 detik.
    // Atomic DB tidak cukup karena kedua setTimeout jalan bersamaan sebelum DB update.
    // Fix: Set in-flight per userId, clear setelah 10 detik.
    const rtKey = `rt_${userId}`;
    if (rtInFlight.has(rtKey)) return; // Sudah ada yang jalan untuk user ini
    rtInFlight.add(rtKey);
    setTimeout(() => rtInFlight.delete(rtKey), 10000); // clear setelah 10 detik

    // 1. Ambil data user
    const user = await User.findById(userId).lean();
    if (!user || user.is_blocked || user.opt_out) return;

    // [FIX RT-QUIET] Block RT Marketing jam 00:00-06:59 WIB
    // Data log: 1.772 pesan dikirim jam 00-06 → 0 konversi. Hanya ganggu user.
    // isUserQuietHour() sudah ada tapi tidak dipanggil di RT Marketing path.
    if (isUserQuietHour(user)) {
      logger.info(`[RT-MARKETING] Quiet hour (00-07 WIB), skipping user ${userId}`);
      return;
    }

    // [FIX RACE CONDITION] RT Marketing double-send karena race condition:
    // Masalah: findById() → cek cooldown → kirim → update last_rt_sent_at
    // Jika 3 event datang bersamaan, semua baca last_rt_sent_at = null → semua kirim!
    // Bukti log: elrey dapat 3 pesan RT_HOT dalam 30 detik (20:34:46, 20:35:11, 20:35:16)
    // Fix: atomic findOneAndUpdate sekaligus jadi "claim" slot kirim.
    // Hanya 1 yang berhasil claim (dokumen berubah) — sisanya return karena sudah claimed.
    const RT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 jam
    const claimCutoff = new Date(Date.now() - RT_COOLDOWN_MS);
    const claimed = await User.findOneAndUpdate(
      {
        _id: userId,
        is_blocked: { $ne: true },
        opt_out:    { $ne: true },
        $or: [
          { last_rt_sent_at: null },
          { last_rt_sent_at: { $exists: false } },
          { last_rt_sent_at: { $lt: claimCutoff } }
        ]
      },
      { $set: { last_rt_sent_at: new Date() } },
      { new: false } // return dokumen LAMA (untuk ambil data user)
    ).lean();

    if (!claimed) {
      // User tidak ditemukan, blocked, opt-out, atau masih dalam cooldown 6 jam
      return;
    }

    // Update referensi user dengan data terbaru dari claimed
    Object.assign(user, claimed);

    // [FIX BUG #1, #16] Capture historical last_active_at BEFORE any updates
    // This timestamp was set during the user's PREVIOUS activity, not the current message
    // Using it ensures correct segment classification (HOT/WARM/COLD/GHOST)
    const historicalLastActive = user.last_active_at;

    // [FIX BUG #11] Check if user is in active checkout (has PENDING order)
    if (await isUserInCheckout(user._id)) {
      logger.info(`[CHECKOUT] User ${user._id} has pending order, skipping REALTIME to avoid payment flow interruption`);
      return; // Exit early for realtime trigger
    }

    // 2. [FIX] Hapus pengecekan Order disini agar buyer tetap dapat marketing untuk
    // produk-produk SISA yang belum dibeli. (Difilter di buildAllProductsKeyboard)

    // 3. TIDAK pakai isInCooldown() global 48 jam — RT punya cooldown sendiri di atas (6 jam)
    // isInCooldown() global hanya untuk campaign besar (jam 10, drip, dll)
    // if (isInCooldown(user)) return; // ← DIHAPUS, diganti RT cooldown 6 jam di atas

    // 4. Klasifikasi segment berdasarkan last_active_at
    // [FIX BUG #1] Use historical timestamp for classification
    const segment = await classifyNonBuyer({ ...user, last_active_at: historicalLastActive });

    // 5. Tentukan diskon berdasarkan segment
    // [FIX] Naikkan semua nilai — 5% terlalu kecil (Rp2.600 dari Rp52rb tidak memotivasi)
    // Data: 8 diskon dipakai semua 5%, tapi conversion rate masih rendah
    // Strategi: makin lama tidak aktif, makin besar diskon (urgency lebih kuat)
    let discountVal = 0;
    if      (segment === 'HOT')   discountVal = 15;  // Aktif tadi → butuh nudge kecil
    else if (segment === 'WARM')  discountVal = 20;  // Beberapa hari lalu → perlu lebih
    else if (segment === 'COLD')  discountVal = 25;  // Seminggu lalu → perlu tawaran kuat
    else if (segment === 'GHOST') discountVal = 30;  // Lama tidak aktif → last chance offer

    // 6. Ambil produk aktif & build keyboard
    const allProducts = await Product.find({ active: 1 }).lean();
    if (!allProducts.length) return;

    const { keyboard, products: unboughtProducts } = await buildAllProductsKeyboard(userId, allProducts, discountVal);
    if (!keyboard || !unboughtProducts.length) return; // User sudah beli semua produk

    // 7. Buat/update diskon di DB (trigger_event='REALTIME' — sekarang dikenali applyAutomaticDiscount)
    if (discountVal > 0) {
      const existingDisc = await Discount.findOne({
        target_user_id: Number(userId),
        active: true,
        valid_until: { $gt: new Date() }
      }).lean();
      if (!existingDisc) {
        // [FIX] valid_until 48 jam — user yang balik besok tetap dapat diskon
        await Discount.findOneAndUpdate(
          { target_user_id: Number(userId), target_product_id: null, trigger_event: 'REALTIME', type: 'PERCENTAGE', active: true },
          { $set: { value: discountVal, valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000) } },
          { upsert: true }
        );
      }
    }

    // 8. Buat pesan berdasarkan segment — ringkas, personal, langsung ke point
    const name = user.first_name || 'Bos';
    const p = unboughtProducts[0];
    const totalBuyers = (await Order.distinct('user_id', { status: 'SUCCESS' })).length;
    let msg;

    if (segment === 'HOT') {
      msg = `👋 <b>${name}!</b>\n\n` +
            `Ada <b>${totalBuyers}+ member</b> yang sudah di dalam.\n\n` +
            `Hari ini kamu dapat <b>diskon ${discountVal}%</b> — tinggal klik tombol di bawah.\n\n` +
            `<blockquote>Diskon berlaku 24 jam dari sekarang.</blockquote>`;
    } else if (segment === 'WARM') {
      msg = `🔔 <b>${name}, ada penawaran buat kamu!</b>\n\n` +
            `Kamu belum sempat gabung — kami kasih <b>diskon ${discountVal}%</b> hari ini.\n\n` +
            `Sudah <b>${totalBuyers}+ member</b> yang aktif.\n\n` +
            `<blockquote>Diskon berlaku 24 jam — tidak bisa diperpanjang.</blockquote>`;
    } else if (segment === 'COLD') {
      msg = `🎁 <b>Selamat datang kembali, ${name}!</b>\n\n` +
            `Sudah lama tidak mampir — ada <b>diskon ${discountVal}%</b> khusus buat kamu.\n\n` +
            `<blockquote>Penawaran ini hanya berlaku 24 jam dari sekarang.</blockquote>`;
    } else { // GHOST
      msg = `🎁 <b>${name}, masih ingat kami?</b>\n\n` +
            `Kami siapkan <b>diskon ${discountVal}%</b> — penawaran terbesar yang pernah kami kasih.\n\n` +
            `<blockquote>Ini penawaran terakhir — berlaku 24 jam saja.</blockquote>`;
    }

    // 9. [FIX BUG #2] Check global rate limit (max 3 messages/day)
    const canSend = await checkAndIncrementRateLimit(userId);
    if (!canSend) {
      logger.info(`[RATE_LIMIT] User ${userId} exceeded 3 messages/day, skipping REALTIME`);
      return;
    }

    // 10. Kirim via sendSafe (sudah handle blocked, cooldown, logging)
    const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');
    const hType = await getSetting('header_type', 'url');
    
    // [FIX ROTASI RT] Pilih produk hero berdasarkan broadcastCount — berganti tiap pesan
    // Sebelumnya: unboughtProducts[0] → selalu produk pertama (sama terus)
    const rtUserIdNum = typeof userId === 'object' ? parseInt(String(userId).slice(-6), 16) : Number(userId);
    const rtBroadcastCount = user.daily_message_count || 0;
    const rtRotationIndex = (rtUserIdNum + rtBroadcastCount) % (unboughtProducts.length || 1);
    const firstProd = unboughtProducts[rtRotationIndex] || unboughtProducts[0];
    const media = firstProd?.promo_image_id || hFile;
    const mediaType = firstProd?.promo_image_id ? (firstProd.promo_media_type || 'photo') : hType;
    logger.info(`[RT-ROTASI] userId=${userId} rotasi=${rtRotationIndex}/${unboughtProducts.length} → hero: ${firstProd?.name || '-'}`);

    const result = await sendSafe(bot, userId, msg, {
      media,
      mediaType,
      keyboard,
      campaign: `RT_${segment}`, // RT = RealTime, beda dari cron campaign
      userName: name,
      reason: unboughtProducts.map(p => p.name).join(', ')
    });

    if (result.ok) {
      logger.info(`[RT-MARKETING] Terkirim ke ${userId} (${name}) segment=${segment} diskon=${discountVal}%`);
      // [FIX RT-COOLDOWN] Simpan timestamp RT terakhir — terpisah dari last_broadcast_at (campaign besar)
      // last_broadcast_at tetap di-update oleh sendSafe() untuk rate limit harian
      // last_rt_sent_at dipakai khusus untuk cooldown 6 jam RT Marketing
      await User.findByIdAndUpdate(userId, { $set: { last_rt_sent_at: new Date() } }).catch(() => {});

      // [SESSION] Mulai sesi & jadwalkan follow-up touchpoints
      // T+5min, T+15min, T+30min — hanya dikirim jika user masih aktif & belum checkout
      scheduleSessionFollowups(bot, userId);
    }

  } catch (err) {
    // Silent fail — jangan sampai crash user experience karena marketing
    logger.warn(`[RT-MARKETING] Error untuk userId=${userId}: ${err.message}`);
  }
}

// ─── SESSION FOLLOW-UP ────────────────────────────────────────────────────────
// Jadwalkan 3 touchpoint setelah RT Marketing pertama berhasil dikirim.
// Setiap touchpoint cek: user masih aktif? belum checkout? rate limit OK?
// Konten berbeda tiap touchpoint agar tidak terasa spam.

const FOLLOWUP_DELAYS = [
  5  * 60 * 1000,  // T+5 menit  → guide produk
  15 * 60 * 1000,  // T+15 menit → FOMO / social proof
  30 * 60 * 1000,  // T+30 menit → last offer
];

function scheduleSessionFollowups(bot, userId) {
  updateSessionActivity(userId);
  const session = getSession(userId);
  if (!session) return;

  FOLLOWUP_DELAYS.forEach((delay, idx) => {
    const t = setTimeout(async () => {
      try {
        await sendSessionFollowup(bot, userId, idx + 1);
      } catch (e) {
        logger.warn(`[SESSION-FU] Error touchpoint ${idx+1} untuk ${userId}: ${e.message}`);
      }
    }, delay);
    session.timers.push(t);
  });

  logger.info(`[SESSION] Sesi dimulai untuk ${userId} — 3 follow-up dijadwalkan (T+5, T+15, T+30 menit)`);
}

async function sendSessionFollowup(bot, userId, touchpoint) {
  // ── Guard checks ──────────────────────────────────────────────────────────
  if (!isMarketingEnabled()) return;
  if (!isSessionStillActive(userId)) {
    logger.info(`[SESSION-FU] User ${userId} tidak aktif lagi, batal touchpoint ${touchpoint}`);
    endSession(userId);
    return;
  }

  const user = await User.findById(userId).lean();
  if (!user || user.is_blocked || user.opt_out) { endSession(userId); return; }

  // Quiet hour 00-07 WIB — pakai user object yang nyata
  if (isUserQuietHour(user)) {
    logger.info(`[SESSION-FU] Quiet hour, batal touchpoint ${touchpoint} untuk ${userId}`);
    return;
  }

  // Jangan ganggu saat checkout
  if (await isUserInCheckout(userId)) {
    logger.info(`[SESSION-FU] User ${userId} sedang checkout, batal touchpoint ${touchpoint}`);
    endSession(userId);
    return;
  }

  // Rate limit harian (max 3 pesan/hari)
  const canSend = await checkAndIncrementRateLimit(userId);
  if (!canSend) {
    logger.info(`[SESSION-FU] Rate limit harian, batal touchpoint ${touchpoint} untuk ${userId}`);
    endSession(userId);
    return;
  }

  // Ambil produk yang belum dibeli
  const allProducts = await Product.find({ active: 1 }).lean();
  const { keyboard, products: unboughtProducts } = await buildAllProductsKeyboard(userId, allProducts, 0);
  if (!unboughtProducts.length) { endSession(userId); return; } // Sudah beli semua

  const name = user.first_name || 'Bos';
  const totalBuyers = (await Order.distinct('user_id', { status: 'SUCCESS' })).length;
  const recentBuyers = await Order.countDocuments({
    status: 'SUCCESS',
    created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  });

  let msg = '';

  if (touchpoint === 1) {
    // T+5 menit: Guide — bantu user pilih produk
    const prodNames = unboughtProducts.slice(0, 3).map(p => `• <b>${p.name}</b>`).join('\n');
    msg = `🤔 <b>Bingung pilih yang mana, ${name}?</b>\n\n` +
          `Ini yang paling banyak dipilih member baru:\n${prodNames}\n\n` +
          `<blockquote>Semua akses permanen, bayar sekali. Tidak ada biaya bulanan.</blockquote>\n\n` +
          `👇 <b>Pilih satu dan lihat detailnya:</b>`;
  } else if (touchpoint === 2) {
    // T+15 menit: FOMO + social proof nyata
    const socialLine = recentBuyers > 0
      ? `${recentBuyers} orang sudah gabung dalam 24 jam terakhir.`
      : `${totalBuyers}+ member sudah aktif di dalam.`;
    msg = `⚡ <b>${socialLine}</b>\n\n` +
          `Kamu sudah di sini ${Math.round((Date.now() - (getSession(userId)?.sessionStart || Date.now())) / 60000)} menit.\n` +
          `Banyak yang ambil keputusan lebih cepat dari itu.\n\n` +
          `<blockquote>Penawaran hari ini — termasuk diskon yang sudah kami aktifkan — berlaku sampai tengah malam.</blockquote>\n\n` +
          `👇 <b>Ambil sekarang sebelum habis:</b>`;
  } else if (touchpoint === 3) {
    // T+30 menit: Last offer — diskon ekstra tipis
    msg = `🎁 <b>${name}, satu penawaran terakhir sebelum kamu pergi.</b>\n\n` +
          `Kami aktifkan diskon ekstra khusus sesi ini — tidak akan muncul lagi setelah kamu tutup bot.\n\n` +
          `<blockquote>Ini bukan template. Ini genuinely last call untuk harga ini hari ini.</blockquote>\n\n` +
          `👇 <b>Klik tombol di bawah — sekarang atau tidak sama sekali:</b>`;
  }

  if (!msg) return;

  const hFile = await getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');
  const hType = await getSetting('header_type', 'url');

  const result = await sendSafe(bot, userId, msg, {
    media: hFile, mediaType: hType,
    keyboard,
    campaign: `RT_SESSION_T${touchpoint}`,
    userName: name,
    reason: `session_followup_t${touchpoint}`
  });

  if (result.ok) {
    logger.info(`[SESSION-FU] ✅ Touchpoint ${touchpoint} terkirim ke ${userId} (${name})`);
    const session = getSession(userId);
    if (session) session.touchpoints = touchpoint;
  }
}

// Export endSession agar bisa dipanggil dari index.js saat user mulai checkout
function cancelSessionOnCheckout(userId) {
  if (getSession(userId)) {
    logger.info(`[SESSION] Checkout dimulai → cancel semua follow-up untuk ${userId}`);
    endSession(userId);
  }
}


module.exports = {
  startCron,
  runMarketingCampaign,
  sendTestMarketing,
  markDripConverted,
  setMarketingEnabled,
  isMarketingEnabled,
  stopDailyCron,
  triggerRealtimeMarketing,   // ← export baru
  getSmartRecommendation,
  runCartAbandonCampaign,
  runDripFollowUp,
  checkAndIncrementRateLimit,  // ← export for unit tests
  acquireCampaignLock,         // ← export for unit tests
  isUserInCheckout,            // ← export for unit tests
  classifyNonBuyer,            // ← export for unit tests (Task 6.1.4)
  isInCooldown,                // ← export for unit tests (Task 6.3.1)
  updateSessionActivity,       // ← dipanggil tiap user aktif dari index.js
  cancelSessionOnCheckout,     // ← dipanggil saat user mulai checkout
};

