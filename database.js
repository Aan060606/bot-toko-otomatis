const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/toko-otomatis";

mongoose.connect(uri)
  .then(() => console.log("✅ Terhubung ke MongoDB!"))
  .catch(err => console.error("❌ Gagal terhubung ke MongoDB:", err));

const UserSchema = new mongoose.Schema({
  _id: Number, // Telegram User ID
  first_name: String,
  username: String,
  joined_at: { type: Date, default: Date.now },
  last_active_at: { type: Date, default: Date.now },
  total_spent: { type: Number, default: 0 },
  purchase_count: { type: Number, default: 0 },
  is_blocked: { type: Boolean, default: false },
  source_ref: String // Referral / broadcast source if any
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

const UserEventSchema = new mongoose.Schema({
  user_id: { type: Number, ref: 'User' },
  event_type: String, // START, VIEW, CHECKOUT, SUCCESS, FAIL
  product_id: { type: String, ref: 'Product' },
  metadata: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now }
});

const DiscountSchema = new mongoose.Schema({
  code: String, // Or trigger name like 'NEW_USER'
  type: String, // 'PERCENTAGE', 'FIXED'
  value: Number,
  trigger_event: String, // 'FIRST_TIME', 'LOYALTY', etc
  target_user_id: { type: Number, ref: 'User' }, // Optional specific user
  target_product_id: { type: String, ref: 'Product' }, // Optional specific product
  min_purchase: { type: Number, default: 0 },
  max_uses: { type: Number, default: 0 }, // 0 = unlimited
  used_count: { type: Number, default: 0 },
  valid_until: Date,
  active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now }
});

const BroadcastLogSchema = new mongoose.Schema({
  admin_id: Number,
  target_segment: String, // 'ALL', 'BUYERS', 'NON_BUYERS', etc
  message_text: String,
  status: { type: String, default: 'PENDING' }, // PENDING, SENDING, COMPLETED, FAILED
  success_count: { type: Number, default: 0 },
  failed_count: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

module.exports = {
  User: mongoose.model('User', UserSchema),
  Product: mongoose.model('Product', ProductSchema),
  Stock: mongoose.model('Stock', StockSchema),
  Cart: mongoose.model('Cart', CartSchema),
  Order: mongoose.model('Order', OrderSchema),
  OrderItem: mongoose.model('OrderItem', OrderItemSchema),
  Setting: mongoose.model('Setting', SettingSchema),
  UserEvent: mongoose.model('UserEvent', UserEventSchema),
  Discount: mongoose.model('Discount', DiscountSchema),
  BroadcastLog: mongoose.model('BroadcastLog', BroadcastLogSchema)
};
