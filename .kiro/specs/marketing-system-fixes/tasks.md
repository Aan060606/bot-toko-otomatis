# Implementation Tasks - Marketing System Fixes

## Overview

This task list implements 16 critical bug fixes for the marketing automation system, grouped by logical implementation order. Each task specifies exact file locations and line numbers from the design document.

**Execution Order:**
1. Database schema changes (foundation)
2. Helper functions (reusable utilities)
3. Critical bug fixes (P1)
4. High priority fixes (P2)
5. Medium priority fixes (P3)

---

## Group 1: Database Schema Enhancements

### 1.1 Add Rate Limiting Fields to User Schema

- [x] 1.1.1 Add marketing_messages_today and marketing_messages_reset_at fields to User schema
  - **File:** `database.js`
  - **Location:** UserSchema definition (line ~30-45)
  - Add field `marketing_messages_today: { type: Number, default: 0 }`
  - Add field `marketing_messages_reset_at` with default next midnight Asia/Jakarta
  - **Purpose:** Global rate limit tracking (fixes Bug #2)
  - _Requirements: 2.2_

### 1.2 Create CampaignLocks Collection

- [x] 1.2.1 Create CampaignLockSchema with TTL index
  - **File:** `database.js`
  - **Location:** After BroadcastLogSchema definition (line ~230)
  - Create schema with fields: lock_key (unique), campaign_type, acquired_at, expires_at
  - Add TTL index on expires_at with expireAfterSeconds: 0
  - Export CampaignLock model in module.exports
  - **Purpose:** Distributed locking for race condition prevention (fixes Bug #3)
  - _Requirements: 2.3_

### 1.3 Add TTL Index for Discount Cleanup

- [x] 1.3.1 Add TTL index to DiscountSchema for automatic cleanup
  - **File:** `database.js`
  - **Location:** After DiscountSchema definition (line ~145)
  - Add index on valid_until with expireAfterSeconds: 7 * 24 * 60 * 60 (7 days grace)
  - Use partialFilterExpression: { active: false }
  - **Purpose:** Automatic cleanup of expired discounts (fixes Bug #5)
  - _Requirements: 2.5_

### 1.4 Optimize Drip TTL for Converted Records

- [x] 1.4.1 Add separate TTL index for converted DripLog records
  - **File:** `database.js`
  - **Location:** After DripLogSchema existing TTL (line ~175)
  - Add second TTL index on created_at with expireAfterSeconds: 30 * 24 * 60 * 60 (30 days)
  - Use partialFilterExpression: { converted: true }
  - Keep existing 180-day TTL for unconverted records
  - **Purpose:** Faster cleanup of converted drip logs (fixes Bug #14)
  - _Requirements: 2.14_

---

## Group 2: Helper Functions

### 2.1 Global Rate Limit Helper

- [x] 2.1.1 Implement checkAndIncrementRateLimit() function
  - **File:** `scheduler.js`
  - **Location:** Add after isUserQuietHour() function (line ~50)
  - Fetch user and check admin bypass (process.env.ADMIN_CHAT_ID)
  - Reset counter if past marketing_messages_reset_at midnight
  - Check if marketing_messages_today >= 3, return false if exceeded
  - Increment counter using $inc operator
  - Return true if allowed
  - **Purpose:** Global rate limit enforcement (fixes Bug #2)
  - _Requirements: 2.2_

### 2.2 Distributed Lock Helper

- [x] 2.2.1 Implement acquireCampaignLock() function
  - **File:** `scheduler.js`
  - **Location:** Add after checkAndIncrementRateLimit()
  - Generate lock key: `campaign_lock_{userId}_{YYYY-MM-DD}`
  - Use CampaignLock.findOneAndUpdate with upsert: true (atomic operation)
  - Set $setOnInsert with campaign_type, acquired_at, expires_at (1 hour TTL)
  - Return true if upserted (got lock), false if already exists
  - Catch duplicate key error as failed lock acquisition
  - **Purpose:** Distributed locking (fixes Bug #3)
  - _Requirements: 2.3_

### 2.3 Checkout State Check Helper

- [x] 2.3.1 Implement isUserInCheckout() function
  - **File:** `scheduler.js`
  - **Location:** Add after acquireCampaignLock()
  - Query Order.findOne({ user_id: userId, status: 'PENDING' })
  - Return true if pending order exists, false otherwise
  - **Purpose:** Prevent payment flow interruption (fixes Bug #11)
  - _Requirements: 2.11_

---

## Group 3: Critical Priority Fixes (P1)

### 3.1 Fix Realtime Segment Classification Timing

- [x] 3.1.1 Capture historical last_active_at before classification
  - **File:** `scheduler.js`
  - **Location:** triggerRealtimeMarketing function (line ~2363-2410)
  - After user fetch, capture `const historicalLastActive = user.last_active_at`
  - Pass historicalLastActive to classifyNonBuyer: `classifyNonBuyer({ ...user, last_active_at: historicalLastActive })`
  - **Purpose:** Correct segment classification (fixes Bug #1, #16)
  - _Bug_Condition: isBugCondition_1 where realtimeTrigger === true AND last_active_at updated before classification_
  - _Expected_Behavior: Use historical timestamp for accurate segment assignment (HOT 5%, WARM 10%, COLD 15%, GHOST 20%)_
  - _Requirements: 2.1, 2.16_

### 3.2 Add Global Rate Limit Check to All Campaigns

- [x] 3.2.1 Add rate limit check to NON_BUYER campaign
  - **File:** `scheduler.js`
  - **Location:** runNonBuyerCampaign before sendSafe() call
  - Call `const canSend = await checkAndIncrementRateLimit(user._id)`
  - Skip user if canSend === false, log skip reason
  - _Requirements: 2.2_

- [x] 3.2.2 Add rate limit check to CROSS_SELL campaign
  - **File:** `scheduler.js`
  - **Location:** runCrossSellCampaign before sendSafe() call
  - Call checkAndIncrementRateLimit(), skip if false
  - _Requirements: 2.2_

- [x] 3.2.3 Add rate limit check to VIP_WINBACK campaign
  - **File:** `scheduler.js`
  - **Location:** runVIPWinBackCampaign before sendSafe() call
  - Call checkAndIncrementRateLimit(), skip if false
  - _Requirements: 2.2_

- [x] 3.2.4 Add rate limit check to DRIP campaign
  - **File:** `scheduler.js`
  - **Location:** runDripFollowUp before sendSafe() call
  - Call checkAndIncrementRateLimit(), skip if false
  - _Requirements: 2.2_

- [x] 3.2.5 Add rate limit check to CART_ABANDON campaign
  - **File:** `scheduler.js`
  - **Location:** runCartAbandonCampaign before sendSafe() call
  - Call checkAndIncrementRateLimit(), skip if false
  - _Requirements: 2.2_

- [x] 3.2.6 Add rate limit check to REALTIME trigger
  - **File:** `scheduler.js`
  - **Location:** triggerRealtimeMarketing before sendSafe() call
  - Call checkAndIncrementRateLimit(), skip if false
  - _Requirements: 2.2_

### 3.3 Add Distributed Lock to All Campaigns

- [x] 3.3.1 Add lock acquisition to NON_BUYER campaign
  - **File:** `scheduler.js`
  - **Location:** runNonBuyerCampaign user loop start
  - Call `const gotLock = await acquireCampaignLock(user._id, 'NON_BUYER')`
  - Skip user if gotLock === false, log skip reason
  - _Requirements: 2.3_

- [x] 3.3.2 Add lock acquisition to CROSS_SELL campaign
  - **File:** `scheduler.js`
  - **Location:** runCrossSellCampaign user loop start
  - Call acquireCampaignLock(user._id, 'CROSS_SELL'), skip if false
  - _Requirements: 2.3_

- [x] 3.3.3 Add lock acquisition to VIP_WINBACK campaign
  - **File:** `scheduler.js`
  - **Location:** runVIPWinBackCampaign user loop start
  - Call acquireCampaignLock(user._id, 'VIP_WINBACK'), skip if false
  - _Requirements: 2.3_

- [x] 3.3.4 Add lock acquisition to DRIP campaign
  - **File:** `scheduler.js`
  - **Location:** runDripFollowUp user loop start
  - Call acquireCampaignLock(user._id, 'DRIP'), skip if false
  - _Requirements: 2.3_

- [x] 3.3.5 Add lock acquisition to CART_ABANDON campaign
  - **File:** `scheduler.js`
  - **Location:** runCartAbandonCampaign user loop start
  - Call acquireCampaignLock(user._id, 'CART_ABANDON'), skip if false
  - _Requirements: 2.3_

### 3.4 Fix VIP_WINBACK Cooldown Bypass

- [x] 3.4.1 Remove cooldown bypass for VIP_WINBACK campaign
  - **File:** `scheduler.js`
  - **Location:** isInCooldown function (line ~350-360)
  - Add condition: `if (currentCampaign === 'VIP_WINBACK') { /* Do not bypass - fall through */ }`
  - For other campaigns, increase MIN_BYPASS_AGE_MS from 5 minutes to 48 hours (48 * 60 * 60 * 1000)
  - **Purpose:** Enforce 48-hour cooldown for VIP users (fixes Bug #4)
  - _Bug_Condition: campaign === 'VIP_WINBACK' AND (now - last_broadcast_at) >= 5 minutes_
  - _Expected_Behavior: Enforce full 48-hour cooldown, no bypass_
  - _Requirements: 2.4_

---

## Group 4: High Priority Fixes (P2)

### 4.1 Add Discount Cleanup Cron Job

- [x] 4.1.1 Add daily cleanup cron at 3 AM
  - **File:** `scheduler.js`
  - **Location:** startCron function (line ~2162)
  - Add cron job: `cron.schedule('0 3 * * *', async () => { ... }, { timezone: 'Asia/Jakarta' })`
  - Delete expired discounts: `await Discount.deleteMany({ valid_until: { $lt: new Date() }, active: false })`
  - Log deleted count
  - **Purpose:** Automatic cleanup of expired discounts (fixes Bug #5)
  - _Bug_Condition: discount.valid_until < currentTime AND active === false_
  - _Expected_Behavior: Daily cleanup at 03:00 AM deletes expired discounts_
  - _Requirements: 2.5_

### 4.2 Fix WARM Segment Progressive Discount

- [x] 4.2.1 Increase WARM stage 2 discount from 10% to 15%
  - **File:** `scheduler.js`
  - **Location:** runDripFollowUp stage 2 logic (line ~1100-1150)
  - Find: `if (segment === 'WARM') discountVal = 10;`
  - Replace with: `if (segment === 'WARM') discountVal = 15;`
  - **Purpose:** Progressive urgency escalation (fixes Bug #6)
  - _Bug_Condition: segment === 'WARM' AND stage === 2_
  - _Expected_Behavior: discountVal = 15 for progressive urgency_
  - _Requirements: 2.6_

### 4.3 Add Quiet Hour Check to CART_ABANDON

- [x] 4.3.1 Add isUserQuietHour() check before sending
  - **File:** `scheduler.js`
  - **Location:** runCartAbandonCampaign function (line ~1609)
  - Add before sendSafe(): `if (isUserQuietHour(user)) { logger.info(...); continue; }`
  - **Purpose:** Prevent nighttime spam (fixes Bug #7)
  - _Bug_Condition: campaign === 'CART_ABANDON' AND hour IN [0-5]_
  - _Expected_Behavior: Skip sending during 00:00-06:00, queue for 06:01 AM_
  - _Requirements: 2.7_

### 4.4 Add Stock Validation to CROSS_SELL

- [x] 4.4.1 Filter out sold-out products from recommendations
  - **File:** `scheduler.js`
  - **Location:** runCrossSellCampaign product recommendation (line ~900-950)
  - Add filter loop before keyboard building:
    ```javascript
    const inStockProducts = [];
    for (const product of recommendedProducts) {
      const stockCount = await Stock.countDocuments({
        product_id: product._id,
        status: 'AVAILABLE'
      });
      if (stockCount > 0) inStockProducts.push(product);
    }
    ```
  - Use inStockProducts instead of recommendedProducts
  - Skip user if inStockProducts.length === 0
  - **Purpose:** Only recommend available products (fixes Bug #8)
  - _Bug_Condition: product recommended AND Stock.count === 0_
  - _Expected_Behavior: Filter out before recommendation_
  - _Preservation: Cross-sell similarity algorithm unchanged (Req 3.13)_
  - _Requirements: 2.8_

### 4.5 Stagger Campaign Cron Schedules

- [x] 4.5.1 Change NON_BUYER schedule to :00 minutes
  - **File:** `scheduler.js`
  - **Location:** startCron function (line ~2200-2300)
  - Keep as: `cron.schedule('0 10-20 * * *', () => runNonBuyerCampaign(bot), ...)`
  - _Requirements: 2.9_

- [x] 4.5.2 Change CROSS_SELL schedule to :15 minutes
  - **File:** `scheduler.js`
  - **Location:** startCron function
  - Change from: `'0 10-20 * * *'`
  - Change to: `'15 10-20 * * *'`
  - _Requirements: 2.9_

- [x] 4.5.3 Change VIP_WINBACK schedule to :30 minutes
  - **File:** `scheduler.js`
  - **Location:** startCron function
  - Change from: `'0 10-20 * * *'`
  - Change to: `'30 10-20 * * *'`
  - _Requirements: 2.9_

- [x] 4.5.4 Change DRIP schedule to :45 minutes
  - **File:** `scheduler.js`
  - **Location:** startCron function
  - Change from: `'0 10-20 * * *'`
  - Change to: `'45 10-20 * * *'`
  - **Purpose:** Reduce race conditions through time distribution (fixes Bug #9)
  - _Bug_Condition: All campaigns at same hour :00 minutes_
  - _Expected_Behavior: 15-minute gaps between campaigns_
  - _Requirements: 2.9_

---

## Group 5: Medium Priority Fixes (P3)

### 5.1 Add Realtime Trigger Throttle

- [x] 5.1.1 Add 60-minute throttle check
  - **File:** `scheduler.js`
  - **Location:** triggerRealtimeMarketing function start (line ~2370)
  - Add after user fetch:
    ```javascript
    if (user.last_broadcast_at) {
      const minutesSinceLastBroadcast = (new Date() - new Date(user.last_broadcast_at)) / (1000 * 60);
      if (minutesSinceLastBroadcast < 60) {
        return; // Skip - too soon
      }
    }
    ```
  - **Purpose:** Prevent spam during active conversations (fixes Bug #10)
  - _Bug_Condition: realtime trigger on EVERY message_
  - _Expected_Behavior: Max 1 trigger per 60 minutes_
  - _Requirements: 2.10_

### 5.2 Add Checkout State Check to All Campaigns

- [x] 5.2.1 Add checkout check to NON_BUYER campaign
  - **File:** `scheduler.js`
  - **Location:** runNonBuyerCampaign after user fetch
  - Add: `if (await isUserInCheckout(user._id)) { logger.info(...); continue; }`
  - _Requirements: 2.11_

- [x] 5.2.2 Add checkout check to CROSS_SELL campaign
  - **File:** `scheduler.js`
  - **Location:** runCrossSellCampaign after user fetch
  - Add isUserInCheckout() check
  - _Requirements: 2.11_

- [x] 5.2.3 Add checkout check to VIP_WINBACK campaign
  - **File:** `scheduler.js`
  - **Location:** runVIPWinBackCampaign after user fetch
  - Add isUserInCheckout() check
  - _Requirements: 2.11_

- [x] 5.2.4 Add checkout check to DRIP campaign
  - **File:** `scheduler.js`
  - **Location:** runDripFollowUp after user fetch
  - Add isUserInCheckout() check
  - _Requirements: 2.11_

- [x] 5.2.5 Add checkout check to CART_ABANDON campaign
  - **File:** `scheduler.js`
  - **Location:** runCartAbandonCampaign after user fetch
  - Add isUserInCheckout() check
  - _Requirements: 2.11_

- [x] 5.2.6 Add checkout check to REALTIME trigger
  - **File:** `scheduler.js`
  - **Location:** triggerRealtimeMarketing after user fetch
  - Add isUserInCheckout() check
  - **Purpose:** Prevent payment flow interruption (fixes Bug #11)
  - _Bug_Condition: User has PENDING order_
  - _Expected_Behavior: Skip marketing during checkout_
  - _Requirements: 2.11_

### 5.3 Reduce Discount Validity to 24 Hours

- [x] 5.3.1 Find all discount creation locations in NON_BUYER
  - **File:** `scheduler.js`
  - **Location:** runNonBuyerCampaign discount creation
  - Change from: `valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000)`
  - Change to: `valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000)`
  - _Requirements: 2.12_

- [x] 5.3.2 Find all discount creation locations in CROSS_SELL
  - **File:** `scheduler.js`
  - **Location:** runCrossSellCampaign discount creation
  - Change 48h to 24h
  - _Requirements: 2.12_

- [x] 5.3.3 Find all discount creation locations in VIP_WINBACK
  - **File:** `scheduler.js`
  - **Location:** runVIPWinBackCampaign discount creation
  - Change 48h to 24h
  - _Requirements: 2.12_

- [x] 5.3.4 Find all discount creation locations in DRIP
  - **File:** `scheduler.js`
  - **Location:** runDripFollowUp discount creation
  - Change 48h to 24h
  - _Requirements: 2.12_

- [x] 5.3.5 Find all discount creation locations in CART_ABANDON
  - **File:** `scheduler.js`
  - **Location:** runCartAbandonCampaign discount creation
  - Change 48h to 24h
  - _Requirements: 2.12_

- [x] 5.3.6 Find all discount creation locations in REALTIME
  - **File:** `scheduler.js`
  - **Location:** triggerRealtimeMarketing discount creation
  - Change 48h to 24h
  - **Purpose:** Increase urgency psychology (fixes Bug #12)
  - _Bug_Condition: Discount validity === 48 hours_
  - _Expected_Behavior: Validity === 24 hours_
  - _Requirements: 2.12_

### 5.4 Add Product Rotation for All Segments

- [x] 5.4.1 Apply rotation algorithm to WARM/COLD/GHOST segments
  - **File:** `scheduler.js`
  - **Location:** runNonBuyerCampaign product selection (line ~650-750)
  - Find HOT segment rotation logic:
    ```javascript
    const rotationIndex = (userIdNum + dayOfYear) % unboughtProducts.length;
    selectedProduct = unboughtProducts[rotationIndex];
    ```
  - Remove `if (segment === 'HOT')` condition wrapper
  - Apply rotation to ALL segments (WARM, COLD, GHOST)
  - **Purpose:** Fair product exposure (fixes Bug #13)
  - _Bug_Condition: segment IN ['WARM', 'COLD', 'GHOST'] AND always prodList[0]_
  - _Expected_Behavior: Rotation for all segments_
  - _Requirements: 2.13_

### 5.5 Increase Realtime Trigger Delay

- [x] 5.5.1 Change delay from 5 seconds to 30 seconds
  - **File:** `index.js`
  - **Location:** Line ~848
  - Find: `setTimeout(() => { scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {}); }, 5000);`
  - Change to: `setTimeout(() => { scheduler.triggerRealtimeMarketing(bot, userId).catch(() => {}); }, 30000);`
  - **Purpose:** Give users time to explore naturally (fixes Bug #15)
  - _Bug_Condition: Delay === 5 seconds_
  - _Expected_Behavior: Delay === 30 seconds_
  - _Requirements: 2.15_

---

## Group 6: Verification & Testing

### 6.1 Unit Tests

- [x] 6.1.1 Test checkAndIncrementRateLimit() with various counter states
  - Test admin bypass
  - Test midnight reset
  - Test limit enforcement (>= 3)
  - Test counter increment

- [x] 6.1.2 Test acquireCampaignLock() atomic operations
  - Test successful lock acquisition
  - Test failed lock (already acquired)
  - Test TTL expiration

- [x] 6.1.3 Test isUserInCheckout() with pending/completed orders
  - Test with PENDING order (should return true)
  - Test with COMPLETED order (should return false)
  - Test with no order (should return false)

- [x] 6.1.4 Test segment classification with captured timestamps
  - Test HOT segment (< 1 day)
  - Test WARM segment (1-7 days)
  - Test COLD segment (7-30 days)
  - Test GHOST segment (> 30 days)

### 6.2 Integration Tests

- [x] 6.2.1 Full day simulation test
  - Run all campaigns over 24-hour period
  - Verify no user receives > 3 messages
  - Verify quiet hours respected
  - Verify admin bypass works

- [x] 6.2.2 Concurrent campaign stress test
  - Start 4 campaigns simultaneously
  - 1000 users in database
  - Verify locks prevent duplicates
  - Verify rate limit enforced

- [x] 6.2.3 Discount lifecycle test
  - Create discount → use in order → expire → cleanup
  - Verify TTL cleanup within 7 days

### 6.3 Preservation Tests

- [x] 6.3.1 Verify existing campaign cooldown logic unchanged
  - Test 48-hour cooldown between DIFFERENT campaigns
  - _Requirement: 3.1_

- [x] 6.3.2 Verify admin bypass functionality unchanged
  - Test admin bypasses all limits
  - _Requirement: 3.2_

- [x] 6.3.3 Verify buyer bypass unchanged
  - Test buyers bypass cooldowns when bypassForBuyer: true
  - _Requirement: 3.3_

- [x] 6.3.4 Verify discount application logic unchanged
  - Test discount applied correctly in checkout
  - Test used_count incremented
  - _Requirement: 3.4_

- [x] 6.3.5 Verify opt-out respect unchanged
  - Test opt_out: true skips all campaigns except cart abandon
  - _Requirement: 3.15_

---

## Group 7: Deployment & Monitoring

### 7.1 Database Migration

- [x] 7.1.1 Run schema migration script
  - Update all User documents with default values for new fields
  - Create indexes in background mode
  - Verify index creation complete

### 7.2 Code Deployment

- [x] 7.2.1 Deploy to staging environment
  - Run integration tests on staging
  - Monitor logs for 24 hours

- [x] 7.2.2 Deploy to production with rolling restart
  - Zero downtime deployment
  - Monitor error rates

### 7.3 Post-Deployment Monitoring

- [x] 7.3.1 Monitor rate limit effectiveness
  - Track rate_limit_skips metric
  - Verify users not exceeding 3 messages/day

- [x] 7.3.2 Monitor lock acquisition
  - Track lock_acquisition_failures
  - Verify race conditions prevented

- [x] 7.3.3 Monitor cleanup jobs
  - Verify daily cleanup running at 3 AM
  - Track deleted discount counts

- [x] 7.3.4 Monitor segment distribution
  - Verify NOT all users classified as HOT
  - Expected: HOT 5%, WARM 30%, COLD 45%, GHOST 20%

- [x] 7.3.5 Monitor success metrics
  - Block rate target: < 5% (from 30%)
  - Revenue recovery: +60-80%
  - Messages/user/day: <= 3

---

## Summary

**Total Tasks:** 77
- Database Schema: 4 tasks
- Helper Functions: 3 tasks
- Critical Fixes (P1): 20 tasks
- High Priority (P2): 11 tasks
- Medium Priority (P3): 20 tasks
- Testing: 14 tasks
- Deployment: 5 tasks

**Estimated Implementation Time:**
- Group 1 (Database): 2 hours
- Group 2 (Helpers): 2 hours
- Group 3 (Critical): 6 hours
- Group 4 (High): 4 hours
- Group 5 (Medium): 5 hours
- Group 6 (Testing): 8 hours
- Group 7 (Deployment): 3 hours
- **Total: ~30 hours**

**Critical Path:**
1. Database schema changes (foundation)
2. Helper functions (dependencies)
3. Critical fixes (highest impact)
4. Testing (validation)
5. Deployment (rollout)
