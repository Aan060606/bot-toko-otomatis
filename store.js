const db = require('./database');
const { Markup } = require('telegraf');

function getActiveProducts() {
  return db.prepare("SELECT * FROM products WHERE active = 1").all();
}

// Ensure settings table exists
db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)").run();

function getSetting(key, def = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function addToCart(userId, productId) {
  const existing = db.prepare("SELECT * FROM carts WHERE user_id = ? AND product_id = ?").get(userId, productId);
  if (existing) {
    db.prepare("UPDATE carts SET quantity = quantity + 1 WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO carts (user_id, product_id, quantity) VALUES (?, ?, 1)").run(userId, productId);
  }
}

function getCart(userId) {
  return db.prepare(`
    SELECT c.id as cart_id, c.quantity, p.id as product_id, p.name, p.price, p.type 
    FROM carts c 
    JOIN products p ON c.product_id = p.id 
    WHERE c.user_id = ?
  `).all(userId);
}

function clearCart(userId) {
  db.prepare("DELETE FROM carts WHERE user_id = ?").run(userId);
}

function getCartTotal(userId) {
  const items = getCart(userId);
  return items.reduce((total, item) => total + (item.price * item.quantity), 0);
}

function removeCartItem(cartId) {
  db.prepare("DELETE FROM carts WHERE id = ?").run(cartId);
}

function createOrder(donationId, userId, totalAmount, cartItems) {
  const orderId = 'ORD-' + Date.now();
  
  const insertOrder = db.prepare("INSERT INTO orders (id, donation_id, user_id, total_amount, status) VALUES (?, ?, ?, ?, 'PENDING')");
  const insertItem = db.prepare("INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)");
  
  const transaction = db.transaction(() => {
    insertOrder.run(orderId, donationId, userId, totalAmount);
    for (const item of cartItems) {
      insertItem.run(orderId, item.product_id, item.quantity, item.price);
    }
  });
  
  transaction();
  return orderId;
}

function fulfillOrder(orderId) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(orderId);
  const deliveredStocks = [];
  
  const fulfillItem = db.prepare("UPDATE order_items SET fulfilled = 1 WHERE id = ?");
  
  const transaction = db.transaction(() => {
    for (const item of items) {
      for(let i=0; i<item.quantity; i++) {
        const stock = db.prepare("SELECT * FROM stocks WHERE product_id = ? LIMIT 1").get(item.product_id);
        if (stock) {
          deliveredStocks.push({
            product_id: item.product_id,
            content: stock.content
          });
          // Fitur Unlimited Stok: Jangan hapus stok agar link bisa dipakai berkali-kali!
          // db.prepare("DELETE FROM stocks WHERE id = ?").run(stock.id);
        } else {
          // No stock available, admin needs to fulfill manually or it's a static link
          // We assume for static link VIP, we can just insert a static stock with 'AVAILABLE' and NOT mark it as SOLD
          // or we check product type.
          const product = db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id);
          if (product && product.type === 'AUTO') {
            // Wait, if it's auto but no stock, we push a "Out of Stock, contact admin"
            deliveredStocks.push({
              product_id: item.product_id,
              content: "❌ Habis stok otomatis. Harap hubungi Admin."
            });
          }
        }
      }
      fulfillItem.run(item.id);
    }
    db.prepare("UPDATE orders SET status = 'SUCCESS' WHERE id = ?").run(orderId);
  });
  
  transaction();
  return deliveredStocks;
}

function getOrder(orderId) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
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
