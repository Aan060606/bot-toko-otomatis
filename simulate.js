const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { User, Product, Order, OrderItem } = require('./database');
const scheduler = require('./scheduler');

async function runSimulation() {
  await mongoose.disconnect(); // Disconnect default connection
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // 1. Seed Products
  const p1 = await Product.create({ name: 'VIP Basic', price: 10000, active: 1, preview_url: 'http://preview.basic' });
  const p2 = await Product.create({ name: 'VIP Indo', price: 20000, active: 1, preview_url: 'http://preview.indo' });
  const p3 = await Product.create({ name: 'VIP Premium', price: 50000, active: 1 });

  // 2. Seed Users
  const uCold = await User.create({ _id: 101, first_name: 'Budi (Cold)', purchase_count: 0, last_active_at: new Date() });
  
  const uCross = await User.create({ _id: 102, first_name: 'Agus (Cross-Sell)', purchase_count: 1, last_active_at: new Date() });
  const order = await Order.create({ _id: 'ORD-102', user_id: 102, status: 'SUCCESS', amount: 10000 });
  await OrderItem.create({ order_id: order._id, product_id: p1._id, price: 10000 }); // Agus bought VIP Basic

  const uCross2 = await User.create({ _id: 103, first_name: 'Siti (Cross-Sell 2)', purchase_count: 1, last_active_at: new Date() });
  const order2 = await Order.create({ _id: 'ORD-103', user_id: 103, status: 'SUCCESS', amount: 20000 });
  await OrderItem.create({ order_id: order2._id, product_id: p2._id, price: 20000 }); // Siti bought VIP Indo

  // Let's create a trend: people who buy VIP Basic ALSO buy VIP Premium
  const uTrend = await User.create({ _id: 104, first_name: 'Joko (Trendsetter)', purchase_count: 2, last_active_at: new Date() });
  const order3 = await Order.create({ _id: 'ORD-104', user_id: 104, status: 'SUCCESS', amount: 60000 });
  await OrderItem.create({ order_id: order3._id, product_id: p1._id, price: 10000 });
  await OrderItem.create({ order_id: order3._id, product_id: p3._id, price: 50000 });

  // 3. Mock Bot
  const logs = [];
  const fakeBot = {
    telegram: {
      sendPhoto: async (userId, photo, extra) => {
        let btnText = "TIDAK ADA TOMBOL";
        if (extra.reply_markup && extra.reply_markup.inline_keyboard) {
          btnText = extra.reply_markup.inline_keyboard.map(row => row.map(b => b.text).join(' | ')).join('\n');
        }
        const u = await User.findById(userId);
        logs.push(`\n[ KE: ${u.first_name} ]\nTEKS:\n${extra.caption}\n\nTOMBOL:\n${btnText}\n------------------------`);
      },
      sendMessage: async (userId, text, extra) => {
        let btnText = "TIDAK ADA TOMBOL";
        if (extra.reply_markup && extra.reply_markup.inline_keyboard) {
          btnText = extra.reply_markup.inline_keyboard.map(row => row.map(b => b.text).join(' | ')).join('\n');
        }
        const u = await User.findById(userId);
        logs.push(`\n[ KE: ${u.first_name} ]\nTEKS:\n${text}\n\nTOMBOL:\n${btnText}\n------------------------`);
      }
    }
  };

  // 4. Run marketing
  await scheduler.runMarketingCampaign(fakeBot);

  console.log(logs.join('\n'));
  
  await mongoose.disconnect();
  await mongod.stop();
}

runSimulation().catch(console.error);
