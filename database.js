const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/toko-otomatis";

mongoose.connect(uri)
  .then(() => console.log("✅ Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal terhubung ke MongoDB:", err));

const UserSchema = new mongoose.Schema({
  _id: Number, // Telegram User ID
  first_name: String,
  username: String
});

const ProductSchema = new mongoose.Schema({
  _id: String, // Product ID
  name: String,
  description: String,
  price: Number,
  type: String, // 'AUTO' or 'MANUAL'
  preview_url: String,
  active: { type: Number, default: 1 }
});

const StockSchema = new mongoose.Schema({
  product_id: { type: String, ref: 'Product' },
  content: String,
  status: { type: String, default: 'AVAILABLE' }
});

const CartSchema = new mongoose.Schema({
  user_id: { type: Number, ref: 'User' },
  product_id: { type: String, ref: 'Product' },
  quantity: { type: Number, default: 1 }
});

const OrderSchema = new mongoose.Schema({
  _id: String, // Our Order ID
  donation_id: String, // Saweria Donation ID
  user_id: { type: Number, ref: 'User' },
  total_amount: Number,
  status: { type: String, default: 'PENDING' },
  created_at: { type: Date, default: Date.now }
});

const OrderItemSchema = new mongoose.Schema({
  order_id: { type: String, ref: 'Order' },
  product_id: { type: String, ref: 'Product' },
  quantity: Number,
  price: Number,
  fulfilled: { type: Number, default: 0 }
});

const SettingSchema = new mongoose.Schema({
  _id: String, // key
  value: String
});

module.exports = {
  User: mongoose.model('User', UserSchema),
  Product: mongoose.model('Product', ProductSchema),
  Stock: mongoose.model('Stock', StockSchema),
  Cart: mongoose.model('Cart', CartSchema),
  Order: mongoose.model('Order', OrderSchema),
  OrderItem: mongoose.model('OrderItem', OrderItemSchema),
  Setting: mongoose.model('Setting', SettingSchema),
};
