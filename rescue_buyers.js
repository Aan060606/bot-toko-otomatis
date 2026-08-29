const mongoose = require('mongoose');
const axios = require('axios');
const { UserEvent, Order } = require('./database'); 
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

// Ganti copywriting ini sesuai kebutuhan Bos
const pesanMaaf = `Halo Bos! 🙏 Mohon maaf sebelumnya, tadi server VIP kami sempat mengalami kepenuhan antrean yang membuat sistem macet saat Bos mencoba memesan.

Kabar baiknya: Server sudah kami perbaiki dan **di-upgrade 10x lipat lebih cepat** sekarang juga! 🚀

Silakan Bos coba klik **Beli VIP** lagi sekarang, dijamin QR Code akan muncul seketika tanpa loading lama. Jangan sampai kehabisan akses VIP-nya!

Ketik /start untuk kembali ke Menu Utama.`;

async function rescueFailedBuyers() {
  console.log("🔍 Mencari pembeli yang gagal checkout dalam 24 jam terakhir...");
  
  // Ambil semua click checkout 24 jam terakhir
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const checkouts = await UserEvent.find({
    event_type: 'CHECKOUT',
    created_at: { $gte: since }
  }).lean();

  const usersToCheck = [...new Set(checkouts.map(c => c.user_id))];
  const failedUsers = [];

  for (const uid of usersToCheck) {
    // Abaikan ID Admin
    if (uid.toString() === process.env.ADMIN_CHAT_ID) continue;
    
    // Cek apakah mereka punya order yang sukses
    const successOrder = await Order.findOne({
      user_id: uid,
      status: 'SUCCESS',
      created_at: { $gte: since }
    });
    
    // Jika tidak punya pesanan sukses, berarti mereka gagal / nyangkut
    if (!successOrder) {
      failedUsers.push(uid);
    }
  }

  console.log(`⚠️ Menemukan ${failedUsers.length} user yang gagal/nyangkut.`);
  console.log(failedUsers);

  // Proses pengiriman pesan
  for (const uid of failedUsers) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: uid,
        text: pesanMaaf,
        parse_mode: 'Markdown'
      });
      console.log(`✅ Sukses mengirim pesan maaf ke user: ${uid}`);
    } catch (err) {
      console.log(`❌ Gagal kirim ke ${uid}:`, err.response?.data?.description || err.message);
    }
    // Jeda 1 detik agar tidak kena spam limit Telegram
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("🎉 Proses Rescue Selesai!");
  process.exit(0);
}

// Hubungkan ke MongoDB lalu jalankan
mongoose.connect(process.env.MONGODB_URI)
  .then(() => rescueFailedBuyers())
  .catch(err => console.error("Koneksi DB Error:", err));
