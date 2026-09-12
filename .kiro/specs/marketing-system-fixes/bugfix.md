# Bugfix Requirements Document

## Introduction

This document addresses 16 critical bugs in the marketing automation system that are causing 60-80% revenue loss, 30% user block rates, and system performance degradation. The bugs span across three main categories: segment classification errors, rate limiting failures, and campaign timing issues. These defects are costing significant revenue through incorrect discount application, user spam leading to opt-outs, and race conditions in campaign delivery.

**Impact Summary:**
- Revenue Loss: 60-80% due to incorrect discount assignment
- Block Rate: 30% (target: <5%) due to message spam
- DB Performance: -50% potential improvement through cleanup
- Conversion Rate: +30-40% potential gain after fixes

**Affected Files:**
- `scheduler.js` - Campaign logic, drip flows, discount calculation
- `index.js` - Realtime trigger system
- `database.js` - Schema for rate limiting and cleanup

---

## Bug Analysis

### Current Behavior (Defect)

#### Section 1: Critical Priority Bugs (P1)

**1.1 Realtime Segment Classification Bug**
WHEN a user triggers realtime marketing (on any message in index.js) THEN the system calls `classifyNonBuyer(user)` which returns segment based on `last_active_at`, but `last_active_at` is updated to current time BEFORE classification in line `await User.findByIdAndUpdate(userId, { last_active_at: new Date() })`, causing ALL realtime users to be classified as HOT (daysInactive < 1) and receive only 5% discount instead of proper segment discount (COLD should get 15%, WARM 10%).

**1.2 No Global Rate Limit**
WHEN multiple marketing campaigns run (NON_BUYER, CROSS_SELL, VIP_WINBACK, DRIP follow-ups, REALTIME triggers) THEN there is no global counter tracking messages sent per user per day, allowing a user to receive up to 9 marketing messages in a single day (1 from each campaign type + realtime triggers), causing spam perception and 30% block rate.

**1.3 Race Condition in Campaign Execution**
WHEN multiple cron jobs run at the same hour (e.g., 10:00 AM: NON_BUYER + CROSS_SELL + VIP_WINBACK all scheduled) THEN multiple campaigns can send messages to the same user simultaneously without distributed locks, violating the "1 message per 48 hours" cooldown rule and causing duplicate marketing messages within seconds.

**1.4 Cooldown Bypass in VIP_WINBACK**
WHEN VIP_WINBACK campaign checks cooldown with `isInCooldown(user, { currentCampaign: 'VIP_WINBACK' })` THEN the bypass logic `if (currentCampaign && user.last_promo_campaign && user.last_promo_campaign.startsWith(currentCampaign))` triggers if last campaign was also VIP_WINBACK, but the MIN_BYPASS_AGE_MS guard is only 5 minutes instead of 48 hours, allowing VIP users to receive campaign messages every 5 minutes instead of every 48 hours.

#### Section 2: High Priority Bugs (P2)

**2.1 Discount Auto-Cleanup Missing**
WHEN discounts are created with `valid_until` dates in the past (expired) THEN there is no TTL index or scheduled cleanup job to remove them from the database, causing accumulation of 1,500 expired discounts per day (540,000 per year), degrading query performance on discount lookup operations.

**2.2 Discount Progressive Logic Broken for WARM Segment**
WHEN DRIP campaign stage 2 runs for WARM segment users THEN the code sets `discountVal = 10` (same as stage 1) instead of progressively increasing to 15% at stage 2, breaking the urgency escalation strategy and reducing conversion effectiveness.

**2.3 Quiet Hour Bypass in CART_ABANDON**
WHEN CART_ABANDON campaign sends messages THEN it bypasses `isUserQuietHour()` check (which blocks 00:00-06:00 sends), allowing cart abandon messages to be sent at 2 AM, causing high false-positive "spam" blocks from sleeping users.

**2.4 Cross-Sell No Stock Validation**
WHEN CROSS_SELL campaign recommends products THEN it does not check stock availability via `Stock.countDocuments({ product_id: p._id, status: 'AVAILABLE' })`, recommending sold-out products and creating bad user experience + wasted marketing spend.

**2.5 Campaign Timing Collision**
WHEN cron schedules are defined in `setupCronJobs()` THEN all campaigns (NON_BUYER, CROSS_SELL, VIP_WINBACK, DRIP) run at the same times (every hour 10:00-20:00), causing simultaneous execution instead of staggered distribution and triggering race condition Bug 1.3.

#### Section 3: Medium Priority Bugs (P3)

**3.1 Realtime Trigger Spam**
WHEN a user sends any message to the bot THEN `index.js` triggers realtime marketing on EVERY message without checking if user is already in an active conversation or checkout flow, spamming users mid-interaction.

**3.2 No Checkout State Check**
WHEN realtime or scheduled campaigns send marketing messages THEN there is no check if user has `ctx.session.awaitingPayment === true` or active PENDING order, interrupting users during payment flow with promotional messages.

**3.3 Discount Validity Period Too Long (48h)**
WHEN system creates "urgency" discounts with 48-hour validity (`valid_until: new Date(Date.now() + 48 * 60 * 60 * 1000)`) THEN the urgency psychology is diluted because 48 hours is too long for impulse decision-making, reducing conversion effectiveness.

**3.4 Product Rotation HOT Segment Only**
WHEN NON_BUYER campaign selects product for HOT segment THEN it uses rotation algorithm `rotationIndex = (userIdNum + dayOfYear) % prodList.length`, but WARM/COLD/GHOST segments always show first product `prodList[0]`, creating unequal product exposure and reducing revenue for products beyond index 0.

**3.5 Drip TTL Not Optimal for Converted**
WHEN DripLog has TTL index `expireAfterSeconds: 180 * 24 * 60 * 60` (180 days) THEN converted drip records (`converted: true`) are kept for 180 days even though they are only used for analytics, wasting database storage when 30 days would be sufficient for reporting needs.

**3.6 Realtime Trigger Delay Too Short (5s)**
WHEN realtime marketing delay is set to 5 seconds after user message (`setTimeout(..., 5000)`) THEN marketing fires too quickly while user may still be reading menu or exploring products, creating jarring UX and perception of pushiness.

**3.7 last_active_at Update Timing Issue**
WHEN user sends message THEN `index.js` updates `last_active_at` immediately via `User.findByIdAndUpdate(userId, { last_active_at: new Date() })` BEFORE calling realtime marketing classification, causing Bug 1.1 where all users appear as "just active" (HOT segment) regardless of actual previous activity.

---

### Expected Behavior (Correct)

#### Section 2: Critical Priority Fixes (P1)

**2.1 Realtime Segment Classification Fix**
WHEN a user triggers realtime marketing THEN the system SHALL capture `user.last_active_at` timestamp BEFORE updating it to current time, use the captured timestamp for `classifyNonBuyer()` calculation to determine true segment (HOT/WARM/COLD/GHOST), and then update `last_active_at` AFTER classification, ensuring users receive correct segment-based discount (HOT 5%, WARM 10%, COLD 15%, GHOST 20%).

**2.2 Global Rate Limit Implementation**
WHEN any marketing message is sent to a user THEN the system SHALL increment a daily counter stored in User schema field `marketing_messages_today: Number` with TTL reset at midnight Asia/Jakarta timezone, check this counter before sending and skip if `>= 3` messages already sent today, log skip reason, ensuring maximum 3 marketing messages per user per day regardless of campaign type.

**2.3 Distributed Lock for Campaign Race Condition**
WHEN multiple cron jobs execute simultaneously THEN each campaign SHALL acquire a distributed lock (using MongoDB findOneAndUpdate atomic operation on new collection `CampaignLocks` with TTL) before processing user list, use lock key format `campaign_lock_{userId}_{date}` with 1-hour TTL, skip user if lock acquisition fails (already being processed by another campaign), ensuring only one campaign can send to each user per execution cycle.

**2.4 VIP_WINBACK Cooldown Enforcement**
WHEN VIP_WINBACK campaign checks cooldown bypass THEN the MIN_BYPASS_AGE_MS guard SHALL be removed entirely for VIP_WINBACK (no bypass allowed) OR increased to 48 hours (48 * 60 * 60 * 1000) to match CAMPAIGN_COOLDOWN_MS, ensuring VIP users receive maximum 1 VIP_WINBACK message every 48 hours.

#### Section 3: High Priority Fixes (P2)

**2.5 Discount Auto-Cleanup Job**
WHEN scheduler initializes THEN the system SHALL create a daily cron job (runs at 03:00 AM Asia/Jakarta) that deletes expired discounts using `Discount.deleteMany({ valid_until: { $lt: new Date() }, active: false })`, log count of deleted records, preventing accumulation of expired discount records.

**2.6 Discount Progressive Increase for WARM at Stage 2**
WHEN DRIP campaign stage 2 processes WARM segment users THEN the system SHALL set `discountVal = 15` (increased from 10% at stage 1) to create progressive urgency, matching the escalation pattern used for other segments.

**2.7 Quiet Hour Enforcement for CART_ABANDON**
WHEN CART_ABANDON campaign prepares to send message THEN the system SHALL call `isUserQuietHour(user)` and skip sending if returns true (00:00-06:00 Jakarta time), queue message for next available sending window (06:01 AM), preventing nighttime message spam.

**2.8 Cross-Sell Stock Validation**
WHEN CROSS_SELL campaign selects products to recommend THEN the system SHALL filter products using `const availableCount = await Stock.countDocuments({ product_id: p._id, status: 'AVAILABLE' })` and exclude products where `availableCount === 0`, ensuring only in-stock products are recommended.

**2.9 Campaign Timing Staggered Distribution**
WHEN cron schedules are configured THEN the system SHALL stagger campaign execution times: NON_BUYER at :00 minutes, CROSS_SELL at :15 minutes, VIP_WINBACK at :30 minutes, DRIP at :45 minutes each hour, reducing simultaneous execution and race conditions.

#### Section 4: Medium Priority Fixes (P3)

**2.10 Realtime Trigger Throttle**
WHEN user sends message THEN realtime marketing SHALL only trigger if no message sent in last 60 minutes (check `user.last_broadcast_at`) AND user has sent < 3 messages in current session (track in session state), preventing spam during active conversations.

**2.11 Checkout State Check in Marketing**
WHEN any marketing campaign (realtime or scheduled) prepares to send THEN the system SHALL query `Order.findOne({ user_id: userId, status: 'PENDING' })` and skip sending if active pending order exists, preventing interruption of payment flows.

**2.12 Discount Validity Reduced to 24h**
WHEN system creates urgency discounts THEN the validity period SHALL be reduced from 48 hours to 24 hours (`valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000)`), increasing psychological urgency and impulse conversion rate.

**2.13 Product Rotation for All Segments**
WHEN NON_BUYER campaign selects product for any segment (HOT/WARM/COLD/GHOST) THEN the system SHALL use rotation algorithm `rotationIndex = (userIdNum + dayOfYear) % prodList.length` consistently, selecting `prodList[rotationIndex]` for all segments, ensuring fair product exposure.

**2.14 Drip TTL Optimization for Converted Records**
WHEN DripLog records have `converted: true` THEN a separate TTL index SHALL be created with `expireAfterSeconds: 30 * 24 * 60 * 60` (30 days) specifically for converted records using partial index filter `{ converted: true }`, reducing storage while retaining unconverted records for 180 days.

**2.15 Realtime Trigger Delay Increased**
WHEN realtime marketing is triggered THEN the delay SHALL be increased from 5 seconds to 30 seconds (`setTimeout(..., 30000)`), giving users time to explore naturally before receiving promotional message.

**2.16 last_active_at Update After Classification**
WHEN user sends message THEN system SHALL read current `user.last_active_at` value, pass it to classification logic, complete realtime marketing classification and sending, THEN update `last_active_at` to current time as final step, ensuring classification uses accurate historical timestamp.

---

### Unchanged Behavior (Regression Prevention)

#### Section 3: Preservation Requirements

**3.1 Existing Campaign Cooldown Logic**
WHEN non-buggy campaigns respect 48-hour cooldown via `isInCooldown()` THEN the system SHALL CONTINUE TO enforce 48-hour minimum between campaign messages for users who received message from different campaign type (e.g., NON_BUYER followed by CROSS_SELL still requires 48h gap).

**3.2 Admin Bypass Functionality**
WHEN admin user ID matches `process.env.ADMIN_CHAT_ID` THEN the system SHALL CONTINUE TO bypass all cooldown, rate limit, and quiet hour restrictions for testing purposes via `if (String(user._id) === String(process.env.ADMIN_CHAT_ID)) return false` checks.

**3.3 Buyer Cooldown Bypass**
WHEN `isInCooldown()` is called with `{ bypassForBuyer: true }` AND user has `purchase_count > 0` THEN the system SHALL CONTINUE TO bypass cooldown restrictions, allowing immediate campaign sends to existing customers.

**3.4 Discount Application Logic**
WHEN user completes checkout with valid discount code THEN the system SHALL CONTINUE TO apply discount via `applyAutomaticDiscount()`, increment `used_count`, deactivate used discounts, track in order record, unchanged by bug fixes.

**3.5 Campaign Message Templates**
WHEN campaigns send messages using custom templates from `Setting` collection (keys like `marketing_cart_abandon`, `marketing_cold_lead`) THEN the system SHALL CONTINUE TO use admin-defined custom messages if present, falling back to default copy only if custom template not found.

**3.6 Drip Stage Progression**
WHEN DRIP campaign processes stage 1 records after 3 days (stage 2) and 6 days (stage 3) THEN the system SHALL CONTINUE TO progress stages sequentially (1→2→3), mark as converted when user purchases, calculate revenue attribution, unchanged by discount percentage fixes.

**3.7 Product Keyboard Building**
WHEN campaigns build product keyboards with discounts THEN the system SHALL CONTINUE TO use `buildAllProductsKeyboard()` helper to generate inline buttons with strikethrough original prices, preview links, bundle offers, unchanged by classification fixes.

**3.8 Telegram Rate Limit Queue**
WHEN any campaign sends messages via `sendSafe()` THEN the system SHALL CONTINUE TO use `TelegramQueue` class with 35ms delay between sends, handle 429 rate limit errors with exponential backoff, pause entire queue during rate limit, unchanged by campaign scheduling fixes.

**3.9 User Blocking Detection**
WHEN `sendSafe()` encounters 403 error or "bot was blocked" message THEN the system SHALL CONTINUE TO set `is_blocked: true` in User record using native driver fallback, log block event, skip user in future campaigns, unchanged by rate limit additions.

**3.10 Media Attachment Handling**
WHEN campaigns send messages with media (GIF/photo/video from `promo_media` or `promo_image_id`) THEN the system SHALL CONTINUE TO send media first followed by text+buttons in single message for photos/videos, separate messages for animations (GIF), unchanged by timing fixes.

**3.11 A/B Testing Variant Assignment**
WHEN DRIP campaign creates new DripLog records THEN the system SHALL CONTINUE TO randomly assign variant 'A' or 'B' using `Math.random() < 0.5`, track conversions by variant in ABTestResult collection, unchanged by discount logic fixes.

**3.12 Social Proof Engine**
WHEN user completes payment successfully THEN the system SHALL CONTINUE TO trigger social proof notifications to up to 5 recent non-buyers after 10-second delay, include product media if available, unchanged by classification fixes.

**3.13 Cross-Sell Similarity Algorithm**
WHEN CROSS_SELL campaign identifies recommended products THEN the system SHALL CONTINUE TO use collaborative filtering (find users with similar purchase history via OrderItem aggregation), fall back to most popular product if no similar users found, unchanged by stock validation addition.

**3.14 Dynamic Discount Calculation**
WHEN calculating personalized discounts via `calculateDynamicDiscount()` THEN the system SHALL CONTINUE TO consider user tenure (daysSinceJoin), purchase history (purchaseCount, totalSpent), previous big discount count, product price caps (<100k = max 15%, >=100k = max 30%), unchanged by segment classification fixes.

**3.15 Opt-Out Respect**
WHEN user has `opt_out: true` in database THEN the system SHALL CONTINUE TO skip all marketing campaigns EXCEPT cart abandon (high-intent signal), log skip reason, unchanged by rate limit implementation.
