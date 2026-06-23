require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { execFile } = require("child_process");
const { Telegraf, Markup, session } = require("telegraf");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const db = require("./database");
const store = require("./store");
const admin = require("./admin");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;
const SAWERIA_USERNAME = process.env.SAWERIA_USERNAME || "zahwafe";
const SAWERIA_USER_ID = process.env.SAWERIA_USER_ID || "d8e876df-405c-4e08-9708-9808b9037ea5";
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

const CURL_HEADERS = [
  "-H", "Accept: */*",
  "-H", "Accept-Encoding: gzip, deflate, br, zstd",
  "-H", "Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "-H", "DNT: 1",
  "-H", "Origin: https://saweria.co",
  "-H", "Priority: u=1, i",
  "-H", "Referer: https://saweria.co/",
  "-H", "Sec-Fetch-Dest: empty",
  "-H", "Sec-Fetch-Mode: cors",
  "-H", "Sec-Fetch-Site: same-site",
  "-H", 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "-H", "sec-ch-ua-mobile: ?0",
  "-H", "sec-ch-ua-platform: \"Windows\"",
  "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
];

function curlPost(url, body) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--compressed", "-m", "30", "-X", "POST", url, "-H", "Content-Type: application/json", ...CURL_HEADERS, "-d", JSON.stringify(body)];
    execFile("curl", args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`Non-JSON response: ${stdout.slice(0, 200)}`)); }
    });
  });
}

function curlGet(url) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--compressed", "-m", "30", url, ...CURL_HEADERS];
    execFile("curl", args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`Non-JSON response: ${stdout.slice(0, 200)}`)); }
    });
  });
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

const SAWERIA_API = "https://backend.saweria.co";

async function calculateAmount(amount) {
  return withRetry(async () => {
    const payload = { agree: true, notUnderage: true, message: "Order Toko", amount, payment_type: "qris", vote: "", currency: "IDR", customer_info: { first_name: "bot", email: "bot@bot.bot", phone: "" } };
    const res = await curlPost(`${SAWERIA_API}/donations/${SAWERIA_USERNAME}/calculate_pg_amount`, payload);
    if (!res?.data?.amount_to_pay) throw new Error("calculateAmount: respons tidak valid");
    return res.data;
  });
}

async function createDonation(amount, email, name, message) {
  return withRetry(async () => {
    const payload = { agree: true, notUnderage: true, message: message || "-", amount, payment_type: "qris", vote: "", currency: "IDR", customer_info: { first_name: name, email, phone: "" } };
    const res = await curlPost(`${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`, payload);
    if (!res?.data?.qr_string) throw new Error("createDonation: respons tidak valid");
    return res.data;
  });
}

async function checkPaymentStatus(donationId) {
  try {
    const res = await curlGet(`${SAWERIA_API}/donations/qris/snap/${donationId}`);
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

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown" }); } catch (e) {}
}

async function onPaymentSuccess(ctx, chatId, msgId, donationId, orderId) {
  stopPolling(donationId);
  try {
    // Process Delivery
    const deliveries = store.fulfillOrder(orderId);
    let deliveryText = `✅ *Pembayaran Berhasil!*\n\n🎉 Terima kasih atas pesanan Anda. Berikut adalah produk yang Anda beli:\n\n`;
    
    deliveries.forEach((d, i) => {
      deliveryText += `${i+1}. Produk ID: \`${d.product_id}\`\n   Isi: ${d.content}\n\n`;
    });

    await ctx.telegram.editMessageText(chatId, msgId, null, deliveryText, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main")]])
    });

    await notifyAdmin(`💳 *PESANAN SELESAI*\n\nOrder ID: \`${orderId}\`\nRef: \`${donationId}\``);
  } catch (e) {
    logger.error(e);
  }
}

function pollPaymentStatus(ctx, donationId, chatId, msgId, orderId) {
  const startTime = Date.now();
  const totalMs = MAX_WAIT_MINUTES * 60 * 1000;

  const interval = setInterval(async () => {
    try {
      const secondsLeft = Math.max(0, Math.floor((totalMs - (Date.now() - startTime)) / 1000));
      const data = await checkPaymentStatus(donationId);
      const rawStatus = (data?.status || "").toUpperCase();

      if (["SUCCESS", "SETTLEMENT", "PAID", "CAPTURE"].includes(rawStatus)) {
        await onPaymentSuccess(ctx, chatId, msgId, donationId, orderId);
      } else if (["FAILED", "EXPIRED", "CANCEL", "FAILURE", "DENY"].includes(rawStatus)) {
        stopPolling(donationId);
        try { await ctx.telegram.editMessageText(chatId, msgId, null, `❌ Pembayaran Gagal/Kedaluwarsa.`, { parse_mode: "Markdown" }); } catch (_) {}
      } else if (secondsLeft <= 0) {
        stopPolling(donationId);
        try { await ctx.telegram.editMessageText(chatId, msgId, null, `⏰ Waktu bayar habis.`, { parse_mode: "Markdown" }); } catch (_) {}
      }
    } catch (err) {}
  }, CHECK_INTERVAL_MS);
  
  return interval;
}

// User Registration Middleware
bot.use((ctx, next) => {
  if (ctx.from) {
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(ctx.from.id);
    if (!user) {
      db.prepare("INSERT INTO users (id, first_name, username) VALUES (?, ?, ?)").run(ctx.from.id, ctx.from.first_name || '', ctx.from.username || '');
    }
  }
  return next();
});

// Admin Command
bot.command("admin", async (ctx) => {
  if (!admin.isAdmin(ctx)) return ctx.reply("⛔ Akses ditolak.");
  return admin.showAdminMenu(ctx);
});

bot.action("admin_main", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showAdminMenu(ctx, true);
});

bot.action("admin_products", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  return admin.showAdminProducts(ctx);
});

// Add Product flow
bot.action("admin_add_product", async (ctx) => {
  if (!admin.isAdmin(ctx)) return;
  ctx.session = ctx.session || {};
  ctx.session.step = 'admin_add_product_name';
  await ctx.answerCbQuery();
  await ctx.reply("📝 Masukkan *Nama Produk*:");
});

bot.on('text', async (ctx, next) => {
  const session = ctx.session || {};
  if (session.step === 'admin_add_product_name') {
    session.newProductName = ctx.message.text;
    session.step = 'admin_add_product_price';
    return ctx.reply("💰 Masukkan *Harga Produk* (hanya angka):");
  }
  if (session.step === 'admin_add_product_price') {
    const price = parseInt(ctx.message.text);
    if (isNaN(price)) return ctx.reply("Harus berupa angka!");
    session.newProductPrice = price;
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
    const insert = db.prepare("INSERT INTO stocks (product_id, content) VALUES (?, ?)");
    let added = 0;
    db.transaction(() => {
      for (const c of contents) { insert.run(session.stockProductId, c); added++; }
    })();
    ctx.session = {};
    return ctx.reply(`✅ Berhasil menambahkan ${added} stok untuk produk ID ${session.stockProductId}`);
  }
  return next();
});

bot.action(/set_type_(auto|manual)/, async (ctx) => {
  const type = ctx.match[1].toUpperCase();
  const session = ctx.session;
  const id = "PROD-" + Date.now();
  db.prepare("INSERT INTO products (id, name, price, type) VALUES (?, ?, ?, ?)").run(id, session.newProductName, session.newProductPrice, type);
  ctx.session = {};
  await ctx.answerCbQuery();
  await ctx.reply(`✅ Produk berhasil ditambahkan!\n\nID: \`${id}\`\nNama: ${session.newProductName}\nHarga: ${session.newProductPrice}\nTipe: ${type}`, {parse_mode: "Markdown"});
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
  ctx.session = {};
  return showStoreMenu(ctx);
});

bot.action("menu_main", async (ctx) => {
  await ctx.answerCbQuery();
  return showStoreMenu(ctx, true);
});

function showStoreMenu(ctx, edit = false) {
  const text = `🏪 *Selamat Datang di Toko Otomatis 24/7*\n\nSilakan pilih menu:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🛍 Belanja Produk", "store_products")],
    [Markup.button.callback("🛒 Lihat Keranjang", "store_cart")],
  ]);
  if (edit) return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  return ctx.replyWithMarkdown(text, keyboard);
}

bot.action("store_products", async (ctx) => {
  await ctx.answerCbQuery();
  const products = store.getActiveProducts();
  let text = `🛍 *Katalog Produk*\n\nPilih produk untuk ditambah ke keranjang:\n\n`;
  const buttons = [];
  products.forEach(p => {
    text += `- *${p.name}* (${formatRupiah(p.price)})\n`;
    buttons.push([Markup.button.callback(`➕ ${p.name}`, `add_cart_${p.id}`)]);
  });
  buttons.push([Markup.button.callback("🔙 Kembali", "menu_main")]);
  
  await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^add_cart_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  store.addToCart(ctx.from.id, productId);
  await ctx.answerCbQuery("✅ Berhasil ditambahkan ke keranjang!");
});

bot.action("store_cart", async (ctx) => {
  await ctx.answerCbQuery();
  const items = store.getCart(ctx.from.id);
  if (items.length === 0) {
    return ctx.editMessageText("🛒 Keranjang belanja Anda kosong.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_main")]]));
  }
  
  let text = `🛒 *Keranjang Belanja*\n\n`;
  items.forEach(item => {
    text += `- ${item.name} (x${item.quantity}) - ${formatRupiah(item.price * item.quantity)}\n`;
  });
  text += `\n💰 *Total: ${formatRupiah(store.getCartTotal(ctx.from.id))}*`;
  
  await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard([
    [Markup.button.callback("💳 Checkout Sekarang", "store_checkout")],
    [Markup.button.callback("🗑 Kosongkan Keranjang", "store_clear_cart")],
    [Markup.button.callback("🔙 Kembali", "menu_main")]
  ])});
});

bot.action("store_clear_cart", async (ctx) => {
  store.clearCart(ctx.from.id);
  await ctx.answerCbQuery("🗑 Keranjang dikosongkan.");
  return showStoreMenu(ctx, true);
});

bot.action("store_checkout", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const items = store.getCart(userId);
  if (items.length === 0) return ctx.reply("Keranjang kosong!");

  const amount = store.getCartTotal(userId);
  const msg = await ctx.reply("⏳ Menyiapkan pembayaran QRIS...");

  try {
    const calc = await calculateAmount(amount);
    const donation = await createDonation(amount, "pembeli@bot.com", ctx.from.first_name || "Pembeli", "Checkout Toko");
    
    const orderId = store.createOrder(donation.id, userId, calc.amount_to_pay, items);
    store.clearCart(userId);

    const qrPath = await generateQRImage(donation.qr_string, donation.id);
    
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
    await ctx.replyWithPhoto({ source: qrPath }, {
      caption: `🧾 *Detail Pembayaran*\n\nOrder ID: \`${orderId}\`\n💵 *Total Bayar: ${formatRupiah(calc.amount_to_pay)}*\n\n📱 Scan QR ini menggunakan aplikasi E-Wallet / M-Banking Anda.\n\n⏳ Berlaku 15 menit.`,
      parse_mode: "Markdown"
    });

    const statusMsg = await ctx.replyWithMarkdown(`⏳ *Menunggu Pembayaran...*\nSistem akan memproses pesanan otomatis setelah pembayaran sukses.`);
    
    activeIntervals[donation.id] = pollPaymentStatus(ctx, donation.id, ctx.chat.id, statusMsg.message_id, orderId);

  } catch (err) {
    logger.error("Checkout error:", err.message);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, "❌ Gagal menyiapkan pembayaran. Coba lagi nanti.");
  }
});

bot.catch((err, ctx) => {
  logger.error(`bot.catch:`, err.message);
});

bot.launch().then(() => logger.success("Bot Toko Otomatis berjalan!"));

// ======== HTTP SERVER FOR PING BOT ========
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is alive!");
}).listen(PORT, () => {
  logger.info(`🌐 HTTP Server berjalan di port ${PORT} (untuk Ping Bot 24/7)`);
});
