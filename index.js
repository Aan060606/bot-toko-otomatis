require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const { startSaweriaSSE } = require("./saweria-sse");
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, BroadcastLog } = require("./database");
const store = require("./store");
const admin = require("./admin");
const scheduler = require("./scheduler");

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

const logger = {
  _ts() { return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }); },
  info(...m) { console.log(`[${this._ts()}] ℹ️ `, ...m); },
  success(...m) { console.log(`[${this._ts()}] ✅`, ...m); },
  warn(...m) { console.warn(`[${this._ts()}] ⚠️ `, ...m); },
  error(...m) { console.error(`[${this._ts()}] ❌`, ...m); },
};

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
      logger.warn("Browser terputus/crash! Mengatur ulang instance...");
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
     logger.warn("Terkena challenge Cloudflare. Mengambil clearance ulang...");
     await page.goto('https://backend.saweria.co/', { waitUntil: 'networkidle2' });
     try { await page.waitForFunction(() => document.title !== 'Just a moment...', { timeout: 15000 }); } catch(e) { }
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
bot.use(session());

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

async function sendPhotoToTelegram(chatId, photoPath, caption) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', require('fs').createReadStream(photoPath));
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  const res = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
  return res.data.result;
}

async function notifyAdmin(text) {
  if (process.env.NODE_ENV === "test") return;
  if (!ADMIN_CHAT_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown" }); } catch (e) {}
}

async function onPaymentSuccess(ctx, chatId, msgId, donationId, orderId, qrMsgId) {
  logger.info(`[PAYMENT] Memproses pembayaran sukses untuk Order ID ${orderId}`);
  stopPolling(donationId);
  if (qrMsgId) {
    logger.info(`[PAYMENT] Menghapus pesan QR Code (${qrMsgId}) di chat ${chatId}`);
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
    let deliveryText = `✅ *Pembayaran Berhasil!*\n\n🎉 Terima kasih atas pesanan Anda. Berikut adalah produk yang Anda beli:\n\n`;
    
    deliveries.forEach((d, i) => {
      if (d.content.trim().startsWith('http')) {
        deliveryText += `🎁 *PRODUK ${i+1}:*\n👉 [KLIK DI SINI UNTUK MENGAKSES](${d.content.trim()}) 👈\n\n`;
      } else {
        deliveryText += `🎁 *PRODUK ${i+1}:*\n\`${d.content}\`\n\n`;
      }
    });

    try {
      await ctx.telegram.editMessageText(chatId, msgId, null, deliveryText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main_keep")]])
      });
    } catch (err) {
      logger.warn(`[PAYMENT] editMessageText gagal (${err.message}). Fallback ke sendMessage.`);
      try {
        await ctx.telegram.sendMessage(chatId, deliveryText, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main_keep")]])
        });
      } catch (err2) {
        logger.error(`[PAYMENT] sendMessage fallback GAGAL (${err2.message}). Mengirim tanpa Markdown!`);
        await ctx.telegram.sendMessage(chatId, deliveryText.replace(/[*_`\[\]()]/g, ""), {
          ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main_keep")]])
        });
      }
    }

    await notifyAdmin(`💳 *PESANAN SELESAI*\n\nOrder ID: \`${orderId}\`\nRef: \`${donationId}\``);
    logger.success(`[PAYMENT] Produk berhasil dikirim ke User ${chatId} untuk Order ID ${orderId}`);
    
    // Update User CRM Stats
    const order = await Order.findById(orderId).lean();
    if (order) {
      await User.findByIdAndUpdate(chatId, {
        $inc: { purchase_count: 1, total_spent: order.total_amount }
      });
      await trackEvent(chatId, 'PAYMENT_SUCCESS', null, { order_id: orderId, total_amount: order.total_amount });
      if (order.discount_id) {
        const { Discount } = require('./database');
        await Discount.findByIdAndUpdate(order.discount_id, { $inc: { used_count: 1 } });
      }
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
  const totalMs = MAX_WAIT_MINUTES * 60 * 1000;

  const interval = setInterval(async () => {
    try {
      const secondsLeft = Math.max(0, Math.floor((totalMs - (Date.now() - startTime)) / 1000));
      const data = await checkPaymentStatus(donationId);
      const rawStatus = (data?.status || "").toUpperCase();

      if (["SUCCESS", "SETTLEMENT", "PAID", "CAPTURE"].includes(rawStatus)) {
        await onPaymentSuccess(ctx, chatId, msgId, donationId, orderId, qrMsgId);
      } else if (["FAILED", "EXPIRED", "CANCEL", "FAILURE", "DENY"].includes(rawStatus)) {
        stopPolling(donationId);
        try { await Order.findByIdAndUpdate(orderId, { status: 'FAILED' }); } catch (e) {}
        if (qrMsgId) try { await ctx.telegram.deleteMessage(chatId, qrMsgId); } catch (_) {}
        try { await ctx.telegram.editMessageText(chatId, msgId, null, `❌ Pembayaran Gagal/Dibatalkan. Silakan checkout ulang.`, { parse_mode: "Markdown" }); } catch (_) {}
      } else if (secondsLeft <= 0) {
        stopPolling(donationId);
        try { await Order.findByIdAndUpdate(orderId, { status: 'EXPIRED' }); } catch (e) {}
        if (qrMsgId) try { await ctx.telegram.deleteMessage(chatId, qrMsgId); } catch (_) {}
        try { await ctx.telegram.editMessageText(chatId, msgId, null, `⏰ Waktu bayar habis. QR Code telah ditarik. Silakan checkout ulang.`, { parse_mode: "Markdown" }); } catch (_) {}
      }
    } catch (err) {}
  }, CHECK_INTERVAL_MS);
  
  return interval;
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
                 
    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply("❌ ID tidak valid, harus berupa angka.");
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
  
  ctx.reply(text, { parse_mode: 'Markdown' });
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
    ctx.reply(`✅ Diskon otomatis *${code}* berhasil dibuat!`, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Gagal membuat diskon: ${err.message}`);
  }
});

bot.command("deletediscount", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  const code = ctx.message.text.replace('/deletediscount', '').trim();
  if (!code) return ctx.reply("Format: /deletediscount <KODE>");
  
  await Discount.deleteOne({ code });
  ctx.reply(`🗑️ Diskon *${code}* berhasil dihapus!`, { parse_mode: 'Markdown' });
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
  
  ctx.reply(text, { parse_mode: 'Markdown' });
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
  ctx.reply(text, { parse_mode: 'Markdown' });
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
  
  ctx.reply(`✅ *Database berhasil dibersihkan!*\n\nData yang diperbaiki:\n- Kolom belanja: ${res1.modifiedCount} user\n- Kolom blokir: ${res2.modifiedCount} user\n\nAudit log telah disimpan.`, { parse_mode: 'Markdown' });
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

  ctx.reply("✅ *DATABASE BERHASIL DI-RESET!*\n\nSemua riwayat user telah bersih kembali menjadi 0. Silakan klik /start untuk memulai sebagai user pertama yang bersih!", { parse_mode: 'Markdown' });
}

bot.command("reset_db", async (ctx) => {
  return handleResetDb(ctx);
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
    ctx.reply("▶️ Memaksa Marketing jalan sekarang...");
    const stats = await scheduler.runDripFollowUp();
    return ctx.reply(`✅ Selesai. Stats: ${JSON.stringify(stats)}`);
  } else if (action === 'test') {
    ctx.reply("🧪 Mengirim test marketing ke Anda...");
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
    ctx.reply("⏳ Sedang memproses backup...");
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
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showAdminCrmStats(ctx);
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

bot.on('message', async (ctx, next) => {
  const session = ctx.session || {};
  if (!session.step) return next();

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
    const newContent = ctx.message.text;
    await Stock.deleteMany({ product_id: session.manageProductId });
    await Stock.create({ product_id: session.manageProductId, content: newContent });
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
    return ctx.reply("Kirim isi stok (pisahkan tiap stok dengan Enter baris baru):");
  }
  if (session.step === 'admin_add_stock_content') {
    const contents = ctx.message.text.split('\n').filter(l => l.trim().length > 0);
    let added = 0;
    for (const c of contents) {
      await Stock.create({ product_id: session.stockProductId, content: c });
      added++;
    }
    ctx.session = {};
    return ctx.reply(`✅ Berhasil menambahkan ${added} stok untuk produk ID ${session.stockProductId}`);
  }

  if (session.step === 'admin_add_product_content') {
    const newContent = ctx.message.text;
    const id = "PROD-" + Date.now();
    await Product.create({
      _id: id,
      name: session.newProductName || "Tanpa Nama",
      price: session.newProductPrice || 0,
      type: session.newProductType || "AUTO",
      preview_url: session.newProductPreview || null
    });
    
    await Stock.create({ product_id: id, content: newContent });
    
    ctx.session = {};
    return ctx.reply(`✅ Produk berhasil ditambahkan beserta Link VIP-nya!\n\nID: \`${id}\`\nNama: ${session.newProductName}\nHarga: Rp${session.newProductPrice}\nTipe: ${session.newProductType}`, {parse_mode: "Markdown"});
  }
  return next();
});

bot.action(/set_type_(auto|manual)/, async (ctx) => {
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
  const text = `⛩️ 𝐉-𝐒𝐔𝐁 𝐂𝐎𝐋𝐋𝐄𝐂𝐓𝐈𝐎𝐍 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 𝐇𝐮𝐛 ⛩️\n「 プレミアムアクセス • 𝑷𝒓𝒆𝒎𝒊𝒖𝒎 𝑨𝒄𝒄𝒆𝒔𝒔 」\n\nSilakan pilih lisensi VIP Anda di bawah ini ⚜️:\n\n_24/7 ON SIAP MELAYANI_${discountText}`;
  const buttons = [];
  
  const formatK = (num) => num >= 1000 ? (num/1000) + 'k' : num.toString();
  const strikethrough = (str) => str.split('').join('\u0336') + '\u0336';

  for (const p of products) {
    if (p.preview_url) {
      buttons.push([Markup.button.url(`📺 Preview Content ${p.name}`, p.preview_url)]);
    }
    
    const discount = await store.applyAutomaticDiscount(userId, p._id, p.price);
    let btnText = `🛒 Beli ${p.name} • Rp${formatK(p.price)}`;
    
    if (discount) {
      const finalPrice = Math.max(0, p.price - discount.deduction);
      const originalK = formatK(p.price);
      const numPart = originalK.replace('k', '');
      const kPart = originalK.includes('k') ? 'k' : '';
      btnText = `🛒 Beli ${p.name} • ${strikethrough(numPart)}${kPart}  ➔  Rp${formatK(finalPrice)}`;
    }
    
    buttons.push([Markup.button.callback(btnText, `buy_now_${p._id}`)]);
  }
  
  if (process.env.ADMIN_CHAT_ID) {
    buttons.push([Markup.button.url("👨‍💻 HUBUNGI ADMIN JIKA GANGGUAN", `tg://user?id=${process.env.ADMIN_CHAT_ID}`)]);
  }
  
  const keyboard = Markup.inlineKeyboard(buttons);
  const hType = await store.getSetting("header_type", "url");
  const hFile = await store.getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");
  
  let sentMsg;
  if (hType === "photo" || (hType === "url" && hFile.match(/\.(jpeg|jpg|png)$/i))) {
    sentMsg = await ctx.replyWithPhoto(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
  } else {
    sentMsg = await ctx.replyWithAnimation(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
  }
  
  await User.findByIdAndUpdate(userId, { last_menu_msg_id: sentMsg.message_id });
  return sentMsg;
}

bot.action(/^buy_now_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const productId = ctx.match[1];
  const userId = ctx.from.id;
  
  await trackEvent(userId, 'CHECKOUT', productId);
  
  await store.clearCart(userId);
  await store.addToCart(userId, productId);
  
  const items = await store.getCart(userId);
  if (items.length === 0) return ctx.reply("❌ Produk tidak tersedia!");

  let amount = await store.getCartTotal(userId);
  logger.info(`[CHECKOUT] User ${userId} memulai checkout untuk product ${productId} seharga ${amount}`);
  const msg = await ctx.reply("⏳ Menyiapkan pembayaran QRIS...");

  try {
    const buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "Pembeli");
    
    // Cek diskon otomatis
    let discountInfo = "";
    const discount = await store.applyAutomaticDiscount(userId, productId, amount);
    if (discount) {
      amount = Math.max(0, amount - discount.deduction);
      discountInfo = `\n🎁 *Diskon Otomatis:* -${formatRupiah(discount.deduction)}`;
    }
    
    // Hitung harga dasar (Base Amount) agar penjual menerima harga bersih 100%
    const baseAmount = calculateBaseAmount(amount);
    
    // Kirim harga dasar ke Saweria. Saweria akan otomatis menambahkan fee QRIS (Payment Gateway) di atas harga dasar ini.
    const donationMessage = "Beli " + productId + " [UID:" + userId + "]";
    const donation = await createDonation(baseAmount, "pembeli@bot.com", buyerName, donationMessage);
    
    // donation.amount_raw berisi harga akhir = Base Amount + Fee QRIS dari Saweria
    const finalAmount = donation.amount_raw || baseAmount;
    
    const orderId = await store.createOrder(donation.id, userId, finalAmount, items, discount ? discount._id : null);
    await store.clearCart(userId);

    const qrPath = await generateQRImage(donation.qr_string, donation.id);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}

    logger.success(`[CHECKOUT] QR Code sukses dibuat untuk Order ID ${orderId}`);
    
    const caption = `🧾 *Detail Pembayaran*\n\nOrder ID: \`${orderId}\`\n💵 *Harga Asli: ${formatRupiah(items[0].price)}*${discountInfo}\n💸 *Pajak Platform & QRIS: ${formatRupiah(finalAmount - amount)}*\n💳 *Total Bayar: ${formatRupiah(finalAmount)}*\n\n📱 Scan QR ini menggunakan aplikasi E-Wallet / M-Banking Anda.\n\n⏳ Berlaku 15 menit.`;
    const qrMsg = await sendPhotoToTelegram(ctx.chat.id, qrPath, caption);

    const statusMsg = await ctx.replyWithMarkdown(`⏳ *Menunggu Pembayaran...*\nSistem akan memproses pesanan otomatis setelah pembayaran sukses.`);

    await Order.findByIdAndUpdate(orderId, {
      qr_msg_id: qrMsg ? qrMsg.message_id : null,
      status_msg_id: statusMsg ? statusMsg.message_id : null
    });
    
    activeIntervals[donation.id] = pollPaymentStatus(ctx, donation.id, ctx.chat.id, statusMsg.message_id, orderId, qrMsg ? qrMsg.message_id : null);
  } catch (err) {
    const errMsg = err.message || String(err);
    logger.error("Checkout error:", errMsg);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
    // Kirim error detail ke admin untuk debugging
    await notifyAdmin(`⚠️ *Checkout Error*\n\nUser: ${ctx.from.id}\nError: \`${errMsg.slice(0, 300)}\``);
    await ctx.reply(`❌ Gagal menyiapkan pembayaran.\n\nError: \`${errMsg.slice(0, 200)}\`\n\nCoba lagi dalam beberapa menit.`, { parse_mode: "Markdown" });
  }
});

// Fallback untuk semua pesan teks yang tidak dikenali
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

if (process.env.NODE_ENV !== "test") {
  // startSaweriaSSE(bot, onPaymentSuccess); // Dinonaktifkan karena sudah pindah ke Webhook
  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      logger.success("Bot Toko Otomatis berjalan!");
      // Mulai cron job marketing otomatis setiap hari jam 10.00 WIB
      scheduler.startCron(bot);
    })
    .catch((err) => {
      if (err.message && err.message.includes('409')) {
        logger.error("409 Conflict: Bot sudah berjalan di tempat lain. Pastikan tidak ada instance lain yang aktif.");
        // Retry after 15 seconds instead of crashing
        setTimeout(() => {
          logger.info("Mencoba restart bot...");
          bot.launch({ dropPendingUpdates: true }).then(() => logger.success("Bot berhasil restart!")).catch(e => {
            logger.error("Gagal restart:", e.message);
            // Jangan process.exit(1) agar Webhook tetap hidup!
          });
        }, 15000);
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
              const amount = parseInt(item.amount);
              const donator = item.donator_name || item.donator || "Seseorang";
              const msg = item.message || "";
              
              console.log(`[WEBHOOK] Menerima donasi dari ${donator}: Rp${amount}`);
              
              const match = msg.match(/\[UID:(\d+)\]/);
              if (match && match[1]) {
                const userId = parseInt(match[1]);
                console.log(`[WEBHOOK] UID Terdeteksi: ${userId}`);
                
                const order = await Order.findOne({ user_id: userId, status: 'PENDING' }).sort({ created_at: -1 });
                if (order) {
                  if (amount < order.total_amount) {
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
