require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const { startSaweriaSSE } = require("./saweria-sse");
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog, DripLog } = require("./database");
const store = require("./store");
const admin = require("./admin");
const scheduler = require("./scheduler");
const preview = require("./preview");

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim() || null;
const SAWERIA_USERNAME = (process.env.SAWERIA_USERNAME || 'zahwafe').trim();
const SAWERIA_USER_ID = (process.env.SAWERIA_USER_ID || 'd8e876df-405c-4e08-9708-9808b9037ea5').trim();
const CHECK_INTERVAL_MS = 7000;
const MAX_WAIT_MINUTES = 15;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN tidak diset!");
  process.exit(1);
}

const logger = require('./logger');


function formatRupiah(amount) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(amount);
}

async function replySafe(ctx, text, options) {
  try {
    return await ctx.reply(text, options);
  } catch (err) {
    logger.error("Telegram reply failed:", err.message);
    return ctx.reply(text.replace(/[*_`]/g, ""));
  }
}

let browserInstance = null;
let bgPage = null;

async function getBgPage() {
  if (!browserInstance) {
    logger.info("Membuka Headless Browser (Puppeteer Stealth)...");
    browserInstance = await puppeteer.launch({
      headless: "new",
      protocolTimeout: 1200000,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--disable-gpu',
        '--disable-web-security',
        '--disable-accelerated-2d-canvas',
        '--no-zygote',
        '--js-flags="--max-old-space-size=256"'
      ]
    });
    
    browserInstance.on('disconnected', () => {
      logger.warn("Browser terputus/crash! Memastikan zombie process terhapus...");
      try {
        if (browserInstance && browserInstance.process()) {
          browserInstance.process().kill('SIGKILL');
        }
      } catch (e) { }
      browserInstance = null;
      bgPage = null;
    });
  }
  
  if (!bgPage || bgPage.isClosed()) {
    bgPage = await browserInstance.newPage();
    // OPTIMASI RAM EXTREME: Blokir gambar, css, font
    await bgPage.setRequestInterception(true);
    bgPage.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    await bgPage.goto('https://backend.saweria.co/', { waitUntil: 'networkidle2' });
    try { await bgPage.waitForFunction(() => document.title !== 'Just a moment...', { timeout: 15000 }); } catch(e) { }
    logger.info("Background page siap!");
  }
  
  return bgPage;
}

let isResolvingCloudflare = false;
let cfResolvePromise = null;

async function executeFetch(page, method, url, body) {
  const reqFn = async (fetchUrl, fetchMethod, fetchBody) => {
    const options = {
      method: fetchMethod,
      headers: { 'Origin': 'https://saweria.co', 'Referer': 'https://saweria.co/' }
    };
    if (fetchBody) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(fetchBody);
    }
    const response = await fetch(fetchUrl, options);
    return { status: response.status, body: await response.text() };
  };
  
  let res = await page.evaluate(reqFn, url, method, body);
  
  // Jika kena block Cloudflare lagi (HTML Just a moment)
  if (res.body.includes('<!DOCTYPE html>') && res.body.includes('Just a moment')) {
     if (isResolvingCloudflare) {
       await cfResolvePromise;
     } else {
       isResolvingCloudflare = true;
       // [ADVANCED LOG] CF hit dengan context URL
       const _cfDonationId = url.split('/').pop();
       logger.cloudflare.hit(_cfDonationId, 1);
       cfResolvePromise = (async () => {
         await page.goto('https://backend.saweria.co/', { waitUntil: 'networkidle2' });
         try { await page.waitForFunction(() => document.title !== 'Just a moment...', { timeout: 15000 }); } catch(e) { }
       })();
       try {
         await cfResolvePromise;
         logger.cloudflare.cleared(_cfDonationId);
       } finally {
         // [BUGFIX] Selalu reset flag agar tidak terjadi deadlock permanen jika CF resolve gagal
         isResolvingCloudflare = false;
       }
     }
     res = await page.evaluate(reqFn, url, method, body);
  }
  
  if (res.status >= 400) throw new Error(`Saweria API Error (${res.status}): ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

async function sawPost(url, body) {
  const page = await getBgPage();
  return executeFetch(page, 'POST', url, body);
}

async function sawGet(url) {
  const page = await getBgPage();
  return executeFetch(page, 'GET', url, null);
}


async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const wait = delayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const bot = new Telegraf(BOT_TOKEN);
// [FIX] Init logger dengan bot reference agar admin alert bisa dikirim otomatis
logger.init(bot, ADMIN_CHAT_ID);

// [FIX SESSION] Session berbasis MongoDB agar tidak hilang saat bot restart
// In-memory session (default) hilang begitu bot di-deploy/restart → user stuck di tengah flow
const mongoose = require('mongoose');
const SessionSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true, index: true },
  data:  { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now, expires: 86400 } // auto-hapus setelah 24 jam
}, { collection: 'botsessions' });
const SessionModel = mongoose.models.BotSession || mongoose.model('BotSession', SessionSchema);

bot.use(async (ctx, next) => {
  const key = ctx.from ? `${ctx.chat?.id}:${ctx.from.id}` : null;
  if (!key) return next();
  let record = await SessionModel.findOne({ key }).lean();
  ctx.session = record ? (record.data || {}) : {};
  try {
    await next();
  } finally {
    // [CRITICAL] Selalu simpan session — pakai finally agar tetap jalan meski handler error
    // Sebelumnya: kalau handler throw, session tidak pernah disimpan → sesi lama tersisa di DB
    try {
      await SessionModel.findOneAndUpdate(
        { key },
        { $set: { data: ctx.session || {}, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (saveErr) {
      console.error('[SESSION] Gagal simpan session ke DB:', saveErr.message);
    }
  }
});

const SAWERIA_API = (process.env.SAWERIA_API || 'https://backend.saweria.co').trim();

// Fungsi untuk menghitung tagihan dasar (Base Amount)
// Rumus final: (Harga Asli * 1.04) lalu bulatkan ke atas ke kelipatan Rp 500
function calculateBaseAmount(netTarget) {
  const base = netTarget * 1.04;
  return Math.ceil(base / 500) * 500;
}

async function createDonation(amount, email, name, message) {
  return withRetry(async () => {
    const url = `${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`;
    logger.info(`Calling Saweria: ${url} | amount=${amount} | user=${SAWERIA_USERNAME}`);
    const payload = { agree: true, notUnderage: true, message: message || "-", amount, payment_type: "qris", vote: "", currency: "IDR", customer_info: { first_name: name, email, phone: "" } };
    const res = await sawPost(url, payload);
    if (!res?.data?.qr_string) {
      logger.error("Saweria Response (createDonation):", JSON.stringify(res));
      throw new Error("createDonation: respons tidak valid");
    }
    return res.data;
  });
}

async function checkPaymentStatus(donationId) {
  try {
    const res = await sawGet(`${SAWERIA_API}/donations/qris/snap/${donationId}`);
    const d = res?.data;
    if (d) return { id: d.id, status: d.transaction_status, amount: d.amount_raw, created_at: d.created_at };
  } catch (e) {}
  return null;
}

async function generateQRImage(qrString, donationId) {
  const filePath = path.join("/tmp", `qr_${donationId}.png`);
  await QRCode.toFile(filePath, qrString, { width: 500, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
  return filePath;
}

const activeIntervals = {};

function stopPolling(donationId) {
  if (activeIntervals[donationId]) {
    clearInterval(activeIntervals[donationId]);
    delete activeIntervals[donationId];
  }
}

async function sendPhotoToTelegram(chatId, photoPath, caption, parseMode = 'HTML') {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', require('fs').createReadStream(photoPath));
  form.append('caption', caption);
  form.append('parse_mode', parseMode);
  const res = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
  return res.data.result;
}

async function notifyAdmin(text, parseMode = 'HTML') {
  if (process.env.NODE_ENV === 'test') return;
  if (!ADMIN_CHAT_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: parseMode }); } catch (e) {}
}

async function onPaymentSuccess(ctx, chatId, msgId, donationId, orderId, qrMsgId) {
  stopPolling(donationId);
  if (qrMsgId) {
    try { await ctx.telegram.deleteMessage(chatId, qrMsgId); } catch (_) {}
  }
  
  try {
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId, status: 'PENDING' },
      { $set: { status: 'SUCCESS', success_processed_at: new Date() } }
    );
    
    if (!updatedOrder) {
      logger.warn(`[IDEMPOTENT] Order ${orderId} sudah diproses. Skip.`);
      return;
    }

    const deliveries = await store.fulfillOrder(orderId);
    const boughtProdIds = deliveries.map(d => d.product_id).filter(Boolean);
    await scheduler.markDripConverted(chatId, updatedOrder.total_amount, boughtProdIds);

    // Pesan sukses — hype, bukan hanya kirim link
    let deliveryText = `🎉 <b>AKSES VIP KAMU AKTIF!</b>\n\n`;
    deliveryText += `Selamat bergabung! Kamu sekarang punya akses ke konten eksklusif yang dicari banyak orang.\n\n`;
    deliveries.forEach((d, i) => {
      if (d.content.trim().startsWith('http')) {
        deliveryText += `🔑 <b>Link Akses #${i+1}:</b>\n👉 <a href="${d.content.trim()}">KLIK DI SINI UNTUK MASUK GRUP VIP</a> 👈\n\n`;
      } else {
        deliveryText += `🔑 <b>Akses #${i+1}:</b>\n<code>${d.content}</code>\n\n`;
      }
    });
    deliveryText += `<i>Simpan link ini baik-baik. Akses permanen — sekali bayar selamanya.</i>`;

    try {
      await ctx.telegram.editMessageText(chatId, msgId, null, deliveryText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'menu_main_keep')]])
      });
    } catch (err) {
      logger.warn(`[PAYMENT] editMessageText gagal (${err.message}). Fallback ke sendMessage.`);
      try {
        await ctx.telegram.sendMessage(chatId, deliveryText, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'menu_main_keep')]])
        });
      } catch (err2) {
        logger.error(`[PAYMENT] sendMessage fallback GAGAL (${err2.message}).`);
        await ctx.telegram.sendMessage(chatId, deliveryText.replace(/<[^>]*>/g, ''), {
          ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'menu_main_keep')]])
        });
      }
    }

    // [FIX] Log payment.success SATU KALI dengan amount BENAR — logger v2 kirim alert ke admin otomatis
    const buyerName = (await User.findById(chatId).lean())?.first_name || 'Unknown';
    const order2 = await Order.findById(orderId).lean();
    const finalAmount = order2?.total_amount || updatedOrder.total_amount || 0;
    logger.payment.success(orderId, chatId, finalAmount, 'poll');
    logger.payment.delivered(orderId, chatId, deliveries.length);
    // Tambah info nama buyer ke log admin (selain yg dikirim oleh logger.payment.success)
    if (buyerName !== 'Unknown') {
      // Kirim detail produk ke admin (logger.payment.success hanya kirim amount)
      const prodNames = deliveries.map(d => d.product_id).join(', ');
      await notifyAdmin(`👤 Buyer: <b>${buyerName}</b> | Produk: <code>${prodNames}</code>`, 'HTML');
    }
    // Update User CRM Stats
    const order = await Order.findById(orderId).lean();
    if (order) {
      await User.findByIdAndUpdate(chatId, {
        $inc: { purchase_count: 1, total_spent: order.total_amount }
      });
      await trackEvent(chatId, 'PAYMENT_SUCCESS', null, { order_id: orderId, total_amount: order.total_amount });
      // [PAY-09] Increment used_count diskon HANYA saat payment SUCCESS (bukan saat checkout PENDING)
      // Ini memastikan kuota diskon tidak berkurang untuk order yang tidak jadi dibayar
      if (order.discount_id) {
        const { Discount } = require('./database');
        await Discount.findByIdAndUpdate(order.discount_id, { $inc: { used_count: 1 } });
      }
    }

    // ── [UPGRADE 4] SOCIAL PROOF ENGINE REAL-TIME ──────────────────────────
    // Kirim notifikasi ke max 5 non-buyer yang baru aktif (<24 jam)
    if (process.env.NODE_ENV !== "test") {
      setTimeout(async () => {
        try {
          // Ambil nama produk yang dibeli
          let boughtNames = [];
          for (const d of deliveries) {
            const prod = await Product.findById(d.product_id).lean();
            if (prod) boughtNames.push(prod.name);
          }
          if (boughtNames.length === 0) return;
          const pName = boughtNames.join(' & ');

          // Cari non-buyer aktif
          const recentNonBuyers = await User.find({
            purchase_count: { $in: [0, null] },
            is_blocked: { $ne: true },
            last_active_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            _id: { $ne: chatId } // Jangan kirim ke pembeli itu sendiri
          }).sort({ last_active_at: -1 }).limit(5).lean();

          if (recentNonBuyers.length > 0) {
            const msg = `🔔 <b>Baru saja terjadi!</b>\n\n` +
                        `Seseorang baru bergabung dan kini punya akses ke koleksi subtitle Indonesia eksklusif dari J-SUB.\n\n` +
                        `<blockquote>J-SUB bukan cuma kumpulin video. Subtitle Indonesia-nya dikerjakan sendiri oleh tim kami.</blockquote>\n\n` +
                        `👇 <b>Lihat Koleksi VIP:</b>`;
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🎁 Lihat VIP Menu', 'menu_main_keep')]]);
            
            for (const nb of recentNonBuyers) {
              await ctx.telegram.sendMessage(nb._id, msg, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        } catch (e) {
          logger.error('Social proof engine error:', e.message);
        }
      }, 10000); // Tunggu 10 detik
    }

    // ── POST-PURCHASE UPSELL ──────────────────────────────────────────────
    // Jalankan 5 detik setelah produk terkirim — saat user sedang "hot"
    // Dibungkus setTimeout + try-catch agar tidak mengganggu alur utama
    if (process.env.NODE_ENV !== "test") {
      setTimeout(async () => {
        try {
          const allProducts = await Product.find({ active: 1 }).lean();
          if (allProducts.length < 2) return; // Hanya 1 produk, skip upsell

          // Ambil semua produk yang sudah dibeli user ini
          const successOrders = await Order.find({ user_id: chatId, status: 'SUCCESS' }).lean();
          const orderIds = successOrders.map(o => o._id);
          const boughtItems = await OrderItem.find({ order_id: { $in: orderIds } }).lean();
          const boughtIds = [...new Set(boughtItems.map(i => String(i.product_id)))];

          // Nama produk yang baru saja dibeli (dari delivery ini)
          const justBoughtName = deliveries[0] ? deliveries[0].product_id : 'produk ini';

          // Cari produk yang belum dimiliki
          const nextProduct = allProducts.find(p => !boughtIds.includes(String(p._id)));

          if (nextProduct) {
            // User belum lengkap — tawarkan produk berikutnya
            await ctx.telegram.sendMessage(chatId,
              `🎊 *Akses VIP kamu sudah aktif!*\n\n` +
              `Btw, banyak member kami yang punya *${nextProduct.name}* juga lho — ` +
              `dan sepertinya cocok banget buat kamu! 😊\n\n` +
              `Sama-sama *Permanen* — sekali beli, selamanya.\n\n` +
              `Tertarik? Klik /start untuk lihat! 🔥`,
              { parse_mode: 'Markdown' }
            );
          } else {
            // User sudah beli semua produk — apresiasi!
            await ctx.telegram.sendMessage(chatId,
              `🏆 *Luar biasa!*\n\n` +
              `Kamu sekarang sudah punya *semua akses VIP* yang kami sediakan!\n\n` +
              `Terima kasih sudah jadi member setia kami. Kamu luar biasa! ❤️`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (upsellErr) {
          // Silent fail — jangan sampai error upsell mengganggu apapun
          logger.warn('Post-purchase upsell gagal (silent):', upsellErr.message);
        }
      }, 60000); // Tunda 60 detik agar pembeli fokus pada link produknya dulu
    }
    // ──────────────────────────────────────────────────────────────────────
  } catch (err) {
    logger.error(err);
  }
}


function pollPaymentStatus(ctx, donationId, chatId, msgId, orderId, qrMsgId) {
  const startTime = Date.now();
  const totalMs   = MAX_WAIT_MINUTES * 60 * 1000;
  let reminderSent = false;

  // [FIX KRITIS] Kembalikan API polling — webhook tidak reliable karena PUBLIC_URL kosong.
  // Poll Saweria API setiap 7 detik sebagai primary detection.
  // Webhook tetap berfungsi sebagai bonus jika terkonfigurasi.
  const interval = setInterval(async () => {
    try {
      const elapsed     = Date.now() - startTime;
      const secondsLeft = Math.max(0, Math.floor((totalMs - elapsed) / 1000));

      // [UTAMA] Cek status pembayaran via Saweria API
      if (secondsLeft > 0) {
        const currentOrder = await Order.findById(orderId).select('status').lean();
        if (currentOrder?.status === 'SUCCESS') {
          stopPolling(donationId);
          return;
        }
        // Poll Saweria API langsung
        try {
          const statusData = await checkPaymentStatus(donationId);
          if (statusData && (statusData.status === 'settlement' || statusData.status === 'capture')) {
            stopPolling(donationId);
            logger.payment.wsCaught(donationId, chatId); // pakai wsCaught untuk log SUCCESS di PAYMENT cat
            await onPaymentSuccess(ctx, chatId, msgId, donationId, orderId, qrMsgId);
            return;
          }
          // Log kalau status masih pending/tidak dikenal
          if (statusData && statusData.status && statusData.status !== 'pending') {
            logger.debug(`[POLL] donationId=${donationId} status=${statusData.status}`);
          }
        } catch (pollErr) {
          // CF atau network error — log ringkas agar bisa dimonitor
          const isCloudflare = pollErr.message?.includes('DOCTYPE') || pollErr.message?.includes('Just a moment');
          if (isCloudflare) {
            logger.cloudflare.hit(donationId, 1);
          }
          // Tidak crash — lanjut polling berikutnya
        }
      }

      // [CONVERSION] Countdown reminder menit ke-10 (5 menit sebelum expire)
      if (!reminderSent && elapsed >= 10 * 60 * 1000 && secondsLeft > 0) {
        reminderSent = true;
        try {
          logger.payment.reminderSent(chatId, orderId);
          await ctx.telegram.sendMessage(chatId,
            `⏰ <b>Reminder: QR kamu berakhir dalam 5 menit!</b>\n\nBelum sempat scan? Tinggal 30 detik:\n1. Buka e-wallet / m-Banking kamu\n2. Pilih Scan QR → arahkan ke kode tadi\n3. Konfirmasi ✅\n\nAtau mau buat QR baru?`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
              { text: '🔄 Buat QR Baru', callback_data: `reorder_${orderId}` },
              { text: '❌ Batalkan',    callback_data: `cancel_order_${orderId}` }
            ]]}}
          );
        } catch (_) {}
      }

      // Timeout 15 menit habis dan webhook/poll tidak pernah detect → expired
      if (secondsLeft <= 0) {
        stopPolling(donationId);
        // Cek sekali lagi via API — mungkin baru saja bayar
        try {
          const lastCheck = await checkPaymentStatus(donationId);
          if (lastCheck && (lastCheck.status === 'settlement' || lastCheck.status === 'capture')) {
            logger.info(`[PAYMENT] Last-second poll detected payment: ${donationId}`);
            await onPaymentSuccess(ctx, chatId, msgId, donationId, orderId, qrMsgId);
            return;
          }
        } catch (_) {}
        const finalCheck = await Order.findById(orderId).select('status').lean();
        if (finalCheck?.status === 'SUCCESS') return;
        logger.payment.expired(orderId, chatId, 0, 'timeout_15min');
        try { await Order.findByIdAndUpdate(orderId, { status: 'EXPIRED' }); } catch (e) {}
        if (qrMsgId) try { await ctx.telegram.deleteMessage(chatId, qrMsgId); } catch (_) {}
        await handleOrderExpired(ctx, chatId, msgId, orderId);
      }
    } catch (err) {}
  }, CHECK_INTERVAL_MS);

  return interval;
}



// [CONVERSION] Handle order expired — pesan human + high-intent user alert ke admin
async function handleOrderExpired(ctx, chatId, msgId, orderId) {
  try {
    await ctx.telegram.editMessageText(chatId, msgId, null,
      `⏰ <b>QR sudah kedaluwarsa.</b>\n\nTidak apa-apa! Bisa dibuat ulang kapan saja — prosesnya cuma 30 detik.\n\nMau lanjutkan checkout?`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '🔄 Buat QR Baru', callback_data: `reorder_${orderId}` }],
        [{ text: '💬 Ada Pertanyaan? Chat Admin', url: `https://t.me/${process.env.ADMIN_TELEGRAM_USERNAME || 'zahwafe'}` }]
      ]}}
    );

    // [CONVERSION] Alert admin jika user ini high-intent (abandoned 3x+)
    try {
      const order = await Order.findById(orderId).lean();
      if (order) {
        const abandonCount = await Order.countDocuments({ user_id: order.user_id, status: 'EXPIRED' });
        if (abandonCount >= 3 && process.env.ADMIN_CHAT_ID) {
          const user = await User.findById(order.user_id).lean();
          const name = user?.first_name || 'Unknown';
          const username = user?.username ? '@' + user.username : 'tanpa username';
          logger.marketing.highIntentAlert(order.user_id, name, abandonCount, orderId);
          await ctx.telegram.sendMessage(process.env.ADMIN_CHAT_ID,
            `🔔 <b>HIGH-INTENT BUYER ALERT!</b>\n\n` +
            `User <b>${name}</b> (${username}) baru saja abandon untuk ke-<b>${abandonCount}</b> kalinya.\n` +
            `Order: <code>${orderId}</code> | Nilai: Rp ${order.total_amount?.toLocaleString('id-ID') || '?'}\n\n` +
            `💡 User ini SANGAT ingin beli. Ada sesuatu yang menghalangi.\n` +
            `Pertimbangkan untuk menyapa mereka secara personal.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
              [{ text: `💬 Sapa ${name} Sekarang`, url: `tg://user?id=${order.user_id}` }]
            ]}}
          );
        }

        // [FIX P1a] Auto-create DripLog CART_ABANDON saat order expire
        // Ini memastikan SEMUA abandoner masuk funnel cart abandon, bukan hanya yang sudah ada DripLog
        if (!user?.is_blocked && !order?.donated) {
          try {
            const existingCA = await DripLog.findOne({
              user_id: order.user_id,
              campaign_type: 'CART_ABANDON',
              product_id: String(order.product_id || order.items?.[0]?.product_id || ''),
              converted: false
            }).lean();
            if (!existingCA) {
              await DripLog.create({
                user_id: order.user_id,
                product_id: String(order.product_id || order.items?.[0]?.product_id || ''),
                campaign_type: 'CART_ABANDON',
                stage: 0, // Stage 0 = baru abandon, siap dikirim Stage 1 berikutnya
                sent_at: new Date(),
                converted: false
              });
              logger.info(`[CART_ABANDON] Auto-created DripLog untuk user ${order.user_id} setelah expire order ${orderId}`);
            }
          } catch (dripErr) {
            logger.error('[CART_ABANDON] Gagal create DripLog:', dripErr.message);
          }
        }

      }
    } catch (_) {}
  } catch (_) {}
}

// User Registration Middleware
// Utility untuk melacak event / behavior user
async function trackEvent(userId, eventType, productId = null, metadata = {}) {
  try {
    await UserEvent.create({
      user_id: userId,
      event_type: eventType,
      product_id: productId,
      metadata
    });
  } catch (err) {
    logger.error("Gagal melacak event:", err.message);
  }
}

// Cache in-memory agar tidak spam write ke MongoDB tiap kali user klik tombol
const activeUsersCache = new Map();

// [BUGFIX 1] Memory Leak Prevention: Bersihkan cache yang kadaluarsa tiap 6 jam
setInterval(() => {
  const now = Date.now();
  for (const [userId, lastUpdate] of activeUsersCache.entries()) {
    if (now - lastUpdate > 24 * 60 * 60 * 1000) {
      activeUsersCache.delete(userId);
    }
  }
}, 6 * 60 * 60 * 1000);

bot.use(async (ctx, next) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    const now = Date.now();
    const lastUpdate = activeUsersCache.get(userId) || 0;

    // UPDATE DATABASE MAKSIMAL 1 KALI PER 1 HARI (24 Jam) per user
    if (now - lastUpdate > 24 * 60 * 60 * 1000) {
      activeUsersCache.set(userId, now);

      const updateOp = {
        $set: {
          first_name: ctx.from.first_name || '',
          username: ctx.from.username || '',
          last_active_at: new Date()
        },
        $setOnInsert: {
          purchase_count: 0,
          total_spent: 0,
          is_blocked: false
        }
      };
      
      // Jika lewat link referral/start payload
      if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start ')) {
        const payload = ctx.message.text.split(' ')[1];
        updateOp.$setOnInsert.source_ref = payload;
      }

      // Jalankan tanpa harus menunggu (non-blocking) agar bot merespon lebih cepat
      User.findByIdAndUpdate(
        userId,
        updateOp,
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      ).exec().catch(err => logger.error("Gagal update user tracking:", err.message));
    }
  }
  return next();
});

// Cooldown / Anti-Spam Middleware khusus untuk aksi tombol (Callback Query)
const clickCooldowns = new Map();
bot.on('callback_query', async (ctx, next) => {
  if (ctx.from) {
    if (admin.isAdmin(ctx)) return next(); // Abaikan cooldown untuk Admin

    const userId = ctx.from.id;
    const now = Date.now();
    const lastClick = clickCooldowns.get(userId) || 0;
    
    // Cooldown 3 detik
    if (now - lastClick < 3000) {
      return ctx.answerCbQuery("⏳ Mohon tunggu 3 detik sebelum memencet tombol lagi.", { show_alert: true });
    }
    clickCooldowns.set(userId, now);
  }
  return next();
});

// Broadcast Engine
async function runBroadcast(adminCtx, queryFilter, segmentName, messageText) {
  const users = await User.find({ ...queryFilter, is_blocked: false }).select('_id').lean();
  if (users.length === 0) {
    return adminCtx.reply(`❌ Tidak ada target user untuk segmen: ${segmentName}`);
  }

  const isDryRun = messageText.includes('DRY_RUN');
  const isConfirm = messageText.includes('CONFIRM');

  if (!isConfirm && !isDryRun) {
    const safeSegment = segmentName.replace(/_/g, '\\_');
    return adminCtx.reply(`🔍 *[PREVIEW] Broadcast*\n\nTarget Segmen: ${safeSegment}\nJumlah Target: ${users.length} user\n\nUntuk mengirim pesan ini secara riil, tambahkan kata \`CONFIRM\` di akhir pesan Anda.\nUntuk mencoba simulasi (tanpa kirim), tambahkan \`DRY_RUN\`.`, { parse_mode: 'Markdown' });
  }

  const finalMessage = messageText.replace(/CONFIRM|DRY_RUN/g, '').trim();

  if (isDryRun) {
    try {
      return await adminCtx.reply(`✅ *[DRY-RUN] Selesai*\n\nPesan (simulasi) akan terkirim ke ${users.length} user (${segmentName.replace(/_/g, '\\_')}).\nPesan:\n${finalMessage}`, { parse_mode: 'Markdown' });
    } catch (err) {
      return await adminCtx.reply(`✅ [DRY-RUN] Selesai\n\nPesan (simulasi) akan terkirim ke ${users.length} user (${segmentName}).\nPesan:\n${finalMessage}`);
    }
  }

  const statusMsg = await adminCtx.reply(`⏳ Memulai broadcast ke ${users.length} user (${segmentName})...\n\nMohon tunggu, proses mengirim 1 pesan per detik...`);
  
  const log = await BroadcastLog.create({
    admin_id: adminCtx.from.id,
    target_segment: segmentName,
    message_text: finalMessage,
    status: 'SENDING'
  });

  let success = 0;
  let failed = 0;

  // Proses secara asinkron agar tidak memblokir bot
  (async () => {
    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u._id, finalMessage, { parse_mode: 'Markdown' });
        success++;
      } catch (err) {
        failed++;
        // Handle blocked bot
        if (err.description && err.description.includes('bot was blocked by the user')) {
          await User.findByIdAndUpdate(u._id, { is_blocked: true });
        }
      }
      // Delay 1 detik untuk menghindari rate limit Telegram (Anti-Spam)
      await new Promise(res => setTimeout(res, 1000));
    }

    log.status = 'COMPLETED';
    log.success_count = success;
    log.failed_count = failed;
    await log.save();

    await bot.telegram.sendMessage(
      adminCtx.from.id, 
      `✅ *Broadcast Selesai!*\n\nSegmen: ${segmentName}\nSukses: ${success}\nGagal/Blocked: ${failed}`,
      { parse_mode: 'Markdown' }
    );
  })();
}

// Admin Commands
bot.command("broadcast_buyer", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const msg = ctx.message.text.replace('/broadcast_buyer', '').trim();
  if (!msg) return ctx.reply("Format salah. Gunakan: /broadcast_buyer <pesan>");
  await runBroadcast(ctx, { purchase_count: { $gt: 0 } }, 'BUYERS', msg);
});

bot.command("broadcast_nonbuyer", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const msg = ctx.message.text.replace('/broadcast_nonbuyer', '').trim();
  if (!msg) return ctx.reply("Format salah. Gunakan: /broadcast_nonbuyer <pesan>");
  await runBroadcast(ctx, { purchase_count: 0 }, 'NON_BUYERS', msg);
});

bot.command("broadcast_all", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const msg = ctx.message.text.replace('/broadcast_all', '').trim();
  if (!msg) return ctx.reply("Format salah. Gunakan: /broadcast_all <pesan>");
  await runBroadcast(ctx, {}, 'ALL', msg);
});

bot.command("broadcast_product", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/broadcast_product', '').trim().split(' ');
  const productId = args[0];
  const msg = args.slice(1).join(' ');

  if (!productId || !msg) {
    return ctx.reply("Format salah. Gunakan: /broadcast_product <product_id> <pesan>\n\nContoh:\n/broadcast_product PROD-123 Hei, ada update untuk produk yang kamu beli!");
  }

  // Efisien: 2 query saja, tidak ada loop N+1
  const orderItems = await OrderItem.find({ product_id: productId }).lean();
  const orderIds = orderItems.map(i => i.order_id);
  const successOrders = await Order.find({ _id: { $in: orderIds }, status: 'SUCCESS' }).lean();
  const userIds = [...new Set(successOrders.map(o => o.user_id))];

  if (userIds.length === 0) {
    return ctx.reply(`❌ Belum ada user yang berhasil membeli produk ID: \`${productId}\``, { parse_mode: 'Markdown' });
  }

  await runBroadcast(ctx, { _id: { $in: userIds } }, `BUYERS_PRODUCT_${productId}`, msg);
});

bot.command("stats", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  return admin.showAdminCrmStats(ctx);
});

// ─── /dashboard — Admin Real-Time Dashboard ───────────────────────────────────
bot.command("dashboard", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  try {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const d7 = new Date(now - 7*86400000);
    const d30 = new Date(now - 30*86400000);

    // Revenue
    const [rev7dArr, rev30dArr, revTodayArr] = await Promise.all([
      Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:d7}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
      Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:d30}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
      Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:todayStart}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
    ]);
    const rev7d = (rev7dArr[0]||{t:0,n:0});
    const rev30d = (rev30dArr[0]||{t:0,n:0});
    const revToday = (revTodayArr[0]||{t:0,n:0});
    const avgDaily = rev30d.n > 0 ? Math.round(rev30d.t / 30) : 0;

    // Users & Funnel
    const [totalUsers, totalBuyers, checkoutToday, abandonToday] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ purchase_count: { $gt: 0 } }),
      UserEvent.countDocuments({ event_type:'CHECKOUT', created_at: { $gte: todayStart } }),
      UserEvent.countDocuments({ event_type:'CHECKOUT', created_at: { $gte: new Date(now - 24*3600000) } }),
    ]);
    const convRate = checkoutToday > 0 ? Math.round((revToday.n / checkoutToday) * 100) : 0;
    const abandonCount = await User.countDocuments({
      _id: { $in: (await UserEvent.find({event_type:'CHECKOUT',created_at:{$gte:new Date(now-24*3600000)}}).distinct('user_id')) },
      purchase_count: 0
    });

    // Top products
    const topProds = await OrderItem.aggregate([
      { $lookup: { from:'orders', localField:'order_id', foreignField:'_id', as:'ord' } },
      { $unwind: '$ord' },
      { $match: { 'ord.status': 'SUCCESS' } },
      { $group: { _id: '$product_id', sold: { $sum: '$quantity' } } },
      { $sort: { sold: -1 } }, { $limit: 5 }
    ]);
    const allProds = await Product.find({ active: 1 }).lean();
    const prodMap = {};
    allProds.forEach(p => { prodMap[String(p._id)] = p.name; });

    // Stock
    const stockByProd = await Stock.aggregate([
      { $match: { status: 'AVAILABLE' } },
      { $group: { _id: '$product_id', count: { $sum: 1 } } }
    ]);
    const stockWarnings = stockByProd.filter(s => s.count < 5).map(s => `⚠️ Stok ${prodMap[s._id]||s._id}: ${s.count} tersisa`);
    const totalAvail = stockByProd.reduce((a,s) => a+s.count, 0);

    // Active drip candidates (users yang bisa dapat cart abandon)
    const abandonCandidates = await UserEvent.countDocuments({
      event_type: 'CHECKOUT',
      created_at: { $gte: new Date(now - 24*3600000) }
    });

    const fmtRp = n => `Rp${Number(n||0).toLocaleString('id-ID')}`;
    const emoji = revToday.t > avgDaily ? '📈' : '📊';

    let msg = `${emoji} <b>DASHBOARD — ${now.toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'})}</b>\n\n`;

    msg += `💰 <b>Revenue:</b>\n`;
    msg += `  • Hari ini: <b>${fmtRp(revToday.t)}</b> (${revToday.n} trx)\n`;
    msg += `  • 7 hari : <b>${fmtRp(rev7d.t)}</b> (${rev7d.n} trx)\n`;
    msg += `  • Avg/hari: ${fmtRp(avgDaily)}\n\n`;

    msg += `👥 <b>Funnel Hari Ini:</b>\n`;
    msg += `  • Total user : ${totalUsers}\n`;
    msg += `  • Buyers     : ${totalBuyers}\n`;
    msg += `  • Checkout   : ${checkoutToday}x\n`;
    msg += `  • Konversi   : ${convRate}% (${revToday.n}/${checkoutToday})\n`;
    msg += `  • Abandon    : ${abandonCount} user (siap dapat follow-up)\n\n`;

    msg += `🔥 <b>Produk Terlaris:</b>\n`;
    topProds.forEach((p,i) => {
      msg += `  ${i+1}. ${prodMap[String(p._id)]||p._id} — ${p.sold} sold\n`;
    });
    if (topProds.length === 0) msg += `  (belum ada data)\n`;
    msg += `\n`;

    msg += `📦 <b>Stok:</b> ${totalAvail} available\n`;
    if (stockWarnings.length > 0) {
      msg += stockWarnings.join('\n') + '\n';
    } else {
      msg += `  ✅ Semua produk stok aman\n`;
    }

    if (revToday.t > avgDaily * 1.5) {
      msg += `\n🚀 <b>Hari ini above average!</b> Revenue ${Math.round(revToday.t/avgDaily*100)}% dari rata-rata harian.`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Dashboard error: ${err.message}`);
  }
});

bot.command("user", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const targetId = ctx.message.text.replace('/user', '').trim();
  if (!targetId) return ctx.reply("Format salah. Gunakan: /user <user_id>");
  
  try {
    const targetUser = await User.findById(targetId).lean();
    if (!targetUser) return ctx.reply("❌ User tidak ditemukan di database.");
    
    const text = `👤 *Data Pelanggan*\n\n` +
                 `ID: \`${targetUser._id}\`\n` +
                 `Nama: ${targetUser.first_name}\n` +
                 `Username: ${targetUser.username}\n` +
                 `Status: ${targetUser.purchase_count > 0 ? '✅ Sudah Beli' : '❌ Belum Beli'}\n` +
                 `Total Belanja: Rp ${targetUser.total_spent.toLocaleString('id-ID')}\n` +
                 `Jml Transaksi: ${targetUser.purchase_count}\n` +
                 `Tgl Join: ${targetUser.joined_at ? new Date(targetUser.joined_at).toLocaleString() : '-'}\n` +
                 `Tgl Aktif: ${targetUser.last_active_at ? new Date(targetUser.last_active_at).toLocaleString() : '-'}\n` +
                 `Diblokir: ${targetUser.is_blocked ? 'Ya' : 'Tidak'}`;
                 
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply("❌ ID tidak valid, harus berupa angka.");
  }
});

bot.command("discount_list", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const discounts = await Discount.find().lean();
  if (discounts.length === 0) return ctx.reply("Belum ada diskon yang dibuat.");
  
  let text = `🎟️ *Daftar Diskon Otomatis*\n\n`;
  discounts.forEach(d => {
    text += `🔹 *${d.code}* [${d.active ? 'Aktif' : 'Nonaktif'}]\n`;
    text += `Tipe: ${d.type} (${d.value}${d.type === 'PERCENTAGE' ? '%' : ' IDR'})\n`;
    text += `Trigger: ${d.trigger_event || 'ALL'}\n`;
    text += `Terpakai: ${d.used_count} / ${d.max_uses > 0 ? d.max_uses : 'Unlimited'}\n\n`;
  });
  
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command("creatediscount", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/creatediscount', '').trim().split(' ');
  if (args.length < 4) {
    return ctx.reply("Format: /creatediscount <KODE> <FIXED/PERCENTAGE> <NILAI> <TRIGGER>\n\nContoh:\n/creatediscount PENGGUNA_BARU FIXED 5000 FIRST_TIME\n/creatediscount LOYAL PERCENTAGE 10 LOYALTY\n/creatediscount COMEBACK FIXED 10000 CART_ABANDON");
  }
  
  const [code, type, valueStr, trigger_event] = args;
  const value = parseInt(valueStr);
  
  if (isNaN(value)) return ctx.reply("❌ Nilai diskon harus berupa angka.");

  try {
    await Discount.create({
      code,
      type: type.toUpperCase(),
      value,
      trigger_event: trigger_event.toUpperCase()
    });
    await ctx.reply(`✅ Diskon otomatis *${code}* berhasil dibuat!`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ Gagal membuat diskon: ${err.message}`);
  }
});

bot.command("deletediscount", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const code = ctx.message.text.replace('/deletediscount', '').trim();
  if (!code) return ctx.reply("Format: /deletediscount <KODE>");
  
  await Discount.deleteOne({ code });
    await ctx.reply(`🗑️ Diskon *${code}* berhasil dihapus!`, { parse_mode: 'Markdown' });
});

// ======== MARKETING AUTOMATION COMMANDS ========

// Trigger campaign marketing manual tanpa tunggu cron
bot.command("run_marketing", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.reply("🚀 Menjalankan campaign marketing otomatis...\n\nProses berjalan di background. Laporan akan dikirim setelah selesai.");
  
  try {
    const today = new Date().toDateString() + '_manual_' + Date.now();
    const stats = await scheduler.runMarketingCampaign(bot, today);
    if (stats.skipped && stats.reason) {
      return ctx.reply(`⚠️ Campaign tidak jalan: ${stats.reason}`);
    }
    const totalNonBuyer = (stats.cold || 0) + (stats.abandon || 0) + (stats.inactive || 0);
    const totalAll = totalNonBuyer + (stats.crossSell || 0) + (stats.stage2 || 0) + (stats.stage3 || 0);
    await ctx.reply(
      `✅ *Campaign Marketing Selesai!*\n\n` +
      `*📣 Campaign 1 — Belum Beli:*\n` +
      `🧊 Cold Lead: ${stats.cold || 0} pesan\n` +
      `🔥 Cart Abandon: ${stats.abandon || 0} pesan\n` +
      `😴 Inactive: ${stats.inactive || 0} pesan\n\n` +
      `*🔁 Campaign 2 — Cross-Sell (Smart):*\n` +
      `🎯 Rekomendasi Produk Baru: ${stats.crossSell || 0} pesan\n` +
      `🏆 Sudah Lengkap (skip): ${stats.complete || 0} user\n\n` +
      `*💧 Campaign 3 — Drip Follow-Up:*\n` +
      `⏰ Stage 2 (Urgensi): ${stats.stage2 || 0} pesan\n` +
      `🔔 Stage 3 (Final + Diskon): ${stats.stage3 || 0} pesan\n\n` +
      `⏭ Di-skip anti-spam: ${stats.skipped || 0}\n` +
      `❌ Gagal/Blocked: ${stats.failed || 0}\n\n` +
      `📨 *Total terkirim: ${totalAll} pesan*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error("Gagal run_marketing manual:", err);
    await ctx.reply("❌ Terjadi kesalahan sistem saat menjalankan marketing.");
  }
});

// Test satu per satu template marketing
bot.command("test_marketing", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return replySafe(ctx, "Gunakan format:\n`/test_marketing <tipe>`\n\nTipe tersedia:\n- `cold_lead`\n- `cart_abandon`\n- `inactive`\n- `cross_sell`\n- `stage2`\n- `stage3`\n- `downsell`\n\nContoh: `/test_marketing cart_abandon`", { parse_mode: 'Markdown' });
  }
  
  const type = args[0].toLowerCase();
  const res = await scheduler.sendTestMarketing(bot, ctx.chat.id, type);
  if (!res.ok) {
    return replySafe(ctx, `❌ Gagal mengirim tes: ${res.error}`);
  }
});

// Nyalakan marketing otomatis harian
bot.command("marketing_on", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  scheduler.setMarketingEnabled(true);
  scheduler.startCron(bot);
  preview.setupPreviewCommands(bot); // Setup /set_vip_group dan /set_topic_name
  replySafe(ctx, "✅ *Marketing otomatis AKTIF!*\n\nCampaign akan berjalan otomatis setiap hari jam 10.00 WIB.", { parse_mode: 'Markdown' });
});

// Matikan marketing otomatis harian
bot.command("marketing_off", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  scheduler.setMarketingEnabled(false);
  scheduler.stopDailyCron();
  replySafe(ctx, "🔴 *Marketing otomatis DIMATIKAN.*\n\nGunakan `/marketing_on` untuk mengaktifkan kembali.", { parse_mode: 'Markdown' });
});

// Ubah template pesan marketing dari Telegram (tanpa coding ulang)
bot.command("set_msg", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const parts = ctx.message.text.replace('/set_msg', '').trim().split(' ');
  const segmen = parts[0];
  const pesan = parts.slice(1).join(' ');

  if (!segmen || !pesan) {
    return ctx.reply(
      "Format: /set_msg <segmen> <pesan>\n\n" +
      "Segmen tersedia:\n" +
      "- cold_lead — User yang belum pernah klik beli\n" +
      "- cart_abandon — User klik beli tapi tidak jadi bayar\n" +
      "- inactive — User tidak aktif > 7 hari\n\n" +
      "Contoh:\n/set_msg cart_abandon Hei! Jangan sampai kehabisan slot VIP ya! Klik /start sekarang!"
    );
  }

  const validSegments = ['cold_lead', 'cart_abandon', 'inactive'];
  if (!validSegments.includes(segmen)) {
    return ctx.reply(`❌ Segmen tidak valid. Pilih: ${validSegments.join(', ')}`);
  }

  await Setting.findByIdAndUpdate(`marketing_${segmen}`, { value: pesan }, { upsert: true });
  try {
    await ctx.reply(`✅ Pesan untuk segmen *${segmen.replace(/_/g, '\\_')}* berhasil diupdate!\n\nPreview:\n${pesan}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`✅ Pesan untuk segmen ${segmen} berhasil diupdate!\n\nPreview:\n${pesan}`);
  }
});

// ── FLASH SALE TRIGGER ────────────────────────────────────────────────────
// Format: /flash_sale <PRODUCT_ID> <DURASI>
// Contoh: /flash_sale PROD-123 2jam  ATAU  /flash_sale PROD-123 30menit
bot.command("flash_sale", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;

  const args = ctx.message.text.replace('/flash_sale', '').trim().split(' ');
  const productId = args[0];
  const durasiStr = args[1];

  if (!productId || !durasiStr) {
    return ctx.reply(
      "⚡ *Format Flash Sale:*\n\n" +
      "`/flash_sale <PRODUCT_ID> <DURASI>`\n\n" +
      "Contoh:\n" +
      "`/flash_sale PROD-123 2jam`\n" +
      "`/flash_sale PROD-123 30menit`\n" +
      "`/flash_sale PROD-123 1hari`",
      { parse_mode: 'Markdown' }
    );
  }

  // Parse durasi ke milidetik
  let durasiMs = 0;
  if (durasiStr.includes('menit')) durasiMs = parseInt(durasiStr) * 60 * 1000;
  else if (durasiStr.includes('jam')) durasiMs = parseInt(durasiStr) * 60 * 60 * 1000;
  else if (durasiStr.includes('hari')) durasiMs = parseInt(durasiStr) * 24 * 60 * 60 * 1000;

  if (!durasiMs || isNaN(durasiMs)) {
    return ctx.reply("❌ Format durasi salah. Gunakan: `2jam`, `30menit`, atau `1hari`", { parse_mode: 'Markdown' });
  }

  const targetProduct = await Product.findById(productId).lean();
  if (!targetProduct) {
    return ctx.reply(`❌ Produk dengan ID \`${productId}\` tidak ditemukan.`, { parse_mode: 'Markdown' });
  }

  const deadline = new Date(Date.now() + durasiMs);
  const deadlineStr = deadline.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
  const durasiLabel = durasiStr;

  // Buat diskon sementara otomatis berlaku sampai deadline
  const flashCode = `FLASH_${productId}_${Date.now()}`;
  await Discount.create({
    code: flashCode,
    type: 'FIXED',
    value: 5000,
    trigger_event: 'ALL',
    target_product_id: productId,
    valid_until: deadline,
    active: true
  });

  // Susun pesan flash sale dengan countdown
  const flashMsg =
    `⚡ *FLASH SALE!*\n\n` +
    `🎯 *${targetProduct.name}*\n\n` +
    `Penawaran spesial hanya berlaku:\n` +
    `⏰ *${durasiLabel.toUpperCase()} LAGI* (s/d pukul ${deadlineStr} WIB)\n\n` +
    `🔥 Harga sudah termasuk diskon otomatis!\n\n` +
    `Klik /start sekarang dan jangan sampai kehabisan!`;

  // Query target: semua user yang BELUM beli produk ini, tidak diblokir
  const orderItems = await OrderItem.find({ product_id: productId }).lean();
  const orderIds = orderItems.map(i => i.order_id);
  const buyerOrders = await Order.find({ _id: { $in: orderIds }, status: 'SUCCESS' }).lean();
  const alreadyBoughtIds = [...new Set(buyerOrders.map(o => o.user_id))];

  await ctx.reply(
    `⚡ *Flash Sale dimulai!*\n\n` +
    `Produk: *${targetProduct.name}*\n` +
    `Durasi: ${durasiLabel}\n` +
    `Berakhir: ${deadlineStr} WIB\n\n` +
    `🚀 Mengirim broadcast ke semua target... Laporan dikirim setelah selesai.`,
    { parse_mode: 'Markdown' }
  );

  // Jalankan broadcast di background
  await runBroadcast(
    ctx,
    { _id: { $nin: alreadyBoughtIds }, is_blocked: { $ne: true } },
    `FLASH_SALE_${productId}`,
    flashMsg
  );
});

bot.command("admin", async (ctx) => {

  if (!admin.isAdmin(ctx)) return ctx.reply("⛔ Akses ditolak.");
  return admin.showAdminMenu(ctx);
});

bot.command("health", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const mongoose = require('mongoose');
  const memUsage = process.memoryUsage();
  
  let text = `🏥 *System Health Check*\n\n`;
  text += `• MongoDB State: \`${mongoose.connection.readyState}\` (1=Connected)\n`;
  text += `• Cron Scheduler: \`${scheduler.isMarketingEnabled() ? 'ACTIVE' : 'INACTIVE'}\`\n`;
  text += `• Uptime: \`${Math.floor(process.uptime())}s\`\n`;
  text += `• Memory (RSS): \`${Math.round(memUsage.rss / 1024 / 1024)} MB\`\n`;
  text += `• Memory (Heap): \`${Math.round(memUsage.heapUsed / 1024 / 1024)} MB\`\n`;
  
    await ctx.reply(text, { parse_mode: 'Markdown' });
});
bot.command("debug_users", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const users = await User.find({}).lean();
  let text = `🐞 *DEBUG USERS (${users.length} total):*\n\n`;
  users.forEach((u, i) => {
    text += `${i+1}. ID: \`${u._id}\` | Name: ${u.first_name || '?'}\n`;
    text += `   Purchases: ${u.purchase_count} | Blocked: ${u.is_blocked}\n`;
    text += `   Last Broadcast: ${u.last_broadcast_at ? new Date(u.last_broadcast_at).toLocaleString('id-ID') : 'Never'}\n\n`;
  });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

async function handleFixDb(ctx) {
  if (!admin.isAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ');
  const isApply = args.length >= 3 && args[1] === 'APPLY' && args[2] === 'CONFIRM';

  const count1 = await User.countDocuments({ purchase_count: { $exists: false } });
  const count2 = await User.countDocuments({ is_blocked: { $exists: false } });

  if (!isApply) {
    return ctx.reply(`🔍 *[DRY-RUN] /fix\\_db*\n\nDokumen yang AKAN diperbaiki:\n- Kolom belanja kosong: ${count1} user\n- Kolom blokir kosong: ${count2} user\n\nUntuk mengeksekusi secara permanen, ketik:\n\`/fix_db APPLY CONFIRM\``, { parse_mode: 'Markdown' });
  }

  // Lakukan audit logging
  const fs = require('fs');
  const path = require('path');
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const logStr = `[${new Date().toISOString()}] Admin ID: ${ctx.from.id} executed /fix_db APPLY CONFIRM. Affected: purchase_count=${count1}, is_blocked=${count2}\n`;
  fs.appendFileSync(path.join(logDir, 'fix_db.log'), logStr);
  
  // Perbaiki semua user lama
  const res1 = await User.updateMany(
    { purchase_count: { $exists: false } },
    { $set: { purchase_count: 0, total_spent: 0 } }
  );
  const res2 = await User.updateMany(
    { is_blocked: { $exists: false } },
    { $set: { is_blocked: false } }
  );
  
    await ctx.reply(`✅ *Database berhasil dibersihkan!*\n\nData yang diperbaiki:\n- Kolom belanja: ${res1.modifiedCount} user\n- Kolom blokir: ${res2.modifiedCount} user\n\nAudit log telah disimpan.`, { parse_mode: 'Markdown' });
}

bot.command("fix_db", async (ctx) => {
  return handleFixDb(ctx);
});

async function handleResetDb(ctx) {
  if (!admin.isAdmin(ctx)) return;
  
  const args = ctx.message.text.split(' ');
  if (args[1] !== 'CONFIRM') {
    return ctx.reply(
      `⚠️ *PERINGATAN RESET DATABASE* ⚠️\n\n` +
      `Command ini akan **MENGHAPUS SEMUA DATA PELANGGAN DAN TRANSAKSI**:\n` +
      `- Semua User & Cart dihapus\n` +
      `- Semua Order & Transaksi dihapus\n` +
      `- Semua Riwayat Marketing dihapus\n\n` +
      `*(Produk, Stok, dan Setting TIDAK AKAN DIHAPUS)*\n\n` +
      `Jika Anda yakin ingin memulai dari 0 (Fresh Start), ketik:\n` +
      `\`/reset_db CONFIRM\``,
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply("⏳ Sedang menghapus semua data user dan transaksi...");

  await User.deleteMany({});
  await Order.deleteMany({});
  await OrderItem.deleteMany({});
  await Cart.deleteMany({});
  await require('./database').UserEvent.deleteMany({});
  await require('./database').DripLog.deleteMany({});
  await require('./database').BroadcastLog.deleteMany({});

    await ctx.reply("✅ *DATABASE BERHASIL DI-RESET!*\n\nSemua riwayat user telah bersih kembali menjadi 0. Silakan klik /start untuk memulai sebagai user pertama yang bersih!", { parse_mode: 'Markdown' });
}

bot.command("reset_db", async (ctx) => {
  return handleResetDb(ctx);
});

// ── /testpromo — QA Test: tembak semua jenis pesan marketing ke admin ────────
bot.command("testpromo", async (ctx) => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId || String(ctx.from.id) !== String(adminId)) {
    return ctx.reply("❌ Akses ditolak. Hanya Admin.");
  }
  await ctx.reply("🧪 *QA Test dimulai! Menembakkan semua jenis pesan marketing ke chat kamu...*", { parse_mode: 'Markdown' });
  try {
    const products = await Product.find({ active: 1 }).lean();
    if (products.length === 0) return ctx.reply("❌ Belum ada produk aktif.");
    const hType = await store.getSetting("header_type", "url");
    const hFile = await store.getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");

    const sendPreview = async (product, caption, kbMarkup) => {
      const img = product.promo_image_id || hFile;
      const mtype = product.promo_image_id ? (product.promo_media_type || 'photo') : hType;
      const extra = { caption, parse_mode: 'HTML', reply_markup: kbMarkup.reply_markup };
      if (mtype === 'video') await ctx.replyWithVideo(img, extra);
      else if (mtype === 'photo' || (img.match && img.match(/\.(jpg|jpeg|png)$/i))) await ctx.replyWithPhoto(img, extra);
      else await ctx.replyWithAnimation(img, extra);
    };

    // ─── TEST 1: Non-Buyer Cold Lead ─────────────
    await ctx.reply("━━━━━━━━━━━━━━\n📨 *TEST 1: Pesan Non-Buyer (Cold Lead)*", { parse_mode: 'Markdown' });
    const p1 = products[0];
    const kb1 = Markup.inlineKeyboard([[Markup.button.callback(`🔥 Beli ${p1.name} (Rp${formatRupiah(p1.price)})`, `buy_now_${p1._id}`)]]);
    await sendPreview(p1,
      `🔥 <b>Hei, belum sempat coba ${p1.name}?</b>\n\nRibu member udah gabung dan nikmatin akses VIP.\n\n👇 <b>Amankan Akses Sekarang</b>`,
      kb1
    );
    await new Promise(r => setTimeout(r, 800));

    // ─── TEST 2: Cross-Sell (jika ada 2+ produk) ─
    if (products.length >= 2) {
      await ctx.reply("━━━━━━━━━━━━━━\n🔁 *TEST 2: Pesan Cross-Sell*", { parse_mode: 'Markdown' });
      const p2 = products[1];
      const kb2 = Markup.inlineKeyboard([[Markup.button.callback(`⚡ Beli ${p2.name} Sekarang`, `buy_now_${p2._id}`)]]);
      await sendPreview(p2,
        `🎉 <b>Makasih udah beli ${p1.name}!</b>\n\nBtw, ada yang belum kamu coba nih — <b>${p2.name}</b>.\n\nLengkapin koleksi kamu! 👇`,
        kb2
      );
      await new Promise(r => setTimeout(r, 800));
    }

    // ─── TEST 3: Discount Reminder ────────────────
    await ctx.reply("━━━━━━━━━━━━━━\n⏰ *TEST 3: Reminder Diskon Mau Hangus*", { parse_mode: 'Markdown' });
    const p3 = products[0];
    const discVal = 35;
    const discAmt = Math.floor(p3.price * discVal / 100);
    const finalP = p3.price - discAmt;
    const kb3 = Markup.inlineKeyboard([[Markup.button.callback(
      `💥 ${p3.name}: Rp${Math.round(p3.price/1000)}k ➤ Rp${Math.round(finalP/1000)}k`,
      `buy_now_${p3._id}`
    )]]);
    await sendPreview(p3,
      `⏰ <b>DISKON ${discVal}% HANGUS JAM 02:00 WIB!</b>\n\nKupon diskon spesial Anda:\n• ${p3.name}: Rp${p3.price.toLocaleString('id-ID')} ➤ <b>Rp${finalP.toLocaleString('id-ID')}</b>\n\n➟ Klik tombol di bawah <b>sebelum hangus!</b>`,
      kb3
    );

    await ctx.reply(
      "━━━━━━━━━━━━━━\n✅ *QA Test selesai!*\n\n" +
      "Cek 3 pesan di atas:\n" +
      "• Foto/video header tampil sesuai produk?\n" +
      "• Tombol beli muncul dengan benar?\n" +
      "• Caption terbaca rapi?\n\n" +
      "⚠️ *PENTING — Soal harga diskon di tombol TEST 3:*\n" +
      "Angka diskon (misal `Rp150k ➤ Rp97k`) di tombol itu *HANYA TEKS PREVIEW* buat ngecek tampilan.\n" +
      "Kalau diklik → QR tetap harga normal karena kamu *belum punya kupon diskon aktif* di database.\n\n" +
      "Diskon baru aktif saat:\n" +
      "1. Cron jam 20:00 WIB jalan\n" +
      "2. User punya kupon mau hangus di DB\n" +
      "3. User klik tombol dari pesan reminder asli\n\n" +
      "_Atur foto/video promo: /admin → Kelola Toko → Manajemen Produk → 📸 Set Foto Promo_",
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Error: \`${err.message}\``, { parse_mode: 'Markdown' });
  }
});

bot.action("admin_main", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showAdminMenu(ctx);
});

bot.action("admin_guide", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showGuide(ctx);
});

bot.action("admin_dashboard_full", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showDashboardFull(ctx);
});


bot.action("admin_shop_menu", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showShopMenu(ctx);
});

bot.action("admin_marketing_menu", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showMarketingMenu(ctx);
});

bot.action("admin_system_menu", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showSystemMenu(ctx);
});

bot.action("admin_marketing_settings", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const text = `🤖 *Mesin Automasi Marketing*\n\nStatus: ${scheduler.isMarketingEnabled() ? '✅ AKTIF' : '❌ MATI'}\n\nPilih aksi di bawah:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🟢 Hidupkan", "marketing_action_on"), Markup.button.callback("🔴 Matikan", "marketing_action_off")],
    [Markup.button.callback("▶️ Paksa Jalan", "marketing_action_run"), Markup.button.callback("🧪 Test Kirim", "marketing_action_test")],
    [Markup.button.callback("✍️ Ubah Teks Pesan", "marketing_action_setmsg")],
    [Markup.button.callback("🔙 Kembali", "admin_marketing_menu")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/marketing_action_(on|off|run|test|setmsg)/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  
  if (action === 'on') {
    scheduler.setMarketingEnabled(true);
    return ctx.reply("✅ Automasi Marketing dihidupkan.");
  } else if (action === 'off') {
    scheduler.setMarketingEnabled(false);
    return ctx.reply("❌ Automasi Marketing dimatikan.");
  } else if (action === 'run') {
    await ctx.reply("▶️ Memaksa Marketing jalan sekarang...");
    try {
      const today = new Date().toDateString() + '_manual_' + Date.now();
      const stats = await scheduler.runMarketingCampaign(bot, today);
      return ctx.reply(`✅ Selesai. Stats: ${JSON.stringify(stats)}`);
    } catch (err) {
      return ctx.reply(`❌ Gagal: ${err.message}`);
    }
  } else if (action === 'test') {
    await ctx.reply("🧪 Mengirim test marketing ke Anda...");
    await bot.telegram.sendMessage(ctx.from.id, "*[PREVIEW]* Halo! Ini contoh pesan edukasi", { parse_mode: 'Markdown' });
    return;
  } else if (action === 'setmsg') {
    ctx.session = ctx.session || {};
    ctx.session.step = 'admin_set_msg';
    return ctx.reply("✍️ *Ubah Pesan Marketing*\n\nKetik dengan format:\n`<TIPE> <PESAN BARU>`\n\nTipe: `CART_ABANDON`, `DRIP_DAY1`, `DRIP_DAY3`, `DRIP_DAY7`, `CROSS_SELL`\n\n_(Ketik BATAL untuk membatalkan)_", { parse_mode: "Markdown" });
  }
});

bot.action("admin_flash_sale_ui", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_flash_sale';
  return ctx.reply("⚡ *Buat Flash Sale*\n\nKetik detail Flash Sale dengan format:\n`<PRODUCT_ID> <HARGA_BARU> <DURASI_JAM>`\n\nContoh: `665d9a... 25000 2`\n\n_(Ketik BATAL untuk membatalkan)_", {parse_mode: "Markdown"});
});

bot.action("admin_search_user", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_search_user';
  return ctx.reply("🔍 *Cari Profil User*\n\nKetik ID Telegram User yang ingin dicek:\n\n_(Ketik BATAL untuk membatalkan)_", {parse_mode: "Markdown"});
});

bot.action("admin_health", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const mongoose = require('mongoose');
  const memUsage = process.memoryUsage();
  let text = `🏥 *System Health Check*\n\n`;
  text += `• MongoDB State: \`${mongoose.connection.readyState}\`\n`;
  text += `• Cron Scheduler: \`${scheduler.isMarketingEnabled() ? 'ACTIVE' : 'INACTIVE'}\`\n`;
  text += `• Uptime: \`${Math.floor(process.uptime())}s\`\n`;
  text += `• Mem (RSS): \`${Math.round(memUsage.rss / 1024 / 1024)} MB\`\n`;
  return ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.action("admin_db_menu", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const text = `⚠️ *Zona Bahaya (Database)*\n\nHati-hati mengeksekusi aksi di bawah ini:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("📦 Backup Manual", "db_action_backup")],
    [Markup.button.callback("🛠 Perbaiki DB", "db_action_fix"), Markup.button.callback("🔥 Reset DB", "db_action_reset")],
    [Markup.button.callback("🔙 Kembali", "admin_system_menu")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/db_action_(backup|fix|reset)/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const act = ctx.match[1];
  if (act === 'backup') {
    await ctx.reply("⏳ Sedang memproses backup...");
    const backupFn = require('./backup');
    await backupFn();
    return ctx.reply("✅ Backup selesai.");
  } else if (act === 'fix') {
    ctx.message = { text: '/fix_db APPLY CONFIRM' }; 
    return handleFixDb(ctx);
  } else if (act === 'reset') {
    ctx.session = ctx.session || {};
    ctx.session.step = 'admin_reset_db';
    return ctx.reply("🔥 *PERINGATAN BAHAYA*\n\nAnda akan MENGHAPUS SEMUA DATA PELANGGAN. Ketik tulisan `SAYA YAKIN RESET DATABASE INI` untuk melanjutkan.", {parse_mode: "Markdown"});
  }
});

bot.action("admin_products", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showAdminProducts(ctx);
});

// Handler tombol CRM Statistik
bot.action("admin_crm_stats", async (ctx) => {
  if (!admin.isAdmin(ctx)) return ctx.answerCbQuery("Ditolak!");
  await ctx.answerCbQuery();
  return admin.showAdminCrmStats(ctx);
});

bot.action("admin_marketing_roi", async (ctx) => {
  if (!admin.isAdmin(ctx)) return ctx.answerCbQuery("Ditolak!");
  await ctx.answerCbQuery();
  return admin.showAdminMarketingRoi(ctx);
});

// Handler tombol Broadcast CRM — UI interaktif
bot.action("admin_crm_menu", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const text = `📢 *Menu Broadcast CRM*\n\nPilih target broadcast Anda:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("📢 Semua User", "broadcast_ui_all")],
    [Markup.button.callback("🛍️ Sudah Beli", "broadcast_ui_buyer"), Markup.button.callback("👤 Belum Beli", "broadcast_ui_nonbuyer")],
    [Markup.button.callback("🔙 Kembali", "admin_main")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/broadcast_ui_(all|buyer|nonbuyer)/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const type = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_broadcast_' + type;
  await ctx.answerCbQuery();
  
  let target = "Semua User";
  if (type === 'buyer') target = "User yang Sudah Membeli";
  if (type === 'nonbuyer') target = "User yang Belum Beli";
  
  return ctx.reply(`📝 *Broadcast ke ${target}*\n\nKetik pesan yang ingin Anda kirimkan sekarang.\n_(Atau ketik BATAL untuk membatalkan)_`, { parse_mode: "Markdown" });
});

// Handler tombol Diskon Otomatis — UI interaktif
bot.action("admin_discount", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const text = `🎟️ *Manajemen Diskon Otomatis*\n\nPilih aksi di bawah ini:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Buat Diskon Baru", "discount_ui_create")],
    [Markup.button.callback("📋 Daftar Diskon", "discount_ui_list")],
    [Markup.button.callback("🔙 Kembali", "admin_marketing_menu")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action("admin_orders", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const recentOrders = await Order.find({ status: 'SUCCESS' }).sort({ _id: -1 }).limit(10).lean();
  let text = `📊 *10 Pesanan Sukses Terakhir*\n\n`;
  if (recentOrders.length === 0) {
    text += "Belum ada pesanan sukses.";
  } else {
    recentOrders.forEach(o => {
      text += `ID: \`${o._id}\`\nTotal: ${formatRupiah(o.total_amount)}\nWaktu: ${o.success_processed_at ? o.success_processed_at.toLocaleString('id-ID') : new Date().toLocaleString('id-ID')}\n\n`;
    });
  }
  const kb = Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "admin_shop_menu")]]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action("discount_ui_list", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  // Hanya ambil diskon manual (yang punya kode), bukan diskon dinamis buatan mesin marketing
  const discounts = await Discount.find({ code: { $exists: true, $ne: null } }).lean();
  if (discounts.length === 0) return ctx.reply("Belum ada diskon manual yang dibuat.");
  
  let text = `🎟️ *Daftar Diskon Manual*\n\n`;
  const buttons = [];
  discounts.forEach(d => {
    text += `🔹 \`${d.code}\` [${d.active ? 'Aktif' : 'Nonaktif'}]\n`;
    text += `Tipe: ${d.type} (${d.value}${d.type === 'PERCENTAGE' ? '%' : ' IDR'})\n`;
    text += `Trigger: \`${d.trigger_event || 'ALL'}\`\n`;
    text += `Terpakai: ${d.used_count} / ${d.max_uses > 0 ? d.max_uses : 'Unlimited'}\n\n`;
    
    buttons.push([
      Markup.button.callback(d.active ? `⏸️ Matikan ${d.code}` : `▶️ Aktifkan ${d.code}`, `toggle_discount_${d.code}`),
      Markup.button.callback(`🗑️ Hapus ${d.code}`, `del_discount_${d.code}`)
    ]);
  });
  
  buttons.push([Markup.button.callback("🔙 Kembali", "admin_discount")]);
  const kb = Markup.inlineKeyboard(buttons);
  
  return ctx.reply(text, { parse_mode: 'Markdown', ...kb });
});

bot.action(/^toggle_discount_(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const code = ctx.match[1];
  const d = await Discount.findOne({ code });
  if (d) {
    d.active = !d.active;
    await d.save();
    await ctx.answerCbQuery(`Diskon ${code} ${d.active ? 'diaktifkan' : 'dimatikan'}!`, { show_alert: true });
    // Hapus pesan lama dan panggil ulang list
    try { await ctx.deleteMessage(); } catch(e){}
    return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'discount_ui_list' } });
  }
});

bot.action(/^del_discount_(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const code = ctx.match[1];
  await Discount.deleteOne({ code });
  await ctx.answerCbQuery(`Diskon ${code} berhasil dihapus!`, { show_alert: true });
  try { await ctx.deleteMessage(); } catch(e){}
  return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'discount_ui_list' } });
});

bot.action("discount_ui_create", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_discount_create';
  const text = `➕ *Buat Diskon Baru*\n\nKetik detail diskon dengan format (dipisah spasi):\n\`KODE TIPE NILAI TRIGGER\`\n\n*Contoh:*\n\`PROMO FIXED 5000 FIRST_TIME\`\n\`LOYAL PERCENTAGE 10 LOYALTY\`\n\`COMEBACK FIXED 10000 CART_ABANDON\`\n\n_(Atau ketik BATAL untuk membatalkan)_`;
  return ctx.reply(text, { parse_mode: "Markdown" });
});

// Add Product flow
bot.action("admin_add_product", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_add_product_name';
  await ctx.answerCbQuery();
  await ctx.reply("📝 Masukkan *Nama Produk*:");
});

bot.action("admin_manage_product", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_manage_product_id';
  await ctx.answerCbQuery();
  await ctx.reply("✏️ Kirimkan *ID Produk* yang ingin diedit atau dihapus:", {parse_mode: "Markdown"});
});

bot.action("admin_header", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_set_header';
  await ctx.answerCbQuery();
  await ctx.reply("🖼 *Ubah Header Menu*\n\nKirimkan langsung sebuah Foto, file GIF, atau Link URL gambar ke chat ini:", {parse_mode: "Markdown"});
});

// [FEATURE] Set foto promo per produk - MULTI MEDIA (album hingga 5 foto/video)
bot.action(/^admin_set_promo_img_(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const productId = ctx.match[1];
  const product = await Product.findById(productId).lean();
  if (!product) return ctx.answerCbQuery('Produk tidak ditemukan!');
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_set_promo_img';
  ctx.session.promo_product_id = productId;
  ctx.session.promo_media_collected = []; // reset koleksi
  await ctx.answerCbQuery();
  const existing = product.promo_media?.length || (product.promo_image_id ? 1 : 0);
  await ctx.reply(
    `📸 *Set Media Promo: ${product.name}*\n\n` +
    `Media saat ini: ${existing > 0 ? `✅ ${existing} media tersimpan` : '❌ Belum ada'}\n\n` +
    `Kirim foto atau video satu per satu (maks *5 media*).\n` +
    `Bot akan tampilkan semua sebagai album ke calon pembeli.\n\n` +
    `• Setelah semua terkirim, ketik *SELESAI*\n` +
    `• Untuk hapus semua media lama, ketik *HAPUS*`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (ctx, next) => {
  // Preview Middleware: tangkap foto/video dari grup VIP untuk cache preview
  await preview.previewMiddleware(ctx, async () => {});

  const session = ctx.session || {};
  if (!session.step) return next();

  // [BUGFIX] Global cancel untuk semua form input
  if (ctx.message && ctx.message.text) {
    const textLower = ctx.message.text.trim().toLowerCase();
    if (['/cancel', '/batal', '/cnncel'].includes(textLower)) {
      ctx.session = {};
      return ctx.reply("✅ Proses input dibatalkan.");
    }
  }

  if (session.step === 'admin_set_header') {
    if (ctx.message.photo) {
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      await store.setSetting("header_type", "photo");
      await store.setSetting("header_file_id", fileId);
    } else if (ctx.message.animation) {
      await store.setSetting("header_type", "animation");
      await store.setSetting("header_file_id", ctx.message.animation.file_id);
    } else if (ctx.message.text && ctx.message.text.startsWith("http")) {
      await store.setSetting("header_type", "url");
      await store.setSetting("header_file_id", ctx.message.text);
    } else {
      return ctx.reply("❌ Harus berupa Foto, GIF, atau Link URL (http...). Coba kirim lagi:");
    }
    ctx.session = {};
    return ctx.reply("✅ Header menu berhasil diperbarui! Cek dengan mengetik /start");
  }

  // [FEATURE] Simpan foto/video promo per produk — MULTI MEDIA MODE
  if (session.step === 'admin_set_promo_img') {
    const productId = session.promo_product_id;
    if (!productId) { ctx.session = {}; return ctx.reply('❌ Sesi tidak valid. Ulangi dari menu.'); }

    // Normalisasi teks: hapus slash di depan, trim spasi, uppercase
    // Jadi "SELESAI", "/SELESAI", "selesai", "/selesai" semua bekerja
    const rawText = ctx.message.text || '';
    const cmd = rawText.trim().toUpperCase().replace(/^\//, '');

    // Ketik HAPUS = bersihkan semua media lama
    if (cmd === 'HAPUS') {
      await Product.findByIdAndUpdate(productId, { promo_media: [], promo_image_id: null, promo_media_type: null });
      ctx.session = {};
      return ctx.reply('🗑 Semua media promo berhasil dihapus. Produk kembali pakai header global.');
    }

    // Ketik SELESAI = simpan semua yang sudah dikumpulkan
    if (cmd === 'SELESAI') {
      const collected = session.promo_media_collected || [];
      if (collected.length === 0) {
        ctx.session = {};
        return ctx.reply('❌ Tidak ada media yang dikirim. Ulangi dari menu.');
      }
      // Simpan ke DB — bypass Mongoose sepenuhnya, tulis langsung via native driver
      // CastError terjadi karena dokumen lama menyimpan promo_media sebagai [String]
      // sedangkan schema baru mengharapkan [{file_id, type}]
      // Native driver tidak melakukan validasi schema → tidak ada CastError
      const mongoose = require('mongoose');
      await mongoose.connection.collection('products').updateOne(
        { _id: productId },
        { $set: {
          promo_media: collected,
          promo_image_id: collected[0].file_id,
          promo_media_type: collected[0].type
        }}
      );
      const prod = await Product.findById(productId).lean();
      // Bersihkan session SEBELUM reply — agar session selalu bersih meski reply gagal
      ctx.session = {};
      // Konfirmasi teks saja (tidak kirim ulang media) — re-send media bisa gagal untuk file besar (>50MB)
      const typeList = collected.map((m, i) => `  ${i+1}. ${m.type === 'video' ? '🎥 Video' : '🖼 Foto'}`).join('\n');
      return ctx.reply(
        `✅ <b>${collected.length} media promo tersimpan untuk ${prod?.name || 'produk ini'}!</b>\n\n` +
        `${typeList}\n\n` +
        `Bot akan pakai media ini sebagai header saat promosikan produk.`,
        { parse_mode: 'HTML' }
      );
    }

    // Terima foto/video satu per satu
    const collected = session.promo_media_collected || [];
    if (collected.length >= 5) {
      return ctx.reply('⚠️ Maksimal 5 media. Ketik *SELESAI* untuk menyimpan atau *HAPUS* untuk mulai ulang.', { parse_mode: 'Markdown' });
    }

    let fileId = null;
    let mediaType = null;

    if (ctx.message.photo) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      mediaType = 'photo';
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
      mediaType = 'video';
    } else if (ctx.message.document) {
      const mime = ctx.message.document.mime_type || '';
      if (mime.startsWith('image/')) { fileId = ctx.message.document.file_id; mediaType = 'photo'; }
      else if (mime.startsWith('video/')) { fileId = ctx.message.document.file_id; mediaType = 'video'; }
      else return ctx.reply('❌ File tidak dikenali. Kirim Foto atau Video saja.');
    } else if (ctx.message.text) {
      // Text lain yang tidak dikenali
      const collected2 = session.promo_media_collected || [];
      return ctx.reply(
        `❌ Tidak dikenali. Kirim foto/video, atau:\n` +
        `• Ketik <b>SELESAI</b> untuk simpan (${collected2.length}/5 media terkumpul)\n` +
        `• Ketik <b>HAPUS</b> untuk mulai ulang`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply('❌ Harus berupa foto atau video.');
    }

    collected.push({ file_id: fileId, type: mediaType });
    session.promo_media_collected = collected;
    ctx.session = session;

    const emoji = mediaType === 'video' ? '🎥' : '🖼';
    return ctx.reply(
      `${emoji} Media ${collected.length}/5 diterima!\n\n` +
      `Kirim media berikutnya atau ketik *SELESAI* untuk menyimpan.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (session.step && session.step.startsWith('admin_broadcast_')) {
    const type = session.step.replace('admin_broadcast_', '');
    const msg = ctx.message.text.trim();
    ctx.session = {}; // reset
    if (msg.toUpperCase() === 'BATAL') return ctx.reply("❌ Aksi dibatalkan.");
    
    if (type === 'all') await runBroadcast(ctx, {}, 'ALL', msg);
    else if (type === 'buyer') await runBroadcast(ctx, { purchase_count: { $gt: 0 } }, 'BUYERS', msg);
    else if (type === 'nonbuyer') await runBroadcast(ctx, { purchase_count: 0 }, 'NON_BUYERS', msg);
    return;
  }

  if (session.step === 'admin_discount_create') {
    const msg = ctx.message.text.trim();
    ctx.session = {}; // reset
    if (msg.toUpperCase() === 'BATAL') return ctx.reply("❌ Aksi dibatalkan.");
    
    const args = msg.split(' ');
    if (args.length < 4) {
      return ctx.reply("❌ Format salah. Aksi dibatalkan. Silakan mulai ulang dari menu.");
    }
    const [code, type, valueStr, trigger_event] = args;
    const value = parseInt(valueStr);
    if (isNaN(value)) return ctx.reply("❌ Nilai diskon harus berupa angka. Aksi dibatalkan.");

    try {
      await Discount.create({
        code,
        type: type.toUpperCase(),
        value,
        trigger_event: trigger_event.toUpperCase()
      });
      return ctx.reply(`✅ Diskon otomatis *${code}* berhasil dibuat!`, { parse_mode: 'Markdown' });
    } catch (err) {
      return ctx.reply(`❌ Gagal membuat diskon: ${err.message}`);
    }
  }

  if (!ctx.message.text) return ctx.reply("❌ Harap kirimkan teks yang sesuai.");

  if (session.step === 'admin_set_msg') {
    const msg = ctx.message.text.trim();
    ctx.session = {};
    if (msg.toUpperCase() === 'BATAL') return ctx.reply("❌ Aksi dibatalkan.");
    const args = msg.split(' ');
    if (args.length < 2) return ctx.reply("Format salah. Batal.");
    const type = args[0].toUpperCase();
    const newMsg = args.slice(1).join(' ');
    await store.setSetting("msg_" + type, newMsg);
    return ctx.reply(`✅ Pesan untuk ${type} berhasil diubah!`);
  }

  if (session.step === 'admin_flash_sale') {
    const msg = ctx.message.text.trim();
    ctx.session = {};
    if (msg.toUpperCase() === 'BATAL') return ctx.reply("❌ Aksi dibatalkan.");
    const args = msg.split(' ');
    if (args.length < 3) return ctx.reply("Format salah. Batal.");
    const [productId, newPriceStr, durationHoursStr] = args;
    const newPrice = parseInt(newPriceStr);
    const durationHours = parseInt(durationHoursStr);
    try {
      const product = await Product.findById(productId);
      if (!product) return ctx.reply("Produk tidak ditemukan.");
      const oldPrice = product.price;
      product.price = newPrice;
      await product.save();
      setTimeout(async () => {
        product.price = oldPrice;
        await product.save();
        bot.telegram.sendMessage(ADMIN_CHAT_ID, `Flash sale produk ${product.name} telah selesai. Harga kembali ke Rp ${oldPrice}`);
      }, durationHours * 3600000);
      return ctx.reply(`✅ Flash Sale untuk ${product.name} aktif selama ${durationHours} jam! Harga diubah jadi Rp ${newPrice}`);
    } catch (err) {
      return ctx.reply(`Gagal: ${err.message}`);
    }
  }

  if (session.step === 'admin_search_user') {
    const msg = ctx.message.text.trim();
    ctx.session = {};
    if (msg.toUpperCase() === 'BATAL') return ctx.reply("❌ Aksi dibatalkan.");
    try {
      const targetUser = await User.findById(msg).lean();
      if (!targetUser) return ctx.reply("❌ User tidak ditemukan di database.");
      const text = `👤 *Data Pelanggan*\n\n` +
                   `ID: \`${targetUser._id}\`\n` +
                   `Nama: ${targetUser.first_name}\n` +
                   `Username: ${targetUser.username}\n` +
                   `Status: ${targetUser.purchase_count > 0 ? '✅ Sudah Beli' : '❌ Belum Beli'}\n` +
                   `Total Belanja: Rp ${targetUser.total_spent ? targetUser.total_spent.toLocaleString('id-ID') : 0}\n` +
                   `Jml Transaksi: ${targetUser.purchase_count}\n` +
                   `Tgl Join: ${targetUser.joined_at ? new Date(targetUser.joined_at).toLocaleString() : '-'}\n` +
                   `Tgl Aktif: ${targetUser.last_active_at ? new Date(targetUser.last_active_at).toLocaleString() : '-'}\n` +
                   `Diblokir: ${targetUser.is_blocked ? 'Ya' : 'Tidak'}`;
      return ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      return ctx.reply("❌ ID tidak valid, harus berupa angka.");
    }
  }

  if (session.step === 'admin_reset_db') {
    const msg = ctx.message.text.trim();
    ctx.session = {};
    if (msg === 'SAYA YAKIN RESET DATABASE INI') {
      ctx.message = { text: '/reset_db APPLY CONFIRM' };
      return handleResetDb(ctx);
    } else {
      return ctx.reply("❌ Teks konfirmasi tidak cocok. Batal.");
    }
  }


  if (session.step === 'admin_manage_product_id') {
    const prodId = ctx.message.text.trim();
    const product = await Product.findById(prodId).lean();
    if (!product) return ctx.reply("❌ Produk tidak ditemukan! Coba lagi:");
    
    session.manageProductId = prodId;
    ctx.session.step = null;
    
    return ctx.reply(`⚙️ *Kelola Produk*\nNama: ${product.name}\nHarga: Rp${product.price}\n\nPilih aksi di bawah ini:`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("Ubah Nama", "edit_prod_name"), Markup.button.callback("Ubah Harga", "edit_prod_price")],
        [Markup.button.callback("Ubah Cuplikan", "edit_prod_preview"), Markup.button.callback("Ubah Isi/Link VIP", "edit_prod_content")],
        [Markup.button.callback("🗑 Hapus Produk", "edit_prod_delete")],
      ])
    });
  }

  if (session.step === 'admin_edit_prod_name') {
    await Product.findByIdAndUpdate(session.manageProductId, { name: ctx.message.text });
    ctx.session = {};
    return ctx.reply("✅ Nama produk berhasil diubah!");
  }
  if (session.step === 'admin_edit_prod_price') {
    const price = parseInt(ctx.message.text);
    if (isNaN(price)) return ctx.reply("❌ Harus berupa angka!");
    await Product.findByIdAndUpdate(session.manageProductId, { price: price });
    ctx.session = {};
    return ctx.reply("✅ Harga produk berhasil diubah!");
  }
  if (session.step === 'admin_edit_prod_preview') {
    let preview = ctx.message.text.trim();
    if (preview.toUpperCase() === 'SKIP' || preview.toUpperCase() === 'HAPUS') preview = null;
    await Product.findByIdAndUpdate(session.manageProductId, { preview_url: preview });
    ctx.session = {};
    return ctx.reply("✅ Link cuplikan produk berhasil diubah!");
  }
  if (session.step === 'admin_edit_prod_content') {
    const newContent = ctx.message.text.trim();
    // [BUGFIX] Validasi: konten harus link atau teks bermakna, bukan angka/teks pendek
    if (!newContent.startsWith('http') && !newContent.startsWith('t.me') && newContent.length < 10) {
      return ctx.reply(`❌ Konten tidak valid: *"${newContent}"*\n\nHarus berupa link Telegram (t.me/...) atau URL (https://...) atau teks minimal 10 karakter.`, { parse_mode: 'Markdown' });
    }
    await Stock.deleteMany({ product_id: session.manageProductId });
    await Stock.create({ product_id: session.manageProductId, content: newContent, status: 'AVAILABLE' });
    ctx.session = {};
    return ctx.reply("✅ Isi konten/Link VIP berhasil diperbarui! Pembeli berikutnya akan menerima link baru ini.");
  }

  if (session.step === 'admin_add_product_name') {
    session.newProductName = ctx.message.text;
    session.step = 'admin_add_product_price';
    return ctx.reply("💰 Masukkan *Harga Produk* (hanya angka):");
  }
  if (session.step === 'admin_add_product_price') {
    const price = parseInt(ctx.message.text);
    if (isNaN(price)) return ctx.reply("Harus berupa angka!");
    session.newProductPrice = price;
    session.step = 'admin_add_product_preview';
    return ctx.reply("👀 Masukkan *Link Cuplikan* produk ini (misal: link telegra.ph, link gambar, dll).\nAtau ketik *SKIP* jika tidak ada cuplikan:");
  }
  if (session.step === 'admin_add_product_preview') {
    let preview = ctx.message.text.trim();
    if (preview.toUpperCase() === 'SKIP') preview = null;
    session.newProductPreview = preview;
    session.step = 'admin_add_product_type';
    return ctx.reply("🛒 Tipe Produk: AUTO atau MANUAL?\n(AUTO = Kirim langsung jika ada stok, MANUAL = Perlu konfirmasi admin)", Markup.inlineKeyboard([
      [Markup.button.callback("AUTO", "set_type_auto"), Markup.button.callback("MANUAL", "set_type_manual")]
    ]));
  }
  if (session.step === 'admin_add_stock_id') {
    session.stockProductId = ctx.message.text;
    session.step = 'admin_add_stock_content';
    return ctx.reply("Kirim isi stok (pisahkan tiap stok dengan Enter baris baru):\n\n⚠️ *PENTING:* Stok adalah LINK FILE VIP atau KONTEN AKSES yang akan dikirim ke pembeli. **Bukan sekadar angka jumlah.**\n\nContoh:\n`https://t.me/+AbcDefg123`\n`https://drive.google.com/...`\n\n*(Ketik /cancel jika ingin membatalkan)*", { parse_mode: 'Markdown' });
  }
  if (session.step === 'admin_add_stock_content') {
    const allLines = ctx.message.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // [BUGFIX] Validasi konten stok: harus berupa URL atau teks bermakna, bukan angka kosong
    const validLines = allLines.filter(l => l.startsWith('http') || l.startsWith('t.me') || l.length > 10);
    const invalidLines = allLines.filter(l => !validLines.includes(l));
    
    if (validLines.length === 0) {
      return ctx.reply(`❌ *Tidak ada stok valid yang ditambahkan!*\n\nKonten stok harus berupa link (https://... atau t.me/...) atau teks minimal 10 karakter.\n\nYang Anda kirim:\n${allLines.map(l => '• ' + l).join('\n')}`, { parse_mode: 'Markdown' });
    }
    
    let added = 0;
    for (const c of validLines) {
      await Stock.create({ product_id: session.stockProductId, content: c, status: 'AVAILABLE' });
      added++;
    }
    ctx.session = {};
    let replyMsg = `✅ Berhasil menambahkan *${added} stok* untuk produk ID \`${session.stockProductId}\``;
    if (invalidLines.length > 0) {
      replyMsg += `\n\n⚠️ *${invalidLines.length} baris dilewati* (terlalu pendek atau bukan link):\n${invalidLines.map(l => '• ' + l).join('\n')}`;
    }
    return ctx.reply(replyMsg, { parse_mode: 'Markdown' });
  }

  if (session.step === 'admin_add_product_content') {
    const newContent = ctx.message.text.trim();
    // [BUGFIX] Validasi konten produk baru
    if (!newContent.startsWith('http') && !newContent.startsWith('t.me') && newContent.length < 10) {
      return ctx.reply(`❌ Konten tidak valid: *"${newContent}"*\n\nHarus berupa link Telegram (t.me/...) atau URL (https://...) atau teks minimal 10 karakter.`, { parse_mode: 'Markdown' });
    }
    const id = "PROD-" + Date.now();
    await Product.create({
      _id: id,
      name: session.newProductName || "Tanpa Nama",
      price: session.newProductPrice || 0,
      type: session.newProductType || "AUTO",
      preview_url: session.newProductPreview || null
    });
    
    await Stock.create({ product_id: id, content: newContent, status: 'AVAILABLE' });
    
    ctx.session = {};
    return ctx.reply(`✅ Produk berhasil ditambahkan beserta Link VIP-nya!\n\nID: \`${id}\`\nNama: ${session.newProductName}\nHarga: Rp${session.newProductPrice}\nTipe: ${session.newProductType}`, {parse_mode: "Markdown"});
  }
  return next();
});

bot.action(/set_type_(auto|manual)/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return; // [BUGFIX] Admin check yang hilang!
  const type = ctx.match[1].toUpperCase();
  ctx.session = ctx.session || {};
  ctx.session.newProductType = type;
  ctx.session.step = 'admin_add_product_content';
  await ctx.answerCbQuery();
  await ctx.reply("🔗 Terakhir, masukkan *Isi Konten / Link VIP* (link grup Telegram, link drive, dll) yang akan otomatis dikirimkan ke pembeli setelah sukses membayar:", {parse_mode: "Markdown"});
});

bot.action(/edit_prod_(name|price|preview|content|delete)/, async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const action = ctx.match[1];
  const prodId = ctx.session.manageProductId;
  if (!prodId) return ctx.reply("❌ Sesi telah habis. Ulangi dari menu Kelola Produk.");
  
  if (action === 'delete') {
    await Product.findByIdAndDelete(prodId);
    await Stock.deleteMany({ product_id: prodId });
    ctx.session = {};
    await ctx.answerCbQuery("Produk Dihapus!");
    return ctx.reply("🗑 Produk beserta stoknya berhasil dihapus secara permanen.");
  }
  
  ctx.session.step = `admin_edit_prod_${action}`;
  await ctx.answerCbQuery();
  if (action === 'name') return ctx.reply("📝 Masukkan *Nama Produk* yang baru:", {parse_mode: "Markdown"});
  if (action === 'price') return ctx.reply("💰 Masukkan *Harga Produk* yang baru (hanya angka):", {parse_mode: "Markdown"});
  if (action === 'preview') return ctx.reply("👀 Masukkan *Link Cuplikan* yang baru, atau ketik *HAPUS* untuk menghilangkan cuplikan:", {parse_mode: "Markdown"});
  if (action === 'content') return ctx.reply("🔗 Kirimkan *Isi Konten / Link VIP* yang baru.\nIni akan menggantikan konten lama yang dikirimkan ke pembeli:", {parse_mode: "Markdown"});
});

bot.action("admin_stocks", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_add_stock_id';
  await ctx.reply("Kirim *ID Produk* yang ingin ditambahkan stoknya:", {parse_mode: "Markdown"});
});

// ======== STORE LOGIC ========
bot.start(async (ctx) => {
  try { await ctx.deleteMessage(); } catch (e) {}
  await trackEvent(ctx.from.id, 'START');
  ctx.session = {};
  return showStoreMenu(ctx);
});

bot.action("menu_main", async (ctx) => {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch(e) {}
  return showStoreMenu(ctx);
});

bot.action("menu_main_keep", async (ctx) => {
  await ctx.answerCbQuery();
  // Sama seperti menu_main, TAPI JANGAN HAPUS PESAN INI! 
  // Agar link produk yang dibeli pembeli tidak hilang saat mereka klik kembali ke menu.
  return showStoreMenu(ctx);
});

async function showStoreMenu(ctx) {
  const userId = ctx.from.id;
  const user = await User.findById(userId).lean();

  if (user && user.last_menu_msg_id) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, user.last_menu_msg_id); } catch (e) {}
  }

  const products = await store.getActiveProducts();
  const discountText = await store.getMenuDiscountText(userId);

  // Social proof dari data real
  const totalBuyers = await User.countDocuments({ purchase_count: { $gt: 0 } });
  const milestone = Math.ceil((totalBuyers + 1) / 50) * 50;
  const slotsLeft = milestone - totalBuyers;

  // Teks menu utama — DNA: subtitle dikerjakan sendiri, koleksi terus berkembang
  const text = [
    `🇮🇩 <b>J-SUB COLLECTION — Subtitle Project</b>\n`,
    `Kami tidak hanya mengumpulkan video yang sudah punya subtitle Indonesia.`,
    `<b>Tim J-SUB mengerjakan subtitle sendiri — untuk memperluas koleksi.</b>\n`,
    `✅ <b>${totalBuyers}+ member</b> sudah punya akses ke koleksi yang terus berkembang.`,
    `⚠️ Harga opening berlaku sampai slot ke-<b>${milestone}</b>. Sisa <b>${slotsLeft} slot</b>.`,
    discountText ? discountText.trim() : '',
    `\n👇 Pilih akses VIP kamu:`,
  ].filter(Boolean).join('\n');

  const buttons = [];
  const formatK = (num) => num >= 1000 ? (num/1000) + 'k' : num.toString();
  const strikethrough = (str) => str.split('').join('\u0336') + '\u0336';

  for (const p of products) {
    // Tombol preview jika ada
    if (p.preview_url) {
      buttons.push([Markup.button.url(`👁 Preview ${p.name}`, p.preview_url)]);
    }
    const discount = await store.applyAutomaticDiscount(userId, p._id, p.price);
    let btnText = `🛒 ${p.name} — Rp${formatK(p.price)}`;
    if (discount) {
      const finalPrice = Math.max(0, p.price - discount.deduction);
      const originalK = formatK(p.price);
      const numPart = originalK.replace('k', '');
      const kPart = originalK.includes('k') ? 'k' : '';
      btnText = `🔥 ${p.name} — ${strikethrough(numPart)}${kPart}  ➜  Rp${formatK(finalPrice)}`;
    }
    buttons.push([Markup.button.callback(btnText, `buy_now_${p._id}`)]);
  }

  // Bundle button
  try {
    const successOrds = await Order.find({ user_id: userId, status: 'SUCCESS' }).lean();
    const boughtIds   = new Set();
    if (successOrds.length) {
      const ordIds  = successOrds.map(o => o._id);
      const items   = await OrderItem.find({ order_id: { $in: ordIds } }).lean();
      items.forEach(i => boughtIds.add(String(i.product_id)));
    }
    const unbought = products.filter(p => !boughtIds.has(String(p._id)));
    if (unbought.length >= 2) {
      const BUNDLE_DISC = 20;
      const totalNormal = unbought.reduce((s, p) => s + (p.price || 0), 0);
      const totalBundle = Math.floor(totalNormal * (1 - BUNDLE_DISC / 100));
      const saving      = totalNormal - totalBundle;
      const shortIds    = unbought.map(p => String(p._id).slice(0, 8)).join('-');
      const formatRp    = n => n.toLocaleString('id-ID');
      buttons.push([
        Markup.button.callback(
          `🎁 BELI SEMUA (HEMAT ${BUNDLE_DISC}%) — Rp${formatRp(totalBundle)}`,
          `buy_bndl_${shortIds}`
        )
      ]);
    }
  } catch(e) { /* skip bundle jika error */ }

  // Tombol chat admin — ambil username admin dari env atau fallback
  const adminTg = process.env.ADMIN_TELEGRAM_USERNAME || process.env.SAWERIA_USERNAME || 'zahwafe';
  buttons.push([Markup.button.url('💬 Tanya Admin', `https://t.me/${adminTg}`)]);

  const keyboard = Markup.inlineKeyboard(buttons);
  const hType = await store.getSetting('header_type', 'url');
  const hFile = await store.getSetting('header_file_id', 'https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif');

  let sentMsg;
  if (hType === 'photo' || (hType === 'url' && hFile.match(/\.(jpeg|jpg|png)$/i))) {
    sentMsg = await ctx.replyWithPhoto(hFile, { caption: text, parse_mode: 'HTML', ...keyboard });
  } else {
    sentMsg = await ctx.replyWithAnimation(hFile, { caption: text, parse_mode: 'HTML', ...keyboard });
  }

  await User.findByIdAndUpdate(userId, { last_menu_msg_id: sentMsg.message_id });
  return sentMsg;
}

const checkoutLocks = new Set();
bot.action(/^buy_now_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (checkoutLocks.has(userId)) {
    return ctx.reply("⏳ Sistem sedang memproses pesanan Anda sebelumnya, mohon tunggu beberapa detik...");
  }
  checkoutLocks.add(userId);

  let msg = null;
  try {
    const productId = ctx.match[1];

    // [AKSI #4] VIEW_PRODUCT event tracking — catat siapa yang lihat produk sebelum checkout
    trackEvent(userId, 'VIEW_PRODUCT', productId, { source: 'buy_now_button' }).catch(() => {});
    // [BUGFIX 3] Anti-DoS & Spam Checkout Limiter (Per Produk)
    const pendingOrders = await Order.find({ 
      user_id: userId, 
      status: 'PENDING', 
      created_at: { $gte: new Date(Date.now() - 15 * 60 * 1000) } 
    }).lean();

    let hasPendingSameProduct = false;
    for (const order of pendingOrders) {
      const itemExists = await OrderItem.findOne({ order_id: order._id, product_id: productId }).lean();
      if (itemExists) {
        hasPendingSameProduct = true;
        break;
      }
    }
    
    if (hasPendingSameProduct) {
      return ctx.reply("⚠️ *Tunggu Dulu!* Anda masih memiliki pesanan QRIS yang sedang aktif (belum dibayar) untuk produk ini.\n\nSilakan selesaikan pembayaran sebelumnya, atau tunggu sekitar 15 menit hingga QR Code tersebut kedaluwarsa sebelum memesan produk yang sama lagi.", { parse_mode: 'Markdown' });
    }

    await trackEvent(userId, 'CHECKOUT', productId);
    
    await store.clearCart(userId);
    await store.addToCart(userId, productId);
    
    const items = await store.getCart(userId);
    if (items.length === 0) return ctx.reply("❌ Produk tidak tersedia!");

    let amount = await store.getCartTotal(userId);
    logger.checkout.attempt(userId, productId, amount);
    msg = await ctx.reply("⏳ Menyiapkan pembayaran QRIS...");

    let buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "Pembeli");
    if (buyerName.length > 30) buyerName = buyerName.substring(0, 30);
    
    // Cek diskon otomatis
    let discountInfo = "";
    const discount = await store.applyAutomaticDiscount(userId, productId, amount);
    if (discount) {
      amount = Math.max(0, amount - discount.deduction);
      discountInfo = `\n🎁 *Diskon Otomatis:* -${formatRupiah(discount.deduction)}`;
      // NOTE: used_count di-increment saat payment SUCCESS (bukan saat checkout PENDING)
      // agar kuota diskon tidak terpakai untuk order yang tidak jadi dibayar
    } else {
      // [BUGFIX] Cek apakah user punya diskon yang BARU saja expired (dalam 24 jam terakhir)
      // Jika ya, beri tahu user dengan jelas agar tidak bingung kenapa harga berubah
      const recentlyExpired = await Discount.findOne({
        target_user_id: Number(userId),
        active: false,
        valid_until: { $lt: new Date(), $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }).lean();

      if (recentlyExpired) {
        discountInfo = `\n\n⚠️ *Catatan:* Kupon diskon ${recentlyExpired.value}% Anda sudah kedaluwarsa. Anda ditagih harga normal.`;
      }
    }
    
    // Hitung harga dasar (Base Amount) agar penjual menerima harga bersih 100%
    const baseAmount = calculateBaseAmount(amount);
    
    // [BUGFIX] Zero-Price Checkout (Diskon 100% / Gratis)
    if (baseAmount <= 0) {
      logger.info(`[CHECKOUT] Zero-price detected for user ${userId}. Bypassing Saweria.`);
      const donationId = 'FREE-' + Date.now();
      const orderId = await store.createOrder(donationId, userId, 0, items, discount ? discount._id : null);
      await store.clearCart(userId);
      
      // Langsung mark as SUCCESS & panggil onPaymentSuccess (bypass Saweria QRIS)
      await Order.findByIdAndUpdate(orderId, { status: 'SUCCESS', success_processed_at: new Date() });
      await scheduler.markDripConverted(userId, 0);
      const deliveries = await store.fulfillOrder(orderId);
      
      let deliveryText = `✅ *Pesanan Berhasil! (Gratis)*\n\n🎉 Terima kasih atas pesanan Anda. Berikut adalah produk yang Anda klaim:\n\n`;
      deliveries.forEach((d, i) => {
        if (d.content.trim().startsWith('http')) deliveryText += `🎁 *PRODUK ${i+1}:*\n👉 [KLIK DI SINI UNTUK MENGAKSES](${d.content.trim()}) 👈\n\n`;
        else deliveryText += `🎁 *PRODUK ${i+1}:*\n\`${d.content}\`\n\n`;
      });
      
      try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch(e){}
      return ctx.reply(deliveryText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main_keep")]])
      });
    }

    // Kirim harga dasar ke Saweria. Saweria akan otomatis menambahkan fee QRIS (Payment Gateway) di atas harga dasar ini.
    const donationMessage = "Beli " + productId + " [UID:" + userId + "]";
    const donation = await createDonation(baseAmount, "pembeli@bot.com", buyerName, donationMessage);
    
    // donation.amount_raw berisi harga akhir = Base Amount + Fee QRIS dari Saweria
    const finalAmount = donation.amount_raw || baseAmount;
    
    const orderId = await store.createOrder(donation.id, userId, finalAmount, items, discount ? discount._id : null);
    await store.clearCart(userId);

    const qrPath = await generateQRImage(donation.qr_string, donation.id);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

    logger.checkout.qrCreated(userId, orderId, finalAmount, donation.id);
    
    // Hitung jam expire spesifik untuk ditampilkan ke user
    const expireTime = new Date(Date.now() + 15 * 60 * 1000);
    const expireStr = expireTime.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

    const qrCaption = [
      `✅ <b>Pesanan kamu sudah terkunci!</b>`,
      ``,
      `Order ID: <code>${orderId}</code>`,
      `💵 Harga: <s>${formatRupiah(items[0].price)}</s>${discountInfo ? ' → ' + discountInfo.replace(/[*_]/g,'') : ''}`,
      `💸 Biaya QRIS: +${formatRupiah(finalAmount - amount)}`,
      `💳 <b>Total Bayar: ${formatRupiah(finalAmount)}</b>`,
      ``,
      `📱 <b>Cara bayar (30 detik selesai):</b>`,
      `1️⃣ Buka GoPay / OVO / DANA / BCA Mobile / m-Banking apapun`,
      `2️⃣ Pilih <b>"Scan QR"</b> atau <b>"Bayar QRIS"</b>`,
      `3️⃣ Arahkan kamera ke kode di atas → konfirmasi`,
      ``,
      `✅ Akses VIP langsung dikirim otomatis ke chat ini`,
      `⏱ QR aktif sampai pukul <b>${expireStr} WIB</b>`,
      ``,
      `🔒 Pembayaran aman via Bank Indonesia (QRIS Nasional)`,
    ].join('\n');
    const qrMsg = await sendPhotoToTelegram(ctx.chat.id, qrPath, qrCaption, 'HTML');
    // [BUGFIX] Hapus file QR sementara dari disk (/tmp) setelah berhasil dikirim
    try { fs.unlink(qrPath, () => {}); } catch (e) {}

    const adminTgHandle = process.env.ADMIN_TELEGRAM_USERNAME || 'zahwafe';
    const statusMsg = await ctx.telegram.sendMessage(ctx.chat.id,
      `⏳ <b>Menunggu konfirmasi pembayaran...</b>\n\nSistem kami memantau secara otomatis. Begitu QRIS dikonfirmasi, link akses VIP langsung masuk ke chat ini — tidak perlu lapor ke admin.\n\n💬 Ada masalah saat scan?`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
        { text: '💬 Hubungi Admin', url: `https://t.me/${adminTgHandle}` }
      ]]}}
    );

    await Order.findByIdAndUpdate(orderId, {
      qr_msg_id: qrMsg ? qrMsg.message_id : null,
      status_msg_id: statusMsg ? statusMsg.message_id : null
    });
    
    activeIntervals[donation.id] = pollPaymentStatus(ctx, donation.id, ctx.chat.id, statusMsg.message_id, orderId, qrMsg ? qrMsg.message_id : null);
  } catch (err) {
    const errMsg = err.message || String(err);
    const isUserBlocked = errMsg.includes('403') || errMsg.includes('Forbidden') || errMsg.includes('bot was blocked');
    const isTelegramError = errMsg.includes('Bad Request') || errMsg.includes('query is too old');

    if (isUserBlocked) {
      // User memblokir bot — ini bukan bug sistem, tapi user action
      logger.warn(`[CHECKOUT] User ${userId} memblokir bot saat proses checkout. Order di-cancel.`);
      // Tandai user sebagai blocked di DB
      await User.findByIdAndUpdate(userId, { is_blocked: true }).catch(() => {});
      // Expire order jika sudah dibuat (agar tidak stuck PENDING)
      if (typeof orderId !== 'undefined' && orderId) {
        await Order.findByIdAndUpdate(orderId, { status: 'EXPIRED' }).catch(() => {});
      }
      // Notif admin: info bukan error
      await notifyAdmin(
        `ℹ️ <b>User Memblokir Bot Saat Checkout</b>\n\nUser: <code>${userId}</code>\nOrder di-cancel otomatis. Tidak perlu tindakan.`,
        'HTML'
      );
    } else if (isTelegramError) {
      // Telegram Bad Request — sering terjadi karena message kadaluwarsa, bukan bug
      logger.warn(`[CHECKOUT] Telegram API error (non-critical): ${errMsg.slice(0, 150)}`);
    } else {
      // Error sistem nyata — baru kirim alert ke admin
      logger.error('Checkout error:', errMsg);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
      await notifyAdmin(`⚠️ <b>Checkout Error (Sistem)</b>\n\nUser: <code>${ctx.from.id}</code>\nError: <code>${errMsg.slice(0, 300)}</code>`, 'HTML');
      try {
        await ctx.reply(`❌ Gagal menyiapkan pembayaran.\n\nCoba lagi dalam beberapa menit atau hubungi admin.`, {
          reply_markup: { inline_keyboard: [[{ text: '💬 Hubungi Admin', url: `https://t.me/${process.env.ADMIN_TELEGRAM_USERNAME || 'zahwafe'}` }]] }
        });
      } catch (_) {}
    }
  } finally {
    checkoutLocks.delete(userId);
  }
});


// ─── BUNDLE: Beli Semua Produk Sekaligus ───────────────────────────────────
// [FIX] Updated ke buy_bndl_ (short prefix) agar callback < 64 char Telegram limit
bot.action(/^buy_bndl_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🎁 Menyiapkan QRIS Paket Bundle...');
  const userId = ctx.from.id;

  if (checkoutLocks.has(userId)) {
    return ctx.reply("⏳ Sistem sedang memproses pesanan Anda sebelumnya, mohon tunggu beberapa detik...");
  }
  checkoutLocks.add(userId);

  let msg = null;
  try {
    const shortIds = ctx.match[1].split('-').filter(Boolean);
    const allProds = await Product.find({ active: 1 }).lean();
    const products = allProds.filter(p =>
      shortIds.some(sid => String(p._id).startsWith(sid))
    );
    const finalProducts = products.length > 0 ? products : allProds;
    if (!finalProducts.length) {
      return ctx.reply('❌ Produk tidak ditemukan.');
    }

    // [BUGFIX] Anti-DoS & Spam Checkout Limiter untuk Bundle
    const pendingOrders = await Order.find({ 
      user_id: userId, 
      status: 'PENDING', 
      created_at: { $gte: new Date(Date.now() - 15 * 60 * 1000) } 
    }).lean();

    let hasPendingBundle = false;
    for (const order of pendingOrders) {
      const orderItems = await OrderItem.find({ order_id: order._id }).lean();
      if (orderItems.length > 1) { // Asumsi order > 1 item adalah bundle
        hasPendingBundle = true;
        break;
      }
    }

    if (hasPendingBundle) {
      return ctx.reply("⚠️ *Tunggu Dulu!* Anda masih memiliki pesanan QRIS yang sedang aktif untuk paket Bundle.\n\nSilakan selesaikan pembayaran sebelumnya, atau tunggu sekitar 15 menit hingga QR Code kedaluwarsa.", { parse_mode: 'Markdown' });
    }

    await trackEvent(userId, 'CHECKOUT', 'BUNDLE');

    await store.clearCart(userId);
    for (const p of finalProducts) {
      await store.addToCart(userId, String(p._id));
    }

    const items = await store.getCart(userId);
    if (items.length === 0) return ctx.reply("❌ Produk tidak tersedia!");

    let amount = await store.getCartTotal(userId);
    logger.info(`[CHECKOUT] User ${userId} memulai checkout untuk BUNDLE seharga ${amount}`);
    msg = await ctx.reply("⏳ Menyiapkan pembayaran QRIS Bundle...");

    let buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "Pembeli");
    if (buyerName.length > 30) buyerName = buyerName.substring(0, 30);

    const BUNDLE_DISC = 20;

    // Apply bundle discount
    await Discount.deleteMany({ target_user_id: Number(userId), type: 'BUNDLE' });
    const discount = await Discount.create({
      target_user_id: Number(userId),
      type:           'BUNDLE',
      value:          BUNDLE_DISC,
      valid_until:    new Date(Date.now() + 72 * 60 * 60 * 1000),
      active:         true
    });

    let discountInfo = "";
    const deduction = Math.floor(amount * (BUNDLE_DISC / 100));
    amount = Math.max(0, amount - deduction);
    discountInfo = `\n🎁 *Diskon Bundle 20%:* -${formatRupiah(deduction)}`;
    
    const baseAmount = calculateBaseAmount(amount);

    if (baseAmount <= 0) {
      logger.info(`[CHECKOUT] Zero-price detected for user ${userId} BUNDLE. Bypassing Saweria.`);
      const donationId = 'FREE-BNDL-' + Date.now();
      const orderId = await store.createOrder(donationId, userId, 0, items, discount._id);
      await store.clearCart(userId);
      
      await Order.findByIdAndUpdate(orderId, { status: 'SUCCESS', success_processed_at: new Date() });
      await scheduler.markDripConverted(userId, 0);
      const deliveries = await store.fulfillOrder(orderId);
      
      let deliveryText = `✅ *Pesanan Bundle Berhasil! (Gratis)*\n\n🎉 Terima kasih atas pesanan Anda. Berikut adalah produk yang Anda klaim:\n\n`;
      deliveries.forEach((d, i) => {
        if (d.content.trim().startsWith('http')) deliveryText += `🎁 *PRODUK ${i+1}:*\n👉 [KLIK DI SINI UNTUK MENGAKSES](${d.content.trim()}) 👈\n\n`;
        else deliveryText += `🎁 *PRODUK ${i+1}:*\n\`${d.content}\`\n\n`;
      });
      
      try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch(e){}
      return ctx.reply(deliveryText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main_keep")]])
      });
    }

    const donationMessage = "Beli BUNDLE [UID:" + userId + "]";
    const donation = await createDonation(baseAmount, "pembeli@bot.com", buyerName, donationMessage);
    
    const finalAmount = donation.amount_raw || baseAmount;
    
    const orderId = await store.createOrder(donation.id, userId, finalAmount, items, discount._id);
    await store.clearCart(userId);

    const qrPath = await generateQRImage(donation.qr_string, donation.id);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

    logger.success(`[CHECKOUT] QR Code sukses dibuat untuk Order ID ${orderId} (BUNDLE)`);
    
    const totalNormal = items.reduce((s, i) => s + (i.price * i.quantity), 0);
    const caption = `🧾 *Detail Pembayaran BUNDLE*\n\nOrder ID: \`${orderId}\`\n💵 *Harga Asli: ${formatRupiah(totalNormal)}*${discountInfo}\n💸 *Pajak Platform & QRIS: ${formatRupiah(finalAmount - amount)}*\n💳 *Total Bayar: ${formatRupiah(finalAmount)}*\n\n📱 Scan QR ini menggunakan aplikasi E-Wallet / M-Banking Anda.\n\n⏳ Berlaku 15 menit.`;
    const qrMsg = await sendPhotoToTelegram(ctx.chat.id, qrPath, caption);
    try { fs.unlink(qrPath, () => {}); } catch (e) {}

    const statusMsg = await ctx.replyWithMarkdown(`⏳ *Menunggu Pembayaran...*\nSistem akan memproses pesanan otomatis setelah pembayaran sukses.`);

    await Order.findByIdAndUpdate(orderId, {
      qr_msg_id: qrMsg ? qrMsg.message_id : null,
      status_msg_id: statusMsg ? statusMsg.message_id : null
    });
    
    activeIntervals[donation.id] = pollPaymentStatus(ctx, donation.id, ctx.chat.id, statusMsg.message_id, orderId, qrMsg ? qrMsg.message_id : null);
  } catch (err) {
    const errMsg = err.message || String(err);
    logger.error("Checkout BUNDLE error:", errMsg);
    try { if (msg) await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
    await notifyAdmin(`⚠️ *Checkout Bundle Error*\n\nUser: ${ctx.from.id}\nError: \`${errMsg.slice(0, 300)}\``);
    await ctx.reply(`❌ Gagal menyiapkan pembayaran bundle.\n\nError: \`${errMsg.slice(0, 200)}\`\n\nCoba lagi dalam beberapa menit.`, { parse_mode: "Markdown" });
  } finally {
    checkoutLocks.delete(userId);
  }
});





// [CONVERSION] Handler tombol "Buat QR Baru" dari pesan expire/reminder
bot.action(/^reorder_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Membuat QR baru...');
  const oldOrderId = ctx.match[1];
  try {
    const oldOrder = await Order.findById(oldOrderId).lean();
    if (!oldOrder) return ctx.reply('❌ Order tidak ditemukan. Silakan mulai dari menu utama.');
    // Arahkan user ke menu utama untuk checkout ulang
    await ctx.reply('🔄 Silakan pilih produk dari menu untuk checkout ulang:', { parse_mode: 'HTML' });
    return showStoreMenu(ctx);
  } catch (e) {
    return showStoreMenu(ctx);
  }
});

// [CONVERSION] Handler tombol "Batalkan" dari reminder
bot.action(/^cancel_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Dibatalkan.');
  try {
    const orderId = ctx.match[1];
    await Order.findByIdAndUpdate(orderId, { status: 'EXPIRED' });
  } catch (_) {}
  await ctx.editMessageText('❌ Checkout dibatalkan.\n\nKapan pun mau kembali, ketuk /start ya!', { parse_mode: 'HTML' });
});

bot.on('text', async (ctx, next) => {
  // Hanya respon di private chat, hindari spam jika bot masuk grup
  if (ctx.chat && ctx.chat.type !== 'private') return next();
  
  // Jika ini bukan perintah command (tidak berawalan /)
  if (!ctx.message.text.startsWith('/')) {
    try { await ctx.deleteMessage(); } catch (e) {}
    await trackEvent(ctx.from.id, 'START');
    ctx.session = {};
    return showStoreMenu(ctx);
  }
  return next();
});

bot.catch((err, ctx) => {
  logger.error(`bot.catch:`, err.message);
});

async function handleTestPay(ctx) {
  if (!ADMIN_CHAT_ID || ctx.from.id.toString() !== ADMIN_CHAT_ID.toString()) {
    return replySafe(ctx, `❌ Akses ditolak! Perintah ini hanya untuk Admin utama.\nID Anda saat ini: \`${ctx.from.id}\`\nSedangkan ID Admin di .env: \`${ADMIN_CHAT_ID}\``, { parse_mode: "Markdown" });
  }
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return replySafe(ctx, "Format: `/testpay <ORDER_ID>`\nContoh: `/testpay ORD-12345`", { parse_mode: "Markdown" });
  
  const orderId = args[1];
  const order = await store.getOrder(orderId);
  if (!order) return ctx.reply("❌ Order ID tidak ditemukan di database.");
  if (order.status === "SUCCESS") return ctx.reply("⚠️ Order ini sudah berstatus SUCCESS.");

  await ctx.reply(`🔄 [QA TEST: PAY-03]\nMemalsukan status pembayaran gateway...\n✅ Mocking API Status: SETTLEMENT / PAID / CAPTURE\n✅ Mengeksekusi callback success untuk ${orderId}...`);
  await onPaymentSuccess(ctx, ctx.chat.id, order.status_msg_id, order.donation_id, orderId, order.qr_msg_id);
}

bot.command("testpay", async (ctx) => {
  return handleTestPay(ctx);
});

// ADMIN: Force trigger marketing (Untuk testing / mempercepat jadwal Drip)
bot.command('force_marketing', async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.reply("⏳ Memaksa mesin automasi marketing berjalan sekarang juga...");

  try {
    const stats = await scheduler.runMarketingCampaign(bot, 'forced_' + Date.now());

    // stats.skipped === true hanya jika marketing dimatikan admin
    if (stats.skipped === true) {
      await ctx.reply(`⚠️ *Marketing Dimatikan.*\nAlasan: ${stats.reason}\n\nKetik /marketing\\_on untuk mengaktifkan.`, { parse_mode: 'Markdown' });
      return;
    }

    // Campaign berjalan — tampilkan hasil ringkas
    const cartAbandonTotal = (stats.cartAbandon1h||0) + (stats.cartAbandon3h||0) + (stats.cartAbandon12h||0);
    const total = (stats.cold || 0) + (stats.abandon || 0) + (stats.inactive || 0) +
                  (stats.crossSell || 0) + (stats.stage2 || 0) + (stats.stage3 || 0) + (stats.vipWinBack || 0) +
                  cartAbandonTotal + (stats.flashSaleSent || 0);
    let msg = `✅ *Marketing Selesai!*\n\n`;
    msg += `📨 *Total Pesan Terkirim:* ${total}\n\n`;
    if (stats.stage2)          msg += `• Stage 2 (Urgensi): ${stats.stage2} user\n`;
    if (stats.stage3)          msg += `• Stage 3 (Diskon Final): ${stats.stage3} user\n`;
    if (stats.cold)            msg += `• Cold Lead (Baru): ${stats.cold} user\n`;
    if (stats.abandon)         msg += `• Cart Abandon (lama): ${stats.abandon} user\n`;
    if (stats.inactive)        msg += `• Inactive: ${stats.inactive} user\n`;
    if (stats.crossSell)       msg += `• Cross-Sell: ${stats.crossSell} user\n`;
    if (stats.vipWinBack)      msg += `• VIP Win-Back: ${stats.vipWinBack} user\n`;
    if (cartAbandonTotal > 0)  msg += `• 🔴 Cart Abandon Recovery: ${cartAbandonTotal} user (1h:${stats.cartAbandon1h||0} 3h:${stats.cartAbandon3h||0} 12h:${stats.cartAbandon12h||0})\n`;
    if (stats.flashSaleSent)   msg += `• ⚡ Flash Sale Blast: ${stats.flashSaleSent} user\n`;
    if (stats.skipped)         msg += `\n⏭ Diskip (cooldown): ${stats.skipped}\n`;
    if (stats.failed)          msg += `❌ Gagal kirim: ${stats.failed}\n`;
    if (total === 0)           msg += `\n_Semua user dalam cooldown atau tidak ada yang memenuhi syarat._`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ *Gagal:* ${err.message}`);
  }
});

async function resumePendingOrders() {
  try {
    // [BUGFIX] Gunakan 14 menit (< MAX_WAIT_MINUTES=15) agar tidak merujuk order yang sudah expired
    const fourteenMinsAgo = new Date(Date.now() - 14 * 60 * 1000);
    const pendingOrders = await Order.find({ status: 'PENDING', created_at: { $gte: fourteenMinsAgo } }).lean();
    
    if (pendingOrders.length > 0) {
      logger.info(`[AUTO-RESUME] Menemukan ${pendingOrders.length} order PENDING. Melanjutkan polling...`);
      for (const order of pendingOrders) {
        if (!order.donation_id) continue;
        const mockCtx = { telegram: bot.telegram };
        // [BUGFIX] Simpan interval ke activeIntervals agar bisa di-stop oleh stopPolling()
        activeIntervals[order.donation_id] = pollPaymentStatus(mockCtx, order.donation_id, order.user_id, order.status_msg_id, order._id, order.qr_msg_id);
      }
    }
  } catch (err) {
    logger.error("[AUTO-RESUME] Gagal memuat order PENDING:", err.message);
  }
}

if (process.env.NODE_ENV !== "test") {
  // startSaweriaSSE(bot, onPaymentSuccess); // Dinonaktifkan karena sudah pindah ke Webhook
  scheduler.startCron(bot);
  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      logger.success("Bot Toko Otomatis berjalan!");
      resumePendingOrders();
    })
    .catch((err) => {
      if (err.message && err.message.includes('409')) {
        logger.error("409 Conflict: Bot sudah berjalan di tempat lain. Mematikan diri agar Coolify merestart (Graceful Shutdown)!");
        process.exit(1);
      } else {
        logger.error("Gagal menjalankan bot:", err.message);
        process.exit(1);
      }
    });

  const http = require("http");
  const PORT = process.env.PORT || 3000;
  http.createServer(async (req, res) => {
    // === ENDPOINT WEBHOOK SAWERIA ===
    if (req.method === "POST" && req.url.startsWith("/webhook")) {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          console.log("[WEBHOOK] Raw Payload:", body);
          
          let items = [];
          if (payload.data && Array.isArray(payload.data)) items = payload.data;
          else if (payload.data) items = [payload.data];
          else items = [payload]; // Kadang payload langsung di root

          if (items.length > 0) {
            for (const item of items) {
              const amount = parseInt(item.amount_raw || item.amount);
              const donator = item.donator_name || item.donator || "Seseorang";
              const msg = item.message || "";
              
              console.log(`[WEBHOOK] Menerima donasi dari ${donator}: Rp${amount}`);
              
              const match = msg.match(/\[UID:(\d+)\]/);
              if (match && match[1]) {
                const userId = parseInt(match[1]);
                console.log(`[WEBHOOK] UID Terdeteksi: ${userId}`);
                
                // [BUGFIX] Cocokkan donation_id agar webhook lama tidak picu order baru yang salah
                const donationIdFromWebhook = item.id || item.donation_id || null;
                let order = null;
                if (donationIdFromWebhook) {
                  order = await Order.findOne({ user_id: userId, donation_id: donationIdFromWebhook, status: 'PENDING' });
                }
                // [BUGFIX] HANYA match by donation_id - tidak ada fallback ke latest PENDING
                // Fallback berbahaya: bisa fulfill order lain secara tidak sengaja
                if (!order && donationIdFromWebhook) {
                  logger.warn(`[WEBHOOK] donation_id ${donationIdFromWebhook} tidak cocok dengan order PENDING manapun. Abaikan.`);
                }
                
                if (order) {
                  const TOLERANCE = 500; // Toleransi Rp500 untuk perbedaan pembulatan fee QRIS
                  if (amount < (order.total_amount - TOLERANCE)) {
                    const textKurang = `⚠️ *PEMBAYARAN TIDAK SESUAI*\n\nSistem mendeteksi dana masuk sebesar *Rp${amount}*, namun total tagihan pesanan Anda adalah *Rp${order.total_amount}*.\n\nPesanan DIBATALKAN. Silakan hubungi admin.`;
                    bot.telegram.sendMessage(userId, textKurang, { parse_mode: "Markdown" }).catch(() => {});
                    await Order.findByIdAndUpdate(order._id, { status: 'FAILED' });
                  } else {
                    console.log(`[WEBHOOK] Memproses order ${order._id}`);
                    const mockCtx = { telegram: bot.telegram };
                    await onPaymentSuccess(mockCtx, userId, order.status_msg_id, order.donation_id, order._id, order.qr_msg_id);
                  }
                }
              } else {
                if (process.env.ADMIN_CHAT_ID) {
                  const text = `🔔 *WEBHOOK SAWERIA AMAN!*\nBot menerima sinyal (Test/Manual):\nDari: ${donator}\nJumlah: Rp${amount}\nPesan: ${msg}\n\n_Sistem Webhook berjalan sempurna!_`;
                  bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text, { parse_mode: "Markdown" })
                    .then(() => console.log("[WEBHOOK] Pesan sukses dikirim ke admin!"))
                    .catch((e) => console.error("[WEBHOOK] GAGAL kirim ke admin:", e.message));
                } else {
                  console.log("[WEBHOOK] ADMIN_CHAT_ID tidak disetting.");
                }
              }
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success" }));
        } catch (e) {
          console.error("[WEBHOOK] Error:", e.message);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is alive! Webhook is ready at /webhook");
  }).listen(PORT, () => {
    logger.info(`🌐 HTTP Server & Webhook berjalan di port ${PORT}`);
  });

  // ── [HEALTH CHECK] Jalankan saat startup + setiap jam ─────────────────────
  const dbModule = require('./database');

  // Fix DB: buat unique index DripLog agar duplikat tidak bisa masuk lagi
  (async () => {
    try {
      // Tunggu koneksi DB siap (race condition fix)
      const mongoose = require('mongoose');
      let attempts = 0;
      while ((!mongoose.connection.db) && attempts++ < 20) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (!mongoose.connection.db) throw new Error('DB not ready after 10s');
      const col = mongoose.connection.db.collection('driplogs');
      const indexes = await col.indexes();
      const hasUniq = indexes.some(i => i.unique && i.key && i.key.user_id && i.key.campaign_type && i.key.stage);
      if (!hasUniq) {
        const dups = await require('./database').DripLog.aggregate([
          { $group: { _id: { u: '$user_id', c: '$campaign_type', s: '$stage' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } }
        ]);
        let deleted = 0;
        for (const d of dups) {
          await require('./database').DripLog.deleteMany({ _id: { $in: d.ids.slice(1) } });
          deleted += d.ids.length - 1;
        }
        if (deleted > 0) logger.info(`[DB] Auto-deleted ${deleted} DripLog duplicates before unique index`);
        await col.createIndex({ user_id: 1, campaign_type: 1, stage: 1 }, { unique: true, background: true });
        logger.success('[DB] Unique index DripLog dibuat — duplikat tidak bisa masuk lagi');
      }
    } catch (e) {
      logger.warn('[DB] Unique index DripLog: ' + e.message);
    }

    // Auto-expire stuck PENDING orders saat startup
    try {
      const stuck = await Order.find({ status: 'PENDING', created_at: { $lt: new Date(Date.now() - 20 * 60000) } }).lean();
      for (const o of stuck) {
        await Order.findByIdAndUpdate(o._id, { status: 'EXPIRED' });
        logger.warn(`[STARTUP] Auto-expired stuck PENDING: ${o._id} (user: ${o.user_id})`);
      }
      if (stuck.length > 0) logger.info(`[STARTUP] Total expired: ${stuck.length} stuck PENDING orders`);
    } catch (e) {
      logger.warn('[STARTUP] Auto-expire error: ' + e.message);
    }

    // Health check startup
    await logger.system.healthCheck(dbModule);
  })().catch(e => logger.warn('[STARTUP] Init error: ' + e.message));

  // Health check setiap jam (jam 01 WIB = sync dengan cron marketing)
  const cron = require('node-cron');
  cron.schedule('0 * * * *', async () => {
    await logger.system.healthCheck(dbModule);
  }, { timezone: 'Asia/Jakarta' });

  // Daily summary jam 23:55 WIB
  cron.schedule('55 23 * * *', () => {
    logger.summary();
  }, { timezone: 'Asia/Jakarta' });

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('Menerima SIGINT, mematikan bot...');
    bot.stop('SIGINT');
    require('mongoose').disconnect();
  });
  
  process.once('SIGTERM', () => {
    logger.info('Menerima SIGTERM, mematikan bot...');
    bot.stop('SIGTERM');
    require('mongoose').disconnect();
  });
}


module.exports = {
  bot,
  calculateBaseAmount,
  createDonation,
  checkPaymentStatus,
  onPaymentSuccess,
  handleFixDb,
  handleResetDb,
  handleTestPay
};
