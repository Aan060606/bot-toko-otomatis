const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, DripLog } = require('./database');

const gzip = promisify(zlib.gzip);

async function runDatabaseBackup(bot) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) {
    console.warn("⚠️ ADMIN_CHAT_ID tidak di-set, backup dibatalkan karena tidak ada tujuan upload.");
    return;
  }

  console.log("⏳ Memulai Auto-Backup Database ke Telegram...");

  try {
    // 1. Ekspor Data dari Mongoose
    const data = {
      timestamp: new Date().toISOString(),
      collections: {
        users: await User.find().lean(),
        products: await Product.find().lean(),
        stocks: await Stock.find().lean(),
        orders: await Order.find().lean(),
        orderItems: await OrderItem.find().lean(),
        userEvents: await UserEvent.find().lean(),
        discounts: await Discount.find().lean(),
        dripLogs: await DripLog.find().lean(),
        settings: await Setting.find().lean()
      }
    };

    // 2. Buat Buffer JSON & Kompresi jadi GZIP
    const jsonString = JSON.stringify(data);
    const compressedBuffer = await gzip(jsonString);

    // 3. Nama File
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `backup_saweria_${dateStr}.json.gz`;
    const tempPath = path.join('/tmp', filename);

    // 4. Tulis file sementara
    fs.writeFileSync(tempPath, compressedBuffer);

    // 5. Kirim file ke Telegram (sebagai Storage Eksternal Persisten)
    await bot.telegram.sendDocument(
      adminId,
      { source: tempPath, filename },
      { caption: `🗄️ *AUTO-BACKUP DATABASE*\n\nTanggal: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\nUkuran asli: ${(jsonString.length / 1024 / 1024).toFixed(2)} MB\nUkuran kompresi: ${(compressedBuffer.length / 1024 / 1024).toFixed(2)} MB\n\n_File ini dikompresi (GZIP). Ekstrak untuk melihat data JSON._`, parse_mode: 'Markdown' }
    );

    // 6. Cleanup file lokal (Railway filesystem ephemeral, tapi tetap kita bersihkan)
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    console.log("✅ Auto-Backup sukses dikirim ke Telegram Admin.");

  } catch (err) {
    console.error("❌ Auto-Backup gagal:", err);
    try {
      await bot.telegram.sendMessage(adminId, `❌ *AUTO-BACKUP GAGAL*\n\nError: ${err.message}`, { parse_mode: 'Markdown' });
    } catch (e) {}
  }
}

module.exports = {
  runDatabaseBackup
};
