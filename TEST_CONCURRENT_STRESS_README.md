# Concurrent Campaign Stress Test - Task 6.2.2

## Overview

This test validates that the marketing system can handle high concurrency scenarios with proper distributed locking and rate limiting.

## Test Specifications

- **Test File:** `test-concurrent-campaign-stress.js`
- **Task ID:** 6.2.2
- **Test Type:** Integration / Stress Test

## What It Tests

1. **Distributed Locks Prevent Duplicates**
   - 4 campaigns start simultaneously
   - All campaigns attempt to process the same 1000 users
   - Locks ensure each user is processed by only one campaign at a time
   - Verifies no duplicate messages are sent

2. **Rate Limiting Under Load**
   - Users start with 0-3 messages already sent
   - System enforces max 3 messages per user per day
   - Validates rate limit counter is properly incremented
   - Confirms users at limit are skipped by all campaigns

3. **High Volume Handling**
   - 1000 users in database with varied states
   - 4 concurrent campaigns (NON_BUYER, CROSS_SELL, VIP_WINBACK, DRIP)
   - Total of 4000 campaign execution attempts
   - System processes concurrently without race conditions

4. **Database Integrity**
   - Validates database state matches tracking
   - Verifies lock collection properly manages concurrency
   - Ensures no data corruption under high load

## Prerequisites

### Required
- MongoDB server running and accessible
- Node.js environment with dependencies installed
- `.env` file with configuration (BOT_TOKEN not required for this test)

### MongoDB Options
1. **Local MongoDB**: Install and run `mongod` locally
2. **Docker MongoDB**: `docker run -d -p 27017:27017 mongo`
3. **Cloud MongoDB**: Set `MONGODB_URI` in `.env` to your connection string

## Running the Test

### Standard Execution
```bash
node test-concurrent-campaign-stress.js
```

### With Custom MongoDB URI
```bash
MONGODB_URI="mongodb://localhost:27017/my_test_db" node test-concurrent-campaign-stress.js
```

### Expected Output
The test will:
1. Connect to MongoDB
2. Create 1000 test users (takes ~5-10 seconds)
3. Launch 4 campaigns simultaneously
4. Process all users concurrently
5. Validate results against 5 test criteria
6. Clean up all test data
7. Exit with code 0 (success) or 1 (failure)

## Test Duration

- **User Creation:** ~5-10 seconds (1000 users in batches)
- **Campaign Execution:** ~20-40 seconds (depending on system performance)
- **Validation:** ~5 seconds
- **Total:** ~30-60 seconds

## Output Files

The test creates a log file: `test-stress-output.log` with complete execution details.

## Success Criteria

All of the following must pass:

1. ✓ **Lock Effectiveness**: Zero duplicate sends detected
2. ✓ **Rate Limit Enforcement**: No user exceeds 3 messages/day
3. ✓ **Single Campaign Send**: Each user processed by max 1 campaign per cycle
4. ✓ **Campaign Execution**: All 4 campaigns complete successfully
5. ✓ **Database Integrity**: Database state consistent with tracking

## Interpreting Results

### Successful Test Output
```
╔════════════════════════════════════════════════════════════╗
║                       TEST SUMMARY                         ║
╚════════════════════════════════════════════════════════════╝

  Tests Passed:             5
  Tests Failed:             0
  Duplicate Sends:          0
  Rate Limit Violations:    0

  ✓✓✓ ALL STRESS TESTS PASSED ✓✓✓
  System handles high concurrency correctly!
```

### Failed Test Output
If any test fails, you'll see:
```
✗✗✗ SOME TESTS FAILED ✗✗✗
Review failures above for details
```

Look for lines marked with `✗ FAIL:` to identify specific issues.

## Troubleshooting

### "Cannot connect to MongoDB"
**Problem:** MongoDB is not running or not accessible.

**Solutions:**
1. Start local MongoDB: `mongod --dbpath /path/to/data`
2. Use Docker: `docker run -d -p 27017:27017 mongo`
3. Check MongoDB is running: `mongo --eval "db.runCommand({ ping: 1 })"`
4. Verify connection string in `MONGODB_URI` environment variable

### "Test times out"
**Problem:** System is too slow or MongoDB is overloaded.

**Solutions:**
1. Reduce TEST_CONFIG.TOTAL_USERS from 1000 to 100 (for quick validation)
2. Ensure MongoDB has sufficient resources
3. Close other applications to free up system resources

### "Duplicate sends detected"
**Problem:** Distributed locks are not working correctly.

**Implications:**
- Bug #3 (Race Condition) fix is not working
- Lock acquisition logic needs review
- Database may not support findOneAndUpdate atomicity

**Next Steps:**
1. Review `acquireCampaignLock()` function implementation
2. Verify CampaignLock schema has unique index on `lock_key`
3. Check MongoDB supports atomic operations

### "Rate limit violations"
**Problem:** Rate limiting is not enforcing the 3 messages/day limit.

**Implications:**
- Bug #2 (Global Rate Limit) fix is not working
- Counter increment logic may have race conditions
- Database updates may not be atomic

**Next Steps:**
1. Review `checkAndIncrementRateLimit()` function implementation
2. Verify User schema has `marketing_messages_today` field
3. Check $inc operator is being used for atomic increments

## Test Data

### User Distribution
The test creates 1000 users with varied states:
- ~250 users with 0 messages sent today (can receive 3)
- ~250 users with 1 message sent (can receive 2)
- ~250 users with 2 messages sent (can receive 1)
- ~250 users with 3 messages sent (should be skipped)

### Cleanup
All test data is automatically cleaned up after the test:
- All users with ID matching pattern `user_*`
- All campaign locks created during the test
- Database is left in clean state

## Performance Benchmarks

Expected performance on modern hardware:

| Metric | Value |
|--------|-------|
| Total Campaign Attempts | 4,000 |
| Messages Sent | ~750-1500 |
| Lock Acquisitions | 1,000 |
| Lock Blocks | ~3,000 |
| Execution Time | 30-60 seconds |
| Throughput | 60-130 attempts/sec |

## Integration with CI/CD

To run this test in automated pipelines:

```bash
#!/bin/bash
# Start MongoDB for testing
docker run -d --name test-mongo -p 27017:27017 mongo

# Wait for MongoDB to be ready
sleep 5

# Run the test
node test-concurrent-campaign-stress.js
TEST_EXIT_CODE=$?

# Cleanup
docker stop test-mongo
docker rm test-mongo

exit $TEST_EXIT_CODE
```

## Related Tests

- **test-full-day-simulation.js**: Task 6.2.1 - Full 24-hour campaign simulation
- **test-checkout-state-standalone.js**: Tests checkout state detection
- **test-db-connection.js**: Basic MongoDB connection test

## Design References

This test validates the fixes for:
- **Bug #3**: Race Condition in Campaign Execution (Design Section 1.3)
- **Bug #2**: Missing Global Rate Limit (Design Section 1.2)
- **Bug #9**: Campaign Timing Collision (Design Section 2.5)

See `design.md` for complete bug details and fix implementations.

## Support

If you encounter issues with this test:
1. Check MongoDB is running and accessible
2. Review test-stress-output.log for detailed execution trace
3. Verify all dependencies are installed: `npm install`
4. Ensure sufficient system resources (RAM: 2GB+, CPU: 2+ cores)

For questions about the marketing system or bug fixes, refer to:
- `bugfix.md`: Bug requirements and expected behavior
- `design.md`: Technical implementation details
- `tasks.md`: Complete task list and dependencies
