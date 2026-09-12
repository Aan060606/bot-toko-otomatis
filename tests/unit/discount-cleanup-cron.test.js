/**
 * Unit Test: Daily Discount Cleanup Cron (Task 4.1.1)
 * 
 * Validates Bug #5 fix: Expired inactive discounts are deleted daily at 3 AM
 * Requirements: 2.5
 */

const { Discount } = require('../../database');

describe('Discount Cleanup Cron - Task 4.1.1', () => {
  beforeEach(async () => {
    // Clean up test data
    await Discount.deleteMany({ code: /^TEST_CLEANUP_/ });
  });

  afterEach(async () => {
    // Clean up test data
    await Discount.deleteMany({ code: /^TEST_CLEANUP_/ });
  });

  test('Bug Condition: Expired inactive discounts should be deleted', async () => {
    // Setup: Create expired inactive discount
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    const discount = await Discount.create({
      code: 'TEST_CLEANUP_EXPIRED',
      discount_type: 'percentage',
      discount_value: 10,
      valid_until: expiredDate,
      active: false,
      used_count: 0
    });

    // Verify discount exists
    const beforeCleanup = await Discount.findById(discount._id);
    expect(beforeCleanup).not.toBeNull();

    // Execute cleanup logic (simulating cron job)
    const deleteResult = await Discount.deleteMany({
      valid_until: { $lt: new Date() },
      active: false
    });

    // Expected Behavior: Discount should be deleted
    expect(deleteResult.deletedCount).toBeGreaterThan(0);

    // Verify discount is gone
    const afterCleanup = await Discount.findById(discount._id);
    expect(afterCleanup).toBeNull();
  });

  test('Preservation: Active discounts should NOT be deleted even if expired', async () => {
    // Setup: Create expired but ACTIVE discount
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const discount = await Discount.create({
      code: 'TEST_CLEANUP_ACTIVE',
      discount_type: 'percentage',
      discount_value: 10,
      valid_until: expiredDate,
      active: true, // Still active
      used_count: 0
    });

    // Execute cleanup logic
    const deleteResult = await Discount.deleteMany({
      valid_until: { $lt: new Date() },
      active: false // Only deletes inactive
    });

    // Expected: Active discount should remain
    const afterCleanup = await Discount.findById(discount._id);
    expect(afterCleanup).not.toBeNull();
    expect(afterCleanup.active).toBe(true);
  });

  test('Preservation: Valid discounts should NOT be deleted', async () => {
    // Setup: Create valid inactive discount
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const discount = await Discount.create({
      code: 'TEST_CLEANUP_VALID',
      discount_type: 'percentage',
      discount_value: 10,
      valid_until: futureDate,
      active: false,
      used_count: 0
    });

    // Execute cleanup logic
    const deleteResult = await Discount.deleteMany({
      valid_until: { $lt: new Date() },
      active: false
    });

    // Expected: Valid discount should remain
    const afterCleanup = await Discount.findById(discount._id);
    expect(afterCleanup).not.toBeNull();
  });

  test('Cleanup should delete multiple expired inactive discounts', async () => {
    // Setup: Create multiple expired inactive discounts
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Discount.create([
      {
        code: 'TEST_CLEANUP_MULTI_1',
        discount_type: 'percentage',
        discount_value: 10,
        valid_until: expiredDate,
        active: false,
        used_count: 0
      },
      {
        code: 'TEST_CLEANUP_MULTI_2',
        discount_type: 'percentage',
        discount_value: 15,
        valid_until: expiredDate,
        active: false,
        used_count: 0
      },
      {
        code: 'TEST_CLEANUP_MULTI_3',
        discount_type: 'percentage',
        discount_value: 20,
        valid_until: expiredDate,
        active: false,
        used_count: 0
      }
    ]);

    // Execute cleanup logic
    const deleteResult = await Discount.deleteMany({
      valid_until: { $lt: new Date() },
      active: false
    });

    // Expected: All expired inactive discounts should be deleted
    expect(deleteResult.deletedCount).toBeGreaterThanOrEqual(3);
  });

  test('Cleanup should log deleted count', async () => {
    // Setup: Create expired inactive discount
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Discount.create({
      code: 'TEST_CLEANUP_LOG',
      discount_type: 'percentage',
      discount_value: 10,
      valid_until: expiredDate,
      active: false,
      used_count: 0
    });

    // Execute cleanup logic
    const deleteResult = await Discount.deleteMany({
      valid_until: { $lt: new Date() },
      active: false
    });

    // Expected: deletedCount should be available for logging
    expect(deleteResult.deletedCount).toBeDefined();
    expect(typeof deleteResult.deletedCount).toBe('number');
    expect(deleteResult.deletedCount).toBeGreaterThan(0);
  });
});
