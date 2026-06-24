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
  return carts.map(c => ({
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
  // Batalkan semua order PENDING sebelumnya untuk user ini agar tidak ganda
  await Order.updateMany(
    { user_id: userId, status: 'PENDING' },
    { $set: { status: 'CANCELLED' } }
  );

  const orderId = 'ORD-' + Date.now();
  
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
    for(let i=0; i<item.quantity; i++) {
      const stock = await Stock.findOneAndUpdate(
        { product_id: item.product_id, status: 'AVAILABLE' },
        { $set: { status: 'SOLD', order_id: orderId, fulfilled_at: new Date() } }
      ).lean();
      if (stock) {
        deliveredStocks.push({
          product_id: item.product_id,
          content: stock.content
        });
      } else {
        const product = await Product.findById(item.product_id).lean();
        if (product && product.type === 'AUTO') {
          deliveredStocks.push({
            product_id: item.product_id,
            content: "❌ Habis stok otomatis. Harap hubungi Admin."
          });
        }
      }
    }
    await OrderItem.findByIdAndUpdate(item._id, { fulfilled: 1 });
  }
  await Order.findByIdAndUpdate(orderId, { status: 'SUCCESS' });

  // Tandai semua DripLog user ini sebagai converted agar drip follow-up berhenti
  const order = await Order.findById(orderId).lean();
  if (order) {
    try {
      await DripLog.updateMany(
        { user_id: order.user_id, converted: false },
        { $set: { converted: true } }
      );
    } catch (e) { /* silent */ }
  }

  return deliveredStocks;
}

async function getOrder(orderId) {
  return await Order.findById(orderId).lean();
}

async function applyAutomaticDiscount(userId, productId, basePrice) {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const now = new Date();
  const activeDiscounts = await Discount.find({
    active: true,
    $and: [
      { $or: [{ valid_until: null }, { valid_until: { $gt: now } }] },
      { $or: [{ target_product_id: null }, { target_product_id: productId }] },
      { $or: [{ target_user_id: null }, { target_user_id: userId }] }
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
      const lastCheckout = await UserEvent.findOne({ user_id: userId, event_type: 'CHECKOUT' }).sort('-created_at');
      if (lastCheckout && (now - lastCheckout.created_at) > 3600000) isEligible = true; // 1 jam
    } else if (!discount.trigger_event || discount.trigger_event === 'ALL') {
      isEligible = true;
    }

    if (isEligible) {
      let deduction = 0;
      if (discount.type === 'PERCENTAGE') {
        deduction = (basePrice * discount.value) / 100;
      } else if (discount.type === 'FIXED') {
        deduction = discount.value;
      }
      
      if (deduction > maxDeduction) {
        maxDeduction = deduction;
        bestDiscount = { ...discount, deduction };
      }
    }
  }

  return bestDiscount;
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
  applyAutomaticDiscount
};
