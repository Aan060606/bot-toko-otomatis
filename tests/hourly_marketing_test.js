const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
// Dependencies will be required dynamically

// Mock Telegraf Bot
const mockBot = {
  telegram: {
    sendMessage: async () => true,
    sendPhoto: async () => true,
    sendAnimation: async () => true,
  }
};

async function runAudit() {
  console.log("🚀 Memulai Audit Simulasi Fast-Paced Marketing...");
  
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  
  // Dynamically require after env is set to override database.js top-level connection
  const { User, Product, DripLog, UserEvent, CronProgress } = require('../database');
  const scheduler = require('../scheduler');

  console.log("✅ Mock Database Connected.");

  let currentTime = new Date('2026-07-01T00:00:00Z');
  
  const OriginalDate = global.Date;
  
  const advanceTime = (hours) => {
    currentTime = new Date(currentTime.getTime() + (hours * 60 * 60 * 1000));
    console.log(`\n⏳ WAKTU MAJU: ${hours} Jam -> Sekarang: ${currentTime.toISOString()}`);
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length) return new OriginalDate(...args);
        return new OriginalDate(currentTime.getTime());
      }
      static now() {
        return currentTime.getTime();
      }
    };
  };

  advanceTime(0);

  // Create Mock Product
  const product = await Product.create({
    _id: 'PROD-TEST',
    name: 'VIP JAV SUB INDO',
    price: 50000,
    active: 1
  });

  // Create Mock Users
  // 1. Cold Lead (Baru join, belum pernah beli, aktif)
  const coldUser = await User.create({
    _id: 111,
    first_name: 'ColdUser',
    joined_at: new Date(currentTime.getTime() - (2 * 60 * 60 * 1000)), // Gabung 2 jam lalu
    last_active_at: new Date(currentTime.getTime() - (1 * 60 * 60 * 1000)),
    purchase_count: 0
  });

  // 2. Cart Abandon (Pernah checkout, belum beli)
  const abandonUser = await User.create({
    _id: 222,
    first_name: 'AbandonUser',
    joined_at: new Date(currentTime.getTime() - (24 * 60 * 60 * 1000)),
    last_active_at: new Date(currentTime.getTime() - (1 * 60 * 60 * 1000)),
    purchase_count: 0
  });
  await UserEvent.create({
    user_id: 222,
    event_type: 'CHECKOUT',
    created_at: new Date(currentTime.getTime() - (1 * 60 * 60 * 1000))
  });

  console.log("👥 Mock Users Created.");

  console.log("\n====================================");
  console.log("🕒 T=0 Jam (Memulai Stage 1)");
  console.log("====================================");
  await scheduler.runMarketingCampaign(mockBot, 'DAY_0');
  
  const dripLog1 = await DripLog.findOne({ user_id: 111 }).lean();
  console.log(`ColdUser Drip Stage: ${dripLog1 ? dripLog1.stage : 'TIDAK ADA'} (Ekspektasi: 1)`);
  
  const dripLog2 = await DripLog.findOne({ user_id: 222 }).lean();
  console.log(`AbandonUser Drip Stage: ${dripLog2 ? dripLog2.stage : 'TIDAK ADA'} (Ekspektasi: 1)`);

  console.log("\n====================================");
  console.log("🕒 T=3 Jam (Uji Anti-Spam Cooldown)");
  console.log("====================================");
  advanceTime(3);
  await scheduler.runMarketingCampaign(mockBot, 'DAY_0_H3');
  
  const checkCooldown1 = await DripLog.findOne({ user_id: 111 }).lean();
  console.log(`ColdUser Drip Stage: ${checkCooldown1.stage} (Ekspektasi: 1 - karena tertahan Cooldown 6 Jam)`);

  console.log("\n====================================");
  console.log("🕒 T=7 Jam (Pemicu Stage 2 -> Syarat: 6 Jam dari Stage 1)");
  console.log("====================================");
  advanceTime(4); // 3 + 4 = 7 Jam dari T=0
  await scheduler.runMarketingCampaign(mockBot, 'DAY_0_H7');

  const checkStage2 = await DripLog.findOne({ user_id: 111 }).lean();
  console.log(`ColdUser Drip Stage: ${checkStage2.stage} (Ekspektasi: 2)`);

  console.log("\n====================================");
  console.log("🕒 T=15 Jam (Syarat Stage 3: 12 Jam dari Stage 2 - Seharusnya DITOLAK)");
  console.log("====================================");
  advanceTime(8); // 7 + 8 = 15 Jam dari T=0 (Baru 8 jam dari Stage 2)
  await scheduler.runMarketingCampaign(mockBot, 'DAY_0_H15');

  const checkStage3False = await DripLog.findOne({ user_id: 111 }).lean();
  console.log(`ColdUser Drip Stage: ${checkStage3False.stage} (Ekspektasi: 2 - belum genap 12 jam sejak Stage 2)`);

  console.log("\n====================================");
  console.log("🕒 T=20 Jam (Pemicu Stage 3 -> Syarat: 12 Jam dari Stage 2)");
  console.log("====================================");
  advanceTime(5); // 15 + 5 = 20 Jam dari T=0 (Sudah 13 jam dari Stage 2)
  await scheduler.runMarketingCampaign(mockBot, 'DAY_0_H20');

  const checkStage3True = await DripLog.findOne({ user_id: 111 }).lean();
  console.log(`ColdUser Drip Stage: ${checkStage3True.stage} (Ekspektasi: 3)`);

  console.log("\n✅ SEMUA SKENARIO AUDIT SELESAI!");

  await mongoose.disconnect();
  await mongoServer.stop();
  global.Date = OriginalDate;
}

runAudit().catch(console.error);
