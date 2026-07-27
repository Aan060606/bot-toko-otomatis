const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

// Mock bot & scheduler functions
const bot = {
  telegram: {
    sendMessage: async (id, text) => console.log(`[BOT] Pesan terkirim ke User ${id}:\n`, text.split('\n')[0], '...'),
    sendAnimation: async (id, file, opts) => console.log(`[BOT] Animasi terkirim ke User ${id} dengan caption:\n`, opts.caption.split('\n')[0], '...'),
    sendPhoto: async (id, file, opts) => console.log(`[BOT] Photo terkirim ke User ${id} dengan caption:\n`, opts.caption.split('\n')[0], '...')
  }
};

async function run() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  
  // Set env var BEFORE requiring database.js so it connects to our memory server!
  process.env.MONGODB_URI = uri;
  
  const { User, UserEvent, Product, DripLog, OrderItem, Setting, Discount, ABTestResult, CronProgress } = require('./database');
  const scheduler = require('./scheduler');

  await new Promise(r => setTimeout(r, 1000));
  
  console.log("✅ Mesin Waktu DB Siap!");

  // Siapkan Data
  await Product.create({ _id: "PROD-1", name: "VIP PREMIUM", price: 100000, type: "AUTO", active: 1 });
  // Kita hilangkan ID dan order_id untuk menghindari cast error
  await OrderItem.create({ product_id: "PROD-1", quantity: 1, price: 100000, fulfilled: 1 }); 

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  await User.create({ _id: 111, first_name: "Abandon", purchase_count: 0, joined_at: new Date(now - 30 * dayMs), last_active_at: new Date(now - 2 * dayMs) });
  await UserEvent.create({ user_id: 111, event_type: "CHECKOUT", product_id: "PROD-1", created_at: new Date(now - 2 * dayMs) });

  await User.create({ _id: 222, first_name: "Inactive", purchase_count: 0, joined_at: new Date(now - 30 * dayMs), last_active_at: new Date(now - 8 * dayMs) });

  await User.create({ _id: 333, first_name: "Cold", purchase_count: 0, joined_at: new Date(now - 30 * dayMs), last_active_at: new Date(now - 1 * dayMs) });

  console.log("\n🚀 MENJALANKAN CAMPAIGN 1 (NON-BUYER) - HARI KE-0");
  const stats1 = await scheduler.runMarketingCampaign(bot, "DAY_0");
  console.log("📊 Stats Campaign 1:", stats1);
  
  const drips = await DripLog.find({}).lean();
  console.log(`💧 Drip Logs Tercipta: ${drips.length} user dimasukkan ke funnel Stage 1.`);

  console.log("\n⏳ MEMUTAR WAKTU KE HARI KE-3...");
  await DripLog.updateMany({}, { $set: { sent_at: new Date(now - 4 * dayMs) } });
  
  // Hapus cooldown shield agar bisa dikirim lagi dalam simulasi
  await User.updateMany({}, { $set: { last_broadcast_at: new Date(now - 4 * dayMs) } });

  console.log("\n🚀 MENJALANKAN CAMPAIGN 3 (DRIP STAGE 2) - HARI KE-3");
  const stats2 = await scheduler.runMarketingCampaign(bot, "DAY_3");
  console.log("📊 Stats Drip Stage 2:", stats2);

  console.log("\n⏳ MEMUTAR WAKTU KE HARI KE-6...");
  await DripLog.updateMany({ stage: 2 }, { $set: { sent_at: new Date(now - 4 * dayMs) } });
  await User.updateMany({}, { $set: { last_broadcast_at: new Date(now - 4 * dayMs) } });

  console.log("\n🚀 MENJALANKAN CAMPAIGN 3 (DRIP STAGE 3) - HARI KE-6");
  const stats3 = await scheduler.runMarketingCampaign(bot, "DAY_6");
  console.log("📊 Stats Drip Stage 3:", stats3);

  // Cek Diskon Darurat
  const discounts = await Discount.find({}).lean();
  console.log(`🎟️ Diskon Darurat Tercipta: ${discounts.length} diskon.`);
  
  await mongoose.disconnect();
  await mongod.stop();
  console.log("\n✅ SIMULASI SELESAI!");
}

run().catch(console.error);
