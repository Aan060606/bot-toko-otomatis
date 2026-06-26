const WebSocket = require('ws');
const { Order } = require('./database');

function startSaweriaSSE(bot, onPaymentSuccess) {
  const rawKey = process.env.SAWERIA_STREAM_KEY || '';
  const streamKey = rawKey.replace(/['"]/g, '').trim();

  if (!streamKey) {
    console.warn("[WS] SAWERIA_STREAM_KEY tidak ditemukan di .env. Sistem Overlay dinonaktifkan.");
    return;
  }

  const url = `wss://events.saweria.co/stream?streamKey=${streamKey}`;
  console.log(`[WS] Menghubungkan ke Overlay Saweria...`);
  
  let ws;
  let reconnectTimer;
  let heartbeatTimer;

  const connect = () => {
    // Menambahkan header User-Agent & Origin untuk menghindari blokir 403 (Cloudflare/Anti-DDoS)
    ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://saweria.co'
      }
    });

    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      // Saweria sends pong every ~25 seconds, so we timeout at 45 seconds
      heartbeatTimer = setTimeout(() => {
        console.warn("[WS] KONEKSI ZOMBIE TERDETEKSI! Tidak ada respon dari server selama 45 detik. Mere-start koneksi...");
        ws.terminate(); // terminate will trigger 'close' event
      }, 45000);
    };

    ws.on('open', () => {
      console.log("[WS] Berhasil terhubung ke WebSocket Overlay Saweria. Menunggu pembayaran...");
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resetHeartbeat();
    });

    ws.on('message', async (data) => {
      try {
        resetHeartbeat(); // Setiap ada pesan (termasuk pong), reset timer zombie
        
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
                // Validasi keamanan: Pastikan jumlah yang dibayar SESUAI dengan tagihan
                if (item.amount < order.total_amount) {
                  console.log(`[WS] PERINGATAN KEAMANAN: UID ${userId} mencoba membayar Rp${item.amount} untuk tagihan Rp${order.total_amount}. Ditolak!`);
                  
                  const textKurang = `⚠️ *PEMBAYARAN TIDAK SESUAI*\n\nSistem mendeteksi dana masuk sebesar *Rp${item.amount}*, namun total tagihan pesanan Anda adalah *Rp${order.total_amount}*.\n\nPesanan otomatis DIBATALKAN karena nominal tidak sesuai. Silakan hubungi admin jika terjadi kesalahan.`;
                  bot.telegram.sendMessage(userId, textKurang, { parse_mode: "Markdown" }).catch(() => {});
                  
                  // Opsional: Langsung ubah status order ke FAILED
                  await Order.findByIdAndUpdate(order._id, { status: 'FAILED' });
                } else {
                  console.log(`[WS] Ditemukan Order PENDING: ${order._id}. Memproses pesanan secara kilat!`);
                  
                  // Buat mock ctx karena onPaymentSuccess butuh ctx.telegram
                  const mockCtx = { telegram: bot.telegram };
                  
                  // Memanggil fungsi sukses yang ada di index.js
                  await onPaymentSuccess(mockCtx, userId, null, order.donation_id, order._id, null);
                  console.log(`[WS] Order ${order._id} berhasil diproses via WebSockets!`);
                }
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
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      reconnectTimer = setTimeout(connect, 5000);
    });

    ws.on('error', (error) => {
      console.error("[WS] WebSocket Error:", error.message);
      ws.terminate();
    });
  };

  connect();
}

module.exports = { startSaweriaSSE };
