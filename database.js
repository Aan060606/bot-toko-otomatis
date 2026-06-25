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
  source_ref: String,
  last_broadcast_at: { type: Date, default: null }, // Kapan terakhir dapat pesan marketing otomatis (anti-spam 3 hari)
  last_menu_msg_id: { type: Number, default: null } // Menyimpan ID pesan menu utama terakhir
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
  status: { type: String, default: 'AVAILABLE' },
  order_id: String,
  fulfilled_at: Date
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
  discount_id: { type: String, ref: 'Discount' },
  success_processed_at: Date,
  created_at: { type: Date, default: Date.now }
});
OrderSchema.index({ user_id: 1, status: 1 });

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
  event_type: String, // START, CHECKOUT, PAYMENT_SUCCESS
  product_id: { type: String, ref: 'Product' },
  metadata: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now }
});
// TTL Index: MongoDB akan otomatis hapus event lama setelah 30 hari
// Data User utama (purchase_count, total_spent, dll) TIDAK ikut terhapus
UserEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

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

const DripLogSchema = new mongoose.Schema({
  user_id: { type: Number, ref: 'User' },
  product_id: { type: String, ref: 'Product' }, // Produk yang sedang ditawarkan di drip ini
  campaign_type: { type: String, enum: ['NON_BUYER', 'CROSS_SELL'], default: 'NON_BUYER' },
  stage: { type: Number, default: 1 },           // Tahap saat ini: 1 (awal), 2 (urgensi), 3 (final)
  sent_at: { type: Date, default: Date.now },    // Kapan pesan tahap ini dikirim
  converted: { type: Boolean, default: false },  // true jika user akhirnya beli → stop follow-up
  exited_reason: { type: String, enum: ['TIMEOUT', 'PURCHASE', 'BLOCKED'] },
  variant: { type: String, enum: ['A', 'B'] },   // Untuk A/B Testing
  created_at: { type: Date, default: Date.now }
});
// TTL 180 hari absolut untuk menghapus data usang yang macet atau sudah converted
DripLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const ABTestResultSchema = new mongoose.Schema({
  variant: { type: String, enum: ['A', 'B'] },
  stage: Number,
  converted: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

const CronProgressSchema = new mongoose.Schema({
  date: { type: String, unique: true }, // Format YYYY-MM-DD
  campaign: String, // 'DRIP', 'NON_BUYER', 'VIP', 'CROSS_SELL'
  last_processed_id: mongoose.Schema.Types.ObjectId,
  completed: { type: Boolean, default: false }
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
  DripLog: mongoose.model('DripLog', DripLogSchema),
  BroadcastLog: mongoose.model('BroadcastLog', BroadcastLogSchema),
  ABTestResult: mongoose.model('ABTestResult', ABTestResultSchema),
  CronProgress: mongoose.model('CronProgress', CronProgressSchema)
};
