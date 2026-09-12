/**
 * Unit Test: checkAndIncrementRateLimit() Helper Function (Task 6.1.1)
 * 
 * Tests the global rate limit enforcement helper implemented in Task 2.1.1
 * Validates Bug #2 fix: Max 3 marketing messages per user per day
 * Requirements: 2.2
 */

const { User } = require('../../database');
const scheduler = require('../../scheduler');

// Mock process.env.ADMIN_CHAT_ID for admin bypass tests
const ADMIN_CHAT_ID = '111111'; // From test setup

describe('checkAndIncrementRateLimit() - Task 6.1.1', () => {
  beforeEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_rate_limit_/ });
  });

  afterEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_rate_limit_/ });
  });

  test('Admin Bypass: Admin user should bypass rate limit', async () => {
    // Setup: Create admin user with 3 messages already sent today
    const adminUser = await User.create({
      _id: ADMIN_CHAT_ID,
      username: 'test_rate_limit_admin',
      first_name: 'Admin',
      marketing_messages_today: 3,
      marketing_messages_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      purchase_count: 0
    });

    // Execute: Check rate limit for admin
    const canSend = await scheduler.checkAndIncrementRateLimit(adminUser._id);

    // Expected Behavior: Admin should bypass rate limit even with 3 messages
    expect(canSend).toBe(true);

    // Verify counter was NOT incremented for admin
    const updatedUser = await User.findById(adminUser._id);
    expect(updatedUser.marketing_messages_today).toBe(3); // Should remain at 3
  });

  test('Midnight Reset: Counter should reset at midnight Asia/Jakarta', async () => {
    // Setup: Create user with 2 messages sent and reset time in the past
    const pastMidnight = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const user = await User.create({
      username: 'test_rate_limit_reset',
      first_name: 'Reset Test',
      marketing_messages_today: 2,
      marketing_messages_reset_at: pastMidnight,
      purchase_count: 0
    });

    // Execute: Check rate limit (should trigger reset)
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Counter should reset to 0, then increment to 1
    expect(canSend).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(1); // Reset to 0, then incremented to 1
    expect(updatedUser.marketing_messages_reset_at).not.toEqual(pastMidnight); // New midnight set
    expect(updatedUser.marketing_messages_reset_at > new Date()).toBe(true); // Future date
  });

  test('Limit Enforcement: User at limit (>= 3) should be blocked', async () => {
    // Setup: Create user with exactly 3 messages sent today
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_at_limit',
      first_name: 'At Limit',
      marketing_messages_today: 3,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should return false (rate limit exceeded)
    expect(canSend).toBe(false);

    // Verify counter was NOT incremented
    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(3); // Should remain at 3
  });

  test('Limit Enforcement: User beyond limit (> 3) should be blocked', async () => {
    // Setup: Create user with 4 messages (edge case: somehow bypassed earlier)
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_over_limit',
      first_name: 'Over Limit',
      marketing_messages_today: 4,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should return false
    expect(canSend).toBe(false);

    // Verify counter was NOT incremented
    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(4); // Should remain at 4
  });

  test('Counter Increment: User with 0 messages should increment to 1', async () => {
    // Setup: Create user with 0 messages sent today
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_increment_0',
      first_name: 'Zero Messages',
      marketing_messages_today: 0,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should return true and increment counter
    expect(canSend).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(1); // Incremented from 0 to 1
  });

  test('Counter Increment: User with 1 message should increment to 2', async () => {
    // Setup: Create user with 1 message sent today
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_increment_1',
      first_name: 'One Message',
      marketing_messages_today: 1,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should return true and increment counter
    expect(canSend).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(2); // Incremented from 1 to 2
  });

  test('Counter Increment: User with 2 messages should increment to 3', async () => {
    // Setup: Create user with 2 messages sent today (last allowed message)
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_increment_2',
      first_name: 'Two Messages',
      marketing_messages_today: 2,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should return true and increment counter to 3
    expect(canSend).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(3); // Incremented from 2 to 3
  });

  test('Non-existent User: Should return false for invalid user ID', async () => {
    // Setup: Use non-existent user ID
    const fakeUserId = '507f1f77bcf86cd799439011'; // Valid MongoDB ObjectId format but doesn't exist

    // Execute: Check rate limit
    const canSend = await scheduler.checkAndIncrementRateLimit(fakeUserId);

    // Expected Behavior: Should return false (user not found)
    expect(canSend).toBe(false);
  });

  test('Sequential Calls: Multiple calls should increment counter correctly', async () => {
    // Setup: Create user with 0 messages
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_rate_limit_sequential',
      first_name: 'Sequential Test',
      marketing_messages_today: 0,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Call rate limit check 3 times (max allowed)
    const canSend1 = await scheduler.checkAndIncrementRateLimit(user._id);
    const canSend2 = await scheduler.checkAndIncrementRateLimit(user._id);
    const canSend3 = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: All 3 should succeed
    expect(canSend1).toBe(true);
    expect(canSend2).toBe(true);
    expect(canSend3).toBe(true);

    // Verify counter is now at 3
    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(3);

    // Execute: 4th call should be blocked
    const canSend4 = await scheduler.checkAndIncrementRateLimit(user._id);
    expect(canSend4).toBe(false);

    // Verify counter remains at 3
    const finalUser = await User.findById(user._id);
    expect(finalUser.marketing_messages_today).toBe(3);
  });

  test('Admin Bypass with Counter Increment: Admin counter should not increment', async () => {
    // Setup: Create admin user with counter at 0
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const adminUser = await User.create({
      _id: ADMIN_CHAT_ID,
      username: 'test_rate_limit_admin_counter',
      first_name: 'Admin Counter',
      marketing_messages_today: 0,
      marketing_messages_reset_at: futureReset,
      purchase_count: 0
    });

    // Execute: Multiple calls for admin
    await scheduler.checkAndIncrementRateLimit(adminUser._id);
    await scheduler.checkAndIncrementRateLimit(adminUser._id);
    await scheduler.checkAndIncrementRateLimit(adminUser._id);
    await scheduler.checkAndIncrementRateLimit(adminUser._id);

    // Expected Behavior: Admin counter should remain at 0 (no increment)
    const updatedUser = await User.findById(adminUser._id);
    expect(updatedUser.marketing_messages_today).toBe(0); // Should not increment for admin
  });

  test('Midnight Reset with Increment: Reset should occur then increment', async () => {
    // Setup: Create user at limit with past reset time
    const pastMidnight = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const user = await User.create({
      username: 'test_rate_limit_reset_increment',
      first_name: 'Reset Increment',
      marketing_messages_today: 3, // At limit
      marketing_messages_reset_at: pastMidnight,
      purchase_count: 0
    });

    // Execute: Check rate limit (should reset and allow)
    const canSend = await scheduler.checkAndIncrementRateLimit(user._id);

    // Expected Behavior: Should reset to 0, then increment to 1
    expect(canSend).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.marketing_messages_today).toBe(1); // Reset + incremented
  });
});
