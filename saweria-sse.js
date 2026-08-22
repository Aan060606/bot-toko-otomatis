const WebSocket = require('ws');
const { Order } = require('./database');

function startSaweriaSSE(bot, onPaymentSuccess) {
  const rawKey = process.env.SAWERIA_STREAM_KEY || '';
  let streamKey = rawKey.replace(/['"]/g, '').trim();

  // Jika user secara tidak sengaja memasukkan URL lengkap, kita ekstrak streamKey-nya
  if (streamKey.includes('streamKey=')) {
    streamKey = streamKey.split('streamKey=')[1].split('&')[0];
  }

  if (!streamKey) {
    console.warn("[WS] SAWERIA_STREAM_KEY tidak ditemukan di .env. Sistem Overlay dinonaktifkan.");
    return;
  }

  const maskedKey = streamKey.substring(0, 5) + '...' + streamKey.slice(-5);
  const url = `wss://events.saweria.co/stream?streamKey=${streamKey}`;
  console.log(`[WS] Menghubungkan ke Overlay Saweria... (Key: ${maskedKey})`);
  
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

    // Tangkap body dari error 403 untuk mengetahui alasan penolakan
    ws.on('unexpected-response', (request, response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        console.error(`[WS] Server menolak koneksi dengan HTTP ${response.statusCode}. Body:`, body.substring(0, 500));
      });
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
              
              // [BUGFIX KRITIS] SSE: item.amount = jumlah yang user bayar (NET, tanpa fee QRIS)
              // order.total_amount = harga * 1.04 (sudah include markup fee QRIS 4%)
              // Jadi item.amount SELALU < order.total_amount -- tidak bisa dibandingkan langsung!
              // Solusi: cari order berdasarkan donation_id, atau gunakan toleransi yang lebih besar
              
              // Prioritaskan match berdasarkan donation_id (WAJIB)
              let order = await Order.findOne({ 
                user_id: userId, 
                status: 'PENDING',
                donation_id: item.id // Saweria WS item.id = donation_id
              });
              
              if (order) {
                // Toleransi: item.amount adalah harga bersih (net), order.total_amount sudah termasuk fee 4%
                // Toleransi = max(2000, 5% dari order.total_amount) agar aman di semua harga produk
                const TOLERANCE = Math.max(2000, Math.ceil(order.total_amount * 0.05));
                const amountWithFee = Math.ceil(item.amount * 1.04 / 500) * 500; // Konversi ke 'format order'
                const isUnderpayment = amountWithFee < (order.total_amount - TOLERANCE);
                
                if (isUnderpayment) {
                  console.log(`[WS] PERINGATAN: UID ${userId} bayar Rp${item.amount} (net) / Rp${amountWithFee} (est. total) untuk tagihan Rp${order.total_amount}. Selisih terlalu besar!`);
                  
                  const textKurang = `⚠️ *PEMBAYARAN TIDAK SESUAI*\n\nSistem mendeteksi dana masuk sebesar *Rp${item.amount}*, namun total tagihan pesanan Anda adalah *Rp${order.total_amount}*.\n\nPesanan otomatis DIBATALKAN karena nominal tidak sesuai. Silakan hubungi admin jika terjadi kesalahan.`;
                  bot.telegram.sendMessage(userId, textKurang, { parse_mode: "Markdown" }).catch(() => {});
                  
                  await Order.findByIdAndUpdate(order._id, { status: 'FAILED' });
                } else {
                  console.log(`[WS] ✅ Pembayaran valid! UID ${userId} bayar Rp${item.amount}. Order ${order._id} diproses via WebSocket!`);
                  
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
