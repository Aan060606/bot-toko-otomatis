const WebSocket = require('ws');
const { Order } = require('./database');

function startSaweriaSSE(bot, onPaymentSuccess) {
  const streamKey = process.env.SAWERIA_STREAM_KEY;
  if (!streamKey) {
    console.warn("[WS] SAWERIA_STREAM_KEY tidak ditemukan di .env. Sistem Overlay (WebSocket) dinonaktifkan.");
    return;
  }

  const url = `wss://events.saweria.co/stream?streamKey=${streamKey}`;
  console.log(`[WS] Menghubungkan ke Overlay Saweria...`);
  
  let ws;
  let reconnectTimer;

  const connect = () => {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log("[WS] Berhasil terhubung ke WebSocket Overlay Saweria. Menunggu pembayaran...");
      if (reconnectTimer) clearTimeout(reconnectTimer);
    });

    ws.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        // event donation structure from Saweria WS
        if (payload && payload.type === 'donation' && Array.isArray(payload.data)) {
          for (const item of payload.data) {
            console.log("[WS] Notifikasi pembayaran instan diterima:", item.donator, "Rp" + item.amount);
            
            const msg = item.message || "";
            // Cari format [UID:12345] di pesan
            const match = msg.match(/\[UID:(\d+)\]/);
            
            if (match && match[1]) {
              const userId = parseInt(match[1]);
              console.log(`[WS] Mendeteksi pembayaran untuk UID Telegram: ${userId}`);
              
              // Cari order yang masih PENDING untuk user ini
              const order = await Order.findOne({ user_id: userId, status: 'PENDING' }).sort({ created_at: -1 });
              
              if (order) {
                console.log(`[WS] Ditemukan Order PENDING: ${order._id}. Memproses pesanan secara kilat!`);
                
                // Buat mock ctx karena onPaymentSuccess butuh ctx.telegram
                const mockCtx = { telegram: bot.telegram };
                
                // Memanggil fungsi sukses yang ada di index.js
                await onPaymentSuccess(mockCtx, userId, null, order.donation_id, order._id, null);
                console.log(`[WS] Order ${order._id} berhasil diproses via WebSockets!`);
              } else {
                console.log(`[WS] Pesanan PENDING tidak ditemukan untuk UID ${userId}. Mungkin sudah sukses via polling.`);
              }
            } else {
              // Jika tidak ada [UID:xxx], kemungkinan ini adalah "Test Notifikasi" dari dashboard Saweria
              console.log(`[WS] Menerima donasi/test tanpa UID dari ${item.donator}.`);
              if (process.env.ADMIN_CHAT_ID) {
                const text = `🔔 *KONEKSI SSE/WS AMAN!*\nBot berhasil menangkap sinyal (Test/Manual) dari Saweria Overlay:\n\nDari: ${item.donator}\nJumlah: Rp${item.amount}\nPesan: ${msg}\n\n_Ini membuktikan sistem "Respon Kilat" sudah terhubung sempurna!_`;
                bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text, { parse_mode: "Markdown" }).catch(() => {});
              }
            }
          }
        }
      } catch (e) {
        console.error("[WS] Error saat memproses event pesan:", e.message);
      }
    });

    ws.on('close', () => {
      console.warn("[WS] Peringatan: Koneksi terputus. Mencoba menghubungkan kembali dalam 5 detik...");
      reconnectTimer = setTimeout(connect, 5000);
    });

    ws.on('error', (error) => {
      console.error("[WS] WebSocket Error:", error.message);
      ws.close();
    });
  };

  connect();
}

module.exports = { startSaweriaSSE };
