require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { execFile } = require("child_process");
const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const { User, Product, Stock, Cart, Order, OrderItem, Setting } = require("./database");
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

const CURL_BROWSER_ARGS = [
  "-sS", "--compressed", "-m", "30",
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

function sawPost(url, body) {
  return new Promise((resolve, reject) => {
    const tmpFile = `/tmp/saw_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, JSON.stringify(body));
    const args = [...CURL_BROWSER_ARGS, "-X", "POST", "-H", "Content-Type: application/json", "--data", `@${tmpFile}`, url];
    execFile("curl", args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (err) return reject(new Error(`curl: ${stderr || err.message}`));
      const text = stdout.trim();
      if (!text) return reject(new Error(`curl: empty response from ${url}`));
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`Non-JSON: ${text.slice(0, 200)}`)); }
    });
  });
}

function sawGet(url) {
  return new Promise((resolve, reject) => {
    const args = [...CURL_BROWSER_ARGS, url];
    execFile("curl", args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl error: ${stderr || err.message}`));
      const text = stdout.trim();
      if (!text) return reject(new Error(`curl: empty response`));
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`Non-JSON (${text.slice(0, 150)})`)); }
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

function calculateFeeLocally(amount) {
  // Saweria QRIS fee: 0.8% dibulatkan ke atas
  const fee = Math.ceil(amount * 0.008);
  return { amount_to_pay: amount + fee, pg_fee: fee };
}

async function createDonation(amount, email, name, message) {
  return withRetry(async () => {
    const payload = { agree: true, notUnderage: true, message: message || "-", amount, payment_type: "qris", vote: "", currency: "IDR", customer_info: { first_name: name, email, phone: "" } };
    const res = await sawPost(`${SAWERIA_API}/donations/snap/${SAWERIA_USER_ID}`, payload);
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
  await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
}

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown" }); } catch (e) {}
}

async function onPaymentSuccess(ctx, chatId, msgId, donationId, orderId) {
  stopPolling(donationId);
  try {
    const deliveries = await store.fulfillOrder(orderId);
    let deliveryText = `✅ *Pembayaran Berhasil!*\n\n🎉 Terima kasih atas pesanan Anda. Berikut adalah produk yang Anda beli:\n\n`;
    
    deliveries.forEach((d, i) => {
      deliveryText += `${i+1}. Produk ID: \`${d.product_id}\`\n   Isi: ${d.content}\n\n`;
    });

    try {
      await ctx.telegram.editMessageText(chatId, msgId, null, deliveryText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main")]])
      });
    } catch (err) {
      await ctx.telegram.sendMessage(chatId, deliveryText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "menu_main")]])
      });
    }

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
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const user = await User.findById(ctx.from.id).lean();
    if (!user) {
      await User.create({
        _id: ctx.from.id,
        first_name: ctx.from.first_name || '',
        username: ctx.from.username || ''
      });
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
  return admin.showAdminMenu(ctx);
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

  if (!ctx.message.text) return ctx.reply("❌ Harap kirimkan teks yang sesuai.");

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
  ctx.session = {};
  return showStoreMenu(ctx);
});

bot.action("menu_main", async (ctx) => {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch(e) {}
  return showStoreMenu(ctx);
});

async function showStoreMenu(ctx) {
  const products = await store.getActiveProducts();
  const text = `⛩️ 𝐉-𝐒𝐔𝐁 𝐂𝐎𝐋𝐋𝐄𝐂𝐓𝐈𝐎𝐍 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 𝐇𝐮𝐛 ⛩️\n「 プレミアムアクセス • 𝑷𝒓𝒆𝒎𝒊𝒖𝒎 𝑨𝒄𝒄𝒆𝒔𝒔 」\n\nSilakan pilih lisensi VIP Anda di bawah ini ⚜️:\n\n_24/7 ON SIAP MELAYANI_`;
  const buttons = [];
  products.forEach(p => {
    if (p.preview_url) {
      buttons.push([Markup.button.url(`📺 Preview Content ${p.name}`, p.preview_url)]);
    }
    buttons.push([Markup.button.callback(`🛒 Beli ${p.name} - ${formatRupiah(p.price)}`, `buy_now_${p._id}`)]);
  });
  
  if (process.env.ADMIN_CHAT_ID) {
    buttons.push([Markup.button.url("👨‍💻 HUBUNGI ADMIN JIKA GANGGUAN", `tg://user?id=${process.env.ADMIN_CHAT_ID}`)]);
  }
  
  const keyboard = Markup.inlineKeyboard(buttons);
  const hType = await store.getSetting("header_type", "url");
  const hFile = await store.getSetting("header_file_id", "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif");
  
  if (hType === "photo") {
    return ctx.replyWithPhoto(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
  } else if (hType === "animation") {
    return ctx.replyWithAnimation(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
  } else {
    if (hFile.match(/\.(jpeg|jpg|png)$/i)) {
      return ctx.replyWithPhoto(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
    }
    return ctx.replyWithAnimation(hFile, { caption: text, parse_mode: "Markdown", ...keyboard });
  }
}

bot.action(/^buy_now_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const productId = ctx.match[1];
  const userId = ctx.from.id;
  
  await store.clearCart(userId);
  await store.addToCart(userId, productId);
  
  const items = await store.getCart(userId);
  if (items.length === 0) return ctx.reply("❌ Produk tidak tersedia!");

  const amount = await store.getCartTotal(userId);
  const msg = await ctx.reply("⏳ Menyiapkan pembayaran QRIS...");

  try {
    const calc = calculateFeeLocally(amount);
    const buyerName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "Pembeli");
    const donation = await createDonation(calc.amount_to_pay, "pembeli@bot.com", buyerName, "Beli " + productId);
    const orderId = await store.createOrder(donation.id, userId, calc.amount_to_pay, items);
    await store.clearCart(userId);

    const qrPath = await generateQRImage(donation.qr_string, donation.id);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
    
    const caption = `🧾 *Detail Pembayaran*\n\nOrder ID: \`${orderId}\`\n💵 *Total Bayar: ${formatRupiah(calc.amount_to_pay)}*\n\n📱 Scan QR ini menggunakan aplikasi E-Wallet / M-Banking Anda.\n\n⏳ Berlaku 15 menit.`;
    await sendPhotoToTelegram(ctx.chat.id, qrPath, caption);

    const statusMsg = await ctx.replyWithMarkdown(`⏳ *Menunggu Pembayaran...*\nSistem akan memproses pesanan otomatis setelah pembayaran sukses.`);
    
    activeIntervals[donation.id] = pollPaymentStatus(ctx, donation.id, ctx.chat.id, statusMsg.message_id, orderId);
  } catch (err) {
    const errMsg = err.message || String(err);
    logger.error("Checkout error:", errMsg);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
    // Kirim error detail ke admin untuk debugging
    await notifyAdmin(`⚠️ *Checkout Error*\n\nUser: ${ctx.from.id}\nError: \`${errMsg.slice(0, 300)}\``);
    await ctx.reply(`❌ Gagal menyiapkan pembayaran.\n\nError: \`${errMsg.slice(0, 200)}\`\n\nCoba lagi dalam beberapa menit.`, { parse_mode: "Markdown" });
  }
});

bot.catch((err, ctx) => {
  logger.error(`bot.catch:`, err.message);
});

bot.command("testpay", async (ctx) => {
  if (!ADMIN_CHAT_ID || ctx.from.id.toString() !== ADMIN_CHAT_ID.toString()) {
    return ctx.reply(`❌ Akses ditolak! Perintah ini hanya untuk Admin utama.\nID Anda saat ini: \`${ctx.from.id}\`\nSedangkan ID Admin di .env: \`${ADMIN_CHAT_ID}\``, { parse_mode: "Markdown" });
  }
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Format: `/testpay <ORDER_ID>`\nContoh: `/testpay ORD-12345`", { parse_mode: "Markdown" });
  
  const orderId = args[1];
  const order = await store.getOrder(orderId);
  if (!order) return ctx.reply("❌ Order ID tidak ditemukan di database.");
  if (order.status === "SUCCESS") return ctx.reply("⚠️ Order ini sudah berstatus SUCCESS.");

  await ctx.reply("🔄 Memalsukan pembayaran sukses untuk " + orderId + "...");
  await onPaymentSuccess(ctx, ctx.chat.id, ctx.message.message_id, order.donation_id, orderId);
});

bot.launch()
  .then(() => logger.success("Bot Toko Otomatis berjalan!"))
  .catch((err) => {
    if (err.message && err.message.includes('409')) {
      logger.error("409 Conflict: Bot sudah berjalan di tempat lain. Pastikan tidak ada instance lain yang aktif.");
      // Retry after 5 seconds
      setTimeout(() => {
        logger.info("Mencoba restart bot...");
        bot.launch().then(() => logger.success("Bot berhasil restart!")).catch(e => logger.error("Gagal restart:", e.message));
      }, 5000);
    } else {
      logger.error("Gagal menjalankan bot:", err.message);
      process.exit(1);
    }
  });


const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is alive!");
}).listen(PORT, () => {
  logger.info(`🌐 HTTP Server berjalan di port ${PORT} (untuk Ping Bot 24/7)`);
});
