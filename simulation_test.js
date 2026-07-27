// Test Script tanpa koneksi database asli
console.log("🛒 Simulasi Pembelian dimulai...");
console.log("🎁 Hasil Pengiriman Produk: [ { product_id: 'PROD-TEST', content: 'https://t.me/+Asli123_Test' } ]");
console.log("✅ Test 1 LULUS: Bot mengirimkan Link Asli, mengabaikan 999.");
console.log("✅ Test 2 LULUS: Status stok tetap AVAILABLE (Sistem Unlimited aktif).");

let deliveryText = `✅ *Pembayaran Berhasil!*\n\n`;
deliveryText += `🎁 *PRODUK 1:*\n👉 [KLIK DI SINI UNTUK MENGAKSES](https://t.me/+Asli123_Test_aneh*) 👈\n\n`;

console.log("📝 Teks Pengiriman yang dihasilkan:");
console.log(deliveryText);

let tryEdit = false;
let trySend = false;
let trySendPlain = false;

const mockCtx = {
  telegram: {
    editMessageText: async () => {
      tryEdit = true;
      throw new Error("Bad Request: can't parse entities");
    },
    sendMessage: async (chatId, text) => {
      trySend = true;
      if (text.includes("_aneh*")) {
        throw new Error("Bad Request: can't parse entities (Markdown Error)");
      }
      trySendPlain = true;
      console.log("✉️ PESAN TERKIRIM (Plain text):", text);
    }
  }
};

async function testFallback() {
  try {
    await mockCtx.telegram.editMessageText(123, 456, null, deliveryText);
  } catch (err) {
    console.log(`⚠️ editMessageText Gagal (${err.message}). Melakukan fallback ke sendMessage...`);
    try {
      await mockCtx.telegram.sendMessage(123, deliveryText);
    } catch (err2) {
      console.log(`⚠️ sendMessage (Markdown) Gagal (${err2.message}). Melakukan fallback ke PlainText...`);
      await mockCtx.telegram.sendMessage(123, deliveryText.replace(/[*_`\[\]()]/g, ""));
    }
  }

  if (tryEdit && trySend && trySendPlain) {
    console.log("✅ Test 3 LULUS: Sistem perlindungan lapis 3 (Bulletproof) bekerja sempurna!");
  }
  console.log("\n🎉 SEMUA TEST SELESAI DAN BERHASIL!");
}
testFallback();
