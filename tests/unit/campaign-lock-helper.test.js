/**
 * Unit Test: acquireCampaignLock() Helper Function (Task 6.1.2)
 * 
 * Tests the distributed locking helper implemented in Task 2.2.1
 * Validates Bug #3 fix: Race condition prevention through atomic lock operations
 * Requirements: 2.3
 */

const { CampaignLock } = require('../../database');
const scheduler = require('../../scheduler');

describe('acquireCampaignLock() - Task 6.1.2', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await CampaignLock.deleteMany({});
  });

  afterEach(async () => {
    // Clean up test data after each test
    await CampaignLock.deleteMany({});
  });

  test('Successful Lock Acquisition: First campaign should acquire lock', async () => {
    // Setup: No existing locks
    const userId = '507f1f77bcf86cd799439011';
    const campaignType = 'NON_BUYER';

    // Execute: Attempt to acquire lock
    const gotLock = await scheduler.acquireCampaignLock(userId, campaignType);

    // Expected Behavior: Should successfully acquire lock (return true)
    expect(gotLock).toBe(true);

    // Verify: Lock document should exist in database
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    const lockDoc = await CampaignLock.findOne({ lock_key: lockKey });
    expect(lockDoc).not.toBeNull();
    expect(lockDoc.campaign_type).toBe(campaignType);
    expect(lockDoc.acquired_at).toBeInstanceOf(Date);
    expect(lockDoc.expires_at).toBeInstanceOf(Date);
    
    // Verify: TTL expiration is set to 1 hour from now (approximately)
    const ttlDiff = lockDoc.expires_at.getTime() - lockDoc.acquired_at.getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(ttlDiff).toBeGreaterThanOrEqual(oneHourMs - 1000); // Allow 1 second tolerance
    expect(ttlDiff).toBeLessThanOrEqual(oneHourMs + 1000);
  });

  test('Failed Lock Acquisition: Second campaign should fail to acquire lock', async () => {
    // Setup: First campaign already has lock
    const userId = '507f1f77bcf86cd799439012';
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    await CampaignLock.create({
      lock_key: lockKey,
      campaign_type: 'NON_BUYER',
      acquired_at: new Date(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000)
    });

    // Execute: Second campaign attempts to acquire same lock
    const gotLock = await scheduler.acquireCampaignLock(userId, 'CROSS_SELL');

    // Expected Behavior: Should fail to acquire lock (return false)
    expect(gotLock).toBe(false);

    // Verify: Original lock should remain unchanged
    const lockDoc = await CampaignLock.findOne({ lock_key: lockKey });
    expect(lockDoc).not.toBeNull();
    expect(lockDoc.campaign_type).toBe('NON_BUYER'); // Should still be original campaign
  });

  test('Atomic Operation: Concurrent lock attempts should only allow one', async () => {
    // Setup: Two campaigns attempt to acquire lock simultaneously
    const userId = '507f1f77bcf86cd799439013';
    
    // Execute: Simulate race condition with Promise.all
    const [gotLock1, gotLock2] = await Promise.all([
      scheduler.acquireCampaignLock(userId, 'NON_BUYER'),
      scheduler.acquireCampaignLock(userId, 'CROSS_SELL')
    ]);

    // Expected Behavior: Exactly one should succeed (atomic operation)
    const successCount = (gotLock1 ? 1 : 0) + (gotLock2 ? 1 : 0);
    expect(successCount).toBe(1);

    // Verify: Only one lock document should exist
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    const lockCount = await CampaignLock.countDocuments({ lock_key: lockKey });
    expect(lockCount).toBe(1);
  });

  test('TTL Expiration: Lock with past expires_at should still exist (TTL cleanup is async)', async () => {
    // Setup: Create lock with already expired timestamp
    const userId = '507f1f77bcf86cd799439014';
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    const pastExpiration = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    await CampaignLock.create({
      lock_key: lockKey,
      campaign_type: 'VIP_WINBACK',
      acquired_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      expires_at: pastExpiration
    });

    // Execute: Attempt to acquire lock immediately after creation
    const gotLock = await scheduler.acquireCampaignLock(userId, 'DRIP');

    // Expected Behavior: Lock attempt should fail because TTL cleanup is async
    // MongoDB TTL index runs every 60 seconds, so expired documents persist briefly
    expect(gotLock).toBe(false);

    // Verify: Expired lock still exists (TTL hasn't cleaned it yet)
    const lockDoc = await CampaignLock.findOne({ lock_key: lockKey });
    expect(lockDoc).not.toBeNull();
  });

  test('Different Dates: Same user can have locks on different dates', async () => {
    // Setup: Create lock for yesterday
    const userId = '507f1f77bcf86cd799439015';
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const lockKeyYesterday = `campaign_lock_${userId}_${yesterdayStr}`;
    
    await CampaignLock.create({
      lock_key: lockKeyYesterday,
      campaign_type: 'NON_BUYER',
      acquired_at: yesterday,
      expires_at: new Date(yesterday.getTime() + 60 * 60 * 1000)
    });

    // Execute: Attempt to acquire lock for today
    const gotLock = await scheduler.acquireCampaignLock(userId, 'CROSS_SELL');

    // Expected Behavior: Should succeed (different date = different lock key)
    expect(gotLock).toBe(true);

    // Verify: Both lock documents should exist
    const lockCount = await CampaignLock.countDocuments({ 
      lock_key: { $regex: `^campaign_lock_${userId}_` } 
    });
    expect(lockCount).toBe(2);
  });

  test('Different Users: Different users can acquire locks simultaneously', async () => {
    // Setup: No existing locks
    const userId1 = '507f1f77bcf86cd799439016';
    const userId2 = '507f1f77bcf86cd799439017';

    // Execute: Both users acquire locks
    const [gotLock1, gotLock2] = await Promise.all([
      scheduler.acquireCampaignLock(userId1, 'NON_BUYER'),
      scheduler.acquireCampaignLock(userId2, 'NON_BUYER')
    ]);

    // Expected Behavior: Both should succeed (different users)
    expect(gotLock1).toBe(true);
    expect(gotLock2).toBe(true);

    // Verify: Both lock documents should exist
    const today = new Date().toISOString().split('T')[0];
    const lockCount = await CampaignLock.countDocuments({ 
      lock_key: { $regex: `^campaign_lock_.*_${today}$` } 
    });
    expect(lockCount).toBeGreaterThanOrEqual(2);
  });

  test('Lock Key Format: Verify lock key follows correct format', async () => {
    // Setup: Test with specific user ID
    const userId = '507f1f77bcf86cd799439018';
    const campaignType = 'VIP_WINBACK';

    // Execute: Acquire lock
    const gotLock = await scheduler.acquireCampaignLock(userId, campaignType);

    // Expected Behavior: Lock should be acquired
    expect(gotLock).toBe(true);

    // Verify: Lock key format is correct: campaign_lock_{userId}_{YYYY-MM-DD}
    const today = new Date().toISOString().split('T')[0];
    const expectedLockKey = `campaign_lock_${userId}_${today}`;
    
    const lockDoc = await CampaignLock.findOne({ lock_key: expectedLockKey });
    expect(lockDoc).not.toBeNull();
    expect(lockDoc.lock_key).toMatch(/^campaign_lock_[a-f0-9]+_\d{4}-\d{2}-\d{2}$/);
  });

  test('Multiple Sequential Attempts: Same campaign should fail on retry', async () => {
    // Setup: No existing locks
    const userId = '507f1f77bcf86cd799439019';
    const campaignType = 'DRIP';

    // Execute: First attempt should succeed
    const firstAttempt = await scheduler.acquireCampaignLock(userId, campaignType);
    expect(firstAttempt).toBe(true);

    // Execute: Second attempt by same campaign should fail
    const secondAttempt = await scheduler.acquireCampaignLock(userId, campaignType);
    expect(secondAttempt).toBe(false);

    // Execute: Third attempt by different campaign should also fail
    const thirdAttempt = await scheduler.acquireCampaignLock(userId, 'CART_ABANDON');
    expect(thirdAttempt).toBe(false);

    // Verify: Only one lock document exists
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    const lockCount = await CampaignLock.countDocuments({ lock_key: lockKey });
    expect(lockCount).toBe(1);
  });

  test('Stress Test: 10 concurrent campaigns on same user, only 1 succeeds', async () => {
    // Setup: Simulate extreme race condition
    const userId = '507f1f77bcf86cd799439020';
    const campaigns = [
      'NON_BUYER', 'CROSS_SELL', 'VIP_WINBACK', 'DRIP', 'CART_ABANDON',
      'REALTIME', 'NON_BUYER_2', 'CROSS_SELL_2', 'VIP_WINBACK_2', 'DRIP_2'
    ];

    // Execute: All 10 campaigns attempt lock simultaneously
    const results = await Promise.all(
      campaigns.map(campaign => scheduler.acquireCampaignLock(userId, campaign))
    );

    // Expected Behavior: Exactly one should succeed
    const successCount = results.filter(r => r === true).length;
    expect(successCount).toBe(1);

    // Verify: Only one lock document exists
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    const lockCount = await CampaignLock.countDocuments({ lock_key: lockKey });
    expect(lockCount).toBe(1);
  });

  test('Campaign Type Tracking: Lock should store which campaign acquired it', async () => {
    // Setup: No existing locks
    const userId = '507f1f77bcf86cd799439021';
    const campaignType = 'CROSS_SELL';

    // Execute: Acquire lock
    const gotLock = await scheduler.acquireCampaignLock(userId, campaignType);

    // Expected Behavior: Lock should be acquired
    expect(gotLock).toBe(true);

    // Verify: Campaign type is correctly stored
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    const lockDoc = await CampaignLock.findOne({ lock_key: lockKey });
    expect(lockDoc.campaign_type).toBe(campaignType);
  });

  test('Lock Expiration Timestamp: expires_at should be approximately 1 hour from acquired_at', async () => {
    // Setup: No existing locks
    const userId = '507f1f77bcf86cd799439022';
    const campaignType = 'NON_BUYER';

    // Execute: Acquire lock
    const beforeAcquire = Date.now();
    const gotLock = await scheduler.acquireCampaignLock(userId, campaignType);
    const afterAcquire = Date.now();

    // Expected Behavior: Lock should be acquired
    expect(gotLock).toBe(true);

    // Verify: expires_at is 1 hour after acquired_at
    const today = new Date().toISOString().split('T')[0];
    const lockKey = `campaign_lock_${userId}_${today}`;
    
    const lockDoc = await CampaignLock.findOne({ lock_key: lockKey });
    expect(lockDoc).not.toBeNull();

    // Check that acquired_at is within test execution window
    const acquiredTime = lockDoc.acquired_at.getTime();
    expect(acquiredTime).toBeGreaterThanOrEqual(beforeAcquire - 1000);
    expect(acquiredTime).toBeLessThanOrEqual(afterAcquire + 1000);

    // Check that expires_at is exactly 1 hour after acquired_at
    const ttlDuration = lockDoc.expires_at.getTime() - lockDoc.acquired_at.getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(ttlDuration).toBeGreaterThanOrEqual(oneHourMs - 1000);
    expect(ttlDuration).toBeLessThanOrEqual(oneHourMs + 1000);
  });

  test('Error Handling: Malformed userId should not crash', async () => {
    // Setup: Use various invalid user IDs
    const invalidUserIds = [null, undefined, '', ' ', 123, {}, []];

    // Execute & Verify: Each should handle gracefully
    for (const invalidId of invalidUserIds) {
      let gotLock;
      try {
        gotLock = await scheduler.acquireCampaignLock(invalidId, 'TEST');
      } catch (err) {
        // If it throws, that's also acceptable behavior
        expect(err).toBeDefined();
        continue;
      }
      
      // If it doesn't throw, it should return false (failed to acquire)
      expect(gotLock).toBe(false);
    }
  });
});
