const { Discount, User } = require('./database');
const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const discounts = await Discount.find().lean();
  console.log("ALL DISCOUNTS:", discounts);
  const user = await User.findOne().sort('-created_at').lean();
  console.log("LAST USER:", user);
  process.exit(0);
}
run();
