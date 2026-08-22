const { Markup } = require('telegraf');
const { Product, User, Order, OrderItem, Stock, DripLog, Discount, UserEvent, Setting, BroadcastLog, ABTestResult } = require('./database');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  return String(ctx.from?.id) === String(ADMIN_CHAT_ID);
}

// ─── MENU UTAMA — tampilkan ringkasan live ────────────────────────────────────
async function showAdminMenu(ctx, edit = false) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const fmtRp = n => `Rp${Number(n||0).toLocaleString('id-ID')}`;

  // Data live paralel
  const [revTodayArr, totalBuyers, totalUsers, totalStock, abandonToday] = await Promise.all([
    Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:todayStart}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
    User.countDocuments({ purchase_count: { $gt: 0 } }),
    User.countDocuments(),
    Stock.countDocuments({ status: 'AVAILABLE' }),
    UserEvent.countDocuments({ event_type:'CHECKOUT', created_at:{ $gte: new Date(now-86400000) } }),
  ]);
  const revToday = revTodayArr[0] || { t: 0, n: 0 };

  // Scheduler status — ambil dari module scheduler jika tersedia
  let marketingStatus = '✅ ON';
  try {
    const sched = require('./scheduler');
    marketingStatus = sched.isMarketingEnabled() ? '✅ ON' : '🔴 OFF';
  } catch(e) {}

  const text = [
    `🛠 <b>Admin Control Panel</b>`,
    ``,
    `📅 <b>${now.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long'})}</b>`,
    ``,
    `💰 Revenue hari ini: <b>${fmtRp(revToday.t)}</b> (${revToday.n} trx)`,
    `👥 User: <b>${totalUsers}</b> total | <b>${totalBuyers}</b> pembeli`,
    `📦 Stok tersedia: <b>${totalStock}</b> item`,
    `🛒 Checkout 24h: <b>${abandonToday}</b> (termasuk abandon)`,
    `🤖 Marketing: <b>${marketingStatus}</b>`,
    ``,
    `Pilih kategori di bawah:`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Kelola Toko & Pesanan', 'admin_shop_menu')],
    [Markup.button.callback('📢 Marketing & CRM', 'admin_marketing_menu')],
    [Markup.button.callback('⚙️ Pengaturan Sistem', 'admin_system_menu')],
    [Markup.button.callback('📊 Dashboard Lengkap', 'admin_dashboard_full')],
    [Markup.button.callback('📖 Panduan', 'admin_guide')],
  ]);

  if (edit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// ─── SUB-MENU: TOKO — tampilkan stok & pesanan live ──────────────────────────
async function showShopMenu(ctx) {
  const fmtRp = n => `Rp${Number(n||0).toLocaleString('id-ID')}`;
  const products = await Product.find({ active: 1 }).lean();

  let stockLines = '';
  for (const p of products) {
    const avail = await Stock.countDocuments({ product_id: String(p._id), status:'AVAILABLE' });
    const warn  = avail < 5 ? ' ⚠️' : '';
    stockLines += `• ${p.name}: <b>${avail} stok</b>${warn}\n`;
  }

  const pendingOrders = await Order.countDocuments({ status:'PENDING', created_at:{ $gte: new Date(Date.now()-15*60000) } });
  const todaySuccess  = await Order.countDocuments({ status:'SUCCESS', success_processed_at:{ $gte: new Date(new Date().setHours(0,0,0,0)) } });

  const text = [
    `📦 <b>Kelola Toko & Pesanan</b>`,
    ``,
    `<b>📊 Stok Saat Ini:</b>`,
    stockLines.trim() || '(tidak ada produk aktif)',
    ``,
    `<b>🧾 Pesanan:</b>`,
    `• Pending (15 menit terakhir): <b>${pendingOrders}</b>`,
    `• Sukses hari ini: <b>${todaySuccess}</b>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Manajemen Produk', 'admin_products'), Markup.button.callback('📥 Tambah Stok', 'admin_stocks')],
    [Markup.button.callback('⚡ Flash Sale', 'admin_flash_sale_ui'), Markup.button.callback('📋 Daftar Pesanan', 'admin_orders')],
    [Markup.button.callback('🔙 Menu Utama', 'admin_main')],
  ]);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
}

// ─── SUB-MENU: MARKETING — tampilkan funnel & campaign live ──────────────────
async function showMarketingMenu(ctx) {
  const now = new Date();
  const fmtRp = n => `Rp${Number(n||0).toLocaleString('id-ID')}`;

  const [totalUsers, totalBuyers, drip1, drip2, drip3, activeDisc, lastBroadcast] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ purchase_count: { $gt: 0 } }),
    DripLog.countDocuments({ stage:1, converted:false }),
    DripLog.countDocuments({ stage:2, converted:false }),
    DripLog.countDocuments({ stage:3, converted:false }),
    Discount.countDocuments({ active:true, $or:[{valid_until:null},{valid_until:{$gt:now}}] }),
    BroadcastLog.findOne().sort('-created_at').lean(),
  ]);

  // Marketing on/off
  let mktStatus = '✅ ON';
  try { const s = require('./scheduler'); mktStatus = s.isMarketingEnabled() ? '✅ ON' : '🔴 OFF'; } catch(e) {}

  const nonBuyers = totalUsers - totalBuyers;
  const convRate  = totalUsers > 0 ? Math.round(totalBuyers / totalUsers * 100) : 0;

  const lastBroadStr = lastBroadcast
    ? new Date(lastBroadcast.created_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})
    : 'Belum pernah';

  const text = [
    `📢 <b>Marketing & CRM</b>`,
    ``,
    `<b>📊 Funnel:</b>`,
    `• Total user: <b>${totalUsers}</b> | Pembeli: <b>${totalBuyers}</b> (${convRate}%)`,
    `• Non-buyer aktif: <b>${nonBuyers}</b>`,
    ``,
    `<b>🤖 Drip Campaign (aktif):</b>`,
    `• Stage 1 (hari 1): <b>${drip1}</b> user`,
    `• Stage 2 (hari 3): <b>${drip2}</b> user`,
    `• Stage 3 (hari 7): <b>${drip3}</b> user`,
    ``,
    `<b>🎟 Diskon aktif:</b> <b>${activeDisc}</b>`,
    `<b>📣 Broadcast terakhir:</b> ${lastBroadStr}`,
    `<b>Mesin marketing:</b> ${mktStatus}`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📢 Broadcast Pesan', 'admin_crm_menu'), Markup.button.callback('🎟 Diskon', 'admin_discount')],
    [Markup.button.callback('📊 Statistik Penjualan', 'admin_crm_stats'), Markup.button.callback('📈 ROI Drip', 'admin_marketing_roi')],
    [Markup.button.callback('🤖 Mesin Automasi', 'admin_marketing_settings')],
    [Markup.button.callback('🔙 Menu Utama', 'admin_main')],
  ]);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
}

// ─── SUB-MENU: SISTEM — tampilkan health live ─────────────────────────────────
async function showSystemMenu(ctx) {
  const mongoose = require('mongoose');
  const mem = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  const uptimeStr = uptime < 3600 ? `${Math.floor(uptime/60)}m ${uptime%60}s` : `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;
  const dbState = mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected';

  const text = [
    `⚙️ <b>Pengaturan Sistem</b>`,
    ``,
    `<b>🏥 Health Status:</b>`,
    `• MongoDB: <b>${dbState}</b>`,
    `• Uptime: <b>${uptimeStr}</b>`,
    `• Memory RSS: <b>${Math.round(mem.rss/1024/1024)} MB</b>`,
    `• Memory Heap: <b>${Math.round(mem.heapUsed/1024/1024)} MB</b>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🖼 Ubah Header Menu', 'admin_header')],
    [Markup.button.callback('🔍 Cari User', 'admin_search_user'), Markup.button.callback('🏥 Health Detail', 'admin_health')],
    [Markup.button.callback('⚠️ Database & Backup', 'admin_db_menu')],
    [Markup.button.callback('🔙 Menu Utama', 'admin_main')],
  ]);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
}

// ─── DASHBOARD PENUH (dari /dashboard command) ───────────────────────────────
async function showDashboardFull(ctx) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const d7 = new Date(now - 7*86400000);
  const d30 = new Date(now - 30*86400000);
  const fmtRp = n => `Rp${Number(n||0).toLocaleString('id-ID')}`;

  const [rev7dArr, rev30dArr, revTodayArr, totalUsers, totalBuyers, checkoutToday] = await Promise.all([
    Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:d7}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
    Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:d30}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
    Order.aggregate([{$match:{status:'SUCCESS',success_processed_at:{$gte:todayStart}}},{$group:{_id:null,t:{$sum:'$total_amount'},n:{$sum:1}}}]),
    User.countDocuments(),
    User.countDocuments({ purchase_count:{ $gt:0 } }),
    UserEvent.countDocuments({ event_type:'CHECKOUT', created_at:{ $gte: todayStart } }),
  ]);
  const rev7d = rev7dArr[0]||{t:0,n:0};
  const rev30d = rev30dArr[0]||{t:0,n:0};
  const revToday = revTodayArr[0]||{t:0,n:0};
  const avgDaily = Math.round(rev30d.t / 30);
  const convRate = checkoutToday > 0 ? Math.round(revToday.n/checkoutToday*100) : 0;

  // Top products
  const topProds = await OrderItem.aggregate([
    {$lookup:{from:'orders',localField:'order_id',foreignField:'_id',as:'ord'}},
    {$unwind:'$ord'}, {$match:{'ord.status':'SUCCESS'}},
    {$group:{_id:'$product_id',sold:{$sum:'$quantity'}}},
    {$sort:{sold:-1}}, {$limit:4}
  ]);
  const allProds = await Product.find({active:1}).lean();
  const prodMap = {}; allProds.forEach(p => { prodMap[String(p._id)] = p.name; });

  const stockByProd = await Stock.aggregate([
    {$match:{status:'AVAILABLE'}},
    {$group:{_id:'$product_id',count:{$sum:1}}}
  ]);
  const totalAvail = stockByProd.reduce((a,s)=>a+s.count,0);
  const lowStock = stockByProd.filter(s=>s.count<5);

  const emoji = revToday.t > avgDaily ? '📈' : '📊';

  const lines = [
    `${emoji} <b>Dashboard — ${now.toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'})}</b>`,
    ``,
    `💰 <b>Revenue:</b>`,
    `  • Hari ini: <b>${fmtRp(revToday.t)}</b> (${revToday.n} trx)`,
    `  • 7 hari  : <b>${fmtRp(rev7d.t)}</b> (${rev7d.n} trx)`,
    `  • Avg/hari: ${fmtRp(avgDaily)}`,
    ``,
    `👥 <b>Funnel Hari Ini:</b>`,
    `  • Total user : ${totalUsers}`,
    `  • Pembeli    : ${totalBuyers}`,
    `  • Checkout   : ${checkoutToday}x`,
    `  • Konversi   : ${convRate}% (${revToday.n}/${checkoutToday})`,
    ``,
    `🔥 <b>Produk Terlaris:</b>`,
    ...topProds.map((p,i) => `  ${i+1}. ${prodMap[String(p._id)]||p._id} — ${p.sold} sold`),
    ``,
    `📦 <b>Stok:</b> ${totalAvail} available`,
    lowStock.length > 0
      ? lowStock.map(s=>`  ⚠️ ${prodMap[s._id]||s._id}: ${s.count} tersisa`).join('\n')
      : `  ✅ Semua stok aman`,
    revToday.t > avgDaily * 1.5 ? `\n🚀 <b>Hari ini above average!</b> ${Math.round(revToday.t/avgDaily*100)}% dari rata-rata.` : '',
  ].filter(l => l !== undefined);

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'admin_main')]]);
  return ctx.editMessageText(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
}

function showGuide(ctx) {
  const text = `📖 <b>Panduan Admin</b>\n\n` +
    `<b>1. Cara Kerja Otomatis</b>\n` +
    `• Cart Abandon: user belum bayar → dapat pesan 1j, 3j, 12j\n` +
    `• Drip Funnel: non-buyer dapat edukasi hari ke 1, 3, 7\n` +
    `• Post-Purchase: buyer dapat tips D+3, cross-sell D+7\n` +
    `• Flash Sale: tiap Minggu malam jam 20:00\n\n` +
    `<b>2. Tambah Produk</b>\n` +
    `Toko → Manajemen Produk → Tambah Produk → lalu Tambah Stok\n\n` +
    `<b>3. Broadcast</b>\n` +
    `Marketing → Broadcast → pilih target → ketik pesan\n\n` +
    `<b>4. Diskon</b>\n` +
    `Marketing → Diskon → buat kode/trigger otomatis\n\n` +
    `<i>Semua fitur bisa diakses dari tombol menu. Tidak perlu ketik command!</i>`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu Utama', 'admin_main')]]);
  return ctx.editMessageText(text, { parse_mode:'HTML', ...keyboard });
}

async function showAdminProducts(ctx) {
  const products = await Product.find().lean();
  let lines = [`📦 <b>Daftar Produk</b>\n`];
  if (products.length === 0) {
    lines.push('Belum ada produk.');
  } else {
    for (const [i, p] of products.entries()) {
      const avail = await Stock.countDocuments({ product_id: String(p._id), status:'AVAILABLE' });
      const hasPromo = p.promo_image_id ? '🖼✅' : '🖼❌';
      const activeLabel = p.active ? '✅' : '❌';
      lines.push(`${i+1}. <b>${p.name}</b> — Rp${p.price.toLocaleString('id-ID')}`);
      lines.push(`   Stok: <b>${avail}</b> | Status: ${activeLabel} | Promo: ${hasPromo}`);
      lines.push(`   ID: <code>${p._id}</code>`);
    }
  }

  const promoButtons = products.map(p => [Markup.button.callback(`📸 Promo: ${p.name}`, `admin_set_promo_img_${p._id}`)]);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_product')],
    [Markup.button.callback('✏️ Edit/Hapus Produk', 'admin_manage_product')],
    ...promoButtons,
    [Markup.button.callback('🔙 Kembali', 'admin_main')],
  ]);
  return ctx.editMessageText(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
}

async function showAdminCrmStats(ctx) {
  const fmtRp = n => 'Rp' + Number(n||0).toLocaleString('id-ID');

  const [totalUsers, buyers, blockedUsers, totalRevAgg, topProducts, lastCampaign, allProducts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ purchase_count: { $gt: 0 } }),
    User.countDocuments({ is_blocked: true }),
    Order.aggregate([{$match:{status:'SUCCESS'}},{$group:{_id:null,total:{$sum:'$total_amount'}}}]),
    OrderItem.aggregate([
      {$lookup:{from:'orders',localField:'order_id',foreignField:'_id',as:'order'}},
      {$unwind:'$order'}, {$match:{'order.status':'SUCCESS'}},
      {$group:{_id:'$product_id',total:{$sum:'$quantity'}}},
      {$sort:{total:-1}}, {$limit:5}
    ]),
    BroadcastLog.findOne().sort('-created_at').lean(),
    Product.find({active:1}).lean()
  ]);

  const totalRevenue = totalRevAgg[0]?.total || 0;
  const nonBuyers = totalUsers - buyers;
  const buyerPct = totalUsers > 0 ? Math.round(buyers/totalUsers*100) : 0;
  const productMap = {}; allProducts.forEach(p => { productMap[String(p._id)] = p.name; });

  const penetrationAgg = await User.aggregate([
    {$match:{purchase_count:{$gt:0}}},
    {$group:{_id:'$purchase_count',count:{$sum:1}}},
    {$sort:{_id:1}}
  ]);

  const lines = [
    `📊 <b>Statistik Toko & CRM</b>`,
    ``,
    `👥 <b>Users:</b>`,
    `  • Total: <b>${totalUsers}</b>`,
    `  • Pembeli: <b>${buyers}</b> (${buyerPct}%)`,
    `  • Non-buyer: <b>${nonBuyers}</b>`,
    blockedUsers > 0 ? `  • Blokir bot: <b>${blockedUsers}</b>` : '',
    ``,
    topProducts.length > 0 ? `🏆 <b>Produk Terlaris:</b>` : '',
    ...topProducts.map((p,i) => `  ${i+1}. ${productMap[String(p._id)]||p._id} — ${p.total} terjual`),
    ``,
    penetrationAgg.length > 1 ? `🔁 <b>Cross-sell penetration:</b>` : '',
    ...penetrationAgg.map(r => `  • Beli ${r._id} produk: ${r.count} user`),
    ``,
    lastCampaign ? `📣 <b>Broadcast terakhir:</b> ${new Date(lastCampaign.created_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}` : '',
    lastCampaign ? `   Terkirim: ${lastCampaign.success_count} | Gagal: ${lastCampaign.failed_count}` : '',
    ``,
    `💸 <b>Total Revenue: ${fmtRp(totalRevenue)}</b>`,
  ].filter(l => l !== '');

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'admin_main')]]);
  if (ctx.callbackQuery) return ctx.editMessageText(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
  return ctx.reply(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
}

async function showAdminMarketingRoi(ctx) {
  const fmtRp = n => 'Rp' + Number(n||0).toLocaleString('id-ID');

  const dripStats = await DripLog.aggregate([
    {$group:{_id:'$stage',total:{$sum:1},converted:{$sum:{$cond:['$converted',1,0]}},revenue:{$sum:'$revenue_generated'}}},
    {$sort:{_id:1}}
  ]);
  const abStats = await ABTestResult.aggregate([
    {$group:{_id:'$variant',conversions:{$sum:1},revenue:{$sum:'$revenue_generated'}}},
    {$sort:{_id:1}}
  ]);

  let totalDripRevenue = 0;
  const lines = [`📈 <b>ROI Marketing Real-Time</b>\n`];

  lines.push(`<b>🎯 Kinerja Drip per Stage:</b>`);
  if (dripStats.length === 0) {
    lines.push('  Belum ada data');
  } else {
    dripStats.forEach(s => {
      totalDripRevenue += s.revenue || 0;
      const rate = s.total > 0 ? Math.round(s.converted/s.total*100) : 0;
      lines.push(`  Stage ${s._id}: ${s.total} terkirim | ${s.converted} konversi (${rate}%) | ${fmtRp(s.revenue)}`);
    });
  }

  lines.push(`\n<b>🧪 A/B Testing:</b>`);
  if (abStats.length === 0) {
    lines.push('  Belum ada data');
  } else {
    abStats.forEach(s => lines.push(`  Varian ${s._id}: ${s.conversions} konversi | ${fmtRp(s.revenue)}`));
  }

  lines.push(`\n━━━━━━━━━━━━━━`);
  lines.push(`💵 <b>Total Revenue Drip: ${fmtRp(totalDripRevenue)}</b>`);

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'admin_marketing_menu')]]);
  if (ctx.callbackQuery) return ctx.editMessageText(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
  return ctx.reply(lines.join('\n'), { parse_mode:'HTML', ...keyboard });
}

module.exports = {
  isAdmin,
  showAdminMenu,
  showGuide,
  showShopMenu,
  showMarketingMenu,
  showSystemMenu,
  showAdminProducts,
  showAdminCrmStats,
  showAdminMarketingRoi,
  showDashboardFull,
};
