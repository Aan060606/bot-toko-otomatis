require('dotenv').config();
const mongoose = require('mongoose');
const { User, Order, Product, DripLog, Discount, CronProgress } = require('./database');
const scheduler = require('./scheduler');
const store = require('./store');

async function runQA() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to DB for QA Simulation');

  console.log('\n--- SIMULATING MARKETING FLOWS ---');
  
  const allProducts = await Product.find({ active: 1 }).lean();
  console.log(`📦 Found ${allProducts.length} active products.`);

  // 1. Simulate RT Marketing trigger for a buyer who hasn't bought everything
  console.log('\n🔍 SCENARIO 1: Realtime Marketing for Buyer (Should offer unbought products)');
  const buyer = await User.findOne({ purchase_count: { $gt: 0 }, last_broadcast_at: { $lt: new Date(Date.now() - 48*3600*1000) } }).lean();
  if (buyer) {
    console.log(`   Buyer found: ${buyer.first_name} (ID: ${buyer._id})`);
    // Instead of actually sending, we just check what buildAllProductsKeyboard would return
    const boughtIds = await scheduler.getBoughtProductIds(buyer._id);
    console.log(`   Has bought products: ${boughtIds.length} out of ${allProducts.length}`);
    const { products: unboughtProducts } = await scheduler.buildAllProductsKeyboard(buyer._id, allProducts, 10);
    console.log(`   Targeted with RT Marketing for ${unboughtProducts.length} unbought products.`);
    console.log(unboughtProducts.length > 0 ? '   ✅ PASS: Buyer gets RT Marketing for unbought products.' : '   ℹ️ Buyer already bought everything.');
  }

  // 2. Simulate Cart Abandon Check
  console.log('\n🔍 SCENARIO 2: Cart Abandonment Recovery');
  const abandonCount = await DripLog.countDocuments({ campaign_type: 'CART_ABANDON', stage: 0, converted: false });
  console.log(`   Pending Cart Abandonments: ${abandonCount}`);
  if (abandonCount > 0) {
    console.log('   ✅ PASS: Cart Abandonment queue is active.');
  }

  // 3. Simulate Drip Follow-Up
  console.log('\n🔍 SCENARIO 3: Drip Follow-up Queue');
  const dripCount = await DripLog.countDocuments({ campaign_type: { $ne: 'CART_ABANDON' }, stage: { $gt: 0 }, converted: false });
  console.log(`   Pending Drip Logs (S1/S2/S3): ${dripCount}`);

  // 4. Simulate Post-Purchase
  console.log('\n🔍 SCENARIO 4: Post-Purchase / Cross-Sell Flow');
  const ppCount = await DripLog.countDocuments({ campaign_type: 'POST_PURCHASE', converted: false });
  console.log(`   Active Post-Purchase Logs: ${ppCount}`);

  console.log('\n✅ QA SIMULATION COMPLETE.');
  process.exit(0);
}

// Expose internal functions for QA testing if possible, or just simulate DB states.
runQA().catch(console.error);
