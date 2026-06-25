const { Markup } = require('telegraf');
const { Product } = require('./database');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  return String(ctx.from?.id) === String(ADMIN_CHAT_ID);
}

function showAdminMenu(ctx, edit = false) {
  const text = `🛠 *Admin Control Panel*\n\nPilih kategori manajemen di bawah:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📦 Kelola Toko & Pesanan", "admin_shop_menu")],
    [Markup.button.callback("📢 Marketing & CRM", "admin_marketing_menu")],
    [Markup.button.callback("⚙️ Pengaturan Sistem", "admin_system_menu")],
    [Markup.button.callback("📖 Buku Panduan (FAQ)", "admin_guide")]
  ]);
  
  if (edit) {
    return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  }
  return ctx.replyWithMarkdown(text, keyboard);
}

function showGuide(ctx) {
  const text = `📖 *Buku Panduan Admin (FAQ)*

*1. Cara Kerja Bot (Otomatis)*
• *Follow-up Keranjang*: User yang klik "Beli" tapi belum bayar akan diingatkan setelah 1 Jam.
• *Drip Funnel*: Edukasi ke user yang belum pernah beli dikirim di Hari 1, 3, dan 7 jam 10:00 pagi.
• *Cross-sell*: Penawaran produk lain H+1 setelah user sukses membeli.
• *Auto-Backup*: Semua data di-backup setiap jam 02:00 pagi ke chat Anda.

*2. Cara Tambah Produk*
Masuk ke \`Kelola Toko > Manajemen Produk > Tambah Produk\`. Ikuti instruksinya. Setelah selesai, *JANGAN LUPA TAMBAH STOK*. Stok adalah *Link VIP / File Teks* yang dikirimkan ke pembeli setelah mereka bayar.

*3. Cara Broadcast*
Masuk ke \`Marketing > Broadcast\`. Pilih targetnya, ketik pesannya, dan bot akan mengirimnya dengan delay 1 detik per user agar tidak kena limit Telegram.

*4. Diskon Otomatis*
Masuk ke \`Marketing > Diskon\`. Anda bisa buat kode promo yang akan *trigger* otomatis saat checkout, misalnya untuk \`FIRST_TIME\` (pembelian pertama) atau \`CART_ABANDON\` (keranjang tertinggal).

_Kendalikan semua fitur hanya melalui menu tombol ini. Tidak perlu menghafal garis miring (/)!_`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🔙 Menu Utama", "admin_main")]]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

function showShopMenu(ctx) {
  const text = `📦 *Kelola Toko & Pesanan*\n\nManajemen inventaris, stok, dan daftar transaksi.`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Manajemen Produk", "admin_products"), Markup.button.callback("📥 Tambah Stok", "admin_stocks")],
    [Markup.button.callback("⚡ Buat Flash Sale", "admin_flash_sale_ui"), Markup.button.callback("📊 Daftar Pesanan", "admin_orders")],
    [Markup.button.callback("🔙 Menu Utama", "admin_main")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

function showMarketingMenu(ctx) {
  const text = `📢 *Marketing & CRM*\n\nOtomatisasi pengiriman pesan dan pengelolaan pelanggan.`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📢 Broadcast Pesan", "admin_crm_menu"), Markup.button.callback("🎟️ Diskon Otomatis", "admin_discount")],
    [Markup.button.callback("👥 Statistik Penjualan", "admin_crm_stats")],
    [Markup.button.callback("🤖 Mesin Automasi", "admin_marketing_settings")],
    [Markup.button.callback("🔙 Menu Utama", "admin_main")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

function showSystemMenu(ctx) {
  const text = `⚙️ *Pengaturan Sistem*\n\nKonfigurasi server, kesehatan database, dan antarmuka.`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🖼 Ubah Header Menu", "admin_header")],
    [Markup.button.callback("🔍 Cari Profil User", "admin_search_user"), Markup.button.callback("🏥 Cek Kesehatan", "admin_health")],
    [Markup.button.callback("⚠️ Database & Backup", "admin_db_menu")],
    [Markup.button.callback("🔙 Menu Utama", "admin_main")]
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

// Show products
async function showAdminProducts(ctx) {
  const products = await Product.find().lean();
  let text = `📦 *Daftar Produk*\n\n`;
  if (products.length === 0) text += "Belum ada produk.";
  else {
    products.forEach((p, i) => {
      text += `${i+1}. *${p.name}* (Rp${p.price}) - Tipe: ${p.type}\n   ID: \`${p._id}\`\n`;
    });
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Tambah Produk", "admin_add_product")],
    [Markup.button.callback("✏️ Kelola Produk (Edit/Hapus)", "admin_manage_product")],
    [Markup.button.callback("🔙 Kembali", "admin_main")],
  ]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

// ENHANCED CRM STATS — Fitur 5
async function showAdminCrmStats(ctx) {
  const { User, Order, OrderItem, Product, BroadcastLog } = require('./database');

  // Query paralel untuk efisiensi
  const [totalUsers, buyers, nonBuyers, blockedUsers, totalRevAgg, topProducts, lastCampaign, allProducts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ purchase_count: { $gt: 0 } }),
    User.countDocuments({ 
      $or: [
        { purchase_count: 0 },
        { purchase_count: null },
        { purchase_count: { $exists: false } }
      ]
    }),
    User.countDocuments({ is_blocked: true }),
    Order.aggregate([{ $match: { status: 'SUCCESS' } }, { $group: { _id: null, total: { $sum: '$total_amount' } } }]),
    // Produk terlaris: hitung total penjualan per produk
    OrderItem.aggregate([
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $match: { 'order.status': 'SUCCESS' } },
      { $group: { _id: '$product_id', total: { $sum: '$quantity' } } },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]),
    BroadcastLog.findOne().sort('-created_at').lean(),
    Product.find({ active: 1 }).lean()
  ]);

  const totalRevenue = totalRevAgg[0] ? totalRevAgg[0].total : 0;
  const totalProductCount = allProducts.length;

  // Penetrasi cross-sell: distribusi purchase_count per user
  const penetrationAgg = await User.aggregate([
    { $match: { purchase_count: { $gt: 0 } } },
    { $group: { _id: '$purchase_count', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  // Buat map nama produk dari ID untuk top products
  const productMap = {};
  allProducts.forEach(p => { productMap[String(p._id)] = p.name; });

  // Susun teks statistik
  let text = `📊 *Statistik Toko & CRM*\n\n`;

  // === OVERVIEW ===
  const buyerPct = totalUsers > 0 ? Math.round((buyers / totalUsers) * 100) : 0;
  text += `👥 *Total Pengguna:* ${totalUsers}\n`;
  text += `✅ Sudah Beli: ${buyers} (${buyerPct}%)\n`;
  text += `❌ Belum Beli: ${nonBuyers} (${100 - buyerPct}%)\n`;
  if (blockedUsers > 0) {
    text += `🚫 *Memblokir Bot:* ${blockedUsers} user\n`;
  }
  text += `\n`;

  // === PENETRASI CROSS-SELL ===
  if (totalProductCount > 1 && penetrationAgg.length > 0) {
    text += `🔁 *Penetrasi Cross-Sell (${totalProductCount} produk):*\n`;
    penetrationAgg.forEach(row => {
      const label = row._id >= totalProductCount ? `Lengkap (${row._id})` : `${row._id} produk`;
      const emoji = row._id >= totalProductCount ? '🏆' : '📦';
      text += `${emoji} Beli ${label}: ${row.count} user\n`;
    });
    text += '\n';
  }

  // === PRODUK TERLARIS ===
  if (topProducts.length > 0) {
    text += `🏆 *Produk Terlaris:*\n`;
    topProducts.forEach((p, i) => {
      const name = productMap[String(p._id)] || p._id;
      text += `${i + 1}. ${name} — *${p.total} terjual*\n`;
    });
    text += '\n';
  }

  // === CAMPAIGN TERAKHIR ===
  if (lastCampaign) {
    const tgl = new Date(lastCampaign.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    text += `📢 *Campaign Terakhir:*\n`;
    text += `Tanggal: ${tgl}\n`;
    text += `Terkirim: ${lastCampaign.success_count} | Gagal: ${lastCampaign.failed_count}\n\n`;
  }

  // === PENDAPATAN ===
  text += `💸 *Total Pendapatan:* Rp ${totalRevenue.toLocaleString('id-ID')}`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "admin_main")]]);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  }
  return ctx.replyWithMarkdown(text, keyboard);
}


module.exports = {
  isAdmin,
  showAdminMenu,
  showGuide,
  showShopMenu,
  showMarketingMenu,
  showSystemMenu,
  showAdminProducts,
  showAdminCrmStats
};
