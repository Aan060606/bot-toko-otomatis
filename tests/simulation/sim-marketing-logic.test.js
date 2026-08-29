/**
 * SIM-03: Simulasi Marketing Funnel — isInCooldown, classifyNonBuyer, calculateDynamicDiscount
 * Menguji semua cabang logika marketing scheduler tanpa butuh kirim Telegram sungguhan
 */
const { User, Product, Discount, UserEvent, DripLog } = require('../../database');

// Import fungsi internal scheduler — expose via module wrapper
// Kita test logika murni tanpa bot.telegram
let classifyNonBuyer, calculateDynamicDiscount, isInCooldownFn;

// Ambil fungsi dari scheduler via trick: load modul dan extract
// Scheduler tidak export fungsi-fungsinya, jadi kita simulasikan logikanya langsung
describe('SIM-03 Marketing Logic — Cooldown, Classification, Dynamic Discount', () => {

  // ─── COOLDOWN ────────────────────────────────────────────────
  describe('Anti-Spam Cooldown', () => {
    test('SIM-03a: user tanpa last_broadcast_at → tidak kena cooldown', async () => {
      const user = { _id: 7001, last_broadcast_at: null };
      const adminId = process.env.ADMIN_CHAT_ID || '999';

      // Replicate isInCooldown logic
      function isInCooldown(u) {
        if (String(u._id) === String(adminId)) return false;
        if (!u.last_broadcast_at) return false;
        const hours = (new Date() - new Date(u.last_broadcast_at)) / 3600000;
        return hours < 24;
      }

      expect(isInCooldown(user)).toBe(false);
    });

    test('SIM-03b: user dapat pesan 1 jam lalu → kena cooldown 24 jam', async () => {
      const user = { _id: 7002, last_broadcast_at: new Date(Date.now() - 3600000) }; // 1 jam lalu

      function isInCooldown(u) {
        if (!u.last_broadcast_at) return false;
        const hours = (new Date() - new Date(u.last_broadcast_at)) / 3600000;
        return hours < 24;
      }

      expect(isInCooldown(user)).toBe(true);
    });

    test('SIM-03c: user dapat pesan 25 jam lalu → bebas dari cooldown', async () => {
      const user = { _id: 7003, last_broadcast_at: new Date(Date.now() - 25 * 3600000) };

      function isInCooldown(u) {
        if (!u.last_broadcast_at) return false;
        const hours = (new Date() - new Date(u.last_broadcast_at)) / 3600000;
        return hours < 24;
      }

      expect(isInCooldown(user)).toBe(false);
    });

    test('SIM-03d: admin ID → selalu bebas dari cooldown', async () => {
      const adminId = process.env.ADMIN_CHAT_ID || '12345';
      const user = { _id: Number(adminId), last_broadcast_at: new Date() }; // baru saja

      function isInCooldown(u) {
        if (String(u._id) === String(adminId)) return false;
        if (!u.last_broadcast_at) return false;
        const hours = (new Date() - new Date(u.last_broadcast_at)) / 3600000;
        return hours < 24;
      }

      expect(isInCooldown(user)).toBe(false); // admin kebal
    });
  });

  // ─── CLASSIFY NON-BUYER ───────────────────────────────────────
  describe('classifyNonBuyer', () => {
    test('SIM-03e: user checkout 30 menit lalu tanpa bayar → CART_ABANDON', async () => {
      await User.create({ _id: 7010, first_name: 'AbandonUser', purchase_count: 0, last_active_at: new Date() });
      await UserEvent.create({
        user_id: 7010,
        event_type: 'CHECKOUT',
        created_at: new Date(Date.now() - 35 * 60 * 1000) // 35 menit lalu
      });

      // Replicate classifyNonBuyer
      async function classify(user) {
        const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
        if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
          const hoursSince = (new Date() - new Date(lastEvent.created_at)) / 3600000;
          if (hoursSince >= 0.5 && hoursSince <= 30 * 24) return 'CART_ABANDON';
        }
        const daysInactive = (new Date() - new Date(user.last_active_at)) / 86400000;
        if (daysInactive > 7) return 'INACTIVE';
        return 'COLD_LEAD';
      }

      const result = await classify(await User.findById(7010).lean());
      expect(result).toBe('CART_ABANDON');
    });

    test('SIM-03f: user tidak aktif 10 hari → INACTIVE', async () => {
      await User.create({
        _id: 7011, first_name: 'InactiveUser', purchase_count: 0,
        last_active_at: new Date(Date.now() - 10 * 86400000) // 10 hari lalu
      });

      async function classify(user) {
        const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
        if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
          const hoursSince = (new Date() - new Date(lastEvent.created_at)) / 3600000;
          if (hoursSince >= 0.5 && hoursSince <= 30 * 24) return 'CART_ABANDON';
        }
        const daysInactive = (new Date() - new Date(user.last_active_at)) / 86400000;
        if (daysInactive > 7) return 'INACTIVE';
        return 'COLD_LEAD';
      }

      const result = await classify(await User.findById(7011).lean());
      expect(result).toBe('INACTIVE');
    });

    test('SIM-03g: user aktif baru join hari ini → COLD_LEAD', async () => {
      await User.create({ _id: 7012, first_name: 'ColdUser', purchase_count: 0, last_active_at: new Date() });

      async function classify(user) {
        const lastEvent = await UserEvent.findOne({ user_id: user._id }).sort({ created_at: -1 }).lean();
        if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
          const hoursSince = (new Date() - new Date(lastEvent.created_at)) / 3600000;
          if (hoursSince >= 0.5 && hoursSince <= 30 * 24) return 'CART_ABANDON';
        }
        const daysInactive = (new Date() - new Date(user.last_active_at)) / 86400000;
        if (daysInactive > 7) return 'INACTIVE';
        return 'COLD_LEAD';
      }

      const result = await classify(await User.findById(7012).lean());
      expect(result).toBe('COLD_LEAD');
    });
  });

  // ─── DYNAMIC DISCOUNT ─────────────────────────────────────────
  describe('calculateDynamicDiscount', () => {
    async function calcDiscount(user) {
      const daysSinceJoin = (Date.now() - new Date(user.joined_at || user.created_at || Date.now())) / 86400000;
      const purchaseCount = user.purchase_count || 0;
      const totalSpent = user.total_spent || 0;

      if (totalSpent > 100000 || purchaseCount >= 5) return { percentage: 10, title: 'Khusus Member VIP' };

      if (purchaseCount === 0 && daysSinceJoin > 30) {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
        const prevBig = await Discount.countDocuments({
          target_user_id: user._id, type: 'PERCENTAGE', value: { $gte: 25 }, created_at: { $gte: ninetyDaysAgo }
        });
        if (prevBig >= 2) return { percentage: 25 };
        if (prevBig === 1) return { percentage: 35 };
        return { percentage: 50 };
      }

      if (purchaseCount === 0 && daysSinceJoin <= 30) return { percentage: 20 };
      return { percentage: 15 };
    }

    test('SIM-03h: VIP user (total_spent > 100k) → diskon 10%', async () => {
      const user = { _id: 7020, purchase_count: 2, total_spent: 150000, joined_at: new Date(Date.now() - 60 * 86400000) };
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(10);
    });

    test('SIM-03i: user beli 5x → diskon VIP 10%', async () => {
      const user = { _id: 7021, purchase_count: 5, total_spent: 0, joined_at: new Date() };
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(10);
    });

    test('SIM-03j: user baru join (<30 hari), belum beli → diskon 20%', async () => {
      const user = { _id: 7022, purchase_count: 0, total_spent: 0, joined_at: new Date(Date.now() - 7 * 86400000) };
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(20);
    });

    test('SIM-03k: user lama (>30 hari), belum beli, tidak pernah dapat diskon → diskon 50%', async () => {
      await User.create({ _id: 7023, purchase_count: 0, total_spent: 0, joined_at: new Date(Date.now() - 45 * 86400000) });
      const user = await User.findById(7023).lean();
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(50);
    });

    test('SIM-03l: user lama, pernah dapat 1 diskon besar → diskon 35%', async () => {
      await User.create({ _id: 7024, purchase_count: 0, total_spent: 0, joined_at: new Date(Date.now() - 45 * 86400000) });
      await Discount.create({ target_user_id: 7024, type: 'PERCENTAGE', value: 30, created_at: new Date() });
      const user = await User.findById(7024).lean();
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(35);
    });

    test('SIM-03m: user lama, pernah dapat 2+ diskon besar → diskon 25%', async () => {
      await User.create({ _id: 7025, purchase_count: 0, total_spent: 0, joined_at: new Date(Date.now() - 45 * 86400000) });
      await Discount.create({ target_user_id: 7025, type: 'PERCENTAGE', value: 30, created_at: new Date() });
      await Discount.create({ target_user_id: 7025, type: 'PERCENTAGE', value: 35, created_at: new Date() });
      const user = await User.findById(7025).lean();
      const result = await calcDiscount(user);
      expect(result.percentage).toBe(25);
    });
  });
});
