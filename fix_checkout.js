const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const target = `    // Hitung harga dasar (Base Amount) agar penjual menerima harga bersih 100%
    const baseAmount = calculateBaseAmount(amount);`;

const replacement = `    // Jika harga akhir adalah Rp0, bypass payment gateway dan berikan gratis
    if (amount === 0) {
      const orderId = await store.createOrder("FREE-" + Date.now(), userId, 0, items, discount ? discount._id : null);
      await store.clearCart(userId);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {}
      await ctx.reply("🎁 *SELAMAT!* Anda mendapatkan produk ini secara **GRATIS** dengan potongan Diskon 100%!", { parse_mode: 'Markdown' });
      await onPaymentSuccess(ctx, ctx.chat.id, null, "FREE-" + Date.now(), orderId, null);
      return;
    }

    // Hitung harga dasar (Base Amount) agar penjual menerima harga bersih 100%
    let baseAmount = calculateBaseAmount(amount);
    
    // FAILSAFE: Minimum nominal QRIS Saweria adalah Rp1.000
    // Jika baseAmount di bawah 1.000, paksa naik menjadi 1.000 agar API tidak error 400
    if (baseAmount < 1000) {
      baseAmount = 1000;
      logger.warn(\`Base amount dipaksa menjadi 1000 (minimum QRIS) untuk User \${userId}\`);
    }`;

code = code.replace(target, replacement);
fs.writeFileSync('index.js', code);
console.log("Fixed index.js");
