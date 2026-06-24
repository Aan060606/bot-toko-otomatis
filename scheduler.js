/**
 * scheduler.js — Behavioral Marketing Automation
 *
 * Algoritma segmentasi user non-buyer:
 *   Segmen B (CART_ABANDON): Klik beli tapi tidak jadi bayar dalam 72 jam
 *   Segmen C (INACTIVE):     Tidak aktif > 7 hari, belum beli
 *   Segmen A (COLD_LEAD):    Buka bot, belum pernah klik beli
 *
 * Anti-Spam: User hanya dapat 1 pesan otomatis per 3 hari
 * Template pesan bisa diubah Admin via /set_msg tanpa coding ulang
 */

const { User, UserEvent, BroadcastLog, Setting } = require('./database');

let marketingEnabled = true;
let cronTimer = null;

// Ambil template pesan dari DB, fallback ke default jika belum diset
async function getMsg(key, defaultMsg) {
  const row = await Setting.findById(`marketing_${key}`).lean();
  return row ? row.value : defaultMsg;
}

// Kirim pesan ke 1 user, otomatis tandai is_blocked jika gagal
async function sendSafe(bot, userId, text) {
  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
    return { ok: true };
  } catch (err) {
    const isBlocked = err.description && (
      err.description.includes('bot was blocked') ||
      err.description.includes('user is deactivated') ||
      err.description.includes('chat not found')
    );
    if (isBlocked) {
      await User.findByIdAndUpdate(userId, { is_blocked: true });
    }
    return { ok: false, blocked: isBlocked };
  }
}

// Klasifikasi user ke salah satu dari 3 segmen berdasarkan behavior
async function classifyUser(user) {
  const now = new Date();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const seventyTwoHoursAgo = new Date(now - 72 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // Anti-spam: skip jika sudah dapat pesan marketing dalam 3 hari terakhir
  if (user.last_broadcast_at && user.last_broadcast_at > threeDaysAgo) {
    return null;
  }

  // Segmen B — Cart Abandon: pernah klik Beli dalam 72 jam tapi tidak bayar
  const recentCheckout = await UserEvent.findOne({
    user_id: user._id,
    event_type: 'CHECKOUT',
    created_at: { $gte: seventyTwoHoursAgo }
  }).lean();

  if (recentCheckout) return 'CART_ABANDON';

  // Segmen C — Inactive: tidak aktif lebih dari 7 hari
  if (user.last_active_at && user.last_active_at < sevenDaysAgo) return 'INACTIVE';

  // Segmen A — Cold Lead: user biasa yang belum pernah klik beli
  return 'COLD_LEAD';
}

// Fungsi utama — jalankan satu sesi campaign marketing
async function runMarketingCampaign(bot) {
  if (!marketingEnabled) {
    return { skipped: true, reason: 'Marketing dimatikan Admin' };
  }

  const msgColdLead = await getMsg('cold_lead',
    `👋 *Hei!*\n\nKamu sudah pernah mampir ke toko kami tapi belum bergabung jadi *Member VIP*.\n\n` +
    `Dengan *Akses VIP Permanen*, kamu bisa menikmati konten premium selamanya — sekali bayar, selesai! ✅\n\n` +
    `Klik /start untuk lihat pilihan paket! 🔥`
  );

  const msgCartAbandon = await getMsg('cart_abandon',
    `🛒 *Hei! Kamu hampir jadi Member VIP!*\n\n` +
    `Kami lihat kamu tadi tertarik dengan produk kami tapi belum menyelesaikan pembayaran.\n\n` +
    `Apakah ada kendala? Hubungi Admin jika butuh bantuan!\n\n` +
    `Klik /start untuk lanjutkan pembelian. Jangan sampai ketinggalan! ⚡`
  );

  const msgInactive = await getMsg('inactive',
    `👀 *Sudah lama tidak melihat kamu!*\n\n` +
    `Kami kangen nih! Kamu sudah tahu belum kalau kami punya *Akses VIP Permanen*?\n\n` +
    `Sekali beli, nikmati selamanya. Tidak ada biaya langganan! 🎉\n\n` +
    `Klik /start sekarang! 🚀`
  );

  // Ambil semua user belum beli yang tidak diblokir
  const nonBuyers = await User.find({ purchase_count: 0, is_blocked: false }).lean();
  const stats = { cold: 0, abandon: 0, inactive: 0, skipped: 0, failed: 0 };

  for (const user of nonBuyers) {
    const segment = await classifyUser(user);

    if (!segment) { stats.skipped++; continue; }

    let msg;
    if (segment === 'CART_ABANDON') msg = msgCartAbandon;
    else if (segment === 'INACTIVE') msg = msgInactive;
    else msg = msgColdLead;

    const result = await sendSafe(bot, user._id, msg);

    if (result.ok) {
      // Update last_broadcast_at untuk anti-spam 3 hari
      await User.findByIdAndUpdate(user._id, { last_broadcast_at: new Date() });
      if (segment === 'CART_ABANDON') stats.abandon++;
      else if (segment === 'INACTIVE') stats.inactive++;
      else stats.cold++;
    } else {
      stats.failed++;
    }

    // Delay 1.5 detik per pesan agar aman dari rate limit Telegram
    await new Promise(res => setTimeout(res, 1500));
  }

  // Simpan log kampanye ke database
  const total = stats.cold + stats.abandon + stats.inactive;
  await BroadcastLog.create({
    admin_id: 0, // 0 = sistem otomatis, bukan manual
    target_segment: 'AUTO_MARKETING',
    message_text: `Cold:${stats.cold} | Abandon:${stats.abandon} | Inactive:${stats.inactive} | Skip:${stats.skipped} | Fail:${stats.failed}`,
    status: 'COMPLETED',
    success_count: total,
    failed_count: stats.failed
  });

  return stats;
}

// Cron job harian — cek setiap jam apakah sudah jam 10.00 WIB
function startDailyCron(bot) {
  if (cronTimer) clearInterval(cronTimer);

  cronTimer = setInterval(async () => {
    const jakartaHour = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })
    ).getHours();

    if (jakartaHour === 10) {
      console.log('[MARKETING] Cron job marketing harian berjalan...');
      try {
        const stats = await runMarketingCampaign(bot);
        console.log('[MARKETING] Selesai:', JSON.stringify(stats));
      } catch (err) {
        console.error('[MARKETING] Error:', err.message);
      }
    }
  }, 60 * 60 * 1000); // Cek setiap 1 jam

  console.log('[MARKETING] Cron aktif — campaign berjalan setiap hari jam 10.00 WIB');
}

function stopDailyCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

function setMarketingEnabled(val) { marketingEnabled = val; }
function isMarketingEnabled() { return marketingEnabled; }

module.exports = { runMarketingCampaign, startDailyCron, stopDailyCron, setMarketingEnabled, isMarketingEnabled };
