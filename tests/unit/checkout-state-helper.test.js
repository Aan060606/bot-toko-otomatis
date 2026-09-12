/**
 * Unit Test: isUserInCheckout() Helper Function (Task 6.1.3)
 * 
 * Tests the checkout state check helper implemented in Task 2.3.1
 * Validates Bug #11 fix: Prevent marketing messages during active checkout/payment flow
 * Requirements: 2.11
 */

const { User, Order, Product, Stock } = require('../../database');
const scheduler = require('../../scheduler');

describe('isUserInCheckout() - Task 6.1.3', () => {
  let testUser;
  let testProduct;
  let testStock;

  beforeEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_checkout_/ });
    await Order.deleteMany({ order_id: /^TEST_CHECKOUT_/ });
    await Product.deleteMany({ name: /^Test Checkout Product/ });
    await Stock.deleteMany({ stock_id: /^TEST_STOCK_CHECKOUT_/ });

    // Create test user
    testUser = await User.create({
      username: 'test_checkout_user',
      first_name: 'Checkout Test',
      purchase_count: 0,
      marketing_messages_today: 0
    });

    // Create test product
    testProduct = await Product.create({
      name: 'Test Checkout Product',
      description: 'Product for checkout state tests',
      price: 50000,
      is_active: true
    });

    // Create test stock
    testStock = await Stock.create({
      stock_id: `TEST_STOCK_CHECKOUT_${Date.now()}`,
      product_id: testProduct._id,
      stock_data: 'test-data-123',
      status: 'AVAILABLE',
      added_at: new Date()
    });
  });

  afterEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_checkout_/ });
    await Order.deleteMany({ order_id: /^TEST_CHECKOUT_/ });
    await Product.deleteMany({ name: /^Test Checkout Product/ });
    await Stock.deleteMany({ stock_id: /^TEST_STOCK_CHECKOUT_/ });
  });

  test('PENDING Order: Should return true when user has PENDING order', async () => {
    // Setup: Create a PENDING order for the test user
    await Order.create({
      order_id: `TEST_CHECKOUT_PENDING_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-pending',
      created_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return true (user has pending order)
    expect(isInCheckout).toBe(true);
  });

  test('COMPLETED Order: Should return false when user has only COMPLETED order', async () => {
    // Setup: Create a COMPLETED order for the test user
    await Order.create({
      order_id: `TEST_CHECKOUT_COMPLETED_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'COMPLETED',
      payment_url: 'https://saweria.co/test-completed',
      created_at: new Date(),
      completed_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return false (no pending order)
    expect(isInCheckout).toBe(false);
  });

  test('No Order: Should return false when user has no orders', async () => {
    // Setup: User already created with no orders

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return false (no orders at all)
    expect(isInCheckout).toBe(false);
  });

  test('CANCELLED Order: Should return false when user has only CANCELLED order', async () => {
    // Setup: Create a CANCELLED order for the test user
    await Order.create({
      order_id: `TEST_CHECKOUT_CANCELLED_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'CANCELLED',
      payment_url: 'https://saweria.co/test-cancelled',
      created_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return false (no pending order)
    expect(isInCheckout).toBe(false);
  });

  test('Multiple Orders: Should return true when user has PENDING order among others', async () => {
    // Setup: Create multiple orders with different statuses
    await Order.create({
      order_id: `TEST_CHECKOUT_MULTI_COMPLETED_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'COMPLETED',
      payment_url: 'https://saweria.co/test-multi-1',
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
      completed_at: new Date(Date.now() - 24 * 60 * 60 * 1000)
    });

    await Order.create({
      order_id: `TEST_CHECKOUT_MULTI_PENDING_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-multi-2',
      created_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return true (has at least one pending order)
    expect(isInCheckout).toBe(true);
  });

  test('Multiple PENDING Orders: Should return true when user has multiple PENDING orders', async () => {
    // Setup: Create multiple PENDING orders (edge case scenario)
    await Order.create({
      order_id: `TEST_CHECKOUT_PENDING1_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-pending-1',
      created_at: new Date()
    });

    await Order.create({
      order_id: `TEST_CHECKOUT_PENDING2_${Date.now() + 1}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-pending-2',
      created_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return true (has pending orders)
    expect(isInCheckout).toBe(true);
  });

  test('Invalid User ID: Should return false for non-existent user', async () => {
    // Setup: Use non-existent user ID
    const fakeUserId = '507f1f77bcf86cd799439011'; // Valid MongoDB ObjectId format but doesn't exist

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(fakeUserId);

    // Expected Behavior: Should return false (no user, no orders)
    expect(isInCheckout).toBe(false);
  });

  test('EXPIRED Order: Should return false when user has only EXPIRED order', async () => {
    // Setup: Create an EXPIRED order for the test user
    await Order.create({
      order_id: `TEST_CHECKOUT_EXPIRED_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'EXPIRED',
      payment_url: 'https://saweria.co/test-expired',
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      expired_at: new Date()
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return false (no pending order)
    expect(isInCheckout).toBe(false);
  });

  test('Order Lifecycle: Should transition from true to false when order completes', async () => {
    // Setup: Create a PENDING order
    const orderId = `TEST_CHECKOUT_LIFECYCLE_${Date.now()}`;
    const order = await Order.create({
      order_id: orderId,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-lifecycle',
      created_at: new Date()
    });

    // Execute: Check while PENDING
    const isInCheckoutBefore = await scheduler.isUserInCheckout(testUser._id);

    // Expected: Should be true
    expect(isInCheckoutBefore).toBe(true);

    // Setup: Update order to COMPLETED
    await Order.findByIdAndUpdate(order._id, {
      status: 'COMPLETED',
      completed_at: new Date()
    });

    // Execute: Check after COMPLETED
    const isInCheckoutAfter = await scheduler.isUserInCheckout(testUser._id);

    // Expected: Should be false now
    expect(isInCheckoutAfter).toBe(false);
  });

  test('Mixed Status Orders: Should return false when no PENDING orders exist', async () => {
    // Setup: Create orders with various non-PENDING statuses
    await Order.create({
      order_id: `TEST_CHECKOUT_MIXED1_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'COMPLETED',
      payment_url: 'https://saweria.co/test-mixed-1',
      created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      completed_at: new Date(Date.now() - 48 * 60 * 60 * 1000)
    });

    await Order.create({
      order_id: `TEST_CHECKOUT_MIXED2_${Date.now() + 1}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'CANCELLED',
      payment_url: 'https://saweria.co/test-mixed-2',
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000)
    });

    await Order.create({
      order_id: `TEST_CHECKOUT_MIXED3_${Date.now() + 2}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'EXPIRED',
      payment_url: 'https://saweria.co/test-mixed-3',
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
      expired_at: new Date(Date.now() - 1 * 60 * 60 * 1000)
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return false (no pending orders)
    expect(isInCheckout).toBe(false);
  });

  test('Recent PENDING Order: Should return true for newly created PENDING order', async () => {
    // Setup: Create a very recent PENDING order (simulating immediate checkout)
    await Order.create({
      order_id: `TEST_CHECKOUT_RECENT_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-recent',
      created_at: new Date() // Just now
    });

    // Execute: Check immediately after order creation
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return true immediately
    expect(isInCheckout).toBe(true);
  });

  test('Old PENDING Order: Should return true even for old PENDING orders', async () => {
    // Setup: Create an old PENDING order (user started checkout but never completed)
    await Order.create({
      order_id: `TEST_CHECKOUT_OLD_${Date.now()}`,
      user_id: testUser._id,
      product_id: testProduct._id,
      stock_id: testStock._id,
      quantity: 1,
      total_amount: 50000,
      status: 'PENDING',
      payment_url: 'https://saweria.co/test-old',
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
    });

    // Execute: Check if user is in checkout
    const isInCheckout = await scheduler.isUserInCheckout(testUser._id);

    // Expected Behavior: Should return true (still pending, age doesn't matter)
    expect(isInCheckout).toBe(true);
  });
});
