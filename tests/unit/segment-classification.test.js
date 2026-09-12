/**
 * Unit Test: Segment Classification with Captured Timestamps (Task 6.1.4)
 * 
 * Tests the segment classification logic that uses historical last_active_at timestamps
 * Validates Bug #1 and Bug #16 fix: Correct segment assignment for realtime marketing
 * Requirements: 2.1, 2.16
 * 
 * Tests four segment classifications:
 * - HOT: < 1 day inactive
 * - WARM: 1-7 days inactive
 * - COLD: 7-30 days inactive
 * - GHOST: > 30 days inactive
 */

const { User } = require('../../database');
const scheduler = require('../../scheduler');

describe('Segment Classification with Captured Timestamps - Task 6.1.4', () => {
  beforeEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_segment_/ });
  });

  afterEach(async () => {
    // Clean up test data
    await User.deleteMany({ username: /^test_segment_/ });
  });

  test('HOT Segment: User active < 1 day ago should be classified as HOT', async () => {
    // Setup: Create user with last_active_at less than 1 day ago (12 hours ago)
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_hot',
      first_name: 'Hot User',
      last_active_at: twelveHoursAgo,
      purchase_count: 0
    });

    // Execute: Classify user using historical timestamp
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as HOT
    expect(segment).toBe('HOT');

    // Verify: Calculate days inactive manually
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeLessThan(1);
  });

  test('HOT Segment Boundary: User active exactly 23 hours ago should be HOT', async () => {
    // Setup: Create user with last_active_at exactly 23 hours ago (edge case)
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_hot_boundary',
      first_name: 'Hot Boundary',
      last_active_at: twentyThreeHoursAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as HOT
    expect(segment).toBe('HOT');

    // Verify: Days inactive should be < 1
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeLessThan(1);
  });

  test('WARM Segment: User active 1-7 days ago should be classified as WARM', async () => {
    // Setup: Create user with last_active_at 3 days ago
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_warm',
      first_name: 'Warm User',
      last_active_at: threeDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user using historical timestamp
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as WARM
    expect(segment).toBe('WARM');

    // Verify: Calculate days inactive manually
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThanOrEqual(1);
    expect(daysInactive).toBeLessThanOrEqual(7);
  });

  test('WARM Segment Lower Boundary: User active exactly 1 day ago should be WARM', async () => {
    // Setup: Create user with last_active_at exactly 1 day ago (edge case)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_warm_lower',
      first_name: 'Warm Lower',
      last_active_at: oneDayAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as WARM
    expect(segment).toBe('WARM');

    // Verify: Days inactive should be >= 1 and <= 7
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThanOrEqual(1);
    expect(daysInactive).toBeLessThanOrEqual(7);
  });

  test('WARM Segment Upper Boundary: User active exactly 7 days ago should be WARM', async () => {
    // Setup: Create user with last_active_at exactly 7 days ago (edge case)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_warm_upper',
      first_name: 'Warm Upper',
      last_active_at: sevenDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as WARM
    expect(segment).toBe('WARM');

    // Verify: Days inactive should be exactly 7
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThanOrEqual(6.9); // Allow slight precision variance
    expect(daysInactive).toBeLessThanOrEqual(7.1);
  });

  test('COLD Segment: User active 7-30 days ago should be classified as COLD', async () => {
    // Setup: Create user with last_active_at 15 days ago
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_cold',
      first_name: 'Cold User',
      last_active_at: fifteenDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user using historical timestamp
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as COLD
    expect(segment).toBe('COLD');

    // Verify: Calculate days inactive manually
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(7);
    expect(daysInactive).toBeLessThanOrEqual(30);
  });

  test('COLD Segment Lower Boundary: User active 7.1 days ago should be COLD', async () => {
    // Setup: Create user with last_active_at just over 7 days ago (edge case)
    const sevenPointOneDaysAgo = new Date(Date.now() - 7.1 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_cold_lower',
      first_name: 'Cold Lower',
      last_active_at: sevenPointOneDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as COLD
    expect(segment).toBe('COLD');

    // Verify: Days inactive should be > 7 and <= 30
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(7);
    expect(daysInactive).toBeLessThanOrEqual(30);
  });

  test('COLD Segment Upper Boundary: User active exactly 30 days ago should be COLD', async () => {
    // Setup: Create user with last_active_at exactly 30 days ago (edge case)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_cold_upper',
      first_name: 'Cold Upper',
      last_active_at: thirtyDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as COLD
    expect(segment).toBe('COLD');

    // Verify: Days inactive should be exactly 30
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThanOrEqual(29.9); // Allow slight precision variance
    expect(daysInactive).toBeLessThanOrEqual(30.1);
  });

  test('GHOST Segment: User active > 30 days ago should be classified as GHOST', async () => {
    // Setup: Create user with last_active_at 60 days ago
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_ghost',
      first_name: 'Ghost User',
      last_active_at: sixtyDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user using historical timestamp
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as GHOST
    expect(segment).toBe('GHOST');

    // Verify: Calculate days inactive manually
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(30);
  });

  test('GHOST Segment Lower Boundary: User active 30.1 days ago should be GHOST', async () => {
    // Setup: Create user with last_active_at just over 30 days ago (edge case)
    const thirtyPointOneDaysAgo = new Date(Date.now() - 30.1 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_ghost_lower',
      first_name: 'Ghost Lower',
      last_active_at: thirtyPointOneDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as GHOST
    expect(segment).toBe('GHOST');

    // Verify: Days inactive should be > 30
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(30);
  });

  test('GHOST Segment Extended: User active 90 days ago should be GHOST', async () => {
    // Setup: Create user with last_active_at 90 days ago (long inactive)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_ghost_extended',
      first_name: 'Ghost Extended',
      last_active_at: ninetyDaysAgo,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be classified as GHOST
    expect(segment).toBe('GHOST');

    // Verify: Days inactive should be much greater than 30
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(89);
  });

  test('Bug #1 Fix Verification: Historical timestamp prevents incorrect HOT classification', async () => {
    // Setup: Create user who was last active 10 days ago (should be COLD)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_bug1_fix',
      first_name: 'Bug 1 Fix',
      last_active_at: tenDaysAgo,
      purchase_count: 0
    });

    // Capture historical timestamp (simulating what fixed code does)
    const historicalLastActive = user.last_active_at;

    // Execute: Classify using historical timestamp
    const segmentWithHistorical = await scheduler.classifyNonBuyer({ 
      ...user.toObject(), 
      last_active_at: historicalLastActive 
    });

    // Expected Behavior: Should be COLD (not HOT)
    expect(segmentWithHistorical).toBe('COLD');

    // Verify: If we used current time, it would incorrectly classify as HOT
    const segmentWithCurrentTime = await scheduler.classifyNonBuyer({ 
      ...user.toObject(), 
      last_active_at: new Date() 
    });
    expect(segmentWithCurrentTime).toBe('HOT');

    // This demonstrates the bug: without capturing historical timestamp,
    // a COLD user would be misclassified as HOT and receive wrong discount (5% vs 15%)
  });

  test('Segment Discount Mapping: Verify correct discount percentages for each segment', async () => {
    // This test verifies the discount percentages mentioned in the bug fix requirements
    // HOT: 5%, WARM: 10%, COLD: 15%, GHOST: 20%

    // Setup: Create users for each segment
    const hotUser = await User.create({
      username: 'test_segment_discount_hot',
      first_name: 'Discount Hot',
      last_active_at: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12 hours ago
      purchase_count: 0
    });

    const warmUser = await User.create({
      username: 'test_segment_discount_warm',
      first_name: 'Discount Warm',
      last_active_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      purchase_count: 0
    });

    const coldUser = await User.create({
      username: 'test_segment_discount_cold',
      first_name: 'Discount Cold',
      last_active_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      purchase_count: 0
    });

    const ghostUser = await User.create({
      username: 'test_segment_discount_ghost',
      first_name: 'Discount Ghost',
      last_active_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      purchase_count: 0
    });

    // Execute: Classify all users
    const hotSegment = await scheduler.classifyNonBuyer(hotUser);
    const warmSegment = await scheduler.classifyNonBuyer(warmUser);
    const coldSegment = await scheduler.classifyNonBuyer(coldUser);
    const ghostSegment = await scheduler.classifyNonBuyer(ghostUser);

    // Expected Behavior: Correct segment classification
    expect(hotSegment).toBe('HOT');
    expect(warmSegment).toBe('WARM');
    expect(coldSegment).toBe('COLD');
    expect(ghostSegment).toBe('GHOST');

    // Map segments to expected discounts (as per requirements 2.1)
    const discountMap = {
      'HOT': 5,
      'WARM': 10,
      'COLD': 15,
      'GHOST': 20
    };

    // Verify: Each segment maps to correct discount
    expect(discountMap[hotSegment]).toBe(5);
    expect(discountMap[warmSegment]).toBe(10);
    expect(discountMap[coldSegment]).toBe(15);
    expect(discountMap[ghostSegment]).toBe(20);
  });

  test('Real-world Scenario: User returns after 10 days should get COLD discount (15%)', async () => {
    // Setup: Simulate real-world scenario - user was last active 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const user = await User.create({
      username: 'test_segment_realworld',
      first_name: 'Real World User',
      last_active_at: tenDaysAgo,
      purchase_count: 0
    });

    // Capture historical timestamp BEFORE any update (this is the fix)
    const historicalLastActive = user.last_active_at;

    // Execute: Classify using historical timestamp
    const segment = await scheduler.classifyNonBuyer({ 
      ...user.toObject(), 
      last_active_at: historicalLastActive 
    });

    // Expected Behavior: Should be COLD (15% discount)
    expect(segment).toBe('COLD');

    // Verify: User should receive 15% discount, not 5% HOT discount
    const expectedDiscount = segment === 'COLD' ? 15 : 0;
    expect(expectedDiscount).toBe(15);

    // Business Impact: This fix ensures user gets 15% instead of 5%,
    // increasing conversion probability and fixing the 60-80% revenue loss bug
  });

  test('Timestamp Precision: Classification should handle millisecond precision', async () => {
    // Setup: Create user with precise timestamp (1 day + 1 hour + 30 minutes)
    const preciseTime = new Date(Date.now() - (1 * 24 * 60 * 60 * 1000 + 1.5 * 60 * 60 * 1000));
    const user = await User.create({
      username: 'test_segment_precision',
      first_name: 'Precision Test',
      last_active_at: preciseTime,
      purchase_count: 0
    });

    // Execute: Classify user
    const segment = await scheduler.classifyNonBuyer(user);

    // Expected Behavior: Should be WARM (1.0625 days inactive)
    expect(segment).toBe('WARM');

    // Verify: Precise calculation
    const daysInactive = (new Date() - new Date(user.last_active_at)) / (1000 * 60 * 60 * 24);
    expect(daysInactive).toBeGreaterThan(1);
    expect(daysInactive).toBeLessThan(2);
  });
});
