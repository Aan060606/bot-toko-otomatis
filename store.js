const { User, Product, Stock, Cart, Order, OrderItem, Setting } = require('./database');

async function getActiveProducts() {
  return await Product.find({}).lean();
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

async function createOrder(donationId, userId, totalAmount, cartItems) {
  const orderId = 'ORD-' + Date.now();
  
  await Order.create({
    _id: orderId,
    donation_id: donationId,
    user_id: userId,
    total_amount: totalAmount,
    status: 'PENDING'
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
      const stock = await Stock.findOne({ product_id: item.product_id }).lean();
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
  
  return deliveredStocks;
}

async function getOrder(orderId) {
  return await Order.findById(orderId).lean();
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
  getOrder
};
