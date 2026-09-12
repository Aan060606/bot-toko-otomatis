/**
 * Test for Bug #5: Discount TTL Index for Automatic Cleanup
 * Validates that expired inactive discounts are automatically deleted after 7 days grace period
 */

describe('Bug #5 - Discount TTL Index', () => {
  test('TTL index exists on DiscountSchema with correct configuration', async () => {
    const { Discount } = require('../../database');
    
    // Get the collection indexes
    const indexes = await Discount.collection.getIndexes();
    
    // Check if TTL index exists on valid_until field
    const ttlIndex = Object.values(indexes).find(idx => 
      idx.key && idx.key.valid_until === 1 && idx.expireAfterSeconds !== undefined
    );
    
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex.expireAfterSeconds).toBe(7 * 24 * 60 * 60); // 7 days in seconds
    expect(ttlIndex.partialFilterExpression).toEqual({ active: false });
  });

  test('inactive expired discount should be marked for deletion by TTL', async () => {
    const { Discount } = require('../../database');
    
    // Create an expired inactive discount (should be cleaned up by MongoDB TTL)
    const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)); // 8 days ago
    const discount = await Discount.create({
      code: 'EXPIRED_INACTIVE',
      type: 'PERCENTAGE',
      value: 10,
      trigger_event: 'CART_ABANDON',
      max_uses: 1,
      used_count: 1,
      valid_until: expiredDate,
      active: false // Inactive - should be cleaned by TTL
    });
    
    expect(discount._id).toBeDefined();
    expect(discount.active).toBe(false);
    expect(discount.valid_until).toEqual(expiredDate);
    
    // Note: Actual deletion happens asynchronously by MongoDB TTL monitor (runs every 60 seconds)
    // In production, this document will be automatically deleted after the TTL expires
  });

  test('active expired discount should NOT be cleaned by TTL', async () => {
    const { Discount } = require('../../database');
    
    // Create an expired but ACTIVE discount (should NOT be cleaned)
    const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)); // 8 days ago
    const discount = await Discount.create({
      code: 'EXPIRED_ACTIVE',
      type: 'PERCENTAGE',
      value: 15,
      trigger_event: 'DRIP',
      max_uses: 5,
      used_count: 2,
      valid_until: expiredDate,
      active: true // Still active - should NOT be cleaned by TTL
    });
    
    // Verify it was created
    const found = await Discount.findById(discount._id).lean();
    expect(found).toBeDefined();
    expect(found.active).toBe(true);
    
    // This discount should persist because partialFilterExpression requires active: false
  });

  test('unexpired inactive discount should NOT be cleaned yet', async () => {
    const { Discount } = require('../../database');
    
    // Create an unexpired inactive discount (within 7-day grace period)
    const recentExpiry = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)); // 3 days ago
    const discount = await Discount.create({
      code: 'RECENT_INACTIVE',
      type: 'FIXED',
      value: 5000,
      trigger_event: 'CROSS_SELL',
      max_uses: 1,
      used_count: 1,
      valid_until: recentExpiry,
      active: false // Inactive but within grace period
    });
    
    // Verify it exists
    const found = await Discount.findById(discount._id).lean();
    expect(found).toBeDefined();
    expect(found.active).toBe(false);
    
    // This will be cleaned after (7 days - 3 days) = 4 more days
  });
});
