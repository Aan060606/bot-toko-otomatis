const { User, Product, Stock, Cart, Order, OrderItem, Setting, Discount, UserEvent, DripLog } = require('./database');

async function getActiveProducts() {
  return await Product.find({ active: 1 }).lean();
}

async function getSetting(key, def = null) {
  const row = await Setting.findById(key).lean();
  return row ? row.value : def;
}

async function setSetting(key, value) {
  await Setting.findByIdAndUpdate(key, { value }, { upsert: true });
}

async function addToCart(userId, productId) {
  const existing = await Cart.findOne({ user_id: userId, product_id: productId });
  if (existing) {
    await Cart.updateOne({ _id: existing._id }, { $inc: { quantity: 1 } });
  } else {
    await Cart.create({ user_id: userId, product_id: productId, quantity: 1 });
  }
}

async function getCart(userId) {
  const carts = await Cart.find({ user_id: userId }).populate('product_id').lean();
  // [BUGFIX] Filter cart item yang produknya sudah dihapus dari DB
  // Tanpa guard ini: c.product_id = null → c.product_id._id crash dengan TypeError
  return carts.filter(c => c.product_id).map(c => ({
    cart_id: c._id.toString(),
    quantity: c.quantity,
    product_id: c.product_id._id,
    name: c.product_id.name,
    price: c.product_id.price,
    type: c.product_id.type
  }));
}

async function clearCart(userId) {
  await Cart.deleteMany({ user_id: userId });
}

async function getCartTotal(userId) {
  const items = await getCart(userId);
  return items.reduce((total, item) => total + (item.price * item.quantity), 0);
}

async function removeCartItem(cartId) {
  await Cart.findByIdAndDelete(cartId);
}

async function createOrder(donationId, userId, totalAmount, cartItems, discountId = null) {
  // Hanya batalkan order PENDING sebelumnya yang berisi produk yang sama
  // agar user tetap bisa memesan produk lain secara paralel
  const pendingOrders = await Order.find({ user_id: userId, status: 'PENDING' }).lean();
  for (const order of pendingOrders) {
    const items = await OrderItem.find({ order_id: order._id }).lean();
    const hasSameProduct = items.some(i => cartItems.some(ci => String(ci.product_id) === String(i.product_id)));
    if (hasSameProduct) {
      await Order.updateOne({ _id: order._id }, { $set: { status: 'CANCELLED' } });
    }
  }

  const crypto = require('crypto');
  const orderId = 'ORD-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
  
  await Order.create({
    _id: orderId,
    donation_id: donationId,
    user_id: userId,
    total_amount: totalAmount,
    status: 'PENDING',
    discount_id: discountId
  });
  
  for (const item of cartItems) {
    await OrderItem.create({
      order_id: orderId,
      product_id: item.product_id,
      quantity: item.quantity,
      price: item.price
    });
  }
  
  return orderId;
}

async function fulfillOrder(orderId) {
  const items = await OrderItem.find({ order_id: orderId }).lean();
  const deliveredStocks = [];
  
  for (const item of items) {
    // [BUGFIX BUG-03] Skip item yang sudah pernah diproses — idempotency guard
    if (item.fulfilled) continue;
    
    // [BUGFIX BUG-02] Kumpulkan konten yang perlu di-restock dalam array
    // dan jalankan setelah loop quantity selesai, agar iterasi berikutnya
    // tidak menemukan stok baru hasil restock iterasi sebelumnya
    const restockQueue = [];
    
    for(let i=0; i<item.quantity; i++) {
      // [BUGFIX STK-06/STK-07] Gunakan findOneAndUpdate atomik untuk "klaim" satu stok
      // Ini mencegah dua order paralel mendapat konten yang sama (race condition)
      const stock = await Stock.findOneAndUpdate(
        { product_id: item.product_id, status: 'AVAILABLE' },
        { $set: { status: 'SOLD', order_id: orderId, fulfilled_at: new Date() } },
        { returnDocument: 'before' } // Kembalikan dokumen SEBELUM update agar kita tahu kontennya
      );

      if (stock) {
        // Stok AVAILABLE berhasil diklaim — catat untuk audit trail
        deliveredStocks.push({
          product_id: item.product_id,
          content: stock.content
        });

        // [PRODUK DIGITAL UNLIMITED] Queue untuk restock setelah loop selesai
        restockQueue.push({ product_id: item.product_id, content: stock.content });

      } else {
        // Tidak ada stok AVAILABLE — cek apakah ada stok dari ORDER LAIN (unlimited digital product)
        const anyStock = await Stock.findOne({ product_id: item.product_id }).lean();

        if (anyStock && anyStock.order_id !== orderId) {
          // Ada stok dari ORDER LAIN (unlimited digital) — GUNAKAN kontennya untuk delivery
          deliveredStocks.push({
            product_id: item.product_id,
            content: anyStock.content
          });
          // Queue untuk restock agar pembeli BERIKUTNYA juga bisa dapat
          restockQueue.push({ product_id: item.product_id, content: anyStock.content });
        } else {
          // [BUGFIX BUG-01/BUG-02] Tidak ada stok AVAILABLE dan:
          // - Tidak ada stok sama sekali (BUG-01), ATAU
          // - anyStock.order_id === orderId (sudah diklaim di iterasi sebelumnya dalam loop ini - BUG-02)
          // Kedua kasus → tampilkan "Habis stok"
          deliveredStocks.push({
            product_id: item.product_id,
            content: '⚠️ Habis stok. Hubungi Admin untuk mendapat akses.'
          });
          // Jika ada anyStock (dari order ini), tetap queue untuk restock pembeli berikutnya
          if (anyStock) {
            restockQueue.push({ product_id: item.product_id, content: anyStock.content });
          }
        }
      }


    }
    
    // [BUGFIX BUG-02] Jalankan semua restock SETELAH loop quantity selesai
    for (const r of restockQueue) {
      await Stock.create({ product_id: r.product_id, content: r.content, status: 'AVAILABLE' });
    }
    
    await OrderItem.findByIdAndUpdate(item._id, { $set: { fulfilled: 1 } });
  }
  // NOTE: Status 'SUCCESS' sudah di-set secara atomik di onPaymentSuccess() index.js
  // menggunakan findOneAndUpdate dengan kondisi { status: 'PENDING' } sebagai idempotency guard.
  // Tidak di-set ulang di sini agar guard tersebut tetap berfungsi.

  // Tandai semua DripLog user ini sebagai converted agar drip follow-up berhenti
  const order = await Order.findById(orderId).lean();
  if (order) {
    try {
      await DripLog.updateMany(
        { user_id: order.user_id, converted: false },
        { $set: { converted: true } }
      );
    } catch (e) { /* silent */ }

    // ─── [W9] POST-PURCHASE FOLLOW-UP ──────────────────────────────────────
    // Setelah beli, buat DripLog POST_PURCHASE untuk follow-up bertingkat:
    //  Stage 1 = Terima kasih + cara akses (langsung, dikirim di index.js setelah payment)
    //  Stage 2 = 3 hari kemudian: tips penggunaan + minta review
    //  Stage 3 = 7 hari kemudian: cross-sell produk lain dengan diskon 10%
    try {
      const items = await OrderItem.find({ order_id: orderId }).lean();
      for (const item of items) {
        const existing = await DripLog.findOne({
          user_id: order.user_id,
          product_id: String(item.product_id),
          campaign_type: 'POST_PURCHASE'
        }).lean();
        if (!existing) {
          await DripLog.create({
            user_id: order.user_id,
            product_id: String(item.product_id),
            campaign_type: 'POST_PURCHASE',
            stage: 1,           // Stage 1 = sudah delivered
            converted: false,   // false = masih perlu follow-up stage 2 & 3
            sent_at: new Date(),
            variant: Math.random() > 0.5 ? 'A' : 'B'
          });
        }
      }
    } catch (e) { /* silent - jangan crash fulfillment */ }
  }

  return deliveredStocks;
}

async function getOrder(orderId) {
  return await Order.findById(orderId).lean();
}

async function applyAutomaticDiscount(userId, productId, basePrice) {
  // FIX: Selalu konversi ke Number agar query MongoDB tidak gagal karena type mismatch (String vs Number)
  const numUserId = Number(userId);
  const user = await User.findById(numUserId).lean();
  if (!user) return null;

  const now = new Date();
  const activeDiscounts = await Discount.find({
    active: true,
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gt: now } }] },
      { $or: [{ target_product_id: null }, { target_product_id: String(productId) }] },
      { $or: [{ target_user_id: null }, { target_user_id: numUserId }] }
    ]
  }).lean();

  let bestDiscount = null;
  let maxDeduction = 0;

  for (const discount of activeDiscounts) {
    if (discount.max_uses > 0 && discount.used_count >= discount.max_uses) continue;
    if (discount.min_purchase > basePrice) continue;

    // Cek trigger
    let isEligible = false;
    if (discount.trigger_event === 'FIRST_TIME' && user.purchase_count === 0) isEligible = true;
    else if (discount.trigger_event === 'LOYALTY' && user.purchase_count >= 5) isEligible = true;
    else if (discount.trigger_event === 'CART_ABANDON') {
      const lastCheckout = await UserEvent.findOne({ user_id: numUserId, event_type: 'CHECKOUT' }).sort('-created_at');
      if (lastCheckout && (now - lastCheckout.created_at) > 3600000) isEligible = true; // 1 jam
    } else if (!discount.trigger_event || discount.trigger_event === 'ALL') {
      isEligible = true; // Diskon personal dari Drip Stage 3 tidak punya trigger, langsung berlaku
    }

    if (isEligible) {
      let deduction = 0;
      if (discount.type === 'PERCENTAGE') {
        deduction = Math.floor((basePrice * discount.value) / 100);
      } else if (discount.type === 'FIXED') {
        deduction = discount.value;
      } else if (discount.type === 'BUNDLE') {
        // BUNDLE = persentase, tapi di-cap agar tidak merusak nilai produk murah
        // Produk <100rb: max 15% | Produk >=100rb: full bundle %
        const cappedPct = basePrice < 100000
          ? Math.min(discount.value, 15)
          : discount.value;
        deduction = Math.floor((basePrice * cappedPct) / 100);
      }

      
      if (deduction > maxDeduction) {
        maxDeduction = deduction;
        bestDiscount = { ...discount, deduction };
      }
    }
  }

  return bestDiscount;
}

async function getMenuDiscountText(userId) {
  const numUserId = Number(userId); // [BUGFIX] Cast ke Number agar query target_user_id (tipe Number) cocok
  const user = await User.findById(numUserId).lean();
  if (!user) return "";

  const now = new Date();
  const activeDiscounts = await Discount.find({
    active: true,
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gt: now } }] },
      { $or: [{ target_user_id: null }, { target_user_id: numUserId }] }
    ]
  }).lean();

  // [BUGFIX] Tampilkan hanya 1 label promo terbaik per kategori untuk mencegah spam text
  // Prioritas: FIRST_TIME > LOYALTY > personal (target_user_id) > global
  let bestFirstTime = null, bestLoyalty = null, bestPersonal = null, bestGlobal = null;

  for (const d of activeDiscounts) {
    if (d.max_uses > 0 && d.used_count >= d.max_uses) continue;

    const deduction = d.type === 'PERCENTAGE' ? d.value : 0;

    if (d.trigger_event === 'FIRST_TIME' && user.purchase_count === 0) {
      if (!bestFirstTime || deduction > bestFirstTime.deduction) bestFirstTime = { ...d, deduction };
    } else if (d.trigger_event === 'LOYALTY' && user.purchase_count >= 5) {
      if (!bestLoyalty || deduction > bestLoyalty.deduction) bestLoyalty = { ...d, deduction };
    } else if ((!d.trigger_event || d.trigger_event === 'ALL') && d.target_user_id) {
      // Diskon personal (target_user_id set) — dari drip atau cart abandon
      if (!bestPersonal || deduction > bestPersonal.deduction) bestPersonal = { ...d, deduction };
    } else if (!d.trigger_event || d.trigger_event === 'ALL') {
      // Diskon global (flash sale dll)
      if (!bestGlobal || deduction > bestGlobal.deduction) bestGlobal = { ...d, deduction };
    }
  }

  // Pilih 1 saja — prioritas dari atas
  const winner = bestFirstTime || bestLoyalty || bestPersonal || bestGlobal;
  if (!winner) return "";

  const valText = winner.type === 'PERCENTAGE' ? `${winner.value}%` : `Rp${winner.value.toLocaleString('id-ID')}`;
  let label = `🔥 *PROMO SPESIAL:* Diskon ${valText} Langsung!`;
  if (bestFirstTime) label = `🎁 *SPESIAL PENGGUNA BARU:* Potongan Harga ${valText}!`;
  else if (bestLoyalty) label = `💎 *MEMBER LOYAL:* Anda berhak mendapat Diskon ${valText}!`;

  return "\n\n" + label;
}

module.exports = {
  getActiveProducts,
  addToCart,
  getCart,
  clearCart,
  getCartTotal,
  removeCartItem,
  createOrder,
  fulfillOrder,
  getSetting,
  setSetting,
  getOrder,
  applyAutomaticDiscount,
  getMenuDiscountText
};
