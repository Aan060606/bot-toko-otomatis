const fs = require('fs');
const mongoose = require('mongoose');
const { User, Product, Stock, Cart, Order, OrderItem, Setting, UserEvent, Discount, DripLog, CronProgress } = require('./database');

async function dump() {
  try {
    console.log("Starting DB Dump...");
    const data = {
      users: await User.find().lean(),
      products: await Product.find().lean(),
      stocks: await Stock.find().lean(),
      orders: await Order.find().lean(),
      orderItems: await OrderItem.find().lean(),
      userEvents: await UserEvent.find().lean(),
      discounts: await Discount.find().lean(),
      dripLogs: await DripLog.find().lean(),
      settings: await Setting.find().lean(),
      cronProgress: await CronProgress.find().lean()
    };
    
    fs.writeFileSync('./db_dump.json', JSON.stringify(data));
    console.log("DB Dump successful!");
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

dump();
