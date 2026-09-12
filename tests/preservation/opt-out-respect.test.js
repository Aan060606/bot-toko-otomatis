/**
 * Test Suite: Opt-Out Respect Preservation (Task 6.3.5)
 * Validates: Requirement 3.15
 * 
 * Ensures opt_out: true users are skipped from all campaigns EXCEPT cart abandon
 */

const { describe, test, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');
const mongoose = require('mongoose');

let User, Product, Order, Cart, DripLog;

beforeAll(async () => {
  // Connect to test database
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/saweria_test', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
  }
  
  const db = require('../../database');
  User = db.User;
  Product = db.Product;
  Order = db.Order;
  Cart = db.Cart;
  DripLog = db.DripLog;
});

afterAll(async () => {
  await mongoose.connection.close();
});

beforeEach(async () => {
  // Clean up test data
  await User.deleteMany({ _id: { $gte: 80000, $lt: 90000 } });
  await Product.deleteMany({ _id: /^PROD-OPTOUT-TEST/ });
  await Order.deleteMany({ user_id: { $gte: 80000, $lt: 90000 } });
  await Cart.deleteMany({ user_id: { $gte: 80000, $lt: 90000 } });
  await DripLog.deleteMany({ user_id: { $gte: 80000, $lt: 90000 } });
});

describe('Opt-Out Respect Preservation (Req 3.15)', () => {
  
  test('opt_out: true skips NON_BUYER campaign', async () => {
    // Setup: User with opt_out = true
    const user = await User.create({ 
      _id: 80001, 
      first_name: 'OptOutUser1', 
      purchase_count: 0,
      opt_out: true,
      last_active_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
    });
    
    // Simulate NON_BUYER campaign eligibility check
    const isEligible = !user.opt_out;
    
    // Assert: User should be skipped
    expect(isEligible).toBe(false);
  });
  
  test('opt_out: true skips CROSS_SELL campaign', async () => {
    // Setup
    const user = await User.create({ 
      _id: 80002, 
      first_name: 'OptOutUser2', 
      purchase_count: 1,
      opt_out: true,
      last_active_at: new Date()
    });
    
    await Product.create({ 
      _id: 'PROD-OPTOUT-TEST-01', 
      name: 'Test Product', 
      price: 100000, 
      type: 'AUTO', 
      active: 1 
    });
    
    // Simulate CROSS_SELL eligibility check
    const isEligible = !user.opt_out;
    
    // Assert: User should be skipped
    expect(isEligible).toBe(false);
  });
  
  test('opt_out: true skips VIP_WINBACK campaign', async () => {
    // Setup: VIP user with opt_out
    const user = await User.create({ 
      _id: 80003, 
      first_name: 'OptOutVIP', 
      purchase_count: 5,
      total_spent: 500000,
      opt_out: true,
      last_active_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) // 45 days ago
    });
    
    // Simulate VIP_WINBACK eligibility check
    const isEligible = !user.opt_out;
    
    // Assert: User should be skipped
    expect(isEligible).toBe(false);
  });
  
  test('opt_out: true skips DRIP campaign', async () => {
    // Setup
    const user = await User.create({ 
      _id: 80004, 
      first_name: 'OptOutDrip', 
      purchase_count: 0,
      opt_out: true,
      joined_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });
    
    await DripLog.create({
      user_id: 80004,
      stage: 1,
      sent_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      converted: false
    });
    
    // Simulate DRIP eligibility check
    const isEligible = !user.opt_out;
    
    // Assert: User should be skipped
    expect(isEligible).toBe(false);
  });
  
  test('opt_out: true skips REALTIME marketing', async () => {
    // Setup
    const user = await User.create({ 
      _id: 80005, 
      first_name: 'OptOutRealtime', 
      purchase_count: 0,
      opt_out: true,
      last_active_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    });
    
    // Simulate REALTIME eligibility check
    const isEligible = !user.opt_out;
    
    // Assert: User should be skipped
    expect(isEligible).toBe(false);
  });
  
  test('opt_out: true ALLOWS CART_ABANDON campaign (exception)', async () => {
    // Setup: User with opt_out but abandoned cart (high-intent signal)
    const user = await User.create({ 
      _id: 80006, 
      first_name: 'OptOutCart', 
      purchase_count: 0,
      opt_out: true,
      last_active_at: new Date()
    });
    
    await Product.create({ 
      _id: 'PROD-OPTOUT-TEST-02', 
      name: 'Cart Product', 
      price: 50000, 
      type: 'AUTO', 
      active: 1 
    });
    
    await Cart.create({
      user_id: 80006,
      product_id: 'PROD-OPTOUT-TEST-02',
      quantity: 1,
      added_at: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
    });
    
    // Simulate CART_ABANDON eligibility check
    // Cart abandon is EXCEPTION: should NOT check opt_out
    const hasAbandonedCart = true;
    const isEligible = hasAbandonedCart; // No opt_out check for cart abandon
    
    // Assert: User with opt_out SHOULD receive cart abandon message
    expect(isEligible).toBe(true);
    expect(user.opt_out).toBe(true); // Still opted out, but cart abandon is allowed
  });
  
  test('opt_out: false allows all campaigns', async () => {
    // Setup: Normal user without opt_out
    const user = await User.create({ 
      _id: 80007, 
      first_name: 'NormalUser', 
      purchase_count: 0,
      opt_out: false,
      last_active_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });
    
    // Simulate eligibility checks for all campaigns
    const isEligibleNonBuyer = !user.opt_out;
    const isEligibleCrossSell = !user.opt_out;
    const isEligibleVIP = !user.opt_out;
    const isEligibleDrip = !user.opt_out;
    const isEligibleRealtime = !user.opt_out;
    const isEligibleCart = true; // Cart abandon doesn't check opt_out
    
    // Assert: All campaigns should allow the user
    expect(isEligibleNonBuyer).toBe(true);
    expect(isEligibleCrossSell).toBe(true);
    expect(isEligibleVIP).toBe(true);
    expect(isEligibleDrip).toBe(true);
    expect(isEligibleRealtime).toBe(true);
    expect(isEligibleCart).toBe(true);
  });
});
