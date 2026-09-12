# Campaign Lock Helper Tests (Task 6.1.2)

## Overview
This document describes the unit tests for `acquireCampaignLock()` helper function that implements distributed locking to prevent race conditions in the marketing system.

## Test File
- **File**: `tests/unit/campaign-lock-helper.test.js`
- **Validates**: Bug #3 fix (Race condition prevention)
- **Requirements**: 2.3

## Test Coverage

### Core Functionality Tests

1. **Successful Lock Acquisition**
   - First campaign should successfully acquire lock
   - Verifies lock document creation with correct fields
   - Validates TTL is set to 1 hour

2. **Failed Lock Acquisition**
   - Second campaign should fail when lock already exists
   - Original lock remains unchanged

3. **Atomic Operation**
   - Concurrent lock attempts allow only one to succeed
   - Uses Promise.all to simulate race condition
   - Verifies exactly one lock document created

### TTL and Expiration Tests

4. **TTL Expiration Behavior**
   - Tests that expired locks still exist immediately after expiration
   - Documents MongoDB TTL cleanup delay (runs every 60 seconds)

### Multi-User and Multi-Date Tests

5. **Different Dates**
   - Same user can have locks on different dates
   - Lock key format includes date: `campaign_lock_{userId}_{YYYY-MM-DD}`

6. **Different Users**
   - Different users can acquire locks simultaneously
   - Locks are user-specific

### Validation Tests

7. **Lock Key Format**
   - Verifies correct format: `campaign_lock_{userId}_{YYYY-MM-DD}`
   - Uses regex validation

8. **Multiple Sequential Attempts**
   - Same campaign fails on retry
   - Different campaigns also fail if lock exists

### Stress Tests

9. **10 Concurrent Campaigns**
   - Simulates extreme race condition
   - All 10 campaigns attempt lock on same user
   - Exactly one succeeds

### Tracking Tests

10. **Campaign Type Tracking**
    - Lock stores which campaign acquired it
    - Useful for debugging and monitoring

11. **Lock Expiration Timestamp**
    - `expires_at` is exactly 1 hour after `acquired_at`
    - Validates TTL calculation

### Error Handling

12. **Malformed userId**
    - Tests with null, undefined, empty string, numbers, objects, arrays
    - Should handle gracefully without crashing

## Running Tests

```bash
# Run all unit tests
npm run test:unit

# Run only campaign lock tests
npm test tests/unit/campaign-lock-helper.test.js

# Run with coverage
npm test -- --coverage tests/unit/campaign-lock-helper.test.js
```

## Implementation Details

### Atomic Operation
The function uses MongoDB's `findOneAndUpdate` with `upsert: true` and `$setOnInsert` to achieve atomic lock acquisition:

```javascript
const result = await CampaignLock.findOneAndUpdate(
  { lock_key: lockKey },
  { 
    $setOnInsert: { 
      campaign_type: campaignType, 
      acquired_at: new Date(),
      expires_at: expiresAt
    }
  },
  { upsert: true, new: true, rawResult: true }
);

// Returns true if new document created (lock acquired)
return result.lastErrorObject.upserted !== undefined;
```

### Lock Key Format
- **Format**: `campaign_lock_{userId}_{YYYY-MM-DD}`
- **Purpose**: Ensures one lock per user per day
- **Example**: `campaign_lock_507f1f77bcf86cd799439011_2026-01-15`

### TTL Behavior
- Lock expires 1 hour after acquisition
- MongoDB TTL index runs every 60 seconds
- Expired documents may persist briefly before cleanup

## Integration with Marketing System

The lock is used in all campaign functions:
- NON_BUYER campaign
- CROSS_SELL campaign
- VIP_WINBACK campaign
- DRIP campaign
- CART_ABANDON campaign

Each campaign checks the lock before processing:
```javascript
const gotLock = await acquireCampaignLock(user._id, 'CAMPAIGN_NAME');
if (!gotLock) {
  logger.info(`[LOCK] User ${user._id} locked by another campaign`);
  continue; // Skip this user
}
```

## Expected Test Results

All 13 tests should pass:
- ✓ Successful Lock Acquisition
- ✓ Failed Lock Acquisition
- ✓ Atomic Operation
- ✓ TTL Expiration
- ✓ Different Dates
- ✓ Different Users
- ✓ Lock Key Format
- ✓ Multiple Sequential Attempts
- ✓ Stress Test (10 concurrent)
- ✓ Campaign Type Tracking
- ✓ Lock Expiration Timestamp
- ✓ Error Handling

## Dependencies

- MongoDB in-memory server (for testing)
- Jest testing framework
- Mongoose ODM
- CampaignLock model (from database.js)
- scheduler module (exports acquireCampaignLock)
