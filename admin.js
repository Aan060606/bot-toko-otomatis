const { Markup } = require('telegraf');
const { Product } = require('./database');
const { v4: uuidv4 } = require('uuid');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  return String(ctx.from?.id) === String(ADMIN_CHAT_ID);
}

function showAdminMenu(ctx, edit = false) {
  const text = `🛠 *Admin Panel*\n\nPilih menu di bawah:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📦 Manajemen Produk", "admin_products"), Markup.button.callback("📥 Tambah Stok", "admin_stocks")],
    [Markup.button.callback("📢 Broadcast CRM", "admin_crm_menu")],
    [Markup.button.callback("🎟️ Diskon Otomatis", "admin_discount")],
    [Markup.button.callback("👥 Statistik & CRM", "admin_crm_stats")],
    [Markup.button.callback("🖼 Ubah Header", "admin_header"), Markup.button.callback("📊 Pesanan", "admin_orders")],
  ]);
  
  if (edit) {
    return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  }
  return ctx.replyWithMarkdown(text, keyboard);
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

// CRM STATS
async function showAdminCrmStats(ctx) {
  const { User, Order } = require('./database');
  const totalUsers = await User.countDocuments();
  const buyers = await User.countDocuments({ purchase_count: { $gt: 0 } });
  const nonBuyers = totalUsers - buyers;
  const totalRevAgg = await Order.aggregate([{ $match: { status: 'SUCCESS' } }, { $group: { _id: null, total: { $sum: '$total_amount' } } }]);
  const totalRevenue = totalRevAgg[0] ? totalRevAgg[0].total : 0;

  const text = `👥 *Statistik CRM Pelanggan*\n\n` +
               `Total Pengguna: ${totalUsers}\n` +
               `Sudah Pernah Beli: ${buyers}\n` +
               `Belum Pernah Beli: ${nonBuyers}\n\n` +
               `💰 *Total Pendapatan Sukses: Rp ${totalRevenue.toLocaleString('id-ID')}*\n\n` +
               `_Catatan: Gunakan command /broadcast untuk mengirim pesan ke segmen tertentu._`;
               
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "admin_main")]]);
  return ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
}

module.exports = {
  isAdmin,
  showAdminMenu,
  showAdminProducts,
  showAdminCrmStats
};
