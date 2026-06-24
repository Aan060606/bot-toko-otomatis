const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:test-token';
  process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '111111';

  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri('saweria_bot_test');
});

beforeEach(async () => {
  const { User, Product, Stock, Cart, Order, OrderItem, Setting, Discount, UserEvent, DripLog, BroadcastLog } = require('../../database');
  await Promise.all([
    User.deleteMany({}),
    Product.deleteMany({}),
    Stock.deleteMany({}),
    Cart.deleteMany({}),
    Order.deleteMany({}),
    OrderItem.deleteMany({}),
    Setting.deleteMany({}),
    Discount.deleteMany({}),
    UserEvent.deleteMany({}),
    DripLog.deleteMany({}),
    BroadcastLog.deleteMany({})
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
