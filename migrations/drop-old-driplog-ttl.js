/**
 * MIGRATION SCRIPT: Drop Old DripLog TTL Index
 * 
 * SCRIPT INI WAJIB DIJALANKAN MANUAL SATU KALI DI PRODUCTION SEBELUM DEPLOY
 * KODE BARU (yang mengubah DripLogSchema index TTL).
 * 
 * Tujuan: Mencegah MongoServerError: IndexOptionsConflict karena MongoDB
 * tidak bisa menimpa index TTL dengan konfigurasi yang berbeda.
 * 
 * Cara Menjalankan:
 * node migrations/drop-old-driplog-ttl.js
 */

const mongoose = require('mongoose');

// Sesuaikan URI dengan environment production Anda (bisa pakai process.env.MONGODB_URI)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/toko-otomatis';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('[MIGRATION] Terhubung ke MongoDB.');
    try {
      // Periksa apakah index created_at_1 masih ada
      const collection = mongoose.connection.collection('driplogs');
      const indexes = await collection.indexes();
      
      const hasOldIndex = indexes.some(idx => idx.name === 'created_at_1');
      
      if (hasOldIndex) {
        console.log('[MIGRATION] Menemukan index lama "created_at_1". Mencoba menghapus...');
        await collection.dropIndex('created_at_1');
        console.log('✅ [BERHASIL] Index lama "created_at_1" sukses dihapus!');
      } else {
        console.log('✅ [AMAN] Index "created_at_1" tidak ditemukan. Mungkin sudah pernah dihapus.');
      }
    } catch (err) {
      console.error('❌ [GAGAL] Terjadi kesalahan saat menghapus index:', err);
    } finally {
      await mongoose.disconnect();
      console.log('[MIGRATION] Selesai. Koneksi database ditutup.');
      process.exit(0);
    }
  })
  .catch(err => {
    console.error('❌ [GAGAL] Tidak bisa terhubung ke MongoDB:', err);
    process.exit(1);
  });
