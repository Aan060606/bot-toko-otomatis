# 📊 VISUAL FLOW MARKETING SYSTEM

## 🎯 USER JOURNEY MAP

```
┌─────────────────────────────────────────────────────────────────┐
│                     USER JOINS BOT                               │
│                          ↓                                       │
│                    [Track: /start]                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  USER BEHAVIOR TRACKING                          │
├─────────────────────────────────────────────────────────────────┤
│  • last_active_at (setiap interaksi)                            │
│  • UserEvent (START, CHECKOUT, PAYMENT)                         │
│  • Cart tracking (add/remove)                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    ┌───────┴───────┐
                    │               │
                    ↓               ↓
        ┌────────────────┐  ┌──────────────┐
        │  BELUM BELI    │  │  SUDAH BELI  │
        │  (Non-Buyer)   │  │  (Customer)  │
        └────────────────┘  └──────────────┘
                │                   │
                ↓                   ↓
    ┌──────────────────────┐    ┌──────────────────┐
    │  KLASIFIKASI         │    │  INACTIVE?       │
    │  SEGMENT             │    │  (>7 hari)       │
    └──────────────────────┘    └──────────────────┘
                │                   │
    ┌───────────┼───────────────────┼──────┐
    │           │           │       │      │
    ↓           ↓           ↓       ↓      ↓
┌────────┐ ┌─────┐ ┌──────┐ ┌─────┐ ┌─────────┐
│ CART   │ │ HOT │ │ WARM │ │COLD │ │ GHOST   │
│ABANDON │ │ <3d │ │ 3-7d │ │7-30d│ │ 30-60d  │
└────────┘ └─────┘ └──────┘ └─────┘ └─────────┘
    │         │        │        │         │
    └─────────┴────────┴────────┴─────────┘
                       ↓
            ┌──────────────────────┐
            │   KIRIM PESAN        │
            │   + DISKON           │
            └──────────────────────┘
                       ↓
                 [DRIP STAGE 1]
                       ↓
              ┌────────┴────────┐
              │                 │
              ↓                 ↓
        ┌──────────┐      ┌──────────┐
        │ CONVERT  │      │ TUNGGU   │
        │ (BELI)   │      │ 3 HARI   │
        └──────────┘      └──────────┘
              │                 │
              │                 ↓
              │           [DRIP STAGE 2]
              │                 │
              │          ┌──────┴──────┐
              │          │             │
              │          ↓             ↓
              │    ┌──────────┐  ┌──────────┐
              │    │ CONVERT  │  │ TUNGGU   │
              │    └──────────┘  │ 3 HARI   │
              │          │       └──────────┘
              │          │             │
              │          │             ↓
              │          │       [DRIP STAGE 3]
              │          │             │
              │          │       ┌─────┴─────┐
              │          │       │           │
              │          │       ↓           ↓
              │          │  ┌──────────┐ ┌──────────┐
              │          │  │ CONVERT  │ │ TIMEOUT  │
              │          │  └──────────┘ │ (EXIT)   │
              │          │       │       └──────────┘
              └──────────┴───────┘
                       ↓
              ┌─────────────────┐
              │  SUCCESS ORDER  │
              │  Mark Converted │
              └─────────────────┘
                       ↓
              ┌─────────────────┐
              │  CROSS-SELL     │
              │  (D+1, D+7)     │
              └─────────────────┘
```

---

## 🔄 SEGMENT CLASSIFICATION LOGIC

```
USER AKTIF TERAKHIR KAPAN?
         │
    ┌────┴─────────────────────────────┐
    │                                  │
    ↓                                  ↓
< 3 HARI                         > 3 HARI
    │                                  │
    ↓                                  ↓
┌─────────────┐              ┌──────────────┐
│ CEK CART    │              │ CEK DURASI   │
└─────────────┘              └──────────────┘
    │                                  │
    ↓                          ┌───────┴───────┬──────────┐
ADA PENDING ORDER?             │               │          │
    │                          ↓               ↓          ↓
    ├─ YA (>72 jam) → CART_ABANDON          3-7d      7-30d    30-60d
    │                                          │          │          │
    └─ TIDAK                                   ↓          ↓          ↓
         │                                  WARM       COLD      GHOST
         ↓
    [HOT LEAD]
```

---

## 💰 DISKON PROGRESSION

```
SEGMENT        STAGE 1    STAGE 2    STAGE 3
─────────────────────────────────────────────
CART_ABANDON     0%         5%        10%
HOT              5%        10%        15%
WARM            10%        15%        20%
COLD            15%        20%        25%
GHOST           20%        25%        30%
INACTIVE        10%        15%        20%

         ↑           ↑           ↑
         │           │           │
      INITIAL    URGENCY     FINAL
       (D+0)      (D+3)      (D+6)
```

---

## ⏰ TIMING SCHEDULE

```
TIME        CAMPAIGN              TARGET SEGMENT
────────────────────────────────────────────────
08:00    NON-BUYER + CROSS-SELL   ALL (kecuali quiet hour)
11:00    NON-BUYER                HOT, WARM
14:00    CROSS-SELL               Customers
17:00    NON-BUYER                COLD, GHOST
20:00    NON-BUYER + CROSS-SELL   ALL (prime time)
23:00    DRIP STAGE CHECK         Stage 2, 3
00:00    ❌ QUIET HOUR START
06:00    ✅ QUIET HOUR END
```

---

## 🎯 CONVERSION FUNNEL

```
1000 USERS JOIN
      │
      ├─ 700 Active (70%)
      │    │
      │    ├─ 500 Receive Campaign (50%)
      │    │    │
      │    │    ├─ 150 Click Product (30% CTR)
      │    │    │    │
      │    │    │    ├─ 75 Add to Cart (50% add rate)
      │    │    │    │    │
      │    │    │    │    ├─ 45 Checkout (60% checkout rate)
      │    │    │    │    │    │
      │    │    │    │    │    └─ 30 Complete Payment (67% payment rate)
      │    │    │    │    │           ↓
      │    │    │    │    │       [SUCCESS]
      │    │    │    │    │       3% Overall CVR
      │    │    │    │    │
      │    │    │    │    └─ 30 CART ABANDON
      │    │    │    │           ↓
      │    │    │    │       [DRIP CAMPAIGN]
      │    │    │    │           ↓
      │    │    │    │       +15 Recovery (50% recovery)
      │    │    │    │           ↓
      │    │    │    │       TOTAL: 45 SALES (4.5% CVR)
      │    │    │    │
      │    │    │    └─ 75 Browse Only
      │    │    │           ↓
      │    │    │       [WARM → DRIP]
      │    │    │
      │    │    └─ 350 No Click
      │    │           ↓
      │    │       [COLD/GHOST → DRIP]
      │    │
      │    └─ 200 No Campaign (cooldown/opt-out)
      │
      └─ 300 Inactive/Blocked
```

**Optimization Target**:
- CTR: 30% → **40%** (better messaging)
- Add to Cart: 50% → **65%** (better product page)
- Checkout: 60% → **75%** (reduce friction)
- Payment: 67% → **80%** (urgency + discount)

**Result**: 3% → **8-10% Overall CVR**

---

## 📈 REVENUE PROJECTION

```
BASELINE (Current)
──────────────────
1000 users/month
× 3% CVR
× Rp50,000 avg
= Rp 1,500,000/month

OPTIMIZED (Target)
──────────────────
1000 users/month
× 8% CVR
× Rp50,000 avg
= Rp 4,000,000/month

CROSS-SELL BONUS
────────────────
80 existing customers
× 30% buy 2nd product
× Rp50,000 avg
= Rp 1,200,000/month

TOTAL OPTIMIZED
───────────────
Rp 4,000,000 (main)
+ Rp 1,200,000 (cross-sell)
= Rp 5,200,000/month

INCREASE: +247% 🚀
```

---

## 🔥 PRIORITY OPTIMIZATION MATRIX

```
                    HIGH IMPACT
                        ↑
              ┌─────────┼─────────┐
              │    A    │    B    │
              │         │         │
      LOW ←───┤  QUICK  │  LONG   │───→ HIGH
    EFFORT    │  WINS   │  TERM   │   EFFORT
              │         │         │
              ├─────────┼─────────┤
              │    C    │    D    │
              │  MAYBE  │  AVOID  │
              └─────────┴─────────┘
                        ↓
                    LOW IMPACT

QUADRANT A (DO FIRST):
─────────────────────
✅ Update pesan marketing template
✅ Aktifkan diskon otomatis
✅ Optimize quiet hour
✅ Add preview content

QUADRANT B (PLAN):
─────────────────
⏳ A/B testing infrastructure
⏳ Smart recommendation algorithm
⏳ Dashboard analytics
⏳ Retention automation

QUADRANT C (IF TIME):
────────────────────
🔹 Custom emoji per segment
🔹 Multi-language support
🔹 Advanced personalization

QUADRANT D (SKIP):
─────────────────
❌ Over-engineering
❌ Premature scaling
❌ Complex features nobody asked
```

---

## 🎪 CUSTOMER LIFECYCLE

```
DAY 0
├─ User join → [HOT]
├─ Kirim welcome message
└─ Offer 5% discount

DAY 1 (if no purchase)
├─ [HOT] → Product rotation promo
└─ Preview content + social proof

DAY 3 (if no purchase)
├─ [HOT] → [WARM]
├─ Stage 2: Urgency message
└─ Increase discount 10%

DAY 6 (if no purchase)
├─ [WARM] → Still WARM
├─ Stage 3: Final offer
└─ Max discount 15%

DAY 9 (if no purchase)
├─ Exit active drip
└─ Enter passive re-targeting

DAY 10+ (if no purchase)
├─ [WARM] → [COLD]
└─ Re-engagement campaign 15% off

DAY 30+ (if no purchase)
├─ [COLD] → [GHOST]
└─ Last effort 20% off

DAY 60+ (if no purchase)
├─ Mark as lost lead
└─ Stop active campaigns

─────────────────────────────

IF PURCHASE AT ANY POINT:
├─ Mark drip as CONVERTED
├─ Stop non-buyer campaigns
├─ Start post-purchase drip:
│   ├─ D+1: Thank you + onboarding
│   ├─ D+3: Tips & engagement
│   ├─ D+7: Cross-sell offer
│   └─ D+30: Loyalty discount
└─ Lifetime customer journey
```

---

## 💡 PSYCHOLOGICAL TRIGGERS

```
TRIGGER         WHEN           MESSAGE ELEMENT
──────────────────────────────────────────────
SCARCITY      Stage 2, 3    "Slot tinggal 10"
URGENCY       All stages    "Promo berakhir..."
SOCIAL PROOF  Initial       "3.200+ member"
AUTHORITY     Initial       "Tim profesional"
FOMO          Stage 3       "Jangan sampai nyesel"
RECIPROCITY   Stage 1       Free preview/tips
CONSISTENCY   Follow-up     "Kamu sudah lihat..."
LIKING        Personalized  Use first_name

┌─────────────────────────────────────┐
│  HOOK (Attention)                   │
│  ↓                                  │
│  AGITATE (Problem)                  │
│  ↓                                  │
│  SOLUTION (Your Product)            │
│  ↓                                  │
│  SOCIAL PROOF (Trust)               │
│  ↓                                  │
│  UNIQUE VALUE (Differentiation)     │
│  ↓                                  │
│  URGENCY (Act Now)                  │
│  ↓                                  │
│  CTA (Clear Action)                 │
└─────────────────────────────────────┘
```

---

## 🎯 SUCCESS METRICS DASHBOARD

```
┌────────────────────────────────────────────┐
│  DAILY METRICS                             │
├────────────────────────────────────────────┤
│  Active Users Today:      147              │
│  Campaigns Sent:          52               │
│  Click-Through Rate:      34%              │
│  Conversions Today:       7                │
│  Revenue Today:           Rp 350,000       │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  CAMPAIGN PERFORMANCE                      │
├────────────────────────────────────────────┤
│  NON-BUYER:                                │
│    - Sent: 35  Converted: 4  CVR: 11.4%   │
│  CROSS-SELL:                               │
│    - Sent: 12  Converted: 2  CVR: 16.7%   │
│  DRIP STAGE 2:                             │
│    - Sent: 5   Converted: 1  CVR: 20.0%   │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  SEGMENT BREAKDOWN                         │
├────────────────────────────────────────────┤
│  HOT:    23 users  (16% of active)         │
│  WARM:   45 users  (31% of active)         │
│  COLD:   52 users  (35% of active)         │
│  GHOST:  27 users  (18% of active)         │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  TOP PERFORMING PRODUCTS                   │
├────────────────────────────────────────────┤
│  1. JAV Premium      - 45 sales            │
│  2. Viral Indo       - 23 sales            │
│  3. Boocil VIP       - 18 sales            │
└────────────────────────────────────────────┘
```

---

## ✅ IMPLEMENTATION CHECKLIST

```
PHASE 1: FOUNDATION (Week 1)
├─ [x] Segmentation logic working
├─ [x] Drip automation running
├─ [x] Anti-spam cooldown active
├─ [x] Quiet hour implemented
├─ [x] Discount automation ready
└─ [ ] Template messages optimized

PHASE 2: OPTIMIZATION (Week 2)
├─ [ ] A/B test setup
├─ [ ] Product rotation analysis
├─ [ ] Preview content added
├─ [ ] Cross-sell logic tested
└─ [ ] Analytics dashboard

PHASE 3: SCALE (Week 3-4)
├─ [ ] Winning variant deployed
├─ [ ] Smart recommendation live
├─ [ ] Post-purchase drip active
├─ [ ] Retention automation
└─ [ ] Performance monitoring

ONGOING:
├─ Daily: Monitor logs
├─ Weekly: Review conversion rates
├─ Monthly: Optimize messaging
└─ Quarterly: Strategic planning
```

---

**VISUAL FLOW SELESAI!** 📊

**File tersedia**:
- ✅ `📈_MARKETING_SYSTEM_LENGKAP.md` - Dokumentasi lengkap
- ✅ `📊_MARKETING_FLOW_VISUAL.md` - Visual diagram (this file)

**Next**: Implementasikan quick wins dari checklist di atas! 🚀

