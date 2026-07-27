/**
 * preview.js — Dynamic Content Preview System
 *
 * Cara kerja:
 * 1. Bot ambil foto/video terbaru dari grup VIP (topik per topik)
 * 2. Cache thumbnail ke database (agar tidak spam API Telegram)
 * 3. Saat kirim pesan marketing, sertakan preview terbaru secara otomatis
 * 4. Preview dikirim dengan watermark "🔒 PREVIEW ONLY — Join VIP untuk akses penuh"
 */

const { Setting } = require('./database');
const mongoose = require('mongoose');

// Schema untuk cache preview
const PreviewCacheSchema = new mongoose.Schema({
  _id: String,           // file_id dari Telegram
  file_type: String,     // 'photo' atau 'video'
  topic_id: Number,      // ID topik dalam grup (null = umum)
  topic_name: String,    // Nama topik (e.g. "JAV Sub Indo")
  caption: String,       // Caption asli konten
  cached_at: { type: Date, default: Date.now },
  used_count: { type: Number, default: 0 }
}, { collection: 'previewcaches' });

const PreviewCache = mongoose.models.PreviewCache || mongoose.model('PreviewCache', PreviewCacheSchema);

/**
 * Ambil preview terbaru dari grup VIP dan cache ke database
 * Dipanggil oleh cron setiap 4 jam
 */
async function refreshPreviewCache(bot) {
  try {
    const groupId = await Setting.findById('vip_group_id').lean().then(r => r?.value);
    if (!groupId) {
      console.log('[PREVIEW] vip_group_id belum di-set. Skip.');
      return 0;
    }

    // Ambil updates terbaru dari grup (Telegram tidak punya getHistory lewat Bot API)
    // Solusi: gunakan forwardMessages yang sudah kita tangkap dari webhook
    const recentPhotos = await mongoose.connection.db.collection('previewcaches')
      .countDocuments({ cached_at: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) } });

    console.log('[PREVIEW] Cache saat ini:', recentPhotos, 'preview tersedia');
    return recentPhotos;
  } catch (err) {
    console.error('[PREVIEW] Gagal refresh cache:', err.message);
    return 0;
  }
}

/**
 * Tangkap foto/video yang masuk ke grup VIP dan simpan ke cache
 * Dipasang di index.js sebagai middleware
 */
async function captureGroupContent(ctx) {
  try {
    const groupId = await Setting.findById('vip_group_id').lean().then(r => r?.value);
    if (!groupId) return;

    const chatId = String(ctx.chat?.id);
    if (chatId !== String(groupId)) return;

    // Hanya tangkap foto dan video
    let fileId = null;
    let fileType = null;
    let caption = ctx.message?.caption || '';
    const topicId = ctx.message?.message_thread_id || null;

    if (ctx.message?.photo) {
      // Ambil resolusi terbesar
      const photos = ctx.message.photo;
      fileId = photos[photos.length - 1].file_id;
      fileType = 'photo';
    } else if (ctx.message?.video) {
      // Ambil thumbnail video kalau ada
      fileId = ctx.message.video.thumb?.file_id || ctx.message.video.file_id;
      fileType = 'video';
    } else if (ctx.message?.document && ctx.message.document.mime_type?.startsWith('video')) {
      fileId = ctx.message.document.thumb?.file_id || null;
      if (fileId) fileType = 'photo'; // Pakai thumbnail saja
    }

    if (!fileId) return;

    // Simpan ke cache (max 50 preview per topik)
    const existingCount = await PreviewCache.countDocuments({ topic_id: topicId });
    if (existingCount >= 50) {
      // Hapus yang paling lama
      const oldest = await PreviewCache.findOne({ topic_id: topicId }).sort({ cached_at: 1 });
      if (oldest) await PreviewCache.findByIdAndDelete(oldest._id);
    }

    // Cek duplikat
    const exists = await PreviewCache.findById(fileId);
    if (exists) return;

    // Deteksi nama topik dari setting
    let topicName = 'Konten VIP';
    if (topicId) {
      const topicSetting = await Setting.findById(`topic_name_${topicId}`).lean();
      topicName = topicSetting?.value || `Topik ${topicId}`;
    }

    await PreviewCache.create({
      _id: fileId,
      file_type: fileType,
      topic_id: topicId,
      topic_name: topicName,
      caption: caption.substring(0, 200),
      cached_at: new Date()
    });

    console.log(`[PREVIEW] ✅ Captured ${fileType} dari topik: ${topicName}`);
  } catch (err) {
    console.error('[PREVIEW] Gagal capture konten:', err.message);
  }
}

/**
 * Ambil 3 preview terbaru dari cache untuk dikirim ke user
 * Gunakan ini sebelum mengirim pesan marketing
 */
async function getLatestPreviews(count = 3, topicId = null) {
  try {
    const query = topicId ? { topic_id: topicId } : {};
    const previews = await PreviewCache.find(query)
      .sort({ cached_at: -1 })
      .limit(count)
      .lean();
    return previews;
  } catch (err) {
    return [];
  }
}

/**
 * Kirim media group (album preview) ke user dengan watermark caption
 * Dipanggil sebelum pesan marketing Stage 1
 */
async function sendPreviewToUser(bot, userId, maxPreviews = 3) {
  try {
    const previews = await getLatestPreviews(maxPreviews);
    if (previews.length === 0) return false;

    const media = previews.map((p, i) => ({
      type: p.file_type === 'video' ? 'photo' : 'photo', // Selalu kirim sebagai foto (thumbnail)
      media: p.file_id,
      caption: i === 0
        ? `👁 *PREVIEW KONTEN TERBARU — ${p.topic_name}*\n\n🔒 Ini hanya sebagian kecil dari ribuan konten eksklusif.\n_Join VIP untuk akses penuh tanpa batas._`
        : undefined,
      parse_mode: i === 0 ? 'Markdown' : undefined
    }));

    if (media.length === 1) {
      // Single photo
      await bot.telegram.sendPhoto(userId, previews[0]._id, {
        caption: `👁 *PREVIEW KONTEN TERBARU — ${previews[0].topic_name}*\n\n🔒 Ini hanya sebagian kecil dari ribuan konten eksklusif.\n_Join VIP untuk akses penuh tanpa batas._`,
        parse_mode: 'Markdown'
      });
    } else {
      // Media group (album)
      await bot.telegram.sendMediaGroup(userId, media);
    }

    // Update used_count
    for (const p of previews) {
      await PreviewCache.findByIdAndUpdate(p._id, { $inc: { used_count: 1 } });
    }

    return true;
  } catch (err) {
    console.error('[PREVIEW] Gagal kirim preview ke', userId, ':', err.message);
    return false;
  }
}

/**
 * Setup command admin untuk konfigurasi grup VIP
 * /set_vip_group — dipanggil di grup VIP, otomatis simpan ID grup
 */
async function setupPreviewCommands(bot) {
  // Command untuk set grup VIP (harus dipanggil dari dalam grup)
  bot.command('set_vip_group', async (ctx) => {
    const adminId = process.env.ADMIN_CHAT_ID;
    if (String(ctx.from.id) !== String(adminId)) return;

    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title;

    await Setting.findByIdAndUpdate('vip_group_id', { value: String(chatId) }, { upsert: true });
    await ctx.reply(`✅ Grup VIP berhasil di-set!\n\nGrup: *${chatTitle}*\nID: \`${chatId}\`\n\nSekarang bot akan otomatis mengambil preview dari grup ini untuk dikirim ke calon pembeli.`, { parse_mode: 'Markdown' });

    console.log('[PREVIEW] VIP Group set:', chatId, chatTitle);
  });

  // Command untuk set nama topik
  bot.command('set_topic_name', async (ctx) => {
    const adminId = process.env.ADMIN_CHAT_ID;
    if (String(ctx.from.id) !== String(adminId)) return;

    const args = ctx.message.text.split(' ').slice(1).join(' ');
    const topicId = ctx.message.message_thread_id;

    if (!topicId) {
      return ctx.reply('❌ Command ini harus dijalankan di dalam topik yang ingin diberi nama.');
    }

    await Setting.findByIdAndUpdate(`topic_name_${topicId}`, { value: args }, { upsert: true });
    await ctx.reply(`✅ Nama topik berhasil di-set: *${args}*`, { parse_mode: 'Markdown' });
  });
}

/**
 * Middleware untuk index.js — pasang di bot.on('message')
 */
async function previewMiddleware(ctx, next) {
  await captureGroupContent(ctx);
  return next();
}

module.exports = {
  PreviewCache,
  captureGroupContent,
  getLatestPreviews,
  sendPreviewToUser,
  refreshPreviewCache,
  setupPreviewCommands,
  previewMiddleware
};
