const EventSource = require('eventsource');
const { Order } = require('./database');

function startSaweriaSSE(bot, onPaymentSuccess) {
  const streamKey = process.env.SAWERIA_STREAM_KEY;
  if (!streamKey) {
    console.warn("[SSE] SAWERIA_STREAM_KEY tidak ditemukan di .env. Sistem Overlay (SSE) dinonaktifkan.");
    return;
  }

  const url = `https://backend.saweria.co/stream?streamKey=${streamKey}`;
  console.log(`[SSE] Menghubungkan ke Overlay Saweria (SSE)...`);
  
  const es = new EventSource(url);

  es.onopen = () => {
    console.log("[SSE] Berhasil terhubung ke WebSocket Overlay Saweria. Menunggu pembayaran...");
  };

  es.addEventListener('donations', async (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("[SSE] Notifikasi pembayaran instan diterima:", data.donator, "Rp" + data.amount);
      
      const msg = data.message || "";
      // Cari format [UID:12345] di pesan
      const match = msg.match(/\[UID:(\d+)\]/);
      
      if (match && match[1]) {
        const userId = parseInt(match[1]);
        console.log(`[SSE] Mendeteksi pembayaran untuk UID Telegram: ${userId}`);
        
        // Cari order yang masih PENDING untuk user ini
        const order = await Order.findOne({ user_id: userId, status: 'PENDING' }).sort({ created_at: -1 });
        
        if (order) {
          console.log(`[SSE] Ditemukan Order PENDING: ${order._id}. Memproses pesanan secara kilat!`);
          
          // Buat mock ctx karena onPaymentSuccess butuh ctx.telegram
          const mockCtx = { telegram: bot.telegram };
          
          // Memanggil fungsi sukses yang ada di index.js
          // parameter: ctx, chatId, msgId, donationId, orderId, qrMsgId
          await onPaymentSuccess(mockCtx, userId, null, order.donation_id, order._id, null);
          console.log(`[SSE] Order ${order._id} berhasil diproses via SSE!`);
        } else {
          console.log(`[SSE] Pesanan PENDING tidak ditemukan untuk UID ${userId}. Mungkin sudah sukses via polling.`);
        }
      }
    } catch (e) {
      console.error("[SSE] Error saat memproses event donations:", e.message);
    }
  });

  es.onerror = (error) => {
    console.warn("[SSE] Peringatan: Koneksi terputus atau gagal terhubung. EventSource akan otomatis mereconnect.");
  };
}

module.exports = { startSaweriaSSE };
